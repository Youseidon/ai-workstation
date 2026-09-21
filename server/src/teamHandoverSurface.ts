import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProgramRecord, PromptRecord, SuiteRecord, TaskControlReceipt } from "@agent-console/shared";
import { config } from "./config.ts";
import { harnessSeams } from "./harnessSeams.ts";
import { startExecute } from "./runService.ts";
import { settings } from "./settings.ts";
import type { HandoverTap } from "./taskControl.ts";
import type { TeamRoster, TeamMember } from "./teamRoster.ts";
import {
  RemoteGitControlRecordRemote,
  controlRef,
  handoverBranch,
  expireOfferIfDue,
  type ControlRecord,
  type ControlRecordRemote,
} from "./teamControlRecord.ts";
import {
  BareGitHandoverPackageRemote,
  beginHandover,
  captureHandoverPackage,
  publishHandoverOffer,
  readPublishedOffer,
  CONTEXT_PATH,
  type CapturePreview,
  type HandoverConfirmation,
  type PublishedOffer,
} from "./teamHandoverCapture.ts";
import {
  acceptHandoverOffer,
  assertHandoverEnabled,
  classifyHandoverStop,
  declineHandoverOffer,
  discoverHandoverOffer,
  returnHandoverWork,
  startReceiverRun,
  type ReceiverEnvironment,
  type ReceiverPolicy,
} from "./teamHandoverRun.ts";
import {
  applyReturnedResult,
  handoverPipelineHold,
  requestHandoverChanges,
  reviewReturnedResult,
  type HandoverBaseline,
  type RequesterEnvironment,
} from "./teamResultApply.ts";
import { renderTeamItemActionCard } from "./teamItemViews.ts";
import { itemSubject, WorkspaceError, workspaces } from "./workspaces.ts";

/**
 * The handover surface (H06, gap register C1).
 *
 * The H track built the whole engine - the control record, capture and publish,
 * accept, claim and the receiver's run, return and apply - as server modules
 * with no caller. Nothing connected any of it to a person: `workspaceApi.ts`
 * exposed no route, `registerHandoverTapHandler` had no production caller, and
 * nothing scheduled a control-record read, so a receiver's workstation never
 * discovered an offer.
 *
 * This module is that missing surface and nothing more. It owns three things:
 *
 * - **The environments.** Both `ReceiverEnvironment` and `RequesterEnvironment`
 *   are derived from the Team roster and this workstation's own settings, never
 *   from the offer, because what a workstation may run is its own decision.
 * - **Discovery.** The engine discovers an offer for an item it is told about;
 *   nothing enumerated items. `listControlItems` reads the shared repository's
 *   own `refs/aw/items/*` namespace, so a receiver finds an offer without
 *   reading anyone's messages.
 * - **Routing.** One tap handler, registered with `TaskControlService`, behind
 *   the capability gate that stays exactly where H04 put it.
 *
 * It redesigns no engine module. Where the engine offers a seam - `spawn`,
 * `push`, `policy` - this fills it in with the real thing.
 */

/* ------------------------------- local paths ------------------------------- */

const HANDOVER_PROGRAM = "Team handover";
const HANDOVER_SUITE = "Handover offers";

/** The recorded default shared-record read interval (tm4.md, Scope). */
export const CONTROL_READ_INTERVAL_MS = 5_000;

function handoverRoot(): string {
  return join(config.repoRoot, ".agent-console", "handover");
}

/** One private bare clone carries every item's control ref; the refs do not collide. */
function controlBare(): string {
  return join(handoverRoot(), "control.git");
}

function worktreeRoot(): string {
  return join(handoverRoot(), "worktrees");
}

function integrationRoot(): string {
  return join(handoverRoot(), "integration");
}

function baselinePath(itemId: string): string {
  return join(handoverRoot(), "baselines", `${itemId}.json`);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new WorkspaceError(502, "handover_git_failed", (result.stderr || result.stdout || "A handover Git operation failed.").trim());
  }
  return result.stdout;
}

function tryGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

const commandId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

/* ----------------------------- the shared record ---------------------------- */

export function controlRemote(itemId: string, remoteUrl: string): ControlRecordRemote {
  return new RemoteGitControlRecordRemote(controlBare(), itemId, remoteUrl);
}

/**
 * Every item the shared repository carries a control record for.
 *
 * The engine reads one record when it is told which; nothing told a receiver
 * which items exist, which is half of why no workstation ever discovered an
 * offer. `refs/aw/items/<item>/control` is its own namespace, so listing it is
 * the discovery: no message of anyone else's is read to find an offer.
 */
export function listControlItems(remoteUrl: string): string[] {
  const listed = tryGit(config.repoRoot, ["ls-remote", remoteUrl, "refs/aw/items/*/control"]);
  if (listed === null) return [];
  const items: string[] = [];
  for (const line of listed.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    const item = ref === undefined ? null : /^refs\/aw\/items\/([^/]+)\/control$/.exec(ref)?.[1] ?? null;
    if (item !== null && !items.includes(item)) items.push(item);
  }
  return items;
}

/* ------------------------------- environments ------------------------------- */

function memberFor(roster: TeamRoster, botId: string): TeamMember {
  const member = roster.members.find(one => one.botId === botId);
  if (member === undefined) throw new WorkspaceError(409, "team_owner_missing", "This workstation is not in the Team roster.");
  return member;
}

function groupActorId(roster: TeamRoster, member: TeamMember): string {
  const actor = workspaces.taskControlTeamActorFor({ transport: "telegram", transportUserId: member.telegramUserId, chatId: roster.groupChatId });
  if (actor === null || actor.enabled !== 1) {
    throw new WorkspaceError(403, "actor_not_enrolled", "This Team member is not active in the group. Refresh the team and try again.");
  }
  return actor.id;
}

/**
 * This workstation's own approved policy for a handover package (RTC-12).
 *
 * It is derived from what this machine can actually do, never from the offer.
 * A provider this workstation is not logged in to is not in `providers`, so it
 * lands in RTC-12's fourth row, `unknown`, rather than being read as permission;
 * an omitted requirement is not permission.
 */
export function receiverPolicy(providers: string[]): ReceiverPolicy {
  return {
    providers: [...providers],
    models: [],
    hostAccess: false,
    // The sandbox a handover run is offered and accepted under: the receiver's
    // own detached worktree of the handover branch, and nothing outside it.
    sandbox: [HANDOVER_SANDBOX],
    tools: [],
    grantable: [],
    denied: [],
    unenforceable: [],
  };
}

/** The sandbox token every offer states and every receiver's policy covers. */
export const HANDOVER_SANDBOX = "handover_worktree";

/** The receiver's own clone of the shared repository, which its worktrees come from. */
function handoverClone(remoteUrl: string): { workspaceId: number; workDirectory: string } {
  for (const workspace of workspaces.list()) {
    if (!workspace.workDirectoryExists) continue;
    const origin = tryGit(workspace.workDirectory, ["config", "--get", "remote.origin.url"])?.trim();
    if (origin === remoteUrl) return { workspaceId: workspace.id, workDirectory: workspace.workDirectory };
  }
  throw new WorkspaceError(409, "handover_clone_missing",
    "This workstation has no registered workspace cloned from the team repository, so it cannot run a handover. Add one and try again.");
}

/** The suite a discovered offer's candidate task is minted in. */
function handoverSuite(workspaceId: number): number {
  const tree = workspaces.tree(workspaceId);
  const program = tree.programs.find(one => one.name === HANDOVER_PROGRAM)
    ?? workspaces.createChild("program", workspaceId, { name: HANDOVER_PROGRAM, overview: "Work items handed over by a teammate." }) as ProgramRecord;
  const suites = (program.suites ?? workspaces.tree(workspaceId).programs.find(one => one.id === program.id)?.suites ?? []) as SuiteRecord[];
  const suite = suites.find(one => one.name === HANDOVER_SUITE)
    ?? workspaces.createChild("suite", program.id, { name: HANDOVER_SUITE, overview: "One task per offer this workstation has discovered." }) as SuiteRecord;
  return suite.id;
}

export interface SurfaceContext {
  roster: TeamRoster;
  botId: string;
  /** Provider ids this workstation is logged in to, refreshed by its caller. */
  providers: string[];
}

export function receiverEnvironment(context: SurfaceContext): ReceiverEnvironment {
  const member = memberFor(context.roster, context.botId);
  const clone = handoverClone(context.roster.remoteUrl);
  // Read through the context rather than captured once, so B19's re-validation
  // immediately before starting really does see the current settings.
  const policy = () => receiverPolicy(context.providers);
  return {
    personId: member.personId,
    workstationId: member.workstationId,
    botId: context.botId,
    chatId: context.roster.groupChatId,
    topicId: null,
    actorId: groupActorId(context.roster, member),
    roster: context.roster.members.map(one => one.personId),
    workspaceId: clone.workspaceId,
    suiteId: handoverSuite(clone.workspaceId),
    policy,
  };
}

export function requesterEnvironment(context: SurfaceContext, itemId: string): RequesterEnvironment {
  const member = memberFor(context.roster, context.botId);
  const link = workspaces.itemLink(itemId);
  if (link === null) throw new WorkspaceError(404, "item_not_found", "This Team item is no longer available.");
  const home = workspaces.promptHome(link.promptId);
  return {
    personId: member.personId,
    workstationId: member.workstationId,
    botId: context.botId,
    chatId: context.roster.groupChatId,
    topicId: null,
    actorId: groupActorId(context.roster, member),
    roster: context.roster.members.map(one => one.personId),
    workDirectory: workspaces.get(home.workspaceId).workDirectory,
    remoteUrl: context.roster.remoteUrl,
  };
}

/* --------------------------------- baseline -------------------------------- */

/**
 * The complete baseline the apply compares against.
 *
 * It is written locally at publish, because it is the requester's own record of
 * their workspace at export and must survive the receiver touching the context
 * file on the branch. Reading it back off the branch is the fallback, for a
 * requester who published from a workstation that has since been reinstalled.
 */
function recordBaseline(preview: CapturePreview): void {
  writeJsonFile(baselinePath(preview.itemId), preview.context.baseline);
}

export function handoverBaseline(env: RequesterEnvironment, itemId: string): HandoverBaseline {
  const path = baselinePath(itemId);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as HandoverBaseline;
    } catch { /* fall through to the branch */ }
  }
  const raw = tryGit(env.workDirectory, ["show", `refs/aw/handover/${itemId}:${CONTEXT_PATH}`]);
  if (raw === null) {
    throw new WorkspaceError(409, "handover_baseline_missing",
      "This workstation has no record of the baseline this item was captured from, so a result cannot be compared against it.");
  }
  const context = JSON.parse(raw) as { baseline?: HandoverBaseline };
  if (context.baseline === undefined) {
    throw new WorkspaceError(502, "handover_baseline_missing", "The handover package carries no baseline.");
  }
  return context.baseline;
}

/* ----------------------------- the preview cache ---------------------------- */

/**
 * The preview a requester is shown and the package they then confirm are the
 * same one. Re-capturing at publish would mint a second snapshot commit and
 * publish a package nobody reviewed, so the preview is held here between the
 * two taps and a publish without one is refused rather than guessed at.
 */
const previews = new Map<string, CapturePreview>();

export function cachedPreview(itemId: string): CapturePreview | null {
  return previews.get(itemId) ?? null;
}

/* ------------------------------ requester side ------------------------------ */

export async function beginItemHandover(context: SurfaceContext, itemId: string): Promise<{ record: ControlRecord; head: string }> {
  assertHandoverEnabled();
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  const outcome = await beginHandover(remote, {
    itemId,
    requester: env.personId,
    commandId: commandId("begin"),
    workstationId: env.workstationId,
  });
  return { record: outcome.record, head: outcome.head };
}

export async function previewItemHandover(
  context: SurfaceContext,
  itemId: string,
  input: { provider: string; model?: string | null },
): Promise<CapturePreview> {
  assertHandoverEnabled();
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  const preview = await captureHandoverPackage({
    itemId,
    requester: env.personId,
    provider: input.provider,
    model: input.model ?? null,
    control: remote,
    // A route answers; it does not sit on a socket for five minutes waiting for
    // somebody else's run to end. The refusal says what to do instead.
    idleWait: { attempts: 2, delayMs: 250 },
  });
  previews.set(itemId, preview);
  return preview;
}

export async function publishItemHandover(
  context: SurfaceContext,
  itemId: string,
  input: { confirmations: HandoverConfirmation[]; acknowledgedBytes: number },
): Promise<{ offer: PublishedOffer; record: ControlRecord }> {
  assertHandoverEnabled();
  const preview = previews.get(itemId);
  if (preview === undefined) {
    throw new WorkspaceError(409, "preview_required",
      "Review the capture preview before publishing this offer; nothing is published from a package nobody has seen.");
  }
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  const packages = new BareGitHandoverPackageRemote(preview.workDirectory, env.remoteUrl);
  const published = await publishHandoverOffer({
    preview,
    control: remote,
    packages,
    commandId: commandId("publish"),
    actor: { personId: env.personId, workstationId: env.workstationId },
    confirmations: input.confirmations,
    acknowledgedBytes: input.acknowledgedBytes,
    // Every offer states the sandbox it is to be run under, so a receiver's
    // policy compares against something rather than against "unstated".
    requested: { hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
  });
  recordBaseline(preview);
  offeredProviders.set(itemId, { provider: preview.provider, model: preview.model });
  previews.delete(itemId);
  return { offer: published.offer, record: published.outcome.record };
}

export async function reviewItemHandover(context: SurfaceContext, itemId: string) {
  assertHandoverEnabled();
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  const outcome = await reviewReturnedResult(remote, {
    env,
    itemId,
    baseline: handoverBaseline(env, itemId),
    integrationRoot: integrationRoot(),
  });
  return outcome;
}

export async function applyItemHandover(context: SurfaceContext, itemId: string, input: { acceptanceMet: boolean }) {
  assertHandoverEnabled();
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  return applyReturnedResult(remote, {
    env,
    itemId,
    baseline: handoverBaseline(env, itemId),
    commandId: commandId("apply"),
    acceptance: { met: input.acceptanceMet },
    integrationRoot: integrationRoot(),
  });
}

export async function requestItemChanges(context: SurfaceContext, itemId: string, input: { requirements: string }) {
  assertHandoverEnabled();
  const env = requesterEnvironment(context, itemId);
  const remote = controlRemote(itemId, env.remoteUrl);
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const result = await readReturnedFor(remote, current.record);
  const packages = new BareGitHandoverPackageRemote(env.workDirectory, env.remoteUrl);
  const branch = handoverBranch(itemId);
  return requestHandoverChanges(remote, {
    env,
    itemId,
    commandId: commandId("changes"),
    requirementsRevision: input.requirements,
    // The new round is offered from the work that came back, which is what the
    // returning receiver pushed on the same branch.
    packageHash: `sha1:${result.resultCommit}`,
    snapshotCommit: result.resultCommit,
    provider: providerForItem(itemId).provider,
    model: providerForItem(itemId).model,
    requested: { hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
    verifyBranch: () => packages.verify(result.resultCommit, branch),
  });
}

async function readReturnedFor(remote: ControlRecordRemote, record: ControlRecord): Promise<{ resultCommit: string }> {
  if (record.lastCommandId === null) throw new WorkspaceError(409, "result_incomplete", "This item has nothing to send back.");
  const event = await remote.readEvent(record.lastCommandId);
  const resultCommit = event?.payload.result?.resultCommit;
  if (typeof resultCommit !== "string" || resultCommit === "") {
    throw new WorkspaceError(409, "result_incomplete", "This item has nothing to send back.");
  }
  return { resultCommit };
}

/**
 * The provider a re-offer asks for: the one the previous round was published
 * with. It is recorded at publish rather than re-derived, because a re-offer
 * that quietly asked for a different provider would change what every receiver
 * compares against.
 */
const offeredProviders = new Map<string, { provider: string; model: string | null }>();

function providerForItem(itemId: string): { provider: string; model: string | null } {
  const recorded = offeredProviders.get(itemId);
  if (recorded !== undefined) return recorded;
  throw new WorkspaceError(409, "handover_provider_unknown",
    "This workstation has no record of the provider this item was offered with, so it cannot re-offer it.");
}

/* ------------------------------- the tap handler ---------------------------- */

function receipt(tap: HandoverTap, state: "APPLIED" | "REJECTED", message: string, errorCode?: string): TaskControlReceipt {
  const prior = workspaces.taskControlReceiptForAction(tap.actionRef);
  if (prior !== null) return prior;
  return workspaces.recordTaskControlReceipt({
    commandId: tap.commandId,
    actionRef: tap.actionRef,
    state,
    message,
    errorCode: errorCode ?? null,
  });
}

function answered(tap: HandoverTap, fallback: string): TaskControlReceipt {
  const recorded = workspaces.taskControlReceiptForAction(tap.actionRef);
  return recorded ?? receipt(tap, "APPLIED", fallback);
}

/**
 * The production caller `registerHandoverTapHandler` never had. Every tap has
 * already passed the capability gate in `TaskControlService`, so this routes
 * rather than re-deciding: the record decides what may happen, and a refusal is
 * answered with its own receipt.
 */
export async function handleHandoverTap(context: SurfaceContext, tap: HandoverTap): Promise<TaskControlReceipt> {
  const remoteUrl = context.roster.remoteUrl;
  const remote = controlRemote(tap.itemId, remoteUrl);
  try {
    switch (tap.action) {
      case "accept_offer": return await tapAccept(context, tap, remote);
      case "decline_offer": return await tapDecline(context, tap, remote);
      case "return_work": return await tapReturn(context, tap, remote);
      case "apply_result": return await tapApply(context, tap);
      case "request_changes": return await tapRequestChanges(context, tap);
      default:
        return receipt(tap, "REJECTED", `${tap.action} is not offered as a button on this workstation.`, "action_not_available");
    }
  } catch (error) {
    const code = error instanceof WorkspaceError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "This handover action failed.";
    return receipt(tap, "REJECTED", message, code);
  }
}

async function tapAccept(context: SurfaceContext, tap: HandoverTap, remote: ControlRecordRemote): Promise<TaskControlReceipt> {
  const current = await remote.read();
  if (current === null) return receipt(tap, "REJECTED", "This item has no control record yet.", "control_not_found");
  const offer = await readPublishedOffer(current.record, remote);
  if (offer === null) {
    return receipt(tap, "REJECTED", `This offer is no longer open: the item is ${current.record.state}.`, "offer_not_open");
  }
  const env = receiverEnvironment(context);
  const result = await acceptHandoverOffer(remote, {
    env,
    itemId: tap.itemId,
    offer,
    commandId: tap.commandId,
    actionRef: tap.actionRef,
    fromHead: current.head,
  });
  if (result.kind === "claimed") {
    // The claim is what the tap answers. The run is this workstation's own work
    // afterwards and must not hold the callback open, so it is started detached
    // and its failure is reported on the item's own thread.
    void runClaimedItem(context, tap.itemId, offer).catch(() => undefined);
  }
  return answered(tap, result.kind === "claimed" ? `Accepted. Preparing to run ${tap.itemId} on this workstation.` : result.reason);
}

async function tapDecline(context: SurfaceContext, tap: HandoverTap, remote: ControlRecordRemote): Promise<TaskControlReceipt> {
  const env = receiverEnvironment(context);
  await declineHandoverOffer(remote, { env, itemId: tap.itemId, commandId: tap.commandId, actionRef: tap.actionRef });
  return answered(tap, "Declined. The offer stays open for anyone else.");
}

async function tapApply(context: SurfaceContext, tap: HandoverTap): Promise<TaskControlReceipt> {
  const outcome = await applyItemHandover(context, tap.itemId, { acceptanceMet: true });
  if (outcome.kind === "blocked") return receipt(tap, "REJECTED", outcome.reason, "apply_blocked");
  if (outcome.kind === "already_applied") return receipt(tap, "APPLIED", "Already applied; this is the first receipt.");
  return receipt(tap, "APPLIED", `Applied ${outcome.label} result for ${tap.itemId}.`);
}

async function tapRequestChanges(context: SurfaceContext, tap: HandoverTap): Promise<TaskControlReceipt> {
  const outcome = await requestItemChanges(context, tap.itemId, {
    requirements: tap.content ?? "Changes requested from the review card.",
  });
  return receipt(tap, "APPLIED", `Changes requested; ${tap.itemId} is offered again at epoch ${outcome.epoch}.`);
}

/* --------------------------- the receiver's own run ------------------------- */

interface ActiveHandoverRun {
  itemId: string;
  runId: string;
  worktree: string;
  workspaceId: number;
  /** The task the run is on, in the worktree's own workspace. */
  promptId: number;
  /** The candidate task the offer card's buttons are bound to. */
  cardPromptId: number;
  provider: string;
  model: string | null;
}

/**
 * The task the receiver's run is actually on.
 *
 * `startReceiverRun` hands `spawn` the candidate task's id together with the
 * worktree's brand-new workspace, but a task belongs to one workspace and
 * `resolvePrompt` refuses a pair that does not match, so the product's only
 * spawn path cannot take that pair. The candidate task stays what the offer
 * card's buttons are bound to, because that is what survives a restart, and the
 * work itself is a task in the worktree's workspace, which is where a receiver
 * expects to see it in their own console.
 */
function worktreeTask(workspaceId: number, itemId: string, branch: string): number {
  const program = workspaces.createChild("program", workspaceId, {
    name: HANDOVER_PROGRAM,
    overview: "Work handed over by a teammate, running in this workstation's own worktree.",
  }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: itemId, overview: branch }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, {
    title: `Handover ${itemId}`,
    content: `Finish the work published on ${branch} for Team item ${itemId}. `
      + `The requester's context is in ${CONTEXT_PATH}.`,
  }) as PromptRecord;
  return prompt.id;
}

const activeRuns = new Map<string, ActiveHandoverRun>();

export function activeHandoverRun(itemId: string): ActiveHandoverRun | null {
  return activeRuns.get(itemId) ?? null;
}

async function runClaimedItem(context: SurfaceContext, itemId: string, offer: PublishedOffer): Promise<void> {
  const env = receiverEnvironment(context);
  const clone = handoverClone(context.roster.remoteUrl);
  let spawnedRunId: string | null = null;
  let spawnedPromptId: number | null = null;
  const result = await startReceiverRun(controlRemote(itemId, context.roster.remoteUrl), {
    env,
    itemId,
    offer,
    commandIdPrefix: commandId("run"),
    clone: { directory: clone.workDirectory, worktreeRoot: worktreeRoot() },
    spawn: async spawn => {
      // The engine reserves the worktree under its own run id before the
      // asynchronous provider check, which is the ordering B19 and D19 require.
      // `startExecute` reserves again under the id it mints, so the engine's
      // reservation is released here first: the directory is owned once, by the
      // run that actually exists.
      workspaces.markStartIntent(spawn.runId, "KNOWN_STOPPED", "Handed to the run service, which owns this start.");
      try {
        spawnedPromptId = worktreeTask(spawn.workspaceId, itemId, offer.branch);
        spawnedRunId = (await startExecute({
          workspaceId: spawn.workspaceId,
          promptId: spawnedPromptId,
          provider: spawn.provider,
          model: spawn.model,
        })).runId;
        return { kind: "started" };
      } catch (error) {
        return { kind: "no_spawn", reason: error instanceof Error ? error.message : "The run could not be started." };
      }
    },
  });
  if (result.kind === "started" && spawnedRunId !== null && spawnedPromptId !== null) {
    activeRuns.set(itemId, {
      itemId,
      runId: spawnedRunId,
      worktree: result.worktree,
      workspaceId: result.workspaceId,
      promptId: spawnedPromptId,
      cardPromptId: result.promptId,
      provider: offer.provider,
      model: offer.model,
    });
  }
}

/**
 * The commits the receiver made, pushed on the **same branch**, which is what a
 * return publishes. Nothing is force-pushed and no other branch is touched.
 */
function commitResult(run: ActiveHandoverRun, itemId: string): string {
  git(run.worktree, ["add", "-A", "--", "."]);
  const dirty = git(run.worktree, ["status", "--porcelain=v1"]).trim() !== "";
  if (dirty) {
    spawnSync("git", ["commit", "-q", "-m", `Handover result for ${itemId}`], {
      cwd: run.worktree,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "agent-console", GIT_AUTHOR_EMAIL: "agent-console@invalid",
        GIT_COMMITTER_NAME: "agent-console", GIT_COMMITTER_EMAIL: "agent-console@invalid",
      },
    });
  }
  return git(run.worktree, ["rev-parse", "HEAD"]).trim();
}

async function tapReturn(context: SurfaceContext, tap: HandoverTap, remote: ControlRecordRemote): Promise<TaskControlReceipt> {
  const run = activeRuns.get(tap.itemId);
  if (run === undefined) {
    return receipt(tap, "REJECTED", "This workstation is not running this item.", "handover_run_missing");
  }
  const env = receiverEnvironment(context);
  const resultCommit = commitResult(run, tap.itemId);
  const stopReason = classifyHandoverStop(handoverStopSignal(run.promptId));
  const returned = await returnHandoverWork(remote, {
    env,
    itemId: tap.itemId,
    commandIdPrefix: commandId("return"),
    stopReason,
    resultCommit,
    runId: run.runId,
    push: async () => {
      git(run.worktree, ["push", context.roster.remoteUrl, `HEAD:refs/heads/${handoverBranch(tap.itemId)}`]);
    },
    verification: (workspaces.promptHistory(run.promptId).runs as Array<{ role: string; id?: string }>)
      .filter(one => one.role === "execute")
      .map(one => `run ${String(one.id ?? "")} on ${env.workstationId}`),
  });
  activeRuns.delete(tap.itemId);
  return receipt(tap, "APPLIED", `Returned ${returned.label} work for ${tap.itemId} (${returned.stopReason}).`);
}

/**
 * B05's stop reasons, read from what the run actually recorded. **Quota is its
 * own reason** and is never collapsed into a tool failure or an unknown stop,
 * and an unknown stop is never classified as quota by default.
 */
const QUOTA_SHAPE = /\b(quota|usage limit|rate[ _-]?limit|out of credit|insufficient_quota)\b/i;

export function handoverStopSignal(promptId: number): { completed?: boolean; quotaExhausted?: boolean; providerFailed?: boolean; humanBlocker?: boolean } {
  const status = workspaces.promptOutcome(promptId).status;
  const activity = workspaces.latestRunActivity(promptId);
  const said = (activity?.events ?? [])
    .map(event => JSON.stringify((event as { payload?: unknown }).payload ?? ""))
    .join(" ");
  // Quota is its own reason and is read only from a provider saying so. An
  // unknown stop stays unknown: nothing here guesses quota from a bare failure.
  const quota = QUOTA_SHAPE.test(said);
  const failed = activity?.state === "FAILED";
  return {
    completed: status === "DONE",
    quotaExhausted: quota,
    providerFailed: failed && !quota,
    humanBlocker: status === "BLOCKED",
  };
}

/**
 * The Return work card, posted by the receiver's **own** bot once its run has
 * ended. The tap on it is what publishes the result; nothing returns work on a
 * receiver's behalf.
 */
export function postReturnWorkCard(context: SurfaceContext, itemId: string, run: ActiveHandoverRun, record: ControlRecord): number | null {
  const existing = workspaces.handoverActionsForItem(context.botId, itemId).some(one => one.action === "return_work");
  if (existing) return null;
  const env = receiverEnvironment(context);
  const ref = `tc_${randomBytes(18).toString("base64url")}`;
  const reason = classifyHandoverStop(handoverStopSignal(run.promptId));
  workspaces.createTaskControlAction({
    ref,
    action: "return_work",
    promptId: run.promptId,
    actorId: env.actorId,
    chatId: env.chatId,
    topicId: env.topicId ?? null,
    botId: context.botId,
    messageId: `handover-return-${itemId}`,
    expectedRevision: workspaces.humanInputState(run.promptId).revision,
    expiresAt: new Date(Date.now() + (harnessSeams.actionTtlMs ?? 10 * 60 * 1000)).toISOString(),
    subjectKind: "task",
    payload: { kind: "handover_offer", itemId, epoch: record.epoch, packageHash: "", resultId: null },
  });
  return workspaces.enqueueTelegramOutbox({
    botId: context.botId,
    chatId: env.chatId,
    topicId: env.topicId ?? null,
    payload: renderTeamItemActionCard({
      itemId,
      title: "Return work",
      detail: reason === "completed"
        ? "This run finished. Return the work to the requester for review."
        : `This run stopped: ${reason}. Returning it publishes what is done so far, labelled partial, and releases this workstation.`,
      actions: [{ ref, action: "return_work" }],
    }),
    subject: itemSubject(itemId),
  });
}

/* ----------------------------- the control poll ----------------------------- */

export interface ControlPollResult {
  items: number;
  discovered: string[];
  reviewed: string[];
  expired: string[];
  returnable: string[];
}

/**
 * One pass of the shared-record read (criterion 2, tm4.md's 5-second default).
 *
 * This is what makes an offer arrive without anyone telling a workstation to
 * look. It does four things and each is one workstation's own business:
 *
 * - a teammate discovers an open call and posts **its own** Accept card;
 * - a requester whose offer has passed its 24-hour deadline records the expiry
 *   through the same validated shared update as a decline (it is never inferred);
 * - a requester whose work has come back is shown the review card, which is what
 *   makes D01 work: the return lands while env A is stopped and the card appears
 *   when it returns;
 * - a receiver whose run has ended is offered Return work.
 */
export async function pollControlRecords(context: SurfaceContext): Promise<ControlPollResult> {
  const result: ControlPollResult = { items: 0, discovered: [], reviewed: [], expired: [], returnable: [] };
  if (!settings.team.enabled || !settings.team.handoverEnabled) return result;
  const me = memberFor(context.roster, context.botId);
  for (const itemId of listControlItems(context.roster.remoteUrl)) {
    result.items += 1;
    const remote = controlRemote(itemId, context.roster.remoteUrl);
    let current: Awaited<ReturnType<ControlRecordRemote["read"]>>;
    try { current = await remote.read(); } catch { continue; }
    if (current === null) continue;
    const record = current.record;
    const mine = record.requester === me.personId;
    try {
      if (mine && record.state === "OFFERED") {
        const expiry = await expireOfferIfDue(remote, {
          actor: { personId: me.personId, workstationId: me.workstationId },
          commandId: commandId("expire"),
          roster: context.roster.members.map(one => one.personId),
        });
        if (expiry.expired) { result.expired.push(itemId); continue; }
      }
      if (!mine && record.state === "OFFERED") {
        const discovery = await discoverHandoverOffer(remote, receiverEnvironment(context));
        if (discovery.kind === "offer") result.discovered.push(itemId);
        continue;
      }
      if (mine && record.state === "RETURNED" && workspaces.itemLink(itemId) !== null) {
        await reviewItemHandover(context, itemId);
        result.reviewed.push(itemId);
        continue;
      }
      if (!mine && record.executor === me.personId) {
        const run = activeRuns.get(itemId);
        if (run !== undefined && runEnded(run)) {
          result.returnable.push(itemId);
          postReturnWorkCard(context, itemId, run, record);
        }
      }
    } catch { /* one item's failure never stops the pass */ }
  }
  return result;
}

function runEnded(run: ActiveHandoverRun): boolean {
  const runs = workspaces.promptHistory(run.promptId).runs as Array<{ role: string; endedAt: string | null }>;
  return runs.some(one => one.role === "execute") && !runs.some(one => one.role === "execute" && one.endedAt === null);
}

/* ------------------------------- the web view ------------------------------- */

export interface HandoverItemStatus {
  itemId: string;
  state: ControlRecord["state"];
  epoch: number;
  requester: string;
  executor: string | null;
  branch: string;
  hold: { held: boolean; reason: string };
}

export async function handoverStatus(context: SurfaceContext, itemId: string): Promise<HandoverItemStatus | null> {
  const env = requesterEnvironment(context, itemId);
  const current = await controlRemote(itemId, env.remoteUrl).read();
  if (current === null) return null;
  return {
    itemId,
    state: current.record.state,
    epoch: current.record.epoch,
    requester: current.record.requester,
    executor: current.record.executor,
    branch: current.record.branch,
    hold: handoverPipelineHold(itemId, current.record),
  };
}

/** Exposed for the tests that drive the surface without a Telegram session. */
export const handoverSurfaceInternals = { previews, activeRuns, offeredProviders, controlRef, controlBare, worktreeRoot };

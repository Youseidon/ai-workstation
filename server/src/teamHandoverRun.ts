import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PromptRecord, TaskControlAction } from "@agent-console/shared";
import { harnessSeams } from "./harnessSeams.ts";
import { settings } from "./settings.ts";
import { renderHandoverOfferCard } from "./taskControlRenderer.ts";
import {
  applyControlTransition,
  type ControlRecord,
  type ControlRecordRemote,
  type ControlTransitionInput,
} from "./teamControlRecord.ts";
import { readPublishedOffer, type PublishedOffer } from "./teamHandoverCapture.ts";
import { itemSubject, WorkspaceError, workspaces } from "./workspaces.ts";

/**
 * Accept, claim and run (H04, TM-T1-H1 and TM-T1-H2).
 *
 * A receiver's workstation discovers an open-call offer by reading the shared
 * record on its poll, posts its own Accept and run card from its own bot,
 * claims the item through the control record's compare-and-swap, and runs it in
 * a worktree of `aw/handover/<item>` under **its own** provider login, settings
 * and quota.
 *
 * Three boundaries this module keeps, because each of them is a rule rather
 * than a preference:
 *
 * - **The record decides a race, not a bot.** Every accept goes through
 *   `applyControlTransition`, so a simultaneous accept is settled by the
 *   remote's non-fast-forward rejection. The loser re-reads, is told who holds
 *   the item, goes inert and starts nothing.
 * - **A decline is a local fact.** handover-rules.md 4.3's outcome half is still
 *   Proposed and unruled, so declining records a receipt, ends that person's own
 *   buttons and leaves the record exactly where it was. Nothing here moves the
 *   record on a decline.
 * - **Only the current executor acknowledges physical stop or release.** A
 *   requester may request Pause or Cancel; there is no path here by which one
 *   workstation stops another's run, and none is offered.
 */

/* ------------------------- RTC-12, the capability matrix ------------------- */

/**
 * protocol.md section 8, made executable. `L` is the receiver's own approved
 * policy for this workspace and `R` is what the incoming package declares, both
 * as enforceable capability tokens rather than an ordinal list of strings.
 *
 * The four outcomes are evaluated in this order, and the order is the contract:
 * an explicit denial takes precedence over everything, unknown enforcement is
 * never treated as allowed, and only then does a grantable delta get a local
 * prompt. **An omitted requirement is not permission**: a token no local policy
 * mentions is UNKNOWN, not permitted.
 */
export type CapabilityOutcome = "within_limit" | "delta_grantable" | "hard_deny" | "unknown";

/** What an offer states it needs. An unstated field is not a permitted field. */
export interface RequestedCapabilities {
  provider: string;
  model: string | null;
  hostAccess: boolean;
  sandbox: string;
  tools?: string[];
}

export interface ReceiverPolicy {
  /** Providers this workstation is logged in to and approved for. */
  providers: string[];
  models: string[];
  hostAccess: boolean;
  sandbox: string[];
  tools: string[];
  /** Additions this receiver may grant once, for this item and revision only. */
  grantable: string[];
  /** Explicit local denials. A Telegram approval cannot override one. */
  denied: string[];
  /** Capabilities whose enforcement this adapter cannot demonstrate. */
  unenforceable: string[];
}

export interface CapabilityComparison {
  outcome: CapabilityOutcome;
  requested: string[];
  within: string[];
  /** The exact additions the receiver is shown locally; never a widened setting. */
  additions: string[];
  denied: string[];
  unknown: string[];
  reason: string;
  runnable: boolean;
  needsLocalGrant: boolean;
}

/** The token an offer's sandbox becomes when the offer does not state one. */
export const UNSTATED = "unstated";

export function capabilityTokens(requested: RequestedCapabilities): string[] {
  const tokens = [`provider:${requested.provider}`, `sandbox:${requested.sandbox}`];
  if (requested.model !== null) tokens.push(`model:${requested.model}`);
  if (requested.hostAccess) tokens.push("host_access");
  for (const tool of requested.tools ?? []) tokens.push(`tool:${tool}`);
  return tokens;
}

/** Whether the receiver's own configured policy already covers this token. */
function coveredBy(token: string, policy: ReceiverPolicy): boolean {
  if (token === "host_access") return policy.hostAccess;
  const separator = token.indexOf(":");
  if (separator < 0) return false;
  const kind = token.slice(0, separator);
  const value = token.slice(separator + 1);
  if (kind === "provider") return policy.providers.includes(value);
  if (kind === "model") return policy.models.includes(value);
  if (kind === "sandbox") return policy.sandbox.includes(value);
  if (kind === "tool") return policy.tools.includes(value);
  return false;
}

export function compareCapabilities(requested: RequestedCapabilities, policy: ReceiverPolicy): CapabilityComparison {
  const tokens = capabilityTokens(requested);
  // Deny precedence: a hard local denial wins even over the same capability
  // being grantable, and a Telegram approval cannot override it.
  const denied = tokens.filter(token => policy.denied.includes(token));
  const unenforceable = tokens.filter(token => !denied.includes(token) && policy.unenforceable.includes(token));
  const rest = tokens.filter(token => !denied.includes(token) && !unenforceable.includes(token));
  const within = rest.filter(token => coveredBy(token, policy));
  const outside = rest.filter(token => !coveredBy(token, policy));
  const additions = outside.filter(token => policy.grantable.includes(token));
  // Outside L, not grantable and not denied: there is no local policy that says
  // what to do, which is the fourth row of the table, not the second.
  const missingPolicy = outside.filter(token => !policy.grantable.includes(token));
  const unknown = [...unenforceable, ...missingPolicy];

  const outcome: CapabilityOutcome = denied.length > 0
    ? "hard_deny"
    : unknown.length > 0
      ? "unknown"
      : additions.length > 0 ? "delta_grantable" : "within_limit";
  const reason = outcome === "hard_deny"
    ? `This workstation denies ${denied.join(", ")}, and that cannot be granted from Telegram.`
    : outcome === "unknown"
      ? `This workstation has no enforceable policy for ${unknown.join(", ")}, so preparation waits. An omitted requirement is not permission.`
      : outcome === "delta_grantable"
        ? `This package needs ${additions.join(", ")} beyond your settings. Grant it for this item and revision, or decline.`
        : "This package is inside your own settings, so it starts with no second prompt.";
  return {
    outcome,
    requested: tokens,
    within,
    additions,
    denied,
    unknown,
    reason,
    runnable: outcome === "within_limit" || outcome === "delta_grantable",
    needsLocalGrant: outcome === "delta_grantable",
  };
}

/**
 * The tool boundary: "check newly requested tools at runtime". A capability the
 * accepted comparison never covered is refused here rather than inherited from
 * the start approval, and a denial is still a denial.
 */
export function assertRuntimeCapability(policy: ReceiverPolicy, comparison: CapabilityComparison, token: string): void {
  if (policy.denied.includes(token)) {
    throw new WorkspaceError(403, "capability_denied", `This workstation denies ${token}.`, { capability: token });
  }
  if (comparison.within.includes(token) || comparison.additions.includes(token)) return;
  throw new WorkspaceError(409, "capability_unknown",
    `${token} was not part of what this run was approved for, and an omitted requirement is not permission.`, { capability: token });
}

function requestedFrom(offer: PublishedOffer): RequestedCapabilities {
  return {
    provider: offer.provider,
    model: offer.model,
    hostAccess: offer.hostAccess === true,
    // An offer that states no sandbox has not been approved for one.
    sandbox: offer.sandbox ?? UNSTATED,
    tools: offer.tools ?? [],
  };
}

/* ------------------------------- environment ------------------------------ */

export interface ReceiverEnvironment {
  personId: string;
  workstationId: string;
  /** This workstation's own bot: every card and question it posts comes from here. */
  botId: string;
  chatId: string;
  topicId?: string | null;
  /** The receiver's own enrolled actor, which owns their local decisions. */
  actorId: string;
  roster: string[];
  /** The receiver's own workspace, where a candidate task for an offer is created. */
  workspaceId: number;
  suiteId: number;
  /** Read again immediately before starting, never cached from claim time (B19). */
  policy: () => ReceiverPolicy;
}

/* -------------------------------- the card -------------------------------- */

export interface OfferCard {
  outboxId: number;
  botId: string;
  actions: Array<{ ref: string; action: TaskControlAction }>;
  inert: boolean;
}

/**
 * A handover button's payload. The receiver's offer card and the requester's
 * review card (H05) both carry one, so a tap on either routes through the same
 * capability gate and reaches the handover runtime with the item it is about.
 */
interface HandoverActionPayload {
  kind: "handover_offer" | "handover_review";
  itemId: string;
  epoch: number;
  packageHash: string;
  /** Present on a review card: the result this tap would apply or send back. */
  resultId: string | null;
}

export function decodeHandoverActionPayload(json: string | null): HandoverActionPayload | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as Partial<HandoverActionPayload>;
    if (value.kind !== "handover_offer" && value.kind !== "handover_review") return null;
    if (typeof value.itemId !== "string" || typeof value.epoch !== "number") return null;
    return {
      kind: value.kind,
      itemId: value.itemId,
      epoch: value.epoch,
      packageHash: String(value.packageHash ?? ""),
      resultId: typeof value.resultId === "string" ? value.resultId : null,
    };
  } catch { return null; }
}

const actionRef = () => `tc_${randomBytes(18).toString("base64url")}`;

const ttl = (options: { ttlMs?: number }) => options.ttlMs ?? harnessSeams.actionTtlMs ?? 10 * 60 * 1000;

/**
 * The receiver's local candidate task for one offer. It is the task the worktree
 * is linked to once the claim wins, and it exists before the claim because a
 * card needs a local subject to bind its actions to. It claims nothing: no
 * `item_link` is written until the compare-and-swap has been won.
 */
function candidatePrompt(env: ReceiverEnvironment, offer: PublishedOffer): number {
  const existing = workspaces.handoverCandidatePrompt(env.botId, offer.itemId);
  if (existing !== null) return existing;
  const prompt = workspaces.createChild("prompt", env.suiteId, {
    title: `Handover ${offer.itemId}`,
    content: `Finish the work published on ${offer.branch} for Team item ${offer.itemId}.`,
  }) as PromptRecord;
  return prompt.id;
}

function offerCardPayload(
  offer: PublishedOffer,
  comparison: CapabilityComparison,
  promptId: number | null,
  actions: Array<{ ref: string; action: TaskControlAction }>,
  inert?: { reason: string },
) {
  return renderHandoverOfferCard({
    itemId: offer.itemId,
    branch: offer.branch,
    epoch: offer.epoch,
    startDeadline: offer.startDeadline,
    requested: { provider: offer.provider, model: offer.model, hostAccess: offer.hostAccess, sandbox: offer.sandbox, tools: offer.tools },
    capability: { outcome: comparison.outcome, additions: comparison.additions, denied: comparison.denied, unknown: comparison.unknown, reason: comparison.reason },
    promptId,
    actions,
    inert: inert !== undefined,
    reason: inert?.reason,
  });
}

function postOfferCard(
  env: ReceiverEnvironment,
  offer: PublishedOffer,
  comparison: CapabilityComparison,
  promptId: number,
  options: { now?: Date; ttlMs?: number },
): OfferCard {
  const expiresAt = new Date((options.now ?? new Date()).getTime() + ttl(options)).toISOString();
  const revision = workspaces.humanInputState(promptId).revision;
  // A hard denial or an unknown capability offers no Accept and run at all, so
  // the local decision cannot be overridden by a tap.
  const wanted: TaskControlAction[] = comparison.runnable ? ["accept_offer", "decline_offer"] : ["decline_offer"];
  const actions = wanted.map(action => ({ ref: actionRef(), action }));
  const payload: HandoverActionPayload = { kind: "handover_offer", itemId: offer.itemId, epoch: offer.epoch, packageHash: offer.packageHash, resultId: null };
  for (const action of actions) {
    workspaces.createTaskControlAction({
      ref: action.ref,
      action: action.action,
      promptId,
      actorId: env.actorId,
      chatId: env.chatId,
      topicId: env.topicId ?? null,
      botId: env.botId,
      messageId: `handover-${offer.itemId}`,
      expectedRevision: revision,
      expiresAt,
      subjectKind: "task",
      payload,
    });
  }
  const outboxId = workspaces.enqueueTelegramOutbox({
    botId: env.botId,
    chatId: env.chatId,
    topicId: env.topicId ?? null,
    payload: offerCardPayload(offer, comparison, promptId, actions),
    subject: itemSubject(offer.itemId),
  });
  return { outboxId, botId: env.botId, actions, inert: false };
}

/**
 * Edits this workstation's own card inert and ends its remaining buttons. It is
 * purely local: the shared record is never touched from here.
 */
function goInert(env: ReceiverEnvironment, offer: PublishedOffer, comparison: CapabilityComparison, reason: string): boolean {
  workspaces.expireHandoverActionsForItem(env.botId, offer.itemId);
  const outboxId = workspaces.handoverOfferCardOutbox(env.botId, offer.itemId);
  if (outboxId === null) return false;
  workspaces.enqueueTelegramEdit({
    botId: env.botId,
    targetOutboxId: outboxId,
    payload: offerCardPayload(offer, comparison, workspaces.handoverCandidatePrompt(env.botId, offer.itemId), [], { reason }),
  });
  return true;
}

/* -------------------------------- discovery ------------------------------- */

export type Discovery =
  | { kind: "none" }
  | { kind: "own_offer"; itemId: string }
  | {
    kind: "offer";
    offer: PublishedOffer;
    comparison: CapabilityComparison;
    promptId: number;
    card: OfferCard;
  };

/**
 * Step 4 of teammate-design.md section 5.4: the receiver's workstation reads the
 * shared record on its poll, compares the requested capabilities with its own
 * settings, and posts its own Accept and run card from its own bot. Nothing is
 * read from another bot's messages.
 */
export async function discoverHandoverOffer(
  remote: ControlRecordRemote,
  env: ReceiverEnvironment,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<Discovery> {
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const offer = await readPublishedOffer(current.record, remote);
  if (offer === null) return { kind: "none" };
  // A requester does not accept their own open call.
  if (current.record.requester === env.personId) return { kind: "own_offer", itemId: offer.itemId };

  const comparison = compareCapabilities(requestedFrom(offer), env.policy());
  const existing = workspaces.handoverCandidatePrompt(env.botId, offer.itemId);
  const promptId = candidatePrompt(env, offer);
  if (existing !== null) {
    const outboxId = workspaces.handoverOfferCardOutbox(env.botId, offer.itemId);
    if (outboxId !== null) {
      // Already discovered: the card stands, and a further poll does not repost it.
      const actions = workspaces.handoverActionsForItem(env.botId, offer.itemId);
      return { kind: "offer", offer, comparison, promptId, card: { outboxId, botId: env.botId, actions, inert: false } };
    }
  }
  return { kind: "offer", offer, comparison, promptId, card: postOfferCard(env, offer, comparison, promptId, options) };
}

/* ----------------------------- accept and claim --------------------------- */

export type AcceptResult =
  | { kind: "claimed"; record: ControlRecord; head: string; promptId: number }
  | { kind: "lost"; record: ControlRecord; holder: string | null; reason: string }
  | { kind: "refused"; comparison: CapabilityComparison | null; reason: string };

export interface AcceptInput {
  env: ReceiverEnvironment;
  itemId: string;
  offer: PublishedOffer;
  commandId: string;
  /** The tap's own action, so a losing or expired tap is answered with its own receipt. */
  actionRef?: string;
  /** The head the tap was minted against, so a simultaneous accept is driven from one head. */
  fromHead?: string;
  now?: Date;
}

/** A lost race, not a bug: every one of these is re-read and re-validated. */
const RACE_CODES = new Set(["control_conflict", "control_state_invalid", "control_stale_epoch", "control_condition_unmet"]);

function answer(actionRef: string | undefined, commandId: string, state: "APPLIED" | "REJECTED", message: string, errorCode?: string): void {
  if (actionRef === undefined) return;
  if (workspaces.taskControlAction(actionRef) === null) return;
  workspaces.recordTaskControlReceipt({ commandId, actionRef, state, message, errorCode: errorCode ?? null });
}

/**
 * Step 5 of section 5.4. The claim is a compare-and-swap on the control record,
 * so which tap reached which bot first decides nothing: the update that lands
 * wins, and the loser re-reads the state that actually exists rather than
 * retrying. A claim that lost stays lost.
 */
export async function acceptHandoverOffer(remote: ControlRecordRemote, input: AcceptInput): Promise<AcceptResult> {
  const { env, itemId, offer } = input;
  const now = input.now ?? new Date();

  const action = input.actionRef === undefined ? null : workspaces.taskControlAction(input.actionRef);
  if (action !== null && Date.parse(action.expires_at) <= now.getTime()) {
    const reason = "Not applied: this action expired. Review the current item state.";
    answer(input.actionRef, input.commandId, "REJECTED", reason, "action_expired");
    return { kind: "refused", comparison: null, reason };
  }

  // The receiver's own policy decides whether it may run this at all, and a
  // hard denial or an unknown capability can never be overridden by a tap.
  const comparison = compareCapabilities(requestedFrom(offer), env.policy());
  if (!comparison.runnable) {
    answer(input.actionRef, input.commandId, "REJECTED", comparison.reason, `capability_${comparison.outcome}`);
    return { kind: "refused", comparison, reason: comparison.reason };
  }

  try {
    const outcome = await applyControlTransition(remote, {
      event: "accept_offer",
      actor: { personId: env.personId, workstationId: env.workstationId },
      commandId: input.commandId,
      epoch: offer.epoch,
      roster: env.roster,
      now,
      fromHead: input.fromHead,
    });
    if (outcome.record.executor !== env.personId) {
      // The command id was already recorded by someone else's outcome.
      throw new WorkspaceError(409, "control_conflict", "Another workstation claimed this item first.",
        { state: outcome.record.state, epoch: String(outcome.record.epoch), itemId });
    }
    // Only a winning claim writes anything local: the loser links nothing.
    const promptId = candidatePrompt(env, offer);
    if (workspaces.itemLink(itemId) === null) {
      workspaces.createItemLink({ itemId, promptId, role: "executor", epoch: outcome.record.epoch });
    }
    workspaces.updateItemControlHead({ itemId, controlHead: outcome.head, epoch: outcome.record.epoch });
    answer(input.actionRef, input.commandId, "APPLIED", `Accepted. Preparing to run ${itemId} on this workstation.`);
    return { kind: "claimed", record: outcome.record, head: outcome.head, promptId };
  } catch (error) {
    if (!(error instanceof WorkspaceError) || !RACE_CODES.has(error.code)) throw error;
    const settled = await remote.read();
    if (settled === null) throw error;
    const holder = settled.record.executor;
    const reason = holder === null
      ? `This offer is no longer open: the item is ${settled.record.state}.`
      : `${holder} holds this item now (${settled.record.state}).`;
    answer(input.actionRef, input.commandId, "REJECTED", reason, "control_conflict");
    goInert(env, offer, comparison, reason);
    return { kind: "lost", record: settled.record, holder, reason };
  }
}

export interface DeclineResult {
  recorded: boolean;
  cardInert: boolean;
  recordState: ControlRecord["state"];
  recordHead: string;
}

/**
 * handover-rules.md 4.3, the half that follows from the open call already being
 * Ruled: a decline is **recorded rather than silent**, that person's own card
 * goes inert, and the offer stays `OFFERED` for anyone else.
 *
 * Deliberately not a record transition. The record tier's `decline_offer` moves
 * `OFFERED` to `WITHDRAWN`, which is protocol.md's table and what TM-T0-6
 * asserts; reading a per-person decline onto it would withdraw an open call
 * because one teammate passed. That reading is row 4.3's outcome half, which is
 * still Proposed and unruled, so nothing here decides it: this writes no shared
 * update at all.
 */
export async function declineHandoverOffer(
  remote: ControlRecordRemote,
  input: { env: ReceiverEnvironment; itemId: string; commandId: string; actionRef: string },
): Promise<DeclineResult> {
  const { env } = input;
  const action = workspaces.taskControlAction(input.actionRef);
  if (action === null || action.action !== "decline_offer") {
    throw new WorkspaceError(404, "action_not_found", "This decline action is no longer available.");
  }
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const offer = await readPublishedOffer(current.record, remote);
  if (offer === null) throw new WorkspaceError(409, "offer_not_open", "This item is no longer offering anything.", { state: current.record.state });

  workspaces.recordTaskControlReceipt({
    commandId: input.commandId,
    actionRef: input.actionRef,
    state: "APPLIED",
    message: "Declined. The offer stays open for anyone else.",
  });
  const cardInert = goInert(env, offer, compareCapabilities(requestedFrom(offer), env.policy()),
    "You declined this offer. It stays open for anyone else on the team.");

  const after = await remote.read();
  return {
    recorded: true,
    cardInert,
    recordState: after!.record.state,
    recordHead: after!.head,
  };
}

/* ----------------------------------- run ---------------------------------- */

export type SpawnOutcome =
  | { kind: "started" }
  | { kind: "no_spawn"; reason: string }
  | { kind: "unknown"; reason: string };

export interface StartReceiverRunInput {
  env: ReceiverEnvironment;
  itemId: string;
  offer: PublishedOffer;
  commandIdPrefix: string;
  clone: { directory: string; worktreeRoot: string };
  spawn: (context: {
    runId: string;
    workspaceId: number;
    promptId: number;
    worktree: string;
    provider: string;
    model: string | null;
  }) => Promise<SpawnOutcome>;
  /** The asynchronous provider check, which runs after the reservation exists. */
  checkProvider?: () => Promise<void>;
  now?: Date;
}

export type StartResult =
  | { kind: "started"; runId: string; worktree: string; workspaceId: number; promptId: number; record: ControlRecord }
  | { kind: "refused"; comparison: CapabilityComparison; record: ControlRecord; reason: string }
  | { kind: "no_spawn"; record: ControlRecord; reason: string }
  | { kind: "start_unknown"; runId: string; reason: string; requiresReconciliation: true };

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new WorkspaceError(502, "handover_worktree_failed", (result.stderr || result.stdout || "A Git worktree operation failed.").trim());
  }
}

/**
 * A worktree of `aw/handover/<item>` in the receiver's own clone. Detached, so
 * it never competes with whatever the clone's own checkout holds and never
 * renames the receiver's branches; the result is pushed back to the same branch.
 */
function addWorktree(clone: { directory: string; worktreeRoot: string }, itemId: string, branch: string): string {
  git(clone.directory, ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const directory = join(clone.worktreeRoot, itemId);
  git(clone.directory, ["worktree", "add", "-q", "--detach", directory, `refs/remotes/origin/${branch}`]);
  return directory;
}

function removeWorktree(cloneDirectory: string, directory: string): void {
  spawnSync("git", ["worktree", "remove", "--force", directory], { cwd: cloneDirectory, encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
}

/** Reads the current head and applies one transition from it. */
async function advance(remote: ControlRecordRemote, input: Omit<ControlTransitionInput, "epoch" | "fromHead">): Promise<{ record: ControlRecord; head: string }> {
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const outcome = await applyControlTransition(remote, { ...input, epoch: current.record.epoch, fromHead: current.head });
  return { record: outcome.record, head: outcome.head };
}

/**
 * Step 6 of section 5.4, in protocol.md section 6's order.
 *
 * 1. The receiver's own settings are read **again**, immediately before
 *    starting, rather than trusted from claim time (B19).
 * 2. The workspace is reserved atomically **before** the asynchronous provider
 *    check, and the reservation is a durable START_INTENT keyed on the effective
 *    directory.
 * 3. Only then is the run spawned, and an unknown outcome is START_UNKNOWN,
 *    which requires reconciliation and is never retried automatically (B23).
 *
 * Every failure path before the spawn removes the worktree and the workspace it
 * created, so a refusal starts nothing and leaves no orphan.
 */
export async function startReceiverRun(remote: ControlRecordRemote, input: StartReceiverRunInput): Promise<StartResult> {
  const { env, itemId, offer } = input;
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  if (current.record.state !== "CLAIMED" || current.record.executor !== env.personId) {
    throw new WorkspaceError(409, "control_state_invalid", `This workstation cannot start ${itemId} from ${current.record.state}.`,
      { state: current.record.state, epoch: String(current.record.epoch), itemId });
  }

  // B19: re-validate immediately before starting, not at claim time.
  const comparison = compareCapabilities(requestedFrom(offer), env.policy());
  if (!comparison.runnable) {
    return { kind: "refused", comparison, record: current.record, reason: comparison.reason };
  }

  const link = workspaces.itemLink(itemId);
  if (link === null || link.role !== "executor") {
    throw new WorkspaceError(409, "item_not_found", "This workstation does not hold this item as executor.", { itemId });
  }
  const promptId = link.promptId;
  const runId = `run_${randomBytes(12).toString("hex")}`;

  let worktree: string | null = null;
  let workspaceId: number | null = null;
  const discard = () => {
    if (workspaceId !== null) { try { workspaces.remove(workspaceId); } catch { /* already gone */ } }
    if (worktree !== null) removeWorktree(input.clone.directory, worktree);
  };
  try {
    worktree = addWorktree(input.clone, itemId, offer.branch);
    workspaceId = workspaces.create({ name: `handover-${itemId}`, workDirectory: worktree }).id;
    // Atomic, and before any asynchronous provider check.
    workspaces.reserveStartIntent({ runId, workspaceId, promptId, provider: offer.provider, model: offer.model, source: "handover" });
  } catch (error) {
    discard();
    throw error;
  }

  try {
    if (input.checkProvider !== undefined) await input.checkProvider();
  } catch (error) {
    workspaces.markStartIntent(runId, "KNOWN_NO_SPAWN", "The provider check failed before this run was spawned.");
    discard();
    throw error;
  }

  await advance(remote, {
    event: "preparation_complete",
    actor: { personId: env.personId, workstationId: env.workstationId },
    commandId: `${input.commandIdPrefix}-prepare`,
    roster: env.roster,
    now: input.now,
    payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true },
  });

  const outcome = await input.spawn({ runId, workspaceId, promptId, worktree, provider: offer.provider, model: offer.model });
  if (outcome.kind === "started") {
    workspaces.markStartIntent(runId, "RUNNING");
    const running = await advance(remote, {
      event: "run_started",
      actor: { personId: env.personId, workstationId: env.workstationId },
      commandId: `${input.commandIdPrefix}-started`,
      roster: env.roster,
      now: input.now,
      payload: { runId },
    });
    return { kind: "started", runId, worktree, workspaceId, promptId, record: running.record };
  }
  if (outcome.kind === "no_spawn") {
    workspaces.markStartIntent(runId, "KNOWN_NO_SPAWN", outcome.reason);
    const back = await advance(remote, {
      event: "no_spawn_failure",
      actor: { personId: env.personId, workstationId: env.workstationId },
      commandId: `${input.commandIdPrefix}-nospawn`,
      roster: env.roster,
      now: input.now,
      payload: { spawnOutcome: "known", reason: outcome.reason },
    });
    return { kind: "no_spawn", record: back.record, reason: outcome.reason };
  }
  // An unknown spawn outcome holds ownership and requires reconciliation. It
  // advances no state and is never retried automatically.
  workspaces.markStartIntent(runId, "START_UNKNOWN", outcome.reason);
  return { kind: "start_unknown", runId, reason: outcome.reason, requiresReconciliation: true };
}

/* ------------------------------- questions -------------------------------- */

export type HandoverQuestionKind = "requirement" | "access" | "provider" | "allowance";

/**
 * "Requirements answers remain requester-owned; access decisions remain
 * executor-owned" (protocol.md section 5). A requirement question is issued to
 * the requester as actor, so it applies while their workstation is stopped;
 * access, provider and allowance questions are the receiver's own and are asked
 * locally. Either way the question is posted by the receiver's own bot, so no
 * answer is forwarded between workstations.
 */
export function handoverQuestionAudience(kind: HandoverQuestionKind): "requester" | "receiver" {
  return kind === "requirement" ? "requester" : "receiver";
}

export interface PostedHandoverQuestion {
  outboxId: number;
  botId: string;
  actorId: string;
  chatId: string;
  audience: "requester" | "receiver";
  actions: Array<{ ref: string; action: TaskControlAction }>;
}

export function postHandoverQuestion(input: {
  env: ReceiverEnvironment;
  itemId: string;
  promptId: number;
  kind: HandoverQuestionKind;
  question: string;
  requester: { actorId: string; chatId: string; topicId?: string | null };
  ttlMs?: number;
  now?: Date;
}): PostedHandoverQuestion {
  const audience = handoverQuestionAudience(input.kind);
  const target = audience === "requester"
    ? { actorId: input.requester.actorId, chatId: input.requester.chatId, topicId: input.requester.topicId ?? null }
    : { actorId: input.env.actorId, chatId: input.env.chatId, topicId: input.env.topicId ?? null };
  const expiresAt = new Date((input.now ?? new Date()).getTime() + ttl(input)).toISOString();
  const revision = workspaces.humanInputState(input.promptId).revision;
  const actions: Array<{ ref: string; action: TaskControlAction }> = [
    { ref: actionRef(), action: "save_human_response" },
    { ref: actionRef(), action: "answer_and_resume" },
  ];
  for (const action of actions) {
    workspaces.createTaskControlAction({
      ref: action.ref,
      action: action.action,
      promptId: input.promptId,
      actorId: target.actorId,
      chatId: target.chatId,
      topicId: target.topicId,
      // Always this workstation's own bot: it receives the reply directly.
      botId: input.env.botId,
      messageId: `handover-question-${input.itemId}`,
      expectedRevision: revision,
      expiresAt,
    });
  }
  const outboxId = workspaces.enqueueTelegramOutbox({
    botId: input.env.botId,
    chatId: target.chatId,
    topicId: target.topicId,
    payload: {
      kind: "handover_question",
      itemId: input.itemId,
      questionKind: input.kind,
      audience,
      question: input.question,
      actions: actions.map(action => ({ ref: action.ref, action: action.action })),
    },
    subject: audience === "requester" ? itemSubject(input.itemId) : undefined,
  });
  return { outboxId, botId: input.env.botId, actorId: target.actorId, chatId: target.chatId, audience, actions };
}

/* ------------------------- stop reasons and return ------------------------ */

/**
 * B05's distinct stop reasons. **Quota is its own reason**: it is never
 * collapsed into a tool failure, a human blocker or an unknown stop, and an
 * unknown stop is never classified as quota exhaustion by default.
 */
export const HANDOVER_STOP_REASONS = [
  "completed",
  "quota",
  "provider_failure",
  "tool_failure",
  "human_blocker",
  "cancelled",
  "unknown",
] as const;
export type HandoverStopReason = (typeof HANDOVER_STOP_REASONS)[number];

export interface StopSignal {
  completed?: boolean;
  quotaExhausted?: boolean;
  providerFailed?: boolean;
  toolFailed?: boolean;
  humanBlocker?: boolean;
  cancelled?: boolean;
}

export function classifyHandoverStop(signal: StopSignal): HandoverStopReason {
  if (signal.quotaExhausted === true) return "quota";
  if (signal.cancelled === true) return "cancelled";
  if (signal.humanBlocker === true) return "human_blocker";
  if (signal.providerFailed === true) return "provider_failure";
  if (signal.toolFailed === true) return "tool_failure";
  if (signal.completed === true) return "completed";
  return "unknown";
}

export interface ReturnResult {
  record: ControlRecord;
  label: "full" | "partial";
  releasedExecutor: boolean;
  stopReason: HandoverStopReason;
  /** The Result record's own id, which the requester's apply and receipt quote back. */
  resultId: string;
}

/**
 * Step 7 of section 5.4, and TM-T1-H2's fifth case. A receiver who cannot finish
 * pushes the commits so far on the **same branch** and returns the work
 * **labelled partial**; that label is what releases the executor. There is no
 * release action and no `RELEASED` state: `RETURNED` releases the executor
 * because protocol.md section 5 says it does.
 */
export async function returnHandoverWork(
  remote: ControlRecordRemote,
  input: {
    env: ReceiverEnvironment;
    itemId: string;
    commandIdPrefix: string;
    stopReason: HandoverStopReason;
    resultCommit: string;
    runId: string;
    push: () => Promise<void>;
    now?: Date;
    /** protocol.md section 3's Result record beyond the commit and the label. */
    resultId?: string;
    verification?: string[];
    uncertainEffects?: string[];
  },
): Promise<ReturnResult> {
  const { env } = input;
  const label: "full" | "partial" = input.stopReason === "completed" ? "full" : "partial";
  const resultId = input.resultId ?? `${input.commandIdPrefix}-result`;
  const actor = { personId: env.personId, workstationId: env.workstationId };

  workspaces.markStartIntent(input.runId, "KNOWN_STOPPED", `The run ended: ${input.stopReason}.`);
  await advance(remote, {
    event: "run_ended", actor, commandId: `${input.commandIdPrefix}-ended`, roster: env.roster, now: input.now,
    payload: { outcome: label, reason: input.stopReason },
  });

  // The result is published before the record says it was returned.
  await input.push();

  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");

  const returned = await advance(remote, {
    event: "return_work", actor, commandId: `${input.commandIdPrefix}-return`, roster: env.roster, now: input.now,
    payload: {
      resultCommit: input.resultCommit,
      resultLabel: label,
      resultId,
      // protocol.md section 3's Result record. Evidence and claimed completion
      // stay separate (B26): a returned branch is not a claim that the work is
      // right, so the evidence travels as its own field and the requester
      // reviews it. `RETURNED` is what releases the executor, and the release
      // evidence is recorded here because there is no release action.
      result: {
        resultId,
        epoch: current.record.epoch,
        resultCommit: input.resultCommit,
        label,
        verification: input.verification ?? [],
        uncertainEffects: input.uncertainEffects ?? [],
        releaseEvidence: `${env.personId} stopped ${input.runId} on ${env.workstationId}: ${input.stopReason}.`,
        executor: env.personId,
        returnedAt: (input.now ?? new Date()).toISOString(),
      },
    },
  });
  return {
    record: returned.record,
    label,
    releasedExecutor: returned.record.executor === null,
    stopReason: input.stopReason,
    resultId,
  };
}

/* --------------------- stop requests and reacquisition -------------------- */

/**
 * A requester or the current executor may **request** Pause or Cancel. The
 * request is recorded and holds scheduling; it does not stop the other
 * workstation's run, and nothing here can.
 */
export async function requestExecutorStop(
  remote: ControlRecordRemote,
  input: { itemId: string; actor: { personId: string; workstationId?: string }; kind: "pause" | "cancel"; commandId: string; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord; requested: true }> {
  const outcome = await advance(remote, {
    event: "stop_request", actor: input.actor, commandId: input.commandId, roster: input.roster, now: input.now,
    payload: { reason: `${input.kind === "pause" ? "Pause" : "Cancel"} requested by ${input.actor.personId}.` },
  });
  return { record: outcome.record, requested: true };
}

/**
 * Only the current executor can acknowledge physical stop or release, and only
 * once writing has actually stopped (B13). The table enforces both.
 */
export async function acknowledgeExecutorStop(
  remote: ControlRecordRemote,
  input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; writingStopped: boolean; blocker?: "required" | "none"; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord }> {
  const outcome = await advance(remote, {
    event: "stop_proven", actor: input.actor, commandId: input.commandId, roster: input.roster, now: input.now,
    payload: { writingStopped: input.writingStopped, blocker: input.blocker ?? "none" },
  });
  return { record: outcome.record };
}

/**
 * Reacquisition succeeds only through a validated shared update proving no other
 * executor can still start or run. Where that proof cannot be produced, the
 * attempt fails with the current state and the requester stays held. There is no
 * force-takeover here, and a claimed item cannot be reacquired at all.
 */
export async function reacquireOwnership(
  remote: ControlRecordRemote,
  input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; proof: { noOtherExecutor: boolean }; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord }> {
  const outcome = await advance(remote, {
    event: "reacquire", actor: input.actor, commandId: input.commandId, roster: input.roster, now: input.now,
    payload: { noOtherExecutor: input.proof.noOtherExecutor },
  });
  return { record: outcome.record };
}

/**
 * handover-rules.md 4.4 in its corrected form, settled 2026-09-21: a requester
 * whose own task completes locally while the item is claimed records a **cancel
 * request**. The receiver's own workstation stops its run and acknowledges, the
 * item is not closed until it has, and the branch is kept until the requester
 * deletes it. There is no path by which the requester stops the receiver's run.
 */
export async function recordLocalCompletionCancelRequest(
  remote: ControlRecordRemote,
  input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord; cancelRequested: boolean; itemClosed: boolean; branchKept: boolean }> {
  const outcome = await advance(remote, {
    event: "stop_request", actor: input.actor, commandId: input.commandId, roster: input.roster, now: input.now,
    payload: { reason: `${input.actor.personId} completed this task locally; cancellation is requested of the current executor.` },
  });
  return { record: outcome.record, cancelRequested: true, itemClosed: false, branchKept: true };
}

/** States in which the current executor has stopped and acknowledged, so nothing is still writing. */
const ACKNOWLEDGED: readonly ControlRecord["state"][] = ["LOCAL", "PREPARING", "OFFERED", "WAITING_INPUT", "PAUSED", "RETURNED", "COMPLETED", "CANCELLED", "WITHDRAWN"];

/**
 * Closing the item thread after a handover. The item is **not closed until the
 * receiver's own workstation has stopped and acknowledged**, so a close before
 * that is refused rather than closing over a live run.
 */
export function closeAfterHandover(record: ControlRecord, input: { itemId: string; commandId: string }): { closed: boolean; reason: string } {
  if (!ACKNOWLEDGED.includes(record.state)) {
    return { closed: false, reason: `The current executor has not acknowledged yet; the item is ${record.state}.` };
  }
  workspaces.revokeItemGrants({ itemId: input.itemId, commandId: input.commandId });
  const closed = workspaces.closeItemLink({ itemId: input.itemId, commandId: input.commandId });
  return { closed, reason: closed ? "Thread closed; grants ended." : "This item thread was already closed." };
}

/* ------------------------- roster and Team changes ------------------------ */

/**
 * A teammate removed from the roster while an offer is open: their group actor
 * is disabled and their grants revoked, which ends their outstanding buttons, so
 * their card goes inert. The record is untouched and the offer stays open for a
 * remaining member.
 */
export function retireHandoverCardsFor(input: { itemId: string; personId: string; actorIds: string[] }): { actorsDisabled: number; grantsRevoked: number } {
  let actorsDisabled = 0;
  for (const id of input.actorIds) if (workspaces.disableTaskControlActor(id)) actorsDisabled += 1;
  const grantsRevoked = workspaces.revokeItemGrants({
    itemId: input.itemId,
    personId: input.personId,
    commandId: `roster-removed-${input.personId}`,
  });
  return { actorsDisabled, grantsRevoked };
}

/**
 * The capability gate. Handover needs Team **and** its own setting, both false
 * by default, and either being off answers 403 while leaving the record and
 * personal control untouched.
 */
export function assertHandoverEnabled(config?: { teamEnabled: boolean; handoverEnabled: boolean }): void {
  const teamEnabled = config?.teamEnabled ?? settings.team.enabled;
  const handoverEnabled = config?.handoverEnabled ?? settings.team.handoverEnabled;
  if (!teamEnabled) throw new WorkspaceError(403, "team_disabled", "Team features are disabled.");
  if (!handoverEnabled) {
    throw new WorkspaceError(403, "handover_disabled", "Handover is not enabled on this workstation.");
  }
}

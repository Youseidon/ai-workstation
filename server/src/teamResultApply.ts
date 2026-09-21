import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskControlAction } from "@agent-console/shared";
import { config } from "./config.ts";
import { harnessSeams } from "./harnessSeams.ts";
import { renderHandoverReviewCard } from "./taskControlRenderer.ts";
import {
  applyControlTransition,
  handoverBranch,
  type ControlRecord,
  type ControlRecordRemote,
  type ControlTransitionPayload,
} from "./teamControlRecord.ts";
import { workspaceTrees } from "./teamHandoverCapture.ts";
import { assertHandoverEnabled } from "./teamHandoverRun.ts";
import { itemSubject, WorkspaceError, workspaces } from "./workspaces.ts";

/**
 * Return and apply (H05, TM-T1-H3), the requester's half of handover.
 *
 * H04 pushed the result commits on the same branch and moved the record to
 * `RETURNED`. This module is what the requester's workstation then does:
 * reconstruct the Result record, review it, and apply it by **ordinary merge**
 * in the requester's own checkout.
 *
 * Four rules shape every function here, and each is a rule rather than a
 * preference (protocol.md section 10).
 *
 * - **The baseline is the whole workspace, not HEAD.** Capture recorded the
 *   developer's HEAD, their index written as a tree and their tracked and
 *   untracked non-ignored content written as a tree. Apply compares all three.
 *   Checking only HEAD misses uncommitted divergence, and an ordinary merge
 *   over uncommitted divergence is how unrelated work gets overwritten.
 * - **Apply is offered only when the merge is clean.** The check runs in an
 *   isolated integration checkout, so a conflict is discovered without the
 *   original being touched. A conflict stops in Git's own conflict state and
 *   says so; nothing here resolves one, and no strategy flag is ever passed.
 * - **Application is not one transaction.** Files and SQLite cannot commit
 *   together, so an APPLY_INTENT with the pre-apply and target manifests is
 *   persisted first and a recoverable pre-apply snapshot is retained, the files
 *   move next, and acceptance, pipeline state and the shared record are updated
 *   once afterwards. A restart reads the intent and compares the tree with both
 *   manifests rather than merging again.
 * - **Nothing is pushed and no protected branch is merged automatically.** The
 *   only writes are a fetch into `refs/aw/*`, the merge in the requester's own
 *   checkout and the local pre-apply ref.
 */

/* ------------------------------- git plumbing ------------------------------ */

interface GitResult { status: number; stdout: string; stderr: string }

function run(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(cwd: string, args: string[]): string {
  const result = run(cwd, args);
  if (result.status !== 0) {
    throw new WorkspaceError(502, "apply_git_failed", (result.stderr || result.stdout || "A Git operation failed.").trim());
  }
  return result.stdout;
}

const lines = (value: string) => value.split("\n").map(one => one.trim()).filter(one => one !== "");

/**
 * Branches this product never merges into or pushes automatically. A handover
 * result is merged in the requester's own working branch; a protected product
 * branch is the operator's to move.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master", "trunk", "release", "develop", "production"];

function isProtected(branch: string, extra: readonly string[] = []): boolean {
  const all = [...PROTECTED_BRANCHES, ...extra].map(one => one.toLowerCase());
  const name = branch.toLowerCase();
  return all.includes(name) || all.some(one => name.startsWith(`${one}/`));
}

/* -------------------------------- baseline -------------------------------- */

/** The complete working-tree and staged baseline recorded at export. */
export interface HandoverBaseline {
  head: string;
  staged: string[];
  worktree: string[];
  indexTree: string;
  worktreeTree: string;
}

/** What a workspace looks like at one moment, in the same three hashes. */
export interface TreeManifest {
  head: string;
  indexTree: string;
  worktreeTree: string;
}

export interface BaselineComparison {
  matches: boolean;
  expected: TreeManifest;
  observed: TreeManifest;
  /** HEAD moved: the requester committed while the item was claimed. */
  committedDivergence: boolean;
  /** The index or the working tree moved, which checking HEAD alone would miss. */
  uncommittedDivergence: boolean;
  /** Git's own name-status list across the diverged trees. */
  divergedPaths: string[];
  reason: string;
}

/** Observes the three hashes without disturbing HEAD, the index or the worktree. */
export function observeWorkspace(root: string): TreeManifest {
  const trees = workspaceTrees(root);
  return { head: git(root, ["rev-parse", "HEAD"]).trim(), indexTree: trees.indexTree, worktreeTree: trees.worktreeTree };
}

/**
 * Compares the current original workspace against the **complete** baseline.
 *
 * This is the single load-bearing comparison of the task. `head` alone would
 * pass a workspace whose index and working tree have moved since export, and
 * merging the result over that is exactly how unrelated changes are lost.
 */
export function compareWorkspaceBaseline(root: string, baseline: HandoverBaseline): BaselineComparison {
  const observed = observeWorkspace(root);
  const expected: TreeManifest = { head: baseline.head, indexTree: baseline.indexTree, worktreeTree: baseline.worktreeTree };
  const committedDivergence = observed.head !== expected.head;
  const uncommittedDivergence = observed.indexTree !== expected.indexTree || observed.worktreeTree !== expected.worktreeTree;
  const divergedPaths = uncommittedDivergence
    ? [...new Set([
      ...lines(git(root, ["diff", "--name-only", expected.indexTree, observed.indexTree])),
      ...lines(git(root, ["diff", "--name-only", expected.worktreeTree, observed.worktreeTree])),
    ])].sort()
    : [];
  const matches = !committedDivergence && !uncommittedDivergence;
  const parts: string[] = [];
  if (committedDivergence) parts.push(`HEAD moved from ${expected.head} to ${observed.head}`);
  if (uncommittedDivergence) {
    parts.push(divergedPaths.length === 0
      ? "the index or working tree changed since export"
      : `uncommitted changes since export in ${divergedPaths.join(", ")}`);
  }
  return {
    matches,
    expected,
    observed,
    committedDivergence,
    uncommittedDivergence,
    divergedPaths,
    reason: matches
      ? "This workspace is exactly as it was when the handover was captured."
      : `This workspace moved on while the item was handed over: ${parts.join("; ")}.`,
  };
}

/* ------------------------------ result record ------------------------------ */

/** protocol.md section 3's Result record, rebuilt from the `return_work` event. */
export interface ReturnedResult {
  resultId: string;
  itemId: string;
  epoch: number;
  branch: string;
  resultCommit: string;
  label: "full" | "partial";
  verification: string[];
  uncertainEffects: string[];
  releaseEvidence: string;
  executor: string;
  returnedAt: string;
}

function resultFrom(record: ControlRecord, payload: ControlTransitionPayload): ReturnedResult | null {
  const result = payload.result;
  if (result === undefined) return null;
  if (result.label !== "full" && result.label !== "partial") return null;
  if (typeof result.resultCommit !== "string" || result.resultCommit.trim() === "") return null;
  return {
    resultId: result.resultId,
    itemId: record.itemId,
    epoch: result.epoch,
    branch: record.branch,
    resultCommit: result.resultCommit,
    label: result.label,
    verification: result.verification ?? [],
    uncertainEffects: result.uncertainEffects ?? [],
    releaseEvidence: result.releaseEvidence ?? "",
    executor: result.executor,
    returnedAt: result.returnedAt,
  };
}

/**
 * Reads the returned result out of the shared record. The requester's
 * workstation does this on its own poll, so the completion report is readable
 * the moment it lands even if this workstation was stopped when it did (D01).
 *
 * `return_work` records the Result and `apply_result` and
 * `application_reconciled` quote it forward, so the same result is readable at
 * `RETURNED`, at `APPLYING` and after the application without walking history.
 */
export async function readReturnedResult(remote: ControlRecordRemote, itemId?: string): Promise<ReturnedResult | null> {
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  if (itemId !== undefined && current.record.itemId !== itemId) return null;
  return readReturnedResultFrom(remote, current.record);
}

async function readReturnedResultFrom(remote: ControlRecordRemote, record: ControlRecord): Promise<ReturnedResult | null> {
  if (record.lastCommandId === null) return null;
  const event = await remote.readEvent(record.lastCommandId);
  if (event === null) return null;
  return resultFrom(record, event.payload);
}

function resultPayload(result: ReturnedResult): NonNullable<ControlTransitionPayload["result"]> {
  return {
    resultId: result.resultId,
    epoch: result.epoch,
    resultCommit: result.resultCommit,
    label: result.label,
    verification: result.verification,
    uncertainEffects: result.uncertainEffects,
    releaseEvidence: result.releaseEvidence,
    executor: result.executor,
    returnedAt: result.returnedAt,
  };
}

/* ------------------------------- apply intent ------------------------------ */

/** The target an application is aiming at, recorded before the files move. */
export interface TargetManifest {
  /** The merged tree. It is the same object whether the merge fast-forwards or not. */
  tree: string;
  /** The commit HEAD becomes when the merge fast-forwards, else null. */
  fastForwardTo: string | null;
}

export interface ApplyReceipt {
  resultId: string;
  itemId: string;
  epoch: number;
  resultCommit: string;
  label: "full" | "partial";
  commandId: string;
  head: string;
  fastForward: boolean;
  target: TargetManifest;
  observedTarget: TreeManifest;
  taskCompleted: boolean;
  pipelineHoldReleased: boolean;
  appliedAt: string;
}

/** APPLY_INTENT: what a restart needs to tell a finished apply from a torn one. */
export interface ApplyIntent {
  version: 1;
  itemId: string;
  resultId: string;
  resultCommit: string;
  commandId: string;
  label: "full" | "partial";
  acceptanceMet: boolean;
  /** The expected pre-apply manifest. */
  pre: TreeManifest;
  /** The recoverable pre-apply snapshot: a commit, kept alive by a local ref. */
  preSnapshot: string;
  preRef: string;
  target: TargetManifest;
  /** APPLY_FILES_DONE: the files are at the target, bookkeeping may not be. */
  filesDone: boolean;
  /** RESULT_APPLIED: the whole sequence finished, and this is the first receipt. */
  receipt: ApplyReceipt | null;
  createdAt: string;
}

function intentDirectory(): string {
  return join(config.repoRoot, ".agent-console", "handover-apply");
}

function intentPath(itemId: string): string {
  return join(intentDirectory(), `${itemId}.json`);
}

export function readApplyIntent(itemId: string): ApplyIntent | null {
  const path = intentPath(itemId);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ApplyIntent;
    return value.version === 1 && value.itemId === itemId ? value : null;
  } catch {
    return null;
  }
}

/** Written whole, through a temporary file, so a crash never leaves half an intent. */
function writeApplyIntent(intent: ApplyIntent): void {
  const path = intentPath(intent.itemId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/* ------------------------------- the requester ----------------------------- */

/** The gate H04 built, passed explicitly where a caller has its own settings. */
export type HandoverCapability = { teamEnabled: boolean; handoverEnabled: boolean };

export interface RequesterEnvironment {
  personId: string;
  workstationId: string;
  /** The requester's own bot: the review card is posted from here. */
  botId: string;
  chatId: string;
  topicId?: string | null;
  actorId: string;
  roster?: string[];
  /** The original workspace, which is the checkout the result is merged into. */
  workDirectory: string;
  /** An explicit URL for the shared repository; no remote configuration is changed. */
  remoteUrl: string;
  /** Extra branch names this workstation also refuses to merge into automatically. */
  protectedBranches?: string[];
}

/** Resolves the requester's item, refusing a closed one: a closed item accepts no action (F02). */
function requesterItem(itemId: string) {
  const link = workspaces.itemLink(itemId);
  if (link === null) throw new WorkspaceError(404, "item_not_found", "This Team item is no longer available.");
  if (link.closedAt !== null) {
    throw new WorkspaceError(409, "item_closed",
      "This item thread is closed, and a closed item accepts no action. Reopening it is a new item.", { itemId });
  }
  return link;
}

/* ------------------------------- merge probe ------------------------------- */

export interface MergeProbe {
  clean: boolean;
  fastForward: boolean;
  /** Git's own unmerged path list, empty when the merge is clean. */
  conflictPaths: string[];
  /** The merged tree, present only when the merge is clean. */
  tree: string | null;
  /** Kept in its conflicted state for explicit review; removed when clean. */
  integrationCheckout: string | null;
  reason: string;
}

/**
 * Validates the delta through an **isolated integration checkout**: a detached
 * worktree of the requester's own repository, at the requester's current HEAD,
 * where the merge is attempted without the original being touched.
 *
 * No merge strategy option is passed and no conflict is resolved here. A
 * conflict is left exactly as Git left it, in the integration checkout, and
 * reported.
 */
export function probeResultMerge(input: { root: string; resultCommit: string; integrationRoot?: string }): MergeProbe {
  const root = input.root;
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const fastForward = run(root, ["merge-base", "--is-ancestor", head, input.resultCommit]).status === 0;
  if (fastForward) {
    return {
      clean: true,
      fastForward: true,
      conflictPaths: [],
      tree: git(root, ["rev-parse", `${input.resultCommit}^{tree}`]).trim(),
      integrationCheckout: null,
      reason: "The result fast-forwards this checkout.",
    };
  }
  const base = input.integrationRoot ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const checkout = mkdtempSync(join(base, "aw-apply-integration-"));
  rmSync(checkout, { recursive: true, force: true });
  git(root, ["worktree", "add", "--detach", "--quiet", checkout, head]);
  const merged = run(checkout, ["merge", "--no-commit", "--no-ff", input.resultCommit]);
  if (merged.status === 0) {
    const tree = git(checkout, ["write-tree"]).trim();
    discardIntegration(root, checkout);
    return { clean: true, fastForward: false, conflictPaths: [], tree, integrationCheckout: null, reason: "The result merges cleanly into this checkout." };
  }
  const conflictPaths = [...new Set(lines(git(checkout, ["diff", "--name-only", "--diff-filter=U"])))].sort();
  return {
    clean: false,
    fastForward: false,
    conflictPaths,
    tree: null,
    integrationCheckout: checkout,
    reason: conflictPaths.length === 0
      ? `Git could not merge the result: ${(merged.stderr || merged.stdout).trim()}`
      : `Git stopped with a conflict in ${conflictPaths.join(", ")}. The conflict is left exactly as Git left it, in ${checkout}, for review; nothing is resolved automatically.`,
  };
}

function discardIntegration(root: string, checkout: string): void {
  rmSync(checkout, { recursive: true, force: true });
  run(root, ["worktree", "prune"]);
}

/** Removes an integration checkout kept for review once the requester is done with it. */
export function discardIntegrationCheckout(root: string, checkout: string): void {
  discardIntegration(root, checkout);
}

/** Fetches the result branch into `refs/aw/*`, which changes no branch and no remote configuration. */
export function fetchResult(env: RequesterEnvironment, itemId: string): string {
  const branch = handoverBranch(itemId);
  git(env.workDirectory, [
    "fetch", "--no-tags", "--quiet", env.remoteUrl, `+refs/heads/${branch}:refs/aw/handover/${itemId}`,
  ]);
  return git(env.workDirectory, ["rev-parse", `refs/aw/handover/${itemId}`]).trim();
}

/* --------------------------------- review ---------------------------------- */

export interface ReviewCard {
  outboxId: number;
  botId: string;
  actions: Array<{ ref: string; action: TaskControlAction }>;
  /** Review is not one of the seven actions; it is this card's own evidence. */
  offered: Array<"review" | "request_changes" | "apply_result">;
}

/**
 * Why Apply is withheld. Each is an independent gate and all of them are
 * reported, because a checkout that moved on both ways is two separate facts
 * and the requester needs each of them.
 */
export type ReviewRefusal = "protected_branch" | "baseline_diverged" | "merge_conflict";

export interface ReviewOutcome {
  result: ReturnedResult;
  baseline: BaselineComparison;
  merge: MergeProbe;
  /** Empty exactly when Apply is offered. */
  refusedBecause: ReviewRefusal[];
  applyOffered: boolean;
  /** A DONE statement with no evidence is not automatic acceptance. */
  evidenceMissing: boolean;
  reason: string;
  card: ReviewCard;
}

const actionRef = () => `tc_${randomBytes(18).toString("base64url")}`;

const ttl = (options: { ttlMs?: number }) => options.ttlMs ?? harnessSeams.actionTtlMs ?? 10 * 60 * 1000;

/**
 * Step 7 of teammate-design.md section 5.4: the record is `RETURNED` and the
 * requester is offered Review, Request changes and Apply.
 *
 * **Apply is offered only when the merge is clean**, and clean means two
 * independent things: the original workspace still matches the complete
 * baseline recorded at export, and Git can complete the merge in the isolated
 * integration checkout. A diverged checkout therefore shows as a conflict
 * rather than as a silent overwrite (Q9).
 */
export async function reviewReturnedResult(
  remote: ControlRecordRemote,
  input: {
    env: RequesterEnvironment;
    itemId: string;
    baseline: HandoverBaseline;
    now?: Date;
    ttlMs?: number;
    integrationRoot?: string;
    capability?: HandoverCapability;
  },
): Promise<ReviewOutcome> {
  assertHandoverEnabled(input.capability);
  const link = requesterItem(input.itemId);
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  if (current.record.state !== "RETURNED") {
    throw new WorkspaceError(409, "control_state_invalid",
      `There is nothing to review: ${input.itemId} is ${current.record.state}.`,
      { state: current.record.state, epoch: String(current.record.epoch), itemId: input.itemId });
  }
  if (current.record.requester !== input.env.personId) {
    throw new WorkspaceError(403, "control_actor_unauthorized", "Only the requester reviews a returned result.");
  }
  const result = await readReturnedResultFrom(remote, current.record);
  if (result === null) throw new WorkspaceError(502, "result_incomplete", "The returned result is incomplete.");

  const resultCommit = fetchResult(input.env, input.itemId);
  const baseline = compareWorkspaceBaseline(input.env.workDirectory, input.baseline);
  const merge = probeResultMerge({ root: input.env.workDirectory, resultCommit, integrationRoot: input.integrationRoot });
  const branch = git(input.env.workDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const branchProtected = isProtected(branch, input.env.protectedBranches);
  const evidenceMissing = result.label === "full" && result.verification.length === 0;

  // Apply is offered exactly when no gate refuses, and every gate that refuses
  // is named. `applyOffered` is derived from this list rather than computed
  // beside it, so a gate cannot be dropped from one and left in the other.
  const refusedBecause: ReviewRefusal[] = [
    ...(branchProtected ? ["protected_branch" as const] : []),
    ...(baseline.matches ? [] : ["baseline_diverged" as const]),
    ...(merge.clean ? [] : ["merge_conflict" as const]),
  ];
  const applyOffered = refusedBecause.length === 0;
  const said: Record<ReviewRefusal, string> = {
    protected_branch: `${branch} is a protected product branch, and this product never merges or pushes one automatically. Move to your own branch and review again.`,
    baseline_diverged: baseline.reason,
    merge_conflict: merge.reason,
  };
  const reason = applyOffered
    ? evidenceMissing
      ? "This result is labelled full but carries no verification evidence. A DONE statement without evidence is not acceptance; review it before applying."
      : "The result merges cleanly into this checkout."
    : refusedBecause.map(one => said[one]).join(" ");

  const expiresAt = new Date((input.now ?? new Date()).getTime() + ttl(input)).toISOString();
  const revision = workspaces.humanInputState(link.promptId).revision;
  const wanted: TaskControlAction[] = applyOffered ? ["apply_result", "request_changes"] : ["request_changes"];
  const actions = wanted.map(action => ({ ref: actionRef(), action }));
  const payload = { kind: "handover_review", itemId: input.itemId, epoch: current.record.epoch, resultId: result.resultId, packageHash: "" };
  for (const action of actions) {
    workspaces.createTaskControlAction({
      ref: action.ref,
      action: action.action,
      promptId: link.promptId,
      actorId: input.env.actorId,
      chatId: input.env.chatId,
      topicId: input.env.topicId ?? null,
      botId: input.env.botId,
      messageId: `handover-review-${input.itemId}`,
      expectedRevision: revision,
      expiresAt,
      subjectKind: "task",
      payload,
    });
  }
  const outboxId = workspaces.enqueueTelegramOutbox({
    botId: input.env.botId,
    chatId: input.env.chatId,
    topicId: input.env.topicId ?? null,
    payload: renderHandoverReviewCard({
      itemId: input.itemId,
      branch: current.record.branch,
      epoch: current.record.epoch,
      resultId: result.resultId,
      resultCommit: result.resultCommit,
      label: result.label,
      verification: result.verification,
      uncertainEffects: result.uncertainEffects,
      evidenceMissing,
      applyOffered,
      divergedPaths: baseline.divergedPaths,
      conflictPaths: merge.conflictPaths,
      promptId: link.promptId,
      actions,
      reason,
    }),
    subject: itemSubject(input.itemId),
  });
  return {
    result,
    baseline,
    merge,
    refusedBecause,
    applyOffered,
    evidenceMissing,
    reason,
    card: {
      outboxId,
      botId: input.env.botId,
      actions,
      offered: applyOffered ? ["review", "request_changes", "apply_result"] : ["review", "request_changes"],
    },
  };
}

/* ---------------------------------- apply ---------------------------------- */

export type ApplyOutcome =
  | { kind: "applied"; receipt: ApplyReceipt; record: ControlRecord; merged: true; taskCompleted: boolean; label: "full" | "partial"; pipelineHoldReleased: true }
  | { kind: "already_applied"; receipt: ApplyReceipt; record: ControlRecord; merged: false }
  | { kind: "blocked"; record: ControlRecord; merged: false; baseline: BaselineComparison; merge: MergeProbe; reason: string };

export interface ApplyInput {
  env: RequesterEnvironment;
  capability?: HandoverCapability;
  itemId: string;
  baseline: HandoverBaseline;
  commandId: string;
  /** The requester's own decision. It is never derived from the result's label. */
  acceptance: { met: boolean };
  now?: Date;
  integrationRoot?: string;
  /**
   * Seams for the two moments the sequence can be interrupted: just before the
   * original is touched, and after the files have moved but before the
   * bookkeeping is recorded.
   */
  hooks?: { beforeMerge?: () => void; afterFilesDone?: () => void };
}

/**
 * Apply by ordinary merge, in the four steps of protocol.md section 10.
 *
 * 1. Claim `APPLYING` in shared history, persist APPLY_INTENT with the result
 *    id, the expected pre-apply manifest and the target manifest, and retain a
 *    recoverable pre-apply snapshot.
 * 2. Validate and apply the delta through an isolated integration checkout,
 *    rechecking the original's baseline before updating it and keeping it
 *    unchanged on conflict.
 * 3. Record the observed target hashes and APPLY_FILES_DONE, then update task
 *    acceptance and pipeline state once and publish RESULT_APPLIED with the
 *    same result id.
 * 4. Restart is handled by `recoverApplyIntent`, not by retrying here.
 */
export async function applyReturnedResult(remote: ControlRecordRemote, input: ApplyInput): Promise<ApplyOutcome> {
  assertHandoverEnabled(input.capability);
  const link = requesterItem(input.itemId);
  const env = input.env;
  const now = input.now ?? new Date();

  const opening = await remote.read();
  if (opening === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const result = await readReturnedResultFrom(remote, opening.record);
  if (result === null) throw new WorkspaceError(502, "result_incomplete", "The returned result is incomplete.");

  // B27, idempotence. The first receipt is returned and no second merge happens.
  // It is keyed on the result id rather than on the tap, so a second Apply from
  // a fresh card is still the same application.
  const existing = readApplyIntent(input.itemId);
  if (existing !== null && existing.receipt !== null && existing.resultId === result.resultId) {
    return { kind: "already_applied", receipt: existing.receipt, record: opening.record, merged: false };
  }

  const branch = git(env.workDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (isProtected(branch, env.protectedBranches)) {
    throw new WorkspaceError(409, "protected_branch",
      `${branch} is a protected product branch. This product never merges or pushes one automatically.`, { branch, itemId: input.itemId });
  }

  const resultCommit = fetchResult(env, input.itemId);
  if (resultCommit !== result.resultCommit) {
    throw new WorkspaceError(409, "result_moved",
      "The handover branch no longer carries the result that was returned; re-read the record before applying.",
      { expected: result.resultCommit, observed: resultCommit, itemId: input.itemId });
  }

  /* Step 1: claim APPLYING, persist the intent, retain the pre-apply snapshot. */
  let record = opening.record;
  let intent = existing !== null && existing.resultId === result.resultId ? existing : null;
  if (record.state === "RETURNED") {
    const claimed = await applyControlTransition(remote, {
      event: "apply_result",
      actor: { personId: env.personId, workstationId: env.workstationId },
      commandId: input.commandId,
      epoch: opening.record.epoch,
      roster: env.roster,
      now,
      fromHead: opening.head,
      // The baseline is validated here, before the original is touched.
      payload: {
        baselineValidated: true,
        resultId: result.resultId,
        resultCommit: result.resultCommit,
        // Quoted forward so the same Result is readable while APPLYING.
        result: resultPayload(result),
      },
    });
    record = claimed.record;
  } else if (record.state !== "APPLYING") {
    throw new WorkspaceError(409, "control_state_invalid",
      `${input.itemId} is ${record.state}, so there is nothing to apply.`,
      { state: record.state, epoch: String(record.epoch), itemId: input.itemId });
  }

  const pre = observeWorkspace(env.workDirectory);
  const probe = probeResultMerge({ root: env.workDirectory, resultCommit, integrationRoot: input.integrationRoot });
  const baseline = compareWorkspaceBaseline(env.workDirectory, input.baseline);

  /*
   * Step 2, the refusal half. The original is kept unchanged and the record does
   * not advance past APPLYING. A conflict keeps Git's own conflict state in the
   * integration checkout and says so; nothing is resolved automatically, and a
   * workspace that diverged from the complete baseline is refused even when Git
   * would have merged, because merging over it would overwrite unrelated work.
   */
  if (!baseline.matches || !probe.clean) {
    const reason = !probe.clean && !baseline.matches
      ? `${baseline.reason} ${probe.reason}`
      : !probe.clean ? probe.reason : baseline.reason;
    return { kind: "blocked", record, merged: false, baseline, merge: probe, reason };
  }

  const probedTree = probe.tree;
  if (probedTree === null) throw new WorkspaceError(502, "apply_target_unknown", "The merge produced no target tree.");
  const target: TargetManifest = { tree: probedTree, fastForwardTo: probe.fastForward ? resultCommit : null };
  if (intent === null || intent.target.tree !== target.tree) {
    const preRef = `refs/aw/apply/${input.itemId}/pre`;
    const preSnapshot = retainPreApplySnapshot(env.workDirectory, preRef, input.itemId, pre);
    intent = {
      version: 1,
      itemId: input.itemId,
      resultId: result.resultId,
      resultCommit: result.resultCommit,
      commandId: input.commandId,
      label: result.label,
      acceptanceMet: input.acceptance.met,
      pre,
      preSnapshot,
      preRef,
      target,
      filesDone: false,
      receipt: null,
      createdAt: now.toISOString(),
    };
    writeApplyIntent(intent);
  }

  /*
   * Step 2, the apply half. The baseline is rechecked **immediately** before the
   * original moves, not once at the start: claiming APPLYING, probing the merge
   * and retaining the snapshot all take time, and the developer whose workspace
   * this is may well save a file during it.
   */
  input.hooks?.beforeMerge?.();
  const recheck = compareWorkspaceBaseline(env.workDirectory, input.baseline);
  if (!recheck.matches) {
    return { kind: "blocked", record, merged: false, baseline: recheck, merge: probe, reason: recheck.reason };
  }
  /*
   * The merge is an ordinary one, so the working tree has to be clean for it,
   * and clearing it is licensed by the two steps above rather than assumed:
   * the complete baseline matched, which means every staged and working byte is
   * already inside the snapshot the result was built on, and the pre-apply
   * snapshot retained a moment ago holds the same bytes under `refs/aw/`. There
   * is therefore no unrelated index or working state here to preserve, which is
   * exactly what the baseline comparison is for. Ignored files are left alone.
   */
  git(env.workDirectory, ["reset", "--hard", "--quiet", "HEAD"]);
  git(env.workDirectory, ["clean", "-fdq"]);
  const merged = run(env.workDirectory, ["merge", "--no-edit", resultCommit]);
  if (merged.status !== 0) {
    // Git refused after all: leave the original exactly as Git left it and say so.
    const conflictPaths = [...new Set(lines(run(env.workDirectory, ["diff", "--name-only", "--diff-filter=U"]).stdout))].sort();
    return {
      kind: "blocked",
      record,
      merged: false,
      baseline: recheck,
      merge: { ...probe, clean: false, conflictPaths, reason: (merged.stderr || merged.stdout).trim() },
      reason: `Git stopped: ${(merged.stderr || merged.stdout).trim()}`,
    };
  }

  /* Step 3: observed target hashes and APPLY_FILES_DONE, then bookkeeping once. */
  const observedTarget = observeWorkspace(env.workDirectory);
  if (observedTarget.worktreeTree !== target.tree) {
    // The files are neither the pre-apply state nor the target. Recovery owns
    // this, not another merge, so the bookkeeping is not done and the pipeline
    // is not advanced.
    return {
      kind: "blocked",
      record,
      merged: false,
      baseline: recheck,
      merge: probe,
      reason: `The merge left a tree that is not the recorded target (${observedTarget.worktreeTree} rather than ${target.tree}). `
        + `The pre-apply snapshot is kept at ${intent.preRef}; recover and review before applying again.`,
    };
  }
  intent = { ...intent, filesDone: true };
  writeApplyIntent(intent);
  input.hooks?.afterFilesDone?.();

  return finishApplication(remote, {
    env, itemId: input.itemId, promptId: link.promptId, intent, record, result,
    observedTarget, fastForward: probe.fastForward, now,
  });
}

/**
 * The pre-apply snapshot, retained so the original is recoverable. It is a
 * single-parent commit of the whole pre-apply workspace written through a
 * temporary index, kept alive by a local ref under `refs/aw/`, which is neither
 * a branch nor anything this product ever pushes.
 */
function retainPreApplySnapshot(root: string, ref: string, itemId: string, pre: TreeManifest): string {
  const commit = git(root, [
    "-c", "user.name=agent-console", "-c", "user.email=agent-console@invalid",
    "commit-tree", pre.worktreeTree, "-p", pre.head, "-m", `Pre-apply snapshot for ${itemId}`,
  ]).trim();
  git(root, ["update-ref", ref, commit]);
  return commit;
}

/**
 * Step 3's second half: task acceptance and pipeline state are updated **once**,
 * and RESULT_APPLIED is published with the same result id. It is separate from
 * the merge so a restart can reach it without applying anything again.
 *
 * A Telegram edit that fails afterwards must not roll this back, which is why
 * every card edit is outside it.
 */
async function finishApplication(
  remote: ControlRecordRemote,
  input: {
    env: RequesterEnvironment; itemId: string; promptId: number; intent: ApplyIntent;
    record: ControlRecord; result: ReturnedResult; observedTarget: TreeManifest; fastForward: boolean; now: Date;
  },
): Promise<ApplyOutcome> {
  const { intent, result } = input;
  // Applying a partial result leaves the source owning a resumable PAUSED task
  // and can never label it complete, however the requester's decision reads.
  const acceptanceMet = result.label === "full" && intent.acceptanceMet;
  const evidence = [
    `Handover result ${result.resultCommit} applied from ${input.record.branch}, labelled ${result.label}.`,
    ...result.verification,
    ...result.uncertainEffects.map(one => `Uncertain external effect: ${one}`),
  ].join("\n");
  const task = workspaces.applyHandoverResultToTask({
    promptId: input.promptId,
    label: result.label,
    acceptanceMet,
    evidence,
    resultCommit: result.resultCommit,
  });

  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const reconciled = await applyControlTransition(remote, {
    event: "application_reconciled",
    actor: { personId: input.env.personId, workstationId: input.env.workstationId },
    commandId: `${intent.commandId}-reconciled`,
    epoch: current.record.epoch,
    roster: input.env.roster,
    now: input.now,
    fromHead: current.head,
    payload: {
      acceptanceMet,
      // RESULT_APPLIED carries the same result id the intent and the receipt do.
      resultId: result.resultId,
      resultCommit: result.resultCommit,
      result: resultPayload(result),
      targetTree: intent.target.tree,
    },
  });

  const receipt: ApplyReceipt = {
    resultId: result.resultId,
    itemId: input.itemId,
    epoch: reconciled.record.epoch,
    resultCommit: result.resultCommit,
    label: result.label,
    commandId: intent.commandId,
    head: input.observedTarget.head,
    fastForward: input.fastForward,
    target: intent.target,
    observedTarget: input.observedTarget,
    taskCompleted: task.completed,
    pipelineHoldReleased: true,
    appliedAt: input.now.toISOString(),
  };
  writeApplyIntent({ ...intent, filesDone: true, receipt });
  return {
    kind: "applied",
    receipt,
    record: reconciled.record,
    merged: true,
    taskCompleted: task.completed,
    label: result.label,
    pipelineHoldReleased: true,
  };
}

/* -------------------------------- recovery --------------------------------- */

export type RecoveryOutcome =
  | { kind: "none" }
  | { kind: "already_applied"; receipt: ApplyReceipt }
  | { kind: "finished_bookkeeping"; receipt: ApplyReceipt; record: ControlRecord; merged: false }
  | { kind: "pre_intact"; intent: ApplyIntent; reason: string }
  | { kind: "recovery_required"; intent: ApplyIntent; observed: TreeManifest; reason: string };

/**
 * Step 4: on restart, compare the tree with the pre and target manifests.
 *
 * If the target is present the files are already there, so the bookkeeping is
 * finished **without applying again**. A tree that is neither the pre-apply
 * state nor the target is partial or unknown, and that requires recovery: it
 * does not retry the destructive application and it does not advance the
 * pipeline.
 */
export async function recoverApplyIntent(
  remote: ControlRecordRemote,
  input: { env: RequesterEnvironment; itemId: string; now?: Date },
): Promise<RecoveryOutcome> {
  const intent = readApplyIntent(input.itemId);
  if (intent === null) return { kind: "none" };
  if (intent.receipt !== null) return { kind: "already_applied", receipt: intent.receipt };

  const observed = observeWorkspace(input.env.workDirectory);
  if (observed.worktreeTree === intent.target.tree) {
    const current = await remote.read();
    if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
    const result = await readReturnedResultFrom(remote, current.record);
    if (result === null) throw new WorkspaceError(502, "result_incomplete", "The returned result is incomplete.");
    const link = requesterItem(input.itemId);
    const finished = await finishApplication(remote, {
      env: input.env, itemId: input.itemId, promptId: link.promptId, intent,
      record: current.record, result, observedTarget: observed,
      fastForward: intent.target.fastForwardTo !== null, now: input.now ?? new Date(),
    });
    if (finished.kind !== "applied") throw new WorkspaceError(500, "apply_recovery_failed", "The application could not be finished.");
    return { kind: "finished_bookkeeping", receipt: finished.receipt, record: finished.record, merged: false };
  }
  if (observed.head === intent.pre.head && observed.indexTree === intent.pre.indexTree && observed.worktreeTree === intent.pre.worktreeTree) {
    return {
      kind: "pre_intact",
      intent,
      reason: "Nothing was applied before the restart: this workspace is still exactly the pre-apply snapshot, so applying again is safe.",
    };
  }
  return {
    kind: "recovery_required",
    intent,
    observed,
    reason: `This workspace is neither the pre-apply state nor the applied result, so the application is partial or unknown. `
      + `The pre-apply snapshot is kept at ${intent.preRef} (${intent.preSnapshot}); recover from it and review before applying again. `
      + `Nothing was retried and the pipeline was not advanced.`,
  };
}

/* ------------------------------ request changes ---------------------------- */

export interface RequestChangesOutcome {
  record: ControlRecord;
  epoch: number;
  /** The open call names nobody, including whoever returned the work. */
  receiver: null;
}

/**
 * Step 8 of teammate-design.md section 5.4: Request changes opens a **new epoch**
 * and a fresh **open-call** offer. Every command bound to the previous epoch is
 * refused from then on, and the new offer is discoverable by any available
 * teammate, including one who declined the previous round.
 */
export async function requestHandoverChanges(
  remote: ControlRecordRemote,
  input: {
    env: RequesterEnvironment;
    itemId: string;
    commandId: string;
    requirementsRevision: string;
    /** The package the new round is offered from, verified before it is offered. */
    packageHash: string;
    snapshotCommit: string;
    provider: string;
    model?: string | null;
    requested?: { hostAccess?: boolean; sandbox?: string; tools?: string[] };
    verifyBranch: () => Promise<boolean>;
    now?: Date;
    capability?: HandoverCapability;
  },
): Promise<RequestChangesOutcome> {
  assertHandoverEnabled(input.capability);
  requesterItem(input.itemId);
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  if (!await input.verifyBranch()) {
    throw new WorkspaceError(502, "package_not_retrievable",
      "The handover branch is not retrievable from the remote, so no new offer was published.");
  }
  const now = input.now ?? new Date();
  const outcome = await applyControlTransition(remote, {
    event: "request_changes",
    actor: { personId: input.env.personId, workstationId: input.env.workstationId },
    commandId: input.commandId,
    epoch: current.record.epoch,
    roster: input.env.roster,
    now,
    fromHead: current.head,
    payload: {
      requirementsRevision: input.requirementsRevision,
      packageVerified: true,
      branchVerified: true,
      requestedProvider: input.provider,
      requestedModel: input.model ?? null,
      packageHash: input.packageHash,
      snapshotCommit: input.snapshotCommit,
      ...(input.requested?.hostAccess === undefined ? {} : { requestedHostAccess: input.requested.hostAccess }),
      ...(input.requested?.sandbox === undefined ? {} : { requestedSandbox: input.requested.sandbox }),
      ...(input.requested?.tools === undefined ? {} : { requestedTools: input.requested.tools }),
    },
  });
  return { record: outcome.record, epoch: outcome.record.epoch, receiver: null };
}

/* ------------------------------ the pipeline hold -------------------------- */

/**
 * The requester's own pipeline hold, taken at capture and released by the
 * application (D12). `RETURNED` releases the executor, not the hold, which is
 * why a return alone leaves this held.
 */
export function handoverPipelineHold(itemId: string, record: ControlRecord): { held: boolean; reason: string } {
  const intent = readApplyIntent(itemId);
  if (intent !== null && intent.receipt !== null) {
    return { held: false, reason: `The result was applied on ${intent.receipt.appliedAt}; the hold is released.` };
  }
  if (record.state === "LOCAL" || record.state === "CANCELLED") {
    return { held: false, reason: `This item is ${record.state}; there is no handover hold.` };
  }
  return { held: true, reason: `This item is ${record.state}; the pipeline stays held until the result is applied or the handover ends.` };
}

/* --------------------------------- retention ------------------------------- */

/**
 * G04 retention: the control record and its events are kept as the audit trail,
 * and the requester deletes the `aw/handover/<item>` branch once the item is
 * applied or cancelled. The record stays readable afterwards.
 */
export async function deleteHandoverBranch(
  remote: ControlRecordRemote,
  input: { env: RequesterEnvironment; itemId: string },
): Promise<{ deleted: boolean; recordKept: true; reason: string }> {
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const applied = readApplyIntent(input.itemId)?.receipt ?? null;
  const done = applied !== null || current.record.state === "CANCELLED" || current.record.state === "COMPLETED";
  if (!done) {
    return {
      deleted: false,
      recordKept: true,
      reason: `${input.itemId} is ${current.record.state}: the branch is kept until the item is applied or cancelled.`,
    };
  }
  const branch = handoverBranch(input.itemId);
  const deleted = run(input.env.workDirectory, ["push", "--delete", input.env.remoteUrl, `refs/heads/${branch}`]).status === 0;
  return {
    deleted,
    recordKept: true,
    reason: deleted
      ? `${branch} is deleted; the control record and its events are kept as the audit trail.`
      : `${branch} was already gone; the control record and its events are kept as the audit trail.`,
  };
}

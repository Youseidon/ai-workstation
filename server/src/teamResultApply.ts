import type { TaskControlAction } from "@agent-console/shared";
import type { ControlRecord, ControlRecordRemote } from "./teamControlRecord.ts";
import { WorkspaceError } from "./workspaces.ts";

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

/**
 * Branches this product never merges into or pushes automatically. A handover
 * result is merged in the requester's own working branch; a protected product
 * branch is the operator's to move.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master", "trunk", "release", "develop", "production"];

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

/**
 * Compares the current original workspace against the **complete** baseline.
 *
 * This is the single load-bearing comparison of the task. `head` alone would
 * pass a workspace whose index and working tree have moved since export, and
 * merging the result over that is exactly how unrelated changes are lost.
 */
export function compareWorkspaceBaseline(root: string, baseline: HandoverBaseline): BaselineComparison {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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


export function readApplyIntent(itemId: string): ApplyIntent | null {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

/** Removes an integration checkout kept for review once the requester is done with it. */
export function discardIntegrationCheckout(root: string, checkout: string): void {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

/** Fetches the result branch into `refs/aw/*`, which changes no branch and no remote configuration. */
export function fetchResult(env: RequesterEnvironment, itemId: string): string {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

export interface ReviewCard {
  outboxId: number;
  botId: string;
  actions: Array<{ ref: string; action: TaskControlAction }>;
  /** Review is not one of the seven actions; it is this card's own evidence. */
  offered: Array<"review" | "request_changes" | "apply_result">;
}

export interface ReviewOutcome {
  result: ReturnedResult;
  baseline: BaselineComparison;
  merge: MergeProbe;
  applyOffered: boolean;
  /** A DONE statement with no evidence is not automatic acceptance. */
  evidenceMissing: boolean;
  reason: string;
  card: ReviewCard;
}

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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
  /** A seam for the restart case: runs after the files move and before bookkeeping. */
  hooks?: { afterFilesDone?: () => void };
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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

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
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

/**
 * The requester's own pipeline hold, taken at capture and released by the
 * application (D12). `RETURNED` releases the executor, not the hold, which is
 * why a return alone leaves this held.
 */
export function handoverPipelineHold(itemId: string, record: ControlRecord): { held: boolean; reason: string } {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

/**
 * G04 retention: the control record and its events are kept as the audit trail,
 * and the requester deletes the `aw/handover/<item>` branch once the item is
 * applied or cancelled. The record stays readable afterwards.
 */
export async function deleteHandoverBranch(
  remote: ControlRecordRemote,
  input: { env: RequesterEnvironment; itemId: string },
): Promise<{ deleted: boolean; recordKept: true; reason: string }> {
  throw new WorkspaceError(501, "handover_not_implemented", "H05 has not built return and apply yet.");
}

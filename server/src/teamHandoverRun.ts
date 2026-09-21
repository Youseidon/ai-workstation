import type { TaskControlAction } from "@agent-console/shared";
import type { ControlRecord, ControlRecordRemote } from "./teamControlRecord.ts";
import type { PublishedOffer } from "./teamHandoverCapture.ts";
import { WorkspaceError } from "./workspaces.ts";

/**
 * Accept, claim and run (H04, TM-T1-H1 and TM-T1-H2).
 *
 * Skeleton: the shape the two T1 rows are written against. Every function
 * throws until the implementation lands, so the rows are red on a stub rather
 * than on behaviour, which the task report states plainly.
 */

const unbuilt = (what: string): never => {
  throw new WorkspaceError(501, "handover_run_unbuilt", `${what} is not built yet.`);
};

/* ------------------------- RTC-12, the capability matrix ------------------- */

export type CapabilityOutcome = "within_limit" | "delta_grantable" | "hard_deny" | "unknown";

export interface RequestedCapabilities {
  provider: string;
  model: string | null;
  hostAccess: boolean;
  sandbox: string;
  tools?: string[];
}

export interface ReceiverPolicy {
  providers: string[];
  models: string[];
  hostAccess: boolean;
  sandbox: string[];
  tools: string[];
  grantable: string[];
  denied: string[];
  unenforceable: string[];
}

export interface CapabilityComparison {
  outcome: CapabilityOutcome;
  requested: string[];
  within: string[];
  additions: string[];
  denied: string[];
  unknown: string[];
  reason: string;
  runnable: boolean;
  needsLocalGrant: boolean;
}

export function capabilityTokens(_requested: RequestedCapabilities): string[] {
  return unbuilt("The capability token set");
}

export function compareCapabilities(_requested: RequestedCapabilities, _policy: ReceiverPolicy): CapabilityComparison {
  return unbuilt("The RTC-12 capability comparison");
}

export function assertRuntimeCapability(_policy: ReceiverPolicy, _comparison: CapabilityComparison, _token: string): void {
  unbuilt("The runtime capability check");
}

/* ------------------------------- environment ------------------------------ */

export interface ReceiverEnvironment {
  personId: string;
  workstationId: string;
  botId: string;
  chatId: string;
  topicId?: string | null;
  actorId: string;
  roster: string[];
  workspaceId: number;
  suiteId: number;
  policy: () => ReceiverPolicy;
}

/* -------------------------------- discovery ------------------------------- */

export interface OfferCard {
  outboxId: number;
  botId: string;
  actions: Array<{ ref: string; action: TaskControlAction }>;
  inert: boolean;
}

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

export async function discoverHandoverOffer(
  _remote: ControlRecordRemote,
  _env: ReceiverEnvironment,
  _options?: { now?: Date; commandIdPrefix?: string; ttlMs?: number },
): Promise<Discovery> {
  return unbuilt("Offer discovery");
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

export async function acceptHandoverOffer(_remote: ControlRecordRemote, _input: AcceptInput): Promise<AcceptResult> {
  return unbuilt("Accept and claim");
}

export interface DeclineResult {
  recorded: boolean;
  cardInert: boolean;
  recordState: ControlRecord["state"];
  recordHead: string;
}

export async function declineHandoverOffer(
  _remote: ControlRecordRemote,
  _input: { env: ReceiverEnvironment; itemId: string; commandId: string; actionRef: string },
): Promise<DeclineResult> {
  return unbuilt("Decline");
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
  checkProvider?: () => Promise<void>;
  now?: Date;
}

export type StartResult =
  | { kind: "started"; runId: string; worktree: string; workspaceId: number; promptId: number; record: ControlRecord }
  | { kind: "refused"; comparison: CapabilityComparison; record: ControlRecord; reason: string }
  | { kind: "no_spawn"; record: ControlRecord; reason: string }
  | { kind: "start_unknown"; runId: string; reason: string; requiresReconciliation: true };

export async function startReceiverRun(_remote: ControlRecordRemote, _input: StartReceiverRunInput): Promise<StartResult> {
  return unbuilt("The receiver run");
}

/* ------------------------------- questions -------------------------------- */

export type HandoverQuestionKind = "requirement" | "access" | "provider" | "allowance";

export function handoverQuestionAudience(_kind: HandoverQuestionKind): "requester" | "receiver" {
  return unbuilt("The question audience map");
}

export interface PostedHandoverQuestion {
  outboxId: number;
  botId: string;
  actorId: string;
  chatId: string;
  audience: "requester" | "receiver";
  actions: Array<{ ref: string; action: TaskControlAction }>;
}

export function postHandoverQuestion(_input: {
  env: ReceiverEnvironment;
  itemId: string;
  promptId: number;
  kind: HandoverQuestionKind;
  question: string;
  requester: { actorId: string; chatId: string; topicId?: string | null };
  ttlMs?: number;
}): PostedHandoverQuestion {
  return unbuilt("Handover questions");
}

/* ------------------------- stop reasons and return ------------------------ */

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

export function classifyHandoverStop(_signal: StopSignal): HandoverStopReason {
  return unbuilt("The stop-reason classification");
}

export interface ReturnResult {
  record: ControlRecord;
  label: "full" | "partial";
  releasedExecutor: boolean;
  stopReason: HandoverStopReason;
}

export async function returnHandoverWork(
  _remote: ControlRecordRemote,
  _input: {
    env: ReceiverEnvironment;
    itemId: string;
    commandIdPrefix: string;
    stopReason: HandoverStopReason;
    resultCommit: string;
    runId: string;
    push: () => Promise<void>;
    now?: Date;
  },
): Promise<ReturnResult> {
  return unbuilt("Return work");
}

/* --------------------- stop requests and reacquisition -------------------- */

export async function requestExecutorStop(
  _remote: ControlRecordRemote,
  _input: { itemId: string; actor: { personId: string; workstationId?: string }; kind: "pause" | "cancel"; commandId: string; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord; requested: true }> {
  return unbuilt("A stop request");
}

export async function acknowledgeExecutorStop(
  _remote: ControlRecordRemote,
  _input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; writingStopped: boolean; blocker?: "required" | "none"; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord }> {
  return unbuilt("A stop acknowledgement");
}

export async function reacquireOwnership(
  _remote: ControlRecordRemote,
  _input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; proof: { noOtherExecutor: boolean }; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord }> {
  return unbuilt("Reacquisition");
}

export async function recordLocalCompletionCancelRequest(
  _remote: ControlRecordRemote,
  _input: { itemId: string; actor: { personId: string; workstationId?: string }; commandId: string; roster?: string[]; now?: Date },
): Promise<{ record: ControlRecord; cancelRequested: boolean; itemClosed: boolean; branchKept: boolean }> {
  return unbuilt("The local-completion cancel request");
}

export function closeAfterHandover(
  _record: ControlRecord,
  _input: { itemId: string; commandId: string },
): { closed: boolean; reason: string } {
  return unbuilt("Closing after a handover");
}

/* ------------------------- roster and Team changes ------------------------ */

export function retireHandoverCardsFor(_input: { itemId: string; personId: string; actorIds: string[] }): { actorsDisabled: number; grantsRevoked: number } {
  return unbuilt("Retiring a removed member's cards");
}

export function assertHandoverEnabled(_config?: { teamEnabled: boolean; handoverEnabled: boolean }): void {
  unbuilt("The handover capability gate");
}

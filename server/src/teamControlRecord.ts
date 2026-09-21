/**
 * The item control record: the Git-carried state machine that arbitrates every
 * handover decision (H02, TM-T0-6).
 *
 * Skeleton only. The type surface below is the contract `teamControlRecord.test.ts`
 * asserts against; every behaviour still throws, so TM-T0-6 fails on behaviour
 * rather than on a missing module.
 */

export const CONTROL_STATES = [
  "LOCAL", "PREPARING", "OFFERED", "CLAIMED", "STARTING", "RUNNING", "WAITING_INPUT",
  "PAUSED", "STOP_REQUESTED", "RETURNED", "APPLYING", "COMPLETED", "CANCELLED", "WITHDRAWN",
] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

export const CONTROL_EVENTS = [
  "create_record", "request_takeover", "publish_offer", "abandon_preparation", "accept_offer",
  "decline_offer", "withdraw_offer", "expire_offer", "preparation_complete", "dependency_wait",
  "run_started", "no_spawn_failure", "blocking_decision", "save_answer", "resume", "stop_request",
  "stop_proven", "run_ended", "return_work", "apply_result", "application_reconciled",
  "request_changes", "further_takeover", "cancel_confirmed", "reacquire", "reopen",
] as const;
export type ControlEventName = (typeof CONTROL_EVENTS)[number];

export type ControlActorRole = "requester" | "executor" | "teammate";

/** An offer expires after 24 hours by default (jd, 2026-09-21). */
export const OFFER_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface ControlRecord {
  version: 1;
  itemId: string;
  state: ControlState;
  epoch: number;
  requester: string;
  executor: string | null;
  branch: string;
  lastCommandId: string | null;
  offerDeadline: string | null;
  resultLabel: "full" | "partial" | null;
  updatedAt: string;
}

export interface ControlEvent {
  version: 1;
  commandId: string;
  event: ControlEventName;
  actor: { personId: string; role: ControlActorRole };
  workstationId: string | null;
  fromState: ControlState;
  toState: ControlState;
  priorEpoch: number;
  epoch: number;
  parent: string | null;
  payload: ControlTransitionPayload;
  recordedAt: string;
}

/** The "required condition" column of protocol.md section 5, made executable. */
export interface ControlTransitionPayload {
  sourceHoldPersisted?: boolean;
  writersStopped?: boolean;
  packageVerified?: boolean;
  branchVerified?: boolean;
  offerDeadline?: string;
  reason?: string;
  policyChecked?: boolean;
  workspaceReserved?: boolean;
  startIntentDurable?: boolean;
  runId?: string;
  spawnOutcome?: "known" | "unknown";
  spawned?: boolean;
  blocker?: "required" | "none";
  writingStopped?: boolean;
  answer?: string;
  unresolvedRequired?: number;
  outcome?: "full" | "partial" | "error";
  resultCommit?: string;
  resultLabel?: "full" | "partial";
  baselineValidated?: boolean;
  acceptanceMet?: boolean;
  requirementsRevision?: string;
  activeWriter?: boolean;
  outstandingStart?: boolean;
  noOtherExecutor?: boolean;
}

export interface ControlTransitionInput {
  event: ControlEventName;
  actor: { personId: string; workstationId?: string };
  commandId: string;
  epoch: number;
  roster?: string[];
  now?: Date;
  payload?: ControlTransitionPayload;
  /** The head this command was minted against, so a race can be driven from one head. */
  fromHead?: string;
}

export interface ControlTransitionRow {
  from: readonly ControlState[];
  event: ControlEventName;
  actors: readonly ControlActorRole[];
  advancesEpoch: boolean;
}

export const CONTROL_TRANSITIONS: readonly ControlTransitionRow[] = [];

export interface ControlSnapshot {
  head: string;
  record: ControlRecord;
}

export interface ControlOutcome {
  head: string;
  record: ControlRecord;
  event: ControlEvent;
  /** False when the outcome was already present and was returned rather than re-applied. */
  applied: boolean;
}

export interface ControlRecordRemote {
  read(): Promise<ControlSnapshot | null>;
  readEvent(commandId: string): Promise<ControlEvent | null>;
  append(expectedHead: string | null, record: ControlRecord, event: ControlEvent): Promise<{ head: string } | "conflict" | "uncertain">;
}

function pending(): never {
  throw new Error("teamControlRecord is not implemented yet");
}

export function controlRef(_itemId: string): string { return pending(); }
export function handoverBranch(_itemId: string): string { return pending(); }
export function newControlRecord(_input: { itemId: string; requester: string; now?: Date }): ControlRecord { return pending(); }
export function controlTransition(_record: ControlRecord, _input: ControlTransitionInput): { record: ControlRecord; event: ControlEvent } { return pending(); }
export async function createControlRecord(_remote: ControlRecordRemote, _input: { itemId: string; requester: string; commandId: string; now?: Date; workstationId?: string }): Promise<ControlOutcome> { return pending(); }
export async function applyControlTransition(_remote: ControlRecordRemote, _input: ControlTransitionInput): Promise<ControlOutcome> { return pending(); }
export async function expireOfferIfDue(_remote: ControlRecordRemote, _input: { actor: { personId: string; workstationId?: string }; commandId: string; roster?: string[]; now?: Date }): Promise<{ expired: boolean; record: ControlRecord; outcome?: ControlOutcome }> { return pending(); }

export class BareGitControlRecordRemote implements ControlRecordRemote {
  constructor(private readonly bareDirectory: string, private readonly itemId: string) {}
  async read(): Promise<ControlSnapshot | null> { return pending(); }
  async readEvent(_commandId: string): Promise<ControlEvent | null> { return pending(); }
  async append(_expectedHead: string | null, _record: ControlRecord, _event: ControlEvent): Promise<{ head: string } | "conflict" | "uncertain"> { return pending(); }
}

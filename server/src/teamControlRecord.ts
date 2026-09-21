import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isItemId } from "./teamItems.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/**
 * The item control record: the Git-carried state machine that arbitrates every
 * handover decision (H02, TM-T0-6).
 *
 * The record lives at `refs/aw/items/<item>/control`, a custom ref outside
 * `refs/heads/`, settled by jd on 2026-09-21 and proved reachable by LG-1 on
 * 2026-09-17. It carries a current `state.json` and append-only
 * `events/<command id>.json`, and each update is one single-parent commit whose
 * parent is the validated current head. The remote's rejection of a non-fast-
 * forward update is the compare-and-swap: nothing here force-pushes, deletes
 * control history or reconciles two `state.json` files.
 *
 * The lifecycle below is protocol.md section 5's table, row by row. Each row is
 * a from-state, an event with its authorized actors, a to-state and the required
 * condition, and all four are checked before anything is written.
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

/**
 * An offer expires after 24 hours by default, settled by jd on 2026-09-21 to
 * match protocol.md's approval-deadline default. Expiry is evaluated against the
 * deadline stored in the record, never by comparing the two workstations' clocks.
 */
export const OFFER_DEADLINE_MS = 24 * 60 * 60 * 1000;

const COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const ZERO_OID = "0000000000000000000000000000000000000000";

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
  /** The Offer record's requested provider, model and package (H03, protocol.md section 3). */
  requestedProvider?: string;
  requestedModel?: string | null;
  /**
   * The rest of what the receiver's workstation compares against its own
   * settings before it runs anything (teammate-design.md 5.4 step 4, B18).
   * Absent means not requested, which is not the same as permitted: H04's
   * comparison treats an omitted requirement as unknown rather than allowed.
   */
  requestedHostAccess?: boolean;
  requestedSandbox?: string;
  requestedTools?: string[];
  packageHash?: string;
  snapshotCommit?: string;
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
  /**
   * protocol.md section 3's Result record. `return_work` records it and
   * `apply_result` and `application_reconciled` quote it forward, so one result
   * id runs through the return, the application and the receipt, and a
   * requester reading the record at any of those states finds the same result
   * without walking the history (H05).
   */
  resultId?: string;
  result?: {
    resultId: string;
    epoch: number;
    resultCommit: string;
    label: "full" | "partial";
    verification: string[];
    uncertainEffects: string[];
    releaseEvidence: string;
    executor: string;
    returnedAt: string;
  };
  /** The merged tree an application is aiming at, recorded before it is reached. */
  targetTree?: string;
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

interface Row extends ControlTransitionRow {
  /** The to-state, which two rows of the table choose from their condition. */
  to: (payload: ControlTransitionPayload, record: ControlRecord) => ControlState;
  /** Returns null when the required condition holds, else why it does not. */
  condition: (payload: ControlTransitionPayload, record: ControlRecord, now: Date) => string | null;
}

const ok = () => null;
const to = (state: ControlState) => () => state;

/**
 * protocol.md section 5, row by row. The one row not in the printed table is
 * `reacquire`, which section 5's prose states in terms: "WITHDRAWN may return to
 * LOCAL through explicit requester reacquisition".
 */
const ROWS: readonly Row[] = [
  {
    from: ["LOCAL"], event: "request_takeover", actors: ["requester"], advancesEpoch: false, to: to("PREPARING"),
    condition: payload => payload.sourceHoldPersisted === true ? null : "The source pipeline and workspace hold must be persisted before interrupting.",
  },
  {
    from: ["PREPARING"], event: "publish_offer", actors: ["requester"], advancesEpoch: true, to: to("OFFERED"),
    condition: payload => payload.writersStopped !== true ? "Managed writers must be stopped before publishing."
      : payload.packageVerified !== true ? "The package must be verified before publishing."
        : payload.branchVerified !== true ? "The handover branch must be retrievable before the offer is published."
          : null,
  },
  { from: ["PREPARING"], event: "abandon_preparation", actors: ["requester"], advancesEpoch: false, to: to("LOCAL"), condition: ok },
  {
    from: ["OFFERED"], event: "accept_offer", actors: ["teammate"], advancesEpoch: false, to: to("CLAIMED"),
    condition: (_payload, record, now) => record.offerDeadline !== null && now.getTime() > Date.parse(record.offerDeadline)
      ? "This offer's start deadline has passed." : null,
  },
  { from: ["OFFERED"], event: "decline_offer", actors: ["teammate"], advancesEpoch: true, to: to("WITHDRAWN"), condition: ok },
  { from: ["OFFERED"], event: "withdraw_offer", actors: ["requester"], advancesEpoch: true, to: to("WITHDRAWN"), condition: ok },
  {
    from: ["OFFERED"], event: "expire_offer", actors: ["requester", "teammate"], advancesEpoch: true, to: to("WITHDRAWN"),
    condition: (_payload, record, now) => record.offerDeadline !== null && now.getTime() > Date.parse(record.offerDeadline)
      ? null : "This offer has not reached its start deadline.",
  },
  {
    from: ["CLAIMED"], event: "preparation_complete", actors: ["executor"], advancesEpoch: false, to: to("STARTING"),
    condition: payload => payload.policyChecked !== true ? "Policy and capability checks must pass before starting."
      : payload.workspaceReserved !== true ? "An idle workspace reservation is required before starting."
        : payload.startIntentDurable !== true ? "The start intent must be durable before starting."
          : null,
  },
  {
    from: ["CLAIMED"], event: "dependency_wait", actors: ["executor"], advancesEpoch: false, to: to("CLAIMED"),
    condition: payload => payload.spawned === true ? "A busy or offline dependency may not spawn a run."
      : typeof payload.reason === "string" && payload.reason.trim() !== "" ? null : "A busy or offline dependency must show its reason.",
  },
  {
    from: ["STARTING"], event: "run_started", actors: ["executor"], advancesEpoch: false, to: to("RUNNING"),
    condition: payload => typeof payload.runId === "string" && payload.runId.trim() !== "" ? null : "A started run must map to exactly one identified attempt.",
  },
  {
    from: ["STARTING"], event: "no_spawn_failure", actors: ["executor"], advancesEpoch: false, to: to("CLAIMED"),
    condition: payload => payload.spawnOutcome === "known" ? null : "An unknown spawn outcome requires reconciliation rather than a no-spawn failure.",
  },
  {
    from: ["RUNNING"], event: "blocking_decision", actors: ["executor"], advancesEpoch: false, to: to("STOP_REQUESTED"),
    condition: payload => typeof payload.reason === "string" && payload.reason.trim() !== "" ? null : "A required question or permission decision must record its blocker.",
  },
  {
    from: ["WAITING_INPUT"], event: "save_answer", actors: ["requester", "executor"], advancesEpoch: false, to: to("WAITING_INPUT"),
    condition: payload => typeof payload.answer === "string" && payload.answer.trim() !== "" ? null : "Saving an answer needs an answer to persist.",
  },
  {
    from: ["WAITING_INPUT", "PAUSED"], event: "resume", actors: ["requester", "executor"], advancesEpoch: false, to: to("STARTING"),
    condition: payload => (payload.unresolvedRequired ?? 0) > 0 ? "Unresolved required questions block a start."
      : payload.policyChecked !== true ? "Policy and capability checks must pass before resuming."
        : payload.workspaceReserved !== true ? "An idle workspace reservation is required before resuming."
          : payload.startIntentDurable !== true ? "The start intent must be durable before resuming."
            : null,
  },
  {
    from: ["CLAIMED", "STARTING", "RUNNING", "WAITING_INPUT"], event: "stop_request", actors: ["requester", "executor"], advancesEpoch: false, to: to("STOP_REQUESTED"),
    condition: payload => typeof payload.reason === "string" && payload.reason.trim() !== "" ? null : "A pause, cancel or transfer request must name its reason.",
  },
  {
    // Only the current executor can acknowledge physical stop or release.
    from: ["STOP_REQUESTED"], event: "stop_proven", actors: ["executor"], advancesEpoch: false,
    to: payload => payload.blocker === "required" ? "WAITING_INPUT" : "PAUSED",
    condition: payload => payload.writingStopped === true ? null : "The executor must prove writing stopped before the hold is released.",
  },
  {
    from: ["RUNNING"], event: "run_ended", actors: ["executor"], advancesEpoch: false, to: to("PAUSED"),
    condition: payload => payload.outcome === "full" || payload.outcome === "partial" || payload.outcome === "error"
      ? null : "A run that ends must record a full, partial or error outcome.",
  },
  {
    from: ["PAUSED"], event: "return_work", actors: ["executor"], advancesEpoch: false, to: to("RETURNED"),
    condition: payload => typeof payload.resultCommit !== "string" || payload.resultCommit.trim() === ""
      ? "Returning work publishes an immutable result."
      : payload.resultLabel === "full" || payload.resultLabel === "partial" ? null : "Incomplete work must be labelled partial.",
  },
  {
    // The source claims a new epoch for application before changing original files.
    from: ["RETURNED"], event: "apply_result", actors: ["requester"], advancesEpoch: true, to: to("APPLYING"),
    condition: payload => payload.baselineValidated === true ? null : "The expected source baseline and result must be validated before applying.",
  },
  {
    from: ["APPLYING"], event: "application_reconciled", actors: ["requester"], advancesEpoch: false,
    to: (payload, record) => payload.acceptanceMet === true && record.resultLabel !== "partial" ? "COMPLETED" : "PAUSED",
    condition: (payload, record) => payload.acceptanceMet === true && record.resultLabel === "partial"
      ? "A result labelled partial cannot be labelled complete; a partial application stays resumable." : null,
  },
  {
    from: ["RETURNED"], event: "request_changes", actors: ["requester"], advancesEpoch: true, to: to("OFFERED"),
    condition: payload => typeof payload.requirementsRevision !== "string" || payload.requirementsRevision.trim() === ""
      ? "Requesting changes needs a new requirements revision."
      : payload.packageVerified !== true ? "The new package must be verified before it is offered."
        : payload.branchVerified !== true ? "The handover branch must be retrievable before the offer is published." : null,
  },
  {
    from: ["PAUSED"], event: "further_takeover", actors: ["requester"], advancesEpoch: true, to: to("OFFERED"),
    condition: payload => payload.writersStopped !== true ? "Managed writers must be stopped before publishing."
      : payload.packageVerified !== true ? "A fresh source release and package are required before a further takeover."
        : payload.branchVerified !== true ? "The handover branch must be retrievable before the offer is published." : null,
  },
  {
    from: ["PAUSED", "WITHDRAWN"], event: "cancel_confirmed", actors: ["requester", "executor"], advancesEpoch: false, to: to("CANCELLED"),
    condition: payload => payload.activeWriter === true ? "Cancellation needs no active writer."
      : payload.outstandingStart === true ? "Cancellation needs no outstanding start." : null,
  },
  {
    // Section 5's prose: WITHDRAWN returns to LOCAL through explicit requester
    // reacquisition, and only through a validated update proving no other
    // executor can still start or run.
    from: ["WITHDRAWN"], event: "reacquire", actors: ["requester"], advancesEpoch: true, to: to("LOCAL"),
    condition: payload => payload.noOtherExecutor === true ? null : "Reacquiring ownership needs proof that no other executor can still start or run.",
  },
  {
    from: ["COMPLETED", "CANCELLED"], event: "reopen", actors: ["requester"], advancesEpoch: true, to: to("LOCAL"),
    condition: payload => typeof payload.requirementsRevision === "string" && payload.requirementsRevision.trim() !== ""
      ? null : "Reopening needs a new requirements revision.",
  },
];

export const CONTROL_TRANSITIONS: readonly ControlTransitionRow[] = ROWS.map(row => ({
  from: row.from, event: row.event, actors: row.actors, advancesEpoch: row.advancesEpoch,
}));

/** Entering one of these releases the offer or the executor (protocol.md section 5). */
const RELEASES_EXECUTOR: readonly ControlState[] = ["LOCAL", "OFFERED", "WITHDRAWN", "RETURNED", "COMPLETED", "CANCELLED"];

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
  /** Fetches the current head and validated state, or null when the record does not exist. */
  read(): Promise<ControlSnapshot | null>;
  /** The recorded outcome of this command id, or null when the record does not carry it. */
  readEvent(commandId: string): Promise<ControlEvent | null>;
  /** Fast-forward-only write. "conflict" is the remote's non-fast-forward rejection. */
  append(expectedHead: string | null, record: ControlRecord, event: ControlEvent): Promise<{ head: string } | "conflict" | "uncertain">;
}

function refuse(code: string, message: string, record: ControlRecord, status = 409): never {
  throw new WorkspaceError(status, code, message, { state: record.state, epoch: String(record.epoch), itemId: record.itemId });
}

function commandId(value: string): string {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    throw new WorkspaceError(422, "invalid_control_command", "A control command id is required.");
  }
  return value;
}

function personId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 160 || /[\s/]/.test(value.trim())) {
    throw new WorkspaceError(422, "invalid_control_record", `${field} is invalid.`);
  }
  return value.trim();
}

export function controlRef(itemId: string): string {
  if (!isItemId(itemId)) throw new WorkspaceError(422, "invalid_control_record", "A valid Team item id is required.");
  return `refs/aw/items/${itemId}/control`;
}

export function handoverBranch(itemId: string): string {
  if (!isItemId(itemId)) throw new WorkspaceError(422, "invalid_control_record", "A valid Team item id is required.");
  return `aw/handover/${itemId}`;
}

/** The genesis record: the initial source owns epoch 0 and the item is LOCAL. */
export function newControlRecord(input: { itemId: string; requester: string; now?: Date }): ControlRecord {
  return validateControlRecord({
    version: 1,
    itemId: input.itemId,
    state: "LOCAL",
    epoch: 0,
    requester: input.requester,
    executor: null,
    branch: handoverBranch(input.itemId),
    lastCommandId: null,
    offerDeadline: null,
    resultLabel: null,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function validateControlRecord(value: unknown): ControlRecord {
  if (value === null || typeof value !== "object") throw new WorkspaceError(422, "invalid_control_record", "The control record is invalid.");
  const source = value as Record<string, unknown>;
  if (source.version !== 1) throw new WorkspaceError(422, "invalid_control_record", "Unsupported control record version.");
  const itemId = source.itemId;
  if (!isItemId(itemId)) throw new WorkspaceError(422, "invalid_control_record", "The control record needs a valid Team item id.");
  if (!CONTROL_STATES.includes(source.state as ControlState)) throw new WorkspaceError(422, "invalid_control_record", "Unknown control state.");
  if (!Number.isSafeInteger(source.epoch) || (source.epoch as number) < 0) throw new WorkspaceError(422, "invalid_control_record", "The control epoch is invalid.");
  if (source.branch !== handoverBranch(itemId)) throw new WorkspaceError(422, "invalid_control_record", "The control record names the wrong handover branch.");
  const label = source.resultLabel;
  if (label !== null && label !== "full" && label !== "partial") throw new WorkspaceError(422, "invalid_control_record", "The result label is invalid.");
  const deadline = source.offerDeadline;
  if (deadline !== null && (typeof deadline !== "string" || Number.isNaN(Date.parse(deadline)))) {
    throw new WorkspaceError(422, "invalid_control_record", "The offer deadline is invalid.");
  }
  return {
    version: 1,
    itemId,
    state: source.state as ControlState,
    epoch: source.epoch as number,
    requester: personId(source.requester, "requester"),
    executor: source.executor === null || source.executor === undefined ? null : personId(source.executor, "executor"),
    branch: source.branch,
    lastCommandId: source.lastCommandId === null || source.lastCommandId === undefined ? null : commandId(source.lastCommandId as string),
    offerDeadline: (deadline as string | null) ?? null,
    resultLabel: label,
    updatedAt: new Date(String(source.updatedAt)).toISOString(),
  };
}

/**
 * The roles this person holds against this record. A transition is authorized
 * only when the table's actor column names one of them, so an actor the table
 * does not authorize is refused and nothing is written.
 */
function rolesFor(record: ControlRecord, person: string, roster?: string[]): ControlActorRole[] {
  const roles: ControlActorRole[] = [];
  if (person === record.requester) roles.push("requester");
  if (record.executor !== null && person === record.executor) roles.push("executor");
  if (person !== record.requester && (roster === undefined || roster.includes(person))) roles.push("teammate");
  return roles;
}

/**
 * Validates one transition against protocol.md section 5 and returns the record
 * and event it would write. Pure: it touches neither Git nor SQLite.
 */
export function controlTransition(record: ControlRecord, input: ControlTransitionInput): { record: ControlRecord; event: ControlEvent } {
  const id = commandId(input.commandId);
  const now = input.now ?? new Date();
  const payload = input.payload ?? {};
  const actor = personId(input.actor.personId, "actor");
  const rows = ROWS.filter(one => one.event === input.event);
  if (rows.length === 0) throw new WorkspaceError(422, "invalid_control_event", "Unknown control event.");
  const row = rows.find(one => one.from.includes(record.state));
  if (row === undefined) {
    refuse("control_state_invalid", `${input.event} is not available from ${record.state}.`, record);
  }
  const roles = rolesFor(record, actor, input.roster);
  const role = row.actors.find(one => roles.includes(one));
  if (role === undefined) {
    refuse("control_actor_unauthorized", `${actor} is not authorized to ${input.event} from ${record.state}.`, record, 403);
  }
  // Ordering comes from epochs and command ids: a command bound to a superseded
  // epoch can never become valid again.
  if (input.epoch !== record.epoch) {
    refuse("control_stale_epoch", `This command was bound to epoch ${input.epoch}, and the item is at epoch ${record.epoch}.`, record);
  }
  const unmet = row.condition(payload, record, now);
  if (unmet !== null) refuse("control_condition_unmet", unmet, record);

  const toState = row.to(payload, record);
  const epoch = row.advancesEpoch ? record.epoch + 1 : record.epoch;
  const next: ControlRecord = validateControlRecord({
    ...record,
    state: toState,
    epoch,
    executor: input.event === "accept_offer" ? actor : RELEASES_EXECUTOR.includes(toState) ? null : record.executor,
    lastCommandId: id,
    offerDeadline: toState === "OFFERED"
      ? (payload.offerDeadline ?? new Date(now.getTime() + OFFER_DEADLINE_MS).toISOString())
      : record.state === "OFFERED" ? null : record.offerDeadline,
    resultLabel: input.event === "return_work" ? (payload.resultLabel ?? null) : toState === "LOCAL" ? null : record.resultLabel,
    updatedAt: now.toISOString(),
  });
  const event: ControlEvent = {
    version: 1,
    commandId: id,
    event: input.event,
    actor: { personId: actor, role },
    workstationId: input.actor.workstationId ?? null,
    fromState: record.state,
    toState,
    priorEpoch: record.epoch,
    epoch,
    parent: null,
    payload,
    recordedAt: now.toISOString(),
  };
  return { record: next, event };
}

/** Writes the accepted head into `item_link.control_head`, when this workstation links the item. */
function cacheControlHead(record: ControlRecord, head: string): void {
  if (workspaces.itemLink(record.itemId) === null) return;
  workspaces.updateItemControlHead({ itemId: record.itemId, controlHead: head, epoch: record.epoch >= 1 ? record.epoch : undefined });
}

/** Creates the record at `LOCAL`, epoch 0, before any offer exists. */
export async function createControlRecord(
  remote: ControlRecordRemote,
  input: { itemId: string; requester: string; commandId: string; now?: Date; workstationId?: string },
): Promise<ControlOutcome> {
  const id = commandId(input.commandId);
  const now = input.now ?? new Date();
  const existing = await remote.read();
  if (existing !== null) {
    const recorded = await remote.readEvent(id);
    if (recorded !== null) return { head: existing.head, record: existing.record, event: recorded, applied: false };
    refuse("control_exists", "This item already has a control record.", existing.record);
  }
  const record = newControlRecord({ itemId: input.itemId, requester: input.requester, now });
  const seeded: ControlRecord = { ...record, lastCommandId: id };
  const event: ControlEvent = {
    version: 1,
    commandId: id,
    event: "create_record",
    actor: { personId: personId(input.requester, "requester"), role: "requester" },
    workstationId: input.workstationId ?? null,
    fromState: "LOCAL",
    toState: "LOCAL",
    priorEpoch: 0,
    epoch: 0,
    parent: null,
    payload: {},
    recordedAt: now.toISOString(),
  };
  const written = await remote.append(null, seeded, event);
  if (written === "conflict" || written === "uncertain") {
    const current = await remote.read();
    const recorded = current === null ? null : await remote.readEvent(id);
    if (current !== null && recorded !== null) return { head: current.head, record: current.record, event: recorded, applied: false };
    throw new WorkspaceError(409, "control_conflict", "Another workstation created this control record first; re-read it before trying again.");
  }
  cacheControlHead(seeded, written.head);
  return { head: written.head, record: seeded, event, applied: true };
}

/**
 * The publication protocol of protocol.md section 4: fetch and validate the
 * current head, recheck the semantic preconditions, write one update from that
 * head, and on a lost race re-read and re-validate rather than re-applying. An
 * uncertain outcome is resolved by looking for the command id, never by a blind
 * retry, so no event is ever recorded twice.
 */
export async function applyControlTransition(remote: ControlRecordRemote, input: ControlTransitionInput): Promise<ControlOutcome> {
  const id = commandId(input.commandId);
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  // A workstation whose local row is behind must not re-apply a command id the
  // record already carries.
  const already = await remote.readEvent(id);
  if (already !== null) {
    cacheControlHead(current.record, current.head);
    return { head: current.head, record: current.record, event: already, applied: false };
  }
  if (input.fromHead !== undefined && input.fromHead !== current.head) {
    refuse("control_conflict", "The control record moved; re-read it and re-validate before trying again.", current.record);
  }
  const head = input.fromHead ?? current.head;
  const { record, event } = controlTransition(current.record, { ...input, commandId: id });
  const written = await remote.append(head, record, { ...event, parent: head });
  if (written === "conflict") {
    const settled = await remote.read();
    const recorded = settled === null ? null : await remote.readEvent(id);
    if (settled !== null && recorded !== null) {
      cacheControlHead(settled.record, settled.head);
      return { head: settled.head, record: settled.record, event: recorded, applied: false };
    }
    if (settled !== null) cacheControlHead(settled.record, settled.head);
    refuse("control_conflict", "Another workstation updated this item first; re-read it and re-validate before trying again.", settled?.record ?? current.record);
  }
  if (written === "uncertain") {
    // Fetch and search for this command id before retrying; if it is present,
    // return its existing outcome.
    const settled = await remote.read();
    const recorded = settled === null ? null : await remote.readEvent(id);
    if (settled !== null && recorded !== null) {
      cacheControlHead(settled.record, settled.head);
      return { head: settled.head, record: settled.record, event: recorded, applied: false };
    }
    throw new WorkspaceError(503, "control_push_uncertain", "The control record update did not land; waiting to re-read it before trying again.");
  }
  cacheControlHead(record, written.head);
  return { head: written.head, record, event: { ...event, parent: head }, applied: true };
}

/**
 * Evaluates the stored start deadline. An offer still `OFFERED` past it moves to
 * `WITHDRAWN` through the same validated shared update as decline and withdraw,
 * with its own command id, so expiry is recorded rather than inferred. A second
 * evaluation returns the existing outcome and writes nothing further, and expiry
 * cannot affect a claim that already exists.
 */
export async function expireOfferIfDue(
  remote: ControlRecordRemote,
  input: { actor: { personId: string; workstationId?: string }; commandId: string; roster?: string[]; now?: Date },
): Promise<{ expired: boolean; record: ControlRecord; outcome?: ControlOutcome }> {
  const now = input.now ?? new Date();
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  if (current.record.state !== "OFFERED") return { expired: false, record: current.record };
  if (current.record.offerDeadline === null || now.getTime() <= Date.parse(current.record.offerDeadline)) {
    return { expired: false, record: current.record };
  }
  const outcome = await applyControlTransition(remote, {
    event: "expire_offer",
    actor: input.actor,
    commandId: input.commandId,
    epoch: current.record.epoch,
    roster: input.roster,
    now,
    fromHead: current.head,
  });
  return { expired: outcome.applied, record: outcome.record, outcome };
}

function git(directory: string, args: string[], stdin?: string): string {
  const result = spawnSync("git", ["--git-dir", directory, ...args], { input: stdin, encoding: "utf8" });
  if (result.status !== 0) throw new WorkspaceError(502, "control_git_failed", (result.stderr || result.stdout || "Git control record operation failed.").trim());
  return result.stdout.trim();
}

function readBlob(directory: string, path: string): string | null {
  const result = spawnSync("git", ["--git-dir", directory, "cat-file", "blob", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Writes the objects for one control update and returns its commit. The commit
 * has exactly one parent, the validated current head, and its tree is the new
 * `state.json` beside the events already carried plus this command's own event.
 * It moves no ref, so a caller that must have the remote accept the update first
 * can push the commit before its own mirror follows.
 */
function buildControlCommit(bareDirectory: string, expectedHead: string | null, record: ControlRecord, event: ControlEvent): string {
  const id = commandId(event.commandId);
  const stateBlob = git(bareDirectory, ["hash-object", "-w", "--stdin"], JSON.stringify(validateControlRecord(record)));
  const eventBlob = git(bareDirectory, ["hash-object", "-w", "--stdin"], JSON.stringify(event));
  const carried = expectedHead === null
    ? []
    : (spawnSync("git", ["--git-dir", bareDirectory, "ls-tree", `${expectedHead}:events`], { encoding: "utf8" }).stdout ?? "")
      .split("\n").map(line => line.trim()).filter(line => line !== "" && !line.endsWith(`\t${id}.json`));
  const eventsTree = git(bareDirectory, ["mktree"], [...carried, `100644 blob ${eventBlob}\t${id}.json`].join("\n") + "\n");
  const tree = git(bareDirectory, ["mktree"], `040000 tree ${eventsTree}\tevents\n100644 blob ${stateBlob}\tstate.json\n`);
  const commit = spawnSync("git", [
    "--git-dir", bareDirectory, "commit-tree", tree,
    ...(expectedHead === null ? [] : ["-p", expectedHead]),
    "-m", `${event.event}: ${event.fromState} to ${event.toState} (${id})`,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "agent-console", GIT_AUTHOR_EMAIL: "agent-console@invalid",
      GIT_COMMITTER_NAME: "agent-console", GIT_COMMITTER_EMAIL: "agent-console@invalid",
      GIT_AUTHOR_DATE: event.recordedAt, GIT_COMMITTER_DATE: event.recordedAt,
    },
  });
  if (commit.status !== 0) throw new WorkspaceError(502, "control_git_failed", (commit.stderr || "Could not write the control commit.").trim());
  return commit.stdout.trim();
}

/**
 * A bare-repository seam for `refs/aw/items/<item>/control`. The write is a
 * single-parent commit offered against the validated current head, and Git's
 * refusal to move the ref from a head that is no longer current is the
 * compare-and-swap. Nothing here rewrites or removes history.
 */
export class BareGitControlRecordRemote implements ControlRecordRemote {
  private readonly ref: string;

  constructor(private readonly bareDirectory: string, private readonly itemId: string) {
    this.ref = controlRef(itemId);
  }

  private head(): string | null {
    const found = spawnSync("git", ["--git-dir", this.bareDirectory, "rev-parse", "--verify", "-q", this.ref], { encoding: "utf8" });
    return found.status === 0 ? found.stdout.trim() : null;
  }

  async read(): Promise<ControlSnapshot | null> {
    const head = this.head();
    if (head === null) return null;
    const state = readBlob(this.bareDirectory, `${head}:state.json`);
    if (state === null) throw new WorkspaceError(502, "control_git_failed", "The control record carries no state.json.");
    const record = validateControlRecord(JSON.parse(state) as unknown);
    if (record.itemId !== this.itemId) throw new WorkspaceError(409, "control_item_mismatch", "This control record belongs to another item.");
    return { head, record };
  }

  async readEvent(id: string): Promise<ControlEvent | null> {
    const head = this.head();
    if (head === null) return null;
    const blob = readBlob(this.bareDirectory, `${head}:events/${commandId(id)}.json`);
    return blob === null ? null : JSON.parse(blob) as ControlEvent;
  }

  async append(expectedHead: string | null, record: ControlRecord, event: ControlEvent): Promise<{ head: string } | "conflict"> {
    const next = buildControlCommit(this.bareDirectory, expectedHead, record, event);
    const swap = spawnSync("git", ["--git-dir", this.bareDirectory, "update-ref", this.ref, next, expectedHead ?? ZERO_OID], { encoding: "utf8" });
    return swap.status === 0 ? { head: next } : "conflict";
  }
}

/**
 * A private bare clone which fetches and appends only this item's control ref.
 *
 * The fetch carries no refspec prefix and the push carries no force flag, so a
 * divergent update is rejected by the remote rather than overwriting history,
 * and that rejection is the compare-and-swap. This mirrors
 * `RemoteGitTeamRosterRemote`, which has run against the same host behaviour
 * since TM1 on LG-1's evidence; like it, it is exercised against a live remote
 * by the live checks rather than at T0, where no push is permitted.
 */
export class RemoteGitControlRecordRemote implements ControlRecordRemote {
  private readonly ref: string;
  private readonly local: BareGitControlRecordRemote;

  constructor(private readonly bareDirectory: string, itemId: string, private readonly remoteUrl: string) {
    this.ref = controlRef(itemId);
    this.local = new BareGitControlRecordRemote(bareDirectory, itemId);
    if (!existsSync(bareDirectory)) {
      mkdirSync(dirname(bareDirectory), { recursive: true, mode: 0o700 });
      const cloned = spawnSync("git", ["clone", "--bare", "--no-checkout", remoteUrl, bareDirectory], { encoding: "utf8" });
      if (cloned.status !== 0) throw new WorkspaceError(502, "control_git_failed", (cloned.stderr || "Could not clone the project repository.").trim());
    } else git(bareDirectory, ["remote", "set-url", "origin", remoteUrl]);
  }

  private fetch(): void {
    const fetched = spawnSync("git", ["--git-dir", this.bareDirectory, "fetch", "-q", "origin", `${this.ref}:${this.ref}`], { encoding: "utf8" });
    // A missing ref is simply a record that does not exist yet; anything else is
    // the repository being unreachable, which the caller reports as waiting.
    if (fetched.status !== 0 && !/couldn't find remote ref|not our ref/i.test(fetched.stderr ?? "")) {
      throw new WorkspaceError(503, "control_unreachable", "Waiting for the project repository to become reachable.");
    }
  }

  async read(): Promise<ControlSnapshot | null> {
    this.fetch();
    return this.local.read();
  }

  async readEvent(id: string): Promise<ControlEvent | null> {
    return this.local.readEvent(id);
  }

  async append(expectedHead: string | null, record: ControlRecord, event: ControlEvent): Promise<{ head: string } | "conflict" | "uncertain"> {
    const current = await this.local.read();
    if ((current?.head ?? null) !== expectedHead) return "conflict";
    const next = buildControlCommit(this.bareDirectory, expectedHead, record, event);
    // A normal push of a fast-forward update. The remote is what rejects a
    // divergent one, and that rejection is the compare-and-swap.
    const pushed = spawnSync("git", ["--git-dir", this.bareDirectory, "push", "origin", `${next}:${this.ref}`], { encoding: "utf8" });
    if (pushed.status !== 0) {
      // A rejection is a lost race; anything else leaves the outcome unknown,
      // which the caller resolves by fetching and looking for the command id.
      return /non-fast-forward|fetch first|rejected|already exists/i.test(pushed.stderr ?? "") ? "conflict" : "uncertain";
    }
    const swap = spawnSync("git", ["--git-dir", this.bareDirectory, "update-ref", this.ref, next, expectedHead ?? ZERO_OID], { encoding: "utf8" });
    return swap.status === 0 ? { head: next } : "conflict";
  }
}

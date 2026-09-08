import { createLogger } from "./lib/logger.ts";
import { settings } from "./settings.ts";
import { workspaces } from "./workspaces.ts";

const log = createLogger("retention");

const DELETE_BATCH = 5_000;
const BATCH_PAUSE_MS = 25;

export interface SweepRunEventsResult {
  runsConsidered: number;
  runsTrimmed: number;
  deleted: number;
  keptFinalIntact: boolean;
  vacuum: { autoVacuum: string; ran: boolean };
  databaseBytes: number;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trim `agent_run_event` so the database stops growing without bound.
 *
 * Per run: keep at most `eventsPerRun` (oldest deleted first), always leaving
 * the last `keepFinalEvents` intact. Runs that ended more than `eventAgeDays`
 * ago are thinned to just those final events. Deletes happen in batches of
 * 5 000 with a short pause — never one long transaction — so a restart mid-
 * sweep cannot hold the lock across the whole transcript.
 *
 * `agent_run`, remarks, status events and commands are not touched.
 */
export async function sweepRunEvents(options: { pauseMs?: number } = {}): Promise<SweepRunEventsResult> {
  const { eventsPerRun, eventAgeDays, keepFinalEvents } = settings.retention;
  const pauseMs = options.pauseMs ?? BATCH_PAUSE_MS;
  const ageCutoffMs = eventAgeDays > 0 ? Date.now() - eventAgeDays * 24 * 60 * 60 * 1000 : null;

  const stats = workspaces.runEventRetentionStats();
  let deleted = 0;
  let runsTrimmed = 0;
  let keptFinalIntact = true;
  const pending: number[] = [];

  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending.splice(0, DELETE_BATCH);
      deleted += workspaces.deleteAgentRunEventsByIds(batch);
      if (pending.length > 0 || batch.length === DELETE_BATCH) await pause(pauseMs);
    }
  };

  for (const row of stats) {
    const aged = ageCutoffMs !== null
      && row.endedAt !== null
      && Date.parse(row.endedAt) < ageCutoffMs;
    const keep = aged
      ? keepFinalEvents
      : Math.max(eventsPerRun, keepFinalEvents);
    if (row.eventCount <= keep) continue;

    const ids = workspaces.runEventIdsOldestFirst(row.runId);
    const finalIds = ids.slice(-keepFinalEvents);
    const toDelete = ids.slice(0, Math.max(0, ids.length - keep));
    // The last keepFinalEvents must survive even when eventsPerRun is somehow
    // smaller — refuse to queue a delete that would eat into that tail.
    const finalSet = new Set(finalIds);
    for (const id of toDelete) {
      if (finalSet.has(id)) {
        keptFinalIntact = false;
        continue;
      }
      pending.push(id);
    }
    if (toDelete.length > 0) runsTrimmed += 1;
    if (pending.length >= DELETE_BATCH) await flush();
  }
  await flush();

  const vacuum = workspaces.tryIncrementalVacuum();
  const databaseBytes = workspaces.databaseByteSize();
  const result: SweepRunEventsResult = {
    runsConsidered: stats.length,
    runsTrimmed,
    deleted,
    keptFinalIntact,
    vacuum,
    databaseBytes,
  };
  log.info(
    `sweep deleted=${deleted} runsTrimmed=${runsTrimmed}/${stats.length} `
    + `vacuum=${vacuum.ran ? "incremental" : `skip(${vacuum.autoVacuum})`} `
    + `dbBytes=${databaseBytes}`,
  );
  return result;
}

let scheduled = false;

/** First sweep 60 s after boot, then every 6 h. Idempotent. */
export function scheduleRetentionSweep(): void {
  if (scheduled) return;
  scheduled = true;
  const FIRST_DELAY_MS = 60_000;
  const INTERVAL_MS = 6 * 60 * 60 * 1000;
  const run = () => {
    void sweepRunEvents().catch((error: unknown) => {
      log.error("event retention sweep failed", error);
    });
  };
  setTimeout(() => {
    run();
    setInterval(run, INTERVAL_MS).unref();
  }, FIRST_DELAY_MS).unref();
}

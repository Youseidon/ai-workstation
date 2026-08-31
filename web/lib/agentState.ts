import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import type { LogItem } from "./log";
import type { RunStatus } from "./agentConsole";

/**
 * What an agent is visibly doing.
 *
 * Every value is derived from the run's own event stream, so the avatar is a
 * status readout rather than decoration: if it is spinning, the agent really is
 * mid-tool-call.
 */
export type AgentActivity =
  | "offline"
  | "idle"
  | "starting"
  | "thinking"
  | "tooling"
  | "speaking"
  | "done"
  | "error";

export interface AgentState {
  provider: ProviderId;
  activity: AgentActivity;
  /** The live execute run, when there is one. Consults live in `consults`. */
  run: RunStatus | null;
  consults: RunStatus[];
  consultCount: number;
  /** One line of plain English about what is happening right now. */
  caption: string;
  available: boolean;
  reason: string | null;
  model: string | null;
}

export interface ProviderRuns {
  execute: RunStatus | null;
  consults: RunStatus[];
}

/** How long a finished run keeps showing its outcome before going idle. */
const AFTERGLOW_MS = 8000;

const ACTIVITY_RANK: Record<AgentActivity, number> = {
  error: 6,
  tooling: 5,
  speaking: 4,
  thinking: 3,
  starting: 2,
  done: 1,
  idle: 0,
  offline: 0,
};

/**
 * A provider can be writing and asking at once. `runs.find(provider)` would
 * hide the consult (or the writer) depending on insertion order.
 */
export function runsForProvider(provider: ProviderId, runs: RunStatus[]): ProviderRuns {
  const mine = runs.filter((entry) => entry.provider === provider);
  return {
    execute: mine.find((entry) => entry.role === "execute") ?? null,
    consults: mine.filter((entry) => entry.role === "consult"),
  };
}

/** Status bar occupancy: a writer beats a consult in the same workspace. */
export function preferExecuteRun(run: RunStatus | null, runs: RunStatus[]): RunStatus | null {
  if (run === null) return null;
  if (run.role === "execute") return run;
  return runs.find((entry) => entry.workspace.id === run.workspace.id && entry.role === "execute") ?? run;
}

/** One-line consult question for Dock/Fleet chips. */
export function consultQuestion(run: RunStatus): string {
  const raw = run.source.type === "consult" ? run.source.question : (run.detail ?? "research");
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Reads the tail of the transcript for one run.
 *
 * A tool call still awaiting its result is the most informative thing an agent
 * can be doing, so it outranks streamed prose.
 */
function readTail(items: LogItem[], runId: string): { activity: AgentActivity; caption: string } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.runId !== runId) continue;
    if (item.kind === "error") {
      return { activity: "error", caption: item.message };
    }
    if (item.kind === "tool") {
      if (item.result === null) {
        return {
          activity: "tooling",
          caption: item.summary === "" ? `running ${item.name}` : `${item.name} · ${item.summary}`,
        };
      }
      return {
        activity: "thinking",
        caption: item.result.summary === "" ? `finished ${item.name}` : `${item.name} → ${item.result.summary}`,
      };
    }
    if (item.kind === "text" && item.text.trim() !== "") {
      const flat = item.text.replace(/\s+/g, " ").trim();
      return item.textKind === "thinking"
        ? { activity: "thinking", caption: flat }
        : { activity: "speaking", caption: flat };
    }
  }
  return null;
}

function liveProjection(run: RunStatus, items: LogItem[]): { activity: AgentActivity; caption: string } {
  const tail = readTail(items, run.runId);
  if (tail !== null) return tail;
  return {
    activity: run.state === "starting" ? "starting" : "thinking",
    caption: run.detail ?? (run.state === "starting" ? "starting up…" : "working…"),
  };
}

function busiestConsult(consults: RunStatus[], items: LogItem[]): RunStatus {
  let best = consults[0]!;
  let bestRank = -1;
  let bestElapsed = -1;
  for (const consult of consults) {
    const { activity } = liveProjection(consult, items);
    const rank = ACTIVITY_RANK[activity];
    if (rank > bestRank || (rank === bestRank && consult.elapsedMs > bestElapsed)) {
      best = consult;
      bestRank = rank;
      bestElapsed = consult.elapsedMs;
    }
  }
  return best;
}

export function agentState(
  provider: ProviderInfo,
  runs: RunStatus[],
  items: LogItem[],
  lastRun: RunStatus | null,
  now: number = Date.now(),
): AgentState {
  const { execute, consults } = runsForProvider(provider.id, runs);
  const focus = execute ?? (consults.length > 0 ? busiestConsult(consults, items) : null);
  const base = {
    provider: provider.id,
    run: execute,
    consults,
    consultCount: consults.length,
    available: provider.available,
    reason: provider.reason,
    model: focus?.model ?? provider.model,
  };

  if (focus !== null) {
    return { ...base, ...liveProjection(focus, items) };
  }

  if (!provider.available) {
    return { ...base, activity: "offline", caption: provider.reason ?? "not detected" };
  }

  // Briefly keep showing how the last run ended, so a result that arrives while
  // you are looking elsewhere is not gone by the time you look back.
  if (lastRun !== null && lastRun.provider === provider.id) {
    const age = now - new Date(lastRun.startedAt).getTime() - lastRun.elapsedMs;
    if (age < AFTERGLOW_MS) {
      if (lastRun.state === "error") return { ...base, activity: "error", caption: "last run failed" };
      if (lastRun.state === "interrupted") return { ...base, activity: "done", caption: "last run was stopped" };
      if (lastRun.state === "done") return { ...base, activity: "done", caption: "finished" };
    }
  }

  return { ...base, activity: "idle", caption: "ready" };
}

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  offline: "Unavailable",
  idle: "Idle",
  starting: "Starting",
  thinking: "Thinking",
  tooling: "Using a tool",
  speaking: "Responding",
  done: "Finished",
  error: "Error",
};

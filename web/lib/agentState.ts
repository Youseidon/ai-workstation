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
  /** The live run, when there is one. */
  run: RunStatus | null;
  /** One line of plain English about what is happening right now. */
  caption: string;
  available: boolean;
  reason: string | null;
  model: string | null;
}

/** How long a finished run keeps showing its outcome before going idle. */
const AFTERGLOW_MS = 8000;

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

export function agentState(
  provider: ProviderInfo,
  runs: RunStatus[],
  items: LogItem[],
  lastRun: RunStatus | null,
  now: number = Date.now(),
): AgentState {
  const run = runs.find((entry) => entry.provider === provider.id) ?? null;
  const base = {
    provider: provider.id,
    run,
    available: provider.available,
    reason: provider.reason,
    model: run?.model ?? provider.model,
  };

  if (run !== null) {
    const tail = readTail(items, run.runId);
    if (tail !== null) return { ...base, ...tail };
    return {
      ...base,
      activity: run.state === "starting" ? "starting" : "thinking",
      caption: run.detail ?? (run.state === "starting" ? "starting up…" : "working…"),
    };
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

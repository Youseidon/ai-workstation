import type { TokenUsage, ProviderId, RunRole, RunState, StationPolicy, NormalizedEvent } from "@hydra/shared";
import type { ProcessIdentity } from "./execution.ts";
import type { AgentAdapter, PermissionOverride } from "./agentAdapter.ts";

/**
 * What a run is allowed to spend. Enforced by the runner rather than per adapter, so a
 * provider without its own turn limit is bounded exactly like one that has it.
 * `null` disables an individual budget.
 */
export interface RunBudget {
  maxTotalTokens?:number|null;
  maxToolCalls: number | null;
  maxWallClockMs: number | null;
  maxInputTokens: number | null;
  maxToolOutputBytes: number | null;
  /** Consecutive identical tool calls tolerated before the run is stopped. */
  noProgressToolCalls: number | null;
  /** Per-result cap; 0 disables truncation. */
  maxToolResultBytes: number;
  /** Longest one tool_use may remain unmatched by tool_result. */
  maxOpenToolCallMs: number | null;
}

/** What a run actually spent. Persisted on `agent_run` when it ends. */
export interface RunMetrics {
  processStarted?:boolean|null;
  usage: TokenUsage | null;
  toolCalls: number;
  toolOutputBytes: number;
  /** Set when the runner stopped the run itself. */
  stopReason: string | null;
  /** Peak bytes charged to the run's systemd cgroup, when available. */
  peakMemoryBytes: number | null;
  /**
   * The provider's own id for the conversation this run had, when it announced
   * one. Null for a provider that never did — the wrap-up turn then falls back
   * to a fresh session with a written brief instead of resuming.
   */
  sessionId: string | null;
}

/** Live budget state, surfaced to the agent through the Progress API. */
export interface BudgetSnapshot {
  toolCalls: { used: number; limit: number | null };
  wallClockMs: { used: number; limit: number | null };
  /** Cost-weighted: cache reads count at their cache-read rate, not in full. */
  inputTokens: { used: number; limit: number | null };
  toolOutputBytes: { used: number; limit: number | null };
  openToolCallMs: { used: number; limit: number | null };
  /** 0-1, the highest utilisation across all active budgets. */
  pressure: number;
  warning: string | null;
  exhausted: boolean;
}

export interface RunHandle {
  runId: string;
  provider: ProviderId;
  /** Resolved once at start, so `run_started` and every event agree. */
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  /** The provider session this run is having, once it has named one. */
  sessionId(): string | null;
  interrupt(): Promise<void>;
  /** Stop the provider after it has posted its authoritative terminal status. */
  complete?(): Promise<void>;
  /** Live budget state, for the Progress API to hand back to the agent. */
  budget(): BudgetSnapshot;
  done: Promise<Extract<RunState, "done" | "interrupted" | "error">>;
}

export interface StartRunArgs {
  stationPolicy?: StationPolicy;
  launcherPath?: string | null;
  onSpawn?: (identity: ProcessIdentity) => void;
  runId?: string;
  adapter: AgentAdapter;
  prompt: string;
  cwd: string;
  /** Model picked in the UI for this run; falls back to the adapter's setting. */
  model?: string | null;
  /** Keep the source run's model when resuming that exact provider session. */
  preserveModel?: boolean;
  role?: RunRole;
  permissionOverride?: PermissionOverride;
  /** Continue this provider session instead of opening a new one. */
  resumeSessionId?: string | null;
  /** Omitted budgets fall back to the settings defaults. */
  budget?: Partial<RunBudget>;
  onEvent(event: NormalizedEvent): void;
  onEnd(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">, metrics: RunMetrics): void;
}

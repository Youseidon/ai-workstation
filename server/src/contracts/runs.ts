import type { TokenUsage, ProviderId, RunRole, RunState, StationPolicy, NormalizedEvent } from "@hydra/shared";
import type { ProcessIdentity } from "./execution.ts";
import type { AgentAdapter, PermissionOverride } from "./agentAdapter.ts";

export interface RunBudget {
  maxTotalTokens?:number|null;
  maxToolCalls: number | null;
  maxWallClockMs: number | null;
  maxInputTokens: number | null;
  maxToolOutputBytes: number | null;
  noProgressToolCalls: number | null;
  maxToolResultBytes: number;
  maxOpenToolCallMs: number | null;
}

export interface RunMetrics {
  processStarted?:boolean|null;
  usage: TokenUsage | null;
  toolCalls: number;
  toolOutputBytes: number;
  stopReason: string | null;
  peakMemoryBytes: number | null;
  sessionId: string | null;
}

export interface BudgetSnapshot {
  toolCalls: { used: number; limit: number | null };
  wallClockMs: { used: number; limit: number | null };
  inputTokens: { used: number; limit: number | null };
  toolOutputBytes: { used: number; limit: number | null };
  openToolCallMs: { used: number; limit: number | null };
  pressure: number;
  warning: string | null;
  exhausted: boolean;
}

export interface RunHandle {
  runId: string;
  provider: ProviderId;
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  sessionId(): string | null;
  interrupt(): Promise<void>;
  complete?(): Promise<void>;
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
  model?: string | null;
  preserveModel?: boolean;
  role?: RunRole;
  permissionOverride?: PermissionOverride;
  resumeSessionId?: string | null;
  budget?: Partial<RunBudget>;
  onEvent(event: NormalizedEvent): void;
  onEnd(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">, metrics: RunMetrics): void;
}

import type { PipelineState, ProviderId, PromptStatus, RunRole } from "@hydra/shared";

export interface RemoteRun {
  runId: string;
  title: string;
  workspaceName: string;
  provider: ProviderId;
  model: string | null;
  role: RunRole;
  elapsedMs: number;
}

export interface RemoteStep {
  promptId: number;
  key: string | null;
  title: string;
  status: PromptStatus;
}

export interface RemotePipeline {
  id: number;
  name: string;
  workspaceName: string;
  state: PipelineState | null;
  waitReason: string | null;
  currentSuite: string | null;
  current: RemoteStep | null;
  next: RemoteStep | null;
  done: number;
  total: number;
}

export interface RemoteGate {
  promptId: number;
  key: string | null;
  title: string;
  workspaceName: string;
  question: string | null;
  since: string | null;
}

export interface RemoteOverview {
  runs: RemoteRun[];
  pipelines: RemotePipeline[];
  gates: RemoteGate[];
}

export type TelegramNotice =
  | { kind: "gate"; gate: RemoteGate }
  | { kind: "pipeline_waiting"; pipelineId: number; name: string; workspaceName: string; reason: string | null }
  | { kind: "pipeline_ended"; pipelineId: number; name: string; workspaceName: string; state: "COMPLETE" | "STOPPED" | "INTERRUPTED"; reason: string | null }
  | { kind: "run_failed"; runId: string; title: string; workspaceName: string; provider: ProviderId; detail: string | null };

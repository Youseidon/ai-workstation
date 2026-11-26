import type { PipelineRecord, PipelineState, ProviderId, ServerMessage } from "@hydra/shared";
import type { RemoteGate, TelegramNotice } from "../../contracts/remote.ts";
import { workspaces } from "../../repositories/workspaces.ts";
import { createLogger } from "../../utils/logger.ts";
import { runHub } from "../runs/runHub.ts";
import { remoteGates, runTitle } from "./remoteOverview.ts";

const log = createLogger("notifier");
const POLL_MS = 10_000;

export interface NoticeMarks {
  pipelines: Map<number, { activeId: string | null; state: PipelineState | null }>;
  gates: Set<number>;
}

export function diffNotices(previous: NoticeMarks | null, pipelines: PipelineRecord[], gates: RemoteGate[]): { notices: TelegramNotice[]; marks: NoticeMarks } {
  const marks: NoticeMarks = {
    pipelines: new Map(pipelines.map(pipeline => [pipeline.id, { activeId: pipeline.active?.id ?? null, state: pipeline.active?.state ?? null }])),
    gates: new Set(gates.map(gate => gate.promptId)),
  };
  if (previous === null) return { notices: [], marks };
  const notices: TelegramNotice[] = [];
  const newGates = gates.filter(gate => !previous.gates.has(gate.promptId));
  for (const gate of newGates) notices.push({ kind: "gate", gate });
  for (const pipeline of pipelines) {
    const before = previous.pipelines.get(pipeline.id);
    if (before === undefined) continue;
    const active = pipeline.active;
    const explained = newGates.some(gate => gate.workspaceName === pipeline.workspaceName);
    if (active?.state === "WAITING_HUMAN" && !(before.activeId === active.id && before.state === "WAITING_HUMAN") && !explained) {
      notices.push({ kind: "pipeline_waiting", pipelineId: pipeline.id, name: pipeline.name, workspaceName: pipeline.workspaceName, reason: active.waitReason });
    }
    if (before.activeId !== null && active?.id !== before.activeId) {
      const ended = pipeline.latest?.id === before.activeId ? pipeline.latest : null;
      if (ended && (ended.state === "COMPLETE" || ended.state === "STOPPED" || ended.state === "INTERRUPTED")) {
        notices.push({ kind: "pipeline_ended", pipelineId: pipeline.id, name: pipeline.name, workspaceName: pipeline.workspaceName, state: ended.state, reason: ended.stopReason });
      }
    }
  }
  return { notices, marks };
}

export function startTelegramNotifier(emit: (notice: TelegramNotice) => void): () => void {
  const started = new Map<string, { title: string; workspaceName: string; provider: ProviderId }>();
  const lastError = new Map<string, string>();
  const unsubscribe = runHub.subscribe((message: ServerMessage) => {
    if (message.kind === "run_started") {
      started.set(message.runId, { title: runTitle(message.source), workspaceName: message.workspace.name, provider: message.provider });
    } else if (message.kind === "event" && message.event.type === "error") {
      const payload = message.event.payload as { message?: unknown };
      if (typeof payload.message === "string") lastError.set(message.event.runId, payload.message);
    } else if (message.kind === "run_ended") {
      const run = started.get(message.runId);
      if (run && message.state === "error") emit({ kind: "run_failed", runId: message.runId, ...run, detail: lastError.get(message.runId) ?? null });
      started.delete(message.runId); lastError.delete(message.runId);
    }
  });
  let marks: NoticeMarks | null = null;
  const poll = () => {
    try {
      const result = diffNotices(marks, workspaces.listPipelines(), remoteGates());
      marks = result.marks;
      for (const notice of result.notices) emit(notice);
    } catch (error) {
      log.warn("telegram notice poll failed", error);
    }
  };
  poll();
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  return () => { clearInterval(timer); unsubscribe(); };
}

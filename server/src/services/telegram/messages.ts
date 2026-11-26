import type { TelegramAccess } from "@hydra/shared";
import type { RemoteGate, RemoteOverview, RemotePipeline, RemoteStep, TelegramNotice } from "../../contracts/remote.ts";
import type { InlineButton, ReplyMarkup } from "./botApi.ts";

export type BotAction =
  | { kind: "stop_run"; runId: string }
  | { kind: "play"; pipelineId: number }
  | { kind: "pause"; pipelineId: number }
  | { kind: "stop_pipeline"; pipelineId: number }
  | { kind: "answer"; promptId: number; content: string }
  | { kind: "compose"; promptId: number };

export type ActionToken = (action: BotAction, label: string) => string;
export interface ChatMessage { text: string; markup?: ReplyMarkup }

const MAX_TEXT = 3800;

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function clip(value: string, max: number): string {
  const flat = value.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function finish(lines: string[]): string {
  const text = lines.join("\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text;
}

const button = (text: string, data: string): InlineButton => ({ text: clip(text, 40), callback_data: data });
const stepLabel = (step: RemoteStep) => escapeHtml(step.key ? `${step.key} · ${step.title}` : step.title);
const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const STATE_LABEL: Record<string, string> = {
  PLAYING: "▶️ playing", WAITING_HUMAN: "✋ waiting for you", PAUSED: "⏸ paused",
  COMPLETE: "✅ complete", STOPPED: "⏹ stopped", INTERRUPTED: "⚠️ interrupted",
};

export const NAVIGATION: InlineButton[] = [
  button("🔄 Status", "v:status"), button("🧭 Pipelines", "v:pipes"), button("❓ Questions", "v:gates"),
];

export function helpMessage(access: TelegramAccess): ChatMessage {
  return {
    text: finish([
      "<b>Hydra</b>",
      "/status · running agents and pipelines",
      "/pipelines · each pipeline's current and next step",
      "/next · same as /pipelines",
      "/gates · questions agents are waiting on",
      "/cancel · drop an answer you are writing",
      "",
      access === "control"
        ? "This chat has <b>full control</b>: it can start and stop work and answer questions. Every action asks you to confirm."
        : "This chat has <b>notifications only</b>. Allow full control on Hydra's Account page to start, stop or answer from here.",
    ]),
    markup: { inline_keyboard: [NAVIGATION] },
  };
}

export function statusMessage(overview: RemoteOverview, access: TelegramAccess, action: ActionToken): ChatMessage {
  const lines = ["<b>Running agents</b>"];
  if (overview.runs.length === 0) lines.push("None right now.");
  for (const run of overview.runs) {
    lines.push(`• ${escapeHtml(clip(run.title, 80))}\n   ${escapeHtml(run.workspaceName)} · ${run.provider}${run.model ? ` (${escapeHtml(run.model)})` : ""} · ${duration(run.elapsedMs)}`);
  }
  const live = overview.pipelines.filter(pipeline => pipeline.state !== null);
  lines.push("", "<b>Pipelines</b>");
  if (live.length === 0) lines.push(overview.pipelines.length === 0 ? "No pipelines yet." : "None active. /pipelines lists them all.");
  for (const pipeline of live) lines.push(`• ${escapeHtml(pipeline.name)} · ${STATE_LABEL[pipeline.state ?? ""] ?? pipeline.state}${pipeline.current ? `\n   now: ${stepLabel(pipeline.current)}` : ""}`);
  if (overview.gates.length > 0) lines.push("", `❓ ${overview.gates.length} question${overview.gates.length === 1 ? "" : "s"} waiting for you · /gates`);
  const rows: InlineButton[][] = [];
  if (access === "control") {
    for (const run of overview.runs.slice(0, 8)) rows.push([button(`⏹ Stop ${run.title}`, action({ kind: "stop_run", runId: run.runId }, run.title))]);
  }
  rows.push(NAVIGATION);
  return { text: finish(lines), markup: { inline_keyboard: rows } };
}

function pipelineLines(pipeline: RemotePipeline): string[] {
  const state = pipeline.state === null ? "idle" : STATE_LABEL[pipeline.state] ?? pipeline.state;
  const lines = [`<b>${escapeHtml(pipeline.name)}</b> · ${escapeHtml(pipeline.workspaceName)}`, `   ${state} · ${pipeline.done}/${pipeline.total} stations done`];
  if (pipeline.currentSuite) lines.push(`   suite: ${escapeHtml(pipeline.currentSuite)}`);
  if (pipeline.current) lines.push(`   now: ${stepLabel(pipeline.current)}`);
  lines.push(`   next: ${pipeline.next ? stepLabel(pipeline.next) : pipeline.done === pipeline.total && pipeline.total > 0 ? "nothing left" : "nothing ready"}`);
  if (pipeline.waitReason && pipeline.state === "WAITING_HUMAN") lines.push(`   waiting because: ${escapeHtml(clip(pipeline.waitReason, 160))}`);
  return lines;
}

export function pipelinesMessage(overview: RemoteOverview, access: TelegramAccess, action: ActionToken): ChatMessage {
  const lines: string[] = [];
  if (overview.pipelines.length === 0) lines.push("No pipelines yet. Create one in Hydra.");
  const rows: InlineButton[][] = [];
  for (const pipeline of overview.pipelines.slice(0, 12)) {
    lines.push(...pipelineLines(pipeline), "");
    if (access !== "control") continue;
    if (pipeline.state === "PLAYING") {
      rows.push([
        button(`⏸ Pause ${pipeline.name}`, action({ kind: "pause", pipelineId: pipeline.id }, pipeline.name)),
        button("⏹ Stop", action({ kind: "stop_pipeline", pipelineId: pipeline.id }, pipeline.name)),
      ]);
    } else {
      rows.push([button(`▶️ ${pipeline.state === null ? "Play" : "Resume"} ${pipeline.name}`, action({ kind: "play", pipelineId: pipeline.id }, pipeline.name))]);
    }
  }
  if (overview.pipelines.length > 12) lines.push(`…and ${overview.pipelines.length - 12} more in Hydra.`);
  rows.push(NAVIGATION);
  return { text: finish(lines), markup: { inline_keyboard: rows } };
}

function gateLines(gate: RemoteGate): string[] {
  return [
    `<b>${escapeHtml(gate.key ? `${gate.key} · ${gate.title}` : gate.title)}</b> · ${escapeHtml(gate.workspaceName)}`,
    gate.question ? escapeHtml(clip(gate.question, 900)) : "<i>The agent left no question text.</i>",
  ];
}

export function gatesMessage(gates: RemoteGate[], access: TelegramAccess, action: ActionToken): ChatMessage {
  if (gates.length === 0) return { text: "No questions are waiting for you.", markup: { inline_keyboard: [NAVIGATION] } };
  const lines: string[] = [];
  const rows: InlineButton[][] = [];
  for (const gate of gates.slice(0, 6)) {
    lines.push(...gateLines(gate), "");
    if (access === "control") rows.push([button(`✍️ Answer ${gate.title}`, action({ kind: "compose", promptId: gate.promptId }, gate.title))]);
  }
  if (gates.length > 6) lines.push(`…and ${gates.length - 6} more in Hydra.`);
  rows.push(NAVIGATION);
  return { text: finish(lines), markup: { inline_keyboard: rows } };
}

export function noticeMessage(notice: TelegramNotice, access: TelegramAccess, action: ActionToken): ChatMessage {
  switch (notice.kind) {
    case "gate": {
      const lines = ["❓ <b>An agent needs your answer</b>", "", ...gateLines(notice.gate)];
      if (access !== "control") return { text: finish([...lines, "", "Answer it in Hydra."]) };
      return {
        text: finish([...lines, "", "Reply to this message, or tap Answer."]),
        markup: { inline_keyboard: [[button("✍️ Answer", action({ kind: "compose", promptId: notice.gate.promptId }, notice.gate.title))]] },
      };
    }
    case "pipeline_waiting":
      return {
        text: finish([`✋ <b>${escapeHtml(notice.name)}</b> is waiting for you · ${escapeHtml(notice.workspaceName)}`, ...(notice.reason ? [escapeHtml(clip(notice.reason, 300))] : [])]),
        markup: { inline_keyboard: [NAVIGATION] },
      };
    case "pipeline_ended": {
      const icon = notice.state === "COMPLETE" ? "✅" : notice.state === "STOPPED" ? "⏹" : "⚠️";
      const verb = notice.state === "COMPLETE" ? "finished" : notice.state === "STOPPED" ? "stopped" : "was interrupted";
      return { text: finish([`${icon} <b>${escapeHtml(notice.name)}</b> ${verb} · ${escapeHtml(notice.workspaceName)}`, ...(notice.reason ? [escapeHtml(clip(notice.reason, 300))] : [])]) };
    }
    case "run_failed":
      return {
        text: finish([`❌ <b>Agent failed</b>: ${escapeHtml(clip(notice.title, 120))}`, `${escapeHtml(notice.workspaceName)} · ${notice.provider}`, ...(notice.detail ? ["", escapeHtml(clip(notice.detail, 500))] : [])]),
        markup: { inline_keyboard: [NAVIGATION] },
      };
  }
}

export function confirmText(action: BotAction, label: string): string {
  const name = `<b>${escapeHtml(clip(label, 120))}</b>`;
  switch (action.kind) {
    case "stop_run": return `Stop the agent working on ${name}?`;
    case "play": return `Start ${name}? Agents will run on your machine.`;
    case "pause": return `Pause ${name}? Hydra applies your pipeline pause setting.`;
    case "stop_pipeline": return `Stop ${name}? Hydra applies your pipeline stop setting.`;
    case "answer": return `Send this answer to ${name}?\n\n<blockquote>${escapeHtml(clip(action.content, 1500))}</blockquote>`;
    case "compose": return `Answer ${name}`;
  }
}

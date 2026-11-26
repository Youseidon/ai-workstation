import type { LogItem } from "../../runs/lib/log";
import type { RunState } from "@hydra/shared";

export interface LiveConversationRun {
  runId: string;
  state: RunState;
}

export interface ConversationProgress {
  phase: "sending" | "starting" | "working" | "thinking" | "responding" | "question" | "done" | "stopped" | "error" | "recorded" | "disconnected";
  label: string;
  active: boolean;
}

export interface ConversationTurn {
  id: string;
  prompt?: Extract<LogItem, { kind: "prompt" }>;
  blocks: LogItem[];
  result?: Extract<LogItem, { kind: "result" }>;
  attribution: Pick<LogItem, "provider" | "model">;
}

/** Activity is described only when the provider actually reports it. */
export function conversationProgress(turn: ConversationTurn, live?: LiveConversationRun): ConversationProgress {
  if (turn.result) {
    const phase = turn.result.state === "done" ? "done" : turn.result.state === "interrupted" ? "stopped" : "error";
    return { phase, label: phase === "done" ? "Completed" : phase === "stopped" ? "Stopped" : "Failed", active: false };
  }
  if (!live) return { phase: "recorded", label: "Recorded exchange", active: false };
  if (turn.blocks.some(block => block.kind === "decision" && block.answers === null)) {
    return { phase: "question", label: "Needs your answer", active: true };
  }
  const latest = [...turn.blocks].reverse().find(block => block.kind === "text" || block.kind === "tool" || block.kind === "error");
  if (latest?.kind === "text") return latest.textKind === "thinking"
    ? { phase: "thinking", label: "Thinking", active: true }
    : { phase: "responding", label: "Responding", active: true };
  if (latest?.kind === "tool" && latest.result === null) return { phase: "working", label: `Running ${latest.name}`, active: true };
  if (latest?.kind === "error" && latest.fatal) return { phase: "error", label: "Failed", active: false };
  return live.state === "starting" && !latest
    ? { phase: "starting", label: "Starting agent", active: true }
    : { phase: "working", label: "Working", active: true };
}

/** A presentation projection only. Source items and normalized events remain intact. */
export function conversationTurns(items: LogItem[]): ConversationTurn[] {
  const turns = new Map<string, ConversationTurn>();
  for (const item of items) {
    let turn = turns.get(item.runId);
    if (!turn) {
      turn = { id: item.runId, blocks: [], attribution: item };
      turns.set(item.runId, turn);
    }
    if (item.kind === "prompt") turn.prompt = item;
    else if (item.kind === "result") turn.result = item;
    else turn.blocks.push(item);
  }
  for (const turn of turns.values()) {
    // Providers may repeat their last block or aggregate every message in result.
    // Compare exact text only: never guess that commentary is disposable.
    const text = turn.result?.text;
    const messages = turn.blocks.filter((b) => b.kind === "text" && b.textKind === "message");
    if (text && !messages.some((b) => b.kind === "text" && b.text === text)
      && messages.map((b) => b.kind === "text" ? b.text : "").join("\n\n") !== text) {
      turn.blocks.push({ ...turn.result!, kind: "text", id: `${turn.id}:final`, blockId: `${turn.id}:final`, text, textKind: "message" });
    }
    turn.attribution = turn.blocks.find((b) => b.kind === "text") ?? turn.result ?? turn.prompt ?? turn.attribution;
  }
  // Older pages can arrive after the live transcript. Preserve chronology
  // independently of the order in which those pages entered the store.
  const time = (turn: ConversationTurn) => turn.prompt?.timestamp || turn.blocks[0]?.timestamp || turn.result?.timestamp || "";
  return [...turns.values()].sort((left,right) => time(left).localeCompare(time(right)));
}

export function activityLabel(items: LogItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const label = /^(read|read_file|readfile)$/i.test(item.name) ? "Read files"
      : /^(bash|shell|exec_command|run_command|terminal)$/i.test(item.name) ? "Ran commands"
      : item.name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${name} (${count})`).join(" · ");
}

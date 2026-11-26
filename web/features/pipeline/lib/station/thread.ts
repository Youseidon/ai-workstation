import type { OperationsPrompt, PromptActivity } from "@hydra/shared";

export type Speaker = "agent" | "you" | "gate";

export interface ThreadEntry {
  id: string;
  at: string;
  speaker: Speaker;
  /** Short label above the bubble: "Asked", "Blocked", "Your answer", "Note"… */
  label: string;
  text: string;
  /** Bubble is waiting on the operator. */
  open?: boolean;
}

/**
 * Everything said about one item between the agent and the operator, in order:
 * blockers and decisions it asked for, approval points, your answers, the notes
 * you attached, and what it replied. Read-only history; the composer below is
 * the only place to write.
 */
export function buildThread(item: OperationsPrompt, activity: PromptActivity | null): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const remarks = activity !== null && activity.item.prompt.id === item.prompt.id ? activity.remarks : [];
  for (const remark of remarks) {
    switch (remark.kind) {
      case "BLOCKER":
        entries.push({ id: `r${remark.id}`, at: remark.createdAt, speaker: "agent", label: "Blocked — needs you", text: remark.content });
        break;
      case "DECISION_NEEDED":
        entries.push({ id: `r${remark.id}`, at: remark.createdAt, speaker: "agent", label: "Decision needed", text: remark.content });
        break;
      case "AGENT_RESPONSE":
        entries.push({ id: `r${remark.id}`, at: remark.createdAt, speaker: "agent", label: "Agent replied", text: remark.content });
        break;
      case "HUMAN_RESPONSE":
        entries.push({ id: `r${remark.id}`, at: remark.createdAt, speaker: "you", label: "Your answer", text: remark.content });
        break;
      case "OPERATOR_BRIEFING":
        entries.push({ id: `r${remark.id}`, at: remark.createdAt, speaker: "you", label: "Note for the agent", text: remark.content });
        break;
      default:
        break;
    }
  }
  const clarifications = activity !== null && activity.item.prompt.id === item.prompt.id ? activity.clarifications : [];
  for (const exchange of clarifications) {
    entries.push({ id: `cq${exchange.id}`, at: exchange.createdAt, speaker: "you", label: "You asked", text: exchange.question });
    if (exchange.answer !== null) {
      entries.push({
        id: `ca${exchange.id}`,
        at: exchange.answeredAt ?? exchange.createdAt,
        speaker: "agent",
        label: `${exchange.provider} answered`,
        text: exchange.answer,
      });
    }
  }
  const gate = item.humanIntervention;
  if (gate !== null) {
    entries.push({
      id: `g${gate.id}`,
      at: gate.requestedAt,
      speaker: "gate",
      label: "Approval point",
      text: gate.requiredAction,
      open: gate.status === "PENDING",
    });
    // The answer is normally also a HUMAN_RESPONSE remark; only add it when it is not.
    if (gate.response !== null && !entries.some((entry) => entry.speaker === "you" && entry.text === gate.response)) {
      entries.push({ id: `ga${gate.id}`, at: gate.completedAt ?? gate.requestedAt, speaker: "you", label: "Your answer", text: gate.response });
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  // The newest unanswered agent question is the one the composer answers.
  if (item.operationalState === "BLOCKED") {
    const lastAsk = [...entries].reverse().find((entry) => entry.speaker === "agent");
    const answeredAfter = lastAsk !== undefined && entries.some((entry) => entry.speaker === "you" && entry.at > lastAsk.at);
    if (lastAsk !== undefined && !answeredAfter) lastAsk.open = true;
  }
  return entries;
}

export type ComposerMode = "answer" | "note" | "closed";

export function composerMode(item: OperationsPrompt): ComposerMode {
  if (item.operationalState === "DONE" || item.operationalState === "SKIPPED") return "closed";
  if (item.humanIntervention?.status === "PENDING" || item.operationalState === "BLOCKED") return "answer";
  return "note";
}


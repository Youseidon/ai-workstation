import type { AgentInputAnswer, AgentQuestion, NormalizedEvent, ProviderId, RunMessageDelivery, RunMessageState, RunState, TokenUsage } from "@hydra/shared";

/**
 * The log is a projection of the normalized event stream: text deltas collapse
 * into one block per blockId, and tool results fold into the tool call that
 * produced them, so the panel reads like a transcript rather than a firehose.
 */
interface LogItemBase {
  id: string;
  eventIds?: string[];
  provider: ProviderId;
  /**
   * The model this entry came from, captured at the time it arrived. Held per
   * item rather than read from the current selection so scrolling back through
   * a mixed transcript still shows which model actually said what.
   */
  model: string | null;
  runId: string;
  timestamp: string;
}

/** A saved work item a run was given, so its text can be previewed on demand. */
export interface PromptWorkItem { id: number; key: string | null; title: string }

export type LogItem =
  | (LogItemBase & { kind: "context"; context: string; permissionKey: string; nativeSessionId?: string | null })
  | (LogItemBase & { kind: "prompt"; text: string; workItem?: PromptWorkItem })
  /** `/btw` traffic with a run already working: the operator's note, or the agent's reply. */
  | (LogItemBase & {
      kind: "btw";
      messageId: number;
      direction: "OPERATOR" | "AGENT";
      text: string;
      delivery: RunMessageDelivery | null;
      state: RunMessageState | null;
    })
  | (LogItemBase & {
      kind: "text";
      blockId: string;
      text: string;
      textKind: "message" | "thinking";
    })
  | (LogItemBase & {
      kind: "tool";
      toolUseId: string;
      name: string;
      summary: string;
      input: unknown;
      result: {
        isError: boolean;
        summary: string;
        output: string;
        exitCode: number | null;
      } | null;
    })
  | (LogItemBase & {
      kind: "error";
      message: string;
      detail: string | null;
      fatal: boolean;
    })
  | (LogItemBase & {
      kind: "db";
      direction: "read" | "write";
      operation: string;
      method: string;
      outcome: "accepted" | "rejected" | "replayed";
      httpStatus: number;
      summary: string;
      changed: string[];
      errorCode: string | null;
      durationMs: number;
    })
  | (LogItemBase & {
      kind: "decision";
      requestId: string;
      heading: string;
      questions: AgentQuestion[];
      answers: Record<string, AgentInputAnswer> | null;
      answeredAt: string | null;
    })
  | (LogItemBase & {
      kind: "result";
      state: Extract<RunState, "done" | "interrupted" | "error">;
      elapsedMs: number;
      usage: TokenUsage | null;
      text?: string | null;
    });

export function appendPrompt(
  items: LogItem[],
  input: {
    runId: string;
    provider: ProviderId;
    model: string | null;
    text: string;
    /** When replaying a run that started earlier, its real start time. */
    timestamp?: string;
    /** Set when the prompt was a saved work item rather than typed text. */
    workItem?: PromptWorkItem;
  },
): LogItem[] {
  return [
    ...items,
    {
      kind: "prompt",
      id: `prompt_${input.runId}`,
      provider: input.provider,
      model: input.model,
      runId: input.runId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      text: input.text,
      ...(input.workItem ? { workItem: input.workItem } : {}),
    },
  ];
}

export function applyEvent(items: LogItem[], event: NormalizedEvent): LogItem[] {
  if (items.some((item) => (item.id === event.id || item.eventIds?.includes(event.id)))) return items;
  switch (event.type) {
    case "assistant_text": {
      const { blockId, delta, text, kind } = event.payload;
      const index = findLastIndex(
        items,
        (item) => item.kind === "text" && item.blockId === blockId && item.runId === event.runId,
      );
      if (index === -1) {
        return [
          ...items,
          {
            kind: "text",
            id: event.id,
            provider: event.provider,
            model: event.model,
            runId: event.runId,
            timestamp: event.timestamp,
            blockId,
            text,
            textKind: kind,
          },
        ];
      }
      const existing = items[index] as Extract<LogItem, { kind: "text" }>;
      const next = [...items];
      next[index] = { ...existing, eventIds: [...(existing.eventIds ?? []), event.id], text: delta ? existing.text + text : text };
      return next;
    }

    case "tool_use":
      return [
        ...items,
        {
          kind: "tool",
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          toolUseId: event.payload.toolUseId,
          name: event.payload.name,
          summary: event.payload.summary,
          input: event.payload.input,
          result: null,
        },
      ];

    case "tool_result": {
      const { toolUseId, name, isError, summary, output, exitCode } = event.payload;
      const index = findLastIndex(
        items,
        (item) => item.kind === "tool" && item.toolUseId === toolUseId && item.runId === event.runId && (name === null || name === undefined || item.name === name),
      );
      const result = { isError, summary, output, exitCode };
      if (index === -1) {
        // A result with no matching call (provider restarted mid-stream, or a
        // tool we never saw start): show it as a standalone entry.
        return [
          ...items,
          {
            kind: "tool",
            id: event.id,
            provider: event.provider,
            model: event.model,
            runId: event.runId,
            timestamp: event.timestamp,
            toolUseId,
            name: name ?? "tool",
            summary: "(result without a matching call)",
            input: null,
            result,
          },
        ];
      }
      const existing = items[index] as Extract<LogItem, { kind: "tool" }>;
      const next = [...items];
      next[index] = { ...existing, eventIds: [...(existing.eventIds ?? []), event.id], result };
      return next;
    }

    case "error":
      return [
        ...items,
        {
          kind: "error",
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          message: event.payload.message,
          detail: event.payload.detail,
          fatal: event.payload.fatal,
        },
      ];

    case "result":
      return [
        ...items,
        {
          kind: "result",
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          state: event.payload.state,
          elapsedMs: event.payload.elapsedMs,
          usage: event.payload.usage,
          text: event.payload.text,
        },
      ];

    case "db_access":
      // Deliberately its own line rather than folded into the tool call that
      // made it. The operator's question is "did this agent talk to the app,
      // and what did it change" — an answer buried inside a curl's output is
      // one they would have to go looking for.
      return [
        ...items,
        {
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          kind: "db",
          direction: event.payload.direction,
          operation: event.payload.operation,
          method: event.payload.method,
          outcome: event.payload.outcome,
          httpStatus: event.payload.httpStatus,
          summary: event.payload.summary,
          changed: event.payload.changed,
          errorCode: event.payload.errorCode,
          durationMs: event.payload.durationMs,
        },
      ];

    case "status":
      if (event.payload.conversation) return [...items, { id: event.id, runId: event.runId, provider: event.provider, model: event.model, timestamp: event.timestamp, kind: "context", ...event.payload.conversation }];
      // Status drives the status bar only; it would drown the transcript.
      return items;

    case "input_request":
      return [
        ...items,
        {
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          kind: "decision",
          requestId: event.payload.requestId,
          heading: event.payload.heading,
          questions: event.payload.questions,
          answers: null,
          answeredAt: null,
        },
      ];

    case "operator_message": {
      // The same message is announced again when its state changes (queued →
      // delivered); update the bubble rather than adding a second one.
      const index = findLastIndex(
        items,
        (item) => item.kind === "btw" && item.runId === event.runId && item.direction === "OPERATOR" && item.messageId === event.payload.messageId,
      );
      if (index !== -1) {
        const next = [...items];
        const existing = items[index] as Extract<LogItem, { kind: "btw" }>;
        next[index] = { ...existing, eventIds: [...(existing.eventIds ?? []), event.id], delivery: event.payload.delivery, state: event.payload.state };
        return next;
      }
      return [
        ...items,
        {
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          kind: "btw",
          messageId: event.payload.messageId,
          direction: "OPERATOR",
          text: event.payload.text,
          delivery: event.payload.delivery,
          state: event.payload.state,
        },
      ];
    }

    case "agent_message":
      return [
        ...items,
        {
          id: event.id,
          provider: event.provider,
          model: event.model,
          runId: event.runId,
          timestamp: event.timestamp,
          kind: "btw",
          messageId: event.payload.messageId,
          direction: "AGENT",
          text: event.payload.text,
          delivery: null,
          state: null,
        },
      ];

    case "input_response": {
      const index = findLastIndex(
        items,
        (item) => item.kind === "decision"
          && item.runId === event.runId
          && item.requestId === event.payload.requestId,
      );
      if (index === -1) return items;
      const next = [...items];
      const decision = items[index] as Extract<LogItem, { kind: "decision" }>;
      next[index] = { ...decision, eventIds: [...(decision.eventIds ?? []), event.id], answers: event.payload.answers, answeredAt: event.timestamp };
      return next;
    }
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

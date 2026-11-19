import type { AdapterEvent, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import { runCommand } from "../lib/process.ts";
import type { StreamChannel, StreamMapper } from "./spawnAdapter.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

export interface CodexStreamOptions {
  prompt: string;
  cwd: string;
  model: string | null;
  sandbox: string;
  effort: string;
  resumeSessionId?: string | null;
  requireGit?: boolean;
  startupTimeoutMs?: number;
  apiKey?: string;
}

/** One App Server connection owns exactly one turn; it never replays old turns. */
export class CodexStreamMapper implements StreamMapper {
  settled = false;
  private channel?: StreamChannel;
  private timer?: NodeJS.Timeout;
  private threadId = "";
  private turnId = "";
  private turnRequested = false;
  private interrupted = false;
  private disposed = false;
  private threadRequested = false;
  private initialized = false;
  private usage: TokenUsage | null = null;
  private usageBaseline?: Record<string, number>;
  private lastText: string | null = null;
  private readonly texts = new Map<string, string>();
  private readonly tools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private steerSequence = 0;
  private readonly steers = new Map<string, (accepted: boolean) => void>();

  constructor(private readonly options: CodexStreamOptions) {}

  start(channel: StreamChannel): void {
    this.channel = channel;
    this.timer = setTimeout(() => channel.fail(new Error("Codex App Server timed out during initialization")), this.options.startupTimeoutMs ?? 30_000);
    void this.initialize().catch(error => channel.fail(error));
  }

  private async initialize(): Promise<void> {
    if (this.options.requireGit) {
      const result = await runCommand("git", ["-C", this.options.cwd, "rev-parse", "--is-inside-work-tree"], 5_000);
      if (result.code !== 0) throw new Error("Codex requires a git repository. Enable ‘Allow running outside a git repo’ for this workspace.");
    }
    if (this.interrupted || this.disposed) return;
    this.channel?.send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_console", title: "Agent Console", version: "0.1.0" } } });
  }

  map(value: unknown): AdapterEvent[] {
    if (this.settled || this.disposed) return [];
    const message = record(value);
    // `turn/steer` answers. A refused steer (the turn just ended, say) is not
    // a failed run; the operator's note falls back to the inbox instead.
    if (typeof message.id === "string" && this.steers.has(message.id)) {
      const resolve = this.steers.get(message.id)!;
      this.steers.delete(message.id);
      resolve(message.error === undefined);
      return [];
    }
    if (message.error && message.id !== undefined) {
      // A turn may finish while Stop is in flight; its terminal notification
      // remains authoritative, with the process deadline as a backstop.
      if (message.id === 4) return [];
      throw new Error(`Codex ${message.id === 1 ? "initialization" : message.id === 5 ? "API-key authentication" : "request"} failed: ${string(record(message.error).message)}`);
    }
    if (this.interrupted && !this.turnRequested) return this.complete("interrupted");
    if (message.method && message.id !== undefined) {
      // Never let an unhandled provider request stall a headless run or grant
      // additional access. The caller's explicit sandbox remains authoritative.
      this.channel?.send({ id: message.id, error: { code: -32601, message: "Interactive requests are not supported by this connection" } });
      return [{ type: "error", payload: { message: `Codex requested unsupported interaction: ${string(message.method)}`, fatal: true } }, ...this.complete("error")];
    }
    if (message.id === 1) {
      if (this.initialized) return [];
      this.initialized = true;
      this.channel?.send({ method: "initialized", params: {} });
      if (this.options.apiKey) this.channel?.send({ id: 5, method: "account/login/start", params: { type: "apiKey", apiKey: this.options.apiKey } });
      else this.requestThread();
      return [];
    }
    if (message.id === 5 && this.options.apiKey && this.initialized) {
      this.requestThread();
      return [];
    }
    if (message.id === 2) {
      if (this.turnRequested) return [];
      this.threadId = string(record(record(message.result).thread).id);
      if (!this.threadId) throw new Error("Codex returned no thread ID");
      this.turnRequested = true;
      this.channel?.send({ id: 3, method: "turn/start", params: {
        threadId: this.threadId, cwd: this.options.cwd, model: this.options.model, effort: this.options.effort,
        approvalPolicy: "never",
        // Use the resolved policy from this start/resume response, including
        // configured workspace roots/network settings. Consults stay read-only.
        sandboxPolicy: this.options.sandbox === "read-only" ? this.sandboxPolicy() : record(message.result).sandbox ?? this.sandboxPolicy(),
        input: [{ type: "text", text: this.options.prompt, text_elements: [] }],
      } });
      return [{ type: "status", payload: { state: "running", sessionId: this.threadId, detail: "Waiting for Codex response" } }];
    }
    if (message.id === 3) {
      this.turnId ||= string(record(record(message.result).turn).id);
      if (!this.turnId) throw new Error("Codex returned no turn ID");
      clearTimeout(this.timer);
      if (this.interrupted) this.interrupt();
      return [];
    }
    const params = record(message.params);
    if (!this.turnRequested || params.threadId !== this.threadId) return [];
    if (message.method === "turn/started") {
      const id = string(record(params.turn).id);
      if (!id) throw new Error("Codex started a turn without an ID");
      if (this.turnId && id !== this.turnId) return [];
      this.turnId = id;
      clearTimeout(this.timer);
      if (this.interrupted) this.interrupt();
      return [];
    }
    if (!this.turnId) return [];
    const incomingTurn = string(params.turnId) || string(record(params.turn).id);
    if (this.turnId && incomingTurn && incomingTurn !== this.turnId) return [];
    switch (message.method) {
      case "item/agentMessage/delta":
        return this.text(string(params.itemId), string(params.delta), "message", true);
      case "item/reasoning/summaryTextDelta":
        return this.text(`${string(params.itemId)}:summary:${number(params.summaryIndex)}`, string(params.delta), "thinking", true);
      case "item/reasoning/textDelta":
        return this.text(`${string(params.itemId)}:content:${number(params.contentIndex)}`, string(params.delta), "thinking", true);
      case "item/started":
      case "item/completed":
        return this.item(record(params.item), message.method === "item/completed");
      case "thread/tokenUsage/updated": {
        const usage = record(params.tokenUsage);
        const total = record(usage.total);
        const last = record(usage.last);
        const keys = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"];
        this.usageBaseline ??= Object.fromEntries(keys.map(key => [key, Math.max(0, number(total[key]) - number(last[key]))]));
        const count = (key: string) => Math.max(0, number(total[key]) - (this.usageBaseline?.[key] ?? 0));
        this.usage = { inputTokens: count("inputTokens"), outputTokens: count("outputTokens"), cachedInputTokens: count("cachedInputTokens"), reasoningOutputTokens: count("reasoningOutputTokens"), totalTokens: count("inputTokens") + count("outputTokens") };
        return [{ type: "status", payload: { state: "running", usage: this.usage } }];
      }
      case "error":
        return [{ type: "error", payload: { message: string(record(params.error).message) || "Codex reported an error", fatal: params.willRetry !== true } }];
      case "turn/completed": {
        const turn = record(params.turn);
        const state = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "error" : "done";
        const events: AdapterEvent[] = [];
        // Completion can contain a final-only item or a corrected snapshot.
        if (Array.isArray(turn.items)) for (const item of turn.items) events.push(...this.item(record(item), true));
        if (turn.error) events.push({ type: "error", payload: { message: string(record(turn.error).message) || "Codex turn failed", fatal: true } });
        return [...events, ...this.complete(state)];
      }
      default: return [];
    }
  }

  private requestThread(): void {
    if (this.threadRequested) return;
    this.threadRequested = true;
    this.channel?.send({ id: 2, method: this.options.resumeSessionId ? "thread/resume" : "thread/start", params: {
      ...(this.options.resumeSessionId ? { threadId: this.options.resumeSessionId } : {}),
      cwd: this.options.cwd, model: this.options.model, sandbox: this.options.sandbox, approvalPolicy: "never",
    } });
  }

  private sandboxPolicy(): Record<string, unknown> {
    if (this.options.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
    if (this.options.sandbox === "read-only") return { type: "readOnly", networkAccess: false };
    return { type: "workspaceWrite", writableRoots: [this.options.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }

  private text(blockId: string, text: string, kind: "message" | "thinking", delta: boolean): AdapterEvent[] {
    if (!blockId || !text) return [];
    const previous = this.texts.get(blockId) ?? "";
    const next = delta ? previous + text : text;
    if (next === previous) return [];
    this.texts.set(blockId, next);
    if (kind === "message") this.lastText = next;
    return [{ type: "assistant_text", payload: { blockId, text, kind, delta } }];
  }

  private item(item: Record<string, unknown>, completed: boolean): AdapterEvent[] {
    const id = string(item.id);
    if (!id) return [];
    if (item.type === "agentMessage") return this.text(id, string(item.text), "message", false);
    if (item.type === "reasoning") {
      const events: AdapterEvent[] = [];
      for (const key of ["summary", "content"] as const) if (Array.isArray(item[key])) {
        item[key].forEach((text, index) => events.push(...this.text(`${id}:${key}:${index}`, string(text), "thinking", false)));
      }
      return events;
    }
    if (["userMessage", "hookPrompt", "functionCallOutput"].includes(string(item.type))) return [];
    const name = item.type === "commandExecution" ? "shell" : item.type === "fileChange" ? "apply_patch" : item.type === "mcpToolCall" ? `${string(item.server)}.${string(item.tool)}` : string(item.type) || "tool";
    const events: AdapterEvent[] = [];
    if (!this.tools.has(id)) {
      this.tools.add(id);
      events.push({ type: "tool_use", payload: { toolUseId: id, name, summary: oneLine(string(item.command) || JSON.stringify(item.arguments ?? item.changes ?? item)), input: item.arguments ?? (item.command ? { command: item.command } : item) } });
    }
    if (completed && !this.completedTools.has(id)) {
      this.completedTools.add(id);
      const output = string(item.aggregatedOutput) || JSON.stringify(item.result ?? item.error ?? item.changes ?? item);
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const isError = item.status === "failed" || item.status === "declined" || !!item.error || exitCode !== null && exitCode !== 0;
      events.push({ type: "tool_result", payload: { toolUseId: id, name, output, exitCode, isError, summary: oneLine(output) } });
    }
    return events;
  }

  private complete(state: "done" | "interrupted" | "error"): AdapterEvent[] {
    this.settled = true;
    this.settleSteers();
    clearTimeout(this.timer);
    return [{ type: "result", payload: { state, usage: this.usage, text: this.lastText, exitCode: state === "done" ? 0 : null } }];
  }

  interrupt(): boolean {
    this.interrupted = true;
    if (!this.turnId || !this.threadId) return false;
    this.channel?.send({ id: 4, method: "turn/interrupt", params: { threadId: this.threadId, turnId: this.turnId } });
    return true;
  }

  /**
   * `/btw` into the active turn. `expectedTurnId` makes the server refuse it
   * if the turn has already moved on, rather than starting a new one — a new
   * turn after `turn/completed` is a run this mapper would never settle.
   */
  steer(text: string): Promise<boolean> {
    if (this.settled || this.disposed || this.interrupted || !this.threadId || !this.turnId || this.channel === undefined) return Promise.resolve(false);
    const id = `steer-${(this.steerSequence += 1)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { if (this.steers.delete(id)) resolve(false); }, 10_000);
      this.steers.set(id, (accepted) => { clearTimeout(timer); resolve(accepted); });
      try {
        this.channel!.send({ id, method: "turn/steer", params: {
          threadId: this.threadId, expectedTurnId: this.turnId,
          input: [{ type: "text", text, text_elements: [] }],
        } });
      } catch {
        clearTimeout(timer);
        this.steers.delete(id);
        resolve(false);
      }
    });
  }

  finish(): AdapterEvent[] { this.settleSteers(); return []; }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.settleSteers(); this.channel = undefined; }

  private settleSteers(): void {
    for (const resolve of this.steers.values()) resolve(false);
    this.steers.clear();
  }
}

import { randomBytes } from "node:crypto";
import type { AdapterEvent } from "@hydra/shared";
import { SseDecoder } from "./sse.ts";
import type { StreamChannel, StreamMapper } from "../adapters/spawnAdapter.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";

export interface KiloStreamOptions {
  prompt: string;
  cwd: string;
  password: string;
  agent: "plan" | "code";
  autoApprove: boolean;
  model: string | null;
  variant: string;
  resumeSessionId?: string | null;
  startupTimeoutMs?: number;
}

interface PartState { part: Record<string, unknown>; text: string; }

export class KiloStreamMapper implements StreamMapper {
  settled = false;
  private channel?: StreamChannel;
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private url = "";
  private sessionId = "";
  private started = false;
  private interrupted = false;
  private disposed = false;
  private sawActivity = false;
  private readonly messageId = `msg_${Date.now().toString(16)}${randomBytes(8).toString("hex")}`;
  private readonly assistantMessages = new Set<string>();
  private readonly parts = new Map<string, PartState>();
  private readonly seen = new Set<string>();
  private readonly steps = new Set<string>();

  constructor(private readonly options: KiloStreamOptions, private readonly mapper: StreamMapper) {}

  start(channel: StreamChannel): void {
    this.channel = channel;
    this.timer = setTimeout(() => channel.fail(new Error("Kilo streaming server timed out during initialization")), this.options.startupTimeoutMs ?? 30_000);
  }

  line(line: string): void {
    if (this.url) return;
    const match = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)\b/.exec(line);
    if (!match) return;
    this.url = match[1]!;
    void this.connect().catch(error => { if (!this.disposed && !this.settled) this.channel?.fail(error); });
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetch(`${this.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(this.options.cwd)}`, {
      method, signal: this.abort.signal,
      headers: { Authorization: `Basic ${Buffer.from(`kilo:${this.options.password}`).toString("base64")}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Kilo ${path.split("?")[0]} failed (HTTP ${response.status})`);
    return response;
  }

  private async connect(): Promise<void> {
    if (this.interrupted || this.disposed) return;
    const stream = await this.request("/event");
    if (!stream.body) throw new Error("Kilo returned no event stream");
    void this.read(stream.body).catch(error => { if (!this.disposed && !this.settled) this.channel?.fail(error); });
    if (this.options.resumeSessionId) {
      await this.request(`/session/${encodeURIComponent(this.options.resumeSessionId)}`);
      this.sessionId = this.options.resumeSessionId;
    } else {
      const response = await this.request("/session", "POST", {});
      this.sessionId = string(record(await response.json()).id);
      if (!this.sessionId) throw new Error("Kilo returned no session ID");
    }
    this.channel?.emit({ type: "status", payload: { state: "running", sessionId: this.sessionId, detail: "Waiting for Kilo response" } });
    if (this.interrupted || this.disposed || this.settled) return;
    this.started = true;
    const model = this.options.model;
    const separator = model?.indexOf("/") ?? -1;
    if (model && separator <= 0) throw new Error("Kilo model must use provider/model format");
    await this.request(`/session/${encodeURIComponent(this.sessionId)}/prompt_async`, "POST", {
      messageID: this.messageId, agent: this.options.agent, variant: this.options.variant,
      ...(model ? { model: { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) } } : {}),
      parts: [{ type: "text", text: this.options.prompt }],
    });
    clearTimeout(this.timer);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    try {
      while (!this.disposed && !this.settled) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of sse.push(decoder.decode(value, { stream: true }))) {
          const events = this.map(JSON.parse(frame.data));
          for (const event of events) this.channel?.emit(event);
          if (this.settled) break;
        }
      }
      if (!this.disposed && !this.settled) throw new Error("Kilo event stream closed before the reply completed. Partial output is retained; the prompt was not retried.");
    } finally { reader.releaseLock(); }
  }

  map(value: unknown): AdapterEvent[] {
    if (this.settled || !this.started) return [];
    const event = record(value);
    const properties = record(event.properties);
    const info = record(properties.info);
    const part = record(properties.part);
    const sessionId = string(properties.sessionID) || string(info.sessionID) || string(part.sessionID);
    if (sessionId !== this.sessionId) return [];
    const id = string(event.id);
    if (id && this.seen.has(id)) return [];
    if (id) this.seen.add(id);
    if (event.type === "message.updated") {
      if (info.role !== "assistant" || info.parentID !== this.messageId) return [];
      this.assistantMessages.add(string(info.id));
      this.sawActivity = true;
      const events: AdapterEvent[] = [];
      for (const state of this.parts.values()) if (state.part.messageID === info.id) events.push(...this.emitPart(state));
      if (info.error) events.push(...this.error(info.error));
      return events;
    }
    if (event.type === "message.part.updated") {
      const partId = string(part.id);
      if (!partId) return [];
      const previous = this.parts.get(partId);
      const state = { part, text: typeof part.text === "string" ? part.text || (!previous?.part.type ? previous?.text ?? "" : "") : previous?.text ?? "" };
      this.parts.set(partId, state);
      return this.emitPart(state);
    }
    if (event.type === "message.part.delta" && properties.field === "text") {
      const partId = string(properties.partID);
      const state = this.parts.get(partId) ?? { part: { id: partId, messageID: properties.messageID }, text: "" };
      const delta = string(properties.delta);
      state.text += delta;
      this.parts.set(partId, state);
      if (!this.assistantMessages.has(string(state.part.messageID)) || !["text", "reasoning"].includes(string(state.part.type))) return [];
      this.sawActivity = true;
      return this.mapper.map({ type: state.part.type === "reasoning" ? "reasoning_delta" : "text_delta", sessionID: this.sessionId, part: { ...state.part, text: delta } });
    }
    if (event.type === "session.status" && record(properties.status).type === "busy") this.sawActivity = true;
    if ((event.type === "session.idle" || event.type === "session.status" && record(properties.status).type === "idle") && this.sawActivity) return this.complete();
    if (event.type === "session.error") return this.error(properties.error);
    if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
      const requestId = string(properties.id);
      const allow = this.options.autoApprove && this.options.agent === "code" && !this.interrupted;
      void this.request(`/permission/${encodeURIComponent(requestId)}/reply`, "POST", { reply: allow ? "once" : "reject" }).catch(error => { if (!this.disposed) this.channel?.fail(error); });
      return allow ? [] : [{ type: "error", payload: { message: "Kilo requested a permission that was not pre-approved", detail: string(properties.permission) || string(properties.action), fatal: false } }];
    }
    if (event.type === "question.asked") {
      void this.request(`/question/${encodeURIComponent(string(properties.id))}/reject`, "POST").catch(error => { if (!this.disposed) this.channel?.fail(error); });
      return [{ type: "error", payload: { message: "Kilo requested interactive input; ask a follow-up with your answer", detail: JSON.stringify(properties.questions), fatal: false } }];
    }
    return [];
  }

  private emitPart(state: PartState): AdapterEvent[] {
    const part = state.part;
    if (!this.assistantMessages.has(string(part.messageID))) return [];
    if (part.type === "text" || part.type === "reasoning") {
      return this.mapper.map({ type: part.type, sessionID: this.sessionId, part: { ...part, text: state.text } });
    }
    if (part.type === "tool") return this.mapper.map({ type: "tool_use", sessionID: this.sessionId, part });
    if (part.type === "step-finish" && !this.steps.has(string(part.id))) {
      this.steps.add(string(part.id));
      return this.mapper.map({ type: "step_finish", sessionID: this.sessionId, part });
    }
    return [];
  }

  private error(error: unknown): AdapterEvent[] {
    if (this.interrupted && record(error).name === "MessageAbortedError") return this.complete();
    this.settled = true;
    clearTimeout(this.timer);
    return this.mapper.map({ type: "error", sessionID: this.sessionId, error });
  }

  private complete(): AdapterEvent[] {
    this.settled = true;
    clearTimeout(this.timer);
    return this.mapper.finish(0, null).map(event => event.type === "result" && this.interrupted ? { ...event, payload: { ...event.payload, state: "interrupted" } } : event);
  }

  interrupt(): boolean {
    this.interrupted = true;
    if (!this.sessionId || !this.started) return false;
    void this.request(`/session/${encodeURIComponent(this.sessionId)}/abort`, "POST").catch(error => { if (!this.disposed) this.channel?.fail(error); });
    return true;
  }
  finish(): AdapterEvent[] { return []; }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.abort.abort(); }
}

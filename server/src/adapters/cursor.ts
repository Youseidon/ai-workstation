import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import {
  cursorAuthJsonPath,
  cursorLoginPresent,
  fetchCursorDashboard,
  refreshCursorAccessToken,
  resolveCursorAccessToken,
} from "../lib/cursorAuth.ts";
import { describeEffectiveAccess, effectiveCursorForce, settings } from "../settings.ts";
import {
  parseCursorPeriodUsage,
  parseCursorPlanName,
  providerUsageOk,
  providerUsageUnavailable,
} from "./accountUsage.ts";
import { SpawnAdapter, type SpawnSpec, type StreamMapper } from "./spawnAdapter.ts";
import type { RunOptions } from "./types.ts";

/*
 * `cursor-agent -p --output-format stream-json` emits a Claude-Code-shaped JSON
 * stream. Cursor's flags and payloads move between releases, so this mapper is
 * deliberately tolerant: it understands both the streaming envelope
 * (`{"type":"assistant","message":{...}}`) and a single final object from
 * `--output-format json`, and ignores event types it does not recognise.
 * Verify with `cursor-agent --help` — see README.
 */

interface CursorContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { id?: string; role?: string; content?: CursorContentBlock[] | string };
  result?: unknown;
  is_error?: boolean;
  error?: { message?: string } | string;
  usage?: Record<string, number> | null;
  // Current Cursor versions nest calls by tool kind (for example,
  // `tool_call.readToolCall.args`). Older versions used this flat shape.
  tool_call?: Record<string, unknown>;
  call_id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
}

interface ParsedToolCall {
  id?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export function cursorAgentArgs(input: {
  prompt: string;
  outputFormat: string;
  force: boolean;
  model: string | null;
  extraArgs: string[];
  /** Continue this chat instead of opening a new one. */
  resumeSessionId?: string | null;
}): string[] {
  const args = ["-p", "--output-format", input.outputFormat];
  // `--resume [chatId]` takes an *optional* value, so the id has to be attached
  // with `=`; passed as a separate argv entry it is read as the prompt and a
  // session picker opens instead. Verified against cursor-agent 2026.09.02.
  if (typeof input.resumeSessionId === "string" && input.resumeSessionId !== "") {
    args.push(`--resume=${input.resumeSessionId}`);
  }
  if (input.force) args.push("--force");
  if (input.model !== null) args.push("--model", input.model);
  args.push(...input.extraArgs, input.prompt);
  return args;
}

function toUsage(raw: Record<string, number> | null | undefined): TokenUsage | null {
  if (!raw) return null;
  const inputTokens = raw.input_tokens ?? raw.inputTokens ?? 0;
  const outputTokens = raw.output_tokens ?? raw.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? 0,
    reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const block = entry as CursorContentBlock;
        if (typeof block.text === "string") return block.text;
        return JSON.stringify(entry);
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content, null, 2);
}

export class CursorMapper implements StreamMapper {
  settled = false;
  private usage: TokenUsage | null = null;
  private lastText: string | null = null;
  private blockCounter = 0;
  private readonly toolNames = new Map<string, string>();

  map(value: unknown): AdapterEvent[] {
    const event = value as CursorEvent;
    switch (event.type) {
      case "system":
        // `session_id` is Cursor's chat id, and it arrives on the first line —
        // which is what makes a wrap-up turn possible after a budget stop kills
        // the process long before any result event.
        return [{
          type: "status",
          payload: {
            state: "running",
            detail: event.model ? `model ${event.model}` : (event.subtype ?? "session started"),
            sessionId: event.session_id ?? null,
          },
        }];
      case "assistant":
        return this.mapAssistant(event);
      case "user":
        return this.mapUser(event);
      case "tool_call":
        return this.mapFlatToolCall(event, event.subtype === "completed" ? "result" : "start");
      case "tool_use":
        return this.mapFlatToolCall(event, "start");
      case "tool_result":
        return this.mapFlatToolCall(event, "result");
      case "result": {
        this.usage = toUsage(event.usage) ?? this.usage;
        this.settled = true;
        const failed = event.is_error === true || event.subtype === "error";
        const text = typeof event.result === "string" ? event.result : this.lastText;
        const events: AdapterEvent[] = [];
        if (failed) {
          events.push({
            type: "error",
            payload: { message: text ?? "cursor-agent reported an error", fatal: true },
          });
        }
        events.push({
          type: "result",
          payload: {
            state: failed ? "error" : "done",
            usage: this.usage,
            text,
            exitCode: failed ? null : 0,
          },
        });
        return events;
      }
      case "error": {
        const message = typeof event.error === "string"
          ? event.error
          : event.error?.message ?? "cursor-agent reported an error";
        return [{ type: "error", payload: { message, fatal: false } }];
      }
      default:
        return [];
    }
  }

  private mapAssistant(event: CursorEvent): AdapterEvent[] {
    const content = event.message?.content;
    if (typeof content === "string") return [this.textEvent(event, content)];
    if (!Array.isArray(content)) return [];

    const events: AdapterEvent[] = [];
    content.forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        events.push(this.textEvent(event, block.text, index));
      } else if (block.type === "thinking" && typeof block.text === "string") {
        events.push(this.textEvent(event, block.text, index, "thinking"));
      } else if (block.type === "tool_use") {
        const toolUseId = block.id ?? `cursor_tool_${this.blockCounter++}`;
        const name = block.name ?? "tool";
        this.toolNames.set(toolUseId, name);
        events.push({
          type: "tool_use",
          payload: {
            toolUseId,
            name,
            summary: oneLine(JSON.stringify(block.input ?? {})),
            input: block.input ?? {},
          },
        });
      }
    });
    return events;
  }

  private textEvent(
    event: CursorEvent,
    text: string,
    index = 0,
    kind: "message" | "thinking" = "message",
  ): AdapterEvent {
    if (kind === "message") this.lastText = text;
    const blockId = `${event.message?.id ?? event.session_id ?? "cursor"}:${index}`;
    return {
      type: "assistant_text",
      // stream-json assistant events are incremental chunks. They share a
      // session block id and must be concatenated to reconstruct the response.
      payload: { blockId, delta: true, text, kind },
    };
  }

  private mapUser(event: CursorEvent): AdapterEvent[] {
    const content = event.message?.content;
    if (!Array.isArray(content)) return [];
    const events: AdapterEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id ?? `cursor_tool_${this.blockCounter++}`;
      const output = stringifyContent(block.content);
      events.push({
        type: "tool_result",
        payload: {
          toolUseId,
          name: this.toolNames.get(toolUseId) ?? null,
          isError: block.is_error === true,
          summary: oneLine(output || "completed"),
          output,
          exitCode: null,
        },
      });
    }
    return events;
  }

  private mapFlatToolCall(event: CursorEvent, phase: "start" | "result"): AdapterEvent[] {
    const raw = parseToolCall(event.tool_call) ?? {
      id: event.call_id,
      name: event.name,
      input: event.input,
      output: event.output,
    };
    const toolUseId = raw.id ?? event.call_id ?? `cursor_tool_${this.blockCounter++}`;
    const name = raw.name ?? "tool";
    if (phase === "start") {
      this.toolNames.set(toolUseId, name);
      return [{
        type: "tool_use",
        payload: {
          toolUseId,
          name,
          summary: oneLine(JSON.stringify(raw.input ?? {})),
          input: raw.input ?? {},
        },
      }];
    }
    const output = stringifyContent(raw.output ?? event.output);
    return [{
      type: "tool_result",
      payload: {
        toolUseId,
        name: this.toolNames.get(toolUseId) ?? name,
        isError: raw.isError === true || event.is_error === true || event.status === "failed",
        summary: oneLine(output || "completed"),
        output,
        exitCode: null,
      },
    }];
  }

  finish(): AdapterEvent[] {
    return [];
  }
}

/** Normalize both Cursor's nested stream-json envelope and its legacy flat one. */
function parseToolCall(value: Record<string, unknown> | undefined): ParsedToolCall | null {
  if (!value) return null;

  if ("name" in value || "input" in value || "output" in value || "id" in value) {
    return {
      id: typeof value.id === "string" ? value.id : undefined,
      name: typeof value.name === "string" ? value.name : undefined,
      input: value.input,
      output: value.output,
    };
  }

  for (const [kind, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const result = isRecord(candidate.result) ? candidate.result : null;
    const failed = result !== null && ("error" in result || "failure" in result);
    const output = result === null
      ? undefined
      : result.success ?? result.error ?? result.failure ?? result;
    return {
      name: kind.replace(/ToolCall$/, "") || kind,
      input: candidate.args,
      output,
      isError: failed,
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CursorAdapter extends SpawnAdapter {
  readonly id = "cursor" as const;
  readonly label = "Cursor CLI";
  /** Headless cursor-agent does not reliably report usage; never invent it. */
  readonly reportsTokens = false;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(
      effectiveCursorForce() ? "force (non-interactive)" : "interactive approval",
    );
  }
  get model(): string | null {
    return settings.cursor.model;
  }
  protected get binaryName(): string {
    return settings.cursor.binary;
  }

  protected missingBinaryReason(): string {
    return `\`${settings.cursor.binary}\` not found on PATH — install from https://cursor.com/cli`;
  }

  protected async checkAuth(): Promise<string | null> {
    if (process.env.CURSOR_API_KEY) return null;
    if (settings.cursor.assumeAuthenticated) return null;
    const markers = [
      cursorAuthJsonPath(),
      join(homedir(), ".cursor", "cli-config.json"),
      join(homedir(), ".cursor", "cli.json"),
      join(homedir(), ".config", "cursor-agent"),
      join(homedir(), ".local", "share", "cursor-agent"),
    ];
    if (markers.some((marker) => existsSync(marker))) return null;
    if (cursorLoginPresent()) return null;
    return "No Cursor login detected — run `cursor-agent login` (or set CURSOR_ASSUME_AUTHENTICATED=true)";
  }

  override async getAccountUsage(): Promise<ProviderUsage> {
    const token = await resolveCursorAccessToken();
    if (token === null) {
      return providerUsageUnavailable(
        "cursor",
        process.env.CURSOR_API_KEY
          ? "Cursor plan usage is only available for a `cursor-agent login` session, not an API key"
          : "No Cursor login found — run `cursor-agent login`",
      );
    }

    let accessToken = token;
    let response = await fetchCursorDashboard("GetCurrentPeriodUsage", accessToken);
    if (response.status === 401 || response.status === 403) {
      const refreshed = await refreshCursorAccessToken();
      if (refreshed === null) {
        return providerUsageUnavailable("cursor", "Cursor login expired — run `cursor-agent login`");
      }
      accessToken = refreshed;
      response = await fetchCursorDashboard("GetCurrentPeriodUsage", accessToken);
    }
    if (!response.ok) {
      return providerUsageUnavailable(
        "cursor",
        response.status === 429
          ? "Cursor usage endpoint rate-limited — try again shortly"
          : `Cursor usage request failed (HTTP ${response.status})`,
      );
    }

    const parsed = parseCursorPeriodUsage(response.body);
    // Cursor's dashboard API is billing-cycle only — parseCursorPeriodUsage
    // already maps that single cycle and does not invent extra windows.

    let plan: string | null = null;
    const planResponse = await fetchCursorDashboard("GetPlanInfo", accessToken);
    if (planResponse.ok) plan = parseCursorPlanName(planResponse.body);

    return providerUsageOk("cursor", { ...parsed, plan });
  }

  override async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
    if (opts.permissionOverride !== "inherit") {
      throw new Error("Cursor cannot run as a consult; it has no sandbox.");
    }
    yield* super.run(prompt, opts);
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const model = opts.model ?? settings.cursor.model;
    const resumeSessionId = opts.resumeSessionId ?? null;
    return {
      args: cursorAgentArgs({
        prompt,
        outputFormat: settings.cursor.outputFormat,
        force: effectiveCursorForce(),
        model,
        extraArgs: settings.cursor.extraArgs,
        resumeSessionId,
      }),
      ...(resumeSessionId === null ? {} : { sessionId: resumeSessionId }),
    };
  }

  protected createMapper(): StreamMapper {
    return new CursorMapper();
  }
}

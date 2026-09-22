import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import {
  describeEffectiveAccess,
  effectiveGrokPermissionMode,
  effectiveGrokSandboxMode,
  settings,
} from "../settings.ts";
import {
  fetchJson,
  parseGrokCredits,
  providerUsageOk,
  providerUsageUnavailable,
  writeJsonAtomic,
} from "./accountUsage.ts";
import { SpawnAdapter, type SpawnSpec, type StreamMapper } from "./spawnAdapter.ts";
import type { RunOptions } from "./types.ts";

/*
 * `grok -p --output-format streaming-json` emits NDJSON derived from ACP session
 * updates. Verified against grok 1.0.5; see README for how to re-check flags.
 *
 *   {"type":"thought","data":"..."}
 *   {"type":"tool_call","toolCallId":"call_1","toolName":"list_dir","status":"pending",...}
 *   {"type":"tool_call_update","toolCallId":"call_1","status":null}   // progress, ignore
 *   {"type":"tool_call_update","toolCallId":"call_1","status":"completed","rawOutput":{...}}
 *   {"type":"text","data":"..."}
 *   {"type":"usage","usage":{"input_tokens":812,"output_tokens":45,...}}
 *   {"type":"end","stopReason":"end_turn","usage":{...}}
 *
 * `--output-format json` is a single final object (`text`, `stopReason`, `usage`)
 * and is accepted as a fallback. Unknown event types are ignored.
 */

interface GrokUsage {
  input_tokens?: number;
  inputTokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  reasoning_tokens?: number;
  reasoningOutputTokens?: number;
  total_tokens?: number;
}

interface GrokEvent {
  type?: string;
  subtype?: string;
  data?: unknown;
  text?: unknown;
  thought?: unknown;
  toolCallId?: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  message?: unknown;
  result?: unknown;
  is_error?: boolean;
  error?: { message?: string } | string;
  usage?: GrokUsage | null;
  stopReason?: string;
  stop_reason?: string;
  sessionId?: string;
}

// grok 1.0.5 emits `pending` on tool_call and `status: null` on in-flight updates.
const TERMINAL_TOOL_STATUS = new Set(["completed", "failed", "cancelled", "error", "success"]);

function toUsage(raw: GrokUsage | null | undefined): TokenUsage | null {
  if (!raw) return null;
  const uncached = raw.input_tokens ?? raw.inputTokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0;
  const cacheCreate = raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0;
  const outputTokens = raw.output_tokens ?? raw.outputTokens ?? 0;
  const reasoning = raw.reasoning_tokens ?? raw.reasoningOutputTokens ?? 0;
  if (uncached === 0 && cacheRead === 0 && cacheCreate === 0 && outputTokens === 0) return null;
  // Match Claude: inputTokens is all prompt tokens processed, cached share kept separate.
  const inputTokens = uncached + cacheRead + cacheCreate;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cacheRead,
    reasoningOutputTokens: reasoning,
    totalTokens: inputTokens + outputTokens,
  };
}

function accumulate(base: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (next === null) return base;
  if (base === null) return next;
  const inputTokens = base.inputTokens + next.inputTokens;
  const outputTokens = base.outputTokens + next.outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: base.cachedInputTokens + next.cachedInputTokens,
    reasoningOutputTokens: base.reasoningOutputTokens + next.reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarizeToolInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  switch (name) {
    case "run_terminal_cmd":
    case "run_terminal_command":
      return oneLine(pick("command") ?? pick("cmd") ?? "");
    case "read_file":
    case "search_replace":
    case "write":
      return oneLine(pick("path") ?? pick("file_path") ?? pick("target_file") ?? "");
    case "grep":
      return oneLine([pick("pattern"), pick("path")].filter(Boolean).join("  in  "));
    case "list_dir":
      return oneLine(pick("path") ?? pick("target_directory") ?? "");
    case "web_search":
      return oneLine(pick("query") ?? "");
    case "web_fetch":
      return oneLine(pick("url") ?? "");
    default:
      return oneLine(JSON.stringify(record));
  }
}

class GrokMapper implements StreamMapper {
  settled = false;
  private usage: TokenUsage | null = null;
  private lastText: string | null = null;
  private textBlockSeq = 0;
  private thinkingBlockSeq = 0;
  private currentTextBlock: string | null = null;
  private currentThinkingBlock: string | null = null;
  private readonly openTools = new Set<string>();
  private readonly completedTools = new Set<string>();

  map(value: unknown): AdapterEvent[] {
    const event = value as GrokEvent;
    switch (event.type) {
      case "text":
        return this.mapText(asText(event.data) || asText(event.text), "message");
      case "thought":
        return this.mapText(asText(event.data) || asText(event.thought), "thinking");
      case "tool_call":
        return this.mapTool(event, true);
      case "tool_call_update":
        return this.mapTool(event, false);
      case "usage": {
        this.usage = accumulate(this.usage, toUsage(event.usage));
        this.closeTextBlocks();
        if (this.usage === null) return [];
        return [{ type: "status", payload: { state: "running", usage: this.usage, detail: "usage" } }];
      }
      case "end":
        return this.finishRun(event);
      case "error":
        return this.mapError(event, true);
      case "result":
        // streaming-messages-json terminal line; treat like `end`.
        return this.finishRun(event);
      case "system":
        return [{
          type: "status",
          payload: {
            state: "running",
            detail: event.subtype ?? "session started",
          },
        }];
      case undefined:
      case "":
        // `--output-format json` is one object with `text` / `stopReason` / `usage`.
        if (event.text !== undefined || event.stopReason !== undefined || event.sessionId !== undefined) {
          return this.finishRun(event);
        }
        return [];
      default:
        return [];
    }
  }

  finish(): AdapterEvent[] {
    return [];
  }

  private mapText(text: string, kind: "message" | "thinking"): AdapterEvent[] {
    if (text === "") return [];
    if (kind === "message") {
      this.currentThinkingBlock = null;
      const first = this.currentTextBlock === null;
      if (first) {
        this.textBlockSeq += 1;
        this.currentTextBlock = `grok-text-${this.textBlockSeq}`;
        this.lastText = text;
      } else {
        this.lastText = (this.lastText ?? "") + text;
      }
      const blockId = this.currentTextBlock ?? `grok-text-${this.textBlockSeq}`;
      return [{
        type: "assistant_text",
        payload: { blockId, delta: !first, text, kind },
      }];
    }
    this.currentTextBlock = null;
    const first = this.currentThinkingBlock === null;
    if (first) {
      this.thinkingBlockSeq += 1;
      this.currentThinkingBlock = `grok-thought-${this.thinkingBlockSeq}`;
    }
    const blockId = this.currentThinkingBlock ?? `grok-thought-${this.thinkingBlockSeq}`;
    return [{
      type: "assistant_text",
      payload: { blockId, delta: !first, text, kind },
    }];
  }

  private closeTextBlocks(): void {
    this.currentTextBlock = null;
    this.currentThinkingBlock = null;
  }

  private mapTool(event: GrokEvent, isStart: boolean): AdapterEvent[] {
    this.closeTextBlocks();
    const toolUseId = event.toolCallId ?? `grok_tool_${this.openTools.size}`;
    const name = event.toolName ?? event.title ?? event.kind ?? "tool";
    const events: AdapterEvent[] = [];

    if (isStart || !this.openTools.has(toolUseId)) {
      this.openTools.add(toolUseId);
      events.push({
        type: "tool_use",
        payload: {
          toolUseId,
          name,
          summary: summarizeToolInput(name, event.rawInput) || oneLine(event.title ?? name),
          input: event.rawInput ?? {},
        },
      });
    }

    const status = event.status ?? "";
    if (TERMINAL_TOOL_STATUS.has(status) && !this.completedTools.has(toolUseId)) {
      this.completedTools.add(toolUseId);
      const output = stringifyOutput(event.rawOutput ?? event.content);
      const isError = status === "failed" || status === "error" || event.is_error === true;
      events.push({
        type: "tool_result",
        payload: {
          toolUseId,
          name,
          isError,
          summary: oneLine(output || (isError ? "failed" : "completed")),
          output,
          exitCode: isError ? 1 : 0,
        },
      });
    }

    return events;
  }

  private mapError(event: GrokEvent, fatal: boolean): AdapterEvent[] {
    const message = typeof event.error === "string"
      ? event.error
      : event.error?.message ?? (asText(event.message) || asText(event.data) || "grok reported an error");
    const events: AdapterEvent[] = [
      { type: "error", payload: { message, fatal } },
    ];
    if (fatal && !this.settled) {
      this.settled = true;
      events.push({
        type: "result",
        payload: { state: "error", usage: toUsage(event.usage) ?? this.usage, exitCode: 1 },
      });
    }
    return events;
  }

  private finishRun(event: GrokEvent): AdapterEvent[] {
    if (this.settled) return [];
    this.settled = true;
    this.usage = toUsage(event.usage) ?? this.usage;
    const stop = event.stopReason ?? event.stop_reason ?? "";
    const failed = event.is_error === true
      || event.subtype === "error"
      || event.type === "error"
      || stop === "error";
    const interrupted = stop === "cancelled";
    const text = asText(event.text) || asText(event.result) || this.lastText;
    const events: AdapterEvent[] = [];
    if (failed) {
      events.push({
        type: "error",
        payload: { message: text || "grok reported an error", fatal: true },
      });
    }
    events.push({
      type: "result",
      payload: {
        state: failed ? "error" : interrupted ? "interrupted" : "done",
        usage: this.usage,
        text: text || null,
        exitCode: failed ? 1 : 0,
      },
    });
    return events;
  }
}

export class GrokAdapter extends SpawnAdapter {
  readonly id = "grok" as const;
  readonly label = "Grok CLI";
  readonly reportsTokens = true;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(
      `${effectiveGrokPermissionMode()} · sandbox: ${effectiveGrokSandboxMode()}`,
    );
  }
  get model(): string | null {
    return settings.grok.model;
  }
  protected get binaryName(): string {
    return settings.grok.binary;
  }

  protected missingBinaryReason(): string {
    return `\`${settings.grok.binary}\` not found on PATH — install from https://x.ai/cli`;
  }

  protected async checkAuth(): Promise<string | null> {
    if (settings.grok.apiKey !== null) return null;
    if (settings.grok.assumeAuthenticated) return null;
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const grokHome = process.env.GROK_HOME ?? join(homedir(), ".grok");
    if (existsSync(join(grokHome, "auth.json"))) return null;
    return "No XAI_API_KEY and no stored grok login — run `grok login` (or set GROK_ASSUME_AUTHENTICATED=true)";
  }

  override async getAccountUsage(): Promise<ProviderUsage> {
    const token = await resolveGrokAccessToken();
    if (token === null) {
      return providerUsageUnavailable(
        "grok",
        settings.grok.apiKey !== null
          ? "Grok plan usage is only available for a `grok login` session, not an API key"
          : "No Grok login found — run `grok login`",
      );
    }
    let accessToken = token;
    const headers = grokBillingHeaders(accessToken);
    let response = await fetchJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers });
    if (response.status === 401 || response.status === 403) {
      const refreshed = await refreshGrokAccessToken();
      if (refreshed === null) {
        return providerUsageUnavailable("grok", "Grok login expired — run `grok login`");
      }
      accessToken = refreshed;
      response = await fetchJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        headers: grokBillingHeaders(accessToken),
      });
    }
    if (!response.ok) {
      return providerUsageUnavailable("grok", `Grok billing request failed (HTTP ${response.status})`);
    }
    const parsed = parseGrokCredits(response.body);
    // Grok's credits API is weekly (or legacy monthly). It does not report a
    // daily window; skip rather than invent one from local session logs.
    parsed.windows = parsed.windows.filter((window) => window.kind !== "daily");
    if (parsed.plan === null) {
      const settingsResponse = await fetchJson("https://cli-chat-proxy.grok.com/v1/settings", {
        headers: grokBillingHeaders(accessToken),
      });
      const body = settingsResponse.body as { subscription_tier_display?: string; subscriptionTierDisplay?: string } | null;
      parsed.plan = body?.subscription_tier_display ?? body?.subscriptionTierDisplay ?? null;
    }
    return providerUsageOk("grok", parsed);
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const consult = opts.permissionOverride !== "inherit";
    // grok only names its session in the terminal `end`/`result` line, which is
    // exactly the line a budget-stopped run never emits. `--session-id` lets us
    // name it ourselves instead, so the id exists before the first tool call.
    // Verified against grok 1.0.13 (`grok --help`): `-s, --session-id` sets the
    // UUID of a *new* conversation, `-r, --resume` continues an existing one,
    // and the two must not be combined without `--fork-session`.
    const resumeSessionId = opts.resumeSessionId ?? null;
    const sessionId = resumeSessionId ?? randomUUID();
    const args = [
      "--output-format", "streaming-json",
      "--cwd", opts.cwd,
      "--permission-mode", consult ? "plan" : effectiveGrokPermissionMode(),
      "--sandbox", consult ? "workspace" : effectiveGrokSandboxMode(),
      // An optional-value flag, so the id has to be attached with `=`.
      ...(resumeSessionId === null ? ["--session-id", sessionId] : [`--resume=${resumeSessionId}`]),
    ];
    const model = opts.model ?? settings.grok.model;
    if (model !== null) args.push("-m", model);
    if (settings.grok.maxTurns !== null) args.push("--max-turns", String(settings.grok.maxTurns));
    args.push(...settings.grok.extraArgs);
    // `-p` takes the prompt as its argument. Headless grok does not read stdin
    // into the prompt (unlike `codex exec -`).
    args.push("-p", prompt);
    const env: NodeJS.ProcessEnv = {};
    if (settings.grok.apiKey !== null) env.XAI_API_KEY = settings.grok.apiKey;
    return { args, env: Object.keys(env).length > 0 ? env : undefined, sessionId };
  }

  protected createMapper(): StreamMapper {
    return new GrokMapper();
  }
}

const GROK_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

interface GrokAuthEntry {
  slot: string;
  key: string;
  refreshToken: string | null;
  expiresAt: string | null;
  clientId: string;
  issuer: string;
}

function grokAuthPath(): string {
  const grokHome = process.env.GROK_HOME ?? join(homedir(), ".grok");
  return join(grokHome, "auth.json");
}

function grokBillingHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "x-xai-token-auth": "xai-grok-cli",
    "User-Agent": "xai-grok-cli",
  };
}

function readGrokAuth(): { file: Record<string, unknown>; entry: GrokAuthEntry } | null {
  const path = grokAuthPath();
  if (!existsSync(path)) return null;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [slot, raw] of Object.entries(file)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (key === "") continue;
      return {
        file,
        entry: {
          slot,
          key,
          refreshToken: typeof entry.refresh_token === "string" ? entry.refresh_token : null,
          expiresAt: typeof entry.expires_at === "string" ? entry.expires_at : null,
          clientId: typeof entry.oidc_client_id === "string" ? entry.oidc_client_id : GROK_DEFAULT_CLIENT_ID,
          issuer: typeof entry.oidc_issuer === "string" ? entry.oidc_issuer : "https://auth.x.ai",
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveGrokAccessToken(): Promise<string | null> {
  const auth = readGrokAuth();
  if (auth === null) return null;
  const expiresAt = auth.entry.expiresAt !== null ? Date.parse(auth.entry.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt < Date.now() + 60_000) {
    return (await refreshGrokAccessToken()) ?? auth.entry.key;
  }
  return auth.entry.key;
}

async function refreshGrokAccessToken(): Promise<string | null> {
  const auth = readGrokAuth();
  if (auth?.entry.refreshToken == null || auth.entry.refreshToken === "") return null;
  const tokenUrl = `${auth.entry.issuer.replace(/\/$/, "")}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.entry.refreshToken,
    client_id: auth.entry.clientId,
  });
  const response = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!response.ok || response.body === null || typeof response.body !== "object") return null;
  const payload = response.body as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (accessToken === "") return null;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 6 * 60 * 60;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : auth.entry.refreshToken;
  persistGrokAuth(auth.file, auth.entry.slot, {
    key: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  return accessToken;
}

function persistGrokAuth(file: Record<string, unknown>, slot: string, patch: Record<string, string>): void {
  const current = (file[slot] ?? {}) as Record<string, unknown>;
  file[slot] = { ...current, ...patch };
  try {
    writeJsonAtomic(grokAuthPath(), file);
  } catch {
    // Keep the in-memory token for this request even if the write fails.
  }
}

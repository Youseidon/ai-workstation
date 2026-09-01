import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { mergeUsage, oneLine } from "@agent-console/shared";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  describeEffectiveAccess,
  effectiveClaudePermissionMode,
  hostUnixSockets,
  settings,
} from "../settings.ts";
import { fetchJson, parseClaudeUsage, providerUsageOk, providerUsageUnavailable, writeJsonAtomic } from "./accountUsage.ts";
import type { AgentAdapter, AvailabilityReport, PermissionOverride, RunOptions } from "./types.ts";

export const CLAUDE_CONSULT_DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
] as const;

/** Per-run Claude permission flags. */
export function claudePermissionConfig(override: PermissionOverride): {
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  disableSandboxForHostAccess: boolean;
  disallowedTools: string[] | undefined;
} {
  if (override !== "inherit") {
    return {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: false,
      disableSandboxForHostAccess: false,
      disallowedTools: [...CLAUDE_CONSULT_DISALLOWED_TOOLS],
    };
  }
  const permissionMode = effectiveClaudePermissionMode();
  return {
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    disableSandboxForHostAccess: settings.hostAccess,
    disallowedTools: undefined,
  };
}

/*
 * Claude Code runs in-process through the Agent SDK's async generator — there is
 * no CLI to spawn. The prompt is supplied as an async iterable (streaming input
 * mode) because `Query.interrupt()` is only available in that mode.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/*
 * The Anthropic API reports cache reads/writes separately from `input_tokens`,
 * while Codex folds them in. `inputTokens` is normalized to "all input tokens
 * processed" so the counter in the status bar means the same thing whichever
 * provider is running; `cachedInputTokens` keeps the cached share visible.
 */
function toUsage(raw: RawUsage | undefined): TokenUsage | null {
  if (!raw) return null;
  const cached = raw.cache_read_input_tokens ?? 0;
  const inputTokens = (raw.input_tokens ?? 0) + cached + (raw.cache_creation_input_tokens ?? 0);
  const outputTokens = raw.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function accumulate(base: TokenUsage | null, raw: RawUsage | undefined): TokenUsage | null {
  const next = toUsage(raw);
  if (next === null) return base;
  if (base === null) return next;
  const inputTokens = base.inputTokens + next.inputTokens;
  const outputTokens = base.outputTokens + next.outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: base.cachedInputTokens + next.cachedInputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const block = entry as ContentBlock;
        return typeof block.text === "string" ? block.text : JSON.stringify(entry);
      })
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content, null, 2);
}

/** A one-line description of a tool call, mirroring Claude Code's own summaries. */
function summarizeToolInput(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  switch (name) {
    case "Bash":
      return oneLine(pick("command") ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return oneLine(pick("file_path") ?? pick("notebook_path") ?? "");
    case "Glob":
    case "Grep":
      return oneLine([pick("pattern"), pick("path")].filter(Boolean).join("  in  "));
    case "WebFetch":
      return oneLine(pick("url") ?? "");
    case "Task":
      return oneLine(pick("description") ?? "");
    default:
      return oneLine(JSON.stringify(record));
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly label = "Claude Code";
  readonly transport = "sdk" as const;
  readonly reportsTokens = true;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(effectiveClaudePermissionMode());
  }
  get model(): string | null {
    return settings.claude.model;
  }

  private readonly queries = new Map<string, Query>();

  async checkAvailability(): Promise<AvailabilityReport> {
    const version = await this.getVersion();
    if (settings.claude.apiKey !== null || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { available: true, reason: null, version, binary: null };
    }
    // A Claude Code subscription login also authenticates the SDK.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    if (existsSync(join(configDir, ".credentials.json"))) {
      return { available: true, reason: null, version, binary: null };
    }
    return {
      available: false,
      reason: "ANTHROPIC_API_KEY not set and no Claude Code login found — set the key or run `claude` once to log in",
      version,
      binary: null,
    };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  async getVersion(): Promise<string | null> {
    try {
      const require = createRequire(import.meta.url);
      const pkg = require("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
      return pkg.version ? `agent-sdk ${pkg.version}` : null;
    } catch {
      return null;
    }
  }

  async getAccountUsage(): Promise<ProviderUsage> {
    const token = await resolveClaudeOAuthToken();
    if (token === null) {
      return providerUsageUnavailable(
        "claude",
        settings.claude.apiKey !== null
          ? "Claude plan usage is only available for a Claude Code login, not an API key"
          : "No Claude Code login found — run `claude` once to sign in",
      );
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.0",
    };
    let response = await fetchJson("https://api.anthropic.com/api/oauth/usage", { headers });
    if (response.status === 401) {
      const refreshed = await refreshClaudeOAuthToken();
      if (refreshed === null) {
        return providerUsageUnavailable("claude", "Claude login expired — run `claude` to sign in again");
      }
      response = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
        headers: { ...headers, Authorization: `Bearer ${refreshed}` },
      });
    }
    if (!response.ok) {
      return providerUsageUnavailable(
        "claude",
        response.status === 429
          ? "Claude usage endpoint rate-limited — try again shortly"
          : `Claude usage request failed (HTTP ${response.status})`,
      );
    }
    const parsed = parseClaudeUsage(response.body);
    return providerUsageOk("claude", parsed);
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (opts.signal.aborted) abortController.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const permission = claudePermissionConfig(opts.permissionOverride);
    const options: Options = {
      cwd: opts.cwd,
      abortController,
      includePartialMessages: true,
      permissionMode: permission.permissionMode as Options["permissionMode"],
      settingSources: settings.claude.settingSources as Options["settingSources"],
      stderr: (data: string) => opts.log.debug(`stderr: ${data.trimEnd()}`),
    };
    if (permission.allowDangerouslySkipPermissions) {
      options.allowDangerouslySkipPermissions = true;
    }
    if (permission.disallowedTools !== undefined) {
      (options as Options & { disallowedTools?: string[] }).disallowedTools = permission.disallowedTools;
    }
    if (permission.disableSandboxForHostAccess) {
      const sockets = hostUnixSockets();
      options.sandbox = {
        enabled: false,
        allowUnsandboxedCommands: true,
        network: {
          allowUnixSockets: sockets,
          allowAllUnixSockets: true,
        },
      };
    }
    const model = opts.model ?? settings.claude.model;
    if (model !== null) options.model = model;
    if (settings.claude.maxTurns !== null) options.maxTurns = settings.claude.maxTurns;
    if (settings.claude.apiKey !== null) {
      options.env = { ...process.env, ANTHROPIC_API_KEY: settings.claude.apiKey };
    }

    // Streaming input mode: one message, then the iterable ends and the turn runs.
    async function* promptStream(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
      } as SDKUserMessage;
    }

    let session: Query;
    try {
      session = query({ prompt: promptStream(), options });
    } catch (error) {
      opts.signal.removeEventListener("abort", onAbort);
      yield {
        type: "error",
        payload: { message: "Failed to start Claude Code session", fatal: true, detail: describe(error) },
      };
      return;
    }

    this.queries.set(opts.runId, session);

    let usage: TokenUsage | null = null;
    let lastText: string | null = null;
    let currentMessageId = "message";
    const streamedBlocks = new Set<string>();
    let settled = false;

    try {
      for await (const message of session as AsyncGenerator<SDKMessage, void>) {
        for (const event of this.mapMessage(message, {
          get usage() {
            return usage;
          },
          setUsage: (next) => {
            usage = next;
          },
          setText: (text) => {
            lastText = text;
          },
          getText: () => lastText,
          getMessageId: () => currentMessageId,
          setMessageId: (id) => {
            currentMessageId = id;
          },
          streamedBlocks,
          isSettled: () => settled,
          markSettled: () => {
            settled = true;
          },
        })) {
          yield event;
        }
      }

      if (!settled) {
        yield {
          type: "result",
          payload: {
            state: opts.signal.aborted ? "interrupted" : "done",
            usage,
            text: lastText,
            exitCode: null,
          },
        };
      }
    } catch (error) {
      if (opts.signal.aborted || isAbortError(error)) {
        yield { type: "result", payload: { state: "interrupted", usage, text: lastText, exitCode: null } };
      } else {
        yield {
          type: "error",
          payload: { message: "Claude Code run failed", fatal: true, detail: describe(error) },
        };
        yield { type: "result", payload: { state: "error", usage, text: lastText, exitCode: null } };
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      this.queries.delete(opts.runId);
    }
  }

  private *mapMessage(message: SDKMessage, state: MapperState): Generator<AdapterEvent> {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          yield {
            type: "status",
            payload: {
              state: "running",
              detail: `${message.model} · ${message.tools.length} tools · ${message.permissionMode}`,
            },
          };
        }
        return;
      }

      case "stream_event": {
        const event = message.event as { type?: string; index?: number; message?: { id?: string }; delta?: { type?: string; text?: string; thinking?: string } };
        if (event.type === "message_start" && event.message?.id) {
          state.setMessageId(event.message.id);
          return;
        }
        if (event.type !== "content_block_delta" || event.delta === undefined) return;
        const blockId = `${state.getMessageId()}:${event.index ?? 0}`;
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          state.streamedBlocks.add(blockId);
          yield {
            type: "assistant_text",
            payload: { blockId, delta: true, text: event.delta.text, kind: "message" },
          };
        } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
          state.streamedBlocks.add(blockId);
          yield {
            type: "assistant_text",
            payload: { blockId, delta: true, text: event.delta.thinking, kind: "thinking" },
          };
        }
        return;
      }

      case "assistant": {
        const apiMessage = message.message as unknown as { id?: string; content?: ContentBlock[]; usage?: RawUsage };
        state.setUsage(accumulate(state.usage, apiMessage.usage));
        const messageId = apiMessage.id ?? state.getMessageId();
        const blocks = Array.isArray(apiMessage.content) ? apiMessage.content : [];
        for (const [index, block] of blocks.entries()) {
          const blockId = `${messageId}:${index}`;
          if (block.type === "text" || block.type === "thinking") {
            const text = block.type === "text" ? block.text : block.thinking;
            if (typeof text !== "string" || text === "") continue;
            if (block.type === "text") state.setText(text);
            // Skip blocks already delivered as deltas — the browser has them.
            if (state.streamedBlocks.has(blockId)) continue;
            yield {
              type: "assistant_text",
              payload: {
                blockId,
                delta: false,
                text,
                kind: block.type === "thinking" ? "thinking" : "message",
              },
            };
          } else if (block.type === "tool_use") {
            const name = block.name ?? "tool";
            yield {
              type: "tool_use",
              payload: {
                toolUseId: block.id ?? `${messageId}:${index}`,
                name,
                summary: summarizeToolInput(name, block.input),
                input: block.input ?? {},
              },
            };
          }
        }
        if (state.usage !== null) {
          yield { type: "status", payload: { state: "running", usage: state.usage, detail: "usage" } };
        }
        if (message.error) {
          yield {
            type: "error",
            payload: { message: `Claude reported: ${message.error}`, fatal: false, detail: null },
          };
        }
        return;
      }

      case "user": {
        const apiMessage = message.message as unknown as { content?: ContentBlock[] | string };
        const blocks = Array.isArray(apiMessage.content) ? apiMessage.content : [];
        for (const block of blocks) {
          if (block.type !== "tool_result") continue;
          const output = stringifyContent(block.content);
          yield {
            type: "tool_result",
            payload: {
              toolUseId: block.tool_use_id ?? "unknown",
              name: null,
              isError: block.is_error === true,
              summary: oneLine(output || "completed"),
              output,
              exitCode: null,
            },
          };
        }
        return;
      }

      case "tool_progress": {
        yield {
          type: "status",
          payload: {
            state: "running",
            detail: `${message.tool_name} running ${Math.round(message.elapsed_time_seconds)}s`,
          },
        };
        return;
      }

      case "result": {
        if (state.isSettled()) return;
        state.markSettled();
        const finalUsage = mergeUsage(state.usage, toUsage(message.usage as RawUsage));
        state.setUsage(finalUsage);
        if (message.subtype !== "success") {
          const detail = "errors" in message && Array.isArray(message.errors)
            ? message.errors.join("\n")
            : null;
          yield {
            type: "error",
            payload: { message: `Claude Code ended: ${message.subtype}`, fatal: true, detail },
          };
          yield {
            type: "result",
            payload: { state: "error", usage: finalUsage, text: state.getText(), exitCode: null },
          };
          return;
        }
        yield {
          type: "result",
          payload: {
            state: "done",
            usage: finalUsage,
            text: typeof message.result === "string" ? message.result : state.getText(),
            exitCode: null,
          },
        };
        return;
      }

      default:
        return;
    }
  }

  async interrupt(runId: string): Promise<void> {
    const session = this.queries.get(runId);
    if (!session) return;
    try {
      // The control request can hang if the CLI is mid-tool; the runner's
      // abort signal is the backstop, so give up quickly either way.
      await Promise.race([
        session.interrupt(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt timed out")), 1500)),
      ]);
    } catch {
      // Fall through: the run's AbortController will tear the session down.
    }
  }
}

interface MapperState {
  readonly usage: TokenUsage | null;
  setUsage(next: TokenUsage | null): void;
  setText(text: string): void;
  getText(): string | null;
  getMessageId(): string;
  setMessageId(id: string): void;
  streamedBlocks: Set<string>;
  isSettled(): boolean;
  markSettled(): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

function claudeCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

function readClaudeOAuth(): ClaudeOAuth | null {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (env) return { accessToken: env, refreshToken: null, expiresAt: null };
  const path = claudeCredentialsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    const accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
    if (accessToken === "") return null;
    return {
      accessToken,
      refreshToken: typeof oauth?.refreshToken === "string" ? oauth.refreshToken : null,
      expiresAt: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : null,
    };
  } catch {
    return null;
  }
}

async function resolveClaudeOAuthToken(): Promise<string | null> {
  const oauth = readClaudeOAuth();
  if (oauth === null) return null;
  if (oauth.expiresAt !== null && oauth.expiresAt < Date.now() + 60_000) {
    return (await refreshClaudeOAuthToken()) ?? oauth.accessToken;
  }
  return oauth.accessToken;
}

async function refreshClaudeOAuthToken(): Promise<string | null> {
  const oauth = readClaudeOAuth();
  if (oauth?.refreshToken == null || oauth.refreshToken === "") return null;
  const response = await fetchJson("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok || response.body === null || typeof response.body !== "object") return null;
  const body = response.body as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (accessToken === "") return null;
  persistClaudeOAuth({
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : oauth.refreshToken,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : Date.now() + 8 * 60 * 60 * 1000,
  });
  return accessToken;
}

function persistClaudeOAuth(next: ClaudeOAuth): void {
  const path = claudeCredentialsPath();
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const current = (parsed.claudeAiOauth ?? {}) as Record<string, unknown>;
    parsed.claudeAiOauth = {
      ...current,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? current.refreshToken,
      expiresAt: next.expiresAt ?? current.expiresAt,
    };
    writeJsonAtomic(path, parsed);
  } catch {
    // A failed write leaves the previous file in place; the in-memory token still works this request.
  }
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import { runCommand } from "../lib/process.ts";
import { describeEffectiveAccess, effectiveCopilotPermissionMode, settings } from "../settings.ts";
import {
  fetchJson,
  parseCopilotQuota,
  providerUsageOk,
  providerUsageUnavailable,
} from "./accountUsage.ts";
import { SpawnAdapter, type SpawnSpec, type StreamMapper } from "./spawnAdapter.ts";
import type { RunOptions } from "./types.ts";

/*
 * `copilot -p <prompt> --output-format json` emits NDJSON, one envelope per
 * line: `{"type":"<domain>.<event>","data":{...},"id":...,"timestamp":...}`.
 * Verified against GitHub Copilot CLI 1.0.82; see README for how to re-check.
 *
 *   {"type":"assistant.message_start","data":{"messageId":"…","phase":"final_answer"}}
 *   {"type":"assistant.message_delta","data":{"messageId":"…","deltaContent":"DONE"}}
 *   {"type":"assistant.message","data":{"messageId":"…","content":"DONE","toolRequests":[…]}}
 *   {"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"bash","arguments":{…}}}
 *   {"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"…"}}}
 *   {"type":"model.model_call_success","data":{"responseUsage":{"prompt_tokens":…}}}
 *   {"type":"result","exitCode":0,"sessionId":"…","usage":{"premiumRequests":1,…}}
 *
 * Two shapes to watch: `result` carries its fields at the top level rather than
 * under `data`, and a custom tool (`apply_patch`) sends `arguments` as a raw
 * string instead of an object. Unknown event types are ignored — the CLI emits
 * a lot of session/model telemetry this UI has no use for.
 */

interface CopilotResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

interface CopilotEvent {
  type?: string;
  data?: {
    messageId?: string;
    phase?: string;
    content?: unknown;
    deltaContent?: unknown;
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
    result?: { content?: unknown; detailedContent?: unknown } | null;
    error?: { message?: string; code?: string } | string | null;
    message?: unknown;
    responseUsage?: CopilotResponseUsage | null;
    totalPremiumRequests?: number;
  } | null;
  // `result` is the one envelope that is flat.
  exitCode?: number | null;
  sessionId?: string;
  usage?: { premiumRequests?: number } | null;
}

function toUsage(raw: CopilotResponseUsage | null | undefined): TokenUsage | null {
  if (!raw) return null;
  // `prompt_tokens` already includes the cached share, matching our convention.
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  const cachedInputTokens = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningOutputTokens = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Each model call is billed in full, so per-call usage accumulates across turns. */
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

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

/** `apply_patch` sends a patch string; every other tool sends an object. */
function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === "string") {
    // "*** Begin Patch\n*** Add File: notes.txt\n…" — the second line names the file.
    const fileLine = input.split("\n").find((line) => line.startsWith("*** ") && line.includes(": "));
    return oneLine(fileLine?.replace(/^\*\*\* /, "") ?? input);
  }
  const record = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  switch (name) {
    case "bash":
    case "shell":
      return oneLine(pick("command") ?? "");
    case "view":
    case "read":
    case "create":
    case "write":
    case "str_replace":
      return oneLine(pick("path") ?? pick("file_path") ?? "");
    case "grep":
    case "search":
      return oneLine([pick("pattern") ?? pick("query"), pick("path")].filter(Boolean).join("  in  "));
    case "glob":
      return oneLine(pick("pattern") ?? "");
    case "sql":
      return oneLine(pick("description") ?? pick("query") ?? "");
    case "fetch":
    case "web_fetch":
      return oneLine(pick("url") ?? "");
    default:
      return oneLine(pick("description") ?? JSON.stringify(record));
  }
}

export class CopilotMapper implements StreamMapper {
  settled = false;
  private usage: TokenUsage | null = null;
  private lastText: string | null = null;
  /** Message ids that already emitted a delta, so `assistant.message` is a no-op. */
  private readonly streamed = new Set<string>();
  /** Tool name by call id: only `tool.execution_start` carries one. */
  private readonly openTools = new Map<string, string>();
  private readonly closedTools = new Set<string>();

  map(value: unknown): AdapterEvent[] {
    const event = value as CopilotEvent;
    const data = event.data ?? {};
    switch (event.type) {
      case "assistant.message_delta":
        return this.mapDelta(data.messageId, asText(data.deltaContent), data.phase);
      case "assistant.message":
        return this.mapMessage(data.messageId, asText(data.content), data.phase);
      case "tool.execution_start":
        return this.mapToolStart(data);
      case "tool.execution_complete":
        return this.mapToolComplete(data);
      case "model.model_call_success": {
        this.usage = accumulate(this.usage, toUsage(data.responseUsage));
        if (this.usage === null) return [];
        return [{ type: "status", payload: { state: "running", usage: this.usage, detail: "usage" } }];
      }
      case "session.usage_checkpoint": {
        const premium = data.totalPremiumRequests;
        if (typeof premium !== "number" || premium <= 0) return [];
        return [{
          type: "status",
          payload: {
            state: "running",
            detail: `${premium} premium request${premium === 1 ? "" : "s"}`,
          },
        }];
      }
      case "error":
        return this.mapError(data);
      case "result":
        return this.finishRun(event);
      default:
        return [];
    }
  }

  finish(): AdapterEvent[] {
    return [];
  }

  private blockKind(phase: string | undefined): "message" | "thinking" {
    // Observed phases: "commentary" and "final_answer"; reasoning is opt-in via
    // --enable-reasoning-summaries and arrives under its own phase name.
    return /reason|think/i.test(phase ?? "") ? "thinking" : "message";
  }

  private mapDelta(messageId: string | undefined, text: string, phase: string | undefined): AdapterEvent[] {
    if (messageId === undefined || text === "") return [];
    const first = !this.streamed.has(messageId);
    this.streamed.add(messageId);
    const kind = this.blockKind(phase);
    if (kind === "message") this.lastText = first ? text : (this.lastText ?? "") + text;
    return [{
      type: "assistant_text",
      payload: { blockId: `copilot-msg-${messageId}`, delta: !first, text, kind },
    }];
  }

  /**
   * The terminal form of a message. When it streamed, the deltas already said
   * everything — only its `content` is kept, as the run's final answer.
   */
  private mapMessage(messageId: string | undefined, text: string, phase: string | undefined): AdapterEvent[] {
    if (messageId === undefined || text === "") return [];
    const kind = this.blockKind(phase);
    if (kind === "message") this.lastText = text;
    if (this.streamed.has(messageId)) return [];
    this.streamed.add(messageId);
    return [{
      type: "assistant_text",
      payload: { blockId: `copilot-msg-${messageId}`, delta: false, text, kind },
    }];
  }

  private mapToolStart(data: NonNullable<CopilotEvent["data"]>): AdapterEvent[] {
    const toolUseId = data.toolCallId ?? `copilot_tool_${this.openTools.size}`;
    if (this.openTools.has(toolUseId)) return [];
    const name = data.toolName ?? "tool";
    this.openTools.set(toolUseId, name);
    return [{
      type: "tool_use",
      payload: {
        toolUseId,
        name,
        summary: summarizeToolInput(name, data.arguments) || name,
        input: data.arguments ?? {},
      },
    }];
  }

  private mapToolComplete(data: NonNullable<CopilotEvent["data"]>): AdapterEvent[] {
    const toolUseId = data.toolCallId ?? "";
    if (toolUseId === "" || this.closedTools.has(toolUseId)) return [];
    this.closedTools.add(toolUseId);
    const isError = data.success === false;
    const failure = typeof data.error === "string" ? data.error : (data.error?.message ?? null);
    const output = isError
      ? (failure ?? "tool call failed")
      : stringifyOutput(data.result?.content ?? data.result?.detailedContent);
    return [{
      type: "tool_result",
      payload: {
        toolUseId,
        name: data.toolName ?? this.openTools.get(toolUseId) ?? null,
        isError,
        summary: oneLine(output || (isError ? "failed" : "completed")),
        output,
        exitCode: isError ? 1 : 0,
      },
    }];
  }

  private mapError(data: NonNullable<CopilotEvent["data"]>): AdapterEvent[] {
    const message = typeof data.error === "string"
      ? data.error
      : data.error?.message ?? (asText(data.message) || "copilot reported an error");
    const events: AdapterEvent[] = [{ type: "error", payload: { message, fatal: true } }];
    if (!this.settled) {
      this.settled = true;
      events.push({ type: "result", payload: { state: "error", usage: this.usage, exitCode: 1 } });
    }
    return events;
  }

  private finishRun(event: CopilotEvent): AdapterEvent[] {
    if (this.settled) return [];
    this.settled = true;
    const exitCode = event.exitCode ?? 0;
    const failed = exitCode !== 0;
    const events: AdapterEvent[] = [];
    if (failed) {
      events.push({
        type: "error",
        payload: { message: `copilot exited with code ${exitCode}`, fatal: true },
      });
    }
    events.push({
      type: "result",
      payload: {
        state: failed ? "error" : "done",
        usage: this.usage,
        text: this.lastText,
        exitCode,
      },
    });
    return events;
  }
}

export class CopilotAdapter extends SpawnAdapter {
  readonly id = "copilot" as const;
  readonly label = "GitHub Copilot";
  readonly reportsTokens = true;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(effectiveCopilotPermissionMode());
  }
  get model(): string | null {
    return settings.copilot.model;
  }
  protected get binaryName(): string {
    return settings.copilot.binary;
  }

  protected missingBinaryReason(): string {
    return `\`${settings.copilot.binary}\` not found on PATH — install from https://github.com/github/copilot-cli`;
  }

  protected async checkAuth(): Promise<string | null> {
    if ((await resolveGithubToken()) !== null) return null;
    if (settings.copilot.assumeAuthenticated) return null;
    return "No Copilot login detected — run `copilot login` (or set COPILOT_ASSUME_AUTHENTICATED=true)";
  }

  override async getAccountUsage(): Promise<ProviderUsage> {
    const token = await resolveGithubToken();
    if (token === null) {
      return providerUsageUnavailable(
        "copilot",
        "Copilot plan usage needs a GitHub token — set COPILOT_GITHUB_TOKEN or run `gh auth login`",
      );
    }
    const response = await fetchJson(COPILOT_USER_URL, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "agent-console/1.0",
        "User-Agent": "agent-console",
      },
    });
    if (response.status === 401 || response.status === 403) {
      return providerUsageUnavailable(
        "copilot",
        "GitHub token cannot read Copilot entitlements — sign in again with Copilot access",
      );
    }
    if (!response.ok) {
      return providerUsageUnavailable("copilot", `Copilot usage request failed (HTTP ${response.status})`);
    }
    return providerUsageOk("copilot", parseCopilotQuota(response.body));
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const consult = opts.permissionOverride !== "inherit";
    const mode = consult ? "plan" : effectiveCopilotPermissionMode();
    // Headless runs have nowhere to show an approval prompt, so tool approval is
    // always pre-granted; `mode` decides how far outside the workspace that reaches.
    const args = ["--allow-all-tools", "--output-format", "json", "--no-color", "--no-auto-update"];
    if (mode === "yolo") args.push("--allow-all");
    if (mode === "allow-all-paths") args.push("--allow-all-paths");
    if (mode === "plan") {
      // Plan mode keeps the agent on planning; denying `write` stops the built-in
      // file tools outright. Shell commands still run — Copilot's OS sandbox is
      // experimental, so a consult is read-only by policy, not by containment.
      args.push("--mode", "plan", "--deny-tool", "write");
    }
    const model = opts.model ?? settings.copilot.model;
    if (model !== null) args.push("--model", model);
    if (settings.copilot.reasoningEffort !== null) {
      args.push("--effort", settings.copilot.reasoningEffort);
    }
    if (settings.copilot.maxAiCredits !== null) {
      args.push("--max-ai-credits", String(settings.copilot.maxAiCredits));
    }
    if (!settings.copilot.builtinMcpServers) args.push("--disable-builtin-mcps");
    // Off by default: a server-driven run should not publish itself to GitHub
    // web/mobile, and remote control of an unattended session is worse.
    if (!settings.copilot.remoteExport) args.push("--no-remote-export");
    args.push(...settings.copilot.extraArgs);
    // `-p` takes the prompt as its argument and exits when the turn completes.
    args.push("-p", prompt);
    const env: NodeJS.ProcessEnv = {};
    if (settings.copilot.githubToken !== null) {
      env.COPILOT_GITHUB_TOKEN = settings.copilot.githubToken;
    }
    return { args, env: Object.keys(env).length > 0 ? env : undefined };
  }

  protected createMapper(): StreamMapper {
    return new CopilotMapper();
  }
}

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

const GH_TOKEN_TTL_MS = 60_000;

let ghTokenCache: { at: number; token: string | null } | null = null;

/**
 * The token Copilot itself would use, in the CLI's own order of precedence.
 *
 * A `copilot login` normally lands in the OS credential store, which cannot be
 * read from here; the plaintext fallback under `$COPILOT_HOME` is checked, then
 * the GitHub CLI, whose OAuth tokens Copilot accepts. When none of those exist
 * the account is reported as signed out rather than guessed at.
 */
async function resolveGithubToken(): Promise<string | null> {
  if (settings.copilot.githubToken !== null) return settings.copilot.githubToken;
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  const stored = readStoredCopilotToken();
  if (stored !== null) return stored;
  return readGhCliToken();
}

/** `copilot login` writes here only when no OS credential store is available. */
function readStoredCopilotToken(): string | null {
  const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  for (const name of ["credentials.json", "auth.json"]) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const token = findToken(parsed);
      if (token !== null) return token;
    } catch {
      // Unreadable or not JSON: fall through to the next candidate.
    }
  }
  return null;
}

function findToken(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|oauth/i.test(key) && typeof entry === "string" && entry.trim() !== "") {
      return entry.trim();
    }
    const nested = findToken(entry);
    if (nested !== null) return nested;
  }
  return null;
}

/** Cached: availability detection runs far more often than the token changes. */
async function readGhCliToken(): Promise<string | null> {
  if (ghTokenCache !== null && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) {
    return ghTokenCache.token;
  }
  let token: string | null = null;
  try {
    const result = await runCommand("gh", ["auth", "token"], 3000);
    const text = result.stdout.trim();
    if (result.code === 0 && text !== "") token = text;
  } catch {
    token = null;
  }
  ghTokenCache = { at: Date.now(), token };
  return token;
}

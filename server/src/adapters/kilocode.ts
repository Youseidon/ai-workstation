import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import {
  describeEffectiveAccess,
  effectiveKilocodePermissionMode,
  settings,
} from "../settings.ts";
import { fetchJson, parseKiloUsage, providerUsageOk, providerUsageUnavailable } from "./accountUsage.ts";
import { SpawnAdapter, type SpawnSpec, type StreamMapper } from "./spawnAdapter.ts";
import type { RunOptions } from "./types.ts";

/*
 * `kilo run --format json <prompt>` emits opencode-style NDJSON, one object per
 * message part. Verified against kilo 7.8.1; see README for how to re-check.
 *
 *   {"type":"step_start","sessionID":"ses_…","part":{"type":"step-start",…}}
 *   {"type":"text","sessionID":"…","part":{"type":"text","text":"…",…}}
 *   {"type":"tool_use","sessionID":"…","part":{"type":"tool","callID":"…",
 *      "tool":"write","state":{"status":"completed","input":{…},
 *      "output":"…","title":"…",…}}}
 *   {"type":"step_finish","sessionID":"…","part":{"type":"step-finish",
 *      "reason":"stop"|"tool-calls","model":{"providerID":"kilo","modelID":"…"},
 *      "cost":0.0027,"tokens":{"input":…,"output":…,"reasoning":…,
 *      "cache":{"read":…,"write":…}}}}
 *   {"type":"error","error":{"name":"APIError","data":{"message":"…"}}}
 *
 * Two quirks the mapper exists for: every step_finish reports the tokens of
 * that one request (so a multi-step run's usage is the sum, not the last), and
 * fatal problems — model not found, expired login — arrive as an `error` event
 * while the process still exits 0. Errors therefore settle the run themselves.
 */

interface KiloTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface KiloPart {
  type?: string;
  id?: string;
  callID?: string;
  tool?: string;
  text?: unknown;
  reason?: string;
  tokens?: KiloTokens;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    title?: string;
  };
}

interface KiloEvent {
  type?: string;
  sessionID?: string;
  part?: KiloPart;
  error?: { name?: string; data?: { message?: unknown } } | string;
}

interface KiloToolState {
  name: string;
  input: unknown;
  title: string | null;
}

function toUsage(raw: KiloTokens | null | undefined): TokenUsage | null {
  if (!raw) return null;
  const input = raw.input ?? 0;
  const cacheRead = raw.cache?.read ?? 0;
  const cacheWrite = raw.cache?.write ?? 0;
  const output = raw.output ?? 0;
  const reasoning = raw.reasoning ?? 0;
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) return null;
  // Same convention as Claude/Grok: inputTokens is the whole prompt processed,
  // of which the cache-read share is kept separate.
  const inputTokens = input + cacheRead + cacheWrite;
  return {
    inputTokens,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    reasoningOutputTokens: reasoning,
    totalTokens: inputTokens + output,
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
  return JSON.stringify(value, null, 2);
}

function summarizeToolInput(name: string, input: unknown, title: string | null): string {
  if (title !== null && title !== "") return oneLine(title);
  const record = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  switch (name) {
    case "bash":
    case "terminal":
      return oneLine(pick("command") ?? pick("cmd") ?? "");
    case "write":
    case "edit":
    case "read":
      return oneLine(pick("filePath") ?? pick("file_path") ?? pick("path") ?? "");
    case "grep":
    case "glob":
      return oneLine(pick("pattern") ?? "");
    default:
      return oneLine(JSON.stringify(record));
  }
}

const TERMINAL_TOOL_STATUS = new Set(["completed", "error"]);

export class KiloMapper implements StreamMapper {
  settled = false;
  private usage: TokenUsage | null = null;
  private lastText: string | null = null;
  private announcedSession = false;
  private readonly openTools = new Map<string, KiloToolState>();
  private readonly completedTools = new Set<string>();

  map(value: unknown): AdapterEvent[] {
    const event = value as KiloEvent;
    const part = event.part ?? {};
    const sessionId = event.sessionID ?? null;

    // The session id rides every event; announce it once, on the first line
    // that carries one, so a budget stop can still resume what was spent.
    const prelude: AdapterEvent[] = [];
    if (sessionId !== undefined && !this.announcedSession) {
      this.announcedSession = true;
      prelude.push({
        type: "status",
        payload: { state: "running", detail: `session ${sessionId}`, sessionId },
      });
    }

    switch (event.type) {
      case "step_start":
        prelude.push({
          type: "status",
          payload: { state: "running", detail: "step started" },
        });
        return prelude;
      case "step_finish": {
        this.usage = accumulate(this.usage, toUsage(part.tokens));
        prelude.push({
          type: "status",
          payload: { state: "running", usage: this.usage, detail: `step ${part.reason ?? ""}`.trim() },
        });
        return prelude;
      }
      case "text":
        prelude.push(...this.mapText(part, "message"));
        return prelude;
      case "reasoning":
        prelude.push(...this.mapText(part, "thinking"));
        return prelude;
      case "tool_use":
        prelude.push(...this.mapTool(part));
        return prelude;
      case "error":
        return [...prelude, ...this.mapError(event)];
      default:
        return prelude;
    }
  }

  finish(exitCode: number | null): AdapterEvent[] {
    if (this.settled) return [];
    this.settled = true;
    // A clean exit without a final result line: the run simply ended. Only an
    // abnormal exit is an error — spawnAdapter already reports those.
    return [{
      type: "result",
      payload: { state: "done", usage: this.usage, text: this.lastText, exitCode: exitCode ?? 0 },
    }];
  }

  private mapText(part: KiloPart, kind: "message" | "thinking"): AdapterEvent[] {
    const text = typeof part.text === "string" ? part.text : "";
    if (text === "") return [];
    if (kind === "message") this.lastText = text;
    return [{
      type: "assistant_text",
      payload: {
        blockId: part.id ?? `kilo-${kind}-${this.openTools.size}`,
        delta: false,
        text,
        kind,
      },
    }];
  }

  private mapTool(part: KiloPart): AdapterEvent[] {
    const toolUseId = part.callID ?? `kilo_tool_${this.openTools.size}`;
    const name = part.tool ?? "tool";
    const status = part.state?.status ?? "";
    const events: AdapterEvent[] = [];

    if (!this.openTools.has(toolUseId)) {
      const state: KiloToolState = { name, input: part.state?.input ?? {}, title: part.state?.title ?? null };
      this.openTools.set(toolUseId, state);
      events.push({
        type: "tool_use",
        payload: {
          toolUseId,
          name,
          summary: summarizeToolInput(name, state.input, state.title),
          input: state.input ?? {},
        },
      });
    }

    if (TERMINAL_TOOL_STATUS.has(status) && !this.completedTools.has(toolUseId)) {
      this.completedTools.add(toolUseId);
      const output = stringifyOutput(part.state?.output);
      const isError = status === "error";
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

  private mapError(event: KiloEvent): AdapterEvent[] {
    const message = typeof event.error === "string"
      ? event.error
      : event.error?.data?.message !== undefined
        ? stringifyOutput(event.error.data.message) || (event.error.name ?? "kilo reported an error")
        : event.error?.name ?? "kilo reported an error";
    const events: AdapterEvent[] = [{ type: "error", payload: { message, fatal: true } }];
    if (!this.settled) {
      this.settled = true;
      events.push({ type: "result", payload: { state: "error", usage: this.usage, exitCode: 1 } });
    }
    return events;
  }
}

export class KiloAdapter extends SpawnAdapter {
  readonly id = "kilocode" as const;
  readonly label = "Kilo Code";
  readonly reportsTokens = true;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(effectiveKilocodePermissionMode());
  }
  get model(): string | null {
    return settings.kilocode.model;
  }
  protected get binaryName(): string {
    return settings.kilocode.binary;
  }

  protected missingBinaryReason(): string {
    return `\`${settings.kilocode.binary}\` not found on PATH — install from https://kilo.ai/docs/getting-started/installation`;
  }

  protected async checkAuth(): Promise<string | null> {
    if (settings.kilocode.assumeAuthenticated) return null;
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dataHome = process.env.XDG_DATA_HOME ?? join(await (await import("node:os")).homedir(), ".local", "share");
    if (existsSync(join(dataHome, "kilo", "auth.json"))) return null;
    return "No Kilo login found — run `kilo auth login` (or set KILOCODE_ASSUME_AUTHENTICATED=true)";
  }

  override async getAccountUsage(): Promise<ProviderUsage> {
    const token = resolveKiloAccessToken();
    if (token === null) {
      return providerUsageUnavailable(
        "kilocode",
        settings.kilocode.assumeAuthenticated
          ? "No Kilo credential found in the usual auth.json — re-run `kilo auth login`"
          : "No Kilo login found — run `kilo auth login` (or set KILOCODE_ASSUME_AUTHENTICATED=true)",
      );
    }
    const base = (process.env.KILO_API_URL ?? "https://api.kilo.ai").replace(/\/$/, "");
    const organizationId = resolveKiloOrganizationId();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "agent-console",
    };
    if (organizationId !== null) headers["x-kilocode-organizationid"] = organizationId;

    const balance = await fetchJson(`${base}/api/profile/balance`, { headers });
    if (balance.status === 401 || balance.status === 403) {
      return providerUsageUnavailable("kilocode", "Kilo login expired — run `kilo auth login` again");
    }

    // The Pass endpoint needs the editor-name headers the CLI always sends;
    // without them it 400s while /api/profile/balance still succeeds.
    const passInput = new URLSearchParams({ batch: "1", input: JSON.stringify({ "0": null }) });
    const pass = await fetchJson(`${base}/api/trpc/kiloPass.getState?${passInput}`, {
      headers: {
        ...headers,
        "X-KILOCODE-EDITORNAME": "agent-console",
        "X-KILOCODE-VERSION": "1",
      },
    });

    if (!balance.ok && !pass.ok) {
      return providerUsageUnavailable(
        "kilocode",
        balance.status === 429
          ? "Kilo usage endpoint rate-limited — try again shortly"
          : `Kilo usage request failed (HTTP ${balance.status})`,
      );
    }
    return providerUsageOk(
      "kilocode",
      parseKiloUsage(balance.ok ? balance.body : null, pass.ok ? pass.body : null),
    );
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const consult = opts.permissionOverride !== "inherit";
    const args = ["run", "--format", "json"];
    // The plan agent's own rules confine it to reads; execute runs pre-grant
    // approvals because a headless run has nowhere to put an ask prompt.
    if (consult) {
      args.push("--agent", "plan");
    } else {
      args.push("--agent", "code");
      if (settings.kilocode.autoApprove) args.push("--auto");
    }
    const resumeSessionId = opts.resumeSessionId ?? null;
    if (resumeSessionId !== null) args.push("--session", resumeSessionId);
    const model = opts.model ?? settings.kilocode.model;
    if (model !== null) args.push("-m", model);
    const variant = settings.kilocode.reasoningEffort ?? settings.kilocode.variant ?? settings.reasoningEffort;
    args.push("--variant", variant);
    args.push(...settings.kilocode.extraArgs);
    // The prompt is the positional message. Kilo reads its project/cwd from the
    // spawn's working directory, which the runner already sets.
    args.push(prompt);
    return { args };
  }

  protected createMapper(): StreamMapper {
    return new KiloMapper();
  }
}

const KILO_OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key";

interface KiloAuthFile {
  access?: string;
  refresh?: string;
  expires?: number;
}

/**
 * Mirrors where the kilo CLI keeps its login: `auth.json` under the same data
 * home the availability check already looks at. The `access` JWT doubles as
 * the gateway bearer token (verified against /api/profile). KILO_API_KEY is
 * an OpenRouter-style gateway key, not a profile credential, so it stays out.
 */
function resolveKiloAccessToken(): string | null {
  const path = kiloAuthJsonPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entry = (parsed.kilo ?? {}) as Record<string, unknown> as KiloAuthFile;
    const access = typeof entry.access === "string" ? entry.access.trim() : "";
    if (access === "" || access === KILO_OAUTH_DUMMY_KEY) return null;
    return access;
  } catch {
    return null;
  }
}

function resolveKiloOrganizationId(): string | null {
  const fromEnv = process.env.KILO_ORG_ID?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const path = kiloAuthJsonPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entry = (parsed.kilo ?? {}) as Record<string, unknown>;
    const accountId = typeof entry.accountId === "string" ? entry.accountId.trim() : "";
    return accountId !== "" ? accountId : null;
  } catch {
    return null;
  }
}

function kiloAuthJsonPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "kilo", "auth.json");
}

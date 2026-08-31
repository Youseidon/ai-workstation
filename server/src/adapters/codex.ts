import { spawn } from "node:child_process";
import type { AdapterEvent, ProviderUsage, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import { LineSplitter, tryParseJson } from "../lib/lines.ts";
import { resolveBinary } from "../lib/process.ts";
import { describeEffectiveAccess, effectiveCodexSandboxMode, settings } from "../settings.ts";
import { parseCodexRateLimits, providerUsageOk, providerUsageUnavailable } from "./accountUsage.ts";
import { SpawnAdapter, type SpawnSpec, type StreamMapper } from "./spawnAdapter.ts";
import type { RunOptions } from "./types.ts";

/*
 * Codex emits JSONL on stdout with `codex exec --json`. Verified against
 * codex-cli 0.150.1; see README for how to re-check the flags/shapes.
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",...}}
 *   {"type":"item.completed","item":{"id":"item_1",...,"exit_code":0,"status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":123,...}}
 */

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }> | Record<string, unknown>;
  server?: string;
  tool?: string;
  result?: unknown;
  error?: unknown;
  query?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
  message?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string } | string;
  message?: string;
}

/** Item types that are agent output rather than tool activity. */
const TEXT_ITEM_TYPES = new Set(["agent_message", "reasoning"]);

function toUsage(usage: CodexUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
    totalTokens: inputTokens + outputTokens,
  };
}

class CodexMapper implements StreamMapper {
  settled = false;
  private readonly openTools = new Set<string>();
  private lastAgentMessage: string | null = null;
  private usage: TokenUsage | null = null;

  map(value: unknown): AdapterEvent[] {
    const event = value as CodexEvent;
    switch (event.type) {
      case "thread.started":
        return [{
          type: "status",
          payload: { state: "running", detail: `thread ${event.thread_id ?? "?"}` },
        }];
      case "turn.started":
        return [{ type: "status", payload: { state: "running", detail: "turn started" } }];
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.mapItem(event.type, event.item ?? {});
      case "turn.completed": {
        this.usage = toUsage(event.usage);
        this.settled = true;
        return [{
          type: "result",
          payload: { state: "done", usage: this.usage, text: this.lastAgentMessage, exitCode: 0 },
        }];
      }
      case "turn.failed": {
        this.settled = true;
        const message = typeof event.error === "string"
          ? event.error
          : event.error?.message ?? "Codex turn failed";
        return [
          { type: "error", payload: { message, fatal: true } },
          { type: "result", payload: { state: "error", usage: this.usage, exitCode: null } },
        ];
      }
      case "error": {
        const message = typeof event.error === "string"
          ? event.error
          : event.error?.message ?? event.message ?? "Codex reported an error";
        return [{ type: "error", payload: { message, fatal: false } }];
      }
      default:
        return [];
    }
  }

  private mapItem(phase: string, item: CodexItem): AdapterEvent[] {
    const itemType = item.type ?? "unknown";
    const itemId = item.id ?? `codex_${itemType}_${this.openTools.size}`;

    if (TEXT_ITEM_TYPES.has(itemType)) {
      const text = item.text ?? item.summary ?? "";
      if (text === "") return [];
      if (itemType === "agent_message") this.lastAgentMessage = text;
      return [{
        type: "assistant_text",
        payload: {
          blockId: itemId,
          // Codex sends whole items, so each event replaces the block body.
          delta: false,
          text,
          kind: itemType === "reasoning" ? "thinking" : "message",
        },
      }];
    }

    if (itemType === "error") {
      return [{
        type: "error",
        payload: { message: item.message ?? item.text ?? "Codex item error", fatal: false },
      }];
    }

    const events: AdapterEvent[] = [];
    const { name, summary, input } = describeToolItem(itemType, item);

    if (!this.openTools.has(itemId)) {
      this.openTools.add(itemId);
      events.push({ type: "tool_use", payload: { toolUseId: itemId, name, summary, input } });
    }

    if (phase === "item.completed") {
      const output = renderToolOutput(itemType, item);
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const isError = item.status === "failed" || (exitCode !== null && exitCode !== 0);
      events.push({
        type: "tool_result",
        payload: {
          toolUseId: itemId,
          name,
          isError,
          summary: oneLine(output || (isError ? "failed" : "completed"), 160),
          output,
          exitCode,
        },
      });
    }

    return events;
  }

  finish(): AdapterEvent[] {
    return [];
  }
}

function describeToolItem(itemType: string, item: CodexItem): {
  name: string;
  summary: string;
  input: unknown;
} {
  switch (itemType) {
    case "command_execution":
      return {
        name: "shell",
        summary: oneLine(item.command ?? ""),
        input: { command: item.command },
      };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => change.path ?? "?");
      return {
        name: "apply_patch",
        summary: paths.length > 0 ? oneLine(paths.join(", ")) : "file change",
        input: item.changes,
      };
    }
    case "mcp_tool_call":
      return {
        name: `${item.server ?? "mcp"}.${item.tool ?? "call"}`,
        summary: oneLine(JSON.stringify(item.result ?? {})),
        input: item,
      };
    case "web_search":
      return { name: "web_search", summary: oneLine(item.query ?? ""), input: { query: item.query } };
    case "todo_list": {
      const items = item.items ?? [];
      const done = items.filter((entry) => entry.completed).length;
      return {
        name: "todo_list",
        summary: `${done}/${items.length} done`,
        input: items,
      };
    }
    default:
      return { name: itemType, summary: oneLine(JSON.stringify(item)), input: item };
  }
}

function renderToolOutput(itemType: string, item: CodexItem): string {
  switch (itemType) {
    case "command_execution":
      return item.aggregated_output ?? "";
    case "file_change":
      return JSON.stringify(item.changes ?? [], null, 2);
    case "mcp_tool_call":
      return JSON.stringify(item.error ?? item.result ?? {}, null, 2);
    case "todo_list":
      return (item.items ?? [])
        .map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text ?? ""}`)
        .join("\n");
    default:
      return JSON.stringify(item, null, 2);
  }
}

export class CodexAdapter extends SpawnAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex CLI";
  readonly reportsTokens = true;
  // Getters, not fields: settings can change between runs without a restart.
  get permissionMode(): string {
    return describeEffectiveAccess(`sandbox: ${effectiveCodexSandboxMode()}`);
  }
  get model(): string | null {
    return settings.codex.model;
  }
  protected get binaryName(): string {
    return settings.codex.binary;
  }

  protected missingBinaryReason(): string {
    return `\`${settings.codex.binary}\` not found on PATH — install with \`npm i -g @openai/codex\``;
  }

  protected async checkAuth(): Promise<string | null> {
    if (settings.codex.apiKey !== null) return null;
    // `codex login` stores credentials under $CODEX_HOME (default ~/.codex).
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    if (existsSync(join(codexHome, "auth.json"))) return null;
    return "No OPENAI_API_KEY and no stored codex login — run `codex login`";
  }

  override async getAccountUsage(): Promise<ProviderUsage> {
    const binary = await resolveBinary(this.binaryName);
    if (binary === null) {
      return providerUsageUnavailable("codex", this.missingBinaryReason());
    }
    try {
      const result = await readCodexRateLimits(binary);
      const parsed = parseCodexRateLimits(result);
      return providerUsageOk("codex", parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return providerUsageUnavailable("codex", message);
    }
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const args = ["exec", "--json", "--color", "never", "-C", opts.cwd];
    args.push("-s", opts.permissionOverride === "consult" ? "read-only" : effectiveCodexSandboxMode());
    if (settings.codex.skipGitRepoCheck) args.push("--skip-git-repo-check");
    const model = opts.model ?? settings.codex.model;
    if (model !== null) args.push("-m", model);
    args.push(...settings.codex.extraArgs);
    // `-` makes codex read the prompt from stdin, so no argv escaping worries.
    args.push("-");
    return { args, stdin: prompt };
  }

  protected createMapper(): StreamMapper {
    return new CodexMapper();
  }
}

const CODEX_APP_SERVER_TIMEOUT_MS = 25_000;

/**
 * Drive Codex's own app-server over stdio. Codex owns the ChatGPT login and
 * token refresh; we never read `auth.json`.
 */
function readCodexRateLimits(binary: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedEnv(),
    });
    const splitter = new LineSplitter();
    let settled = false;
    let initialized = false;
    let stderr = "";

    const settle = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolvePromise(result);
    };

    const timer = setTimeout(() => {
      settle(new Error("codex app-server timed out waiting for rate limits"));
    }, CODEX_APP_SERVER_TIMEOUT_MS);

    const send = (message: Record<string, unknown>) => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handle = (value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as { id?: unknown; result?: unknown; error?: { message?: string } };
      if (message.id === 1) {
        if (message.error) {
          settle(new Error(message.error.message ?? "codex app-server initialize failed"));
          return;
        }
        if (initialized) return;
        initialized = true;
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 2 });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          settle(new Error(message.error.message ?? "codex rate-limit request failed"));
          return;
        }
        settle(null, message.result);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        const parsed = tryParseJson(line);
        if (parsed !== undefined) handle(parsed);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      if (!settled) {
        settle(new Error(`codex app-server exited (code ${code ?? "null"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "agent_console", title: "Agent Console", version: "0.1.0" } },
    });
  });
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_CONSOLE_DATA_DIR;
  delete env.AGENT_CONSOLE_DATABASE_PATH;
  delete env.DATABASE_URL;
  return env;
}

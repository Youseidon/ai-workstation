import type { AdapterEvent, TokenUsage } from "@agent-console/shared";
import { oneLine } from "@agent-console/shared";
import { describeEffectiveAccess, effectiveCodexSandboxMode, settings } from "../settings.ts";
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

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const args = ["exec", "--json", "--color", "never", "-C", opts.cwd];
    args.push("-s", effectiveCodexSandboxMode());
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

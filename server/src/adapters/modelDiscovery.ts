import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption, ProviderId } from "@agent-console/shared";
import { MODEL_CATALOG } from "@agent-console/shared";
import { runCommand } from "../lib/process.ts";

const DEFAULT_OPTION: Record<ProviderId, ModelOption> = {
  claude: { id: null, label: "default", hint: "whatever the Agent SDK picks" },
  codex: { id: null, label: "default", hint: "whatever `codex exec` picks" },
  cursor: { id: null, label: "default", hint: "whatever cursor-agent picks" },
  grok: { id: null, label: "default", hint: "whatever `grok` picks" },
  copilot: { id: null, label: "default", hint: "whatever Copilot picks" },
  kilocode: { id: null, label: "default", hint: "whatever the kilo CLI picks" },
};

function labelFor(id: string): string {
  return id.replace(/^(claude|gpt|cursor|grok)-/, "").replace(/-/g, " ");
}

function withDefault(provider: ProviderId, models: ModelOption[]): ModelOption[] {
  const unique = new Map<string, ModelOption>();
  for (const model of models) {
    if (model.id !== null && model.id.trim() !== "") unique.set(model.id, model);
  }
  return [DEFAULT_OPTION[provider], ...unique.values()];
}

export function parseCursorModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9._-]+) - (.+)$/.exec(line.trim());
    if (match === null) continue;
    const id = match[1];
    const display = match[2];
    if (id === undefined || display === undefined) continue;
    const pool = id === "auto" || id.startsWith("composer-") || id.startsWith("cursor-")
      ? "cursor"
      : "vendor";
    models.push({ id, label: labelFor(id), hint: display, pool });
  }
  return models;
}

export function parseGrokModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(?:\*|-)\s+([A-Za-z0-9._-]+)(?:\s+\(([^)]+)\))?\s*$/.exec(line);
    if (match === null) continue;
    const id = match[1];
    if (id === undefined) continue;
    models.push({ id, label: labelFor(id), hint: match[2] === "default" ? "provider default" : id });
  }
  return models;
}

/**
 * `kilo models` prints one `-m` value per line, `provider/modelID`, where the
 * model id itself carries a vendor path (`kilo/~anthropic/claude-opus-latest`).
 * A leading `~` marks the Kilo Gateway's pooled alias for that vendor model.
 */
export function parseKiloModels(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.trim();
    if (!/^[A-Za-z0-9~-][A-Za-z0-9._~/-]*\/[A-Za-z0-9._~/-]+$/.test(id)) continue;
    const modelId = id.replace(/^[^/]+\//, "");
    const pooled = modelId.startsWith("~");
    const autoTier = id.startsWith("kilo-auto/") ? modelId : null;
    // `~anthropic/claude-opus-latest` → "claude opus latest"; the vendor path
    // stays in the id, which is what the mention filter searches anyway.
    const nameOnly = modelId.replace(/^~/, "").split("/").slice(-1)[0] ?? modelId;
    models.push({
      id,
      label: autoTier === null
        ? nameOnly.replace(/-/g, " ")
        : `Auto ${autoTier.charAt(0).toUpperCase()}${autoTier.slice(1)}`,
      hint: autoTier === null ? (pooled ? "Kilo Gateway pool" : modelId) : "Kilo automatic routing",
    });
  }
  return models;
}

interface CodexCache {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    description?: unknown;
    visibility?: unknown;
  }>;
}

interface CodexModelList {
  data?: Array<{
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
  }>;
}

export function parseCodexModels(value: unknown): ModelOption[] {
  const liveRows = (value as CodexModelList | null)?.data;
  if (Array.isArray(liveRows)) {
    return liveRows.flatMap((row) => {
      if (typeof row.model !== "string" || row.hidden === true) return [];
      return [{
        id: row.model,
        label: typeof row.displayName === "string" ? row.displayName : labelFor(row.model),
        hint: typeof row.description === "string" && row.description !== "" ? row.description : row.model,
      }];
    });
  }
  const rows = (value as CodexCache | null)?.models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row.slug !== "string" || row.visibility === "hide") return [];
    return [{
      id: row.slug,
      label: typeof row.display_name === "string" ? row.display_name : labelFor(row.slug),
      hint: typeof row.description === "string" && row.description !== "" ? row.description : row.slug,
    }];
  });
}

/** Ask Codex's authenticated app-server so its own cache refresh rules apply. */
function listCodexModels(binary: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const send = (value: unknown) => child.stdin?.write(`${JSON.stringify(value)}\n`);
    const consume = () => {
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === "") continue;
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
          if (message.id === 1) {
            if (message.error) return finish(new Error(message.error.message ?? "Codex initialization failed"));
            send({ method: "initialized", params: {} });
            send({ method: "model/list", id: 2, params: { limit: 100, includeHidden: false } });
          } else if (message.id === 2) {
            if (message.error) return finish(new Error(message.error.message ?? "Codex model refresh failed"));
            return finish(null, message.result);
          }
        } catch {
          // App-server stdout is expected to be JSONL; ignore non-protocol noise.
        }
      }
    };
    const timer = setTimeout(() => finish(new Error("Codex model refresh timed out")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; consume(); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-1000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited (${code ?? "unknown"})${stderr ? `: ${stderr}` : ""}`));
    });
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "agent_console", title: "Agent Console", version: "0.1.0" } },
    });
  });
}

interface ClaudeCatalog {
  catalog?: {
    config?: {
      models?: Array<{
        id?: unknown;
        name?: unknown;
        description?: unknown;
        section?: unknown;
      }>;
    };
  };
}

export function parseClaudeModels(value: unknown): ModelOption[] {
  const rows = (value as ClaudeCatalog | null)?.catalog?.config?.models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row.id !== "string") return [];
    const name = typeof row.name === "string" ? row.name : labelFor(row.id);
    return [{
      id: row.id,
      label: name.toLowerCase(),
      hint: typeof row.description === "string" && row.description !== "" ? row.description : name,
    }];
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function newestJson(directory: string): Promise<unknown | null> {
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const files = await Promise.all(names.map(async (name) => {
      const path = join(directory, name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
    files.sort((a, b) => b.modified - a.modified);
    return files[0] === undefined ? null : await readJson(files[0].path);
  } catch {
    return null;
  }
}

async function discover(provider: ProviderId, binary: string | null): Promise<ModelOption[]> {
  if (provider === "cursor" && binary !== null) {
    const result = await runCommand(binary, ["--list-models"], 10_000);
    return parseCursorModels(`${result.stdout}\n${result.stderr}`);
  }
  if (provider === "grok" && binary !== null) {
    const result = await runCommand(binary, ["models"], 10_000);
    return parseGrokModels(`${result.stdout}\n${result.stderr}`);
  }
  if (provider === "codex") {
    if (binary !== null) {
      try {
        const live = parseCodexModels(await listCodexModels(binary));
        if (live.length > 0) return live;
      } catch {
        // A cached account catalog is still better than the bundled snapshot.
      }
    }
    const directory = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    try {
      return parseCodexModels(await readJson(join(directory, "models_cache.json")));
    } catch {
      return [];
    }
  }
  if (provider === "claude") {
    const directory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    return parseClaudeModels(await newestJson(join(directory, "cache", "model-catalog")));
  }
  if (provider === "kilocode" && binary !== null) {
    const result = await runCommand(binary, ["models"], 10_000);
    return parseKiloModels(`${result.stdout}\n${result.stderr}`);
  }
  // Copilot exposes its account-specific picker only inside an interactive
  // session. `auto` is deliberately the stable, current provider route.
  return [];
}

/** Refresh one provider without ever making provider detection fail. */
export async function discoverModels(provider: ProviderId, binary: string | null): Promise<ModelOption[]> {
  try {
    const models = await discover(provider, binary);
    return models.length > 0 ? withDefault(provider, models) : MODEL_CATALOG[provider];
  } catch {
    return MODEL_CATALOG[provider];
  }
}

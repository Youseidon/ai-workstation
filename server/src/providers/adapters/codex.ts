import { spawn } from "node:child_process";
import type { ProviderUsage } from "@hydra/shared";
import { LineSplitter, tryParseJson } from "../../utils/lines.ts";
import { resolveBinary } from "../../infrastructure/process.ts";
import { describeEffectiveAccess, effectiveCodexSandboxMode, settings } from "../../config/settings.ts";
import { parseCodexRateLimits, providerUsageOk, providerUsageUnavailable } from "../accountUsage.ts";
import { CodexStreamMapper } from "../streams/codexStream.ts";
import { SpawnAdapter, type SpawnSpec } from "./spawnAdapter.ts";
import type { RunOptions } from "../../contracts/agentAdapter.ts";

/** Codex App Server supplies native text/reasoning deltas over JSON-RPC stdio. */
export function codexServerArgs(extra: string[], apiKey = false): string[] {
  for (let index = 0; index < extra.length; index++) {
    const flag = extra[index]!;
    if (["-c", "--config", "--enable", "--disable"].includes(flag)) {
      if (!extra[++index]) throw new Error(`Missing value for Codex extra argument ${flag}`);
    } else if (!/^--(?:config|enable|disable)=/.test(flag)) {
      throw new Error(`Codex streaming uses App Server. Replace unsupported exec-only extra argument ${flag} with a -c configuration override.`);
    }
  }
  // API-key login is connection-local. Never replace a stored ChatGPT login.
  return ["app-server", ...extra, ...(apiKey ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : [])];
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

  /** `/btw`: App Server takes input into the active turn (`turn/steer`). */
  sendUserMessage(runId: string, text: string): Promise<boolean> {
    return this.steerRun(runId, text);
  }

  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    const resumeSessionId = opts.resumeSessionId ?? null;
    const sandbox = opts.permissionOverride !== "inherit" ? "read-only" : effectiveCodexSandboxMode();
    return {
      args: codexServerArgs(settings.codex.extraArgs, settings.codex.apiKey !== null),
      interactive: true,
      env: settings.codex.apiKey ? { OPENAI_API_KEY: settings.codex.apiKey } : undefined,
      mapper: new CodexStreamMapper({ prompt, cwd: opts.cwd, model: opts.model ?? settings.codex.model,
        sandbox, effort: settings.reasoningEffortFor("codex"), resumeSessionId,
        requireGit: !settings.codex.skipGitRepoCheck, apiKey: settings.codex.apiKey ?? undefined }),
    };
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
      params: { clientInfo: { name: "hydra", title: "Hydra", version: "0.1.0" } },
    });
  });
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HYDRA_DATA_DIR;
  delete env.HYDRA_DATABASE_PATH;
  delete env.HYDRA_DB;
  delete env.HYDRA_WORKER_SECRET;
  delete env.HYDRA_PERSONAL_DEFAULTS;
  delete env.DATABASE_URL;
  delete env.SETTINGS_FILE;
  return env;
}

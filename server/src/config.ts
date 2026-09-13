import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/** Repo root, derived from this file rather than from the cwd of the process. */
const defaultRepoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const repoRoot = process.env.AGENT_CONSOLE_REPO_ROOT?.trim()
  ? resolve(process.env.AGENT_CONSOLE_REPO_ROOT.trim())
  : defaultRepoRoot;

// Load .env from the repo root first, then server/.env (the latter wins).
loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true });
loadDotenv({ path: resolve(repoRoot, "server/.env"), quiet: true });

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function origin(name: string, fallback: string): string {
  const value = str(name, fallback);
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return fallback;
  }
}

/**
 * Boot-time only. Everything a user can change while the server is running
 * lives in `settings.ts` instead, which layers saved overrides over these
 * same `.env` values.
 */
const host = str("HOST", "127.0.0.1");
const port = int("PORT", 4000);
const agentHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

export const config = {
  repoRoot,
  host,
  port,
  /** Base URL embedded in prompts for agent-side context/status calls. */
  agentApiBaseUrl: origin("AGENT_API_BASE_URL", `http://${agentHost}:${port}`),
  /** Origins allowed to open a WebSocket / call the REST endpoints. */
  allowedOrigins: str("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;

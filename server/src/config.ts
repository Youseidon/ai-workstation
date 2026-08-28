import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/** Repo root, derived from this file rather than from the cwd of the process. */
const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");

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

/**
 * Boot-time only. Everything a user can change while the server is running
 * lives in `settings.ts` instead, which layers saved overrides over these
 * same `.env` values.
 */
export const config = {
  repoRoot,
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 4000),
  /** Origins allowed to open a WebSocket / call the REST endpoints. */
  allowedOrigins: str("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
} as const;

export type AppConfig = typeof config;

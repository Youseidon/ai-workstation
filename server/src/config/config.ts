import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

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

export const config = {
  repoRoot,
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 4000),
  allowedOrigins: str("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
};

export type AppConfig = typeof config;

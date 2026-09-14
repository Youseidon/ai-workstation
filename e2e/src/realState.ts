import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/*
 * The operator's real state that a harness run must never change
 * (docs/e2e-harness-plan.md section 1 and 4.1).
 *
 * The real database is checked by content, not by file hash: the operator's
 * own app may legitimately write to it while the harness runs. Every harness
 * root and fixture workspace lives under HARNESS_ROOT_PREFIX, so any real row
 * pointing there is harness pollution.
 */

export const repoRoot = resolve(import.meta.dirname, "../..");
export const realAgentConsoleDir = join(repoRoot, ".agent-console");
export const realDatabasePath = join(realAgentConsoleDir, "console.sqlite");
export const HARNESS_ROOT_PREFIX = join(tmpdir(), "ai-workstation-e2e-");

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** Files whose content must be identical before and after a harness run. */
export function fileHashes(): Record<string, string | null> {
  const nextDir = join(repoRoot, "web/.next");
  const nextListing = existsSync(nextDir)
    ? createHash("sha256")
        .update(
          readdirSync(nextDir)
            .filter((name) => name !== "cache" && name !== "dev")
            .sort()
            .map((name) => `${name}:${statSync(join(nextDir, name)).mtimeMs}`)
            .join("\n"),
        )
        .digest("hex")
    : null;
  return {
    ".env": sha256(join(repoRoot, ".env")),
    ".agent-console/settings.json": sha256(join(realAgentConsoleDir, "settings.json")),
    "web/.next (listing)": nextListing,
  };
}

/** Real database rows that point into a harness root. Must always be empty. */
export function realDatabaseHarnessRows(databasePath = realDatabasePath): string[] {
  if (!existsSync(databasePath)) return [];
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT id, name, work_directory AS workDirectory FROM workspace WHERE work_directory LIKE ? ESCAPE '\\'")
      .all(`${HARNESS_ROOT_PREFIX.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as Array<{ id: number; name: string; workDirectory: string }>;
    return rows.map((row) => `workspace ${row.id} "${row.name}" -> ${row.workDirectory}`);
  } finally {
    db.close();
  }
}

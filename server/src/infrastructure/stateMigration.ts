import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readHolder } from "./instanceLock.ts";

/*
 * One-time move of the state directory from its pre-rename home.
 *
 * The app was called "Agent Console" and kept its state in
 * `$XDG_STATE_HOME/agent-console/`. It is Hydra now, and keeps it in
 * `$XDG_STATE_HOME/hydra/`. Without this, the first boot after the rename would
 * find no database and start empty — every workspace, run and pipeline would
 * look gone.
 *
 * Moved rather than copied: the database is large, a copy would leave two
 * diverging "live" databases, and a rename within one directory tree is atomic.
 * The WAL is checkpointed into the main file first so nothing lives only in a
 * sidecar that would have to be renamed in step with it.
 *
 * A live holder of the old lock is a pre-rename `serve` still running. Moving
 * its database out from under it would split its writes across two files, so
 * that refuses instead, and the operator stops the old server first.
 */
export class PreRenameServerRunningError extends Error {
  constructor(readonly path: string, readonly pid: number) {
    super(
      `A pre-rename server (pid ${pid}) is still using ${path}. `
      + "Stop it, then start Hydra again so it can move the database to its new location.",
    );
    this.name = "PreRenameServerRunningError";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StateMigrationResult {
  moved: boolean;
  from: string;
  to: string;
}

/**
 * Moves `from` (a SQLite file) to `to`, plus the sibling `provider-sdk`
 * directory. A no-op when `to` already exists or `from` does not.
 */
export function migratePreRenameState(from: string, to: string): StateMigrationResult {
  const result = { moved: false, from, to };
  if (existsSync(to) || !existsSync(from)) return result;

  const lockPath = `${from}.lock`;
  const holder = readHolder(lockPath);
  if (holder !== null && alive(holder.pid)) throw new PreRenameServerRunningError(from, holder.pid);

  const old = new Database(from);
  try {
    old.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    old.close();
  }

  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  renameSync(from, to);
  chmodSync(to, 0o600);
  // Empty after the checkpoint; a stale one must never pair with the moved file.
  for (const sidecar of [`${from}-wal`, `${from}-shm`, lockPath]) rmSync(sidecar, { force: true });

  const oldSdk = join(dirname(from), "provider-sdk");
  const newSdk = join(dirname(to), "provider-sdk");
  if (existsSync(oldSdk) && !existsSync(newSdk)) renameSync(oldSdk, newSdk);

  writeFileSync(
    join(dirname(from), "MOVED.txt"),
    `This app was renamed to Hydra. Its state now lives in ${dirname(to)}\n`,
  );
  result.moved = true;
  return result;
}

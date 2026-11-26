import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readHolder } from "./instanceLock.ts";

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

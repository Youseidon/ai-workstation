import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * A single-writer claim on the console's database, held as a pid file.
 *
 * The database is shared mutable state, and one boot-time step — reconciling
 * runs that were in flight — is destructive: it marks every `STARTING`/
 * `RUNNING` row interrupted on the assumption that the process which owned
 * those runs is gone. Binding the HTTP port already rules out a second copy on
 * the same port. This rules out the other way two servers meet: a second copy
 * on a *different* port pointed at the same database, which is exactly what
 * following the "set PORT to something else" advice produces.
 */
export interface InstanceLock {
  /** Idempotent, and never removes a lock file another process has claimed. */
  release(): void;
}

export class InstanceLockedError extends Error {
  constructor(readonly path: string, readonly heldByPid: number) {
    super(`database is locked by process ${heldByPid} (${path})`);
    this.name = "InstanceLockedError";
  }
}

/**
 * `EPERM` means the pid exists but belongs to another user, which still counts
 * as alive. Only `ESRCH` — no such process — makes a lock stale.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function write(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function acquireInstanceLock(path: string): InstanceLock {
  if (!write(path)) {
    const holder = readHolder(path);
    // A holder that is gone left the file behind by crashing or being killed
    // with SIGKILL; an unreadable or malformed file is debris either way.
    if (holder !== null && processAlive(holder)) throw new InstanceLockedError(path, holder);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Losing this second attempt means another process took the stale lock
    // first; it now owns the database and this one must not proceed.
    if (!write(path)) throw new InstanceLockedError(path, readHolder(path) ?? 0);
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      if (readHolder(path) !== process.pid) return;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

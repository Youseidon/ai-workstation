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

/**
 * Who holds the lock. `mode` is what separates the two failure reports the
 * operator needs told apart: a second *development* server is debris to clear,
 * while a `serve` process is a live pipeline somebody is depending on and the
 * advice is to develop against a copy instead.
 */
export interface LockHolder {
  pid: number;
  /** `AGENT_CONSOLE_MODE` of the holding process; "dev" when it did not say. */
  mode: string;
  /** ISO timestamp, or null for a lock file written before this payload existed. */
  startedAt: string | null;
}

export class InstanceLockedError extends Error {
  constructor(readonly path: string, readonly heldByPid: number, readonly holder: LockHolder | null = null) {
    super(`database is locked by process ${heldByPid} (${path})`);
    this.name = "InstanceLockedError";
  }
}

/** The mode this process claims a lock under. */
export function currentLockMode(): string {
  const mode = process.env.AGENT_CONSOLE_MODE;
  return mode === undefined || mode.trim() === "" ? "dev" : mode.trim();
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

/*
 * The payload is JSON, and a bare pid is still read as one.
 *
 * Lock files outlive an upgrade: a `serve` process started before this change
 * left `1234\n` behind, and treating that as debris would have the next boot
 * displace a server that is still running. The bare-pid branch is not legacy
 * tolerance for its own sake — it is the difference between refusing to start
 * and stealing a live console's database.
 */
export function readHolder(path: string): LockHolder | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (raw === "") return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<LockHolder>;
      const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        mode: typeof parsed.mode === "string" && parsed.mode !== "" ? parsed.mode : "dev",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      };
    } catch {
      return null;
    }
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, mode: "dev", startedAt: null } : null;
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
    const holder: LockHolder = { pid: process.pid, mode: currentLockMode(), startedAt: new Date().toISOString() };
    writeSync(fd, `${JSON.stringify(holder)}\n`);
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
    if (holder !== null && processAlive(holder.pid)) throw new InstanceLockedError(path, holder.pid, holder);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Losing this second attempt means another process took the stale lock
    // first; it now owns the database and this one must not proceed.
    if (!write(path)) {
      const successor = readHolder(path);
      throw new InstanceLockedError(path, successor?.pid ?? 0, successor);
    }
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      if (readHolder(path)?.pid !== process.pid) return;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface InstanceLock {
  release(): void;
}

export interface LockHolder {
  pid: number;
  mode: string;
  startedAt: string | null;
}

export class InstanceLockedError extends Error {
  constructor(readonly path: string, readonly heldByPid: number, readonly holder: LockHolder | null = null) {
    super(`database is locked by process ${heldByPid} (${path})`);
    this.name = "InstanceLockedError";
  }
}

export function currentLockMode(): string {
  const mode = process.env.HYDRA_MODE;
  return mode === undefined || mode.trim() === "" ? "dev" : mode.trim();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
    if (holder !== null && processAlive(holder.pid)) throw new InstanceLockedError(path, holder.pid, holder);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

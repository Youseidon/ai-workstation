import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { connect } from "node:net";

/** A child process in its own process group, logging to a file, stoppable without orphans. */
export class ManagedProcess {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private exited: Promise<number | null> = Promise.resolve(null);

  constructor(
    readonly name: string,
    private readonly spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string },
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  start(): void {
    if (this.running) throw new Error(`${this.name} is already running`);
    this.log = createWriteStream(this.spec.logFile, { flags: "a" });
    this.log.write(`\n--- ${this.name} start ${new Date().toISOString()} ---\n`);
    const child = spawn(this.spec.command, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.pipe(this.log, { end: false });
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    this.child = child;
  }

  /** SIGTERM the whole group, escalate to SIGKILL, and wait for exit. */
  async stop(graceMs = 10_000): Promise<void> {
    const child = this.child;
    if (child === null || !this.running || child.pid === undefined) return;
    const group = -child.pid;
    try {
      process.kill(group, "SIGTERM");
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => {
      try {
        process.kill(group, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, graceMs);
    await this.exited;
    clearTimeout(timer);
    this.log?.write(`--- ${this.name} stopped ${new Date().toISOString()} ---\n`);
  }

  /** Resolves with the exit code if the process dies before `ready` resolves. */
  whenExited(): Promise<number | null> {
    return this.exited;
  }
}

export function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Polls `probe` until it returns true; fails with `description` after `timeoutMs`. No fixed sleeps in callers. */
export async function waitFor(description: string, probe: () => Promise<boolean>, timeoutMs: number, abort?: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let aborted: unknown = undefined;
  void abort?.then((value) => {
    aborted = value ?? "exited";
  });
  while (Date.now() < deadline) {
    if (aborted !== undefined) throw new Error(`${description}: process exited (${String(aborted)}) before becoming ready`);
    try {
      if (await probe()) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: not ready within ${timeoutMs}ms`);
}

import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterEvent, ProviderId } from "@agent-console/shared";
import { AsyncQueue } from "../lib/asyncQueue.ts";
import { LineSplitter, tryParseJson } from "../lib/lines.ts";
import { resolveBinary } from "../lib/process.ts";
import type { AgentAdapter, AvailabilityReport, RunOptions } from "./types.ts";

export interface SpawnSpec {
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** When set, written to the child's stdin and then closed. */
  stdin?: string;
}

/**
 * Turns one provider's JSON stream into normalized events. One instance is
 * created per run so it can hold per-run state (open tool calls, usage, ...).
 */
export interface StreamMapper {
  /** Called for each successfully parsed JSON line from stdout. */
  map(value: unknown): AdapterEvent[];
  /** Called once the child exits. */
  finish(exitCode: number | null, signal: NodeJS.Signals | null): AdapterEvent[];
  /** True once the mapper has emitted a terminal `result` event. */
  readonly settled: boolean;
}

const KILL_GRACE_MS = 2000;
const MAX_STDERR_CAPTURE = 4000;

/**
 * Shared machinery for CLI-backed providers: process spawn, JSONL framing,
 * stderr-to-log, clean interrupt, and non-zero-exit handling.
 */
export abstract class SpawnAdapter implements AgentAdapter {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly reportsTokens: boolean;
  abstract readonly permissionMode: string;
  abstract readonly model: string | null;
  readonly transport = "spawn" as const;

  protected abstract readonly binaryName: string;
  /** Reason shown when the binary is not on PATH. */
  protected abstract missingBinaryReason(): string;
  /** Extra availability checks (auth, keys) once the binary is present. */
  protected abstract checkAuth(): Promise<string | null>;
  protected abstract buildSpec(prompt: string, opts: RunOptions): SpawnSpec;
  protected abstract createMapper(): StreamMapper;

  private readonly children = new Map<string, ChildProcess>();

  async checkAvailability(): Promise<AvailabilityReport> {
    const binary = await resolveBinary(this.binaryName);
    if (binary === null) {
      return { available: false, reason: this.missingBinaryReason(), version: null, binary: null };
    }
    const version = await this.getVersion();
    const authReason = await this.checkAuth();
    return { available: authReason === null, reason: authReason, version, binary };
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  async getVersion(): Promise<string | null> {
    const binary = await resolveBinary(this.binaryName);
    if (binary === null) return null;
    const { readVersion } = await import("../lib/process.ts");
    return readVersion(binary);
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
    const binary = await resolveBinary(this.binaryName);
    if (binary === null) {
      yield { type: "error", payload: { message: this.missingBinaryReason(), fatal: true } };
      return;
    }

    const spec = this.buildSpec(prompt, opts);
    const mapper = this.createMapper();
    const queue = new AsyncQueue<AdapterEvent>();
    const splitter = new LineSplitter();
    let stderrTail = "";

    opts.log.info(`spawn ${binary} ${spec.args.map(redactArg).join(" ")}`);

    let child: ChildProcess;
    try {
      const childEnv={...process.env,...spec.env};
      // Persistence belongs exclusively to the server process. Never pass a
      // database/data-directory capability to a spawned agent, even if one is
      // added to the service environment later.
      delete childEnv.AGENT_CONSOLE_DATA_DIR;
      delete childEnv.AGENT_CONSOLE_DATABASE_PATH;
      delete childEnv.DATABASE_URL;
      child = spawn(binary, spec.args, {
        cwd: opts.cwd,
        env: childEnv,
        // With no stdin payload the handle is closed outright: these CLIs
        // otherwise sit waiting for piped input.
        stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      yield {
        type: "error",
        payload: { message: `Failed to start ${this.binaryName}`, fatal: true, detail: describeError(error) },
      };
      return;
    }

    this.children.set(opts.runId, child);

    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", (error) => {
        opts.log.debug(`stdin write failed: ${describeError(error)}`);
      });
      child.stdin.end(spec.stdin);
    }

    const onAbort = () => {
      void this.interrupt(opts.runId);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      const parsed = tryParseJson(line);
      if (parsed === undefined) {
        // Not JSON: banner/progress noise. Server log only.
        opts.log.debug(`non-json stdout: ${line.slice(0, 400)}`);
        return;
      }
      try {
        for (const event of mapper.map(parsed)) queue.push(event);
      } catch (error) {
        opts.log.warn("mapper failed on line", describeError(error));
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_CAPTURE);
      opts.log.debug(`stderr: ${chunk.trimEnd()}`);
    });

    child.on("error", (error) => {
      queue.push({
        type: "error",
        payload: { message: `${this.binaryName} process error`, fatal: true, detail: describeError(error) },
      });
      queue.close();
    });

    child.on("close", (code, signal) => {
      for (const line of splitter.flush()) handleLine(line);
      const interrupted = this.interrupted.has(opts.runId);

      if (!mapper.settled) {
        if (interrupted) {
          queue.push({ type: "result", payload: { state: "interrupted", exitCode: code } });
        } else if (code !== 0) {
          queue.push({
            type: "error",
            payload: {
              message: `${this.binaryName} exited unexpectedly (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
              fatal: true,
              detail: stderrTail.trim() || null,
            },
          });
          queue.push({ type: "result", payload: { state: "error", exitCode: code } });
        }
      }

      for (const event of mapper.finish(code, signal)) queue.push(event);
      queue.close();
    });

    try {
      for await (const event of queue) yield event;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      this.children.delete(opts.runId);
      this.interrupted.delete(opts.runId);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  private readonly interrupted = new Set<string>();

  async interrupt(runId: string): Promise<void> {
    const child = this.children.get(runId);
    if (!child || child.exitCode !== null) return;
    this.interrupted.add(runId);
    child.kill("SIGINT");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolvePromise();
      }, KILL_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Prompts can be long/sensitive; keep the server log readable. */
function redactArg(arg: string): string {
  return arg.length > 80 ? `${arg.slice(0, 77)}…` : arg;
}

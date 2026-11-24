import { processIdentity } from "../executionProcess.ts";
import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterEvent, ProviderId, ProviderUsage } from "@agent-console/shared";
import { AsyncQueue } from "../lib/asyncQueue.ts";
import { LineSplitter, tryParseJson } from "../lib/lines.ts";
import { resolveBinary } from "../lib/process.ts";
import { providerUsageUnavailable } from "./accountUsage.ts";
import type { AgentAdapter, AvailabilityReport, RunOptions } from "./types.ts";
import { settings } from "../settings.ts";
import {
  buildSpawnPlan,
  withSpawnEnvironment,
  readSystemdUnitOutcome,
  signalProcessTree,
  signalSystemdUnit,
  type SpawnPlan,
} from "./resourceContainment.ts";

export interface SpawnSpec {
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** When set, written to the child's stdin and then closed. */
  stdin?: string;
  /**
   * The session id this spawn is known to have before a byte of stdout arrives:
   * either one the adapter assigned itself (`--session-id`) or the one it is
   * resuming. Announced as a status event straight after spawn, because a
   * provider that only names its session in a final result event names it for
   * exactly the runs that do not need it — a budget stop never gets there.
   */
  sessionId?: string;
  /** Duplex transports keep stdin open and end when their protocol settles. */
  interactive?: boolean;
  mapper?: StreamMapper;
}

export interface StreamChannel {
  send(message: unknown): void;
  emit(event: AdapterEvent): void;
  fail(error: unknown): void;
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
  start?(channel: StreamChannel): void;
  line?(line: string): void;
  /** True when the provider has been asked to stop through its native API. */
  interrupt?(): boolean;
  /** Adds operator input to the turn in progress (`/btw`); false when there is none to add to. */
  steer?(text: string): Promise<boolean>;
  dispose?(): void;
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
  protected createMapper(): StreamMapper { throw new Error("Provider did not configure a stream mapper"); }

  private readonly children = new Map<string, { child: ChildProcess; plan: SpawnPlan; mapper: StreamMapper }>();

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

  async getAccountUsage(): Promise<ProviderUsage> {
    return providerUsageUnavailable(this.id, `${this.label} does not report account usage credits`);
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
    const binary = await resolveBinary(this.binaryName);
    if (binary === null) {
      yield { type: "error", payload: { message: this.missingBinaryReason(), fatal: true } };
      return;
    }

    const spec = this.buildSpec(prompt, opts);
    const mapper = spec.mapper ?? this.createMapper();
    const queue = new AsyncQueue<AdapterEvent>();
    const splitter = new LineSplitter();
    let stderrTail = "";

    const limits = settings.resourceLimits;
    const childEnv = { ...process.env, ...spec.env };
    delete childEnv.AGENT_CONSOLE_DATA_DIR;
    delete childEnv.AGENT_CONSOLE_DATABASE_PATH;
    delete childEnv.AGENT_CONSOLE_DB;
    delete childEnv.DATABASE_URL;
    delete childEnv.SETTINGS_FILE;
    const plan = withSpawnEnvironment(buildSpawnPlan(binary, spec.args, opts.runId, limits,undefined,undefined,opts.deadlineMs), opts.cwd, childEnv);
    opts.log.info(`spawn ${binary} ${spec.args.map(redactArg).join(" ")} · containment=${plan.containment}`);
    if (plan.containment !== "systemd") {
      opts.log.warn("systemd user containment unavailable; using process-tree cancellation without aggregate memory/task limits");
    }

    let child: ChildProcess;
    try {
      // Persistence belongs exclusively to the server process. Never pass a
      // database/data-directory capability to a spawned agent, even if one is
      // added to the service environment later.
      child = spawn(plan.command, plan.args, {
        cwd: opts.cwd,
        env: childEnv,
        // With no stdin payload the handle is closed outright: these CLIs
        // otherwise sit waiting for piped input.
        stdio: [spec.stdin === undefined && !spec.interactive ? "ignore" : "pipe", "pipe", "pipe"],
        detached: plan.detached,
      });
    } catch (error) {
      yield {
        type: "error",
        payload: { message: `Failed to start ${this.binaryName}`, fatal: true, detail: describeError(error) },
      };
      return;
    }

    if (opts.onSpawn && child.pid !== undefined) {
      try { opts.onSpawn(processIdentity(child.pid,plan.unitName,plan.containment)); }
      catch (error) {
        if(plan.unitName) await signalSystemdUnit(plan.unitName,"SIGKILL");
        else signalProcessTree(child.pid,"SIGKILL");
        child.on("error",()=>{});
        throw error;
      }
    }
    this.children.set(opts.runId, { child, plan, mapper });
    const emit = (event: AdapterEvent) => {
      queue.push(event);
      if (spec.interactive && event.type === "result") queue.close();
    };
    const fail = (error: unknown) => {
      emit({ type: "error", payload: { message: `${this.label} streaming failed`, fatal: true, detail: describeError(error) } });
      emit({ type: "result", payload: { state: "error", exitCode: null } });
    };
    child.stdin?.on("error", error => { if (!mapper.settled) fail(error); });

    // Before any provider output, so the id survives an interrupt.
    if (spec.sessionId !== undefined) {
      queue.push({ type: "status", payload: { state: "running", detail: `session ${spec.sessionId}`, sessionId: spec.sessionId } });
    }

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
        try {
          if (spec.interactive && !mapper.line) fail(new Error("Provider returned invalid JSON on its protocol stream"));
          else mapper.line?.(line);
        } catch (error) { fail(error); }
        // Not JSON: banner/progress noise. Server log only.
        opts.log.debug(`non-json stdout: ${line.slice(0, 400)}`);
        return;
      }
      try {
        for (const event of mapper.map(parsed)) emit(event);
      } catch (error) {
        if (spec.interactive) fail(error);
        else opts.log.warn("mapper failed on line", describeError(error));
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

    child.on("close", (code, signal) => { void (async () => {
      for (const line of splitter.flush()) handleLine(line);
      const interrupted = this.interrupted.has(opts.runId);
      const unitOutcome = plan.unitName === null
        ? { result: null, peakMemoryBytes: null, stopReason: null }
        : await readSystemdUnitOutcome(plan.unitName, limits);

      if (!mapper.settled) {
        if (interrupted) {
          queue.push({ type: "result", payload: { state: "interrupted", exitCode: code } });
        } else if (unitOutcome.stopReason !== null) {
          queue.push({
            type: "error",
            payload: {
              message: "Provider exceeded its run memory limit",
              fatal: true,
              detail: `${unitOutcome.stopReason}${unitOutcome.peakMemoryBytes === null ? "" : ` · peak ${unitOutcome.peakMemoryBytes} bytes`}`,
            },
          });
          queue.push({
            type: "result",
            payload: {
              state: "error",
              exitCode: code,
              stopReason: unitOutcome.stopReason,
              peakMemoryBytes: unitOutcome.peakMemoryBytes,
            },
          });
        } else if (code !== 0 || spec.interactive) {
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
    })(); });

    try {
      mapper.start?.({
        send: message => {
          if (!child.stdin?.writable) throw new Error("Provider input closed");
          child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        emit,
        fail,
      });
      if (opts.signal.aborted) onAbort();
      for await (const event of queue) yield event;
    } finally {
      mapper.dispose?.();
      opts.signal.removeEventListener("abort", onAbort);
      if (spec.interactive && child.exitCode === null && child.signalCode === null) {
        // App Server flushes its durable thread on stdio EOF. Give a completed
        // protocol a brief shutdown window before enforcing tree cleanup.
        child.stdin?.end();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 250);
          child.once("close", () => { clearTimeout(timer); resolve(); });
        });
      }
      this.children.delete(opts.runId);
      if (plan.containment === "process-group") signalProcessTree(child.pid, "SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await this.forceKill(opts.runId, child, plan);
      this.interrupted.delete(opts.runId);
    }
  }

  private readonly interrupted = new Set<string>();

  /**
   * Hands `/btw` text to a live run's mapper. Not `sendUserMessage` itself: a
   * provider opts in by defining that method, so this base class must not.
   */
  protected async steerRun(runId: string, text: string): Promise<boolean> {
    const tracked = this.children.get(runId);
    if (!tracked || tracked.child.exitCode !== null || tracked.mapper.steer === undefined) return false;
    return tracked.mapper.steer(text);
  }

  async interrupt(runId: string): Promise<void> {
    const tracked = this.children.get(runId);
    const child = tracked?.child;
    if (!child || child.exitCode !== null) return;
    this.interrupted.add(runId);
    if (!tracked.mapper.interrupt?.()) await this.signalTree(child, tracked.plan, "SIGINT");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => { void (async () => {
        if (child.exitCode === null && child.signalCode === null) await this.forceKill(runId, child, tracked.plan);
        resolvePromise();
      })(); }, KILL_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        // The group leader can exit while a compiler/test worker ignores the
        // interrupt. Do not mistake that for the complete tree being gone.
        if (tracked.plan.containment === "process-group") signalProcessTree(child.pid, "SIGKILL");
        resolvePromise();
      });
    });
  }

  private async signalTree(child: ChildProcess, plan: SpawnPlan, signal: "SIGINT" | "SIGKILL"): Promise<void> {
    if (plan.unitName !== null && await signalSystemdUnit(plan.unitName, signal)) return;
    if (!signalProcessTree(child.pid, signal)) child.kill(signal);
  }

  private async forceKill(runId: string, child: ChildProcess, plan: SpawnPlan): Promise<void> {
    await this.signalTree(child, plan, "SIGKILL");
    // The wrapper can outlive a unit it was waiting for; make sure its pipe and
    // run record cannot remain open after the cgroup has been killed.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    this.interrupted.add(runId);
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

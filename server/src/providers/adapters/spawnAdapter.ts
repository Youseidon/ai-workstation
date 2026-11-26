import { processIdentity } from "../../infrastructure/executionProcess.ts";
import { spawn, type ChildProcess } from "node:child_process";
import type { AdapterEvent, ProviderId, ProviderUsage } from "@hydra/shared";
import { AsyncQueue } from "../../utils/asyncQueue.ts";
import { LineSplitter, tryParseJson } from "../../utils/lines.ts";
import { resolveProviderBinary } from "../providerBinaries.ts";
import { providerUsageUnavailable } from "../accountUsage.ts";
import type { AgentAdapter, AvailabilityReport, RunOptions } from "../../contracts/agentAdapter.ts";
import { settings } from "../../config/settings.ts";
import {
  buildSpawnPlan,
  withSpawnEnvironment,
  readSystemdUnitOutcome,
  signalProcessTree,
  signalSystemdUnit,
  type SpawnPlan,
} from "../../infrastructure/resourceContainment.ts";

export interface SpawnSpec {
  args: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  sessionId?: string;
  interactive?: boolean;
  mapper?: StreamMapper;
}

export interface StreamChannel {
  send(message: unknown): void;
  emit(event: AdapterEvent): void;
  fail(error: unknown): void;
}

export interface StreamMapper {
  map(value: unknown): AdapterEvent[];
  finish(exitCode: number | null, signal: NodeJS.Signals | null): AdapterEvent[];
  readonly settled: boolean;
  start?(channel: StreamChannel): void;
  line?(line: string): void;
  interrupt?(): boolean;
  steer?(text: string): Promise<boolean>;
  dispose?(): void;
}

const KILL_GRACE_MS = 2000;
const MAX_STDERR_CAPTURE = 4000;

export abstract class SpawnAdapter implements AgentAdapter {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly reportsTokens: boolean;
  abstract readonly permissionMode: string;
  abstract readonly model: string | null;
  readonly transport = "spawn" as const;

  protected abstract readonly binaryName: string;
  protected abstract missingBinaryReason(): string;
  protected abstract checkAuth(): Promise<string | null>;
  protected abstract buildSpec(prompt: string, opts: RunOptions): SpawnSpec;
  protected createMapper(): StreamMapper { throw new Error("Provider did not configure a stream mapper"); }

  private readonly children = new Map<string, { child: ChildProcess; plan: SpawnPlan; mapper: StreamMapper }>();

  protected resolveBinary(): Promise<string | null> {
    return resolveProviderBinary(this.id, this.binaryName);
  }

  async checkAvailability(): Promise<AvailabilityReport> {
    const binary = await this.resolveBinary();
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
    const binary = await this.resolveBinary();
    if (binary === null) return null;
    const { readVersion } = await import("../../infrastructure/process.ts");
    return readVersion(binary);
  }

  async getAccountUsage(): Promise<ProviderUsage> {
    return providerUsageUnavailable(this.id, `${this.label} does not report account usage credits`);
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
    const binary = await this.resolveBinary();
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
    delete childEnv.HYDRA_DATA_DIR;
    delete childEnv.HYDRA_DATABASE_PATH;
    delete childEnv.HYDRA_DB;
    delete childEnv.HYDRA_WORKER_SECRET;
    delete childEnv.HYDRA_PERSONAL_DEFAULTS;
    delete childEnv.DATABASE_URL;
    delete childEnv.SETTINGS_FILE;
    const plan = withSpawnEnvironment(buildSpawnPlan(binary, spec.args, opts.runId, limits,undefined,undefined,opts.deadlineMs), opts.cwd, childEnv);
    opts.log.info(`spawn ${binary} ${spec.args.map(redactArg).join(" ")} · containment=${plan.containment}`);
    if (plan.containment !== "systemd") {
      opts.log.warn("systemd user containment unavailable; using process-tree cancellation without aggregate memory/task limits");
    }

    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: opts.cwd,
        env: childEnv,
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
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    this.interrupted.add(runId);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function redactArg(arg: string): string {
  return arg.length > 80 ? `${arg.slice(0, 77)}…` : arg;
}

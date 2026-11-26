import type { ProcessIdentity } from "../../contracts/execution.ts";

import { createHash } from "node:crypto";
import { observeResources, type ResourceObservation } from "../../infrastructure/resourceObservation.ts";
import { existsSync, realpathSync } from "node:fs";
import { processIdentity } from "../../infrastructure/executionProcess.ts";
import { buildSpawnPlan, withSpawnEnvironment, signalProcessTree, signalSystemdUnit, type ResourceLimits } from "../../infrastructure/resourceContainment.ts";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  DOD_COMMAND_OUTPUT_MAX_BYTES,
  clampDodTimeout,
} from "@hydra/shared";

export interface DodCommandOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
  resourceStalled?:boolean;
}

export function capOutput(text: string, limit = DOD_COMMAND_OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const half = Math.floor((limit - 80) / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n\n… ${Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes omitted …\n\n${tail}`;
}

export function resolveCommandCwd(workDirectory: string, cwd: string | null): string {
  const root = existsSync(workDirectory) ? realpathSync(workDirectory) : resolve(workDirectory);
  if (cwd === null || cwd.trim() === "") return root;
  if (isAbsolute(cwd)) throw new Error("A definition-of-done directory must be relative to the workspace");
  const resolved = resolve(root,cwd);
  const target = existsSync(resolved) ? realpathSync(resolved) : resolved;
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("A definition-of-done directory must stay inside the workspace");
  }
  return target;
}

function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HYDRA_DB;
  delete env.HYDRA_WORKER_SECRET;
  delete env.HYDRA_PERSONAL_DEFAULTS;
  delete env.HYDRA_DATA_DIR;
  delete env.HYDRA_DATABASE_PATH;
  delete env.DATABASE_URL;
  delete env.SETTINGS_FILE;
  return env;
}

export async function runDodCommand(args: {
  command: string;
  workDirectory: string;
  cwd: string | null;
  timeoutMs: number;
  onSpawn?: (identity: ProcessIdentity) => void;
  taskId?: string;
  limits?: ResourceLimits;
  onObservation?:(observation:ResourceObservation)=>void;
}): Promise<DodCommandOutcome> {
  const startedAt = Date.now();
  const cwd = resolveCommandCwd(args.workDirectory, args.cwd);
  const timeoutMs = clampDodTimeout(args.timeoutMs);
  const env=commandEnv();
  const plan=args.taskId && args.limits ? withSpawnEnvironment(buildSpawnPlan("/bin/sh",["-c",args.command],`command-${args.taskId}`,args.limits,undefined,undefined,timeoutMs),cwd,env) : null;

  return new Promise<DodCommandOutcome>((settle) => {
    const child = spawn(plan?.command ?? args.command, plan?.args ?? [], {
      shell: plan===null,
      cwd,
      env,
      detached: plan?.detached ?? true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid !== undefined && args.onSpawn) {
      try { args.onSpawn(processIdentity(child.pid,plan?.unitName ?? null,plan?.containment ?? "process-group")); }
      catch (error) {
        if(plan?.unitName) void signalSystemdUnit(plan.unitName,"SIGKILL");
        signalProcessTree(child.pid,"SIGKILL");
        child.on("error", () => {});
        child.on("close", () => settle({exitCode:null,signal:"SIGKILL",timedOut:false,output:`Process registration failed: ${error instanceof Error ? error.message : String(error)}`,durationMs:Date.now()-startedAt}));
        return;
      }
    }

    let output = "";
    let bytes = 0;
    let timedOut = false;
    let done = false;

    const collect = (chunk: Buffer): void => {
      if (bytes > DOD_COMMAND_OUTPUT_MAX_BYTES * 4) return;
      bytes += chunk.length;
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const killTree = (): void => {
      if(plan?.unitName) {void signalSystemdUnit(plan.unitName,"SIGKILL");return;}
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
      catch {  }
    };

    let ownedCgroup:string|undefined;
    let resourceStalled=false;
    let observation:ResourceObservation|null=null;
    let progressWindow:ResourceObservation|null=null;
    const observer=args.onObservation && child.pid ? setInterval(()=>{
      const outputVersion=createHash("sha256").update(output.replace(/\d{4}-\d\d-\d\dT[0-9:.+-]+Z?/g,"<time>")).digest("hex");
      if(plan?.unitName && !ownedCgroup) {
        const result=spawnSync("systemctl",["--user","show",plan.unitName,"--property=ControlGroup","--value"],{encoding:"utf8",timeout:2000});
        const path=result.stdout?.trim();if(result.status===0 && path?.startsWith("/") && !path.split("/").includes(".."))ownedCgroup=path;
      }
      const current=observeResources(child.pid!,outputVersion,observation,Date.now(),120000,ownedCgroup);
      if(!progressWindow || current.advancement) progressWindow=current;
      else if(observeResources(child.pid!,outputVersion,progressWindow,Date.now(),120000,ownedCgroup).pressureStalled) {resourceStalled=true;killTree();}
      observation=current;
      try {args.onObservation!(current);} catch {resourceStalled=true;killTree();}
    },10000) : null;
    observer?.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if(observer) clearInterval(observer);
      killTree();
      settle({
        exitCode,
        signal,
        timedOut,
        output: capOutput(output.trimEnd()),
        durationMs: Date.now() - startedAt,
        resourceStalled,
      });
    };

    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (error) => {
      output += `${output === "" ? "" : "\n"}${error.message}`;
      finish(null, null);
    });
  });
}

export function commandPassed(outcome: DodCommandOutcome, expectExitCode: number): boolean {
  return !outcome.timedOut && !outcome.resourceStalled && outcome.exitCode === expectExitCode;
}

export function describeOutcome(outcome: DodCommandOutcome, expectExitCode: number): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  if(outcome.resourceStalled) return `Sustained memory reclaim without command advancement after ${seconds}s; process group stopped for bounded recovery.`;
  if (outcome.timedOut) return `Timed out after ${seconds}s and was killed.`;
  if (outcome.exitCode === null) return `Killed by ${outcome.signal ?? "a signal"} after ${seconds}s.`;
  if (outcome.exitCode === expectExitCode) return `Exit ${outcome.exitCode} as expected, in ${seconds}s.`;
  return `Exit ${outcome.exitCode}, expected ${expectExitCode}, after ${seconds}s.`;
}

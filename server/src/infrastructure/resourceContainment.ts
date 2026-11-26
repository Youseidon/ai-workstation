import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResourceLimits {
  memoryHighBytes: number | null;
  memoryMaxBytes: number | null;
  memorySwapMaxBytes: number;
  tasksMax: number | null;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  unitName: string | null;
  containment: "systemd" | "process-group" | "process";
  detached: boolean;
}

export interface UnitOutcome {
  result: string | null;
  peakMemoryBytes: number | null;
  stopReason: string | null;
}

export function systemdUserManagerAvailable(
  platform = process.platform,
  probe: typeof spawnSync = spawnSync,
): boolean {
  if (platform !== "linux") return false;
  const result = probe("systemctl", ["--user", "show-environment"], {
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0 && result.error === undefined;
}

function safeUnitName(runId: string): string {
  return `hydra-${runId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128)}`;
}

export function buildSystemdSpawnPlan(
  binary: string,
  args: readonly string[],
  runId: string,
  limits: ResourceLimits,
  runtimeMs?:number,
): SpawnPlan {
  const unitName = safeUnitName(runId);
  const properties = [
    "MemoryAccounting=yes",
    "OOMPolicy=kill",
    "KillMode=control-group",
    ...(runtimeMs===undefined?[]:[`RuntimeMaxSec=${Math.max(1,Math.ceil(runtimeMs/1000))}s`,"TimeoutStopSec=2s"]),
    `MemorySwapMax=${limits.memorySwapMaxBytes}`,
    ...(limits.memoryHighBytes === null ? [] : [`MemoryHigh=${limits.memoryHighBytes}`]),
    ...(limits.memoryMaxBytes === null ? [] : [`MemoryMax=${limits.memoryMaxBytes}`]),
    ...(limits.tasksMax === null ? [] : [`TasksMax=${limits.tasksMax}`]),
  ];
  return {
    command: "systemd-run",
    args: [
      "--user", "--quiet", "--wait", "--pipe", "--service-type=exec",
      `--unit=${unitName}`,
      ...properties.flatMap((property) => ["--property", property]),
      "--", binary, ...args,
    ],
    unitName,
    containment: "systemd",
    detached: false,
  };
}

export function buildSpawnPlan(
  binary: string,
  args: readonly string[],
  runId: string,
  limits: ResourceLimits,
  systemdAvailable = systemdUserManagerAvailable(),
  platform = process.platform,
  runtimeMs?:number,
): SpawnPlan {
  if (platform === "linux" && systemdAvailable) return buildSystemdSpawnPlan(binary, args, runId, limits,runtimeMs);
  return {
    command: binary,
    args: [...args],
    unitName: null,
    containment: platform === "win32" ? "process" : "process-group",
    // A detached POSIX child becomes a process-group leader, allowing a signal
    // to reach every descendant even when aggregate cgroup limits are absent.
    detached: platform !== "win32",
  };
}

/** systemd services do not inherit the wrapper's cwd or environment. Forward
 * variable names, never secret values in command-line arguments. */
export function withSpawnEnvironment(plan: SpawnPlan, cwd: string, env: NodeJS.ProcessEnv): SpawnPlan {
  if (plan.containment !== "systemd") return plan;
  const separator = plan.args.indexOf("--");
  return { ...plan, args: [
    ...plan.args.slice(0, separator),
    `--working-directory=${cwd}`,
    ...Object.keys(env).filter(name => /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) && env[name] !== undefined).map(name => `--setenv=${name}`),
    "--property=UnsetEnvironment=HYDRA_DATA_DIR HYDRA_DATABASE_PATH HYDRA_DB HYDRA_WORKER_SECRET HYDRA_PERSONAL_DEFAULTS DATABASE_URL SETTINGS_FILE",
    ...plan.args.slice(separator),
  ] };
}

export function parseSystemdProperties(output: string, memoryMaxBytes: number | null): UnitOutcome {
  const values = new Map(output.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)] as const];
  }));
  const peakRaw = values.get("MemoryPeak") ?? "";
  const peak = /^\d+$/.test(peakRaw) ? Number(peakRaw) : null;
  const result = values.get("Result") || null;
  const oom = result === "oom-kill" || values.get("OOMKilled") === "yes";
  return {
    result,
    peakMemoryBytes: peak !== null && Number.isSafeInteger(peak) ? peak : null,
    stopReason: oom ? `resource_memory_limit:${memoryMaxBytes ?? "unknown"}` : null,
  };
}

export async function readSystemdUnitOutcome(unitName: string, limits: ResourceLimits): Promise<UnitOutcome> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user", "show", unitName,
      "--property=Result", "--property=MemoryPeak", "--property=OOMKilled",
    ], { encoding: "utf8", timeout: 2_000 });
    return parseSystemdProperties(stdout, limits.memoryMaxBytes);
  } catch {
    return { result: null, peakMemoryBytes: null, stopReason: null };
  } finally {
    // A finished transient unit should not accumulate in `systemctl --user`.
    void execFileAsync("systemctl", ["--user", "reset-failed", unitName], { timeout: 2_000 }).catch(() => undefined);
  }
}

export async function signalSystemdUnit(unitName: string, signal: "SIGINT" | "SIGKILL"): Promise<boolean> {
  try {
    await execFileAsync("systemctl", [
      "--user", "kill", `--signal=${signal}`, "--kill-whom=all", unitName,
    ], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform = process.platform,
  kill: typeof process.kill = process.kill,
): boolean {
  if (pid === undefined) return false;
  try {
    kill(platform === "win32" ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}


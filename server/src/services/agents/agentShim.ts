import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = resolve(fileURLToPath(import.meta.url), "../../../../bin/agent-step.mjs");

function runDirectory(runId: string): string {
  return resolve(tmpdir(), `hydra-${process.pid}`, runId);
}

export function existingAgentShim(runId: string): string | null {
  const path = resolve(runDirectory(runId), "agent-step");
  return existsSync(path) ? path : null;
}

export function createAgentShim(args: { runId: string; token: string; port: number; generation?:number; planRevision?:number }): string | null {
  try {
    const directory = runDirectory(args.runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "agent-step");
    const script = [
      "#!/bin/sh",
      `HYDRA_RUN_URL='http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}' \\`,
      `HYDRA_RUN_TOKEN='${args.token}' \\`,
      ...(args.generation===undefined?[]:[`HYDRA_EXECUTION_GENERATION='${args.generation}' \\`]),
      ...(args.planRevision===undefined?[]:[`HYDRA_PLAN_REVISION='${args.planRevision}' \\`]),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHIM)} "$@"`,
      "",
    ].join("\n");
    writeFileSync(path, script, { encoding: "utf8", mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  } catch {
    return null;
  }
}

export function removeAgentShim(runId: string): void {
  try {
    rmSync(runDirectory(runId), { recursive: true, force: true });
  } catch {
  }
}

export function removeAllAgentShims(): void {
  try {
    rmSync(dirname(runDirectory("x")), { recursive: true, force: true });
  } catch {
  }
}

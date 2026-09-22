/**
 * A per-run launcher for `agent-step`, with this run's credentials baked in.
 *
 * The alternative was putting `AGENT_CONSOLE_RUN_URL` and
 * `AGENT_CONSOLE_RUN_TOKEN` into the child's environment, which does not work
 * here: the Claude adapter runs the SDK **in this process**, so per-run
 * variables on `process.env` would be shared by every concurrent run and an
 * agent could post a status against a work item belonging to another one.
 *
 * A small file per run avoids that completely, needs no change to any adapter,
 * and works the same for the in-process SDK and for every spawned CLI. The
 * agent is given one absolute path and never has to assemble a URL, a header,
 * or an idempotency key.
 *
 * The token is written at mode 0600 into the per-user temp directory. It is no
 * more exposed than it already was — the same token has always been pasted into
 * the prompt text the agent receives — and it expires with the run.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = resolve(fileURLToPath(import.meta.url), "../../bin/agent-step.mjs");

function runDirectory(runId: string): string {
  // Scoped by pid as well as run id so two consoles on one machine cannot
  // collide, and so a crashed server's leftovers are identifiable.
  return resolve(tmpdir(), `agent-console-${process.pid}`, runId);
}

/**
 * Writes the launcher and returns its absolute path, or null if it could not be
 * written. Null is not fatal: the raw HTTP contract is still in the prompt, so
 * a run whose shim could not be created is degraded, not broken.
 */
export function createAgentShim(args: { runId: string; token: string; port: number }): string | null {
  try {
    const directory = runDirectory(args.runId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, "agent-step");
    // `exec` so signals and the exit code pass straight through: the agent has
    // to be able to see a non-zero exit when a status post is refused.
    const script = [
      "#!/bin/sh",
      `AGENT_CONSOLE_RUN_URL='http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}' \\`,
      `AGENT_CONSOLE_RUN_TOKEN='${args.token}' \\`,
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

/** Removes a run's launcher. Best effort: a leftover in tmp is not worth failing over. */
export function removeAgentShim(runId: string): void {
  try {
    rmSync(runDirectory(runId), { recursive: true, force: true });
  } catch {
    /* the temp directory is the OS's problem now */
  }
}

/** Removes every launcher this process created. Called on shutdown. */
export function removeAllAgentShims(): void {
  try {
    rmSync(dirname(runDirectory("x")), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

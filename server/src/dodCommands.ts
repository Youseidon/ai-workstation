/**
 * Running a definition-of-done command, and nothing else.
 *
 * This is the part of the definition of done that cannot be talked into
 * passing. A `PROSE` criterion is judged by a model, and a model can persuade
 * itself; an exit code cannot be persuaded. So the command is run *here*, by
 * the server, and the number it returns is the verdict.
 *
 * It is also the only place in this app that executes a string from the
 * database as a shell command, which makes every bound below a security
 * boundary rather than a preference:
 *
 * - **The command comes from the operator, never from an agent.** The only
 *   writers are the definition-of-done editors, which are on the operator's
 *   side of the API. Nothing an agent says is interpolated into a command
 *   string, and there is no substitution syntax that would let it be — the
 *   command is passed to the shell exactly as it was stored.
 * - **`shell: true` is deliberate**, because a criterion *is* a shell command
 *   ("npm test && npm run lint"), and pretending otherwise would only push the
 *   operator into writing `sh -c` themselves. It is safe precisely because of
 *   the sentence above.
 * - **cwd is confined to the workspace**, resolved and re-checked, so a
 *   criterion cannot walk out of the tree it is meant to be verifying.
 * - **The timeout is enforced by killing the process group**, not the shell.
 *   Killing `sh` alone leaves `npm test` running forever, holding the port and
 *   the file locks, with nothing left watching it.
 * - **stdin is closed**, so a command that decides to prompt fails at once
 *   instead of sitting on the timeout.
 * - **Output is capped**, keeping both ends: a compiler puts the error first
 *   and a test runner puts the summary last, and the middle is what nobody
 *   reads.
 */

import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  DOD_COMMAND_OUTPUT_MAX_BYTES,
  clampDodTimeout,
} from "@agent-console/shared";

export interface DodCommandOutcome {
  /** `null` when the process was killed rather than exiting on its own. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, capped. Never null; "" when silent. */
  output: string;
  durationMs: number;
}

/**
 * Head and tail, with a marked gap. A truncation the reader cannot see is a
 * truncation that gets mistaken for the whole output.
 */
export function capOutput(text: string, limit = DOD_COMMAND_OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  const half = Math.floor((limit - 80) / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return `${head}\n\n… ${Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes omitted …\n\n${tail}`;
}

/**
 * Where a criterion is allowed to run: the workspace directory, or something
 * underneath it. An absolute `cwd`, a `..` that climbs out, or a symlink that
 * points elsewhere are all refused by the same check rather than by three.
 */
export function resolveCommandCwd(workDirectory: string, cwd: string | null): string {
  const root = resolve(workDirectory);
  if (cwd === null || cwd.trim() === "") return root;
  if (isAbsolute(cwd)) throw new Error("A definition-of-done directory must be relative to the workspace");
  const target = resolve(root, cwd);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("A definition-of-done directory must stay inside the workspace");
  }
  return target;
}

/** The environment a criterion runs in: the server's, minus its own secrets. */
function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The console's own database location and credentials are not something a
  // verification command has any business reading — and `AGENT_CONSOLE_DB`
  // would point a stray `sqlite3` straight at the file the whole relocation
  // work exists to keep out of reach.
  delete env.AGENT_CONSOLE_DB;
  delete env.AGENT_CONSOLE_DATA_DIR;
  delete env.AGENT_CONSOLE_DATABASE_PATH;
  delete env.DATABASE_URL;
  return env;
}

export async function runDodCommand(args: {
  command: string;
  workDirectory: string;
  cwd: string | null;
  timeoutMs: number;
}): Promise<DodCommandOutcome> {
  const startedAt = Date.now();
  const cwd = resolveCommandCwd(args.workDirectory, args.cwd);
  const timeoutMs = clampDodTimeout(args.timeoutMs);

  return new Promise<DodCommandOutcome>((settle) => {
    const child = spawn(args.command, {
      shell: true,
      cwd,
      env: commandEnv(),
      // Its own process group, so the timeout can take the whole tree the shell
      // started rather than orphaning it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let bytes = 0;
    let timedOut = false;
    let done = false;

    const collect = (chunk: Buffer): void => {
      // Keep collecting a little past the cap so `capOutput` still has a tail
      // worth showing, but not without bound.
      if (bytes > DOD_COMMAND_OUTPUT_MAX_BYTES * 4) return;
      bytes += chunk.length;
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const killTree = (): void => {
      // Negative pid is the process group. It throws once the group is already
      // gone, which is the normal race with a process exiting on its own.
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
      catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({
        exitCode,
        signal,
        timedOut,
        output: capOutput(output.trimEnd()),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("close", (code, signal) => finish(code, signal));
    // A spawn that never started is a failed criterion, not a crashed server:
    // the operator typed a command that is not there, and the message saying so
    // is the evidence they need.
    child.on("error", (error) => {
      output += `${output === "" ? "" : "\n"}${error.message}`;
      finish(null, null);
    });
  });
}

/** Whether an outcome counts as a pass. Exit code only — nothing else votes. */
export function commandPassed(outcome: DodCommandOutcome, expectExitCode: number): boolean {
  return !outcome.timedOut && outcome.exitCode === expectExitCode;
}

/** One line for the operator, next to the criterion that produced it. */
export function describeOutcome(outcome: DodCommandOutcome, expectExitCode: number): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  if (outcome.timedOut) return `Timed out after ${seconds}s and was killed.`;
  if (outcome.exitCode === null) return `Killed by ${outcome.signal ?? "a signal"} after ${seconds}s.`;
  if (outcome.exitCode === expectExitCode) return `Exit ${outcome.exitCode} as expected, in ${seconds}s.`;
  return `Exit ${outcome.exitCode}, expected ${expectExitCode}, after ${seconds}s.`;
}

import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { access, constants } from "node:fs/promises";

/**
 * Resolves a command to an executable path using $PATH — no hardcoded install
 * locations. Returns null when the binary is not on PATH.
 */
export async function resolveBinary(command: string): Promise<string | null> {
  if (command.includes("/") || isAbsolute(command)) {
    return (await isExecutable(command)) ? command : null;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a short-lived command (e.g. `--version`) and captures its output. */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}

/** First non-empty line of `<bin> --version`, or null. */
export async function readVersion(binary: string): Promise<string | null> {
  const result = await runCommand(binary, ["--version"]);
  const text = (result.stdout || result.stderr).trim();
  if (text === "") return null;
  return text.split(/\r?\n/)[0]?.trim() ?? null;
}

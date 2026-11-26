import { win32 } from "node:path";
import { spawn } from "node:child_process";
import type { CommandResult } from "../infrastructure/process.ts";

const INSTALL_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

export function maintenanceEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => INSTALL_ENV.has(key)),
  );
}

export function maintenanceInvocation(
  command: string,
  args: string[],
  platform = process.platform,
) {
  if (
    platform === "win32" &&
    /^npm\.(?:cmd|bat)$/i.test(win32.basename(command))
  ) {
    return {
      command: process.execPath,
      args: [
        win32.join(
          win32.dirname(command),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
        ...args,
      ],
    };
  }
  return { command, args };
}

export function runMaintenanceCommand(
  command: string,
  args: string[],
  timeoutMs = 240_000,
  env: NodeJS.ProcessEnv = maintenanceEnvironment(),
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const invocation = maintenanceInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-16_384);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

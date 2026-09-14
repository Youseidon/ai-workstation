import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/*
 * Harness mode (AGENT_CONSOLE_HARNESS=1) lets the end-to-end harness point the
 * server at fakes and short timeouts. Those seams must never touch the
 * operator's real state, so harness mode refuses to start unless every
 * dependency is provably the harness's own (docs/e2e-harness-plan.md 4.1).
 */

export const HARNESS_GUARD_EXIT_CODE = 78;

export class HarnessGuardError extends Error {
  constructor(
    readonly code: "harness_real_root" | "harness_settings_outside_root" | "harness_non_loopback_url" | "harness_operator_bot",
    message: string,
  ) {
    super(message);
    this.name = "HarnessGuardError";
  }
}

export function isHarnessMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_CONSOLE_HARNESS === "1";
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The harness root must be set explicitly and must not be, or resolve to, the
 * repository root whose `.agent-console` holds the operator's real database.
 */
export function assertHarnessRoot(args: { envRoot: string | undefined; repoRoot: string; settingsFile: string | undefined }): void {
  const envRoot = args.envRoot?.trim();
  if (!envRoot) {
    throw new HarnessGuardError("harness_real_root", "Harness mode requires AGENT_CONSOLE_REPO_ROOT; without it the server would use the repository's real .agent-console.");
  }
  const root = canonical(envRoot);
  const real = canonical(args.repoRoot);
  if (root === real || canonical(resolve(root, ".agent-console")) === canonical(resolve(real, ".agent-console"))) {
    throw new HarnessGuardError("harness_real_root", `Harness mode refuses the repository's real root (${real}).`);
  }
  if (args.settingsFile !== undefined && !isInside(canonical(resolve(root, args.settingsFile)), root)) {
    throw new HarnessGuardError("harness_settings_outside_root", "Harness mode refuses a SETTINGS_FILE outside AGENT_CONSOLE_REPO_ROOT.");
  }
}

/** Fake and proxy URLs in harness mode must be literal loopback addresses. */
export function assertLoopbackUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessGuardError("harness_non_loopback_url", `${name} is not a valid URL.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new HarnessGuardError("harness_non_loopback_url", `${name} must be an http URL on 127.0.0.1 or [::1] in harness mode.`);
  }
  return url;
}

/** The harness may only ever poll a registered test bot, never the operator's own bot. */
export function assertNotOperatorBot(botId: number | string, forbiddenIds: string | undefined): void {
  const forbidden = (forbiddenIds ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (forbidden.includes(String(botId))) {
    throw new HarnessGuardError("harness_operator_bot", `Harness mode refuses bot ${String(botId)}: it is registered as the operator's own bot.`);
  }
}

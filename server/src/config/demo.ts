import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Shared by the login gateway (which creates and expires demo accounts) and
// the account runtime (which seeds one). Kept free of repository imports: the
// gateway must never open an account database.

/** `HYDRA_DEMO=0` hides "Try the demo" and refuses to create demo accounts. */
export function demoEnabled(): boolean {
  return process.env.HYDRA_DEMO?.trim() !== "0";
}

/** Hours a demo account lives before it, its runtime state and its sample folder are deleted. */
export function demoLifetimeHours(): number {
  const value = Number(process.env.HYDRA_DEMO_HOURS ?? 24);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 30) : 24;
}

/**
 * Folder that holds every demo account's sample project. It is a normal
 * folder in the home directory on purpose: agents work in it, so it must
 * never sit inside Hydra's own state directory.
 */
export function demoRoot(): string {
  return resolve(process.env.HYDRA_DEMO_ROOT?.trim() || join(homedir(), "hydra-demo"));
}

export const DEMO_USERNAME = /^demo-[a-z0-9-]{3,60}$/;
/** Written next to a demo project; proves the folder was made by Hydra for that account. */
export const DEMO_OWNER_MARKER = ".hydra-demo-owner";

export function demoAccountDirectory(username: string): string {
  if (!DEMO_USERNAME.test(username)) throw new Error("Not a demo account name");
  return join(demoRoot(), username);
}

/**
 * Deletes a demo account's sample folder, but only when it is a direct child
 * of the demo root and carries the owner marker Hydra wrote for this exact
 * account. Anything else is left alone: a mistaken recursive delete in a home
 * directory is not recoverable.
 */
export function removeDemoFolder(username: string): boolean {
  if (!DEMO_USERNAME.test(username)) return false;
  const directory = demoAccountDirectory(username);
  if (dirname(directory) !== demoRoot()) return false;
  const marker = join(directory, DEMO_OWNER_MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== username) return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
}

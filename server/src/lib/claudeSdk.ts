import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveBinary, runCommand } from "./process.ts";

/*
 * The Claude Agent SDK can be replaced while the server is running.
 *
 * A static `import { query } from "@anthropic-ai/claude-agent-sdk"` is bound
 * for the life of the process, and the copy in node_modules is whatever
 * `npm install` last resolved. An update therefore installs each new version
 * into its own directory under the state dir and imports it by absolute path:
 * a path Node has never loaded is a fresh module, so the next run gets the new
 * SDK while runs already in flight keep the one they started with.
 */

const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const INSTALL_TIMEOUT_MS = 5 * 60_000;

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

export interface LoadedClaudeSdk {
  query: SdkModule["query"];
  version: string | null;
  /** False for the copy in node_modules, true for one installed by an update. */
  managed: boolean;
  /**
   * Whether the Claude Code this SDK launches knows `--effort`. Old SDKs bundle
   * a `cli.js` that rejects the flag before a session is created.
   */
  supportsEffort: boolean;
}

export interface ClaudeSdkUpdate {
  updated: boolean;
  before: string | null;
  after: string | null;
}

function managedRoot(): string {
  const override = process.env.AGENT_CONSOLE_SDK_DIR;
  if (override !== undefined && override.trim() !== "") return resolve(override.trim());
  const state = process.env.XDG_STATE_HOME;
  const base = state !== undefined && state.trim() !== ""
    ? resolve(state.trim())
    : resolve(homedir(), ".local/state");
  return resolve(base, "agent-console/provider-sdk/claude");
}

function packageDirIn(versionDir: string): string {
  return join(versionDir, "node_modules", PACKAGE);
}

function describePackage(packageDir: string): { version: string | null; entry: string; supportsEffort: boolean } {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string; main?: string };
  const cli = join(packageDir, "cli.js");
  return {
    version: typeof pkg.version === "string" ? pkg.version : null,
    entry: join(packageDir, pkg.main ?? "sdk.mjs"),
    // No cli.js means the SDK ships the native Claude Code binary, which is
    // newer than the flag.
    supportsEffort: existsSync(cli) ? readFileSync(cli, "utf8").includes("--effort") : true,
  };
}

async function importPackage(packageDir: string, managed: boolean): Promise<LoadedClaudeSdk> {
  const info = describePackage(packageDir);
  const module = (await import(pathToFileURL(info.entry).href)) as SdkModule;
  if (typeof module.query !== "function") throw new Error(`${PACKAGE} ${info.version ?? "?"} does not export query()`);
  return { query: module.query, version: info.version, managed, supportsEffort: info.supportsEffort };
}

function readActiveVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(managedRoot(), "active.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && /^[\w.-]+$/.test(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

async function loadInitial(): Promise<LoadedClaudeSdk> {
  const active = readActiveVersion();
  if (active !== null) {
    try {
      return await importPackage(packageDirIn(join(managedRoot(), active)), true);
    } catch {
      // A half-removed or broken update must not take Claude down with it.
    }
  }
  const require = createRequire(import.meta.url);
  return importPackage(dirname(require.resolve(`${PACKAGE}/package.json`)), false);
}

let current: Promise<LoadedClaudeSdk> | null = null;

/** The SDK the next Claude run should use. */
export function loadClaudeSdk(): Promise<LoadedClaudeSdk> {
  current ??= loadInitial().catch((error: unknown) => {
    current = null;
    throw error;
  });
  return current;
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-6).join("\n");
}

/** Installs the newest published SDK and makes it the one new runs load. */
export async function installLatestClaudeSdk(): Promise<ClaudeSdkUpdate> {
  const before = (await loadClaudeSdk()).version;
  const npm = await resolveBinary("npm");
  if (npm === null) throw new Error("npm is not on PATH, so the SDK cannot be installed");

  const view = await runCommand(npm, ["view", PACKAGE, "version"], 60_000);
  const latest = view.stdout.trim();
  if (view.code !== 0 || !/^[\w.-]+$/.test(latest)) {
    throw new Error(`Could not read the latest ${PACKAGE} version from npm: ${tail(view.stderr) || "no output"}`);
  }
  if (latest === before) return { updated: false, before, after: before };

  const root = managedRoot();
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-${process.pid}-${Date.now()}`);
  const target = join(root, latest);
  try {
    mkdirSync(staging);
    const install = await runCommand(
      npm,
      ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", `${PACKAGE}@${latest}`],
      INSTALL_TIMEOUT_MS,
    );
    if (install.code !== 0) {
      throw new Error(`npm install ${PACKAGE}@${latest} failed: ${tail(install.stderr) || `exit ${install.code ?? "timeout"}`}`);
    }
    // Rename before importing: the module is identified by its path, and the
    // SDK finds its Claude Code binary relative to where it was loaded from.
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  let loaded: LoadedClaudeSdk;
  try {
    loaded = await importPackage(packageDirIn(target), true);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  const pointer = join(root, "active.json");
  writeFileSync(`${pointer}.tmp`, JSON.stringify({ version: latest }));
  renameSync(`${pointer}.tmp`, pointer);
  current = Promise.resolve(loaded);

  // Runs in flight still hold the previous version; anything older is unused.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === latest || entry.name === before) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
  return { updated: true, before, after: loaded.version };
}

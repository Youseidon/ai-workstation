import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../realState.ts";

export const WEB_DIST_DIR = ".next-e2e";
const webDir = join(repoRoot, "web");

function files(dir: string, skip: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (skip(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, skip) : [path];
  });
}

/** Everything that changes the production bundle: web sources, shared sources, lockfile and the baked server URL. */
export function webSourceHash(serverUrl: string): string {
  const hash = createHash("sha256").update(serverUrl);
  const skip = (name: string) => name === "node_modules" || name.startsWith(".next") || name === "test-results";
  for (const file of [...files(webDir, skip), ...files(join(repoRoot, "shared/src"), skip), join(repoRoot, "package-lock.json")].sort()) {
    hash.update(relative(repoRoot, file)).update(readFileSync(file));
  }
  return hash.digest("hex");
}

export function harnessWebEnv(serverUrl: string, distDir = WEB_DIST_DIR): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    AGENT_CONSOLE_HARNESS: "1",
    AGENT_CONSOLE_WEB_DIST_DIR: distDir,
    AGENT_CONSOLE_WEB_TSCONFIG_PATH: `${distDir}-tsconfig.json`,
    NEXT_PUBLIC_AGENT_SERVER_URL: serverUrl,
  };
}

/** Builds web/.next-e2e unless the cached build already matches the sources. Returns whether it built. */
export function ensureWebBuild(serverUrl: string, logFile: string, distDir = WEB_DIST_DIR): boolean {
  const stampFile = join(webDir, distDir, ".harness-source-hash");
  const hash = webSourceHash(serverUrl);
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === hash) return false;
  // Next updates its configured tsconfig with generated type paths. Keep that
  // harness-only mutation beside the matching build rather than in web/tsconfig.json.
  writeFileSync(join(webDir, `${distDir}-tsconfig.json`), '{\n  "extends": "./tsconfig.json"\n}\n');
  const result = spawnSync(process.execPath, [join(repoRoot, "node_modules/next/dist/bin/next"), "build"], { cwd: webDir, env: harnessWebEnv(serverUrl, distDir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(logFile, `${result.stdout}\n${result.stderr}`, { flag: "a" });
  if (result.status !== 0) throw new Error(`harness web build failed (see ${logFile})`);
  writeFileSync(stampFile, hash);
  return true;
}

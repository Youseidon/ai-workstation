import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { stationPolicyMarkdown, type StationPolicy } from "@hydra/shared";
import { signalProcessTree } from "../infrastructure/resourceContainment.ts";

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const hookScript = fileURLToPath(new URL("../../bin/cursor-policy.mjs", import.meta.url));
const validatedCli = new Set<string>();

/** CLI plugin rules load, but this CLI does not execute plugin hooks. Register
 * the gate at project scope, retaining user hooks and restoring it after exit.
 * Tracked hook files are refused rather than changed behind the operator.
 */
export function installCursorHooks(root: string, manifest: string): () => void {
  const commandPrefix = `${quote(process.execPath)} ${quote(hookScript)} `;
  const hookCommand = commandPrefix + quote(manifest);
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  if (repository.status !== 0 || repository.stdout.trim() !== "true") throw new Error("Protected Cursor runs require a Git workspace so project hooks are loaded reliably");
  const directory = join(realpathSync(root), ".cursor");
  if (existsSync(directory) && realpathSync(directory) !== directory) throw new Error("Refusing a symlinked Cursor policy directory");
  const path = join(directory, "hooks.json");
  if (existsSync(path) && realpathSync(path) !== path) throw new Error("Refusing a symlinked Cursor hook config");
  const original = existsSync(path) ? readFileSync(path, "utf8") : null;
  let before = original;
  const config = original === null ? { version: 1, hooks: {} } : JSON.parse(original);
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new Error("Invalid project Cursor hooks configuration");
  let stale = false;
  for (const event of ["beforeShellExecution", "preToolUse"]) {
    if (Array.isArray(config.hooks[event])) {
      config.hooks[event] = config.hooks[event].filter((h: { command?: string }) => {
        const owned = typeof h.command === "string" && h.command.startsWith(commandPrefix);
        stale ||= owned;
        return !owned;
      });
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }
  }
  // A process crash can leave the previous registration behind. Retire that
  // registration instead of restoring a hook pointing at an expired manifest.
  if (stale) before = Object.keys(config.hooks).length === 0 && Object.keys(config).every(key => ["version", "hooks"].includes(key))
    ? null : JSON.stringify(config, null, 2) + "\n";
  for (const event of ["beforeShellExecution", "preToolUse"]) {
    if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) throw new Error("Invalid Cursor hook list");
    const hooks = config.hooks[event] ?? [];
    if (!hooks.some((h: { command?: string; failClosed?: boolean }) => h.command === hookCommand && h.failClosed === true)) {
      config.hooks[event] = [...hooks, { command: hookCommand, failClosed: true, timeout: 5 }];
    }
  }
  const body = JSON.stringify(config, null, 2) + "\n";
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(config)) return () => {};
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", ".cursor/hooks.json"], { cwd: root, stdio: "ignore" });
  if (tracked.status === 0) throw new Error(`Tracked .cursor/hooks.json cannot be changed for a run-scoped gate. Migrate it explicitly to an ignored project hook configuration before using protected Cursor runs.`);
  let removeExclude = (): void => {};
  const gitPath = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" });
  if (gitPath.status === 0) {
    const exclude = resolve(root, gitPath.stdout.trim());
    const original = (existsSync(exclude) ? readFileSync(exclude, "utf8") : "")
      .replace(/\n# Temporary Cursor policy [a-f0-9-]+\n\/\.cursor\/hooks\.json\n/g, "");
    const marker = `\n# Temporary Cursor policy ${randomUUID()}\n/.cursor/hooks.json\n`;
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, original + marker);
    removeExclude = () => { const current = readFileSync(exclude, "utf8"); writeFileSync(exclude, current.replace(marker, "")); };
  }
  try { mkdirSync(directory, { recursive: true }); writeFileSync(path, body); }
  catch (error) { removeExclude(); throw error; }
  return () => {
    try {
      // Never overwrite a concurrent operator edit. Remove only our own entry.
      if (readFileSync(path, "utf8") === body) {
        if (before === null) rmSync(path); else writeFileSync(path, before);
      } else {
        const current = JSON.parse(readFileSync(path, "utf8"));
        for (const event of ["beforeShellExecution", "preToolUse"]) if (Array.isArray(current.hooks?.[event]))
          current.hooks[event] = current.hooks[event].filter((h: { command?: string }) => h.command !== hookCommand);
        writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
      }
    } finally { removeExclude(); try { rmdirSync(directory); } catch { /* User files remain. */ } }
  };
}

/** Per-run plugin: never overwrite the user's project or global Cursor config. */
export function createCursorPolicy(input: { policy: StationPolicy; root: string; launcher?: string | null }) {
  const directory = mkdtempSync(join(tmpdir(), "hydra-cursor-policy-"));
  const audit = join(directory, "decisions.jsonl");
  try {
    mkdirSync(join(directory, ".cursor-plugin"));
    mkdirSync(join(directory, "hooks"));
    mkdirSync(join(directory, "rules"));
    writeFileSync(join(directory, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "hydra-policy", version: "1.0.0", description: "Run-scoped platform capabilities" }));
    const manifest = join(directory, "policy.json");
    writeFileSync(manifest, JSON.stringify({ ...input, root: realpathSync(input.root), directory, audit }), { mode: 0o600 });
    const command = `${quote(process.execPath)} ${quote(hookScript)} ${quote(manifest)}`;
    writeFileSync(join(directory, "hooks/hooks.json"), JSON.stringify({ version: 1, hooks: {
      beforeShellExecution: [{ command, failClosed: true, timeout: 5 }],
      preToolUse: [{ command, failClosed: true, timeout: 5 }],
    } }));
    writeFileSync(join(directory, "rules/platform.mdc"), `---\nalwaysApply: true\n---\n${stationPolicyMarkdown(input.policy)}`);
    return { directory, audit, manifest, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Prove this CLI loaded and denied our hook with --force before exposing a repo. */
export async function probeCursorPolicy(binary: string, plugin: ReturnType<typeof createCursorPolicy>, model: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Cursor policy probe cancelled");
  // One model-backed conformance check per installed CLI/model/hook revision,
  // rather than adding a billed diagnostic turn to every station and wrap-up.
  const key = `${realpathSync(binary)}:${model}:${createHash("sha256").update(readFileSync(hookScript)).digest("hex")}`;
  if (validatedCli.has(key)) return;
  const probeEnv = { ...process.env, HYDRA_CURSOR_POLICY: plugin.manifest } as NodeJS.ProcessEnv;
  for (const key of ["HYDRA_DATA_DIR", "HYDRA_DATABASE_PATH", "HYDRA_DB", "DATABASE_URL", "SETTINGS_FILE"]) delete probeEnv[key];
  const cwd = mkdtempSync(join(tmpdir(), "hydra-cursor-probe-"));
  // Project hooks are loaded only for a repository in the installed CLI.
  const git = spawnSync("git", ["init", "-q", cwd], { stdio: "ignore" });
  if (git.status !== 0) { rmSync(cwd, { recursive: true, force: true }); throw new Error("Cannot initialize Cursor hook probe repository"); }
  const restoreHooks = installCursorHooks(cwd, plugin.manifest);
  const nonce = `HYDRA_POLICY_PROBE_${randomUUID().replaceAll("-", "")}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["-p", "--trust", "--output-format", "stream-json", "--force", "--sandbox", "enabled", "--plugin-dir", plugin.directory,
        "--model", model, `Use the Shell tool exactly once to run: printf '${nonce}'. This harmless platform diagnostic must be attempted even if a hook refuses it. After the tool result, stop. Do not use any other tools.`],
      { cwd, env: probeEnv, stdio: "ignore", detached: true });
      const stop = (): void => { signalProcessTree(child.pid, "SIGKILL"); };
      const timer = setTimeout(stop, 45_000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("error", error => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(error); });
      child.once("close", () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); });
    });
    if (signal.aborted) throw new Error("Cursor policy probe cancelled");
    let decisions: Array<{ probe?: boolean; permission?: string; event?: string }> = [];
    try { decisions = readFileSync(plugin.audit, "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { /* Missing receipt must fail closed. */ }
    if (!decisions.some(d => d.probe && d.permission === "deny" && ["beforeShellExecution", "preToolUse"].includes(d.event ?? ""))) {
      throw new Error("Cursor did not demonstrate a working command-policy hook. Refusing to expose the workspace. Check CLI hook/plugin support and authentication.");
    }
    validatedCli.add(key);
  } finally { restoreHooks(); rmSync(cwd, { recursive: true, force: true }); }
}

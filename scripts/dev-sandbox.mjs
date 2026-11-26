import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { copySandboxAccounts } from "./lib/sandbox-accounts.mjs";

const SANDBOX = "/tmp/hydra-sandbox/hydra.sqlite";
const SANDBOX_SETTINGS = "/tmp/hydra-sandbox/settings.json";
const SERVER_PORT = "4100";
const WEB_PORT = "3100";

function liveDatabasePath() {
  const explicit = process.env.HYDRA_DB;
  if (explicit !== undefined && explicit.trim() !== "") return resolve(explicit.trim());
  const state = process.env.XDG_STATE_HOME;
  const base = state !== undefined && state.trim() !== "" ? resolve(state.trim()) : resolve(homedir(), ".local/state");
  const current = resolve(base, "hydra/hydra.sqlite");
  const preRename = resolve(base, "agent-console/console.sqlite");
  return !existsSync(current) && existsSync(preRename) ? preRename : current;
}

const keep = process.argv.includes("--keep");
const live = liveDatabasePath();
const reuse = keep && existsSync(SANDBOX);
mkdirSync(dirname(SANDBOX), { recursive: true });

for (const path of [`${SANDBOX}.lock`, `${SANDBOX}.identity.lock`]) {
  if (!existsSync(path)) continue;
  let pid;
  try {
    const text = readFileSync(path, "utf8").trim();
    pid = text.startsWith("{") ? JSON.parse(text).pid : Number(text);
  } catch { continue; }
  if (!Number.isInteger(pid) || pid <= 0) continue;
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { alive = error.code === "EPERM"; }
  if (alive) throw new Error(`Sandbox is already running (pid ${pid}); stop it before starting another copy.`);
}

if (reuse) {
  console.log(`sandbox  reusing ${SANDBOX}`);
} else if (existsSync(live)) {
  copyFileSync(live, SANDBOX);
  rmSync(`${SANDBOX}-wal`, { force: true });
  rmSync(`${SANDBOX}-shm`, { force: true });
  if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${SANDBOX}-wal`);
  console.log(`sandbox  copied ${live}`);
} else {
  console.log(`sandbox  no database at ${live} — starting empty`);
}

if (!reuse) copySandboxAccounts(live, SANDBOX);
if (!reuse || !existsSync(SANDBOX_SETTINGS)) {
  const savedSettings = resolve(process.env.SETTINGS_FILE ?? ".hydra/settings.json");
  if (existsSync(savedSettings)) copyFileSync(savedSettings, SANDBOX_SETTINGS);
  else writeFileSync(SANDBOX_SETTINGS, "{}\n", { mode: 0o600 });
  chmodSync(SANDBOX_SETTINGS, 0o600);
}

console.log(`sandbox  server  http://127.0.0.1:${SERVER_PORT}`);
console.log(`sandbox  web     http://localhost:${WEB_PORT}`);
console.log(`sandbox  this is a sandbox; the live database is untouched`);

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HYDRA_DB: SANDBOX,
    SETTINGS_FILE: SANDBOX_SETTINGS,
    PORT: SERVER_PORT,
    WEB_PORT,
    NEXT_PUBLIC_AGENT_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
    ALLOWED_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
  },
});

child.on("exit", (code, signal) => process.exit(signal === null ? code ?? 0 : 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

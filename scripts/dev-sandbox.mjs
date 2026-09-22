/*
 * Development against a copy of the live database, on ports of its own.
 *
 * `npm run dev` runs the server under `tsx watch`, so saving a file restarts it
 * — killing every agent in flight and applying any new migration to whatever
 * database it is pointed at. 22 of the owner's first 34 pipeline runs died that
 * way. The server refuses to start under watch against the default database at
 * all; this is the other half, the one that makes doing it right a single
 * command.
 *
 * Pass --keep to reuse an existing copy instead of taking a fresh one, which is
 * what you want when you are iterating on a migration you have already applied.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const SANDBOX = "/tmp/agent-console-sandbox/console.sqlite";
const SERVER_PORT = "4100";
const WEB_PORT = "3100";

/** Same resolution as `server/src/workspaces.ts`, so both find one database. */
function liveDatabasePath() {
  const explicit = process.env.AGENT_CONSOLE_DB;
  if (explicit !== undefined && explicit.trim() !== "") return resolve(explicit.trim());
  const state = process.env.XDG_STATE_HOME;
  const base = state !== undefined && state.trim() !== "" ? resolve(state.trim()) : resolve(homedir(), ".local/state");
  return resolve(base, "agent-console/console.sqlite");
}

const keep = process.argv.includes("--keep");
const live = liveDatabasePath();
mkdirSync(dirname(SANDBOX), { recursive: true });

if (keep && existsSync(SANDBOX)) {
  console.log(`sandbox  reusing ${SANDBOX}`);
} else if (existsSync(live)) {
  // The WAL comes too, or the copy is missing every write since the last
  // checkpoint — which on a busy console is most of today's work. The SHM is
  // deliberately left behind: SQLite rebuilds it, and a stale one is worse than
  // none. Any previous WAL is removed so it cannot be paired with a new copy.
  copyFileSync(live, SANDBOX);
  rmSync(`${SANDBOX}-wal`, { force: true });
  rmSync(`${SANDBOX}-shm`, { force: true });
  if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${SANDBOX}-wal`);
  console.log(`sandbox  copied ${live}`);
} else {
  console.log(`sandbox  no database at ${live} — starting empty`);
}

console.log(`sandbox  server  http://127.0.0.1:${SERVER_PORT}`);
console.log(`sandbox  web     http://localhost:${WEB_PORT}`);
console.log(`sandbox  this is a sandbox; the live database is untouched`);

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENT_CONSOLE_DB: SANDBOX,
    PORT: SERVER_PORT,
    WEB_PORT,
    NEXT_PUBLIC_AGENT_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
    // The web origin moved with the port, so the socket upgrade has to be told.
    ALLOWED_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
  },
});

child.on("exit", (code, signal) => process.exit(signal === null ? code ?? 0 : 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

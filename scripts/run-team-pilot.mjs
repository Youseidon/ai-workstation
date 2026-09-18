#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const envPath = resolve(repoRoot, ".env");

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { /* The server's dotenv parser will report malformed values. */ }
    }
    values[match[1]] = value;
  }
  return values;
}

let values;
try {
  values = parseEnv(await readFile(envPath, "utf8"));
} catch {
  throw new Error("Missing .env. Run npm run setup:team-pilot first.");
}

if ((values.TELEGRAM_BOT_TOKEN ?? "").trim() === "") {
  throw new Error("TELEGRAM_BOT_TOKEN is empty. Set it locally in .env before starting the pilot.");
}
if (values.TEAM_ENABLED !== "false") {
  throw new Error("TEAM_ENABLED must remain false in .env; enable Team explicitly from the Agents page after pairing.");
}

const childEnv = { ...process.env };
for (const key of [
  "HOST",
  "PORT",
  "WEB_PORT",
  "AGENT_API_BASE_URL",
  "NEXT_PUBLIC_AGENT_SERVER_URL",
  "ALLOWED_ORIGINS",
  "AGENT_CONSOLE_REPO_ROOT",
  "AGENT_CONSOLE_HARNESS",
  "AGENT_CONSOLE_WEB_DIST_DIR",
  "AGENT_CONSOLE_WEB_TSCONFIG_PATH",
  "SETTINGS_FILE",
  "AGENT_HOST_ACCESS",
  "TASK_CONTROL_ENABLED",
  "TASK_CONTROL_NOTIFICATIONS_ENABLED",
  "TASK_CONTROL_REMOTE_ACTIONS_ENABLED",
  "TASK_CONTROL_TRANSPORT",
  "TASK_CONTROL_WORKSTATION_LABEL",
  "TEAM_ENABLED",
  "TELEGRAM_BOT_TOKEN",
]) delete childEnv[key];
childEnv.WEB_PORT = values.WEB_PORT;

const child = spawn("npm", ["run", "dev"], {
  cwd: repoRoot,
  // The server and Next config read the local .env themselves. Export only the
  // web port needed by package.json; never fan the bot token into the process tree.
  env: childEnv,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

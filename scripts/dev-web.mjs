#!/usr/bin/env node
/*
 * B3. `dev:web` used to resolve its port with the shell expansion
 * `${WEB_PORT:-3000}`, and npm does not load `.env`. So a plain `npm run dev` in
 * a pilot checkout served 3000 while the server read `.env` and allowed only the
 * configured origin. The only evidence was one line about a rejected websocket
 * upgrade, and REST calls failed silently in the browser because `applyCors`
 * omits the header for an unlisted origin - a wrong port that names neither the
 * port nor the cause.
 *
 * The port is now resolved here, where `.env` can be read, and the source of the
 * value is printed. An explicit environment variable still wins, which is how
 * `dev:team-pilot` passes the pilot's port.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const DEFAULT_PORT = 3000;

function envFilePort() {
  try {
    const text = readFileSync(resolve(repoRoot, ".env"), "utf8");
    const match = /^\s*WEB_PORT\s*=\s*(.*)$/m.exec(text);
    if (!match) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined; // No .env is the ordinary case outside a pilot checkout.
  }
}

function resolvePort() {
  const fromShell = (process.env.WEB_PORT ?? "").trim();
  if (fromShell !== "") return { value: fromShell, source: "WEB_PORT in the environment" };
  const fromFile = envFilePort();
  if (fromFile !== undefined && fromFile !== "") return { value: fromFile, source: "WEB_PORT in .env" };
  return { value: String(DEFAULT_PORT), source: "the default" };
}

const { value, source } = resolvePort();
const port = Number.parseInt(value, 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error(`dev:web: ${source} is "${value}", which is not a TCP port between 1 and 65535.`);
  process.exit(1);
}

// Said out loud, because the failure this replaces was silent.
console.log(`dev:web: serving the web app on port ${port}, from ${source}.`);

const child = spawn("npm", ["run", "dev", "--workspace", "web", "--", "--port", String(port)], {
  cwd: repoRoot,
  env: { ...process.env, WEB_PORT: String(port) },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

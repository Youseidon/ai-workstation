import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const serverFile = join(repoRoot, "server/src/index.ts");
const webFile = join(repoRoot, "web/app/page.tsx");
const starts = Number.parseInt(process.env.DEV_RELOAD_STARTS ?? "6", 10);
const serverPort = Number.parseInt(process.env.DEV_RELOAD_SERVER_PORT ?? "4300", 10);
const webPort = Number.parseInt(process.env.DEV_RELOAD_WEB_PORT ?? "3300", 10);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

if (!Number.isSafeInteger(starts) || starts < 1) {
  throw new Error("DEV_RELOAD_STARTS must be a positive integer.");
}
for (const [name, port] of [["DEV_RELOAD_SERVER_PORT", serverPort], ["DEV_RELOAD_WEB_PORT", webPort]]) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port.`);
  }
}

const originalServer = await readFile(serverFile, "utf8");
const originalWeb = await readFile(webFile, "utf8");
const tempRoot = await mkdtemp(join(tmpdir(), "agent-console-dev-reload-"));

const baseHealth = "sendJson(res, 200, { ok: true });";
const examplePattern = /"Dev reload probe [^"]+"|"Summarise the repo layout and the main entry points\."/;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(label, check, timeoutMs = 60_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

function patchServer(source, token) {
  const replacement = `sendJson(res, 200, { ok: true, devReloadProbe: ${JSON.stringify(token)} });`;
  if (source.includes(baseHealth)) return source.replace(baseHealth, replacement);
  return source.replace(/sendJson\(res, 200, \{ ok: true, devReloadProbe: "dev-reload-[^"]+" \}\);/, replacement);
}

function patchWeb(source, token) {
  return source.replace(examplePattern, JSON.stringify(`Dev reload probe ${token}`));
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function assertPortFree(port) {
  await new Promise((resolveFree, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(`Port ${port} is not available: ${error.code ?? error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close(resolveFree));
  });
}

async function stopDev(child) {
  if (child.exitCode !== null) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(10_000).then(() => false),
  ]);
  if (exited !== false) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(5_000),
  ]);
}

async function runCycle(index) {
  await writeFile(serverFile, originalServer);
  await writeFile(webFile, originalWeb);

  const child = spawn("npm", ["run", "dev"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      AGENT_CONSOLE_REPO_ROOT: tempRoot,
      PORT: String(serverPort),
      WEB_PORT: String(webPort),
      AGENT_API_BASE_URL: serverUrl,
      ALLOWED_ORIGINS: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
      NEXT_PUBLIC_AGENT_SERVER_URL: serverUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let log = "";
  const capture = (chunk) => {
    log += chunk;
    if (log.length > 40_000) log = log.slice(-40_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const exitPromise = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  try {
    await waitFor(`cycle ${index} server ready`, async () => {
      const health = await fetchJson(`${serverUrl}/api/health`);
      return health.ok === true;
    });
    await waitFor(`cycle ${index} web ready`, async () => {
      const html = await fetchText(webUrl);
      return html.includes("Summarise the repo layout");
    });

    const token = `dev-reload-${index}-${Date.now()}`;
    await writeFile(serverFile, patchServer(await readFile(serverFile, "utf8"), token));
    await waitFor(`cycle ${index} server reload`, async () => {
      const health = await fetchJson(`${serverUrl}/api/health`);
      return health.devReloadProbe === token;
    });

    await writeFile(webFile, patchWeb(await readFile(webFile, "utf8"), token));
    await waitFor(`cycle ${index} web reload`, async () => {
      const html = await fetchText(webUrl);
      return html.includes(`Dev reload probe ${token}`);
    });

    console.log(`cycle ${index}/${starts}: PASS server and web reloaded after source edits`);
  } catch (error) {
    const maybeExit = await Promise.race([exitPromise, sleep(0).then(() => null)]);
    const exitLine = maybeExit ? `\nprocess exit: ${JSON.stringify(maybeExit)}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${exitLine}\n--- dev log tail ---\n${log}`);
  } finally {
    await stopDev(child);
  }
}

try {
  if (serverPort === webPort) throw new Error("Server and web ports must differ.");
  await assertPortFree(serverPort);
  await assertPortFree(webPort);
  console.log(`checking npm run dev reload across ${starts} starts on ${serverUrl} and ${webUrl}`);
  for (let index = 1; index <= starts; index += 1) {
    await runCycle(index);
  }
  console.log(`PASS ${starts}/${starts} repeated npm run dev starts reloaded server and web source changes`);
} finally {
  await writeFile(serverFile, originalServer);
  await writeFile(webFile, originalWeb);
  await rm(tempRoot, { recursive: true, force: true });
}

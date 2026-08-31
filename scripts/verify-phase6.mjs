import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const backend = "http://127.0.0.1:4000";
const frontend = "http://localhost:3000";
const cdpPort = process.env.CDP_PORT ?? "9227";
const checks = [];
const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };

async function cdp() {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
  const target = targets.find((item) => item.type === "page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(String(raw));
    if (value.id && pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); }
    if (value.method === "Runtime.exceptionThrown") exceptions.push(value.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, (value) => value.error ? reject(new Error(value.error.message)) : resolve(value.result));
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await send("Page.enable"); await send("Runtime.enable");
  return { send, socket, exceptions };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function navigate(client, path) {
  await client.send("Page.navigate", { url: `${frontend}${path}` });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await evaluate(client, `document.readyState === 'complete' && document.body.innerText.toLowerCase().includes('agent console')`)) return;
  }
  throw new Error(`${path} did not finish rendering`);
}

let workspaceId;
let directory;
const pushed = new WebSocket("ws://127.0.0.1:4000/ws");
try {
  await new Promise((resolve, reject) => { pushed.once("open", resolve); pushed.once("error", reject); });
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("operations_changed was not pushed")), 2000);
    pushed.on("message", (raw) => {
      if (JSON.parse(String(raw)).kind === "operations_changed") { clearTimeout(timeout); resolve(); }
    });
  });
  directory = await mkdtemp(join(tmpdir(), "agent-console-phase6-"));
  const created = await fetch(`${backend}/api/workspaces`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `phase6-${Date.now()}`, description: "temporary verification", workDirectory: directory }),
  });
  assert(created.ok, "temporary workspace created");
  workspaceId = (await created.json()).workspace.id;
  await changed;
  assert(true, "operations_changed pushed after mutation");

  const client = await cdp();
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [theme, path] of [["midnight", "/operations"], ["deep", "/fleet"], ["daylight", "/"]]) {
    await navigate(client, path);
    await evaluate(client, `localStorage.setItem('agent-console.theme', '${theme}'); document.documentElement.dataset.theme='${theme}'`);
    const state = await evaluate(client, `({ title: document.title, text: document.body.innerText.slice(0,4000), buttons: [...document.querySelectorAll('button')].every(b => b.type === 'button' || b.closest('form')), theme: document.documentElement.dataset.theme })`);
    assert(state.theme === theme, `${theme} theme applied`);
    assert(state.text.toLowerCase().includes("agent console"), `${path} rendered app chrome`);
    assert(state.buttons, `${path} buttons have explicit or form-safe types`);
    const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(tmpdir(), `agent-console-phase6-${theme}.png`), Buffer.from(shot.data, "base64"));
  }
  await evaluate(client, `document.documentElement.dataset.effects='reduced'`);
  const reduced = await evaluate(client, `getComputedStyle(document.querySelector('*'), '::before').animationIterationCount`);
  assert(reduced === "1", "app reduced-effects switch freezes animation");
  assert(client.exceptions.length === 0, "no uncaught browser exceptions");
  client.socket.close();
} finally {
  pushed.close();
  if (workspaceId !== undefined) await fetch(`${backend}/api/workspaces/${workspaceId}`, { method: "DELETE" });
  if (directory !== undefined) await rm(directory, { recursive: true });
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`✓ ${check}`);

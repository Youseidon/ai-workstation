import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterEvent } from "@hydra/shared";
import { SpawnAdapter, type SpawnSpec } from "../../../src/providers/adapters/spawnAdapter.ts";
import { CodexStreamMapper } from "../../../src/providers/streams/codexStream.ts";
import { KiloStreamMapper } from "../../../src/providers/streams/kiloStream.ts";
import { KiloMapper } from "../../../src/providers/adapters/kilocode.ts";
import type { RunOptions } from "../../../src/contracts/agentAdapter.ts";
import { createLogger } from "../../../src/utils/logger.ts";

const fixture = fileURLToPath(new URL("../../fixtures/stream-provider.mjs", import.meta.url));
class FixtureAdapter extends SpawnAdapter {
  readonly id = "codex" as const;
  readonly label = "Streaming fixture";
  readonly reportsTokens = false;
  readonly permissionMode = "read-only";
  readonly model = null;
  protected readonly binaryName = process.execPath;
  protected missingBinaryReason() { return "Node missing"; }
  protected async checkAuth() { return null; }
  constructor(private readonly mode: "codex" | "kilo", private readonly directory: string, private readonly scenario: string, private readonly agent: "plan" | "code", private readonly resume: boolean) { super(); }
  protected buildSpec(prompt: string, opts: RunOptions): SpawnSpec {
    return { args: [fixture, this.mode], interactive: true,
      env: { FIXTURE_SCENARIO: this.scenario, FIXTURE_LOG: join(this.directory, "requests.jsonl"), FIXTURE_FINISHED: join(this.directory, "finished") },
      mapper: this.mode === "codex"
        ? new CodexStreamMapper({ prompt, cwd: opts.cwd, model: "test-model", sandbox: "read-only", effort: "low", startupTimeoutMs: this.scenario === "timeout" ? 80 : 5_000, resumeSessionId: this.resume ? "old-thread" : null, apiKey: this.scenario === "api-key" ? "fixture-api-key" : undefined })
        : new KiloStreamMapper({ prompt, cwd: opts.cwd, password: "fixture-password", agent: this.agent, autoApprove: true, model: "test/model", variant: "low", startupTimeoutMs: 5_000, resumeSessionId: this.resume ? "ses_mock" : null }, new KiloMapper()),
    };
  }
}

async function runFixture(mode: "codex" | "kilo", scenario = "normal", stop = false, agent: "plan" | "code" = "plan", resume = false) {
  const directory = await mkdtemp(join(tmpdir(), "native-stream-"));
  const adapter = new FixtureAdapter(mode, directory, scenario, agent, resume);
  const runId = `fixture-${mode}-${Date.now()}`;
  const events: AdapterEvent[] = [];
  let sawLiveText = false;
  let stopping: Promise<void> | undefined;
  try {
    for await (const event of adapter.run("Test prompt", { runId, cwd: directory, model: null, permissionOverride: "consult", signal: new AbortController().signal, log: createLogger("stream-test") })) {
      events.push(event);
      if (!sawLiveText && event.type === "assistant_text" && event.payload.kind === "message") {
        sawLiveText = true;
        assert.equal(existsSync(join(directory, "finished")), false, "text must arrive while the provider is still generating");
        assert.equal(event.payload.text, "First 🌊");
        if (stop) stopping = adapter.interrupt(runId);
      }
    }
    await stopping;
    const requests = (await readFile(join(directory, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const pid = requests[0]?.pid as number;
    assert.equal(requests[0]?.cwd, directory, "provider runs in the selected workspace under every containment mode");
    assert.deepEqual(requests[0]?.serverOnlyEnv, [], "server-only persistence capabilities are not forwarded");
    // Cleanup is synchronous with generator completion, but process reaping may
    // take a tick after SIGKILL; wait for the actual child close.
    for (let n = 0; n < 100; n++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), "provider subprocess must be cleaned up");
    return { events, requests, sawLiveText };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const mode of ["codex", "kilo"] as const) {
  test(`${mode}: real subprocess transport delivers partial text before terminal output and cleans up`, async () => {
    const { events, requests, sawLiveText } = await runFixture(mode);
    assert.equal(sawLiveText, true);
    const replies = events.filter(event => event.type === "assistant_text" && event.payload.kind === "message");
    assert.equal(replies.map(event => event.type === "assistant_text" ? event.payload.text : "").join(""), "First 🌊 words");
    assert.equal(events.some(event => event.type === "assistant_text" && /LEAK|OLD HISTORY/.test(event.payload.text)), false);
    assert.equal(events.filter(event => event.type === "result").length, 1);
    const result = events.at(-1);
    assert.equal(result?.type === "result" && result.payload.state, "done");
    if (mode === "kilo") assert.deepEqual(requests.slice(1, 4).map(request => request.path), ["/event", "/session", "/session/ses_mock/prompt_async"]);
  });
  test(`${mode}: native Stop preserves partial output and settles once`, async () => {
    const { events, sawLiveText } = await runFixture(mode, "normal", true);
    assert.equal(sawLiveText, true);
    const results = events.filter(event => event.type === "result");
    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(result?.type === "result" && result.payload.state, "interrupted");
    assert.equal(result?.type === "result" && result.payload.text, "First 🌊");
  });
}

test("a provider that ignores native Stop is force-killed and settles once", async () => {
  const { events } = await runFixture("codex", "hang", true);
  const results = events.filter(event => event.type === "result");
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result?.type === "result" && result.payload.state, "interrupted");
});

test("Codex timeout, invalid JSON and premature exit fail without a fake successful result", async () => {
  for (const scenario of ["timeout", "invalid", "exit"]) {
    const { events } = await runFixture("codex", scenario);
    const result = events.find(event => event.type === "result");
    assert.equal(result?.type === "result" && result.payload.state, "error");
    assert.equal(events.filter(event => event.type === "result").length, 1);
  }
});

test("Kilo dropped SSE preserves partial text and never retries a writable prompt", async () => {
  const { events, requests, sawLiveText } = await runFixture("kilo", "disconnect");
  assert.equal(sawLiveText, true);
  assert.equal(requests.filter(request => String(request.path).endsWith("prompt_async")).length, 1);
  const result = events.find(event => event.type === "result");
  assert.equal(result?.type === "result" && result.payload.state, "error");
});

test("Kilo permissions preserve plan restrictions even when execute auto-approval is enabled", async () => {
  for (const agent of ["plan", "code"] as const) {
    const { requests } = await runFixture("kilo", "permission", false, agent);
    const permission = requests.find(request => request.path === "/permission/per_mock/reply");
    assert.equal((permission?.body as Record<string, unknown>).reply, agent === "plan" ? "reject" : "once");
  }
});

test("both native transports resume the requested session with current run settings", async () => {
  const codex = await runFixture("codex", "normal", false, "plan", true);
  assert.ok(codex.requests.some(request => (request.request as Record<string, unknown> | undefined)?.method === "thread/resume"));
  const kilo = await runFixture("kilo", "normal", false, "plan", true);
  assert.equal(kilo.requests.some(request => request.path === "/session" && request.method === "POST"), false);
  const prompt = kilo.requests.find(request => String(request.path).endsWith("prompt_async"));
  assert.equal((prompt?.body as Record<string, unknown>).agent, "plan");
  assert.deepEqual((prompt?.body as Record<string, unknown>).model, { providerID: "test", modelID: "model" });
});

test("Codex API-key authentication precedes thread creation and never appears in output", async () => {
  const { events, requests } = await runFixture("codex", "api-key");
  const methods = requests.map(request => (request.request as Record<string, unknown> | undefined)?.method).filter(Boolean);
  assert.ok(methods.indexOf("account/login/start") < methods.indexOf("thread/start"));
  assert.equal(JSON.stringify(events).includes("fixture-api-key"), false);
});

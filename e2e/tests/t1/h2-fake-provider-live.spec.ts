import { readFileSync } from "node:fs";
import type { ProviderInfo } from "@agent-console/shared";
import { expect, serverUrl, test } from "../../src/fixtures.ts";
import { eventually, state } from "../../src/drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../../src/scenarios.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. Live Progress API path.
test.use({ harnessOptions: { fakeProvider: "live" } });

test("S-H2-01: detection runs the fake like the real binary and never reads the operator's Grok login", async ({ harness }) => {
  const { providers } = (await (await fetch(`${serverUrl}/api/providers?refresh=1`)).json()) as { providers: ProviderInfo[] };
  const grok = providers.find((provider) => provider.id === "grok");
  expect(grok?.available).toBe(true);
  expect(grok?.version).toBe("grok 1.0.5");
  const server = readEnv(harness.server.pid);
  expect(server.HOME).toBe(harness.homeDir);
});

test("S-H2-04: a done scenario fetches context, posts a remark and DONE over HTTP to 4100 only", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { content: "Add a CHANGELOG line for release 7.", scenarios: [{ behavior: "done", remark: "Wrote the changelog line." }] });
  const session = await waitForRunEnd(task, runId);
  expect(session.state.toUpperCase()).toBe("DONE");
  expect((await state.prompt(task)).status).toBe("DONE");
  const history = await state.history(task);
  expect(history.remarks.filter((remark) => remark.kind === "PROGRESS" && remark.content === "Wrote the changelog line.")).toHaveLength(1);
  expect(history.events.filter((event) => event.newStatus === "DONE" && event.actorType === "AGENT")).toHaveLength(1);
  const log = harness.fakeProvider.log();
  expect(log.find((entry) => entry.event === "start")?.path).toBe("live");
  expect(log.find((entry) => entry.event === "context")?.chars).toBeGreaterThan(0);
  const calls = log.filter((entry) => entry.event === "http");
  expect(calls.map((entry) => `${entry.method} ${String(entry.path).replace(/runs\/[^/]+/, "runs/:id")}`)).toEqual(["GET /api/agent/runs/:id/context", "POST /api/agent/runs/:id/remarks", "POST /api/agent/runs/:id/status"]);
  expect(new Set(calls.map((entry) => entry.host))).toEqual(new Set(["127.0.0.1:4100"]));
});

test("S-H2-05: a block-on-decision scenario leaves the prompt BLOCKED by the agent with exactly one run", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "block-on-decision", reason: "Two release names are possible.", humanAction: "Pick Aurora or Borealis." }] });
  await waitForRunEnd(task, runId);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  const history = await state.history(task);
  const blocked = history.events.filter((event) => event.newStatus === "BLOCKED");
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.actorType).toBe("AGENT");
  expect(blocked[0]?.verificationSummary).toBe("Pick Aurora or Borealis.");
  expect(await state.sessionsFor(task)).toHaveLength(1);
});

test("S-H2-06: a failing agent ends ERROR and the prompt is BLOCKED by the system", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "fail" }] });
  const session = await waitForRunEnd(task, runId);
  expect(session.state.toUpperCase()).toBe("ERROR");
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  const system = (await state.history(task)).events.find((event) => event.newStatus === "BLOCKED");
  expect(system?.actorType).toBe("SYSTEM");
  expect(system?.reason).toMatch(/without posting the required DONE or BLOCKED status/);
});

test("S-H2-10: a crash after spawn ends ERROR, releases the start intent and leaves no process", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "crash-after-spawn" }] });
  const session = await waitForRunEnd(task, runId);
  expect(session.state.toUpperCase()).toBe("ERROR");
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  const pid = harness.fakeProvider.log().find((entry) => entry.event === "crash")?.pid as number;
  expect(isAlive(pid)).toBe(false);
  const errors = session.events.filter((event) => event.type === "error").map((event) => (event.payload as { message: string }).message);
  expect(errors.some((message) => /exited unexpectedly .*signal SIGKILL/.test(message))).toBe(true);
  const intents = harness.query<{ state: string; released_at: string | null }>("SELECT state, released_at FROM workspace_start_intent WHERE id = ?", runId);
  expect(intents).toHaveLength(1);
  expect(intents[0]?.state).toBe("KNOWN_STOPPED");
  expect(intents[0]?.released_at).not.toBeNull();
});

test("S-H2-11: Stop interrupts a hanging agent, and a SIGINT-ignoring agent is killed", async ({ harness }) => {
  for (const ignoreSigint of [false, true]) {
    const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "hang-until-stopped", ignoreSigint }] });
    await eventually("fake agent to be running", async () => harness.fakeProvider.log().some((entry) => entry.event === "start" && entry.behavior === "hang-until-stopped" && !isHandled(harness, entry.pid as number)));
    const pid = harness.fakeProvider.log().filter((entry) => entry.event === "start").at(-1)?.pid as number;
    await state.interrupt(runId);
    const session = await waitForRunEnd(task, runId);
    expect(session.state.toUpperCase()).toBe("INTERRUPTED");
    expect(harness.fakeProvider.log().some((entry) => entry.event === "signal" && entry.pid === pid && entry.ignored === ignoreSigint)).toBe(true);
    await eventually("fake agent process to exit", async () => !isAlive(pid));
  }
});

test("S-H2-12: the fake checks what the agent actually received and fails when it is absent", async ({ harness }) => {
  const present = await runSavedTask(harness, { content: "Use the codename KESTREL-42 in the notes.", scenarios: [{ behavior: "consume-answer", expectInContext: "KESTREL-42" }] });
  await waitForRunEnd(present.task, present.runId);
  expect((await state.prompt(present.task)).status).toBe("DONE");
  const absent = await runSavedTask(harness, { content: "Nothing special here.", scenarios: [{ behavior: "consume-answer", expectInContext: "KESTREL-42" }] });
  const session = await waitForRunEnd(absent.task, absent.runId);
  expect(session.state.toUpperCase()).toBe("ERROR");
  expect((await state.prompt(absent.task)).status).toBe("BLOCKED");
});

function readEnv(pid: number | null): Record<string, string> {
  return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHandled(harness: { fakeProvider: { log(): Array<{ event: string; pid?: unknown }> } }, pid: number): boolean {
  return harness.fakeProvider.log().some((entry) => entry.event === "signal" && entry.pid === pid);
}

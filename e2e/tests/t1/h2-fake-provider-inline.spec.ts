import { expect, test } from "../../src/fixtures.ts";
import { state } from "../../src/drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../../src/scenarios.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. Inline path: sandboxed provider, no Progress API.
test.use({ harnessOptions: { fakeProvider: "inline" } });

test("S-H2-07: done on the inline path embeds context, makes no HTTP call and applies the final status block", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { content: "Rename the INSTALL section to Setup.", scenarios: [{ behavior: "consume-answer", expectInContext: "Rename the INSTALL section to Setup." }] });
  const session = await waitForRunEnd(task, runId);
  expect(session.state.toUpperCase()).toBe("DONE");
  expect((await state.prompt(task)).status).toBe("DONE");
  const log = harness.fakeProvider.log();
  expect(log.find((entry) => entry.event === "start")?.path).toBe("inline");
  expect(log.filter((entry) => entry.event === "http")).toEqual([]);
  const done = harness.query<{ request_id: string }>("SELECT request_id FROM agent_command WHERE run_id = ? AND operation = 'status'", runId);
  expect(done.map((row) => row.request_id)).toEqual(["offline-status-final"]);
});

test("S-H2-08: blocked on the inline path records the reason and human action", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "block-on-decision", reason: "The licence choice is the owner's.", humanAction: "Choose MIT or Apache-2.0." }] });
  await waitForRunEnd(task, runId);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  const blocked = (await state.history(task)).events.filter((event) => event.newStatus === "BLOCKED");
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.actorType).toBe("AGENT");
  expect(blocked[0]?.reason).toBe("The licence choice is the owner's.");
  expect(blocked[0]?.verificationSummary).toBe("Choose MIT or Apache-2.0.");
});

test("S-H2-09: a crash, a malformed status block or no block never produce DONE", async ({ harness }) => {
  for (const scenario of [{ behavior: "fail" as const }, { behavior: "done" as const, malformedStatus: true }, { behavior: "done" as const, skipStatus: true }]) {
    const { task, runId } = await runSavedTask(harness, { scenarios: [scenario] });
    const session = await waitForRunEnd(task, runId);
    expect(session.state.toUpperCase()).toBe(scenario.behavior === "fail" ? "ERROR" : "DONE");
    expect((await state.prompt(task)).status).toBe("BLOCKED");
    const event = (await state.history(task)).events.find((item) => item.newStatus === "BLOCKED");
    expect(event?.actorType).toBe("SYSTEM");
    expect(event?.reason).toMatch(scenario.behavior === "fail" ? /ended error without posting/ : /ended done without posting/);
  }
});

test("S-H2-14: an empty scenario queue makes the fake fail fast instead of hanging", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [] });
  const session = await waitForRunEnd(task, runId, 20_000);
  expect(session.state.toUpperCase()).toBe("ERROR");
  expect(harness.fakeProvider.log().some((entry) => entry.event === "fatal" && /scenario queue is empty|no scenario queued/.test(String(entry.message)))).toBe(true);
});

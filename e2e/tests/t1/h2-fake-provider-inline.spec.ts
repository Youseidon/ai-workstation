import { expect, test } from "../../src/fixtures.ts";
import { state } from "../../src/drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../../src/scenarios.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. Inline path: sandboxed provider, no Progress API.
test.use({ harnessOptions: { fakeProvider: "inline" } });

test("S-H2-07: done on the offline channel embeds context, is given no launcher and applies the final status block", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { content: "Rename the INSTALL section to Setup.", scenarios: [{ behavior: "consume-answer", expectInContext: "Rename the INSTALL section to Setup." }] });
  const session = await waitForRunEnd(task, runId);
  expect(session.state.toUpperCase()).toBe("DONE");
  expect((await state.prompt(task)).status).toBe("DONE");
  const log = harness.fakeProvider.log();
  const start = log.find((entry) => entry.event === "start");
  expect(start?.channel).toBe("offline");
  // This provider's sandbox has no route to the console, so it is given neither a
  // launcher nor a token: nothing it could run would reach 4100, and the only
  // thing that carries its outcome out is the text of its final message.
  expect(start?.shim ?? null).toBeNull();
  expect(log.filter((entry) => entry.event === "shim")).toEqual([]);
  expect(log.filter((entry) => entry.event === "http")).toEqual([]);
  // So the one status recorded for the run is the server's own, parsed from that
  // message after the process exited.
  const commands = harness.query<{ request_id: string; operation: string }>("SELECT request_id, operation FROM agent_command WHERE run_id = ?", runId);
  expect(commands).toEqual([{ request_id: "offline-status-final", operation: "status" }]);
});

test("a done on the offline channel runs the item's Verify commands before it is applied", async ({ harness }) => {
  // The status block is read after the process exits, and the gate that closes
  // an item only reads recorded results. With no command run it read "not run
  // yet", so an offline run could never close an item that had a Verify section.
  const passing = await runSavedTask(harness, { content: "Rename the INSTALL section to Setup.\n\n## Verify\n\n```sh\ntrue\n```\n", scenarios: [{ behavior: "done" }] });
  expect((await waitForRunEnd(passing.task, passing.runId)).state.toUpperCase()).toBe("DONE");
  expect((await state.prompt(passing.task)).status).toBe("DONE");

  // A failing command keeps the item open on what failed, with the output kept.
  const failing = await runSavedTask(harness, { content: "Rename the INSTALL section to Setup.\n\n## Verify\n\n```sh\necho broken; exit 3\n```\n", scenarios: [{ behavior: "done" }] });
  await waitForRunEnd(failing.task, failing.runId);
  expect((await state.prompt(failing.task)).status).toBe("NEEDS_REVIEW");
  const remarks = (await state.history(failing.task)).remarks as Array<{ kind: string; content: string }>;
  expect(remarks.some((remark) => remark.kind === "VERIFICATION" && remark.content.includes("broken"))).toBe(true);
});

test("a continue on the offline channel re-queues the item with what remains", async ({ harness }) => {
  // The status block only took DONE or BLOCKED, so a sandboxed run that ran out
  // of time had no honest way to end.
  const { task, runId } = await runSavedTask(harness, { scenarios: [{ behavior: "continue", remaining: "Rename the two remaining headings in docs/setup.md." }] });
  expect((await waitForRunEnd(task, runId)).state.toUpperCase()).toBe("DONE");
  expect((await state.prompt(task)).status).toBe("TODO");
  const history = await state.history(task);
  expect((history.remarks as Array<{ kind: string; content: string }>).some((remark) => remark.kind === "CONTINUATION" && remark.content === "Rename the two remaining headings in docs/setup.md.")).toBe(true);
  expect(history.events.some((event) => event.newStatus === "TODO" && event.actorType === "AGENT")).toBe(true);
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
  // Three endings, and the item lands on what was actually observed: a process
  // that failed is FAILED, a process that finished and said nothing is
  // UNREPORTED. Neither is DONE, and neither is BLOCKED - nobody has a question
  // to answer, so parking the station on a human would strand it.
  const cases = [
    { scenario: { behavior: "fail" as const }, runState: "ERROR", status: "FAILED", reason: /The agent process failed/ },
    { scenario: { behavior: "done" as const, malformedStatus: true }, runState: "DONE", status: "UNREPORTED", reason: /ended done without posting a status/ },
    { scenario: { behavior: "done" as const, skipStatus: true }, runState: "DONE", status: "UNREPORTED", reason: /ended done without posting a status/ },
  ];
  for (const { scenario, runState, status, reason } of cases) {
    const { task, runId } = await runSavedTask(harness, { scenarios: [scenario] });
    const session = await waitForRunEnd(task, runId);
    expect(session.state.toUpperCase()).toBe(runState);
    expect((await state.prompt(task)).status).toBe(status);
    const event = (await state.history(task)).events.find((item) => item.newStatus === status);
    expect(event?.actorType).toBe("SYSTEM");
    expect(event?.reason).toMatch(reason);
  }
});

test("S-H2-14: an empty scenario queue makes the fake fail fast instead of hanging", async ({ harness }) => {
  const { task, runId } = await runSavedTask(harness, { scenarios: [] });
  const session = await waitForRunEnd(task, runId, 20_000);
  expect(session.state.toUpperCase()).toBe("ERROR");
  expect(harness.fakeProvider.log().some((entry) => entry.event === "fatal" && /scenario queue is empty|no scenario queued/.test(String(entry.message)))).toBe(true);
});

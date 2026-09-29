import { expect, test } from "../../src/fixtures.ts";

/*
 * Focused browser proof for the Team handovers inbox. The page is the real
 * production web build; only the handover API responses are deterministic.
 * That keeps this row about rendered controls dispatching their real HTTP
 * routes, without paying for another two-workstation Git/Telegram crossing.
 */

const future = "2099-09-29T11:00:00.000Z";
test.use({ harnessOptions: { portOffset: 87 } });
const repository = {
  ready: true,
  reason: null,
  workspaceId: 7,
  workspaceName: "release",
  workDirectory: "/work/release",
};

function item(itemId: string, action: "accept" | "decline" | "return") {
  const returning = action === "return";
  return {
    itemId,
    state: returning ? "RUNNING" : "OFFERED",
    epoch: 1,
    role: "receiver",
    requester: { personId: "requester", label: "Requester" },
    executor: returning ? { personId: "receiver", label: "Teammate" } : null,
    branch: `aw/handover/${itemId}`,
    updatedAt: "2099-09-29T10:00:00.000Z",
    offerDeadline: returning ? null : future,
    resultLabel: null,
    provider: "grok",
    model: null,
    repository,
    localTask: returning
      ? { promptId: 43, workspaceId: 7, title: "Receiver task", runId: "run-43", runState: "DONE" }
      : null,
    actions: [action],
  };
}

const returned = {
  itemId: "review-returned",
  state: "RETURNED",
  epoch: 1,
  role: "requester",
  requester: { personId: "requester", label: "Requester" },
  executor: { personId: "receiver", label: "Teammate" },
  branch: "aw/handover/review-returned",
  updatedAt: "2099-09-29T10:00:00.000Z",
  offerDeadline: null,
  resultLabel: "full",
  provider: "grok",
  model: null,
  repository,
  localTask: { promptId: 42, workspaceId: 7, title: "Requester review task", runId: null, runState: null },
  actions: [],
};

test("C1 (T1): rendered inbox actions POST their actual route and returned work opens task review", async ({ harness, page }) => {
  const { serverUrl, webUrl } = harness;
  const handovers = [item("offer-accept", "accept"), item("offer-decline", "decline"), item("return-ready", "return"), returned];
  const cors = {
    "Access-Control-Allow-Origin": webUrl,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  await page.route(`${serverUrl}/api/task-control/team/handovers**`, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/task-control/team/handovers") {
      await route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ handovers }) });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ result: { ok: true } }) });
  });

  await page.goto(`${webUrl}/tasks`);
  await page.getByRole("button", { name: "Team handovers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team handovers", exact: true })).toBeVisible();
  await expect(page.getByText(/renewed here without another Telegram post/)).toBeVisible();

  for (const [itemId, action, label] of [
    ["offer-accept", "accept", "Accept"],
    ["offer-decline", "decline", "Decline"],
    ["return-ready", "return", "Return work"],
  ] as const) {
    const row = page.locator("article").filter({ hasText: itemId });
    const posted = page.waitForRequest(request =>
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/task-control/team/handovers/${itemId}/${action}`,
    );
    await row.getByRole("button", { name: label, exact: true }).click();
    const request = await posted;
    expect(request.postDataJSON()).toEqual({});
  }

  const review = page.locator("article").filter({ hasText: "Requester review task" });
  await expect(review).toContainText("apply it or request specific changes");
  await review.getByRole("button", { name: "Review returned work", exact: true }).click();
  await expect(page).toHaveURL(`${webUrl}/tasks?workspace=7&prompt=42`);
});

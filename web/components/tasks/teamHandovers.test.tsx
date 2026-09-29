import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamHandoverSummary } from "@agent-console/shared";
import { submitTeamHandoverAction, TeamHandoversView } from "./TeamHandoversPanel";

const localTask = { promptId: 42, workspaceId: 7, title: "Choose the release colour", runId: null, runState: null };

function handover(overrides: Partial<TeamHandoverSummary> = {}): TeamHandoverSummary {
  return {
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    state: "OFFERED",
    epoch: 1,
    role: "receiver",
    requester: { personId: "requester", label: "Requester" },
    executor: null,
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    updatedAt: "2099-09-29T10:00:00.000Z",
    offerDeadline: "2099-09-29T11:00:00.000Z",
    resultLabel: null,
    provider: "grok",
    model: null,
    repository: { ready: true, reason: null, workspaceId: 7, workspaceName: "release", workDirectory: "/work/release" },
    localTask,
    actions: ["accept", "decline"],
    ...overrides,
  };
}

function view(items: TeamHandoverSummary[], overrides: Partial<Parameters<typeof TeamHandoversView>[0]> = {}): string {
  return renderToStaticMarkup(
    <TeamHandoversView
      items={items}
      visible={items}
      filter="open"
      loading={false}
      error={null}
      busyActions={new Set()}
      onFilter={() => {}}
      onRefresh={() => {}}
      onAction={() => {}}
      onOpenTask={() => {}}
      {...overrides}
    />,
  );
}

test("C1: the rendered receiver offer names the decision, readiness and persistent reminder behavior", () => {
  const html = view([handover()]);
  assert.match(html, /Accept to claim and run this work here, or decline it for the team\./);
  assert.match(html, /Ready · release/);
  assert.match(html, /Available now: Accept, Decline\./);
  assert.match(html, /renewed here without another Telegram post/);
  assert.match(html, /Accepted, declined and applied decisions stay final/);
  assert.match(html, /data-testid="team-handover-action-accept"/);
  assert.match(html, /data-testid="team-handover-action-decline"/);
});

test("C1: repository and expired-action refusals are visible instead of leaving dead-looking buttons", () => {
  const setup = handover({
    repository: { ready: false, reason: "Register a workspace for this repository.", workspaceId: null, workspaceName: null, workDirectory: null },
    actions: ["decline"],
  });
  const setupHtml = view([setup]);
  assert.match(setupHtml, /Accept is unavailable until this repository is ready/);
  assert.match(setupHtml, /Register a workspace for this repository/);
  assert.match(setupHtml, /Available now: Decline\. Accept requires repository setup\./);

  const expiredHtml = view([handover({ offerDeadline: "2020-01-01T00:00:00.000Z", actions: [] })]);
  assert.match(expiredHtml, /The offer window expired\. Accept and decline are no longer available\./);
  assert.match(expiredHtml, /No actions available: this offer expired\./);
  assert.doesNotMatch(expiredHtml, /data-testid="team-handover-action-accept"/);
});

test("C1: returned requester work points to review/apply/request-changes in the existing task detail", () => {
  const html = view([handover({ role: "requester", state: "RETURNED", resultLabel: "full", actions: [] })]);
  assert.match(html, /Review the returned work in the task, then apply it or request specific changes\./);
  assert.match(html, /Review returned work<\/button>/);
  assert.match(html, /full result/);
});

test("C1: loading, failure, empty and per-item busy states remain explicit", () => {
  assert.match(view([], { loading: true }), /Loading team handovers…/);
  assert.match(view([], { error: "Team API unavailable" }), /Team API unavailable Use Refresh to try again\./);
  assert.match(view([]), /No open team handovers\. New offers and returned work will appear here\./);

  const item = handover();
  const busy = view([item], { busyActions: new Set([`${item.itemId}:accept`]) });
  assert.match(busy, /Updating this handover…/);
  const accept = /<button[^>]*data-testid="team-handover-action-accept"[^>]*>/.exec(busy)?.[0] ?? "";
  const decline = /<button[^>]*data-testid="team-handover-action-decline"[^>]*>/.exec(busy)?.[0] ?? "";
  assert.match(accept, /disabled=""/);
  assert.match(decline, /disabled=""/);
});

test("C1: the action helper posts the encoded item to the real web handover client route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ result: { state: "CLAIMED" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await submitTeamHandoverAction("awi1/item", "accept");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const called = calls[0];
  assert.ok(called);
  assert.equal(called.url.pathname, "/api/task-control/team/handovers/awi1%2Fitem/accept");
  assert.equal(called.init?.method, "POST");
  assert.equal(called.init?.body, "{}");
});

import { expect, test } from "@playwright/test";
import { startTeamHarness } from "../../src/env/teamHarness.ts";
import { pairTeamMember } from "../../src/teamFlows.ts";

test.setTimeout(180_000);

test("TM-T1-gate: Team is default-off without disabling personal Telegram", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const team = await startTeamHarness({
    envA: { settings: { "team.enabled": false } },
    envB: { settings: { "team.enabled": false } },
  });
  try {
    await pairTeamMember(team, team.envA);
    await page.goto(`${team.envA.app.webUrl}/agents`);

    await expect(page.getByRole("switch", { name: "Enable Team" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("heading", { name: "Live Telegram" })).toBeVisible();
    await expect(page.getByText(`user ${team.envA.user.id}`)).toBeVisible();
    await expect(page.getByLabel("Team status")).toHaveCount(0);
    await expect(page.getByLabel("Create team")).toHaveCount(0);
    await expect(page.getByLabel("Join team")).toHaveCount(0);

    const routes = [
      { method: "GET", path: "/api/task-control/team" },
      { method: "POST", path: "/api/task-control/team/refresh", body: {} },
      { method: "GET", path: "/api/task-control/team/create" },
      { method: "POST", path: "/api/task-control/team/create", body: { remoteUrl: team.bareRepository } },
      { method: "DELETE", path: "/api/task-control/team/create" },
      { method: "POST", path: "/api/task-control/team/create/confirm", body: {} },
      { method: "POST", path: "/api/task-control/team/join", body: { code: "awj1.disabled" } },
      { method: "POST", path: "/api/task-control/team/join/confirm", body: {} },
    ];
    for (const route of routes) {
      const response = await fetch(`${team.envA.app.serverUrl}${route.path}`, {
        method: route.method,
        headers: { Origin: team.envA.app.webUrl, ...(route.body === undefined ? {} : { "content-type": "application/json" }) },
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      await expect(response.json(), `${route.method} ${route.path}`).resolves.toEqual({
        error: {
          code: "team_disabled",
          message: "Enable Team in Agents settings before using Team features.",
        },
      });
    }

    const personal = await fetch(`${team.envA.app.serverUrl}/api/task-control/telegram`, {
      headers: { Origin: team.envA.app.webUrl },
    });
    expect(personal.status).toBe(200);
    await expect(personal.json()).resolves.toMatchObject({ status: { state: "polling" } });
  } finally {
    await team.dispose();
  }
});

/*
 * L-16. The gate above is checked on a page loaded with Team already off. This
 * checks the other direction, which is the one that was broken: Team turned off
 * **while the page is open**.
 *
 * `broadcastSettingsChange` carried only `providers`, and the web reducer applied
 * only `providers`, so the settings snapshot holding `team.enabled` was never
 * re-read. Every Team panel stayed on screen until someone reloaded, and the Team
 * thread panel's button still looked enabled. The API gate held throughout - the
 * stale button could not act, only mislead - which is why this was banded low and
 * why the row below also proves the panels come back when Team returns, rather
 * than only that they vanish.
 */
test("L-16 (T1): turning Team off clears the Team panels without a reload, and turning it back on restores them", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const team = await startTeamHarness({
    envA: { settings: { "team.enabled": true } },
    envB: { settings: { "team.enabled": true } },
  });
  try {
    await pairTeamMember(team, team.envA);
    await page.goto(`${team.envA.app.webUrl}/agents`);
    /*
     * With Team on, the panels are there: the starting point the defect began
     * from. `Team status` is deliberately not among them - it returns null until a
     * team exists, and this harness has not created one, so asserting it would be
     * asserting the absence of a team rather than the state of the gate.
     */
    await expect(page.getByLabel("Create team")).toHaveCount(1);
    await expect(page.getByLabel("Join team")).toHaveCount(1);

    /*
     * Turned off the way the defect was found: by the API, from outside the page,
     * with no reload and without using the page's own switch. The page's own save
     * already applied its result locally, which is why this went unnoticed.
     */
    const setTeam = async (enabled: boolean) => {
      const response = await fetch(`${team.envA.app.serverUrl}/api/settings`, {
        method: "PUT",
        headers: { Origin: team.envA.app.webUrl, "content-type": "application/json" },
        body: JSON.stringify({ "team.enabled": enabled }),
      });
      expect(response.status, `PUT team.enabled=${enabled}`).toBe(200);
    };

    await setTeam(false);
    // No reload anywhere in this test. These waits are the assertion.
    await expect(page.getByLabel("Create team")).toHaveCount(0);
    await expect(page.getByLabel("Join team")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Enable Team" })).toHaveAttribute("aria-checked", "false");

    await setTeam(true);
    await expect(page.getByLabel("Create team")).toHaveCount(1);
    await expect(page.getByLabel("Join team")).toHaveCount(1);
    await expect(page.getByRole("switch", { name: "Enable Team" })).toHaveAttribute("aria-checked", "true");
  } finally {
    await team.dispose();
  }
});

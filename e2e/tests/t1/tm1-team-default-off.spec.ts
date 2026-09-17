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

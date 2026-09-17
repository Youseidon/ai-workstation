import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness } from "../../src/env/teamHarness.ts";
import { createTeamFixture, decodeJoinCode, joinCodeWith, openAgents, pairTeamMember, registerTeamWorkspace, remoteRoster, replaceRemoteRoster } from "../../src/teamFlows.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
let team: TeamHarness;
let contextA: BrowserContext;
let contextB: BrowserContext;
let pageA: Page;
let pageB: Page;

test.beforeEach(async ({ browser }, testInfo) => {
  testInfo.setTimeout(10 * 60_000);
  team = await startTeamHarness();
  team.fakeTelegram.removeChatMember(team.groupChat.id, team.envB.bot.id);
  team.fakeTelegram.removeChatMember(team.groupChat.id, team.envB.user.id);
  await pairTeamMember(team, team.envA);
  await pairTeamMember(team, team.envB);
  contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  testInfo.setTimeout(180_000);
});

test.afterEach(async () => {
  await contextB?.close();
  await contextA?.close();
  await team?.dispose();
});

test("TM-T1-1a: team creation requires the right group, administrator rights and local confirmation", covers("T08, team creation"), async () => {
  await openAgents(pageA, team.envA);
  const panel = pageA.getByLabel("Create team");
  const remote = team.bareRepository;

  await panel.getByLabel("Private Git repository URL").fill(remote);
  await panel.getByRole("button", { name: "Create team" }).click();
  const privateCommand = await panel.locator("code").textContent();
  expect(privateCommand).toMatch(/^\/team [A-Za-z0-9_-]+$/);
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.envA.privateChat, privateCommand!);
  await expect(panel.getByRole("button", { name: "Confirm team" })).toBeDisabled();
  await panel.getByRole("button", { name: "Cancel" }).click();

  team.fakeTelegram.removeChatMember(team.groupChat.id, team.envA.bot.id);
  team.fakeTelegram.addChatMember(team.groupChat, team.envA.bot);
  await panel.getByRole("button", { name: "Create team" }).click();
  const nonAdminCommand = await panel.locator("code").textContent();
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, nonAdminCommand!);
  await expect(panel.getByRole("button", { name: "Confirm team" })).toBeDisabled();
  expect(team.envA.app.query("SELECT * FROM team_roster")).toEqual([]);
  await panel.getByRole("button", { name: "Cancel" }).click();
  team.fakeTelegram.removeChatMember(team.groupChat.id, team.envA.bot.id);
  team.fakeTelegram.addChatMember(team.groupChat, team.envA.bot, { administrator: true, canPinMessages: true, canInviteUsers: true });

  await panel.getByRole("button", { name: "Create team" }).click();
  const staleCommand = await panel.locator("code").textContent();
  await panel.getByRole("button", { name: "Cancel" }).click();
  await panel.getByRole("button", { name: "Create team" }).click();
  const declinedCommand = await panel.locator("code").textContent();
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, staleCommand!);
  await expect(panel.getByRole("button", { name: "Confirm team" })).toBeDisabled();
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, declinedCommand!);
  await expect(panel.getByText("Group verified. Confirm locally.")).toBeVisible();
  await panel.getByRole("button", { name: "Cancel" }).click();
  expect(team.envA.app.query("SELECT * FROM team_roster")).toEqual([]);
  expect(team.envA.app.query("SELECT * FROM task_control_actor WHERE topic_id='__team_group__'")).toEqual([]);

  await panel.getByRole("button", { name: "Create team" }).click();
  const finalCommand = await panel.locator("code").textContent();
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, finalCommand!);
  await expect(panel.getByText("Group verified. Confirm locally.")).toBeVisible();
  await panel.getByRole("button", { name: "Confirm team" }).click();
  await expect(panel.getByText("Team created:")).toBeVisible();
  const joinCode = (await panel.locator("code").filter({ hasText: "awj1." }).textContent())!;
  const payload = decodeJoinCode(joinCode);
  expect(Object.keys(payload).sort()).toEqual(["expiresAt", "groupChatId", "inviteId", "remoteUrl", "teamId", "version"]);
  expect(JSON.stringify(payload)).not.toMatch(/credential|password|token|secret/i);
  const published = remoteRoster(team).roster;
  expect(published.members).toHaveLength(1);
  expect(published.groupChatId).toBe(String(team.groupChat.id));
  expect(team.envA.app.query("SELECT * FROM team_roster")).toHaveLength(1);
  expect(team.envA.app.query("SELECT * FROM task_control_actor WHERE topic_id='__team_group__'")).toHaveLength(1);
});

test("TM-T1-1b: failed, reused and workspace-mismatched join codes have no side effects", covers("T09, join failure"), async () => {
  const { joinCode } = await createTeamFixture(team);
  await openAgents(pageB, team.envB);
  const panel = pageB.getByLabel("Join team");
  const input = panel.getByLabel("Team join code");

  await input.fill("awj1.not-valid");
  await panel.getByRole("button", { name: "Check code" }).click();
  await expect(panel.getByText("Join code is invalid.")).toBeVisible();

  const reusedCode = joinCodeWith(joinCode, { inviteId: "tm-t1-1b-used-invite" });
  await input.fill(reusedCode);
  await panel.getByRole("button", { name: "Check code" }).click();
  await expect(panel.getByText("Add a local workspace that uses the team repository as its origin, then check the code again.")).toBeVisible();
  expect(team.envB.app.query("SELECT * FROM team_roster")).toEqual([]);
  expect(team.envB.app.query("SELECT * FROM task_control_actor WHERE topic_id='__team_group__'")).toEqual([]);

  await registerTeamWorkspace(team.envB);
  const before = remoteRoster(team);
  replaceRemoteRoster(team, before.head, { ...before.roster, usedInviteIds: [...before.roster.usedInviteIds, "tm-t1-1b-used-invite"], commandIds: [...before.roster.commandIds, "tm-t1-1b-fixture"], updatedAt: new Date().toISOString() });
  const beforeRejectedJoin = remoteRoster(team).head;
  await panel.getByRole("button", { name: "Check code" }).click();
  await expect(panel.getByRole("button", { name: "Join team" })).toBeEnabled();
  await panel.getByRole("button", { name: "Join team" }).click();
  await expect(panel.getByText("Join code was already used.")).toBeVisible();
  expect(remoteRoster(team).head).toBe(beforeRejectedJoin);
  expect(remoteRoster(team).roster.members).toHaveLength(1);
  expect(team.envB.app.query("SELECT * FROM team_roster")).toEqual([]);
  expect(team.envB.app.query("SELECT * FROM task_control_actor WHERE topic_id='__team_group__'")).toEqual([]);
  expect(team.fakeTelegram.calls.filter(call => call.method === "createChatInviteLink")).toHaveLength(0);
});

test("TM-T1-1: Yousef joins while jd-laptop is stopped and both panels converge on restart", covers("T08, T09, roster"), async () => {
  const { teamId, joinCode } = await createTeamFixture(team);
  await openAgents(pageA, team.envA);
  await openAgents(pageB, team.envB);
  await registerTeamWorkspace(team.envB);
  await team.envA.app.stopServer();
  const panelB = pageB.getByLabel("Join team");
  await panelB.getByLabel("Team join code").fill(joinCode);
  await panelB.getByRole("button", { name: "Check code" }).click();
  await expect(panelB.getByRole("button", { name: "Join team" })).toBeEnabled();
  await panelB.getByRole("button", { name: "Join team" }).click();
  await expect(panelB.getByText(/add @harness_bot_b .* administrator with Pin messages/i)).toBeVisible();
  expect(remoteRoster(team).roster.members).toHaveLength(2);
  expect(team.envB.app.query("SELECT * FROM team_roster")).toHaveLength(1);
  expect(team.fakeTelegram.calls.filter(call => call.method === "createChatInviteLink")).toHaveLength(0);

  team.fakeTelegram.addChatMember(team.groupChat, team.envB.bot, { administrator: true, canPinMessages: true, canInviteUsers: true });
  await team.envA.app.startServer();
  const statusA = pageA.getByLabel("Team status");
  await statusA.getByRole("button", { name: "Refresh team" }).click();
  await expect(statusA.locator("li").filter({ hasText: "@harness_bot_b" })).toBeVisible();
  await expect(statusA.getByText(/add @harness_bot_b .* administrator with Pin messages/i)).toBeVisible();
  const statusB = pageB.getByLabel("Team status");
  await expect(statusB.locator("li").filter({ hasText: "@harness_bot_a" })).toBeVisible();
  await expect(statusB.locator("li").filter({ hasText: "@harness_bot_b" })).toBeVisible();
  await expect(statusB.getByText(/add @harness_bot_b .* administrator with Pin messages/i)).toBeVisible();

  const inviteCalls = () => team.fakeTelegram.calls.filter(call => call.method === "createChatInviteLink");
  expect(inviteCalls()).toHaveLength(1);
  expect(inviteCalls()[0]?.botId).toBe(team.envA.bot.id);
  expect(inviteCalls()[0]?.body.member_limit).toBe(1);
  await statusA.getByRole("button", { name: "Refresh team" }).click();
  expect(inviteCalls()).toHaveLength(1);
  await team.envA.app.restartServer();
  await statusA.getByRole("button", { name: "Refresh team" }).click();
  expect(inviteCalls()).toHaveLength(1);

  const inviteLink = await statusA.getByRole("link", { name: /fake/ }).getAttribute("href");
  expect(inviteLink).not.toBeNull();
  await team.fakeTelegram.joinChatByInvite(team.envB.user, inviteLink!);
  await expect(team.fakeTelegram.joinChatByInvite(team.envB.user, inviteLink!)).rejects.toThrow(/invite link expired/);
  expect(teamId).toBe(remoteRoster(team).roster.teamId);

  await pageB.setViewportSize({ width: 390, height: 844 });
  await expect(statusB).toBeVisible();
  expect(await statusB.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await pageB.setViewportSize({ width: 1440, height: 1000 });
  await expect(statusB).toBeVisible();
});

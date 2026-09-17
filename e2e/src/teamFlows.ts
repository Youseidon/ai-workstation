import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";
import type { TeamHarness, TeamHarnessMember } from "./env/teamHarness.ts";
import { eventually } from "./drivers/state.ts";

interface ApiFailureBody { error?: { message?: string; code?: string }; }

export interface TeamRosterRecord {
  version: 1;
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  members: Array<{ personId: string; telegramUserId: string; botId: string; botUsername: string; workstationId: string; workstationLabel: string }>;
  usedInviteIds: string[];
  commandIds: string[];
  updatedAt: string;
}

export interface JoinCodePayload {
  version: 1;
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  inviteId: string;
  expiresAt: string;
}

export class TeamApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

export async function teamApi<T>(member: TeamHarnessMember, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${member.app.serverUrl}${path}`, {
    method,
    headers: { Origin: member.app.webUrl, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let failure: ApiFailureBody = {};
    try { failure = JSON.parse(text) as ApiFailureBody; } catch { /* status is enough */ }
    throw new TeamApiError(response.status, failure.error?.code, failure.error?.message ?? `Request failed with ${response.status}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export async function pairTeamMember(team: TeamHarness, member: TeamHarnessMember): Promise<void> {
  await eventually(`${member.name} Telegram polling`, async () => {
    const value = await teamApi<{ status: { state: string } }>(member, "GET", "/api/task-control/telegram");
    return value.status.state === "polling";
  });
  const started = await teamApi<{ pairing: { code: string } }>(member, "POST", "/api/task-control/telegram/pairing", {});
  team.fakeTelegram.userSendsMessage(member.bot, member.user, member.privateChat, `/start ${started.pairing.code}`);
  await eventually(`${member.name} pairing observation`, async () => {
    const value = await teamApi<{ status: { pairing: { observed: unknown } | null } }>(member, "GET", "/api/task-control/telegram");
    return value.status.pairing?.observed ? true : undefined;
  });
  await teamApi(member, "POST", "/api/task-control/telegram/pairing/confirm", { code: started.pairing.code });
}

export async function registerTeamWorkspace(member: TeamHarnessMember): Promise<void> {
  await teamApi(member, "POST", "/api/workspaces", { name: `team-${member.name}`, description: "", workDirectory: member.git.workspace });
}

export async function createTeamFixture(team: TeamHarness): Promise<{ teamId: string; joinCode: string }> {
  const started = await teamApi<{ team: { code: string } }>(team.envA, "POST", "/api/task-control/team/create", { remoteUrl: team.bareRepository });
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, `/team ${started.team.code}`);
  await eventually("team creation observation", async () => {
    const status = await teamApi<{ team: { observed: boolean } | null }>(team.envA, "GET", "/api/task-control/team/create");
    return status.team?.observed ? true : undefined;
  });
  const confirmed = await teamApi<{ team: { teamId: string; joinCode: string } }>(team.envA, "POST", "/api/task-control/team/create/confirm", {});
  return confirmed.team;
}

export async function openAgents(page: Page, member: TeamHarnessMember): Promise<void> {
  await page.goto(`${member.app.webUrl}/agents`);
  await page.getByLabel("Create team").waitFor();
}

export function decodeJoinCode(code: string): JoinCodePayload {
  if (!code.startsWith("awj1.")) throw new Error("join code does not use awj1");
  return JSON.parse(Buffer.from(code.slice(5), "base64url").toString("utf8")) as JoinCodePayload;
}

export function joinCodeWith(code: string, changes: Partial<JoinCodePayload>): string {
  return `awj1.${Buffer.from(JSON.stringify({ ...decodeJoinCode(code), ...changes })).toString("base64url")}`;
}

export function remoteRoster(team: TeamHarness): { head: string; roster: TeamRosterRecord } {
  const head = git(team, ["rev-parse", "refs/aw/team"]);
  return { head, roster: JSON.parse(git(team, ["show", "refs/aw/team"])) as TeamRosterRecord };
}

export function replaceRemoteRoster(team: TeamHarness, expectedHead: string, roster: TeamRosterRecord): string {
  const next = git(team, ["hash-object", "-w", "--stdin"], JSON.stringify(roster));
  git(team, ["update-ref", "refs/aw/team", next, expectedHead]);
  return next;
}

function git(team: TeamHarness, args: string[], input?: string): string {
  const result = spawnSync("git", ["--git-dir", team.bareRepository, ...args], { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`team fixture git ${args[0]} failed`);
  return result.stdout.trim();
}

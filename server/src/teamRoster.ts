import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const JOIN_CODE_PREFIX = "awj1.";
const JOIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const TEAM_REF = "refs/aw/team";

export interface TeamMember {
  personId: string;
  telegramUserId: string;
  botId: string;
  botUsername: string;
  workstationId: string;
  workstationLabel: string;
}

export interface TeamRoster {
  version: 1;
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  members: TeamMember[];
  usedInviteIds: string[];
  commandIds: string[];
  updatedAt: string;
}

interface JoinCodePayload {
  version: 1;
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  inviteId: string;
  expiresAt: string;
}

export interface JoinCodeFields {
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  inviteId?: string;
  now?: Date;
}

export interface DecodedJoinCode {
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  inviteId: string;
  expiresAt: string;
}

export interface TeamRosterRemote {
  read(): Promise<{ roster: TeamRoster; revision: string } | null>;
  compareAndSwap(expectedRevision: string | null, roster: TeamRoster): Promise<{ revision: string } | "conflict">;
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > max) {
    throw new WorkspaceError(422, "invalid_team_roster", `${field} is invalid.`);
  }
  return value.trim();
}

function remoteUrl(value: unknown): string {
  const url = text(value, "remoteUrl", 4096);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url)) {
    throw new WorkspaceError(422, "invalid_team_roster", "remoteUrl must not contain credentials.");
  }
  return url;
}

function validateRoster(value: unknown): TeamRoster {
  if (value === null || typeof value !== "object") throw new WorkspaceError(422, "invalid_team_roster", "Team roster is invalid.");
  const source = value as Record<string, unknown>;
  if (source.version !== 1) throw new WorkspaceError(422, "invalid_team_roster", "Unsupported team roster version.");
  if (!Array.isArray(source.members) || !Array.isArray(source.usedInviteIds) || !Array.isArray(source.commandIds)) {
    throw new WorkspaceError(422, "invalid_team_roster", "Team roster arrays are invalid.");
  }
  const members = source.members.map((entry) => {
    if (entry === null || typeof entry !== "object") throw new WorkspaceError(422, "invalid_team_roster", "Team member is invalid.");
    const member = entry as Record<string, unknown>;
    return {
      personId: text(member.personId, "personId"),
      telegramUserId: text(member.telegramUserId, "telegramUserId"),
      botId: text(member.botId, "botId"),
      botUsername: text(member.botUsername, "botUsername"),
      workstationId: text(member.workstationId, "workstationId"),
      workstationLabel: text(member.workstationLabel, "workstationLabel"),
    };
  });
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length) throw new WorkspaceError(422, "invalid_team_roster", `${field} must be unique.`);
  };
  unique(members.map(member => member.personId), "personId");
  unique(members.map(member => member.telegramUserId), "telegramUserId");
  unique(members.map(member => member.botId), "botId");
  const usedInviteIds = source.usedInviteIds.map(value => text(value, "inviteId"));
  const commandIds = source.commandIds.map(value => text(value, "commandId"));
  unique(usedInviteIds, "inviteId");
  unique(commandIds, "commandId");
  return {
    version: 1,
    teamId: text(source.teamId, "teamId"),
    groupChatId: text(source.groupChatId, "groupChatId"),
    remoteUrl: remoteUrl(source.remoteUrl),
    members,
    usedInviteIds,
    commandIds,
    updatedAt: new Date(text(source.updatedAt, "updatedAt", 64)).toISOString(),
  };
}

export function newTeamRoster(input: Omit<TeamRoster, "version" | "usedInviteIds" | "commandIds" | "updatedAt"> & { now?: Date }): TeamRoster {
  return validateRoster({ ...input, version: 1, usedInviteIds: [], commandIds: [], updatedAt: (input.now ?? new Date()).toISOString() });
}

export function encodeJoinCode(input: JoinCodeFields): string {
  const now = input.now ?? new Date();
  const payload: JoinCodePayload = {
    version: 1,
    teamId: text(input.teamId, "teamId"),
    groupChatId: text(input.groupChatId, "groupChatId"),
    remoteUrl: remoteUrl(input.remoteUrl),
    inviteId: input.inviteId === undefined ? randomBytes(18).toString("base64url") : text(input.inviteId, "inviteId"),
    expiresAt: new Date(now.getTime() + JOIN_CODE_TTL_MS).toISOString(),
  };
  return JOIN_CODE_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeJoinCode(code: string, options: { expectedTeamId?: string; now?: Date } = {}): DecodedJoinCode {
  if (!code.startsWith(JOIN_CODE_PREFIX)) throw new WorkspaceError(422, "invalid_join_code", "Join code is invalid.");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(code.slice(JOIN_CODE_PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new WorkspaceError(422, "invalid_join_code", "Join code is invalid."); }
  if (payload === null || typeof payload !== "object") throw new WorkspaceError(422, "invalid_join_code", "Join code is invalid.");
  const source = payload as Record<string, unknown>;
  if (source.version !== 1) throw new WorkspaceError(422, "invalid_join_code", "Join code version is unsupported.");
  const result = {
    teamId: text(source.teamId, "teamId"),
    groupChatId: text(source.groupChatId, "groupChatId"),
    remoteUrl: remoteUrl(source.remoteUrl),
    inviteId: text(source.inviteId, "inviteId"),
    expiresAt: text(source.expiresAt, "expiresAt", 64),
  };
  const expiry = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= (options.now ?? new Date()).getTime()) throw new WorkspaceError(409, "join_code_expired", "Join code expired.");
  if (options.expectedTeamId !== undefined && result.teamId !== options.expectedTeamId) throw new WorkspaceError(409, "wrong_team", "Join code belongs to another team.");
  return result;
}

export async function publishRoster(remote: TeamRosterRemote, expectedRevision: string | null, roster: TeamRoster, commandId: string): Promise<{ roster: TeamRoster; revision: string }> {
  const valid = validateRoster(roster);
  const id = text(commandId, "commandId");
  if (valid.commandIds.includes(id)) throw new WorkspaceError(409, "command_reused", "Roster command id was already used.");
  const next = { ...valid, commandIds: [...valid.commandIds, id], updatedAt: new Date().toISOString() };
  const result = await remote.compareAndSwap(expectedRevision, next);
  if (result !== "conflict") {
    workspaces.upsertTeamRoster({ teamId: next.teamId, groupChatId: next.groupChatId, remoteUrl: next.remoteUrl, revision: result.revision, record: next });
    return { roster: next, revision: result.revision };
  }
  const current = await remote.read();
  if (current?.roster.commandIds.includes(id)) {
    workspaces.upsertTeamRoster({ teamId: current.roster.teamId, groupChatId: current.roster.groupChatId, remoteUrl: current.roster.remoteUrl, revision: current.revision, record: current.roster });
    return current;
  }
  throw new WorkspaceError(409, "roster_conflict", "Team roster changed; review it before trying again.");
}

function git(directory: string, args: string[], stdin?: string): string {
  const result = spawnSync("git", ["--git-dir", directory, ...args], { input: stdin, encoding: "utf8" });
  if (result.status !== 0) throw new WorkspaceError(502, "team_git_failed", (result.stderr || result.stdout || "Git team roster operation failed.").trim());
  return result.stdout.trim();
}

/** A small bare-clone seam used for refs/aw/team reads and atomic compare-and-swap writes. */
export class BareGitTeamRosterRemote implements TeamRosterRemote {
  constructor(private readonly bareDirectory: string) {}

  async read(): Promise<{ roster: TeamRoster; revision: string } | null> {
    const found = spawnSync("git", ["--git-dir", this.bareDirectory, "rev-parse", "--verify", "-q", TEAM_REF], { encoding: "utf8" });
    if (found.status !== 0) return null;
    const revision = found.stdout.trim();
    return { revision, roster: validateRoster(JSON.parse(git(this.bareDirectory, ["show", TEAM_REF])) as unknown) };
  }

  async compareAndSwap(expectedRevision: string | null, roster: TeamRoster): Promise<{ revision: string } | "conflict"> {
    const content = JSON.stringify(validateRoster(roster));
    const revision = git(this.bareDirectory, ["hash-object", "-w", "--stdin"], content);
    const expected = expectedRevision ?? "0000000000000000000000000000000000000000";
    const result = spawnSync("git", ["--git-dir", this.bareDirectory, "update-ref", TEAM_REF, revision, expected], { encoding: "utf8" });
    return result.status === 0 ? { revision } : "conflict";
  }
}

/** A private bare clone which fetches and compare-and-swap pushes only refs/aw/team. */
export class RemoteGitTeamRosterRemote implements TeamRosterRemote {
  constructor(private readonly bareDirectory: string, private readonly remoteUrl: string) {
    if (!existsSync(bareDirectory)) {
      mkdirSync(dirname(bareDirectory), { recursive: true, mode: 0o700 });
      const result = spawnSync("git", ["clone", "--bare", "--no-checkout", remoteUrl, bareDirectory], { encoding: "utf8" });
      if (result.status !== 0) throw new WorkspaceError(502, "team_git_failed", (result.stderr || "Could not clone the team repository.").trim());
    } else git(bareDirectory, ["remote", "set-url", "origin", remoteUrl]);
  }

  async read(): Promise<{ roster: TeamRoster; revision: string } | null> {
    spawnSync("git", ["--git-dir", this.bareDirectory, "fetch", "-q", "origin", `${TEAM_REF}:${TEAM_REF}`], { encoding: "utf8" });
    return new BareGitTeamRosterRemote(this.bareDirectory).read();
  }

  async compareAndSwap(expectedRevision: string | null, roster: TeamRoster): Promise<{ revision: string } | "conflict"> {
    const current = await this.read();
    if ((current?.revision ?? null) !== expectedRevision) return "conflict";
    const revision = git(this.bareDirectory, ["hash-object", "-w", "--stdin"], JSON.stringify(validateRoster(roster)));
    const lease = `--force-with-lease=${TEAM_REF}:${expectedRevision ?? "0000000000000000000000000000000000000000"}`;
    const pushed = spawnSync("git", ["--git-dir", this.bareDirectory, "push", "origin", `${revision}:${TEAM_REF}`, lease], { encoding: "utf8" });
    return pushed.status === 0 ? { revision } : "conflict";
  }
}

export function rosterRevision(roster: TeamRoster): string {
  return createHash("sha256").update(JSON.stringify(validateRoster(roster))).digest("hex");
}

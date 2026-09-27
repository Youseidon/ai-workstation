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
  /** The machine's own name: `TASK_CONTROL_WORKSTATION_LABEL`, as the personal card shows it. */
  workstationLabel: string;
  /** The person's Telegram display name, for every view that names a person (B5). */
  personLabel: string;
}

/**
 * What a caller hands in. `personLabel` is optional because a roster published
 * before B5 was fixed carries only the one label, and that label was the person's
 * name; it reads back as both, so such a roster says exactly what it said before
 * and nothing has to be migrated. Every write from here on carries both.
 */
export type TeamMemberInput = Omit<TeamMember, "personLabel"> & { personLabel?: string };

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
    const workstationLabel = text(member.workstationLabel, "workstationLabel");
    return {
      personId: text(member.personId, "personId"),
      telegramUserId: text(member.telegramUserId, "telegramUserId"),
      botId: text(member.botId, "botId"),
      botUsername: text(member.botUsername, "botUsername"),
      workstationId: text(member.workstationId, "workstationId"),
      workstationLabel,
      personLabel: member.personLabel === undefined || member.personLabel === null
        ? workstationLabel
        : text(member.personLabel, "personLabel"),
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

/**
 * A roster read back from the local cache rather than from the ref. The cache
 * holds whatever was last published, and a row written before B5 carries one
 * label per member, so the same fallback the ref read applies is applied here:
 * that label was the person's name and it answers for both (B5). It is a fill-in,
 * not a validation, so a record that used to be usable stays usable.
 */
export function cachedTeamRoster(record: unknown): TeamRoster {
  const roster = record as TeamRoster;
  if (!Array.isArray(roster?.members)) return roster;
  return { ...roster, members: roster.members.map(member => ({ ...member, personLabel: member.personLabel ?? member.workstationLabel })) };
}

export function newTeamRoster(input: Omit<TeamRoster, "version" | "usedInviteIds" | "commandIds" | "updatedAt" | "members"> & { members: TeamMemberInput[]; now?: Date }): TeamRoster {
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
  /*
   * M-14: this one code covered two causes and named neither. The stale-mirror
   * cause is now repaired in `RemoteGitTeamRosterRemote.read` or reported as
   * `roster_mirror_unreachable`, so what is left here is the genuine one - another
   * member published while this workstation was holding an older revision - and
   * the message says that and what clears it, rather than telling a workstation to
   * "review" a roster it may have no surface for.
   */
  const held = expectedRevision ?? "none";
  const now = current?.revision ?? "none";
  throw new WorkspaceError(409, "roster_conflict",
    `Another member published the team roster while this workstation held an older one (held ${held.slice(0, 12)}, remote now ${now.slice(0, 12)}). Refresh team to take the current roster, then try again.`);
}

/** Applies a credential-free, single-use join code to the current roster. */
export async function joinTeam(remote: TeamRosterRemote, code: string, member: TeamMemberInput, commandId: string): Promise<{ roster: TeamRoster; revision: string }> {
  const join = decodeJoinCode(code);
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(404, "team_not_found", "The team roster was not found in the repository.");
  if (current.roster.teamId !== join.teamId || current.roster.groupChatId !== join.groupChatId || current.roster.remoteUrl !== join.remoteUrl) {
    throw new WorkspaceError(409, "wrong_team", "Join code does not match the team roster.");
  }
  if (current.roster.usedInviteIds.includes(join.inviteId)) throw new WorkspaceError(409, "join_code_used", "Join code was already used.");
  const validMember = validateRoster({ ...current.roster, members: [...current.roster.members, member] }).members.at(-1)!;
  const next: TeamRoster = { ...current.roster, members: [...current.roster.members, validMember], usedInviteIds: [...current.roster.usedInviteIds, join.inviteId] };
  return publishRoster(remote, current.revision, next, commandId);
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

  /**
   * Reads the roster the **remote** holds, not the one this mirror happens to have.
   *
   * M-14's second cause lived here. The fetch was `refs/aw/team:refs/aw/team`,
   * unforced, and its result was discarded - so a mirror whose ref had diverged
   * from the remote could not fast-forward, the failure was silent, and the read
   * returned the **stale local copy**. Every compare-and-swap after that was made
   * against a fiction, and it failed as `roster_conflict` - "Team roster changed;
   * review it before trying again" - on a workstation whose roster had not changed
   * and which could not review anything. That is why clearing `refs/aw/team` on
   * the remote is not enough on its own: the mirror caches its own copy.
   *
   * The remote is authoritative for this ref, so a diverged mirror is repaired
   * rather than reported: the refspec is forced. What is still reported, and now
   * with its own code, is a fetch that fails for any other reason - no network, no
   * access, a wrong URL - because that is not a conflict and must not be described
   * as one.
   */
  async read(): Promise<{ roster: TeamRoster; revision: string } | null> {
    const fetched = spawnSync(
      "git",
      ["--git-dir", this.bareDirectory, "fetch", "-q", "origin", `+${TEAM_REF}:${TEAM_REF}`],
      { encoding: "utf8" },
    );
    if (fetched.status !== 0) {
      const detail = (fetched.stderr || fetched.stdout || "").trim();
      // An empty remote has no ref to fetch, which is not a failure: it is a
      // repository with no team in it yet, and `read` answers null for that below.
      const missingRef = /couldn't find remote ref|no such ref|not our ref/i.test(detail);
      if (!missingRef) {
        throw new WorkspaceError(502, "roster_mirror_unreachable",
          `Could not read the team roster from ${this.remoteUrl}. The local mirror at ${this.bareDirectory} was left unchanged, so nothing was decided from a stale copy. ${detail}`.trim());
      }
    }
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

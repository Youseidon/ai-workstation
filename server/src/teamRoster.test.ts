import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEAM_GROUP_TOPIC_SENTINEL, WorkspaceError, workspaces } from "./workspaces.ts";
import { BareGitTeamRosterRemote, decodeJoinCode, encodeJoinCode, joinTeam, newTeamRoster, publishRoster } from "./teamRoster.ts";

function roster() {
  return newTeamRoster({
    teamId: "team-1",
    groupChatId: "group-1",
    remoteUrl: "https://example.test/team.git",
    members: [{ personId: "jd", telegramUserId: "101", botId: "bot-a", botUsername: "bot_a", workstationId: "jd-laptop", workstationLabel: "jd laptop" }],
  });
}

test("TM-T0-3 join codes round trip, expire and reject tampering", () => {
  const now = new Date("2026-09-17T00:00:00.000Z");
  const code = encodeJoinCode({ teamId: "team-1", groupChatId: "group-1", remoteUrl: "https://example.test/team.git", inviteId: "invite-1", now });
  assert.deepEqual(decodeJoinCode(code, { expectedTeamId: "team-1", now }), {
    teamId: "team-1", groupChatId: "group-1", remoteUrl: "https://example.test/team.git", inviteId: "invite-1", expiresAt: "2026-09-18T00:00:00.000Z",
  });
  assert.throws(() => decodeJoinCode(`${code}x`, { now }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_join_code");
  assert.throws(() => decodeJoinCode(code, { now: new Date("2026-09-18T00:00:00.000Z") }), (error: unknown) => error instanceof WorkspaceError && error.code === "join_code_expired");
  assert.throws(() => decodeJoinCode(code, { expectedTeamId: "other", now }), (error: unknown) => error instanceof WorkspaceError && error.code === "wrong_team");
  assert.equal(code.includes("credential"), false);
});

test("TM-T0-4 compare-and-swap preserves one winner and resolves uncertain publication", async () => {
  let current: { roster: ReturnType<typeof roster>; revision: string } | null = null;
  const remote = {
    async read() { return current; },
    async compareAndSwap(expected: string | null, next: ReturnType<typeof roster>) {
      if ((current?.revision ?? null) !== expected) return "conflict" as const;
      current = { roster: next, revision: `r${next.commandIds.length}` };
      return { revision: current.revision };
    },
  };
  const first = await publishRoster(remote, null, roster(), "command-one");
  assert.equal(first.revision, "r1");
  await assert.rejects(() => publishRoster(remote, null, roster(), "command-two"), (error: unknown) => error instanceof WorkspaceError && error.code === "roster_conflict");
  const uncertain = await publishRoster(remote, "r1", first.roster, "command-two");
  assert.equal(uncertain.revision, "r2");
  const recovered = await publishRoster(remote, "r1", first.roster, "command-two");
  assert.equal(recovered.revision, "r2");
});

test("TM-T0-4 writes refs/aw/team with a Git compare-and-swap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-roster-git-"));
  try {
    execFileSync("git", ["init", "--bare", "-q", directory]);
    const remote = new BareGitTeamRosterRemote(directory);
    const first = await publishRoster(remote, null, roster(), "git-command-one");
    assert.equal((await remote.read())?.roster.commandIds.includes("git-command-one"), true);
    assert.equal(await remote.compareAndSwap(null, first.roster), "conflict");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TM-T0-3 join consumes one invite id exactly once", async () => {
  let current: { roster: ReturnType<typeof roster>; revision: string } | null = null;
  const remote = { async read() { return current; }, async compareAndSwap(expected: string | null, next: ReturnType<typeof roster>) { if ((current?.revision ?? null) !== expected) return "conflict" as const; current = { roster: next, revision: `r${next.commandIds.length}` }; return { revision: current.revision }; } };
  const published = await publishRoster(remote, null, roster(), "create");
  const code = encodeJoinCode({ teamId: "team-1", groupChatId: "group-1", remoteUrl: "https://example.test/team.git", inviteId: "invite-join" });
  const member = { personId: "yousef", telegramUserId: "202", botId: "bot-b", botUsername: "bot_b", workstationId: "yousef-desktop", workstationLabel: "Yousef desktop" };
  const joined = await joinTeam(remote, code, member, "join");
  assert.equal(joined.roster.members.length, 2);
  await assert.rejects(() => joinTeam(remote, code, member, "join-again"), (error: unknown) => error instanceof WorkspaceError && error.code === "join_code_used");
  assert.equal(published.roster.members.length, 1);
});

test("TM-T0-5 migration 24 persists a roster and prevents duplicate group actors", () => {
  const actor = workspaces.upsertTeamGroupActor({ id: "team-actor-101", transport: "fake_telegram", transportUserId: "101", chatId: "group-1", label: "jd" });
  try {
    assert.equal(actor.topic_id, TEAM_GROUP_TOPIC_SENTINEL);
    assert.throws(
      () => workspaces.upsertTeamGroupActor({ id: "team-actor-101-other", transport: "fake_telegram", transportUserId: "101", chatId: "group-1", label: "jd" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "conflict",
    );
    workspaces.upsertTeamRoster({ teamId: "team-1", groupChatId: "group-1", remoteUrl: "https://example.test/team.git", revision: "r1", record: roster() });
    assert.equal(workspaces.teamRoster("team-1")?.revision, "r1");
  } finally {
    workspaces.removeTaskControlActor(actor.id);
  }
});

test("B5: a roster published before the two labels were separated reads back exactly as it did", async () => {
  // Rosters already in refs/aw/team carry one label per member, and that label is
  // the person's Telegram display name. It reads back as both, so every view says
  // what it said before, and nothing is migrated: the next publish from either
  // workstation writes both fields.
  const bare = mkdtempSync(join(tmpdir(), "team-roster-legacy-"));
  try {
    execFileSync("git", ["init", "--bare", "-q", bare]);
    const remote = new BareGitTeamRosterRemote(bare);
    const legacy = JSON.parse(JSON.stringify(roster())) as { members: Array<Record<string, unknown>> };
    for (const member of legacy.members) delete member.personLabel;
    assert.equal("personLabel" in legacy.members[0]!, false, "the fixture really is a roster from before the change");
    // Written straight into refs/aw/team, because every write path validates and
    // would fill the field in; what is on the ref here is what the pilot published.
    const blob = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], { input: JSON.stringify(legacy), encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", bare, "update-ref", "refs/aw/team", blob]);
    assert.equal(execFileSync("git", ["--git-dir", bare, "show", "refs/aw/team"], { encoding: "utf8" }).includes("personLabel"), false, "the ref really holds a roster with one label");

    const read = (await remote.read())!.roster;
    assert.equal(read.members[0]!.workstationLabel, "jd laptop");
    assert.equal(read.members[0]!.personLabel, "jd laptop", "the one label it has answers for both");

    // A member joining such a roster carries both, and the member already there is
    // left as it was rather than guessed at.
    const joined = await joinTeam(remote, encodeJoinCode({ teamId: "team-1", groupChatId: "group-1", remoteUrl: "https://example.test/team.git", inviteId: "invite-legacy" }), {
      personId: "yousef", telegramUserId: "202", botId: "bot-b", botUsername: "bot_b", workstationId: "ws-yousef", workstationLabel: "yousef-desktop", personLabel: "Yousef",
    }, "join-legacy");
    assert.deepEqual(joined.roster.members.map(member => [member.workstationLabel, member.personLabel]), [["jd laptop", "jd laptop"], ["yousef-desktop", "Yousef"]]);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

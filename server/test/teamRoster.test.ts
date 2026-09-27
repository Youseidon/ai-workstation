import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEAM_GROUP_TOPIC_SENTINEL, WorkspaceError, workspaces } from "../src/workspaces.ts";
import { BareGitTeamRosterRemote, RemoteGitTeamRosterRemote, cachedTeamRoster, decodeJoinCode, encodeJoinCode, joinTeam, newTeamRoster, publishRoster } from "../src/teamRoster.ts";

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

test("B5: a roster row cached before the change is usable without going back to the ref", () => {
  // `team_roster` holds the record as it was last published, and every Team view
  // reads that cache rather than the ref. A row written before the two labels were
  // separated has no `personLabel`, and a view that named a person from it used to
  // render `undefined` and throw; the one label it has answers for both.
  const legacy = JSON.parse(JSON.stringify(roster())) as { members: Array<Record<string, unknown>> };
  for (const member of legacy.members) delete member.personLabel;
  assert.deepEqual(cachedTeamRoster(legacy).members.map(member => [member.workstationLabel, member.personLabel]), [["jd laptop", "jd laptop"]]);
  // A row written after it is handed back as it is.
  assert.deepEqual(cachedTeamRoster(roster()), roster());
});

/*
 * M-14. `roster_conflict` covered at least two causes and named neither, and the
 * second one - a stale local mirror - produced it on a workstation whose roster
 * had not changed and which had no surface on which to "review" anything.
 */

test("M-14: a diverged local mirror is repaired from the remote rather than reported as a roster conflict", async () => {
  const remoteRepo = mkdtempSync(join(tmpdir(), "m14-remote-"));
  const mirror = join(mkdtempSync(join(tmpdir(), "m14-mirror-")), "remote.git");
  try {
    execFileSync("git", ["init", "--bare", "-q", remoteRepo]);
    // The real remote gets a roster, published the ordinary way.
    const source = new BareGitTeamRosterRemote(remoteRepo);
    const published = await publishRoster(source, null, roster(), "m14-create");

    // A mirror of it, then the remote moves on without the mirror knowing.
    const remote = new RemoteGitTeamRosterRemote(mirror, remoteRepo);
    assert.equal((await remote.read())?.revision, published.revision, "the mirror starts level with the remote");
    const moved = await publishRoster(source, published.revision, {
      ...published.roster,
      members: [...published.roster.members, { personId: "yousef", telegramUserId: "202", botId: "bot-b", botUsername: "bot_b", workstationId: "yousef-desktop", workstationLabel: "Yousef desktop", personLabel: "Yousef" }],
    }, "m14-second-member");
    assert.notEqual(moved.revision, published.revision);

    /*
     * Force the mirror's own ref somewhere the remote's history does not contain,
     * which is what makes the unforced fetch fail. That failure used to be
     * discarded, leaving `read` to answer with this stale local copy.
     */
    const stray = execFileSync("git", ["--git-dir", mirror, "hash-object", "-w", "--stdin"], { input: '{"stale":true}', encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", mirror, "update-ref", "refs/aw/team", stray]);

    const read = await remote.read();
    assert.equal(read?.revision, moved.revision, "the read reports the remote's roster, not the mirror's stale copy");
    assert.equal(read?.roster.members.length, 2, "and the member the remote added is in it");
  } finally {
    rmSync(remoteRepo, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  }
});

test("M-14: an unreachable remote is its own error, not a roster conflict", async () => {
  const mirrorParent = mkdtempSync(join(tmpdir(), "m14-unreachable-"));
  const remoteRepo = mkdtempSync(join(tmpdir(), "m14-gone-"));
  const mirror = join(mirrorParent, "remote.git");
  try {
    execFileSync("git", ["init", "--bare", "-q", remoteRepo]);
    const source = new BareGitTeamRosterRemote(remoteRepo);
    await publishRoster(source, null, roster(), "m14-create");
    const remote = new RemoteGitTeamRosterRemote(mirror, remoteRepo);
    assert.equal((await remote.read())?.roster.teamId, "team-1");

    // The remote goes away. The mirror still holds a copy, and answering from it
    // is exactly the silent staleness this splits apart.
    rmSync(remoteRepo, { recursive: true, force: true });
    await assert.rejects(() => remote.read(), (error: unknown) =>
      error instanceof WorkspaceError && error.code === "roster_mirror_unreachable");
  } finally {
    rmSync(mirrorParent, { recursive: true, force: true });
    rmSync(remoteRepo, { recursive: true, force: true });
  }
});

test("M-14: a genuine conflict names what moved and what clears it", async () => {
  let current: { roster: ReturnType<typeof roster>; revision: string } | null = null;
  const remote = {
    async read() { return current; },
    async compareAndSwap(expected: string | null, next: ReturnType<typeof roster>) {
      if ((current?.revision ?? null) !== expected) return "conflict" as const;
      current = { roster: next, revision: `r${next.commandIds.length}` };
      return { revision: current.revision };
    },
  };
  await publishRoster(remote, null, roster(), "m14-one");
  await assert.rejects(
    () => publishRoster(remote, null, roster(), "m14-two"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceError && error.code === "roster_conflict");
      // The old message told a wiped workstation to "review" a roster it had no
      // surface for. This one names the cause and the button that clears it.
      assert.match(error.message, /Another member published the team roster/);
      assert.match(error.message, /Refresh team/);
      assert.doesNotMatch(error.message, /review it before trying again/);
      return true;
    },
  );
});

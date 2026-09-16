import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { isPortOpen, waitFor } from "./env/processes.ts";
import { startTeamHarness } from "./env/teamHarness.ts";

// Scenario IDs refer to docs/e2e-scenarios/tm0.md.

test("S-TM0-01/02/07/08: two app environments share one fake Telegram and one bare repository", async () => {
  const team = await startTeamHarness();
  try {
    assert.notEqual(team.envA.app.serverUrl, team.envB.app.serverUrl);
    assert.notEqual(team.envA.app.webUrl, team.envB.app.webUrl);
    assert.equal(await health(team.envA.app.serverUrl), true);
    assert.equal(await health(team.envB.app.serverUrl), true);
    assert.equal(await isPortOpen(team.envA.app.webPort), true);
    assert.equal(await isPortOpen(team.envB.app.webPort), true);
    assert.ok(existsSync(team.bareRepository));
    assert.ok(team.bareRepository.startsWith(team.root));

    assert.equal(team.envA.app.telegramServer, team.fakeTelegram);
    assert.equal(team.envB.app.telegramServer, team.fakeTelegram);
    assert.deepEqual(team.envA.app.telegramIdentity(), { id: String(team.envA.bot.id), username: team.envA.bot.username });
    assert.deepEqual(team.envB.app.telegramIdentity(), { id: String(team.envB.bot.id), username: team.envB.bot.username });

    team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.envA.privateChat, "hello A");
    team.fakeTelegram.userSendsMessage(team.envB.bot, team.envB.user, team.envB.privateChat, "hello B");
    await waitFor("env A to persist only bot A private update", async () => inboxCount(team.envA.app, team.envA.bot.id) === 1, 15_000);
    await waitFor("env B to persist only bot B private update", async () => inboxCount(team.envB.app, team.envB.bot.id) === 1, 15_000);
    assert.equal(inboxCount(team.envA.app, team.envB.bot.id), 0);
    assert.equal(inboxCount(team.envB.app, team.envA.bot.id), 0);

    team.envA.git.commitFile("from-a.txt", "A\n", "add env A file");
    team.envA.git.push("refs/aw/tm0/a");
    team.envB.git.fetch("refs/aw/tm0/a");
    assert.equal(team.envB.git.revParse("FETCH_HEAD"), team.envA.git.revParse("HEAD"));

    team.envB.git.commitFile("from-b.txt", "B\n", "add env B file");
    team.envB.git.push("refs/aw/tm0/b");
    team.envA.git.fetch("refs/aw/tm0/b");
    assert.equal(team.envA.git.revParse("FETCH_HEAD"), team.envB.git.revParse("HEAD"));

    team.envA.git.cutGit();
    assert.throws(() => team.envA.git.fetch("refs/aw/tm0/b"), /harness network: git is cut for env A/);
    team.envB.git.fetch("refs/aw/tm0/a");
    assert.equal(await health(team.envA.app.serverUrl), true);
    assert.equal(await health(team.envB.app.serverUrl), true);
    team.envA.git.restoreGit();
    team.envA.git.fetch("refs/aw/tm0/b");

    await team.envA.app.dispose();
    assert.equal(await health(team.envB.app.serverUrl), true);
  } finally {
    await team.dispose();
  }
});

async function health(serverUrl: string): Promise<boolean> {
  return (await fetch(`${serverUrl}/api/health`)).ok;
}

function inboxCount(app: { query<T>(sql: string, ...params: unknown[]): T[] }, botId: number): number {
  return app.query<{ count: number }>("SELECT count(*) count FROM telegram_inbox WHERE bot_id=?", `telegram-${botId}`)[0]?.count ?? 0;
}

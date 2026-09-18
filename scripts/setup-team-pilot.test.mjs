import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePilotArgs, pilotEnv, setupTeamPilot, validTelegramToken } from "./setup-team-pilot.mjs";

const testToken = ["123456789", "AAabcdefghijklmnopqrstuvwxyz0123456"].join(":");

test("pilot arguments keep isolated ports and safe defaults", () => {
  const options = parsePilotArgs(["--server-port", "4200", "--web-port", "3200", "--label", "Teammate pilot", "--skip-install"]);
  assert.deepEqual(options, { serverPort: 4200, webPort: 3200, label: "Teammate pilot", install: false, start: true, help: false });
  assert.throws(() => parsePilotArgs(["--server-port", "3200", "--web-port", "3200"]), /must differ/);
  assert.throws(() => parsePilotArgs(["--label", "bad\nlabel"]), /one line/);
});

test("pilot environment enables only personal Telegram setup", () => {
  const contents = pilotEnv({ serverPort: 4100, webPort: 3100, label: "Teammate pilot" }, testToken);
  assert.match(contents, /^PORT=4100$/m);
  assert.match(contents, /^WEB_PORT=3100$/m);
  assert.match(contents, /^TASK_CONTROL_ENABLED=true$/m);
  assert.match(contents, /^TASK_CONTROL_TRANSPORT=telegram$/m);
  assert.match(contents, /^TEAM_ENABLED=false$/m);
  assert.match(contents, /^TASK_CONTROL_REMOTE_ACTIONS_ENABLED=false$/m);
  assert.match(contents, /^AGENT_HOST_ACCESS=false$/m);
  assert.match(contents, new RegExp(`^TELEGRAM_BOT_TOKEN="${testToken}"$`, "m"));
  assert.equal(validTelegramToken(testToken), true);
  assert.equal(validTelegramToken("not-a-token"), false);
});

test("pilot setup writes a private env and refuses existing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-pilot-setup-"));
  const options = parsePilotArgs(["--skip-install"]);
  try {
    await setupTeamPilot({ root, options, checkGit: false, checkPorts: false, runInstall: false, tokenProvider: async () => testToken, log: () => undefined });
    assert.match(await readFile(join(root, ".env"), "utf8"), /^TEAM_ENABLED=false$/m);
    assert.equal((await stat(join(root, ".env"))).mode & 0o777, 0o600);
    await assert.rejects(
      setupTeamPilot({ root, options, checkGit: false, checkPorts: false, runInstall: false, tokenProvider: async () => testToken, log: () => undefined }),
      /Refusing to replace \.env/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "team-pilot-state-"));
  try {
    await mkdir(join(stateRoot, ".agent-console"));
    await assert.rejects(
      setupTeamPilot({ root: stateRoot, options, checkGit: false, checkPorts: false, runInstall: false, tokenProvider: async () => testToken, log: () => undefined }),
      /Refusing to reuse \.agent-console/,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

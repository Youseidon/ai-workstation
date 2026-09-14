import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LiveSetupError, loadLiveConfig } from "./env/liveConfig.ts";
import { knownSecrets } from "./env/orchestrator.ts";
import { forgetCodexTrust } from "./env/providerState.ts";
import { sweep } from "./env/sweep.ts";
import { PreflightError, preflightBot } from "./env/telegramPreflight.ts";
import { FakeTelegramServer } from "./fakes/telegramServer.ts";
import { t3Rows } from "./scenarioTables.ts";

// Scenario IDs refer to docs/e2e-scenarios/h6.md. T0 rows: live setup, the guard's setup side and secrets.

const e2eDir = resolve(import.meta.dirname, "..");
const TOKEN = `8123456789:${"Q".repeat(20)}${randomBytes(12).toString("base64url")}`;
const VALID = {
  E2E_TELEGRAM_TEST_BOT_TOKEN: TOKEN,
  E2E_TELEGRAM_API_ID: "123456",
  E2E_TELEGRAM_API_HASH: randomBytes(16).toString("hex"),
  E2E_TELEGRAM_USER_SESSION: `1BQ${randomBytes(60).toString("base64url")}`,
  E2E_TELEGRAM_TEST_BOT_ID: "8123456789",
  E2E_TELEGRAM_TEST_BOT_USERNAME: "harness_test_bot",
  E2E_TELEGRAM_OPERATOR_BOT_ID: "7000000001",
  E2E_TELEGRAM_OPERATOR_USER_ID: "918273645",
};

function withDirs(fn: (dirs: { home: string; repo: string; live: string }) => void): void {
  const base = mkdtempSync(join(tmpdir(), "h6-live-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  mkdirSync(join(home, ".config/ai-workstation"), { recursive: true });
  mkdirSync(repo);
  try {
    fn({ home, repo, live: join(home, ".config/ai-workstation/e2e-live.env") });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeLive(path: string, values: Record<string, string>, mode = 0o600): void {
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  chmodSync(path, mode);
}

function blocked(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LiveSetupError, `expected a LiveSetupError, got ${String(error)}`);
    return error.message;
  }
  assert.fail("expected the setup to be blocked");
}

const noSecretIn = (message: string) => {
  for (const value of [TOKEN, TOKEN.split(":")[1]!, VALID.E2E_TELEGRAM_API_HASH, VALID.E2E_TELEGRAM_USER_SESSION]) assert.ok(!message.includes(value), "a secret appeared in the setup message");
};

test("S-H6-23: without a live file, e2e:live starts nothing, lists every T3 row as blocked and exits non-zero", () => {
  withDirs(({ home }) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/live.ts", "--project=t3"], { cwd: e2eDir, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.ok(Date.now() - started < 20_000, "blocked within seconds");
    const output = result.stdout + result.stderr;
    assert.match(output, /T3 blocked on setup: .*e2e-live\.env does not exist\. Follow docs\/e2e-live-setup\.md/);
    const rows = t3Rows();
    assert.ok(rows.includes("S-L1-05") && rows.includes("S-H6-01") && rows.includes("S-CLT-03"));
    for (const row of rows) assert.match(output, new RegExp(`${row}: blocked on setup`));
    assert.doesNotMatch(output, /\d+ (passed|skipped)|Running \d+ test/);
  });
});

test("S-H6-24: each incomplete or inconsistent live file is blocked on setup with its own reason and no secret", () => {
  withDirs(({ live, repo }) => {
    for (const key of Object.keys(VALID).filter((name) => name !== "E2E_TELEGRAM_OPERATOR_BOT_ID")) {
      for (const value of [undefined, ""]) {
        const values: Record<string, string> = { ...VALID };
        if (value === undefined) delete values[key];
        else values[key] = value;
        writeLive(live, values);
        const message = blocked(() => loadLiveConfig(live, repo));
        assert.match(message, new RegExp(`missing ${key}`));
        noSecretIn(message);
      }
    }
    const reasons = new Set<string>();
    for (const [change, pattern] of [
      [{ E2E_TELEGRAM_API_ID: "12ab" }, /E2E_TELEGRAM_API_ID is not a positive integer/],
      [{ E2E_TELEGRAM_TEST_BOT_ID: "8123456780" }, /does not belong to E2E_TELEGRAM_TEST_BOT_ID/],
      [{ E2E_TELEGRAM_OPERATOR_BOT_ID: "8123456789" }, /the test bot is the operator's own bot/],
    ] as const) {
      writeLive(live, { ...VALID, ...change });
      const message = blocked(() => loadLiveConfig(live, repo));
      assert.match(message, pattern);
      noSecretIn(message);
      reasons.add(message);
    }
    assert.equal(reasons.size, 3);
    writeLive(live, VALID);
    assert.equal(loadLiveConfig(live, repo).testBotId, "8123456789");
  });
});

test("S-H6-24/18/20: the bot preflight names a rejected token, the wrong bot, a webhook, another poller and an unreachable operator", async () => {
  const token = `700555666:${randomBytes(27).toString("base64url")}`;
  const server = new FakeTelegramServer();
  await server.listen();
  server.addBot({ id: 700_555_666, username: "preflight_bot", token });
  const failing = async (options: Parameters<typeof preflightBot>[0]) => preflightBot(options).then(() => assert.fail("expected the preflight to refuse"), (error: unknown) => {
    assert.ok(error instanceof PreflightError);
    for (const form of [token, token.split(":")[1]!]) assert.ok(!error.message.includes(form));
    return error.message;
  });
  try {
    assert.match(await failing({ baseUrl: server.url, token: `700555666:${"Z".repeat(35)}`, expectedBotId: "700555666" }), /rejected the test bot token/);
    assert.match(await failing({ baseUrl: server.url, token, expectedBotId: "700555667" }), /belongs to bot 700555666, not the registered test bot 700555667/);
    // A competing poller that loops like the app does: when the probe ends its poll with 409, it polls again and ends the probe's.
    let polling = true;
    const loop = (async () => {
      while (polling) {
        await fetch(`${server.url}/bot${token}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout: 1 }) }).catch(() => undefined);
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      }
    })();
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.deepEqual(await preflightBot({ baseUrl: server.url, token, expectedBotId: "700555666" }), { id: "700555666", username: "preflight_bot" }, "without a probe the preflight cannot see the poller");
    assert.match(await failing({ baseUrl: server.url, token, expectedBotId: "700555666", conflictProbeSeconds: 3 }), /another process is polling the test bot/);
    polling = false;
    await loop;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    assert.deepEqual(await preflightBot({ baseUrl: server.url, token, expectedBotId: "700555666", conflictProbeSeconds: 1 }), { id: "700555666", username: "preflight_bot" }, "with the poller gone the probe passes");
  } finally {
    await server.close();
  }
  const stub = createServer((req, res) => {
    const method = req.url?.split("/").at(-1);
    const bodies: Record<string, unknown> = {
      getMe: { ok: true, result: { id: 700555666, is_bot: true, first_name: "b", username: "preflight_bot" } },
      getWebhookInfo: { ok: true, result: { url: req.headers["x-webhook"] === "set" ? "https://example.invalid/hook" : "", pending_update_count: 0 } },
      getUpdates: { ok: true, result: [] },
      sendChatAction: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
      deleteWebhook: { ok: true, result: true },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(bodies[method ?? ""] ?? { ok: false, error_code: 404 }));
  });
  await new Promise<void>((resolveListen) => stub.listen(0, "127.0.0.1", resolveListen));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  try {
    assert.match(await failing({ baseUrl: stubUrl, token, expectedBotId: "700555666", operatorChatId: "918273645" }), /cannot message your account; open the test bot in Telegram and press Start/);
    const withWebhook = createServer((req, res) => stub.emit("request", Object.assign(req, { headers: { ...req.headers, "x-webhook": "set" } }), res));
    await new Promise<void>((resolveListen) => withWebhook.listen(0, "127.0.0.1", resolveListen));
    try {
      assert.match(await failing({ baseUrl: `http://127.0.0.1:${(withWebhook.address() as AddressInfo).port}`, token, expectedBotId: "700555666" }), /a webhook is set on the test bot/);
    } finally {
      withWebhook.close();
    }
  } finally {
    stub.close();
  }
});

test("S-H6-21 (preflight part): the preflight drops updates earlier runs left pending", async () => {
  const token = `700555777:${randomBytes(27).toString("base64url")}`;
  const server = new FakeTelegramServer();
  await server.listen();
  const bot = { id: 700_555_777, username: "stale_bot", token };
  server.addBot(bot);
  const chat = { id: 42, type: "private" as const };
  server.registerChat(chat);
  try {
    server.userSendsMessage(bot, { id: 42, firstName: "Jo" }, chat, "/start old-code");
    server.userSendsMessage(bot, { id: 42, firstName: "Jo" }, chat, "stale reply");
    assert.equal(server.pendingUpdateCount(bot.id), 2);
    await preflightBot({ baseUrl: server.url, token, expectedBotId: "700555777" });
    assert.equal(server.pendingUpdateCount(bot.id), 0);
  } finally {
    await server.close();
  }
});

test("S-H6-17: an empty operator bot id is blocked when an operator bot exists, and allowed when none does", () => {
  withDirs(({ live, repo }) => {
    writeLive(live, { ...VALID, E2E_TELEGRAM_OPERATOR_BOT_ID: "" });
    assert.equal(loadLiveConfig(live, repo).operatorBotId, "", "no repository .env: no operator bot to protect");
    writeFileSync(join(repo, ".env"), "PORT=4000\n");
    assert.equal(loadLiveConfig(live, repo).operatorBotId, "");
    writeFileSync(join(repo, ".env"), `TELEGRAM_BOT_TOKEN=7000000001:${"R".repeat(35)}\n`);
    const message = blocked(() => loadLiveConfig(live, repo));
    assert.match(message, /E2E_TELEGRAM_OPERATOR_BOT_ID is empty although the repository \.env has a bot token/);
    assert.ok(!message.includes("R".repeat(35)));
    const withoutKey: Record<string, string> = { ...VALID };
    delete withoutKey.E2E_TELEGRAM_OPERATOR_BOT_ID;
    writeLive(live, withoutKey);
    blocked(() => loadLiveConfig(live, repo));
  });
});

test("S-H6-27: the live file must be outside the repository and readable only by its owner", () => {
  withDirs(({ live, repo }) => {
    writeLive(live, VALID, 0o644);
    assert.match(blocked(() => loadLiveConfig(live, repo)), /readable by other users \(mode 644\); run chmod 600/);
    writeLive(live, VALID, 0o640);
    assert.match(blocked(() => loadLiveConfig(live, repo)), /mode 640/);
    writeLive(live, VALID);
    loadLiveConfig(live, repo);
    const inside = join(repo, "e2e-live.env");
    writeLive(inside, VALID);
    assert.match(blocked(() => loadLiveConfig(inside, repo)), /resolves inside the repository/);
    const link = join(repo, "..", "home", "link.env");
    symlinkSync(inside, link);
    assert.match(blocked(() => loadLiveConfig(link, repo)), /resolves inside the repository/);
  });
});

test("S-H6-25: the sweep catches live secrets in every artifact kind and form; ids are not secrets", () => {
  withDirs(({ live, repo, home }) => {
    writeLive(live, VALID);
    const secrets = knownSecrets(live, join(repo, ".env"));
    assert.deepEqual(secrets.map((secret) => secret.label).sort(), ["live:E2E_TELEGRAM_API_HASH", "live:E2E_TELEGRAM_TEST_BOT_TOKEN", "live:E2E_TELEGRAM_USER_SESSION"]);
    const artifacts = join(home, "artifacts");
    mkdirSync(artifacts);
    writeFileSync(join(artifacts, "server.log"), `bot ${VALID.E2E_TELEGRAM_TEST_BOT_ID} user ${VALID.E2E_TELEGRAM_OPERATOR_USER_ID} api ${VALID.E2E_TELEGRAM_API_ID}\n`);
    assert.deepEqual(sweep([artifacts], secrets), [], "ids and api_id are not secrets");
    const plants: Array<[string, string, RegExp]> = [
      ["server.log", `GET /bot${TOKEN}/getMe`, /E2E_TELEGRAM_TEST_BOT_TOKEN$/],
      ["telegram-proxy.log", `url=/bot${encodeURIComponent(TOKEN)}/getUpdates`, /E2E_TELEGRAM_TEST_BOT_TOKEN \(url-encoded\)$/],
      ["report.json", JSON.stringify({ error: `token half ${TOKEN.split(":")[1]}` }), /E2E_TELEGRAM_TEST_BOT_TOKEN \(secret half\)$/],
      ["console.sqlite", `SQLite format 3\0${VALID.E2E_TELEGRAM_API_HASH}`, /E2E_TELEGRAM_API_HASH$/],
      ["web.log", `session=${VALID.E2E_TELEGRAM_USER_SESSION}`, /E2E_TELEGRAM_USER_SESSION$/],
    ];
    for (const [file, content, label] of plants) {
      const dir = join(home, `plant-${file}`);
      mkdirSync(dir);
      writeFileSync(join(dir, file), content);
      const findings = sweep([dir], secrets);
      assert.ok(findings.some((finding) => label.test(finding.secretLabel) && finding.file.endsWith(file)), `${file}: ${JSON.stringify(findings)}`);
      assert.ok(!JSON.stringify(findings).includes(TOKEN.split(":")[1]!) && !JSON.stringify(findings).includes(VALID.E2E_TELEGRAM_API_HASH));
    }
    const traceDir = join(home, "trace");
    mkdirSync(join(traceDir, "resources"), { recursive: true });
    writeFileSync(join(traceDir, "resources", "network.txt"), `authorization ${VALID.E2E_TELEGRAM_USER_SESSION}`);
    const zipped = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write('resources/network.txt'); z.close()", join(traceDir, "trace.zip")], { cwd: traceDir });
    assert.equal(zipped.status, 0);
    rmSync(join(traceDir, "resources"), { recursive: true });
    assert.ok(sweep([traceDir], secrets).some((finding) => finding.entry === "resources/network.txt" && finding.secretLabel === "live:E2E_TELEGRAM_USER_SESSION"));
  });
});

test("real-provider hygiene: the harness removes only the Codex trust entries under its own root", () => {
  withDirs(({ home }) => {
    const config = join(home, "config.toml");
    const root = "/tmp/ai-workstation-e2e-Ab12Cd";
    const operator = 'model = "gpt-5.5"\n[projects."/home/op/project"]\ntrust_level = "trusted"\n\n';
    const other = '[projects."/tmp/ai-workstation-e2e-Zz99Yy/workspaces/real-codex-1"]\ntrust_level = "trusted"\n\n';
    writeFileSync(config, `${operator}[projects."${root}/workspaces/real-codex-1"]\ntrust_level = "trusted"\n\n${other}[tui.model_availability_nux]\n"gpt-5.5" = 4\n`);
    assert.equal(forgetCodexTrust(root, config), 1);
    assert.equal(readFileSync(config, "utf8"), `${operator}${other}[tui.model_availability_nux]\n"gpt-5.5" = 4\n`);
    assert.equal(forgetCodexTrust(root, config), 0);
    assert.equal(forgetCodexTrust(root, join(home, "missing.toml")), 0);
  });
});

/*
 * `npm run e2e:live`: the T3 tier on real Telegram (docs/e2e-harness-plan.md 5, docs/e2e-scenarios/h6.md S-H6-23, S-H6-36).
 *
 *   node --import tsx scripts/live.ts --project=t3 [playwright args]
 *
 * Before anything starts it loads the live setup. When setup is missing it starts no process and makes no
 * network call: it lists every T3 row of the scenario tables as blocked on setup, writes
 * test-results/t3-blocked.json for the coverage matrix, and exits non-zero. Otherwise it runs Playwright and,
 * for an unfiltered run, fails when a T3 row has no result, and reports the runtime against the 25-minute target.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LiveSetupError, loadLiveConfig, type LiveConfig } from "../src/env/liveConfig.ts";
import { PreflightError, preflightBot } from "../src/env/telegramPreflight.ts";
import { t3Rows } from "../src/scenarioTables.ts";

const e2eDir = resolve(import.meta.dirname, "..");
const blockedFile = join(e2eDir, "test-results/t3-blocked.json");
const TARGET_MINUTES = 25;
const RUN_ROW = "S-H6-36";

function reportedIds(): Set<string> {
  const ids = new Set<string>();
  const report = join(e2eDir, "test-results/report.json");
  if (!existsSync(report)) return ids;
  const text = readFileSync(report, "utf8");
  for (const match of text.matchAll(/S-[A-Z0-9]+-\d+(?:\/\d+)*/g)) {
    const [first, ...rest] = match[0].split("/");
    ids.add(first!);
    const prefix = first!.slice(0, first!.lastIndexOf("-") + 1);
    for (const number of rest) ids.add(`${prefix}${number}`);
  }
  return ids;
}

const args = process.argv.slice(2);
try {
  const config: LiveConfig = loadLiveConfig();
  // Once per run: a competing poller or a webhook would make every T3 scenario time out one by one (S-H6-20).
  await preflightBot({ baseUrl: "https://api.telegram.org", token: config.testBotToken, expectedBotId: config.testBotId, operatorChatId: config.operatorUserId, conflictProbeSeconds: 10 }).catch((error: unknown) => {
    throw error instanceof PreflightError ? new LiveSetupError(error.message) : error;
  });
  const { TelegramUserPhone } = await import("../src/drivers/telegramUserPhone.ts");
  const phone = new TelegramUserPhone(config);
  try {
    await phone.connect();
  } finally {
    await phone.disconnect().catch(() => undefined);
  }
} catch (error) {
  if (!(error instanceof LiveSetupError)) throw error;
  const rows = t3Rows();
  mkdirSync(join(e2eDir, "test-results"), { recursive: true });
  writeFileSync(blockedFile, `${JSON.stringify({ at: new Date().toISOString(), reason: error.message, rows }, null, 2)}\n`);
  console.error(error.message);
  console.error(`\n${rows.length} T3 rows blocked on setup (none passed, none skipped):\n${rows.map((row) => `  ${row}: blocked on setup`).join("\n")}`);
  process.exit(2);
}

rmSync(blockedFile, { force: true });
rmSync(join(e2eDir, "test-results/t3-run.json"), { force: true });
const started = Date.now();
const result = spawnSync("npx", ["playwright", "test", ...(args.some((arg) => arg.startsWith("--project=")) ? [] : ["--project=t3"]), ...args], { cwd: e2eDir, stdio: "inherit" });
const minutes = (Date.now() - started) / 60_000;
console.log(`\nT3 runtime ${minutes.toFixed(1)} min (target ${TARGET_MINUTES} min)${minutes > TARGET_MINUTES ? ": OVER TARGET" : ""}`);
const filtered = args.some((arg) => arg === "-g" || arg.startsWith("--grep") || arg.endsWith(".spec.ts") || arg.startsWith("tests/"));
if (!filtered) {
  // S-H6-36 is this check itself: every other T3 row has a result and the runtime is reported.
  const seen = reportedIds();
  const missing = t3Rows().filter((row) => row !== RUN_ROW && !seen.has(row));
  const passed = missing.length === 0 && result.status === 0 && minutes <= TARGET_MINUTES;
  writeFileSync(join(e2eDir, "test-results/t3-run.json"), `${JSON.stringify({ at: new Date().toISOString(), row: RUN_ROW, passed, minutes: Number(minutes.toFixed(1)), missing }, null, 2)}\n`);
  console.log(`${RUN_ROW}: ${passed ? "pass" : "FAIL"}`);
  if (missing.length > 0) {
    console.error(`T3 rows with no result (a row may not be silently omitted): ${missing.join(", ")}`);
    process.exit(result.status === 0 ? 1 : (result.status ?? 1));
  }
}
process.exit(result.status ?? 1);

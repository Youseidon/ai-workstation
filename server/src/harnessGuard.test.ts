import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HARNESS_GUARD_EXIT_CODE, HarnessGuardError, assertHarnessRoot, assertLoopbackUrl, assertNotOperatorBot } from "./harnessGuard.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md.

const repoRoot = resolve(import.meta.dirname, "../..");

function refuses(fn: () => void, code: HarnessGuardError["code"]): void {
  assert.throws(fn, (error: unknown) => error instanceof HarnessGuardError && error.code === code);
}

test("S-H1-02/03: harness mode refuses a missing root and the real root in every spelling", () => {
  const link = join(mkdtempSync(join(tmpdir(), "guard-link-")), "repo");
  symlinkSync(repoRoot, link);
  try {
    refuses(() => assertHarnessRoot({ envRoot: undefined, repoRoot, settingsFile: undefined }), "harness_real_root");
    refuses(() => assertHarnessRoot({ envRoot: "  ", repoRoot, settingsFile: undefined }), "harness_real_root");
    for (const spelling of [repoRoot, `${repoRoot}/`, join(repoRoot, "server", ".."), link]) {
      refuses(() => assertHarnessRoot({ envRoot: spelling, repoRoot, settingsFile: undefined }), "harness_real_root");
    }
    const root = mkdtempSync(join(tmpdir(), "guard-root-"));
    assert.doesNotThrow(() => assertHarnessRoot({ envRoot: root, repoRoot, settingsFile: undefined }));
    assert.doesNotThrow(() => assertHarnessRoot({ envRoot: root, repoRoot, settingsFile: ".agent-console/settings.json" }));
    refuses(() => assertHarnessRoot({ envRoot: root, repoRoot, settingsFile: join(repoRoot, ".agent-console/settings.json") }), "harness_settings_outside_root");
    refuses(() => assertHarnessRoot({ envRoot: root, repoRoot, settingsFile: "../elsewhere.json" }), "harness_settings_outside_root");
    rmSync(root, { recursive: true, force: true });
  } finally {
    rmSync(resolve(link, "../"), { recursive: true, force: true });
  }
});

test("S-H3-01: fake URLs must be literal loopback", () => {
  for (const bad of ["https://example.com", "http://10.0.0.5:8080", "http://0.0.0.0:1", "http://localhost:1", "http://127.0.0.1.example.com", "ftp://127.0.0.1/", "http://user:pw@127.0.0.1:1", "not a url"]) {
    refuses(() => assertLoopbackUrl("TELEGRAM_API_BASE_URL", bad), "harness_non_loopback_url");
  }
  assert.equal(assertLoopbackUrl("X", "http://127.0.0.1:4555").port, "4555");
  assert.equal(assertLoopbackUrl("X", "http://[::1]:4555").hostname, "[::1]");
});

test("S-H1-04 (guard part): the operator's bot id is refused, the test bot is accepted", () => {
  refuses(() => assertNotOperatorBot(12345, "999, 12345"), "harness_operator_bot");
  assert.doesNotThrow(() => assertNotOperatorBot(777, "999,12345"));
  assert.doesNotThrow(() => assertNotOperatorBot(777, undefined));
  const error = (() => {
    try {
      assertNotOperatorBot("12345", "12345");
    } catch (caught) {
      return caught as Error;
    }
    return null;
  })();
  assert.match(error?.message ?? "", /12345/);
});

test("S-H1-02: the server process exits with the guard code before opening a database or port", () => {
  const empty = mkdtempSync(join(tmpdir(), "guard-proc-"));
  try {
    for (const envRoot of [repoRoot, undefined]) {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: empty, AGENT_CONSOLE_HARNESS: "1", PORT: "4199" };
      if (envRoot !== undefined) env.AGENT_CONSOLE_REPO_ROOT = envRoot;
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: join(repoRoot, "server"), env, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, HARNESS_GUARD_EXIT_CODE, result.stderr);
      assert.match(result.stderr, /^harness_real_root: /m);
      assert.doesNotMatch(result.stdout + result.stderr, /listening|migrat/i);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

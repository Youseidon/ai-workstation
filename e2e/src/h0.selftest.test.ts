import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileHashes } from "./realState.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md.

const e2eDir = resolve(import.meta.dirname, "..");
const selftestDir = join(e2eDir, "selftest");

function playwright(args: string[], env: Record<string, string>) {
  return spawnSync("npx", ["playwright", "test", "--config", join(selftestDir, "playwright.selftest.config.ts"), ...args.map((arg) => join(selftestDir, arg))], {
    cwd: selftestDir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("S-H0-02: a failing scenario exits non-zero, names the test and keeps a trace and screenshot", () => {
  const out = mkdtempSync(join(tmpdir(), "e2e-selftest-"));
  try {
    const result = playwright(["fixtures/forced-failure.spec.ts"], { SELFTEST_OUTPUT_DIR: out });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as { stats: { unexpected: number } };
    assert.equal(report.stats.unexpected, 1);
    assert.match(readFileSync(join(out, "report.json"), "utf8"), /forced failure leaves artifacts/);
    const files = walk(out);
    assert.ok(files.some((file) => file.endsWith("trace.zip")), "trace kept");
    assert.ok(files.some((file) => file.endsWith(".png")), "screenshot kept");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("S-H0-07: burn-in runs a scenario 20 times and fails when one iteration fails", () => {
  for (const [flaky, expectPass] of [["0", true], ["13", false]] as const) {
    const out = mkdtempSync(join(tmpdir(), "e2e-burnin-"));
    const counter = join(out, "counter");
    try {
      const result = spawnSync("node", [join(e2eDir, "scripts/burn-in.mjs"), "--repeat=20", "--config", join(selftestDir, "playwright.selftest.config.ts"), join(selftestDir, "fixtures/flaky-once.spec.ts")], {
        cwd: selftestDir,
        env: { ...process.env, SELFTEST_OUTPUT_DIR: out, SELFTEST_COUNTER_FILE: counter, SELFTEST_FLAKY_ITERATION: flaky },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, expectPass, result.stdout + result.stderr);
      const runs = readFileSync(counter, "utf8").length;
      if (expectPass) assert.equal(runs, 20);
      else assert.equal(runs, 13, "stops at the first failure");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("S-H0-05: the accessibility scanner is wired and can fail", () => {
  const out = mkdtempSync(join(tmpdir(), "e2e-axe-"));
  try {
    const result = playwright(["fixtures/axe-violation.spec.ts"], { SELFTEST_OUTPUT_DIR: out });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("S-H0-06: the tier scripts resolve and select their project", () => {
  const pkg = JSON.parse(readFileSync(join(e2eDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.e2e ?? "", /--project=t1/);
  assert.match(pkg.scripts["e2e:visual"] ?? "", /--project=t2/);
  assert.match(pkg.scripts["e2e:live"] ?? "", /--project=t3/);
  const root = JSON.parse(readFileSync(join(e2eDir, "../package.json"), "utf8")) as { scripts: Record<string, string>; workspaces: string[] };
  assert.ok(root.workspaces.includes("e2e"));
  for (const name of ["e2e", "e2e:visual", "e2e:live", "e2e:burn-in"]) assert.match(root.scripts[name] ?? "", /--workspace e2e/);
});

test("S-H0-01/03/08: the foundation scenario passes in Chromium and leaves the operator's files untouched", () => {
  const before = fileHashes();
  const result = spawnSync("npx", ["playwright", "test", "--project=t1", "tests/t1/h0-foundation.spec.ts"], { cwd: e2eDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed/);
  assert.deepEqual(fileHashes(), before);
  assert.ok(existsSync(join(e2eDir, "test-results")));
});

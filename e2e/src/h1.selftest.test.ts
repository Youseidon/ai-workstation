import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { HarnessEnvironment } from "./env/orchestrator.ts";
import { sweep } from "./env/sweep.ts";
import { HARNESS_ROOT_PREFIX, realDatabaseHarnessRows } from "./realState.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md.

const e2eDir = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("S-H1-09: a real-database row pointing into a harness root is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "pollution-"));
  try {
    const path = join(dir, "console.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE workspace (id INTEGER PRIMARY KEY, name TEXT, work_directory TEXT)");
    db.prepare("INSERT INTO workspace(name, work_directory) VALUES (?, ?)").run("operator", "/home/someone/project");
    db.prepare("INSERT INTO workspace(name, work_directory) VALUES (?, ?)").run("like_wildcard", "/tmp/ai-workstation-e2eX");
    db.close();
    assert.deepEqual(realDatabaseHarnessRows(path), []);
    const again = new Database(path);
    again.prepare("INSERT INTO workspace(name, work_directory) VALUES (?, ?)").run("polluted", `${HARNESS_ROOT_PREFIX}abc/workspaces/x`);
    again.close();
    assert.equal(realDatabaseHarnessRows(path).length, 1);
    assert.match(realDatabaseHarnessRows(path)[0] ?? "", /polluted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-H1-10: the sweep finds a planted secret in plain files and inside trace archives, and reports no value", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-"));
  const secret = { label: "planted", value: "123456789:AAplantedSecretValue_xyz" };
  try {
    writeFileSync(join(dir, "server.log"), "all clean\n");
    assert.deepEqual(sweep([dir], [secret]), []);
    writeFileSync(join(dir, "server.log"), `line\nGET /bot${secret.value}/getMe\n`);
    mkdirSync(join(dir, "trace"));
    writeFileSync(join(dir, "trace", "network.txt"), `authorization ${secret.value}`);
    const zip = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write('trace/network.txt'); z.close()", join(dir, "trace.zip")], { cwd: dir });
    assert.equal(zip.status, 0, String(zip.stderr));
    rmSync(join(dir, "trace"), { recursive: true });
    const findings = sweep([dir], [secret]);
    assert.ok(findings.some((finding) => finding.file.endsWith("server.log") && finding.offset === 13));
    assert.ok(findings.some((finding) => finding.file.endsWith("trace.zip") && finding.entry === "trace/network.txt"));
    assert.ok(!JSON.stringify(findings).includes(secret.value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-H1-14: a busy harness port fails fast and never falls back to the operator's ports", async () => {
  const blocker = createServer();
  await new Promise<void>((resolveListen) => blocker.listen(4100, "127.0.0.1", resolveListen));
  const environment = new HarnessEnvironment();
  try {
    await assert.rejects(() => environment.start(), /harness port 4100 is already in use/);
    assert.equal(environment.server.pid, null);
    assert.equal(environment.web.pid, null);
  } finally {
    blocker.close();
    await environment.dispose();
  }
});

test("S-H1-11: a failing harness scenario keeps trace, screenshot, logs and a database copy", () => {
  const out = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  try {
    const result = spawnSync("npx", ["playwright", "test", "--config", join(e2eDir, "selftest/playwright.selftest.config.ts"), join(e2eDir, "selftest/fixtures/harness-forced-failure.spec.ts")], {
      cwd: join(e2eDir, "selftest"),
      env: { ...process.env, SELFTEST_OUTPUT_DIR: out },
      encoding: "utf8",
      timeout: 5 * 60_000,
    });
    assert.notEqual(result.status, 0);
    const files = walk(out);
    for (const suffix of ["trace.zip", ".png", "harness/server.log", "harness/web.log", "harness/console.sqlite"]) {
      assert.ok(files.some((file) => file.endsWith(suffix)), `missing ${suffix} in ${files.join(", ")}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

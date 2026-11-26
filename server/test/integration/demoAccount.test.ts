import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import type { DemoSeedProgress, IdentitySession, RunChangeSummary, WorkspaceRecord } from "@hydra/shared";

test("Try the demo creates a seeded throwaway account in its own folder and removes it when it expires", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-demo-flow-"));
  const database = join(dir, "hydra.sqlite");
  const demoRoot = join(dir, "demo-root");
  // Only git on PATH: seeding needs it, and no provider CLI must be found.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  const env = { ...process.env, HYDRA_DB: database, SETTINGS_FILE: join(dir, "settings.json"), HYDRA_DEMO_ROOT: demoRoot, HYDRA_MODE: "serve", PORT: "0", HOST: "127.0.0.1", PATH: bin, ALLOWED_ORIGINS: "http://localhost:3100" };
  const child = fork(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), [], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  try {
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error(`Gateway exited: ${output}`); }),
    ]);
    const base = `http://127.0.0.1:${(ready[0] as { port: number }).port}`;
    const call = (path: string, cookie = "", method = "GET") => fetch(`${base}${path}`, { method, headers: { Origin: "http://localhost:3100", ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });

    assert.deepEqual(await (await call("/api/auth/demo")).json(), { available: true, lifetimeHours: 24 });
    const started = await call("/api/auth/demo", "", "POST");
    assert.equal(started.status, 200);
    const cookie = started.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const lines = (await started.text()).trim().split("\n").map(line => JSON.parse(line) as DemoSeedProgress);
    assert.deepEqual(lines.at(-1)?.state, "done", `seeding failed: ${JSON.stringify(lines.at(-1))}\n${output}`);
    for (const step of ["account", "runtime", "folder", "git", "workspace", "library", "pipelines", "chats", "stations", "settings", "ready"]) {
      assert.ok(lines.some(line => line.step === step && line.state === "done"), `missing step ${step}`);
    }

    const session = await (await call("/api/auth/session", cookie)).json() as IdentitySession;
    assert.equal(session.user?.demo, true);
    assert.match(session.user?.username ?? "", /^demo-[a-z]+-[0-9a-f]{6}$/);
    const username = session.user!.username;

    const { workspaces } = await (await call("/api/workspaces", cookie)).json() as { workspaces: WorkspaceRecord[] };
    assert.equal(workspaces.length, 1);
    const workspace = workspaces[0]!;
    assert.equal(workspace.workDirectory, join(demoRoot, username, "kettle"));
    assert.equal(readFileSync(join(demoRoot, username, ".hydra-demo-owner"), "utf8").trim(), username);
    // The sample is a real, clean repository whose tests pass.
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace.workDirectory, encoding: "utf8" }), "");
    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd: workspace.workDirectory, encoding: "utf8" });
    assert.match(log, /Claude via Hydra\|Add pause and resume/);
    assert.match(log, /Demo Operator\|Kettle: a tiny tea timer/);
    execFileSync(process.execPath, ["--test"], { cwd: workspace.workDirectory, stdio: "pipe" });

    const threads = await (await call(`/api/workspaces/${workspace.id}/threads`, cookie)).json() as { threads: Array<{ title: string; pinned: boolean; unread: boolean }> };
    assert.equal(threads.threads.length, 4);
    assert.ok(threads.threads[0]?.pinned);
    assert.ok(threads.threads.some(thread => thread.unread));

    const { changes } = await (await call(`/api/changes?workspace=${workspace.id}`, cookie)).json() as { changes: RunChangeSummary[] };
    assert.equal(changes.length, 4);
    assert.ok(changes.every(change => change.state === "COMMITTED"));
    assert.ok(changes.some(change => change.pipeline?.name === "Ship Kettle v1"));
    const diff = await (await call(`/api/runs/${changes[0]!.runId}/changes`, cookie)).json() as { changes: { files: unknown[] } };
    assert.ok(diff.changes.files.length > 0);

    const sessions = await (await call("/api/sessions", cookie)).json() as { sessions: Array<{ startedAt: string; state: string }> };
    assert.ok(sessions.sessions.length >= 9);
    assert.ok(sessions.sessions.every(run => run.state !== "RUNNING" && run.state !== "STARTING"));
    assert.ok(sessions.sessions.some(run => Date.now() - Date.parse(run.startedAt) > 4 * 24 * 60 * 60_000), "history is spread over days");
    assert.match(await (await call("/api/pipelines", cookie)).text(), /Ship Kettle v1/);
    const tree = await (await call(`/api/workspaces/${workspace.id}/tree`, cookie)).json() as { workspace: { programs: Array<{ suites: Array<{ prompts: Array<{ externalKey: string; status: string }> }> }> } };
    const statuses = Object.fromEntries(tree.workspace.programs.flatMap(program => program.suites.flatMap(suite => suite.prompts.map(prompt => [prompt.externalKey, prompt.status]))));
    assert.equal(statuses["K-1"], "DONE");
    assert.equal(statuses["K-2"], "DONE");
    assert.equal(statuses["K-4"], "BLOCKED");
    assert.equal(statuses["K-5"], "TODO");
    assert.notEqual(statuses["K-3"], "IN_PROGRESS", "the failed station must not look like it is still running");
    assert.match(await (await call("/api/settings", cookie)).text(), /"budget.maxSpendUsd"/);

    // A browser cannot ask a runtime to seed again, and demos cannot link Telegram.
    assert.equal((await call("/api/demo/seed", cookie, "POST")).status, 404);
    assert.equal((await call("/api/auth/telegram/link", cookie, "POST")).status, 403);

    // Expire it, restart, and everything it owned is gone.
    child.kill("SIGTERM");
    await once(child, "exit");
    const registry = new Database(`${database}.identities.sqlite`);
    registry.prepare("UPDATE identity_demo SET expires_at=0").run();
    registry.close();
    const restarted = fork(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), [], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    try {
      const again = await once(restarted, "message");
      const next = `http://127.0.0.1:${(again[0] as { port: number }).port}`;
      for (let attempt = 0; attempt < 50 && existsSync(join(demoRoot, username)); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(join(demoRoot, username)), false);
      assert.equal(existsSync(`${database}.users/${session.user!.id}`), false);
      assert.deepEqual(await (await fetch(`${next}/api/auth/session`, { headers: { Cookie: cookie } })).json(), { user: null });
    } finally {
      restarted.kill("SIGTERM");
      await once(restarted, "exit");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    rmSync(dir, { recursive: true, force: true });
  }
});

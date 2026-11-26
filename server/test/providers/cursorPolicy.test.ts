import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCursorPolicy, installCursorHooks, probeCursorPolicy } from "../../src/providers/cursorPolicy.ts";
import { resolveStationPolicy } from "@hydra/shared";

const hook = new URL("../../bin/cursor-policy.mjs", import.meta.url).pathname;
const policy = resolveStationPolicy("No verification execution in this station. Completion evidence goes to S6-11.");

test("temporary project hooks preserve user configuration and do not enter checkpoints", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-hooks-cleanup-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root,".cursor"));
  const path = join(root,".cursor/hooks.json");
  const before = JSON.stringify({version:1,hooks:{afterFileEdit:[{command:"user-formatter"}]}});
  writeFileSync(path,before);
  const exclude = join(root,".git/info/exclude");
  const originalExclude = readFileSync(exclude,"utf8");
  try {
    const restore = installCursorHooks(root,"/tmp/test-policy.json");
    const config = JSON.parse(readFileSync(path,"utf8"));
    assert.equal(config.hooks.afterFileEdit[0].command,"user-formatter");
    assert.equal(config.hooks.preToolUse[0].failClosed,true);
    assert.equal(execFileSync("git",["status","--porcelain"],{cwd:root,encoding:"utf8"}),"");
    restore();
    assert.equal(readFileSync(path,"utf8"),before);
    assert.equal(readFileSync(exclude,"utf8"),originalExclude);
    execFileSync("git",["add",".cursor/hooks.json"],{cwd:root});
    assert.throws(()=>installCursorHooks(root,"/tmp/test-policy.json"),/Tracked/);
    assert.equal(readFileSync(path,"utf8"),before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("a crashed run's temporary hooks are retired instead of restored", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-hooks-crash-"));
  execFileSync("git",["init","-q",root]);
  try {
    const exclude = join(root,".git/info/exclude");
    const before = readFileSync(exclude,"utf8");
    installCursorHooks(root,"/tmp/crashed-policy.json");
    const restore = installCursorHooks(root,"/tmp/new-policy.json");
    const active = readFileSync(join(root,".cursor/hooks.json"),"utf8");
    assert.doesNotMatch(active,/crashed-policy/);
    assert.match(active,/new-policy/);
    restore();
    assert.equal(readFileSync(exclude,"utf8"),before);
    assert.equal(spawnSync("git",["status","--porcelain"],{cwd:root,encoding:"utf8"}).stdout,"");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Cursor gate denies test runners, wrappers and shell escapes before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-policy-test-"));
  const launcher = join(root, "agent-step");
  const plugin = createCursorPolicy({ root, launcher, policy });
  const check = (command: string) => JSON.parse(execFileSync(process.execPath, [hook, plugin.manifest], {
    timeout: 5000, input: JSON.stringify({ hook_event_name: "beforeShellExecution", command, cwd: root }), encoding: "utf8",
  }));
  try {
    for (const command of [
      "npm test", "npm run agent:run -- portal-test test/scenario", "npx vitest", "dotnet test example.csproj",
      "node scripts/test.mjs", "python3 -c 'print(1)'", "bash -c 'npm test'", "env npm test", "/tmp/npm test",
      "git status && npm test", "git status; dotnet test", "cat file | bash", "echo $(npm test)",
      "printf x > package.json", "rg --pre=./runner pattern", "git diff --output=package.json",
      "npm run agent:run -- contracts && npm test", `${launcher} check --criterion 1`,
    ]) assert.equal(check(command).permission, "deny", command);
    for (const command of ["git status --short", "rg -n marketplace src", "git diff --stat | head -40",
      "npm run agent:run -- contracts", "npm run agent:build -- src/Example.Tests.csproj",
      `${launcher} inbox`, `${launcher} checkpoint --message 'Save implementation'`, `${launcher} done --verification 'Hand off to S6-11'`]) {
      assert.equal(check(command).permission, "allow", command);
    }
    assert.match(check("npm test").agent_message, /S6-11/);
    const receipts = readFileSync(plugin.audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(receipts.some(row => row.permission === "deny"));
    assert.ok(receipts.every(row => row.command === undefined), "audit must not persist command credentials");
  } finally { plugin.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("Cursor file hooks protect policy, command entrypoints and symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-policy-files-"));
  const outside = mkdtempSync(join(tmpdir(), "cursor-policy-outside-"));
  const plugin = createCursorPolicy({ root, policy });
  const check = (path: string) => JSON.parse(execFileSync(process.execPath, [hook, plugin.manifest], {
    timeout: 5000, input: JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path } }), encoding: "utf8",
  }));
  try {
    symlinkSync(outside, join(root, "escape"));
    for (const path of [".cursor/hooks.json", "AGENTS.md", "package.json", "scripts/agent-command.mjs", "escape/test.js", plugin.manifest])
      assert.equal(check(path).permission, "deny", path);
    assert.equal(check("src/feature.js").permission, "allow");
    const hooks = JSON.parse(readFileSync(join(plugin.directory, "hooks/hooks.json"), "utf8"));
    assert.equal(hooks.hooks.beforeShellExecution[0].failClosed, true);
    writeFileSync(plugin.manifest, "invalid");
    const failed = spawnSync(process.execPath, [hook, plugin.manifest], { timeout: 5000, input: "{}", encoding: "utf8" });
    assert.equal(failed.status, 2);
    assert.equal(JSON.parse(failed.stdout).permission, "deny");
  } finally { plugin.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("Cursor refuses work when the CLI exits without invoking its policy hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-policy-probe-test-"));
  const binary = join(root, "fake-cursor");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const plugin = createCursorPolicy({ root, policy });
  try {
    await assert.rejects(probeCursorPolicy(binary, plugin, "auto", new AbortController().signal), /did not demonstrate/);
  } finally { plugin.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("Cursor probe accepts an observed denial, independent of the model's final answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-policy-probe-pass-"));
  const binary = join(root, "fake-cursor");
  const plugin = createCursorPolicy({ root, policy });
  writeFileSync(binary, `#!/bin/sh\nprintf '%s' '{"hook_event_name":"beforeShellExecution","command":"printf HYDRA_POLICY_PROBE_test"}' | '${process.execPath}' '${hook}' '${plugin.manifest}'\n`, { mode: 0o700 });
  try { await probeCursorPolicy(binary, plugin, "auto", new AbortController().signal); }
  finally { plugin.dispose(); rmSync(root, { recursive: true, force: true }); }
});

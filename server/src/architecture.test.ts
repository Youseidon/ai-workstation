import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("provider adapters cannot import persistence or know the SQLite location", () => {
  const directory=new URL("./adapters/",import.meta.url).pathname;
  for(const file of readdirSync(directory).filter(name=>name.endsWith(".ts"))){
    const source=readFileSync(join(directory,file),"utf8");
    assert.doesNotMatch(source,/better-sqlite3|workspaces\.ts|workspaceApi\.ts|runService\.ts|console\.sqlite|\.agent-console/);
  }
});

test("the WebSocket handler does not take the writer lock or start runs", () => {
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\bactiveForWorkspace\b|\bactiveExecuteForWorkspace\b/);
  assert.doesNotMatch(source,/\bbeginAgentRun\b|\bmarkAgentRunRunning\b|\bfinishAgentRun\b/);
  assert.doesNotMatch(source,/\bbeginSuiteVerification\b|\bfinishSuiteVerification\b|\bbeginClarification\b|\bfinishClarification\b/);
  assert.doesNotMatch(source,/\bstartRun\s*\(/);
  assert.match(source,/\bstartExecute\b/);
  assert.match(source,/\bstartVerifySuite\b/);
});

test("disconnect unsubscribes and does not interrupt", () => {
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  const closeAt=source.indexOf('ws.on("close"');
  assert.ok(closeAt>=0);
  const close=source.slice(closeAt,source.indexOf("ws.on(\"error\"",closeAt));
  assert.match(close,/unsubscribe\(\)/);
  assert.doesNotMatch(close,/\brunHub\.stop\b|\.interrupt\s*\(/);
});

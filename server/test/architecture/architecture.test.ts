import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("provider adapters cannot import persistence or know the SQLite location", () => {
  for (const folder of ["adapters", "streams"]) {
    const directory=new URL(`../../src/providers/${folder}/`,import.meta.url).pathname;
    for(const file of readdirSync(directory).filter(name=>name.endsWith(".ts"))){
      const source=readFileSync(join(directory,file),"utf8");
      assert.doesNotMatch(source,/better-sqlite3|workspaces\.ts|workspaceApi\.ts|runService\.ts|console\.sqlite|\.hydra/);
      assert.doesNotMatch(source, /from ["'][^"']*\/(repositories|services|api)\//);
    }
  }
});

test("source roots expose entrypoints and contracts have no runtime dependencies", () => {
  for (const directory of ["../../src/", "../../../shared/src/"]) {
    const files = readdirSync(new URL(directory, import.meta.url), { withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => entry.name);
    assert.deepEqual(files, ["index.ts"], `${directory} should organize implementations by responsibility`);
  }
  const directory = new URL("../../src/contracts/", import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, directory), "utf8");
    assert.doesNotMatch(source, /^import (?!type\b)/m, `${file} must not initialize a service or store`);
    assert.doesNotMatch(source, /^export (?:async )?(?:function|const|class)\b/m, `${file} should only describe interfaces`);
  }
});

test("the WebSocket handler does not take the writer lock or start runs", () => {
  const source=readFileSync(new URL("../../src/api/server.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\bactiveForWorkspace\b|\bactiveExecuteForWorkspace\b/);
  assert.doesNotMatch(source,/\bbeginAgentRun\b|\bmarkAgentRunRunning\b|\bfinishAgentRun\b/);
  assert.doesNotMatch(source,/\bbeginSuiteVerification\b|\bfinishSuiteVerification\b|\bbeginClarification\b|\bfinishClarification\b/);
  assert.doesNotMatch(source,/\bstartRun\s*\(/);
  assert.match(source,/\bstartExecute\b/);
  assert.match(source,/\bstartVerifySuite\b/);
  assert.match(source,/\bstartConsult\b/);
  const mapper=source.slice(source.indexOf("mapStartError"),source.indexOf("handleRun"));
  assert.doesNotMatch(mapper,/\bdetectProviders\b/);
  assert.match(mapper,/\bProviderUnavailableError\b/);
});

test("disconnect unsubscribes and does not interrupt", () => {
  const source=readFileSync(new URL("../../src/api/server.ts",import.meta.url),"utf8");
  const closeAt=source.indexOf('ws.on("close"');
  assert.ok(closeAt>=0);
  const close=source.slice(closeAt,source.indexOf("ws.on(\"error\"",closeAt));
  assert.match(close,/unsubscribe\(\)/);
  assert.doesNotMatch(close,/\brunHub\.stop\b|\.interrupt\s*\(/);
});

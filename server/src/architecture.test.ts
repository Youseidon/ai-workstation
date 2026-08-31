import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("provider adapters cannot import persistence or know the SQLite location", () => {
  const directory=new URL("./adapters/",import.meta.url).pathname;
  for(const file of readdirSync(directory).filter(name=>name.endsWith(".ts"))){
    const source=readFileSync(join(directory,file),"utf8");
    assert.doesNotMatch(source,/better-sqlite3|workspaces\.ts|workspaceApi\.ts|console\.sqlite|\.agent-console/);
  }
});

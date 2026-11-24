import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentFingerprint } from "../src/sourceFingerprint.ts";

test("provider SDK startup metadata does not stale command evidence; command inputs still do",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fingerprint-env-"));
  const sdk=process.env.CLAUDE_AGENT_SDK_VERSION,flag=process.env.RELIABILITY_COMMAND_FLAG;
  try {
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    const before=environmentFingerprint(dir);
    process.env.CLAUDE_AGENT_SDK_VERSION="fixture-sdk-version";
    assert.equal(environmentFingerprint(dir),before);
    process.env.RELIABILITY_COMMAND_FLAG="changed-command-input";
    assert.notEqual(environmentFingerprint(dir),before);
  } finally {
    if(sdk===undefined)delete process.env.CLAUDE_AGENT_SDK_VERSION;else process.env.CLAUDE_AGENT_SDK_VERSION=sdk;
    if(flag===undefined)delete process.env.RELIABILITY_COMMAND_FLAG;else process.env.RELIABILITY_COMMAND_FLAG=flag;
    rmSync(dir,{recursive:true,force:true});
  }
});

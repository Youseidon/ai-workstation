import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GrokAdapter, grokInstructionArgs } from "../../../src/providers/adapters/grok.ts";
import type { RunOptions } from "../../../src/contracts/agentAdapter.ts";
import { createLogger } from "../../../src/utils/logger.ts";

class InspectableGrok extends GrokAdapter {
  spec(cwd: string, resumeSessionId?: string) {
    return this.buildSpec("Continue the saved work item.", {
      cwd, runId: "instruction-test", model: null, resumeSessionId,
      permissionOverride: "inherit", signal: new AbortController().signal,
      log: createLogger("grok-instructions-test"),
    } satisfies RunOptions);
  }
}

function fixture(t: test.TestContext): string {
  const cwd = mkdtempSync(join(tmpdir(), "grok-instructions-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("new and resumed headless launches explicitly deliver the complete workspace rules", (t) => {
  const cwd = fixture(t);
  const policy = `# Workspace rules\n\n${"Keep existing behavior.\n".repeat(1200)}\nAlways use npm run agent:build.\n`;
  writeFileSync(join(cwd, "AGENTS.md"), policy);
  const adapter = new InspectableGrok();
  for (const resumeSessionId of [undefined, "existing-session"]) {
    const { args } = adapter.spec(cwd, resumeSessionId);
    assert.equal(args.filter((arg) => arg === "--rules").length, 1);
    const rules = args[args.indexOf("--rules") + 1]!;
    assert.ok(rules.includes(policy), "late rules must not be truncated");
    assert.match(rules, /npm run agent:build/);
    assert.equal(args.at(-1), "Continue the saved work item.");
    assert.ok(!args.includes("--system-prompt-override"), "retain native system behavior");
    if (resumeSessionId) assert.ok(args.includes(`--resume=${resumeSessionId}`));
  }
});

test("rules refresh on the next launch and cannot leak across workspace directories", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  writeFileSync(join(first, "AGENTS.md"), "First workspace only.");
  writeFileSync(join(second, "AGENTS.md"), "Second workspace only.");
  assert.match(grokInstructionArgs(first, []).join("\n"), /First workspace only/);
  assert.doesNotMatch(grokInstructionArgs(second, []).join("\n"), /First workspace only/);
  writeFileSync(join(first, "AGENTS.md"), "Updated managed build policy.");
  const refreshed = grokInstructionArgs(first, []).join("\n");
  assert.match(refreshed, /Updated managed build policy/);
  assert.doesNotMatch(refreshed, /First workspace only/);
});

test("operator extra rules merge with workspace rules without duplicate CLI flags", (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "AGENTS.md"), "Use the managed build command.");
  const args = grokInstructionArgs(cwd, ["--max-turns", "10", "--rules", "Operator rule.", "--rules=Second operator rule."]);
  assert.deepEqual(args.slice(0, 2), ["--max-turns", "10"]);
  assert.equal(args.filter((arg) => arg === "--rules").length, 1);
  for (const rule of ["Operator rule.", "Second operator rule.", "Use the managed build command."]) {
    assert.ok(args.at(-1)!.includes(rule));
  }
});

test("absent or empty root instructions preserve extra flags without inventing rules", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(grokInstructionArgs(cwd, ["--max-turns", "10"]), ["--max-turns", "10"]);
  writeFileSync(join(cwd, "AGENTS.md"), " \n");
  assert.deepEqual(grokInstructionArgs(cwd, []), []);
  assert.deepEqual(grokInstructionArgs(cwd, ["--rules", "Operator policy."]), ["--rules", "Operator policy."]);
});

test("unreadable instruction paths and malformed custom rules fail instead of silently dropping policy", (t) => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, "AGENTS.md"));
  assert.throws(() => grokInstructionArgs(cwd, []));
  assert.throws(() => grokInstructionArgs(cwd, ["--rules"]), /requires a value/);
  assert.throws(() => grokInstructionArgs(cwd, ["--rules", "--max-turns", "10"]), /requires a value/);
});

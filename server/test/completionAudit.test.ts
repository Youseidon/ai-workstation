import assert from "node:assert/strict";
import test from "node:test";
import { auditMarkdown, parseReport, reconcileVerdict, selectAuditProvider } from "../src/completionAudit.ts";

test("bounded review prefers native transport and honors an explicit independent session",()=>{
  assert.equal(selectAuditProvider(["claude","codex","grok"],"grok"),"codex");
  assert.equal(selectAuditProvider(["claude","codex"],"codex","codex"),"codex");
  assert.equal(selectAuditProvider(["grok"],"codex","claude"),"grok");
  assert.equal(selectAuditProvider(["codex"],"codex"),"codex");
  assert.equal(selectAuditProvider([],"codex"),null);
});

test("reconcileVerdict refuses COMPLETE without supporting checks", () => {
  assert.equal(reconcileVerdict("COMPLETE", []), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [{ criterion: "a", criterionId: 1, result: "FAILED", evidence: "x", command: null }]), "INCOMPLETE");
  assert.equal(reconcileVerdict("COMPLETE", [{ criterion: "a", criterionId: 1, result: "UNVERIFIED", evidence: "x", command: null }]), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [{ criterion: "a", criterionId: 1, result: "PASSED", evidence: "x", command: null }]), "COMPLETE");
  assert.equal(reconcileVerdict("INCOMPLETE", []), "INCOMPLETE");
});

test("parseReport drops reconfigure and keeps the verdict shape", () => {
  const report = parseReport(JSON.stringify({
    verdict: "INCOMPLETE",
    confidence: "HIGH",
    checks: [{ criterionId: 1, criterion: "ship it", result: "FAILED", evidence: "missing", command: null }],
    remainingWork: ["Finish the route"],
    reconfigure: [{ kind: "raiseBudget", multiplier: 2, why: "old field" }],
    verificationSummary: "looked",
    reasoning: "because",
  }));
  assert.equal(report.verdict, "INCOMPLETE");
  assert.deepEqual(report.remainingWork, ["Finish the route"]);
  assert.equal("reconfigure" in report, false);
  const md = auditMarkdown(report, "claude", "run_1");
  assert.match(md, /INCOMPLETE/);
  assert.doesNotMatch(md, /Pipeline changes asked for/);
});

test("COMPLETE must cover the complete required manifest without unknown or duplicate IDs", () => {
  const pass = (id: number) => ({ criterion: `criterion ${id}`, criterionId: id, result: "PASSED" as const, evidence: "checked", command: null });
  assert.equal(reconcileVerdict("COMPLETE", [pass(1)], [1, 2]), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [pass(1), pass(3)], [1, 2]), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [pass(1), pass(1), pass(2)], [1, 2]), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [pass(1), pass(2)], [1, 2]), "COMPLETE");
});

import assert from "node:assert/strict";
import test from "node:test";
import { compactWorkItem, deriveVerdict, normalizeCheck, parseReportItems, summarize, uniqueCommands } from "./suiteVerification.ts";

test("suite dossier keeps verification context and drops reporting boilerplate",()=>{
  const result=compactWorkItem("Intro.\n\n## Objective\nShip it.\n\n## Verification\n```bash\nnpm test\n```\n\n## Report\nWrite a long summary.\n\n## Stripe runtime and evidence policy\nRepeated policy.");
  assert.match(result,/Objective/);assert.match(result,/npm test/);assert.doesNotMatch(result,/long summary|Repeated policy/);
});

test("suite dossier deduplicates commands in first-seen order",()=>{
  assert.deepEqual(uniqueCommands(["```bash\nnpm test\nnpm run build\n```","```sh\nnpm test\n```"]),["npm test","npm run build"]);
});

test("report parsing survives the shapes agents actually emit", () => {
  const report = `
Some preamble the agent wrote first.

| Item | Status | Decisive command | Evidence |
| --- | --- | --- | --- |
| S0-01 — Repository restructure | PASS | \`git status\` | 1,505 files moved, tree clean |
| S0-02 Endpoint audit | FAIL | \`npm test\` | 3 endpoints still reachable |
| S0-03 | UNVERIFIED | — | no fixture data available |
| S0-04 | WARNING | \`npm run lint\` | 2 lint warnings remain |

Overall suite verdict: FAIL
`;
  const items = parseReportItems(report);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.check), ["VERIFIED", "FAILED", "UNVERIFIED", "WARNING"]);
  assert.equal(items[0]!.promptKey, "S0-01");
  assert.equal(items[0]!.evidence, "1,505 files moved, tree clean");
  assert.equal(items[0]!.commands, "git status");
  assert.equal(deriveVerdict(report, items), "FAIL");
  assert.deepEqual(summarize(items), { total: 4, verified: 1, warnings: 1, failed: 1, unverified: 1 });
});

test("verdict is derived when the agent states none, and never over-reports a pass", () => {
  const items = parseReportItems(`
| Work item | Result |
|---|---|
| A | PASS |
| B | UNVERIFIED |
`);
  assert.equal(items.length, 2);
  // An unverified item is not a passing suite.
  assert.equal(deriveVerdict("no verdict line here", items), "WARNING");
  assert.equal(deriveVerdict("no verdict line", parseReportItems("| Item | Status |\n|---|---|\n| A | PASS |")), "PASS");
});

test("status words are classified without letting FAIL read as PASS", () => {
  assert.equal(normalizeCheck("PASS"), "VERIFIED");
  assert.equal(normalizeCheck("✓ passed"), "VERIFIED");
  assert.equal(normalizeCheck("FAIL"), "FAILED");
  assert.equal(normalizeCheck("failed to pass"), "FAILED");
  assert.equal(normalizeCheck("PASS/FAIL"), "FAILED");
  assert.equal(normalizeCheck("partial"), "WARNING");
  assert.equal(normalizeCheck("n/a"), "UNVERIFIED");
  assert.equal(normalizeCheck("prose, not a status"), null);
});

test("a report with no parsable table yields no items and never throws", () => {
  const prose = "I checked everything and it all looks fine to me.";
  const items = parseReportItems(prose);
  assert.deepEqual(items, []);
  // No items is not evidence of success.
  assert.equal(deriveVerdict(prose, items), "WARNING");
});

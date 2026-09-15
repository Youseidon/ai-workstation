#!/usr/bin/env node
/*
 * Requirement coverage matrix (docs/e2e-harness-plan.md 12.3). Generated, never edited by hand.
 *
 *   node scripts/coverage-matrix.mjs --scope S-L1 [--scope S-CLT] [--tiers T0,T1] [--t0 junit.xml]
 *
 * Reads the scenario tables in docs/e2e-scenarios/*.md and docs/**\/scenarios/*.md, the Playwright
 * JSON report (test-results/report.json) and optionally a node --test junit report, then writes
 * test-results/coverage-matrix.md. Exits non-zero when a must-priority scenario in scope, runnable
 * in the requested tiers, has no passing test.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(e2eDir, "..");
const args = process.argv.slice(2);
const values = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []));
const scopes = values("--scope");
const tiers = (values("--tiers")[0] ?? "T0,T1").split(",").map((tier) => tier.trim().toUpperCase());
const t0Reports = values("--t0");
const report = values("--report")[0] ?? join(e2eDir, "test-results/report.json");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/* Scenario tables */
const scenarios = new Map();
for (const file of walk(join(repoRoot, "docs")).filter((path) => path.endsWith(".md") && (path.includes("e2e-scenarios") || path.includes(`${"/"}scenarios${"/"}`)))) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 8 || !/^S-(?:[A-Z0-9]+-)+\d+$/.test(cells[1])) continue;
    const [, id, covers, kind, , tier, priority] = cells;
    scenarios.set(id, { id, covers, kind, tier, priority: /must/i.test(priority) ? "must" : "should", file: file.slice(repoRoot.length + 1), results: [] });
  }
}

/* Results */
// A test named "S-H6-13/14" covers S-H6-13 and S-H6-14 (the same expansion as scripts/live.ts).
const idsIn = (text) => [...new Set((text.match(/S-(?:[A-Z0-9]+-)+\d+(?:\/\d+)*/g) ?? []).flatMap((match) => {
  const [first, ...rest] = match.split("/");
  const prefix = first.slice(0, first.lastIndexOf("-") + 1);
  return [first, ...rest.map((number) => `${prefix}${number}`)];
}))];
function addResult(ids, result) {
  for (const id of ids) scenarios.get(id)?.results.push(result);
}
if (existsSync(report)) {
  const json = JSON.parse(readFileSync(report, "utf8"));
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        const ids = idsIn([spec.title, ...(test.annotations ?? []).map((annotation) => annotation.description ?? "")].join(" "));
        const passed = test.status === "expected";
        addResult(ids, { tier: test.projectName.toUpperCase(), title: spec.title, passed, status: last?.status ?? test.status });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of json.suites ?? []) visit(suite);
}
for (const file of t0Reports) {
  const xml = readFileSync(file, "utf8");
  for (const match of xml.matchAll(/<testcase\b[^>]*name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const failed = /<failure\b/.test(match[3] ?? "");
    addResult(idsIn(name), { tier: "T0", title: name, passed: !failed, status: failed ? "failed" : "passed" });
  }
}

/* T3 rows the live wrapper reported blocked on setup (scripts/live.ts), shown as blocked rather than missing. */
const blockedPath = join(e2eDir, "test-results/t3-blocked.json");
const blockedT3 = existsSync(blockedPath) ? new Set(JSON.parse(readFileSync(blockedPath, "utf8")).rows) : new Set();
/* The run-level T3 row (S-H6-36) is decided by the live wrapper, not by a single test. */
const runPath = join(e2eDir, "test-results/t3-run.json");
if (existsSync(runPath)) {
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  addResult([run.row], { tier: "T3", title: `e2e:live run (${run.minutes} min)`, passed: run.passed, status: run.passed ? "passed" : "failed" });
}

/* Gate */
const inScope = [...scenarios.values()].filter((scenario) => scopes.length === 0 || scopes.some((scope) => scenario.id.startsWith(`${scope}-`)));
const runnableIn = (scenario) => tiers.filter((tier) => scenario.tier.toUpperCase().includes(tier));
const problems = [];
const rows = inScope.map((scenario) => {
  const wanted = runnableIn(scenario);
  const byTier = Object.fromEntries(["T0", "T1", "T2", "T3"].map((tier) => {
    const results = scenario.results.filter((result) => result.tier === tier);
    if (results.length === 0) return [tier, !scenario.tier.toUpperCase().includes(tier) ? "" : tier === "T3" && blockedT3.has(scenario.id) ? "blocked (setup)" : "missing"];
    return [tier, results.every((result) => result.passed) ? `pass (${results.length})` : `FAIL (${results.filter((result) => !result.passed).length}/${results.length})`];
  }));
  for (const tier of wanted) {
    if (scenario.priority === "must" && !byTier[tier].startsWith("pass")) problems.push(`${scenario.id} (${tier}): ${byTier[tier]}`);
  }
  return { ...scenario, byTier };
});

const requirementIds = new Map();
for (const row of rows) {
  for (const requirement of row.covers.split(/[,;]/).map((part) => part.trim()).filter((part) => /^(RTC-\d+|H-[A-Z0-9]+-\d+|B\d+|T\d+)$/.test(part))) {
    const entry = requirementIds.get(requirement) ?? { passing: [], scenarios: [] };
    entry.scenarios.push(row.id);
    if (Object.values(row.byTier).some((value) => value.startsWith("pass"))) entry.passing.push(row.id);
    requirementIds.set(requirement, entry);
  }
}
const uncovered = [...requirementIds.entries()].filter(([, entry]) => entry.passing.length === 0).map(([id, entry]) => `${id} (scenarios ${entry.scenarios.join(", ")})`);

const lines = [
  "# Coverage matrix",
  "",
  `Generated ${new Date().toISOString()} by e2e/scripts/coverage-matrix.mjs; do not edit.`,
  `Scope: ${scopes.join(", ") || "all"}. Gated tiers: ${tiers.join(", ")}.`,
  "",
  "| Scenario | Priority | Tier (table) | T0 | T1 | T2 | T3 | Covers |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.id} | ${row.priority} | ${row.tier.replaceAll("|", "/")} | ${row.byTier.T0} | ${row.byTier.T1} | ${row.byTier.T2} | ${row.byTier.T3} | ${row.covers} |`),
  "",
  "## Requirement IDs without any passing scenario",
  "",
  ...(uncovered.length === 0 ? ["None."] : uncovered.map((item) => `- ${item}`)),
  "",
  "## Gate",
  "",
  ...(problems.length === 0 ? ["Pass: every must-priority scenario runnable in the gated tiers has a passing test."] : ["Fail:", ...problems.map((problem) => `- ${problem}`)]),
  "",
];
mkdirSync(join(e2eDir, "test-results"), { recursive: true });
writeFileSync(join(e2eDir, "test-results/coverage-matrix.md"), lines.join("\n"));
const shouldMissing = rows.filter((row) => row.priority === "should" && runnableIn(row).some((tier) => !row.byTier[tier].startsWith("pass"))).map((row) => row.id);
console.log(`coverage matrix: ${rows.length} scenarios in scope, ${problems.length} must gaps, ${shouldMissing.length} should gaps${shouldMissing.length ? ` (${shouldMissing.join(", ")})` : ""}, ${uncovered.length} requirement ids uncovered`);
console.log(`written to ${join(e2eDir, "test-results/coverage-matrix.md")}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

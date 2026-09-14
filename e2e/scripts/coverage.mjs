#!/usr/bin/env node
/*
 * Merged V8 code coverage from T0 server tests and the T1 harness server (docs/e2e-harness-plan.md 12.4).
 * A gap finder, not a percentage gate: it lists uncovered lines and branches in the critical files a
 * slice changed, each of which must be covered or explained in the change summary.
 *
 *   node scripts/coverage.mjs [--base <git-ref>] [--skip-t0] [--skip-t1] [-- <playwright args>]
 *
 * KNOWN ISSUE (2026-09-15): the per-line T0/T1 intersection reports lines as uncovered that T0 alone
 * covers (for example harnessGuard.ts). Do not rely on the merged gap list until this is fixed;
 * the per-tier HTML reports under test-results/coverage/{t0,t1} are correct individually.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(e2eDir, "..");
const args = process.argv.slice(2);
const split = args.indexOf("--");
const own = split === -1 ? args : args.slice(0, split);
const playwrightArgs = split === -1 ? [] : args.slice(split + 1);
const base = own.includes("--base") ? own[own.indexOf("--base") + 1] : "HEAD~1";
// Raw V8 data from different processes remaps to different branch maps, so T0 and T1 are reported
// separately and merged by line: a changed line is uncovered only when neither tier ran it.
const rawT0 = join(e2eDir, "test-results/v8-coverage-t0");
const rawT1 = join(e2eDir, "test-results/v8-coverage-t1");
const out = join(e2eDir, "test-results/coverage");

const CRITICAL = [
  "server/src/taskControl.ts",
  "server/src/humanInput.ts",
  "server/src/workspaces.ts",
  "server/src/agentProgressApi.ts",
  "server/src/harnessGuard.ts",
  "server/src/harnessSeams.ts",
  "server/src/integrations/telegram/",
];

for (const dir of [rawT0, rawT1, out]) rmSync(dir, { recursive: true, force: true });
mkdirSync(rawT0, { recursive: true });
mkdirSync(rawT1, { recursive: true });

function run(label, command, commandArgs, options) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) console.warn(`${label} exited ${result.status}; coverage still reported for what ran`);
}

if (!own.includes("--skip-t0")) {
  const root = join(e2eDir, "test-results/coverage-t0-root");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  run("T0 server tests", "npm", ["test"], { cwd: join(repoRoot, "server"), env: { ...process.env, NODE_V8_COVERAGE: rawT0, AGENT_CONSOLE_REPO_ROOT: root } });
}
if (!own.includes("--skip-t1")) {
  run("T1 harness scenarios", "npx", ["playwright", "test", "--project=t1", ...playwrightArgs], { cwd: e2eDir, env: { ...process.env, E2E_COVERAGE_DIR: rawT1 } });
}

const reports = [];
for (const [tier, raw] of [["t0", rawT0], ["t1", rawT1]]) {
  const dir = join(out, tier);
  run(`c8 report (${tier})`, "npx", ["c8", "report", "--temp-directory", raw, "--reports-dir", dir, "--src", repoRoot, "--include", "server/src/**/*.ts", "--exclude", "server/src/**/*.test.ts", "--reporter", "json", "--reporter", "text-summary", "--reporter", "html", "--exclude-after-remap"], { cwd: repoRoot });
  const finalPath = join(dir, "coverage-final.json");
  if (existsSync(finalPath)) reports.push(JSON.parse(readFileSync(finalPath, "utf8")));
}

const changed = spawnSync("git", ["diff", "--name-only", base, "--", "server/src"], { cwd: repoRoot, encoding: "utf8" }).stdout.split("\n").filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
const critical = changed.filter((file) => CRITICAL.some((prefix) => file === prefix || (prefix.endsWith("/") && file.startsWith(prefix))));
if (reports.length === 0) {
  console.error("no coverage report was produced");
  process.exit(1);
}
console.log(`\n== Uncovered code in changed critical files (base ${base})`);
if (critical.length === 0) console.log("No critical server files changed.");
/** Line numbers added or modified since `base`, from the zero-context diff hunks. */
function changedLines(file) {
  const diff = spawnSync("git", ["diff", "-U0", base, "--", file], { cwd: repoRoot, encoding: "utf8" }).stdout;
  const lines = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}

/** Changed lines with an unexecuted statement or branch in this report, or null when the file never loaded. */
function uncoveredIn(coverage, file, touched) {
  const entry = Object.entries(coverage).find(([path]) => relative(repoRoot, path) === file)?.[1];
  if (!entry) return null;
  const statements = new Set();
  const executed = new Set();
  for (const [id, count] of Object.entries(entry.s)) {
    const { start, end } = entry.statementMap[id];
    for (let line = start.line; line <= end.line; line += 1) if (touched.has(line)) (count === 0 ? statements : executed).add(line);
  }
  for (const line of executed) statements.delete(line);
  const branches = new Set();
  for (const [id, counts] of Object.entries(entry.b)) {
    counts.forEach((count, index) => {
      const line = entry.branchMap[id].locations[index]?.start.line ?? entry.branchMap[id].loc.start.line;
      if (count === 0 && touched.has(line)) branches.add(line);
    });
  }
  return { statements, branches };
}

let gaps = 0;
const sorted = (set) => [...set].sort((a, b) => a - b).join(", ");
for (const file of critical) {
  const touched = changedLines(file);
  const perTier = reports.map((coverage) => uncoveredIn(coverage, file, touched)).filter((result) => result !== null);
  if (perTier.length === 0) {
    console.log(`${file}: not loaded by any test`);
    gaps += 1;
    continue;
  }
  const intersect = (key) => perTier.map((result) => result[key]).reduce((left, right) => new Set([...left].filter((line) => right.has(line))));
  const statements = intersect("statements");
  const branches = intersect("branches");
  gaps += statements.size + branches.size;
  console.log(`${file}: ${touched.size} changed lines; uncovered statements on lines [${sorted(statements)}]; uncovered branches on lines [${sorted(branches)}]`);
}
console.log(gaps === 0 ? "\nNo uncovered changed code in critical files." : `\n${gaps} uncovered items in changed critical code: cover each with a test or explain it in the change summary.`);
console.log(`\nHTML reports: ${join(out, "t0/index.html")} and ${join(out, "t1/index.html")}`);

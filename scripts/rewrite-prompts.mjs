#!/usr/bin/env node
/**
 * Applies reviewed prompt-body edits through the same route the authoring UI
 * uses, so every write lands a `prompt_revision` row and can be undone.
 *
 *   node scripts/rewrite-prompts.mjs            # dry run: print the diffs
 *   node scripts/rewrite-prompts.mjs --apply    # write them
 *   node scripts/rewrite-prompts.mjs --key S6-00
 *   node scripts/rewrite-prompts.mjs --edits scripts/prompt-edits-<name>.json
 *
 * An applied edit set is spent: its `find` text no longer exists, so re-running it
 * reports misses. Each rewrite gets its own file rather than overwriting the last,
 * so the record of what was changed and why survives.
 *
 * Edits are exact string replacements, keyed by prompt external key. An edit
 * whose `find` text is absent is reported as a miss and exits non-zero rather
 * than being silently skipped: the corpus moving under a rewrite is exactly the
 * failure this guards against.
 */
import { readFileSync } from "node:fs";

const API = process.env.AGENT_CONSOLE_API ?? "http://127.0.0.1:4000";
const apply = process.argv.includes("--apply");
const flag = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const onlyKey = flag("key");
const editsFile = flag("edits", "./prompt-edits.json");
const reason = flag("reason", "Cost normalisation: stage-level verification");

const EDITS = JSON.parse(readFileSync(new URL(editsFile, import.meta.url), "utf8"));

/** Line-level diff, enough to review a prose edit without pulling in a dep. */
function diff(before, after) {
  const b = before.split("\n");
  const a = after.split("\n");
  const out = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) { i += 1; j += 1; continue; }
    const nextMatch = j < a.length ? b.indexOf(a[j], i) : -1;
    const priorMatch = i < b.length ? a.indexOf(b[i], j) : -1;
    if (nextMatch !== -1 && (priorMatch === -1 || nextMatch - i <= priorMatch - j)) {
      while (i < nextMatch) { out.push(`- ${b[i]}`); i += 1; }
    } else if (priorMatch !== -1) {
      while (j < priorMatch) { out.push(`+ ${a[j]}`); j += 1; }
    } else {
      if (i < b.length) { out.push(`- ${b[i]}`); i += 1; }
      if (j < a.length) { out.push(`+ ${a[j]}`); j += 1; }
    }
  }
  return out;
}

async function json(path, init) {
  const response = await fetch(`${API}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const workspaceList = (await json("/api/workspaces")).workspaces ?? [];
const workspace = workspaceList.find((item) => item.name === "materio-forge");
if (workspace === undefined) throw new Error("materio-forge workspace not found");
const tree = (await json(`/api/workspaces/${workspace.id}/tree`)).workspace;
const byKey = new Map();
for (const program of tree.programs ?? []) {
  for (const suite of program.suites ?? []) {
    for (const prompt of suite.prompts ?? []) byKey.set(prompt.externalKey ?? prompt.title, prompt);
  }
}

let changed = 0;
let missed = 0;
for (const [key, edits] of Object.entries(EDITS)) {
  if (onlyKey !== null && key !== onlyKey) continue;
  const prompt = byKey.get(key);
  if (prompt === undefined) { console.error(`MISS ${key}: no such prompt`); missed += 1; continue; }
  let next = prompt.content;
  let applied = 0;
  for (const edit of edits) {
    if (!next.includes(edit.find)) { console.error(`MISS ${key}: text not found - ${edit.find.slice(0, 60)}`); missed += 1; continue; }
    next = next.replace(edit.find, edit.replace);
    applied += 1;
  }
  if (applied === 0 || next === prompt.content) continue;
  changed += 1;
  console.log(`\n=== ${key} - ${prompt.title}  (${prompt.content.length} -> ${next.length} chars)`);
  for (const line of diff(prompt.content, next)) console.log(`  ${line}`);
  if (apply) {
    await json(`/api/prompts/${prompt.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: next, reason }),
    });
  }
}

console.log(`\n${changed} prompt(s) ${apply ? "updated" : "would change"}, ${missed} miss(es).`);
if (!apply && changed > 0) console.log("Pass --apply to write. Every write records a prompt_revision that can be restored.");
process.exit(missed > 0 ? 1 : 0);

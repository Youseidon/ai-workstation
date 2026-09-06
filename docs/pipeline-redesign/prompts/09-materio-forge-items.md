# 09 — materio-forge: make every open S6 item mechanically verifiable and continuation-aware

Read `00-read-first.md` first. Requires prompts 04 (the `## Verify` block) and 06 (suite overview
reaches sub-steps; workspace description deduped against `AGENTS.md`). This prompt changes **data**
in the owner's console — the S6 items, the S6 suite overview and the workspace description — through
the console's API, never through SQL. It touches no file in `~/projects/materio-forge`.

## Objective

Every open S6 work item ends with a fenced `## Verify` block the server can run, so `done` is checked
by the harness rather than believed; the compact "how a slice is proven" recipe lives in the S6 suite
overview where every sub-step receives it; and the workspace's standing instructions stop repeating
`AGENTS.md`.

## Why

S6 has 77 items, 63 done, 14 open: stations S6-09…S6-15 and S6-09's seven sub-steps (S6-09.1 is
`UNREPORTED` after four budget deaths). The open sub-steps already carry a prose `## Verify (only
these routes)` section naming the exact commands — but as prose, so nothing runs them, and a wrong
`done` would pass. The playbook (S6-00, 8 KB, `DONE`) is referenced by sub-steps that never receive
it; the 1.3 KB suite overview is what they do receive. The workspace description is 7.9 KB and
`AGENTS.md` is 6.9 KB of substantially the same text, both sent on every run.

## Scope

### 0. A route to edit a suite's overview (small server change)

There is no API to change `suite.overview` after import (`updateSuitePipelineDefaults` only edits
provider/model). Add `PATCH /api/suites/:id` accepting `{ overview?: string, name?: string }` in
`server/src/workspaceApi.ts` → `workspaces.updateSuite(suiteId, patch)` (updates `updated_at`;
records a `db_access` line like other writes; no revision table for suites — say so in a comment).
Same for `PATCH /api/programs/:id` `{ overview }`. Tests for both. Keep it to this.

### 1. Verify blocks on the open S6 items

Write `scripts/prompt-edits-s6-verify.json` for `scripts/rewrite-prompts.mjs` (exact `find`/`replace`
per key, dry-run first, `--reason "Server-verified done: fenced Verify blocks"`). Before writing the
commands, confirm in the materio-forge checkout that they exist and exit 0 on a clean tree:
`node harness/replay.mjs --help` (flags `--target`, `--namespace`, `--only-implemented`,
`--reset-between-passes`), `dotnet build src/backend/MaterioForge.slnx -warnaserror` (if the current
tree does not build clean with `-warnaserror`, use the plain build and tell the owner which warnings
exist). Do not run the replay yourself against a live API unless one is already up; the point is the
flags, not the result.

**Sub-steps S6-09.1 … S6-09.7.** Keep the existing `## Verify (only these routes)` prose (it explains
the warm stack and the A/B rule), and append directly under it a fenced block. For S6-09.1
(namespace `clients`):

````markdown
```sh
curl -fsS http://localhost:8080/health
dotnet build src/backend/MaterioForge.slnx -warnaserror   # timeout=600s
MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z MF_DETERMINISTIC=1 MF_DETERMINISTIC_SEED=2654435769 MF_JWT_SECRET=materioforge-deterministic-harness-secret node harness/replay.mjs --target http://localhost:8080 --namespace clients   # timeout=900s
```

The server runs these when you post `done` and refuses `done` with their output if any fails. Keep
the API up (`npm run dev:api`) until `done` is accepted.
````

Use each sub-step's own namespace(s) — read them from the item text (S6-09.2/.3 client portal,
S6-09.4 suppliers/listings, S6-09.5 contractors/trade profiles, S6-09.6/.7 jobs); one replay line per
namespace. Keep "Do not run whole-suite replay."

**Stations S6-09 … S6-14** (module integration runs — the run that resumes after the sub-steps):
append a `## Verify` section with:

````markdown
```sh
curl -fsS http://localhost:8080/health
dotnet build src/backend/MaterioForge.slnx -warnaserror   # timeout=600s
MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z MF_DETERMINISTIC=1 MF_DETERMINISTIC_SEED=2654435769 MF_JWT_SECRET=materioforge-deterministic-harness-secret node harness/replay.mjs --target http://localhost:8080 --only-implemented --reset-between-passes   # timeout=1800s
```
````

`--only-implemented` is the module-level gate S6-00 describes (every flipped route green); the
whole-suite replay with pre-recorded split-state reds stays a *reported* check in the item's Exit
text, not a command, because it is not expected to exit 0. Say this in one sentence under the block.

**S6-15** (residual sweep): the same as a station plus `node harness/burndown.mjs` (exit 0 when the
mock count is zero — confirm the tool's exit semantics; if it never exits non-zero, leave it out of
the block and keep it in prose).

### 2. Continuation language

The console's protocol text now says how a run ends (prompt 06). Only item text needs to agree:

- In every open S6 item, the sentence(s) about what to do when work will not fit — S6-09.2's "Follow
  `harness/module-playbook.json` steps 1–4 for your routes only" is fine; look for "window", "if you
  cannot finish", "report BLOCKED", "stop and" in all 14 — replace with: "Bank progress with
  `PROGRESS` remarks after each route goes green. If this run stops before the item is done, post
  `continue` with what remains; the next run resumes on this working tree."
- The `BLOCKED` occurrences in S6-09.4–.7 are about `port.mjs dossier` marking a *route* BLOCKED
  (the harness's own word). **Leave those alone**; they are correct and unrelated to the console.
- S6-00's "Definition of done for the module" section: prepend one line — "The `## Verify` block on
  each item is what the server runs on `done`; items 3–5 below are the module run's to prove and
  report." (S6-00 is `DONE`; editing its text is harmless and keeps the playbook truthful.)

### 3. The S6 suite overview carries the recipe

Through the new `PATCH /api/suites/7` (id from the API, not assumed), replace the overview with a
≤ 3.5 KB version that keeps every current sentence and adds a **"Proving a slice"** block: the env
line, the per-route and per-namespace replay commands, the build command, the flip command
(`node contracts/tools/set-implementation.mjs --route "<method> <path>" --value dotnet`), "open
`success.json` and read its status first", and "where the oracle is silent, A/B `:5050` vs `:8080`".
End with: "`harness/module-playbook.json` is the canonical checklist; read it once." Submit it via
`curl` from a file; paste the byte count in your report.

### 4. Workspace standing instructions

Diff `workspace.description` against `workspace.agents_md` (both via `GET /api/workspaces/1`). Move
anything that is only in the description **into** `agents_md`/`claude_md` (they are what the CLIs
load), then reduce the description to the ≤ 1.5 KB that is genuinely per-run standing guidance (who
the agent is, the R1–R10 one-liners if they are not already in `AGENTS.md`, "the database is the
tracker"). Update through the existing workspace update route (it writes `workspace_revision`, so
this is reversible). Prompt 06's dedupe then omits nothing that matters and the run context loses
~5 KB.

### 5. Reset S6-09.1

After the edits: S6-09.1 is `UNREPORTED`. Through the UI or the operator API, retry it (a `USER`
actor row, which also grants a fresh continuation allowance). Do not mark anything done.

## Out of scope

Changing what any S6 item asks for; touching `~/projects/materio-forge`; editing DONE items other
than S6-00's one line.

## Acceptance criteria

1. `GET /api/prompts/<id>` for each of the 14 open S6 items shows the fenced block and the resulting
   prompt-scope `COMMAND` criteria (via the DoD endpoint) — one per line, with the timeouts parsed.
2. `scripts/prompt-edits-s6-verify.json` is committed; the dry run reports zero misses before apply
   and every edit is a `prompt_revision` row with the reason.
3. S6 suite overview ≤ 3.5 KB, contains the env line and the five commands; the context of a
   sub-step (`scripts/context-size.ts --prompt 133`) shows it under `## Suite`.
4. Workspace description ≤ 1.5 KB; `agents_md` contains everything the old description had that
   `AGENTS.md` lacked; a `workspace_revision` row records the change.
5. Every open item still says "Do not run whole-suite replay" (sub-steps) or explains the
   `--only-implemented` gate (stations).
6. No `BLOCKED`-as-console-status language remains in the 14 items; the four `dossier … BLOCKED`
   sentences are intact.
7. S6-09.1 is `TODO` with a `USER` ledger row.
8. Server tests for the two new PATCH routes; `npm run typecheck && npm test && npm run build`
   clean.

## Verification to run and report

The dry-run output (diffs) of the edits JSON; the `dod_criterion` rows for S6-09.1 and S6-09; the
before/after sizes of the suite overview, workspace description and `agents_md`; the `context-size`
table for prompt 133 after everything. Report the `replay.mjs --help` output you validated the flags
against and the `dotnet build -warnaserror` result on the clean tree.

# Handoff: finish the pipeline status redesign

You are picking up a partly-finished piece of work on `~/projects/ai-orchestration`, a
self-hosted web console that drives local CLI coding agents (Claude Code, Codex, Cursor, Grok,
Copilot) through a pipeline of work items. Node/TS monorepo: `shared/`, `server/`, `web/`
(Next.js). SQLite via `better-sqlite3`, hand-rolled versioned migrations.

Ten commits landed before you (`git log f0032f7..HEAD`). The redesign's named scope is finished;
what is left is listed under "What is left" below. Read this whole file before touching anything —
there are two things that will bite you, and one of them already destroyed data.

---

## Why this work exists

The owner's words: *"If for any reason it succeeds but is mistakenly marked as failed or review
needed or whatever, I don't have any more reasons to use this pipeline and I just might as well
run prompts directly."*

That was literally true. `operationalState()` ended in a bare `return "FAILED"` — nothing ever
*decided* an item had failed; it arrived there by matching no earlier branch. And when a run's
process ended while the item was still `IN_PROGRESS`, the server forcibly wrote `BLOCKED`, so an
agent that finished the work but dropped one HTTP call was indistinguishable from one that
stopped to ask a question. On this repo's own database, **30 recorded events** were that forced
`BLOCKED`.

Everything below serves one rule: **the pipeline never infers an outcome.** A status is either
posted by an agent through an audited API, decided by a rule you can read on screen, or set by
the operator — and in all three cases it records what caused it.

---

## READ THIS FIRST — two hazards

### 1. `PRAGMA foreign_keys` is a silent no-op inside a transaction

Migration 22 rebuilt `agent_run` and called `db.pragma("foreign_keys = OFF")` from *inside* its
`db.transaction(...)`. SQLite ignored it. Foreign keys stayed on, `DROP TABLE agent_run`
cascaded, and it deleted **135,025 transcript events, 302 idempotency records, 11 handoffs and
1 audit** from the owner's live database. Nothing errored. The migration reported success and
every test passed. The loss was visible only by counting rows.

It was restored from a copy that happened to exist. Do not rely on that happening again.

Four tables cascade off `agent_run`: `agent_run_event`, `agent_command`, `handoff`,
`completion_audit`. If you rebuild any table, put the pragma **outside** the transaction, in a
`try/finally` — see migration 13 (`server/src/workspaces.ts`, search `afterTwelve < 13`) and the
now-corrected migration 22. `server/src/migrationSafety.test.ts` enforces this; do not weaken it.

### 2. The owner's dev server runs against live data

`npm run dev` is usually running under `tsx watch`. **The moment you save a migration, it
restarts and applies it to ~150 MB of real work.** Migrations 21 and 22 both went live mid-session
this way.

Before writing any migration:

```bash
# Work against a copy until the migration is proven.
cp ~/.local/state/agent-console/console.sqlite /tmp/mig-test.sqlite
AGENT_CONSOLE_DB=/tmp/mig-test.sqlite npx tsx -e "import('./server/src/workspaces.ts').then(m=>console.log(m.workspaces.list().length))"
# Then count every table before and after. Row counts, not "it didn't throw".
```

Ask the owner before letting a new migration touch the live database.

Migration 23 was done this way and it is the routine to copy: copy the database,
run the migration's **exact SQL** against the copy in a standalone script, and
diff every table's row count plus `integrity_check` and `foreign_key_check`
before and after. Doing it as a standalone script rather than by saving
`workspaces.ts` is what avoids the race — the file save *is* the deployment.
It reported 138,103 rows across 29 pre-existing tables unchanged, and the same
counts held on the live file afterwards.

---

## What is already done

| Commit | What |
|---|---|
| `f0032f7` | One status vocabulary in `shared/src/statusModel.ts` — catalog, triggers, `STEP_TRANSITIONS`. Migration 21. |
| `0896a60` | `workspaces.writeStatus` — the single choke point all 13 status writers go through. The end-of-run ladder. |
| `620d344` | Handoff narrowed to unfinished work that produced something. |
| `f6308b6` | `db_access` events — every agent↔database call flagged in the transcript. |
| `36fd55d` | Status catalog REST + editor UI + "Why this status" panel. |
| `4c9453f` | Database relocated out of every workspace; `agent-step` shim replaces the curl contract. |
| `1713291` | Child outcomes roll up to the parent as a *derived* signal. |
| `a3657a5` | Reviewer matrix (`reviewer_config`, migration 22) + the migration fix above. |
| `a710577` | Definition of done: three kinds of criterion, inherited, gated in `writeStatus`. Migration 23. |
| `84d92ab` | The reviewer matrix and the definition of done get a UI. |

Current: **schema 23**, 367 tests passing, `npm run build` clean.

### The status model, in brief

`shared/src/statusModel.ts` is the base layer of `shared` — it imports nothing, so `index.ts` and
`pipelineRules.ts` both sit on it.

- **Stored** (`StepStatus`): `TODO · IN_PROGRESS · DONE · BLOCKED · UNREPORTED · FAILED ·
  NEEDS_REVIEW · SKIPPED`
- **Displayed** (`StepDisplayStatus`): the above plus four live overlays that are never stored —
  `WORKING · READY · WAITING_DEPENDENCY · RECOVERY_NEEDED`
- Each carries label, description, tone, icon and policy, overridable per field in
  `status_definition`, with some fields locked and a reason shown in place of the control.
- Every status change writes exactly one `prompt_status_event` carrying `trigger_id`, `rule_id`
  and `evidence_json`.

---

## What the last session did with that scope

**1. Definition of done — done.** Migration 23 adds `definition_of_done`,
`dod_criterion` and `dod_result` exactly as specified. `PROSE` criteria are
judged by the reviewer, which now receives them structured with ids and quotes
each id back, so a verdict lands on the row it was about instead of being
matched to one by string similarity. `COMMAND` criteria are executed by the
server (`dodCommands.ts`) and judged on the exit code. `CHILDREN_CLOSED` is read
off the child rollup.

The gate lives inside `writeStatus`, not at the call sites: there were thirteen
routes to DONE and a gate spelled thirteen times has holes in it. It is a
*synchronous read* of recorded results and never executes anything — running a
test suite from inside a SQLite write transaction would block the event loop of
a console whose job is watching live agents. Producing the evidence is
`definitionOfDone.ts`' job, and the paths that intend to close an item call it
first (the agent door in `index.ts`, and `settleAudit` in the scheduler). A
COMMAND nobody ran is UNVERIFIED, and UNVERIFIED closes nothing.

The dangling `pipeline.dodEnforcement` is resolved: the setting exists in
Pipeline policy, defaulting to `block`. `dod_unmet`, the `dod-unmet` transition
row and the `dodUnmet` reviewer entry are all reachable now — `writeStatus`
emits the signal, and `workspaces.reviewSituation` reads the recorded cause off
the ledger rather than guessing from the status, because NEEDS_REVIEW is where
three different problems land.

**2. Reviewer matrix UI — done.** `ReviewerMatrixPanel.tsx`, in `RulesPanel`
next to the status catalog, deriving its rows from `REVIEW_TRIGGERS` and its
verdict actions from `REVIEW_ACTIONS`.

**3. Optional cleanup — still not done**, and still deliberately out of scope.
Both items below are unchanged.

---

## What is left

- **The two coexisting pipeline systems.** Migration 14 copied
  `prompt_pipeline_rule` into `pipeline_step` and deleted neither the legacy
  tables nor `/api/suites/:id/play`.
- **`agent_run_event` has no retention policy.** It is why the database is
  ~150 MB.
- **Nothing here has been used by a real agent.** The reviewer's
  structured-criteria prompt has never faced a live provider, and the
  agent-posts-DONE-over-a-failing-criterion path is covered by a test against
  real SQLite rather than by an actual agent run. Neither new panel has been
  clicked through in a browser.
- **`reviewer_config` has the bug `definition_of_done` just had fixed.** Both
  are keyed by `(scope, scope_id)` with no foreign key, and SQLite reuses a
  deleted row's id — so a deleted suite's reviewer settings will silently attach
  themselves to the next suite given that id. `forgetOrphanedDefinitionsOfDone`
  in `workspaces.ts` is the pattern; `reviewer_config` needs the same sweep.

## Invariants — do not break these

1. **Never infer an outcome.** A run that ends without posting is `UNREPORTED` — never `DONE`,
   never `FAILED`, never `BLOCKED`. `FAILED` is written only for an observed process failure.
   `shared/src/statusModel.test.ts` locks this down; those rows are `policy: { kind: "locked" }`
   on purpose.

2. **One writer.** Every `prompt.status` change goes through `writeStatus` in `workspaces.ts`. It
   writes the status, the ledger row and any remark in one transaction. Do not add a fourteenth
   direct `UPDATE prompt SET status`.

3. **The scheduler is re-entrant.** `handoffCoordinator.ts:97,111` replay the *source* run's end
   through `onExecuteEnded`. `applyExecuteEnded` stays correct only because of the
   `live.currentRunId !== runId` guard (`pipelineScheduler.ts:407`) and the ordering documented in
   `applyOnBlocked` at `:323` and `:329`, which records two past regressions — a pause that
   silently burned a retry, and a rule that ran before anything checked whether the work was
   already finished. Keep it idempotent under replay.

4. **`BLOCKED` is a question, not unfinished work.** It is never auto-handed-off, never reviewed,
   never audited past. A machine deciding it would overrule a request for a human decision.

5. **The database stays out of reach.** `workspaces.assertDatabaseOutOfReach()` refuses to boot if
   the file sits inside any workspace directory. Do not soften it to a warning.

6. **SQL `CHECK` constraints duplicate TS unions by hand.** `agent_run.role`, `pipeline_step`'s
   actions, `pipeline_run.state`. Widening a union without a migration fails at runtime, and
   `tsc` will not tell you.

7. **A model never overturns a recorded exit code.** `recordReviewerVerdicts`
   files a reviewer's answers only against `PROSE` criteria, however
   confidently it reports on the others. A `COMMAND` is settled by its exit
   code and `CHILDREN_CLOSED` by the rollup — that is the entire reason they
   are not prose, and letting a verdict overwrite one hands back the thing the
   definition of done was built to take away.

8. **The definition-of-done gate reads; it does not run.** See above. If you
   need fresh evidence, call `runDefinitionOfDoneCommands` before the write,
   never from inside it.

9. **A table keyed by `(scope, scope_id)` needs an orphan sweep.** SQLite hands
   out a deleted row's INTEGER PRIMARY KEY again, so criteria written for a
   deleted work item do not merely linger — they attach to the next item given
   that id, and it will not close for reasons nobody wrote. Ask "is the thing
   this row points at still there" rather than cleaning up at each delete site;
   cascades mean the delete sites are not the whole story.

10. **`shared/src/index.ts` re-exports by name, never `export *`.** Node's ESM linker resolves a
   `.ts` barrel's named exports before tsx transpiles the starred module, so `export *` links and
   exposes nothing — every importer fails at runtime while `tsc` stays happy. There is a comment
   there explaining it.

---

## Verification

```bash
npm run typecheck    # shared, server, web
npm test             # 327 currently passing — none may regress
npm run build        # Next.js build must stay clean
```

All four of these were run against a real server on a disposable database
(`PORT=4137 AGENT_CONSOLE_DB=/tmp/... node --import tsx src/index.ts`), which is
the way to exercise the real app without creating test items in the owner's live
console. Re-run them after anything that touches the gate:

1. Point a work item's definition of done at a command that fails; confirm the
   close is refused and the failing command's **real output** appears as
   evidence. ✓ — the compiler's own `error TS2322` line lands in
   `evidence_json`. Note that the operator's own **Mark complete** is an
   override and is *meant* to get through; it records what it closed over.
2. Confirm a passing command actually ran — check the recorded exit code, do not
   take the reviewer's word for it. ✓ — `exit 0`, source `RUNNER`.
3. Rename a status on the rules screen; confirm it changes on the board, the
   station card and the status bar from that one edit. ✓
4. Kill an agent mid-run; confirm the item shows `UNREPORTED` — **not** failed,
   **not** blocked. ✓ — worth re-running after any `writeStatus` change, since
   that path goes through it.

Write tests that assert the *claim*, not the implementation. The existing suites are written that
way and their names say what is being protected — read
`server/src/statusLedger.test.ts` and `server/src/statusCatalog.test.ts` before writing yours.

The full original plan, including sections already delivered, is at
`~/.claude/plans/graceful-baking-hartmanis.md`.

---

## Style notes for this codebase

- Rules are **data, not `if` chains** — an ordered table a test can enumerate and a settings
  screen can point at. `shared/src/pipelineRules.ts` explains why at the top. Extend the tables;
  don't add branches beside them.
- Comments explain **why**, and often name the regression that motivated the code. Match that.
  Several are load-bearing.
- Server code is dense and single-line in places (`workspaces.ts` especially). Match the
  surrounding file rather than reformatting it.
- The owner reads commit messages. Say what changed, what it fixes, and what you verified —
  including anything you did *not* verify.

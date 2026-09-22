# Handoff: finish the pipeline status redesign

You are picking up a partly-finished piece of work on `~/projects/ai-orchestration`, a
self-hosted web console that drives local CLI coding agents (Claude Code, Codex, Cursor, Grok,
Copilot) through a pipeline of work items. Node/TS monorepo: `shared/`, `server/`, `web/`
(Next.js). SQLite via `better-sqlite3`, hand-rolled versioned migrations.

Ten commits landed before you (`git log f0032f7..HEAD`). The redesign's named scope is finished;
what is left is listed under "What is left" below. Read this whole file before touching anything —
there are two things that will bite you, and one of them already destroyed data.

The live redesign plan — what remains, in order, and why — is
[`docs/pipeline-redesign/PLAN.md`](docs/pipeline-redesign/PLAN.md). Prompts 01–03
(stable host, budget/wrap-up, continuation loop) have landed in source on
`pipeline-continuation-loop`. Start there rather than reconstructing the old
reviewer-matrix / handoff / remediation story from this file.

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

Current branch work (prompts 01–03) replaces the automatic
audit → remediate → handoff → retry → recover chain with one continuation loop.
See `docs/pipeline-redesign/PLAN.md` and `docs/pipeline-redesign/prompts/`.

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

When a run ends, the scheduler has exactly three answers: **advance**, **park for a human
question**, or **continue the same station**. Details and remaining prompts live in
[`docs/pipeline-redesign/PLAN.md`](docs/pipeline-redesign/PLAN.md).

---

## What is left

See [`docs/pipeline-redesign/PLAN.md`](docs/pipeline-redesign/PLAN.md) for the ordered
redesign prompts. Prompt 08 (cleanup) is done on this branch: one named-pipeline
Play path, `agent_run_event` retention, and the dead
`handoff` / `reviewer_config` / `reviewer_reconfigure` / `prompt_pipeline_rule`
tables dropped (archived under `<state dir>/archive/` first). Legacy
`pipeline_step` / `suite_pipeline_run` columns for retry/recover are gone.
`agent_run.role` still includes `'handoff'` because completion audits use that
role — rebuilding the CHECK was not worth it.

Outside the redesign plan:

- **Nothing here has been used by a real agent.** The reviewer's
  structured-criteria prompt has never faced a live provider, and the
  agent-posts-DONE-over-a-failing-criterion path is covered by a test against
  real SQLite rather than by an actual agent run. Neither new panel has been
  clicked through in a browser.
- **Tables keyed by `(scope, scope_id)` still need an orphan sweep for
  `definition_of_done`.** `forgetOrphanedScopedRows` in `workspaces.ts` already
  does that; `reviewer_config` is gone.
- **Offline `VACUUM` after retention.** A sweep + `VACUUM` on a copy of the live
  file went 228 MB → ~198 MB (defaults keep up to 4000 events per recent run).
  Reclaiming more needs tighter Retention settings or deleting old runs, then
  `VACUUM` with every console process stopped.

## Invariants — do not break these

1. **Never infer an outcome.** A run that ends without posting is `UNREPORTED` — never `DONE`,
   never `FAILED`, never `BLOCKED`. `FAILED` is written only for an observed process failure.
   Unfinished work is **continued** on the same station, not guessed at.
   `shared/test/statusModel.test.ts` locks this down; those rows are `policy: { kind: "locked" }`
   on purpose.

2. **One writer.** Every `prompt.status` change goes through `writeStatus` in `workspaces.ts`. It
   writes the status, the ledger row and any remark in one transaction. Do not add a fourteenth
   direct `UPDATE prompt SET status`.

3. **The scheduler is re-entrant.** `applyExecuteEnded` (and the continuation path that re-enters
   it) stay correct only because of the `live.currentRunId !== runId` guard in
   `pipelineScheduler.ts`. Keep it idempotent under replay: a late end event for a run the rail
   has already moved past must no-op.

4. **`BLOCKED` is a genuine external question, not unfinished or repairable work.** A valid
   blocker parks immediately with `wait_reason = "human_question"` and is never continued,
   reviewed past, or audited past. The agent door refuses blocker posts whose requested action
   is a source/test/config edit or a Verify-recipe repair; those stay live so the agent can use
   `repair-verify` or post `continue`. Credentials, approvals, choices and external dependencies
   still park.

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
AGENT_CONSOLE_DB=/tmp/….sqlite npm test
npm run build        # Next.js build must stay clean
```

Do not run `npm run dev` against the live database. Use `npm run serve` for real
pipeline work, or `npm run dev:sandbox` / a disposable `AGENT_CONSOLE_DB` for
development. See the README.

Write tests that assert the *claim*, not the implementation. The existing suites are written that
way and their names say what is being protected — read
`server/test/statusLedger.test.ts` and `server/test/pipelineScheduler.test.ts` before writing yours.

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

# Handoff: finish the pipeline status redesign

You are picking up a partly-finished piece of work on `~/projects/ai-orchestration`, a
self-hosted web console that drives local CLI coding agents (Claude Code, Codex, Cursor, Grok,
Copilot) through a pipeline of work items. Node/TS monorepo: `shared/`, `server/`, `web/`
(Next.js). SQLite via `better-sqlite3`, hand-rolled versioned migrations.

Eight commits landed before you (`git log f0032f7..HEAD`). Read this whole file before touching
anything — there are two things that will bite you, and one of them already destroyed data.

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

Current: **schema 22**, 327 tests passing, `npm run build` clean.

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

## Your scope: three items

### 1. Definition of done  ← the main piece

This is the last of the owner's named asks. They chose: **prose criteria judged by a reviewer,
plus optional commands that must exit 0, with children-all-closed as an automatic criterion.**

Today "acceptance criteria" is prose scraped out of the work item's markdown by a regex with the
owner's old domain baked into it (`server/src/suiteVerification.ts:1`):

```ts
const USEFUL_SECTION = /^(objective|scope|verification\b|acceptance\b|exit\b|constraints|rules\b|money rules\b|rounding\b|snapshots\b|gst verification\b|cross-module boundaries\b|financial-records deletion\b)/i;
```

`gst verification` and `money rules` in a general orchestration tool are leftovers. Replace this
with structured criteria.

**Migration 23** — three tables, inherited workspace → program → suite → work item:

```sql
definition_of_done(id, scope, scope_id, enforcement TEXT('block'|'warn'|'off'), updated_at)
dod_criterion(id, dod_id, kind TEXT('PROSE'|'COMMAND'|'CHILDREN_CLOSED'),
              text, command, cwd, expect_exit_code, timeout_ms, required, sort_order)
dod_result(id, prompt_id, criterion_id, run_id,
           source TEXT('AGENT'|'REVIEWER'|'RUNNER'|'HUMAN'),
           result TEXT('PASSED'|'FAILED'|'UNVERIFIED'), evidence, output, created_at)
```

- `PROSE` → judged by the reviewer agent. Its existing `checks[]` array
  (`server/src/completionAudit.ts`, `parseReport`) maps straight onto `dod_result` rows.
- `COMMAND` → **executed by the server, not the agent**, in the workspace directory, with a
  timeout, recording exit code and captured output. This is the part that cannot be talked into
  passing, and it is the reason the owner picked this option. Treat it as security-sensitive:
  commands come from the database and run as the server's user. Cap the timeout, cap captured
  output, run with the workspace as cwd, and do not interpolate anything from an agent into them.
- `CHILDREN_CLOSED` → evaluated automatically from the existing child rollup.

**The closing gate.** `workspaces.completePrompt` (`server/src/workspaces.ts:2591`) and the
`DONE` path in `writeStatus` must consult `dodSatisfied(promptId)`. Unmet under
`enforcement='block'` → the item lands in `NEEDS_REVIEW` with trigger `dod_unmet` and the failing
criteria as `evidence_json`, instead of `DONE`. A human override is always allowed and is
recorded as `operator_override` with their reason.

**Scaffolding already in place for you** (all currently inert — wire it up, don't rebuild it):

- `STATUS_TRIGGERS` already contains `dod_unmet` and `dod_command_failed`
  (`shared/src/statusModel.ts:512`), with sentences.
- `STEP_SIGNALS` contains `dod_unmet` and `STEP_TRANSITIONS` has a `dod-unmet` row landing on
  `NEEDS_REVIEW` (`statusModel.ts:771`). **Nothing in the server emits that signal yet** — the
  table is total, but the row is unreachable from real code. Your job includes making it reachable.
- `REVIEW_TRIGGERS` contains `dodUnmet` with a shipped `DEFAULT_REVIEWER_CONFIG` entry
  (`statusModel.ts:963`), currently `enabled: false`.
- `completionAuditDossier` (`server/src/workspaces.ts:2894`) is where `acceptanceCriteria` is
  handed to the reviewer. Feed structured criteria through here.

**⚠️ Dangling reference you must resolve.** `PolicyKey` in `statusModel.ts:78` includes
`"pipeline.dodEnforcement"`, and two `STEP_TRANSITIONS` rows point at it — but **that setting does
not exist** in `server/src/settings.ts`. Either add the field (one entry in the `FIELDS` table,
`envVar: "PIPELINE_DOD_ENFORCEMENT"`, options `block|warn|off`) or remove the `PolicyKey` member.
Right now the rules panel offers to open a setting that isn't there.

If you add a settings field, two tests police that surface:
`server/src/settingsCoverage.test.ts:26-45` reads `AgentsView.tsx` **as text**, and
`web/components/agents/settingsGroups.test.ts:16-25` hardcodes the group list.

**UI**: per-item DoD editing in `web/components/tasks/WorkItemDetail.tsx`; scope defaults
alongside the status catalog in `web/components/pipeline/RulesPanel.tsx`. Results belong in the
`WhyThisStatus` panel (`web/components/tasks/WhyThisStatus.tsx`) — it already renders
`evidence_json` as key/value pairs, so failing criteria will show up there once you record them.

### 2. Reviewer matrix UI

The server side is done and tested (`server/src/reviewerConfig.test.ts`, 7 tests). There is **no
UI at all** — `GET/PATCH /api/reviewers`, `DELETE /api/reviewers/:trigger` exist and nothing calls
them.

Build it next to the status catalog in `RulesPanel`. One row per `REVIEW_TRIGGERS` entry
(`unreported · failed · dodUnmet · childFailed`) with: enabled, agent, model, max attempts,
"must differ from the agent on trial", and the three verdict actions
(`onComplete · onIncomplete · onUnverifiable` → `close|handoff|retry|park|markReview`).
`REVIEW_TRIGGER_LABEL` and `REVIEW_ACTION_LABEL` in `statusModel.ts` give you the wording.

Follow `web/components/pipeline/StatusCatalogPanel.tsx` — same shape, same toast handling, same
convention of showing a locked field's *reason* rather than hiding the control.

### 3. Optional cleanup, only if asked

Flagged and deliberately out of scope so far — do not fold these into the above:

- **Two coexisting pipeline systems.** Migration 14 copied `prompt_pipeline_rule` into
  `pipeline_step` but deleted neither the legacy tables nor `/api/suites/:id/play`.
- **`agent_run_event` has no retention policy.** It is why the database is ~150 MB.

---

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

7. **`shared/src/index.ts` re-exports by name, never `export *`.** Node's ESM linker resolves a
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

Then, in the real app (`npm run dev`, <http://localhost:3000>):

1. Point a work item's definition of done at a command that fails; confirm `DONE` is refused and
   the failing command's **real output** appears as evidence on the item.
2. Confirm a passing command actually ran — check the recorded exit code, do not take the
   reviewer's word for it.
3. Rename a status on the rules screen; confirm it changes on the board, the station card and the
   status bar from that one edit.
4. Kill an agent mid-run; confirm the item shows `UNREPORTED` — **not** failed, **not** blocked.

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

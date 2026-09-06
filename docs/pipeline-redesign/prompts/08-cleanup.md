# 08 — Cleanup: one pipeline system, event retention, dead tables and dead settings

Read `00-read-first.md` first — hazard 2 applies to every step here. Requires prompts 03 and 05
(the columns and tables they orphan are what this removes). Do this on a branch; prove every
migration on a copy of the live database before the first `npm test`.

## Objective

The codebase describes one pipeline, the database holds only what the code reads, the settings
page shows only switches that change behaviour, and the database stops growing without bound.

## Why

`HANDOFF.md` § "What is left": two coexisting pipeline systems (`prompt_pipeline_rule` +
`/api/suites/:id/play` beside `pipeline_step` + named pipelines); `agent_run_event` with 162 487
rows and no retention (the 200 MB database, and the reason `tsx watch` restarts take seconds);
`reviewer_config` keyed `(scope, scope_id)` with no foreign key (the bug `definition_of_done` had
fixed, and SQLite reuses row ids). After prompt 03 the following are read by nothing:
`reviewer_config`, `reviewer_reconfigure`, `handoff`, and the columns `pipeline_step.on_blocked`,
`retry_limit`, `recover_provider`, `recover_model`, and `suite_pipeline_run.attempt`/`recovering`
(confirm each with `rg` before you touch it).

## Scope — in this order, one commit each

### 1. Retention for `agent_run_event`

- New settings: `retention.eventsPerRun` (number, default `4000`), `retention.eventAgeDays`
  (number, default `30`), `retention.keepFinalEvents` (number, default `200` — the last N events
  of every run are always kept so a station's "what happened" remains readable).
- `server/src/retention.ts`: `sweepRunEvents()` deletes, per run, events beyond `eventsPerRun`
  oldest-first (keeping the last `keepFinalEvents`), and for runs ended more than `eventAgeDays` ago
  everything but the last `keepFinalEvents`. Batch deletes of 5 000 rows with a short pause; never
  inside a long transaction. Run once 60 s after boot and then every 6 h; log one line with counts.
  Then `PRAGMA incremental_vacuum` if `auto_vacuum` is incremental, else note the file size and tell
  the owner in the README how to `VACUUM` offline.
- `agent_run`, `prompt_remark`, `prompt_status_event`, `agent_command` are **not** touched — they
  are the record.
- Test against real SQLite: a run with 10 000 events keeps `eventsPerRun` with the last
  `keepFinalEvents` intact and in order.

### 2. Drop the tables nothing reads

Migration N+1, with the **pragma outside the transaction** pattern `migrationSafety.test.ts`
enforces — or, better, no pragma at all since these drops need no rebuild:

- Export first: write `handoff`, `reviewer_config`, `reviewer_reconfigure` as JSON to
  `<state dir>/archive/<table>-<timestamp>.json` before dropping (the owner may want the history;
  18 + 2 + 5 rows).
- `DROP TABLE reviewer_config; DROP TABLE reviewer_reconfigure; DROP TABLE handoff;`
- `completion_audit` **stays** (the post-N reviewer writes it). Any `completion_audit` column that
  only the removed matrix read (`reconfigure_json` or similar) → `ALTER TABLE … DROP COLUMN` if the
  SQLite bundled with `better-sqlite3` allows it (≥ 3.35 and the column is not in a table-level
  CHECK, an index, or a foreign key); otherwise leave the column and say so.
- Remove `handoff` from the `agent_run.role` CHECK **only if** the reviewer no longer uses that role
  (it does today: `completionAudit.ts` starts runs with `role: "handoff"`). Changing that CHECK is a
  rebuild — not worth it; leave the role.

### 3. Drop the columns nothing reads

Same migration or the next: `ALTER TABLE pipeline_step DROP COLUMN on_blocked` / `retry_limit` /
`recover_provider` / `recover_model`; `ALTER TABLE suite_pipeline_run DROP COLUMN attempt` /
`recovering`. Each has a column-level CHECK or none; verify with `sqlite_master.sql` that none is
referenced by an index or a table-level CHECK before you rely on `DROP COLUMN`. If any drop is not
possible without a rebuild, **leave that column** and record it in `HANDOFF.md`.

### 4. One pipeline system

- Confirm with `rg` and the web code that `/api/suites/:id/play` and `prompt_pipeline_rule` are
  reachable only from the legacy suite-level Play (not from named pipelines, which own their
  `suite_pipeline_run` rows through `pipeline_step`). If the web still offers a suite-level Play
  button, change it to create-or-open a named pipeline for that suite (one stage, all stations) and
  play that; there must be one way to play.
- Delete the route, `playSuite`'s legacy rule resolution, `pipelineRule`/`upsertPipelineRule` for
  prompts, `pipelineRuleDto` over `prompt_pipeline_rule`, and the table (migration: export to the
  archive as in §2, then `DROP TABLE prompt_pipeline_rule`). Migration 14's copy into `pipeline_step`
  already happened; assert on the copy that every enabled legacy row has a `pipeline_step` twin before
  dropping, and refuse the migration (throw, with the missing keys) if not.
- `suite_pipeline_run` stays: it is the scheduler's engine and named runs own it.

### 5. Dead settings

Go through `server/src/settings.ts` field by field and remove any field whose value is read by
nothing (`rg` the accessor). After prompts 02–05 the candidates are the ones they list; check for
others (`settingsCoverage.test.ts` should already fail for a field with no reader — if it does not,
make it). Remove the matching `.env.example` lines and web form fields.

### 6. Docs

`HANDOFF.md` § "What is left" reflects reality after this prompt (probably: nothing from the old
list; whatever you had to leave). `README.md` § Settings lists only what exists.

## Out of scope

Anything behavioural. If you find a behaviour bug, note it in your report; do not fix it here.

## Acceptance criteria

1. On a copy of the live database: migrations apply; `PRAGMA integrity_check` = `ok`;
   `PRAGMA foreign_key_check` empty; row counts of every **kept** table are unchanged (paste the
   before/after table); archive JSON files exist with the dropped rows.
2. After the retention sweep on the copy: `agent_run_event` ≤ Σ min(events, 4000) per run, and every
   run's last 200 events are intact; a `VACUUM`ed copy is < 60 MB (report the number).
3. `rg -n "prompt_pipeline_rule|reviewer_config|reviewer_reconfigure|\bhandoff\b" server shared web
   --type ts --type tsx` returns only the migration that drops them, the archive code, the
   `agent_run.role` CHECK, and `completionAudit.ts`'s role literal.
4. Exactly one Play entry point in the web.
5. Every settings field has a reader (test); `.env.example` matches.
6. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

The migration script against the copy with before/after counts; the retention sweep log line; the
file sizes before and after `VACUUM`. Say explicitly whether any column could not be dropped.

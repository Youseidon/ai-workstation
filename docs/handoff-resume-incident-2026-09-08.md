# Handoff resume conflict — 2026-09-08

## Root cause

POST `/api/prompts/19/handoff` returned 409 because database prompt ID 19
was already DONE. `scheduleHandoff` correctly rejects terminal work items
with `already_terminal`.

The completed item is titled **18. Stand up one real business workspace**.
It completed on September 6, and pipeline 5 advanced from suite 6 to suite 7.
A server restart on September 8 marked the later pipeline run INTERRUPTED.
The next play created a new named run, which selected the first stage without
checking its completed work. Suite 6 had no ready items, so this run stopped
with `nothing_ready` and retained suite 6 as its current suite.

The board resolved Resume through that suite's latest run, whose historical
`currentPromptId` was still 19. It offered a handoff for the completed item,
causing the 409. Historical current-item pointers are not proof that work
remains to be resumed.

## Fix and validation

- `server/src/pipelineScheduler.ts`: select the next stage with unfinished
  enabled work items, skipping stages whose enabled items are DONE or SKIPPED.
- `web/components/pipeline/PipelineBoard.tsx`: exclude DONE and SKIPPED items
  from the Resume handoff target, allowing ordinary pipeline play instead.
- Added regression coverage for restarting after a completed stage, replaying
  an entirely terminal pipeline, and preserving a genuinely blocked stage.
- All 30 pipeline scheduler tests passed against a separate temporary database;
  shared, server, and web type checks passed. Live records were only read.

## Follow-up and numbering distinction

The user reported that it started at "prompt 19" and explicitly requested
leaving the run alone while recording the cause. The displayed task
**19. Build the registry list** has database ID **20**. This is the expected
next task, not a repeat of database ID 19 (displayed task 18).

A read-only follow-up confirmed a new execute for database prompt 20 started
at `2026-09-08T10:12:51.042Z`; database prompt 19 remained DONE. At inspection,
that new execute was already recorded as ERROR and prompt 20 as BLOCKED.
This later execution failure is separate from the terminal-item handoff
conflict; its cause has not been investigated here. No stop, retry, restart,
or state repair was performed in response to the user's follow-up.

Future debugging should distinguish database IDs from numbers embedded in
task titles and inspect current task outcomes before interpreting historical
pipeline pointers. Do not reset completed tasks to work around this conflict.

## Follow-up: selected Claude, executed Codex

The later execution failure was traced after the user reported the model error.
The named and suite pipeline runs stored `play_provider=claude`, and the handoff
agent was Claude. However, prompt ID 20 had a saved station assignment of
`provider=codex, model=NULL`, last updated September 4. The scheduler's normal
station-over-pipeline precedence silently overrode the chosen successor.

The Codex adapter received no explicit model. The local
`/home/junaid/.codex/config.toml` contained `model = "gpt-6-astra"` on line 1;
the origin of that setting is unknown. The CLI reported that this model required
a newer Codex version. No Codex configuration or installation was changed.

Fix: a named-pipeline handoff now saves its selected provider/model on the
current station before resuming. This preserves the selection for retries,
leaves other stations' assignments intact, and keeps ordinary pipeline
precedence unchanged. The handoff dialog defaults to the preferred usable
provider and labels the selection as saved for this station. An explicit null
successor model is preserved, and switching providers does not inherit the old
provider's model. Pipeline membership is checked before changing the station.

All 33 scheduler tests and all workspace type checks passed. Regression tests
cover switching a Codex station to Claude with null, omitted, and explicit
models, retrying Claude, and retaining other station assignments.

The existing ready brief was reused through POST `/api/prompts/20/handoff`
with Claude selected for both roles and pipeline ID 5. The API returned
`started=true`, `reusedReady=true`, and successor run
`run_3e3b52a1-e661-4e27-9dcc-19caa0fa5408`. This correction targets task ID 20;
other tasks may still have intentionally saved Codex assignments.

## Permanent pipeline override and manual correction

The next recurrence was on **20. Prepare the A/B send** (database ID 21).
Database ID 20 had completed successfully with Claude, but ID 21 still had its
own Codex assignment. The earlier fix covered one station, not subsequent
stations. A pipeline-level selection passed as a play default was insufficient
because station rules outrank that default.

Schema migration 14 adds `pipeline.execution_provider` and `execution_model`.
When set, the scheduler reads this saved override at every agent start, before
station assignments, play defaults, and recovery assignments. This applies to
subsequent stations and suites, retries, resumed runs, and handoff successors.
The override is stored on the pipeline definition, so new runs after a restart
retain it. A null override model uses the selected provider's configured
default without inheriting models from other assignments. Provider changes
clear an incompatible old override model. Removing the override restores
individual station rules. Saving does not interrupt an existing process.

Manual correction on the Pipeline page:

1. Click **Pipeline agent** in the header.
2. Select the agent and optionally a model.
3. Click **Save pipeline agent**, then Resume, or use
   **Save and retry current task** when the current process failed without a
   human blocker. Real human blockers still require a response.
4. Select **Use individual station assignments** to remove the override.

The header shows the saved provider and a banner explains its scope. The
handoff successor selector follows the override, and runtime logs now identify
the selected provider/model and whether the pipeline override was applied.

Validation: 37 scheduler tests and 4 human-input tests passed in an isolated
database, including multi-task and multi-suite progression, persistence,
restart, manual correction, recovery, override removal, and handoff precedence.
Workspace type checks and lint on the changed web files passed. The local API
served the new fields and the pipeline page returned HTTP 200; interactive
browser automation was unavailable.

Pipeline 5 was updated through PATCH `/api/pipelines/5` to pin Claude with its
configured default model. POST `/api/prompts/21/respond-and-continue` then
returned successor `run_22caf014-2d1c-4d1d-a0e1-f11870e6c738`; the database
confirmed that successor was RUNNING with provider `claude`. Database ID 20
remained DONE. This is now a persistent pipeline correction rather than a
one-task assignment change.

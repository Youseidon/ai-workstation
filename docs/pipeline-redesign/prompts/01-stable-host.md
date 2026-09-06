# 01 — A stable host: `serve`, a dev sandbox, and auto-resume after a restart

Read `00-read-first.md` first. This prompt is independent of the others and should land first.

## Objective

A live pipeline must never be killed by the console's own development loop, and a pipeline that
*is* interrupted by a restart must pick itself back up without anyone pressing a button.

## Why

22 of the owner's 34 pipeline runs ended with `stop_reason = server_restart`. The console runs under
`tsx watch`; every code edit restarts the server, kills the agent process, marks the pipeline
`INTERRUPTED`, and — under the current `pipeline.onRestart = newRun` default — nothing starts again
until the operator returns, notices, recovers the station, and presses Play (often through a
"prepare a handoff first" dialog). A pipeline meant to run unattended overnight was instead
dependent on the owner not editing code.

## Scope

### 1. `npm run serve` — the way a live pipeline is run

In the root `package.json`:

- `serve`: `npm run build && concurrently --kill-others-on-fail -n server,web -c cyan,magenta "npm:serve:server" "npm:serve:web"`
- `serve:server`: `npm run serve --workspace server` → in `server/package.json` add
  `"serve": "AGENT_CONSOLE_MODE=serve tsx src/index.ts"` (no `watch`).
- `serve:web`: `npm run start --workspace web` (Next production server).

Write a short **"Running a live pipeline"** section into `README.md` (replace the Quick start's
implicit "use dev for everything"): `serve` for anything that drives real work; `dev` only against a
sandbox database.

### 2. `npm run dev:sandbox` — development that cannot touch the live database

Root script `dev:sandbox` runs a small node script `scripts/dev-sandbox.mjs` that:

1. Copies `~/.local/state/agent-console/console.sqlite` (and its `-wal` if present; use the same
   path resolution as `server/src/workspaces.ts` — read `AGENT_CONSOLE_DB`/`XDG_STATE_HOME`) to
   `/tmp/agent-console-sandbox/console.sqlite`, unless `--keep` is passed and a copy exists.
2. Launches the normal `dev` with `AGENT_CONSOLE_DB=<copy> PORT=4100
   NEXT_PUBLIC_AGENT_SERVER_URL=http://127.0.0.1:4100` and the web on `3100` (`next dev -p 3100`;
   pass the port through however `web/package.json` allows).
3. Prints the two URLs and "this is a sandbox; the live database is untouched".

### 3. A guard so `dev` cannot be pointed at a live database by accident

`server/src/lib/instanceLock.ts` currently writes the pid into the lock file. Extend the payload to
JSON `{ pid, mode, startedAt }` where `mode` is `process.env.AGENT_CONSOLE_MODE ?? "dev"`. Keep
backwards compatibility with a bare-pid file.

In `server/src/index.ts`, where `acquireInstanceLock` is called:

- If this process is `dev` (mode ≠ `serve`) and `AGENT_CONSOLE_DB` is **not** set and the resolved
  database path is the default state-dir path, refuse to start with a clear message:
  *"Refusing to run the watch server against the live database. Use `npm run serve` for a live
  pipeline, or `npm run dev:sandbox` to develop against a copy."* Allow an override env
  `AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1` for the owner's deliberate use.
- If the lock is held by a `serve` process, the existing `InstanceLockedError` message should say
  so explicitly ("a live console is running; develop with `npm run dev:sandbox`").

### 4. Auto-resume after a restart

Today the boot routine in `workspaces.ts` (search `stop_reason='server_restart'`) marks in-flight
runs `INTERRUPTED`, orphaned `IN_PROGRESS` items `UNREPORTED`, and pipelines `INTERRUPTED`; then
nothing happens.

Add a third `pipeline.onRestart` option, **`autoResume`, and make it the default**:

- In `shared/src/pipelineRules.ts`: `RESTART_POLICIES = ["autoResume", "newRun", "resumeSameRun"]`;
  `DEFAULT_PIPELINE_POLICY.onRestart = "autoResume"`; add a `TRANSITIONS` row
  `interrupted-auto-resume` (`when: { runState: "INTERRUPTED", onRestart: "autoResume" }`, label
  "Resuming", tone `info`, pulse true, primary `stop`, headline "The server restarted; this run is
  being picked back up automatically.") placed **above** `interrupted-resume`.
- In `server/src/settings.ts`: add the option to the `pipeline.onRestart` field with description
  "Resume every interrupted pipeline by itself a few seconds after boot. The station whose agent
  died is re-run on the same working tree; nothing is marked done or failed." Make it the fallback.
- In `server/src/index.ts` after the server is listening and providers have been detected once:
  if the policy is `autoResume`, schedule (≈10 s after boot, so provider detection and the web
  client can settle) a call to a new `pipelineScheduler.resumeInterrupted()`.
- `pipelineScheduler.resumeInterrupted()` in `server/src/pipelineScheduler.ts`: for every
  `suite_pipeline_run` **and** `pipeline_run` with `state='INTERRUPTED' AND stop_reason='server_restart'`
  whose `ended_at` is within the last 24 h and which has no newer run for the same suite/pipeline:
  1. If `current_prompt_id`'s item is `UNREPORTED` or `IN_PROGRESS` with no live run
     (`recoverable`), reset it to `TODO` through `writeStatus` with a **new** trigger
     `restart_resume` (add to `STATUS_TRIGGERS` and `DEFAULT_TRIGGER_SENTENCES`: "The server
     restarted mid-run, so the station was re-queued on the same working tree."). Keep the tree; do
     not touch files. After prompt 03 lands, this re-queue counts as a continuation.
  2. Resume the run (`resume(...)` for suite runs; `playNamed` for named runs) with the same
     `play_provider`/`play_model`. Named runs own their suite runs — resume via the named run and let
     `syncNamedFromSuite` do the rest; do not resume both.
  3. Log one line per pipeline: `auto-resume pipeline=… suite=… station=…`.
  Wrap each pipeline in its own try/catch; one failure must not stop the others. Everything goes
  through `enqueue(workspaceId, …)` like the other entry points.
- `runHub.isClosing()` already stops `onExecuteEnded` from advancing during shutdown; keep that.

### 5. Graceful shutdown keeps its promise

`server/src/shutdown.test.ts` and the shutdown path in `index.ts` already leave the pipeline
`PLAYING` so the next boot marks it interrupted. Confirm the new auto-resume picks exactly those up
(that is the whole point) and that an operator `Stop` before shutdown is *not* resumed
(`stop_reason='operator_stop'` is not `server_restart`).

## Out of scope

Anything about budgets, continuations, handoffs or the reviewer — prompts 02 and 03. Do not change
what a restart does to the *station's status* beyond re-queueing it; do not infer an outcome.

## Acceptance criteria

1. `npm run serve` starts server + web without file watching; editing a `.ts` file does not restart
   it.
2. `npm run dev` with no `AGENT_CONSOLE_DB` and the default database path refuses to start with the
   message above; `npm run dev:sandbox` starts on 4100/3100 against a fresh copy.
3. A pipeline that is `PLAYING` when the server is killed (`kill -TERM`) is `INTERRUPTED` on boot and
   is `PLAYING` again within ~15 s with a new agent run on the same station, with a ledger row
   whose `trigger_id` is `restart_resume` and a stop/wait reason that the Rules panel renders.
4. A pipeline stopped by the operator before the restart stays `STOPPED`.
5. The Rules panel shows the new `interrupted-auto-resume` row and its policy link.
6. Tests: a `pipelineScheduler.test.ts` case for each of (3) and (4); an `instanceLock.test.ts` case
   for the JSON payload and the bare-pid fallback; a settings-coverage test still passes (every
   option in the field table is honoured).
7. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

On a disposable database (`PORT=4137 AGENT_CONSOLE_DB=/tmp/verify.sqlite`): create a workspace
pointing at a scratch directory, one suite with two trivial items, a pipeline; Play; while the first
station's agent is running, `kill -TERM` the server; restart; watch it resume. Paste the relevant
log lines and the `prompt_status_event` rows in your report.

## Commit message

Say what changed, what it fixes (cite the 22/34 figure), what you verified and what you did not
(e.g. "not verified with a Cursor run; verified with Codex").

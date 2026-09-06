# 02 — Budgets that guard money and thrash, and a wrap-up turn instead of a silent kill

Read `00-read-first.md` first. Independent of 01; prompt 03 depends on this one (it needs
`agent-step continue`).

## Objective

A run is never killed mid-work without a chance to write down what it learned. Budgets exist to cap
spend and to catch a thrash loop — not to stop an agent that is reading its fifth file.

## Why

23 execute runs were stopped by the runner's budget: 13 at `budget_tool_calls:125`, 6 at
`budget_tool_output_bytes:524288`, 3 at `budget_tool_calls:250`, 2 at input tokens. The 125 comes
from `budget.subStepFraction = 50 %` of `budget.maxToolCalls = 250`. Cursor with grok-4.6 makes
~30 tool calls a minute, so a sub-step dies in 3–4 minutes while still reading. The 80 % warning is
only visible in Progress API responses, so an agent that has not posted a remark yet never sees it.
When the budget trips, `stopForBudget()` interrupts the provider: no wrap-up, no notes, and the
station lands `UNREPORTED` with the stop reason as its only record. S6-09.1 died this way four times
in twenty minutes today with nothing written to disk.

The reviewer/handoff runs that then try to reconstruct what happened cost ~30 M input tokens to
date and are being removed in prompt 03. The agent that did the work is the cheapest and best
source of "what is done and what remains" — it already has the context.

## Scope

### 1. Budget defaults and the end of sub-step halving

In `server/src/settings.ts`:

- `budget.maxToolCalls` fallback **1000** (description: "A safety ceiling, not a working limit. When
  it is reached the run gets a wrap-up turn to record its progress, then continues in a fresh run.")
- `budget.maxWallClockMinutes` fallback **90**.
- `budget.maxToolOutputBytes` fallback **8 MB** (`8388608`).
- `budget.maxInputTokens` unchanged (this is the money).
- `budget.noProgressToolCalls` unchanged (this is the thrash detector).
- **Remove** `budget.subStepFraction` and the `depth`-based scaling in `settings.budgetFor` and
  `runner.startRun` (`budgetDepth`). A sub-step is the unit of work; halving its allowance is what
  guaranteed the deaths above. Keep `budgetFor()` signature-compatible if simpler (ignore depth), but
  delete the setting and its env var from `.env.example`.
- Update `.env.example` comments.

### 2. Providers expose a resumable session

Every CLI supports resuming a session: `cursor-agent --resume <chatId>`, `codex exec resume
<thread_id>`, Claude Agent SDK `resume: <session_id>`, `grok`/`copilot` report a `sessionId`
(check `grok --help` and `copilot --help` on the installed versions for the resume flag; if one
cannot resume, say so and fall back per §4).

- `server/src/adapters/types.ts`: add `resumeSessionId?: string | null` to `RunOptions`, and a
  `sessionId?: string` field on the adapter `result` event payload (or a dedicated `session` status
  detail — pick one and use it for all five).
- Each adapter records the session/thread id it sees (`cursor.ts` `session_id`, `codex.ts`
  `thread.started.thread_id`, `claude.ts` SDK `session_id`, `grok.ts` `sessionId`, `copilot.ts`
  `sessionId`) and, when `resumeSessionId` is set, launches the resume form instead of a fresh
  session. Verify the exact flags against the installed binaries (`cursor-agent --help`, `codex
  exec --help`) and note the versions in a comment, the way `README.md` § "CLI flags drift" does.
- `server/src/runner.ts`: `RunHandle` gains `sessionId(): string | null`; `RunMetrics` gains
  `sessionId: string | null`; `workspaces.finishAgentRun` persists it in a new nullable column
  `agent_run.session_id` (migration N+1, `ALTER TABLE agent_run ADD COLUMN session_id TEXT` — no
  rebuild, no pragma games; still prove it on a copy as `00` says).

### 3. The wrap-up turn

In `server/src/runner.ts`, `stopForBudget()` currently interrupts and aborts. Change the contract:
the runner still ends the run with `stopReason = budget_…` (unchanged, so the ledger keeps recording
*why*), but `runService.startExecute`'s `onEnd` — when `metrics.stopReason` starts with `budget_`
and the prompt is still `IN_PROGRESS` — starts a **wrap-up run** before the pipeline is told
anything:

- A new function `startWrapUp({ workspaceId, promptId, sourceRunId, provider, model, sessionId })`
  in `server/src/runService.ts`:
  - New `agent_run` row with `role='execute'` and a new nullable column `wrapup_of TEXT` pointing at
    the source run (same migration as §2; `ALTER TABLE ADD COLUMN`). It reuses the source run's
    **prompt** credential scope (new `runContexts.create` for the new run id) and a fresh
    `agent-step` shim.
  - Budget for the wrap-up: `maxToolCalls: 12`, `maxWallClockMs: 4 min`, `maxInputTokens: null`,
    no wrap-up of a wrap-up (if it trips, the run simply ends).
  - Same permission mode as an execute run (it must be able to run `agent-step`, which is a shell
    command hitting `127.0.0.1`; a read-only sandbox blocks that on Codex).
  - Prompt (short — the session already holds the context):

    > Your run was stopped by the orchestrator's budget (`<stopReason>`), not because anything
    > failed. **Do not edit files or run build/test commands.** Do exactly this, in order:
    > 1. `<agent-step> remark --kind PROGRESS --text "…"` — what is verified (with the command and
    >    result), what is partly done (file paths), and any decision you made that the next run must
    >    know.
    > 2. Then exactly one of:
    >    - `<agent-step> done --verification "…"` only if every acceptance criterion is already
    >      verified; or
    >    - `<agent-step> continue --remaining "…"` — the remaining work as concrete instructions for
    >      the run that resumes this item on the same working tree (files, routes, commands, what
    >      "done" looks like); or
    >    - `<agent-step> blocked --reason "…" --action "…"` only for a concrete external dependency
    >      that needs a human.
    > A run that ends without one of these is treated as `continue` with no notes.

  - If `sessionId` is null or the provider cannot resume, run the wrap-up as a **fresh** short run
    whose prompt additionally contains: the work item's title and key, the last 5 `PROGRESS`/
    `VERIFICATION` remarks, `git status --short` and `git diff --stat` of the working tree
    (captured by the server with `spawnSync`, bounded to 8 KB). Say in the prompt that it is a fresh
    session.
- **Ordering, and the one trap.** `workspaces.finishAgentRun` applies the end-of-run status
  transition (IN_PROGRESS → UNREPORTED when nothing was posted) the moment the source run ends —
  which would make the wrap-up's `done`/`continue` posts fail with `invalid_transition` because the
  item is no longer `IN_PROGRESS`. So: `finishAgentRun` gains an option `deferStatus: true` used
  only when a wrap-up will follow; it records the run row (state, `ended_at`, metrics, stop reason)
  but leaves the item `IN_PROGRESS`. The wrap-up run is a normal `STARTING`/`RUNNING` execute run on
  the same prompt, so `requireActiveExecuteRun` admits its posts. When the wrap-up run ends, *its*
  `finishAgentRun` applies the transition if the item is still `IN_PROGRESS` — `UNREPORTED`, with
  the **source** run's stop reason in the ledger `reason` and `evidence_json: { wrapupOf,
  wrapupStopReason }`. If the wrap-up cannot be started at all (provider gone), apply the transition
  immediately as today. Only after the wrap-up run ends does `pipelineScheduler.onExecuteEnded` fire
  — with the **source** run id (the scheduler's `currentRunId` guard keys on it). The wrap-up's own
  end must not trigger a second `onExecuteEnded`. Cover the deferred path in `statusLedger.test.ts`:
  a source run that ends under budget with a wrap-up pending leaves no ledger row until the wrap-up
  ends.
- Transcript: the wrap-up's events are recorded under its own run id; the station card shows it as
  "wrap-up" (use `wrapup_of` in the run summary DTO so the web can label it — a small label in
  `StationCard.tsx`, nothing more).

### 4. `agent-step continue`

- `server/bin/agent-step.mjs`: add `continue --remaining "<text>" [--verified "<text>"]` → `POST
  …/status` with `{"status":"CONTINUE", "reason": <remaining>, "verificationSummary": <verified>}`.
  Update `help` text.
- `server/src/index.ts` agent door (`/status`): accept `status: "CONTINUE"`. It is **not** a stored
  status. It writes, through `writeStatus`, `to: "TODO"`, new trigger `agent_continue`
  ("The agent recorded its progress and asked to be resumed on the same working tree."), new
  `rule_id: "agent-continue"`, `evidence_json: { remaining, verified }`, and one remark of new kind
  `CONTINUATION` whose content is the `remaining` text (this is the brief the next run receives).
  Then it ends the run the way a `done`/`blocked` post does (`handle.complete()`).
- Idempotency, audit (`agent_command`) and the `db_access` transcript flag work exactly as for
  `done`/`blocked`.
- `shared/src/statusModel.ts`: add `agent_continue` to `STATUS_TRIGGERS` and a `STEP_TRANSITIONS`
  row `agent-continue` (`signal: agent_posted_continue`, `to: "TODO"`, `next: "rule"`, locked —
  "The agent's own account of what remains is the cheapest brief there is."). Add the signal to
  `STEP_SIGNALS`; the totality test in `statusModel.test.ts` must still pass.
- **Until prompt 03 lands**, the scheduler must treat a run that ends with the item on `TODO` and
  latest trigger `agent_continue` as: re-run the same station once, immediately (not `advance` — that
  path is for `agent_decompose`). Tell `applyExecuteEnded` apart by reading the latest ledger row's
  `trigger_id` for the prompt (`workspaces.latestStatusTrigger(promptId)` — add it if absent), not
  by the status alone. Prompt 03 replaces this with the counted continuation loop.

### 5. Agent-facing text

In `server/src/agentContext.ts` (`progressApiMarkdown` and the execute protocol): replace the
"decompose or report BLOCKED if it will not fit the window" advice and the "a reviewer is sent…
that costs an extra run" paragraph with:

> If this run is stopped by its budget you will be given a short wrap-up turn on this same session
> to record what is verified and what remains, and the item will be resumed on this working tree.
> Bank progress with `PROGRESS` remarks as you go. Never report `BLOCKED` because work remains.

List `continue` in the command block. Keep the whole section under ~1 KB (prompt 06 trims the rest).

## Out of scope

The continuation counter, removal of audit/handoff/remediate, station rule changes — prompt 03.
Decompose changes — prompt 07.

## Acceptance criteria

1. A fresh install's effective budget for a depth-2 sub-step equals the station's; the
   `subStepFraction` setting, env var and UI field are gone.
2. A run stopped at any budget gets exactly one wrap-up run (`agent_run.wrapup_of = source id`),
   and the pipeline is told about the source run only after the wrap-up ends.
3. `agent-step continue --remaining "x"` from a live run: the item is `TODO`, the ledger row has
   `trigger_id = agent_continue`, `rule_id = agent-continue`, a `CONTINUATION` remark exists with
   "x", the run ends `done`, and the station is re-run once.
4. A wrap-up that posts `done` closes the item exactly as a normal `done` does (it goes through the
   same door and the same `writeStatus` gate).
5. A wrap-up that posts nothing → source station `UNREPORTED` exactly as today, with the budget stop
   reason.
6. For at least two providers (Cursor and Codex), the wrap-up demonstrably resumes the *same
   session* (the agent refers to files it read in the source run without re-reading them). Record
   which providers you verified and which fall back to the fresh-session form.
7. Tests: `runBudget.test.ts` (defaults, no depth scaling), a `wrapUp.test.ts` covering (2)–(5)
   against real SQLite with a fake adapter, `agentDoor.test.ts` for `CONTINUE`, `statusModel.test.ts`
   totality.
8. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

On a disposable database: set `budget.maxToolCalls` to `6` in settings, run a saved item with Codex
that needs more than six tool calls, and paste: the source run's `stop_reason`, the wrap-up run's
row, the `CONTINUATION` remark, and the second run's first assistant message showing it received the
brief. Repeat once with Cursor. Report the installed CLI versions you tested against.

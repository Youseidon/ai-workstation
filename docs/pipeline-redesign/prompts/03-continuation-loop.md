# 03 — One continuation loop replaces audit → remediate → handoff → retry → recover

Read `00-read-first.md` first. Requires prompt 02 (`agent-step continue`, wrap-up turn). This is the
largest prompt; it is mostly deletion. Do it in one session, on a branch, and do not merge partially.

## Objective

When a run ends, the scheduler has exactly three answers — **advance**, **park for a human
question**, or **continue the same station** — and the operator can read the whole decision table on
one screen.

## Why

Today a run that ends unfinished can go through: an automatic completion audit (read-only agent),
a reviewer verdict routed through a 4×3×6 matrix, a remediation run with a reviewer-written brief and
reviewer-granted budget/provider changes, an automatic handoff (another read-only agent), a station
`retry` with its own counter, a `recover` provider, and finally one of five park reasons. Each stage
was added to fix one incident. The record: 24 audits → 23 INCOMPLETE; 17 handoffs → 15 "CONTINUE";
~30 M input tokens of read-only runs; and the pipeline still parked on `retry_exhausted` after four
identical deaths. None of it produced a line of code. Prompt 02 makes the working agent write its
own brief for free; this prompt makes the scheduler act on it and deletes the rest.

## The new model

### Run outcome → decision

After a run ends, read the item's **latest ledger row** (`prompt_status_event`, newest first) —
not the bare status — and decide:

| Item status | Latest trigger | Decision |
|---|---|---|
| `DONE` | any | `applyOnDone` (station rule `onDone`) |
| `SKIPPED` | any | advance |
| `BLOCKED` | `agent_post` | **park**, `wait_reason = "human_question"` — the only human stop |
| `TODO` | `agent_decompose` | advance (into the children) |
| `TODO` | `agent_continue` | **continuation** (brief = the agent's `CONTINUATION` remark) |
| `UNREPORTED` | any | **continuation** (brief = the stop reason + last PROGRESS remarks) |
| `FAILED` | `run_crashed` / `run_start_failed` | **continuation** (prompt 05 adds provider fallback in front of this) |
| `NEEDS_REVIEW` | any | **continuation** (prompt 04 changes what produces this; until then treat like UNREPORTED) |
| anything else | — | `terminate(STOPPED, "unexpected_status:…")` (keep this; it is the tripwire) |

### Continuation

`continuation(pipeline, promptId, cause)`:

1. `n = workspaces.continuationCount(promptId)` — the number of ledger rows with
   `rule_id = "continuation"` **since the most recent row whose `actor_type` is `USER`** (an operator
   retry/override grants a fresh allowance; that is what a human intervening means).
2. If the station rule's `onUnfinished` is `skip` → `skipPrompt(…, "SYSTEM", …)` and advance.
   If `wait` → park with `wait_reason = "station_rule_wait"`.
3. If `n < settings.pipelinePolicy.maxContinuations` (new setting, default **4**): `writeStatus`
   `to: "TODO"`, trigger `continuation`, `rule_id: "continuation"`, `evidence_json: { attempt: n+1,
   of: N, cause, previousRunId }`, and a SYSTEM remark of kind `CONTINUATION` **only when the agent
   left none** (content: the cause sentence + "Inspect the working tree before changing anything;
   do not redo verified work."). Then `startCurrentStation` on the same station with the same
   provider/model resolution as before. Log `continuation n/N suite=… prompt=… cause=…`.
4. If `n >= N`: if `pipeline.reviewAfterContinuations` (new boolean, default `true`) start **one**
   completion audit through the existing `scheduleCompletionAudit` (kept as the sole reviewer path;
   `automatic: true`) and park with `wait_reason = "review_running"`. When it settles:
   `COMPLETE` → `completePrompt` (its DoD gate still applies) → advance; anything else → park with
   `wait_reason = "continuations_exhausted"` and the report attached to the station. If the setting
   is off → park `continuations_exhausted` directly.

Everything runs inside `enqueue(workspaceId, …)` and stays idempotent under replay (keep the
`live.currentRunId !== runId` guard).

## Scope — what to change

### `shared/`

- `shared/src/index.ts` / rule types: `PromptPipelineRule` becomes `{ provider, model, onDone:
  "continue" | "stop" | "skip_rest", onUnfinished: "continue" | "skip" | "wait" }`. Remove
  `onBlocked`, `retryLimit`, `recoverProvider`, `recoverModel` from the DTO, the validators, and
  `defaultPromptPipelineRule`. Remove `CompletionAuditReport.reconfigure`, `ReconfigureDirective`,
  `ReconfigureKind`, `REVIEW_TRIGGERS`, `REVIEW_ACTIONS`, `ReviewerConfig`,
  `DEFAULT_REVIEWER_CONFIG`, `reviewTriggerFor`, `REVIEW_ACTION_*`, `HANDOFF_TRIGGERS`,
  `HANDOFF_REQUIREMENTS`, `autoHandoffAllowed`, `handoffRequired`, `AUDIT_ON_BLOCKED_MODES` and
  their type guards. Remember: re-export by name.
- `shared/src/pipelineRules.ts`: `PipelinePolicy` becomes `{ pauseMode, stopInterruptsAgent,
  onRestart, maxContinuations, reviewAfterContinuations, dodEnforcement, defaultOnUnfinished,
  defaultOnDone }`. `STOP_REASON`/wait reasons: remove `retry_exhausted`, `recover_exhausted`,
  `handoff_running`, `audit_running`, `audit_incomplete`, `audit_unverifiable`; add
  `human_question` ("The agent asked a question only you can answer."), `station_rule_wait`,
  `review_running` ("A read-only reviewer is checking the station after its continuations ran
  out."), `continuations_exhausted` ("The station was continued N times and is still not finished.
  Read the last brief, fix what is in the way, then Resume."). Replace the corresponding
  `TRANSITIONS` rows one-for-one; the `waiting-human-rule` fallback row stays as the catch-all.
  Rewrite `onBlockedConsequence` as `onUnfinishedConsequence`. `PolicyKey` shrinks to the keys rows
  still reference.
- `shared/src/statusModel.ts`: add trigger `continuation` ("The station was re-queued on the same
  working tree with the previous run's notes.") and `STEP_TRANSITIONS` rows for the continuation
  decisions (`run-ended-no-post` → `next: "continue"` instead of `"review"`; `run-crashed` →
  `"continue"`; new `STEP_NEXT_ACTIONS` value `continue`; remove `handoff`). Remove the rows and
  policy links for review verdicts (`review-complete/incomplete-*/unverifiable/unavailable`) except
  what the post-N review needs (`review-complete` → DONE stays; the others collapse to
  `review-not-complete` → park). Update `reviewTriggerFor` callers → deleted. Keep the catalog
  (statuses) unchanged.

### `server/`

- **Migration N+1** (after 02's): `ALTER TABLE pipeline_step ADD COLUMN on_unfinished TEXT NOT NULL
  DEFAULT 'continue' CHECK(on_unfinished IN ('continue','skip','wait'))` and the same on
  `prompt_pipeline_rule`. Backfill: `UPDATE … SET on_unfinished = CASE on_blocked WHEN 'wait' THEN
  'wait' WHEN 'skip' THEN 'skip' ELSE 'continue' END`. Do not drop `on_blocked`, `retry_limit`,
  `recover_*` (prompt 08). Prove on a copy per `00`.
- `server/src/settings.ts`: remove fields `pipeline.handoffRequirement`, `pipeline.handoffTrigger`,
  `pipeline.auditOnBlocked`, `pipeline.maxHandoffGenerations`, `pipeline.maxRemediationAttempts`,
  `pipeline.reviewerReconfigure`, `pipeline.maxReviewerBudgetMultiplier`, `pipeline.defaultOnBlocked`.
  Add `pipeline.maxContinuations` (number, 4, "How many times one station is re-run on its own
  before a reviewer is sent and the rail parks. An operator Resume grants a fresh allowance."),
  `pipeline.reviewAfterContinuations` (boolean, true), `pipeline.defaultOnUnfinished` (select:
  continue / skip / wait). `settingsCoverage.test.ts` must show every field is honoured.
- `server/src/pipelineScheduler.ts`: implement the table above in `applyExecuteEnded`; delete
  `applyOnBlocked`, `tryAutoHandoff`, `tryCompletionAudit` (the post-N call goes straight to
  `scheduleCompletionAudit`), `applyReviewAction`, `applyReconfigure`, `remediationBrief`,
  `tryRemediate`, `processFailureBlocked`, `UNFINISHED_STATUSES`, and the `attempt`/`recovering`
  handling in `resolveExecuteTarget`/`startCurrentStation`. `settleAudit` shrinks to: COMPLETE →
  close (DoD gate) → advance; else park `continuations_exhausted`. Keep `park`, `terminate`,
  `advance`, `applyOnDone`, `resume`, `playSuiteUnlocked` (its "not ready" reasons must mention
  the new wait reasons), the named-pipeline sync, pause/stop.
- `server/src/completionAudit.ts`: delete `parseReconfigure`, `reconfigure` in the report and
  markdown, `providerFor`'s reviewer-config lookups → provider is `settings.pipelinePolicy`-free:
  "first available read-only provider that is not the source", with an optional
  `pipeline.reviewProvider` setting if you find one is needed (otherwise leave it out). The audit
  prompt's `reconfigure` paragraph goes. The **manual** audit endpoint stays.
- `server/src/handoffCoordinator.ts`: delete the automatic path (`scheduleHandoff` callers from the
  scheduler, `resumeReadyHandoff`, `preparePromptForSuccessor`, `preparePromptForHandoffRetry` and
  their API routes). If nothing else calls into the file, delete it and its tests
  (`handoffReuse.test.ts`, `directRetry.test.ts`) — the resume path is now just "Resume".
- `server/src/workspaces.ts`: add `continuationCount`, `latestStatusTrigger`; remove
  `remediationCount`, `preparePromptForRemediation`, `promptBudgetMultiplier`,
  `recordReviewerReconfigure`, `reviewerReconfiguresForPrompt`, `reviewerConfig`,
  `upsertReviewerConfig`, `reviewSituation` (and their API routes in `workspaceApi.ts`/`index.ts`).
  Delete `reviewerConfig.test.ts`; trim `completionAudit.test.ts` to the post-N review path. Keep
  the tables. `pipelineRule`/`upsertPipelineRule`/`upsertNamedPipelineRule` read and write
  `on_unfinished`.
- `server/src/runner.ts`: remove `budgetMultiplier`.
- `server/src/runService.ts`: `startExecute` no longer consults handoff state; `onExecuteEnded`
  is called with the source run (per prompt 02).

### `web/`

- Delete `ReviewerMatrixPanel.tsx` and its use in `RulesPanel.tsx`.
- `PipelineBoard.tsx`: delete the handoff dialog (`handoffOpen`, `handoffProvider`, "Prepare handoff
  and continue", `directRetry` branch) — **Resume resumes**. The station rule editor edits
  `onUnfinished` (three options with `onUnfinishedConsequence` copy) and `onDone`; remove retry
  limit and recover provider controls.
- `PipelineStatusBar`, `StationCard`, `PipelineBlockedStations`: render the new wait reasons and
  show "continuation n/N" on a station (from the latest `continuation` ledger row's evidence).
- `status.ts` / `continuation.ts` / their tests: update to the new vocabulary.

### Settings and docs

- `.env.example`: remove the deleted `PIPELINE_*` variables, add the new ones.
- `README.md`: rewrite the pipeline behaviour paragraph around the three-outcome table above.
- `HANDOFF.md`: replace the "reviewer matrix / definition of done" sections with a short pointer to
  `docs/pipeline-redesign/PLAN.md`; keep the hazards and invariants sections.

## Out of scope

Server-side verification on DONE (04), provider fallback (05), context trimming (06), decompose (07),
dropping tables (08).

## Acceptance criteria

1. The decision table above is the *only* logic in `applyExecuteEnded`, and a test enumerates every
   row (status × trigger) and asserts the decision — including `unexpected_status` for an unknown
   pair.
2. A station that ends `UNREPORTED` four times is re-run four times without a park, each with a
   `continuation` ledger row (`attempt` 1..4), then a single audit starts, then it parks
   `continuations_exhausted` if the audit is not COMPLETE. No handoff row, no remediation, no
   reconfigure row is ever written.
3. An agent `BLOCKED` parks immediately with `human_question` and is never continued.
4. Operator **Resume** on a `continuations_exhausted` park re-runs the station and the next four
   continuations are allowed again.
5. `agent_continue` → the next run's context contains the agent's `CONTINUATION` remark verbatim
   under "Prior run context".
6. `grep -rn "handoffTrigger\|auditOnBlocked\|remediat\|reconfigure\|recoverProvider\|retryLimit"
   shared server web --include=*.ts --include=*.tsx` returns nothing outside migrations and tests
   that assert the backfill.
7. The Rules panel renders the new `TRANSITIONS` and `STEP_TRANSITIONS`; every row's `policy` points
   at a setting that exists (`rulesSurface.test.ts`).
8. Migration proven on a copy: identical row counts on every pre-existing table, `integrity_check`
   ok, `on_unfinished` backfilled as specified.
9. `npm run typecheck && npm test && npm run build` clean; test count may drop — say by how much and
   which files were deleted.

## Verification to run and report

On a disposable database with a fake adapter that ends without posting: Play a two-station suite,
watch four continuations and the park. Then with an adapter that posts `continue` twice and then
`done`: watch it advance to station two. Then an adapter that posts `blocked`: watch the park and
Resume. Paste ledger rows for each. State which providers you ran for real, if any.

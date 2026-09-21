# Team feature gap register

Created 2026-09-21, at jd's instruction, when implementation finished and the open items needed one place to live.

Every gap found during the F and H tracks is here, whether or not anyone is working on it.
The [burn-down tracker](team-burndown-tracker.md) says what happened; this says what has not.

jd's ruling of 2026-09-21: **work the critical items, then the high ones. The medium and low items are decided after those land.**

| Band | Meaning |
| --- | --- |
| Critical | The feature does not work, or nothing has checked whether it works. |
| High | Will cause a wrong or untrustworthy result during verification. |
| Medium | Real, not blocking, and needs a decision rather than only work. |
| Low | Known, recorded, safe to defer. |

## Critical

### C1. Handover is built but not connected to any user surface

**CLOSED 2026-09-21 by H06, commits `2926149..04dca86`. See the closed section at the foot of this file.**

TM4's engine is complete and tested at the server tier: capture, offer, discovery, accept, claim, the receiver's run, the capability matrix, return, review and apply.
Nothing connects it to a person.

Confirmed by the orchestrator, not inferred:

- `server/src/workspaceApi.ts` contains the string `handover` zero times, so there is no HTTP route.
- `server/src/integrations/telegram/runtime.ts` never calls `registerHandoverTapHandler`, so a Telegram tap on a handover card reaches nothing.
- Nothing schedules a control-record poll, so a receiver's workstation never discovers an offer.

So there is no button anywhere that reaches the engine.
A person cannot start, accept or apply a handover today.

H04 and H05 each found this independently and each flagged it rather than building it, which was right, because it was in neither card.
It was in no card at all, which is the process failure worth naming: the H track's five tasks were scoped as engine slices and none of them owned the surface.

### C2. Nothing has been run against the full test suite

**Status: part-advanced. V1 and V2 are done. V3, V4 and V5 are outstanding.**

V2 completed 2026-09-22 by the orchestrator, since F00B's proof runs had already produced most of it:

| V2 item | Result | Who ran it |
| --- | --- | --- |
| Full server suite | 417/417, three times against one unchanged root | orchestrator, independently |
| Full T1 suite | 127/127 three times (0 failed, 0 skipped, 0 flaky) | F00B worker; the orchestrator independently confirmed **one** full pass at `127 passed (24.8m)` |
| Typecheck | exit 0 across shared, server, web, e2e | orchestrator |
| Lint | exit 0, **0 errors**, 5 warnings | orchestrator |

Stated precisely, because the distinction matters to audit 3: the orchestrator re-ran the server suite three times itself, but confirmed only one of the three T1 passes itself.

The 5 lint warnings are all `@typescript-eslint/no-unused-vars` on underscore-prefixed parameters in `web/components/pipeline/PipelineHeader.tsx`.
That is Yousef's pipeline code, not Team code, and they are warnings rather than errors.
Silencing them means adding an `argsIgnorePattern` to `web/eslint.config.mjs`, which is a config change inside the diverged area of gap M-2, so it was flagged rather than taken.
The burn-ins, audit 3, audit 4 and the LT-4 re-run are all still outstanding.

**A constraint on what V3's burn-ins can claim, found by F00B.**
The T1 harness mints its own `AGENT_CONSOLE_REPO_ROOT` per run with `mkdtempSync(HARNESS_ROOT_PREFIX)` at `e2e/src/env/orchestrator.ts:145` and discards any root the caller sets.
So **a T1 burn-in cannot prove cross-run root pollution**: every repeat starts on a fresh root.
What it does cover is intra-file pollution, because the harness is shared across tests within a spec file at `workers: 1`, plus `dispose()`'s `realDatabaseHarnessRows` assertion that no harness row reached the real database.
V3 must be worded to that and no further. The server suite is the half where holding one root constant is meaningful, and F00B did that.

By jd's instruction of 2026-09-20, testing was parked while implementing.
Every task from F03 onward ran only its own narrow tests plus a composition set.

Not run once since: the full server suite, the full T1 suite, every burn-in, audit 3, audit 4 and the LT-4 re-run.

The risk jd accepted, restated: a regression introduced early is not found until Phase V, with later tasks stacked on top of it.
The mitigation is real - every task merged from its own branch by fast-forward, so Phase V can bisect by task - but until Phase V runs, **done means done by a task's own evidence, not proven harmless to everything else**.

## High

### H-1. A fixture breaks on its second run, and burn-ins re-run by definition

**CLOSED 2026-09-22 by F00B, commits `4070156..581aafd`. See the closed section at the foot of this file.**

### H-2. The three handover end-to-end rows have never run

**CLOSED 2026-09-21 by H06. All three now run and pass, verified independently by the orchestrator: `3 passed (2.9m)`. Their 9/9 burn-in is still owed to Phase V, which is C2, not this gap.**

`e2e/tests/t1/tm4-handover.spec.ts` carries TM-T1-H1, TM-T1-H2 and TM-T1-H3, every one `test.fixme`, so Playwright skips them silently.
They could not run: they need the surface C1 describes.

A skipped test nobody clears is exactly the defect shape this whole track burned down - a claim with no assertion behind it - so **Phase V is not finished while any of the three is still `fixme`**.

The unverified list is long and specific and is recorded in the tracker: delivered callback answers, the offline and renewal wordings, the 2.5 minute drop, the ten minute expiry, a mid-offer Team toggle, a workstation restarting mid-offer, the requirement question being delivered while the requester is stopped, D01, B28, and the transcript credential sweep.

### H-3. G02 still gates enabling handover

**Status: H-2's rows now pass, so the evidence exists. G02 closes when Phase V's burn-in confirms it holds at 3 repeats rather than once.**

The decision half is recorded: jd confirmed on 2026-09-20 that the roster is the trust boundary.
The evidence half now exists, because H04 built RTC-12's capability matrix and it passes at the server tier, covering within-limit, a grantable delta, a hard deny and unknown enforcement.

It is **not** recorded as closed, because the T1 rows that exercise that matrix end to end are the three unrun ones above.
Closing it on server-tier evidence alone would be the same shortcut the F track spent nine tasks undoing.

## Medium

### M-1. The two-person runs with Yousef have never happened

`H-TM-LT3` and `H-TM-LT4` need two people on two machines.
The solo pilot is explicitly not a substitute, so **TM3 is not honestly done** whatever the test counts say.
Outstanding since before this session; needs Yousef's time, not code.

### M-2. main and origin/main have genuinely diverged

`main` holds 270 commits that have never left this machine.
`origin/main` holds ten or more commits of Yousef's pipeline work that main does not have, including two merged pull requests.

Nothing was pushed from here, which the orchestrator verified: no commit of ours is reachable from any remote ref.
`origin/main` moved because a worker ran `git fetch --all`, a remote read, while the real remote had moved on.

This is jd's call and it is larger than the tracker's original "main is far ahead" note implied.

### M-3. Audit check D3 will fail for the wrong reason

Section 4.1 of [team-track-dev-brief.md](team-track-dev-brief.md) defines D3 as "Nothing was pushed: `origin/main` is still the starting commit recorded in the tracker".
That conflates two different facts, and M-2 has now separated them.

The honest check is that **no commit of ours is reachable from any remote ref**.
The orchestrator has not edited the audit checklist, because it is the auditor's instrument and jd's to change.

### M-4. Two handover rules are still unruled

Both are marked **Proposed** in [handover-rules.md](handover-rules.md) and were deliberately not put to jd with the other four.

- **4.3, the decline outcome.** Its text still offers the named-receiver alternative that ruling 1 abolished. The surface behaviour built in H04 is the open-call reading, and the orchestrator forbade the worker from expressing per-person decline as a record transition, so this is genuinely still open rather than quietly decided.
- **4.5, closing an item while a handover is live.** This one has teeth. Refusing to apply to a closed item is right and H05 built it, but the damage happens earlier: **closing an item while a receiver holds it or has already returned work discards that work with no path back**. That is a data-loss shape. Fixing it means touching the close path, which F02 owns and which has shipped.

### M-5. No npm script runs the Team web unit tests

F03's `web/components/tasks/teamThread.test.tsx` and F06's `web/components/agents/teamJoinCode.test.tsx` both exist and both pass.
Neither is in any npm script, so they run only when invoked by hand.

`web/package.json`'s `test:quota-ui` names four files explicitly and is cited by name in `human-verification.md` rows H-M2b-01 and H-M2d-04 with quota-specific expectations, so widening it silently would muddy recorded PASS rows.
Phase V should add a `test:web-ui` covering every `*.test.tsx`.

The assertions exist and nothing routine runs them, which is the brief's own section 7 trap one level up.

### M-6. Fixtures leak rows into the shared root, and one product lookup depends on row order

Found by F00B's row-count leak profile, which snapshots `COUNT(*)` per table between every server test file against one accumulating root.
None of these causes a failure today, proven by three per-file runs and three full-suite runs against one root, so none is a non-deterministic fixture **yet**.

| file | net rows left per run |
| --- | --- |
| `teamHandoverRun` | +57 `task_control_actor`, +25 `telegram_outbox`, +21 `telegram_thread` |
| `teamResultApply` | +20 actor, +9 outbox, +9 thread |
| `teamHandoverSurface` | +18 actor, +10 outbox, +6 thread |
| `telegramLiveRuntime` | +12 `team_roster`; also **deletes** 18 actor rows other files left |
| `startIntent` | +1 outbox, +1 thread, +1 workspace |
| `teamRoster`, `teamGrantCommands` | +1 `team_roster` each |

The concrete hazard is not the row counts, it is this: **`taskControl.ts:321` resolves a roster with `workspaces.teamRosters().find(...)` over all rows ordered by `updated_at DESC`.**
Leaked rosters sharing a `botId` are shadowed by the newest row today, but a same-millisecond `updated_at` tie makes that order undefined.
That is the same mechanism as the bug F00B fixed, one step removed, and it is in **product** code rather than test code.

F00B correctly did not expand scope to it: the fixtures it repaired could produce a false red, these cannot today.
Needs jd's decision on whether to take a follow-up task, because the honest fix is likely a tiebreak in the product lookup rather than more fixture cleanup.

## Low

| Id | Gap | Note |
| --- | --- | --- |
| L-1 | **F10, the pilot rig**: B3 wrong port silently, B4 credentials inherited from the shell, B10 the launcher cannot be stopped by script, B19 the two instances share one working tree | Rig only, no product code. Needed before LT-5 and nothing else. |
| L-2 | **G04's named fallback owner** | The orchestrator recorded Yousef as the only candidate in a two-person team and flagged it. jd has not confirmed the name. |
| L-3 | **Opening the same item twice mints a second item** | `createItemLink` is called again on a repeat open. Found by F03, not in B1 to B19, left alone as out of scope. Worth its own entry if it is real. |
| L-4 | **F03's two-width UI check cannot be re-run** | **Narrowed 2026-09-21 by H06**, which committed its own rig as `scripts/verify-handover-browser.mjs` with an npm script, so the practice is fixed going forward. F03's own control still has no committed rig. |
| L-5 | **F03's `409 prompt_already_complete` is untested at the HTTP tier** | The test drives the runtime directly and relies on the generic `WorkspaceError` handler every other route already uses. |
| L-6 | **F08's accepted trade** | An execute run that never ends leaves the anchor pinned and live rather than frozen and wrong. Judged the better failure and reversible if jd wants a bound. |
| L-7 | **H03 chose the handover context file path** | `.agent-console/handover.json`, inside the snapshot tree only, never in the developer's worktree. The worker's choice, not the design's. |
| L-8 | **H05's clean non-fast-forward merge is unreachable in one round** | Because the baseline gate is strict, an undiverged checkout always fast-forwards. The path exists and the merge probe exercises it; no fixture was contrived to reach it end to end. |
| L-9 | **`special_file` is a fourth capture refusal** | Implemented from protocol.md section 9; tm4's matrix names only three. Recorded rather than added to the table. |
| L-10 | **`h6-route-proxy.spec.ts:21` still cuts its call log by timestamp** | Same `call.at >= cutAt` shape F00B repaired in `l3F1.ts`. Left alone deliberately: the card records this file as already repaired under T20A, and re-cutting another task's repair with no failing symptom is churn. Residual risk flagged, not acted on. |
| L-11 | **F00B's `l3F1.ts` change is shared with T3 and was validated only on the T1 path** | `e2e/tests/t3/l3-f1-edits-live.spec.ts` imports the same helper and could not be run here, because T3 needs live Telegram credentials which are forbidden. The change is backend-agnostic (`telegramCalls()` returns an append-only array under both T1 and T3, so an index cut behaves identically), but it is untested on T3. |

## Closed while this register was open

### C1, the handover surface. Closed 2026-09-21 by H06, commits `2926149..04dca86`.

The engine now reaches a person. Six HTTP routes, a third runtime loop reading the shared ref namespace every 5 seconds so a receiver discovers an offer without being told to look, `registerHandoverTapHandler` finally called from `startSession`, the three handover cards rendered for Telegram, and a requester control on the work-item detail.

**The card named three missing joins and there were five.** Driving a real tap end to end found two more that no reading had caught: `formatTelegramMessage` had no case for any handover card, so every one would have failed delivery as an unsupported payload kind and no tap was ever possible; and the session's `TaskControlService` config never carried `handoverEnabled`, so the gate would have refused every tap even with the setting on. Both were inside C1's own sentence and neither was visible until something tried to use it.

**Two real defects were found by running the tests**, which is exactly why the task existed.

1. **An engine defect in H04**, fixed in its own commit `8062cb2`. `discoverHandoverOffer` deduped per bot and item with no regard to the epoch. Request changes opens a new epoch, so a bot that had ever posted a card for an item would never post another, and **every handover round after the first was undiscoverable by anyone**. It could not have passed at any tier. Dedupe is now per epoch, and a new epoch ends the spent round's undecided buttons while leaving a decided one alone, because a decided button is answered from its receipt rather than re-applied.
2. **A wiring defect**, fixed in `04dca86`. `runtime.handleCallbackResult` did not resolve the group actor for a handover action, so every handover tap was answered with a toast alone and nothing was written into the item's thread. D01's "the completion report is visible at once" could not have held.

### H-2, the three unrun rows. Closed 2026-09-21 by H06.

TM-T1-H1 27.5s, TM-T1-H2 1.7m, TM-T1-H3 43.6s. The orchestrator re-ran them rather than accepting the report: `3 passed (2.9m)`.

One fixture was corrected rather than one assertion weakened: TM-T1-H1's env A had to move off `main` before capture, because `main` is a protected product branch and this product never merges one automatically. The protected-branch refusal was already asserted at the server tier, so nothing lost coverage.

### L-4, F03's unreproducible two-width check. Closed 2026-09-21 by H06.

H06 committed its two-width rig as `scripts/verify-handover-browser.mjs` with an npm script rather than running it once and deleting it, which is the shape L-4 recorded as missing. F03's own control is still not covered by a committed rig, so L-4 is **narrowed, not fully closed**: the practice is fixed and F03's specific gap remains.

### H-1, the fixture that broke on its second run. Closed 2026-09-22 by F00B, commits `4070156..581aafd`.

Two non-deterministic fixtures repaired, both test-only, no product change.

1. **The known shared-state instance.** `telegramSupergroupMigration.test.ts` inserted `team_roster` rows under a fresh `teamId` but the same `group_chat_id` and never removed them, so the sighting count climbed on a second run against the same root. A `forgetTeamRoster` cleanup now runs in the `finally` block, so it holds even when the test fails partway.
2. **A second instance nobody knew about**, in `e2e/src/scenarios/l3F1.ts`, cases S-L3-F1-05, -10, -12 and -18. The Bot API call log was cut by `Date.now()` and filtered with `call.at >= since`, so a call made just before the boundary in the same millisecond was counted rather than excluded. The cut is now an index into the append-only log. **This is stricter than the timestamp it replaced, not looser**, and it follows an idiom already used elsewhere in the same file.

**The orchestrator re-ran every headline claim rather than accepting it**, and additionally ran a mutation: commenting out only the two `forgetTeamRoster(teamId)` calls restored the exact original failure (`# pass 4 / # fail 0`, then `not ok 2 ... # pass 3 / # fail 1` twice, same test name), which proves the fix is load-bearing rather than coincidental. The file was restored and the tree confirmed clean.

Verified totals: server suite 417/417 three times against one unchanged root; T1 `127 passed (24.8m)` with 0 failed, 0 skipped and 0 flaky, including all three TM-T1 handover rows; typecheck clean across four workspaces; diff confined to two test files; both team flags still `fallback: false`.

**No product defect was found.** All thirty T1 spec files ran and passed, including the twenty-one that had not run in the prior session, so the first-discovery risk F00B's card warned audit 3 about did not materialise.

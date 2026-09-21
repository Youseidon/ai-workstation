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

**Status: part-advanced. V1, V2 and V3 are done. V4 and V5 are outstanding.**

V3, the burn-ins, completed 2026-09-22: `tm3-grants.spec.ts` at `9 passed (7.0m)` and `tm4-handover.spec.ts` at `9 passed (8.8m)`, each scenario three times, zero flaky and zero retries.
The orchestrator re-ran the handover burn-in itself at `9 passed (10.0m)`.
Gap H-3 and G02 closed inside it.

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

**CLOSED 2026-09-22 by V3. See the closed section at the foot of this file.**

## Medium

### M-1. The two-person runs with Yousef have never happened

`H-TM-LT3` and `H-TM-LT4` need two people on two machines.
The solo pilot is explicitly not a substitute, so **TM3 is not honestly done** whatever the test counts say.
Outstanding since before this session; needs Yousef's time, not code.

### M-2. main and origin/main have genuinely diverged

**DECIDED 2026-09-22: keep it local. No push.**

jd's ruling: the Team work stays on this machine for now and `origin/main` is left untouched.
The standing no-push constraint therefore continues to hold, and the divergence remains a decision to revisit later rather than an open question.

The facts as verified on 2026-09-22: main holds **325** commits that have never left this machine, `origin/main` is at `4fd0e65` with 29 of Yousef's pipeline commits that main does not have, and `git branch -r --contains HEAD` returns **0**, so no commit of ours is reachable from any remote ref.

Recorded risk jd is accepting: the gap grows with every task, and a later reconcile gets harder the longer it waits.

### M-3. Audit check D3 will fail for the wrong reason

**DECIDED 2026-09-22: the auditors record both readings and the checklist is not edited.**

jd's ruling: V4's auditors run section 4 of [team-track-dev-brief.md](team-track-dev-brief.md) **unchanged**, and for D3 record **both** results:

- the **literal** check, `origin/main` still at the commit the tracker recorded: **FAIL**, because `origin/main` moved from `44ad588` to `4fd0e65` when a worker ran `git fetch --all` while the real remote had moved on.
- the **honest** check, that no commit of ours is reachable from any remote ref: **PASS**, `git branch -r --contains HEAD` returns 0.

Two further checks are known to mismatch how jd chose to run the work, and the auditors record the deviation rather than failing the work for it:

- **D1** requires every task to have its own worker agent id with no repeats. F00A, F04 and V2 were done by the orchestrator, by jd's own execution-model decision of 2026-09-20.
- **A4** requires LT-4 recorded with a date and outcome. LT-4 is deferred by operator instruction of 2026-09-18 pending Yousef (gap M-1), and V5's re-run is sequenced after V4 in any case.

The instrument stays the auditor's and jd's. Nothing in it was edited.

### M-4. Two handover rules are still unruled

**CLOSED 2026-09-22. Both halves ruled by jd; 4.3 by documentation and 4.5 by task H07.**

- **4.3, the decline outcome. Closed.** jd confirmed the **open-call reading**: a decline is recorded, the offer stays `OFFERED` for the rest of the roster, and a per-person decline is never expressed as a record transition. This matches the surface H04 already built, so it was a documentation correction. Recorded as ruling 6 in section 8 of [handover-rules.md](handover-rules.md).
- **4.5, closing an item while a handover is live. CLOSED 2026-09-22 by H07**, commits `d300b05..1f01acd`. jd ruled **refuse the close**. While a receiver holds the item, or has returned work that has not been applied, `/close` is rejected with a reason naming the live handover, and the owner must cancel the handover or apply the return first. Recorded as ruling 7. **This is the only ruling of the seven that requires a product change to already-shipped code**, on the close path F02 owns. Built and merged; see the closed section at the foot of this file.

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

### M-7. H04's `closeAfterHandover` contradicts ruling 7, and nothing owns the reconciliation

Found by H07 while building the close guard, and **correctly not fixed by it**.

`closeAfterHandover` at `server/src/teamHandoverRun.ts:972` permits a close in `OFFERED`, `WAITING_INPUT`, `PAUSED` and `RETURNED`.
Ruling 7 says all four are live and a close must be refused in every one of them.
The two disagree.

H07 tried applying the same `isLiveHandoverState` guard there and it broke an existing assertion: `teamHandoverRun.test.ts:955`, "the item closes once the receiver's own workstation has stopped and acknowledged", where `stop_proven` leaves the record in `PAUSED` and H04 reads an acknowledged stop as the end of the handover.
H07 reverted the attempt entirely rather than weaken that assertion, which was the right call, and the file is byte-identical to main and passes 34/34.

**Why it is not urgent**: `closeAfterHandover` has **no production caller**. The orchestrator verified this; the only references are its own definition and its own test, so no person can reach it today.
**Why it is not nothing**: the moment anyone wires it to a caller, ruling 7 is bypassed and the data-loss path H07 just closed reopens through a second door.

The real question is which reading is right, and it is a design question rather than a bug: does an acknowledged stop end the handover (H04), or is a stopped-but-unreturned item still held (ruling 7)? There is work on the branch in both readings.
Needs jd.

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

### H-3 and G02, the isolation evidence. Closed 2026-09-22 by V3.

G02's decision half was confirmed by jd on 2026-09-20; the evidence half is what was missing, and H-3 required it at **3 repeats rather than once**.

Both tiers now hold at three repeats:

| Tier | Evidence | Repeats |
| --- | --- | --- |
| T1, end to end | `TM-T1-H1` in the `tm4-handover.spec.ts` burn-in | 3, twice over: the V3 worker at `9 passed (8.8m)` and the orchestrator's own re-run at `9 passed (10.0m)`, both exit 0, 0 flaky, 0 retries |
| Server, the capability matrix | the four `RTC-12` rows at `server/src/teamHandoverRun.test.ts:496`, `:513`, `:525`, `:535`, plus `:565` that a hard denial cannot be overridden from Telegram | 3, against one unchanged root |

**The V3 worker flagged a scope gap rather than asserting G02 closed, and it was right to.**
It observed that `TM-T1-H1` exercises only the within-limit path end to end and does not itself enumerate the four matrix rows, and it declined to claim the server tier had run three times because that was outside what it had run.
It was mistaken only in believing the server tier had run once: V2's server suite ran **three times against one unchanged root** and `teamHandoverRun.test.ts` is matched by that glob, so the matrix rows were already inside all three passes.
The orchestrator did not rely on that inference and re-ran the four rows three times directly, plus the whole file at 34/34.

So the honest statement is: the receiver's own policy decides, proven end to end at 3 repeats for the runnable path, and proven row by row at 3 repeats at the server tier.
The two residual limits jd accepted on 2026-09-20 are unchanged and remain accepted: the `.env` bot token is readable by any same-user process, and accepting a handover means another member's code runs with your own credentials in the environment.
`TM-T1-H1:225-227` additionally asserts no credential reaches the transcript, which passed on all six repeats across the two burn-ins.

### M-4's rule 4.5, the close-path data loss. Closed 2026-09-22 by H07, commits `d300b05..1f01acd`.

`/close` is now refused while a handover is live, with a reason that names what is outstanding and what to do instead.
The guard stands **before** `revokeItemGrants` and `closeItemLink`, which is the whole point: H05's refusal to apply to a closed item was too late, because by then the grants were gone and the link shut.

Nine states refuse and five allow. `OFFERED` and `APPLYING` were the two judgement calls and H07 included both, taking the ruling's purpose over its narrowest wording: an open offer is a live invitation to do work that could then never be applied, and a half-finished apply is still unapplied.

**The orchestrator ran a mutation rather than trusting the tests.** Disabling only the guard reproduced the entire data-loss shape: the close applied while the record was `RETURNED`, the item closed, the receiver's grant was revoked, the apply was then refused forever, and `result.md` never reached the requester's checkout. Restored, and re-verified at 421/421 three times against one unchanged root, T1 at `127 passed (25.3m)`, typecheck clean on four workspaces.

Two limits recorded rather than hidden:

- The `/close` **text** command still mints its card and refuses on the tap, rather than refusing instead of the card. H07 chose one unbypassable guard over two that can diverge; making the text path refuse earlier means turning two handlers async. Cosmetic, and a small follow-up if jd wants it.
- **No T1 row covers this yet.** H07 judged one belongs, the phone-side "`/close` on the anchor while a teammate holds the item", and left it to Phase V rather than writing it unasked. V4's auditors should see it as a known gap in end-to-end coverage, not as covered.
- The guard is inert if `registerHandoverStateProbe` is never called. It is registered unconditionally in `startSession` beside the tap handler, which the orchestrator verified, so every real session has it; but it fails open rather than closed if a future path forgets.

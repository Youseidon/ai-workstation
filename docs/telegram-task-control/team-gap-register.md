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

**Superseded 2026-09-26.** The V2 table below records what was measured on 2026-09-22, before the reconcile `a641b0c`, and **none of its figures describes main today**.
The server bar is now **618**, not 417, and lint is **exit 1 with 17 errors and 2 warnings**, not exit 0 with 0 errors - which contradicted L-12 in this same file until this note was added.
Current figures, each measured independently by two auditors, are in `implementation.md` sections 6e and 6f.
The table is kept because audits 1 to 4 cite it.


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

### C3. Two Team surfaces still compare `operationalState` to `AWAITING_RESPONSE` by hand, and the merge moved that value

**Registered 2026-09-25. Found while closing audit 3's A1, not by any audit or any suite. Awaiting jd's decision; not yet reproduced end to end.**

This is the **fourth** defect of the M-9 family and it survived M-9's fix.

The mechanism, verified rather than inferred:

```
$ git show a641b0c^1:server/src/operationalState.ts   # ours, before the reconcile
  if(prompt.status==="BLOCKED")return "AWAITING_RESPONSE";

$ sed -n 47p server/src/operationalState.ts           # main today
  if(prompt.status==="BLOCKED")return "BLOCKED";
```

M-9 introduced `awaitsResponse(state)` for exactly this and converted the two consumers it found - the Telegram `blocked` view filter and the awaiting-items list.
**Two Team-owned consumers were not converted and still compare by hand.**

`pendingHumanQuestion` is the other half of the mechanism, and it is what makes the state reachable rather than theoretical.
It returns non-null only when a *handoff* record is READY and recommends `WAIT_FOR_HUMAN` (`server/src/workspaces.ts:4087-4095`).
The ordinary Team path does not go through a handoff: an agent posts `{"status":"BLOCKED","reason":...,"options":[...]}`, the options ride on the status (`workspaces.ts:2459`), and no handoff row is written.
So on the primary Team path `hasHumanQuestion` is false, `humanResponseHeld` is false, and `operationalState` returns **`BLOCKED`**.
The codebase already knows these are two independent ways an item can need input - `runService.ts:300` and `humanInput.ts:61` both test `status === "BLOCKED" || pendingHumanQuestion !== null` - which is why `awaitsResponse` exists.

| Surface | Line | What a person gets |
| --- | --- | --- |
| `/status` in a Team item thread | `server/src/teamItemViews.ts:169` | `Decision: none waiting` on a blocked task **while the owner's decision card is on their phone**. A teammate asking the thread what is happening is told nothing is waiting |
| F03's **Open Team thread** control | `web/components/tasks/TeamThreadPanel.tsx:25` | Disabled on exactly the blocked task a person would want to pull a teammate into, with self-contradicting text: *"A Team thread opens on a task that is awaiting a response. This one is Needs you."* - and "Needs you" is the label for blocked |

**Why every tier is green anyway.** This is the part to carry forward.

- `teamItemViews.ts:169`'s Decision line has **no test at any tier**. `grep -rn "Decision: waiting\|Decision: none\|awaitingDecision" server/ e2e/` returns the two source lines and nothing else.
- `teamThreadAvailability` **is** tested, and the test has a hole precisely where the merge moved the behaviour. `web/components/tasks/teamThread.test.tsx:30` asserts `AWAITING_RESPONSE` enables the control, then iterates a negative list of `WORKING`, `READY`, `RECOVERY_NEEDED`, `FAILED`, `WAITING_DEPENDENCY`, `DONE`, `SKIPPED`. **`BLOCKED` is in neither list**, because when the test was written `operationalState` could not return it. The test passes whichever way the gate behaves for the one state that now actually occurs.

So the full server suite at 618/618, the full T1 suite at 127/127, the web suite at 94/94, four clean typechecks and a fresh auditor's independent reproduction of all of it are all consistent with both of these being broken.

**What is not yet done**: neither has been reproduced end to end, which is the standard this track holds itself to and the reason M-9's defects were believed rather than argued.
Doing that needs a T1 case driving a blocked-without-handoff Team item, which no scenario currently does.
Whether to take that as a task, and whether the fix is `awaitsResponse` at these two sites plus a sweep of the remaining hand-written comparisons (`web/components/tasks/WorkItemDetail.tsx:245-249`, `web/components/HumanInputDialog.tsx:55`, `web/lib/humanInput.ts:7,11`, `web/components/pipeline/status.ts:161`, the last being upstream's), is jd's call.


**The task, carded 2026-09-26 on jd's ruling. Its own worker, its own branch, red at T1 first.**

| # | Acceptance criterion |
| --- | --- |
| 1 | **Red before anything is fixed.** A T1 case drives a Team item to a stored `BLOCKED` with options and **no handoff record**, and asserts both surfaces below. It fails on `a23d1dd` with no product change in the tree, and the failing output goes in the tests-only commit message so the reproduction is verifiable in the branch rather than described. |
| 2 | `/status` in that item's Team thread reports a decision waiting for the owner, not `Decision: none waiting`. |
| 3 | F03's **Open Team thread** control is enabled for that item, and its disabled reason never again tells a person that a task labelled "Needs you" is not awaiting a response. |
| 4 | Both sites ask `awaitsResponse` rather than comparing a state by hand: `server/src/teamItemViews.ts:169` and `web/components/tasks/TeamThreadPanel.tsx:25`. `awaitsResponse` already exists and already carries the comment explaining why; no second predicate is introduced. |
| 5 | **The hole that hid it is closed, not just the defect.** `web/components/tasks/teamThread.test.tsx`'s negative list is derived from `OPERATIONAL_STATES` rather than hand-written, so a state added or moved in the status model cannot again be absent from both the positive case and the negative list. |
| 6 | The full server suite and the full T1 suite are green at the end, with counts, and the T1 case from criterion 1 is among them. |
| 7 | The remaining hand-written comparisons are **listed in the report and not changed**: `web/components/tasks/WorkItemDetail.tsx:245-249`, `web/components/HumanInputDialog.tsx:55`, `web/lib/humanInput.ts:7,11` and `web/components/pipeline/status.ts:161`. The first three are personal-control surfaces, which invariant A5 says this track leaves unchanged, and the fourth is upstream's. Whether they are defects too is jd's call, and the report gives jd what it needs to make it. |

Scope note for whoever takes it: criterion 1 is the whole point of the task. The fix itself is two lines. If the T1 case cannot be made to fail before the fix, **stop and say so** rather than fixing on the strength of the code reading - that would be the same mistake as trusting a structural check.

### C4. H07's close guard is proven at the server tier only

**Registered 2026-09-26 from audit 4, which ranked it the one failure with product risk behind it. Its own task, by jd's ruling of 2026-09-26.**

H07 closed M-4's rule 4.5 by jd's ruling 7: `/close` is refused while a handover is live, so an owner cannot destroy a receiver's unreturned work.
That is the **data-loss** shape, and it is the only one of the seven rulings that needed a task rather than a document.

It has no end-to-end row. `grep -rn handover_live e2e/` is empty.
The guard's entire proof is the server tier.

This is the third time on this track that the same bet has been placed.
M-9 found three merge-introduced defects that every tier but T1 reported as fine.
C3 is a fourth, still open, found by reading rather than by any suite.
**The tier that would catch a regression here is the one tier this guard has never run in.**

The task: a T1 row that drives a live handover and asserts the close is refused, with the reason naming the handover, through the surface a person actually uses.


**The task, carded 2026-09-26. Its own worker, its own branch.**

Note first that this is a **deferred item coming due, not an oversight**. H07 judged that a T1 row belonged and said so at the time, leaving it to Phase V rather than writing it unasked, and its report told V4's auditors to treat the guard as a known end-to-end gap rather than as covered. Audit 4 did exactly that. Phase V is now where it is owed.

| # | Acceptance criterion |
| --- | --- |
| 1 | A T1 row drives a **live handover** and asserts `/close` is refused, with the refusal naming the live handover, **through the surface a person actually uses** rather than by calling the guard. |
| 2 | **The row is proven load-bearing by mutation**, which is this track's substitute for red-first when the code is already correct: disable the guard alone, show the new row goes red, restore it and show it green, and put both outputs in the commit message. F00B did this for its fixture fix and it is the reason that fix was believed. **A new test that has never failed proves nothing.** |
| 3 | **Both `/close` paths are covered.** H07 recorded that the **text** command still mints its card and refuses on the tap rather than instead of the card, because refusing earlier meant turning two handlers async, and it chose one unbypassable guard over two that can diverge. That is a deliberate design, not a defect: assert what it actually does on both paths rather than asserting the tidier behaviour. |
| 4 | Full server suite and full T1 green at the end, with counts, the new row among them. |
| 5 | **Do not change the guard.** If driving it end to end reveals a behaviour difference from the server-tier tests, **report it and stop** - that is a finding, and deciding what the app should do is jd's. The one thing this task must not do is adjust product behaviour to make a new test pass. |

### C5. The requester's web handover surface has no end-to-end proof it is wired

**Registered 2026-09-26 from audit 4. Its own task, by jd's ruling of 2026-09-26.**

The TM4 end-to-end spec proves the **Telegram** surface and only that surface.
`e2e/tests/t1/tm4-handover.spec.ts` publishes over HTTP and then drives real taps, but it **never opens a browser**: `grep -nE "page\.|browser|goto|locator"` on the spec returns nothing.

So `HandoverControl.tsx`, the control a requester uses to start a handover from the web app, has no end-to-end evidence that it is wired to the routes it calls.
What it has is a props-rendered React test and the two-width rig, and the rig renders the component in isolation with a CSS shim rather than the real Next.js page.

**This is precisely the claim gap C1 was about.** C1 was that the handover engine reached no user surface at all; H06 built the surface and closed it. What was never established is that the *web* half of that surface is connected, as opposed to present - and "present" and "wired" are different claims, which is the M-9 lesson in one line.

The task: a T1 row that drives the requester's handover from the real page.


**The task, carded 2026-09-26. Its own worker, its own branch. Sized larger than C4.**

| # | Acceptance criterion |
| --- | --- |
| 1 | A T1 row drives the requester's handover **from the real page in a real browser**, not from props. The existing TM4 spec never opens one, so this is new capability in the handover spec rather than an added assertion. |
| 2 | It asserts the **effect**, not the render: the offer reaches the control record and the routes actually fire. A test that proves the button exists would restate the evidence that already exists and close nothing. |
| 3 | **Proven load-bearing by mutation**, as C4: break the control's wiring to its route alone, show the row goes red, restore and show green, both outputs in the commit message. This is the whole point of the task - C1 was "present but not wired", and only a test that fails when the wiring breaks can tell those apart. |
| 4 | Full server suite and full T1 green at the end, with counts. |
| 5 | **Report what is still not covered when you are done.** Driving one page does not make the web surface proven; say plainly which paths remain evidenced only by props-rendered tests and the two-width rig, so the next reader does not over-read this row the way `9 passed` on the TM4 burn-in can be over-read. |
| 6 | If this turns out to need more than one row, or the harness cannot drive the page without new fixtures, **say so and stop** rather than growing the task silently. The size was flagged at carding and a bigger shape is jd's call. |

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

**CLOSED 2026-09-22 by the reconcile `a641b0c`.** main is now 331 ahead of `origin/main` and **0 behind**.
The divergence is gone; what it left behind is **M-8**.
Still nothing pushed, and `git branch -r --contains HEAD` is still empty, so the no-remote-write constraint is untouched - jd's "keep it local" ruling of 2026-09-22 covered pushing, and reconciling locally does not reverse it.

The history below is kept because the audits cite it.

**Superseded ruling of 2026-09-22: keep it local. No push.**

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

Three further mismatches are consequences of jd's 2026-09-22 decision to reconcile before auditing, and are recorded rather than failed:

- **D2** is no longer "is the range linear". `git log --merges dc3e9de..main` returns **three** commits, not the one jd anticipated: the reconcile `a641b0c`, plus `b855ec2` and `fa92586`, which are Yousef's own pull-request merges and arrived inside his 29 commits. Record the honest reading: **no merge commit is a task landing**, every task still landed by fast-forward.
- **D9** must account for **29 commits owned by no tracker row**. They are Yousef's, were never claimed by this track, and are out of range rather than unexplained. The check that still bites is that no commit *of ours* in the range lacks a row.
- **A2 and A3** must cite the post-merge numbers. ~~server 486/617 ... 17 errors and 11 warnings ... V4 is blocked on M-8~~ **All three superseded; corrected 2026-09-26 after audit 4 found this entry still carrying them.** M-8 is closed, the server bar is **618**, lint is **17 errors and 2 warnings**, and every tier A2 names is green on main except lint. The attribution of the errors to upstream stands unchanged.

Also for the auditors: H07's close guard has **server-tier proof only and no T1 row**, so treat it as a known end-to-end coverage gap rather than as covered.



### M-4. Two handover rules are still unruled

**CLOSED 2026-09-22. Both halves ruled by jd; 4.3 by documentation and 4.5 by task H07.**

- **4.3, the decline outcome. Closed.** jd confirmed the **open-call reading**: a decline is recorded, the offer stays `OFFERED` for the rest of the roster, and a per-person decline is never expressed as a record transition. This matches the surface H04 already built, so it was a documentation correction. Recorded as ruling 6 in section 8 of [handover-rules.md](handover-rules.md).
- **4.5, closing an item while a handover is live. CLOSED 2026-09-22 by H07**, commits `d300b05..1f01acd`. jd ruled **refuse the close**. While a receiver holds the item, or has returned work that has not been applied, `/close` is rejected with a reason naming the live handover, and the owner must cancel the handover or apply the return first. Recorded as ruling 7. **This is the only ruling of the seven that requires a product change to already-shipped code**, on the close path F02 owns. Built and merged; see the closed section at the foot of this file.

### M-5. No npm script runs the Team web unit tests

**CLOSED 2026-09-25 by task M9, commit `b943650`, on jd's decision to widen it now rather than after V4.**
`npm run test --workspace web` covers both trees, 65 tests to **94**, and `test:web-ui` names the component tests alone. `test:quota-ui` keeps its four files exactly as `human-verification.md` cites them, so no recorded PASS row changes meaning.
Widening found one red, **red since the merge and in `test:quota-ui`, the script the verification rows cite as passing**: it was 13 of 14. The tasks detail gained the definition-of-done panel, which raises toasts, so rendering it outside a `ToastProvider` throws where the app always supplies one at `app/layout.tsx:46`. A stale test, not a defect: it renders in the app's context now, with no assertion changed.


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

### M-8. Upstream's run lifecycle contradicts Team's verified expectations

**CLOSED 2026-09-25 by task M8, landed on main at `094542e`.**
The server suite is **617 of 617**, run three times against one unchanged root, and all four workspaces typecheck.
Every one of the ten remaining failures was classified as a stale fixture, a stale assertion or a real defect, with the reasoning in the tracker's log and in each commit message.
Four merge-introduced product defects were fixed under jd's ruling of 2026-09-25: the Telegram card's flowchart position, the dropped `terminalStatusApplyFailure` reason, the deleted Task Control section on the Agents page, and `AWAITING_RESPONSE` carrying no precedence.
**The Resume button was investigated to jd's instruction and is not broken**; the two end-to-end fixtures described a rail the app can no longer build, and the detail is in the tracker's log of 2026-09-25.
What M-8 did **not** close is the end-to-end tier, which is now **M-9**.

The history below is kept because the audits cite it.

Found by the reconcile `a641b0c`, and the reason the server suite is **486 of 617** on the merged tree.

This is not a merge resolution error, and it is worth being precise about that.
Yousef deliberately changed what happens when a run ends without posting a status.
`applyEndOfRunStatus` now writes `to: decision.to ?? "UNREPORTED"`, where this side wrote `BLOCKED`, and every status write goes through a `writeStatus` choke point with a `recoverableBlocker` refusal in front of it.
His reasoning is recorded in his own comments and is sound: a bare fall-through to `FAILED` meant nothing ever *decided* an item had failed, and "the run said nothing" was indistinguishable from "the process failed".

Team's fixtures encode the old behaviour.
`humanInput`'s fixture is the clearest case: it called `finishAgentRun` and relied on the prompt becoming `BLOCKED` so a human could answer it.
Posting the block explicitly took that file from 0 of 11 to 3 of 11, which confirms the mechanism but leaves the rest as genuine disagreements about what the app should do.

The 131 failures by file: `telegramLiveRuntime` 26, `teamHandoverRun` 23, `telegramSummary` 17, `pipelineScheduler` 11, `teamResultApply` 10, `humanInput` 8, `taskControl` 5, `teamControlRecord` 4, `teamHandoverSurface` 3, `teamHandoverCapture` 3, `runService` 3, `agentProgressTools` 3, `workspaceApi` 2, `teamItems` 2, and single failures elsewhere.

**Why this is not merge work.** Resolving it means deciding, case by case, whether the Team assertion or Yousef's new lifecycle is correct, across F01 to F09 and H01 to H07 - the exact behaviour Phase V certified at 421/421.
That is re-verification of the Team track against a changed platform, and doing it inline would quietly rewrite evidence jd has already signed off.

**jd's decision of 2026-09-22**: scope it as its own task with its own worker and branch, red-first, with evidence per case, rather than have the orchestrator make 128 semantic calls unreviewed.
**V4 and V5 are blocked on it**, because an audit is worth what the tree it audits is worth.

### M-9. The end-to-end tier has never been reconciled with upstream's agent prompt

**CLOSED 2026-09-25 by task M9, eight commits, `56d241c..b943650`.**
The **full T1 suite is 127 of 127** in 24.4 minutes, the first green pass since the reconcile.
The server suite is **618 of 618 three times against one unchanged root** (617 plus one new test), shared 91 of 91, the web suite **94 of 94** now that the component tests run, all four workspaces typecheck, and web lint is unchanged at 17 errors.
**The five failures this entry listed as untraced needed nothing of their own**: `S-L3-B-02` was a stale count, and `S-H4-02`, `S-L1-17`, `S-H6-21` and `S-L3-C1-10` went green with the product fixes below. Nothing was left unexplained.

**The cause was not the fake provider.** The fake was a symptom. `startExecute` carried two prompt builders after the merge - ours, choosing between bound tools, the launcher and the offline protocol, and upstream's, inlining the context unconditionally - and upstream's came second and overwrote the choice.

Three product defects, all merge-introduced, all invisible to every tier but T1:

| Defect | What a user got | Where |
| --- | --- | --- |
| Two prompt builders, upstream's overwriting ours | On default settings - Host access off, Grok sandboxed - a saved-task run's only channel was a launcher its sandbox cannot reach, so the run ended UNREPORTED with the work possibly done | `runService.ts`, now `executeChannel` |
| The launcher dropped the `options` a BLOCKED status carries | The phone's decision card offered nothing to choose between, and nothing downstream invents them | `agent-step blocked --options-file` |
| `BLOCKED` stopped reading as awaiting a response | **No blocked task's question card reached the phone at all, and no blocked task appeared in any list.** The feature's primary path | `operationalState.ts`, now `awaitsResponse` |

The third is the one to remember. A work item waiting on a person has two spellings in the status model - `BLOCKED`, stored and labelled "Needs you", and `AWAITING_RESPONSE`, the live overlay the model documents as an alias of it. Ours returned the overlay; upstream's returns the stored name. Neither is wrong, which is exactly why a merge could swap them silently, and the Telegram layer keyed on the overlay in two places. jd confirmed on 2026-09-25 that a blocked task's card reaching the phone is the intended purpose, so it was repaired rather than accepted.

Four stale fixtures and one set of stale assertions, each classified rather than adjusted until green:

| What | Class |
| --- | --- |
| The fake recognised a run by a curl line and the offline heading, neither of which the prompt has carried since the reconcile | Stale fixture |
| `/api/sessions` ships no transcripts, so a run's events read as empty and S-H2-10 could not see a SIGKILL that was in the database | Stale fixture |
| `S-L1-21` and `S-L3-A-13` built pipelines through routes that moved onto named pipelines, and died on a 404 in setup | Stale fixture |
| `S-L3-B-02` counted one spelling of blocked, expecting 0 from a card that correctly said 1 | Stale fixture |
| A failed run is FAILED and a silent one UNREPORTED, not BLOCKED: `S-H2-06`, `S-H2-09`, `S-H2-10`, `S-H2-12` and their scenario rows | Stale assertion |

**What the H2 scenarios now assert, by jd's decision of 2026-09-25.**
`S-H2-04` asserted a context fetch and "HTTP to 4100 only" from a curl the product gives nobody, and the launcher makes that call from a child process. It now asserts what is honestly observable: the launcher was minted for this run, the fake ran it for the remark and for DONE and called nothing itself, and the console's record for the run is exactly those two calls. The fake logs each call before making it, because the console ends the provider the moment a terminal status lands - a fake that logged only results had no record of the one call that mattered. `S-H2-07` keeps its claim, which the restored offline channel makes literally true: no launcher, no token, nothing run and nothing called.

**Two findings worth carrying**, neither a T1 failure:

- `views.ts` held a raw 0x00 and 0x1f where `[\x00-\x1f]` was meant. The regex behaved identically, so nothing failed - but the NUL made every tool treat the file as binary, and grep reports *no matches* in a binary file rather than saying it skipped it. Searching that file for a symbol returned nothing at all, which is how an auditor concludes a mapping does not exist. It is ours and predates the merge. Fixed in its own commit, `29a2c57`.
- **`S-CLT-02` is now stale and was deliberately left alone.** It asserts a real Claude run calls `get_context`, which inlined context makes optional rather than required. That scenario needs a paid provider, so it cannot be run or verified here, and an assertion nobody can test is not one to adjust on reasoning alone. Recorded for whenever a paid run is authorised.

Found on 2026-09-25 by running the full T1 suite for the first time since the reconcile, as part of M-8's own done criteria.
**20 passed, 57 failed, 50 did not run.**
Nobody had measured this tier after the merge: the handover's state table reports the server suite, typecheck and lint, and says nothing about T1.

Two causes account for nearly all of it, and one is already fixed.

**Fixed inside M-8**: the merge had deleted the Task Control section from the Agents page, leaving `TelegramSetupPanel`, `TeamStatusPanel`, `TeamCreatePanel` and `TeamJoinPanel` imported and rendered nowhere.
Nine T1 specs went green when it was restored.

**Still open, and the substance of M-9**: upstream rewrote the saved-task execute prompt.
The work-item context is now **inlined** in the prompt rather than fetched, and the Progress API is reached through a generated **shim** invoked as `"<shimPath>" done --verification ...` rather than through a `curl -H 'Authorization: Bearer ...' .../context` line the prompt carries.
The T1 fake provider recognises a run by that `curl` line and by the `## Offline completion reporting` heading, so every run now falls through to its `custom` path, reads **0 characters of context**, and fails.
Verified directly by logging the prompt the fake received: 3080 characters, beginning `# Execute saved work item`, with the context inlined and no `curl` anywhere.

**Why this is its own task and not more of M-8.**
It is a second reconciliation of comparable size against a different surface, and it is not the run lifecycle.
The fake has to be taught the new shape, and the H2 scenarios have to be re-decided rather than re-pointed: "makes no HTTP call" and "posts DONE over HTTP to 4100 only" describe a `curl` the product no longer tells any agent to use, and the shim makes that call from a child process instead.
That is a judgement about what those scenarios are for, which is the kind of call that belongs in a task with its own card.

**jd's decision of 2026-09-25**: land M-8 on the server tier's evidence and register this separately, rather than bundle the two.

**V4 is blocked on M-9**, for the reason V4 was blocked on M-8: an audit is worth what the tree it audits is worth, and check A2 requires the full T1 suite to pass.

Known to be in scope, beyond the fake itself: `l3-b-views` `/status` counts, `h4-time-seams` S-H4-02, `h6-route-proxy` S-L1-17, `h6-stale-updates` S-H6-21 and `l3-c1-threads` S-L3-C1-10 all failed and have not been traced to either cause yet.
The 50 that did not run are serial-dependent on a failure earlier in their file, so the true count is higher than 57.

### M-11. A thread closed on a still-blocked task keeps its pinned anchor forever

**Registered 2026-09-25, closing the F02 half of audit 3's A1. Found by audit 3, whose finding 1 is that this file - the answer to "what is left" - had no row for it.**

F02's acceptance criteria included *"retire and unpin the anchor the way completion does"*.
It was deliberately not done, and the reason is good: retiring the anchor makes the thread unroutable, so a closed-but-blocked item would lose the only surface a person could reach it through.
The bug log says so at the top of the B17 entry and in its header line.

What nothing recorded is the consequence, which audit 3 verified in the code and the orchestrator confirmed:

- `syncTeamItem` returns early for a closed link (`server/src/integrations/telegram/runtime.ts:1274`), so a closed item's anchor is never re-rendered.
- `finishCompletedTeamItems` only ever reaches a `DONE` or `SKIPPED` prompt (`runtime.ts:1321`), so it can never reach a closed-but-blocked item.

So the pinned anchor stays in the group indefinitely, showing a state the task left behind.
Meanwhile `e47becc`'s commit message and the tracker both say "B1 to B19 are now all closed, deferred or pointed elsewhere", which is the sentence a later reader would trust.

**What this needs is a decision, not obviously a fix.**
Either a task owns the unpin and settles what a closed-but-blocked thread should look like, or this entry stands as the accepted trade with the bug log's reason.
jd waived audit 3's A1 on 2026-09-25 with this recorded; the waiver is in the tracker.

### M-10. F05's supergroup upgrade has no harness case, and had two invented scenario ids

**Registered 2026-09-25 on jd's ruling, closing the F05 half of audit 3's A1.**

F05's third acceptance criterion reads: *"A harness case upgrades a group mid-test and shows the next anchor delivered to the new id with no manual repair."*
It was not delivered, and it cannot be delivered without new work: **the e2e fake cannot upgrade a group at all.**
`grep -rn "upgradeToSupergroup\|migrate_to_chat_id" e2e/src` returns nothing.

What exists instead is the T0 half, two runtime cases in `server/test/telegramLiveRuntime.test.ts`: the refusal-carried `migrate_to_chat_id`, and the `migrate_from_chat_id` service message.
Both pass. Both are honest work at a lower tier.
Neither proves the repaired anchor reaches a phone, which is the criterion's actual subject.

**The ids were the sharper half of this, and they are retired.**
The two cases were named `TM-T1-8` and `TM-T1-9`.
Neither id exists in any scenario table, in the plan, or in any T1 spec: `grep -rho "TM-T1-[0-9A-Za-z]*" docs/ | sort -u` lists 1, 1a, 1b, 2 to 7, H1 to H3 and the template `TM-T1-n`, and nothing else.
An invented id in a test name is worse than a gap, because a later reader greps for coverage and finds it.
Audit 3 caught `TM-T1-8`; `TM-T1-9` was the same defect in the adjacent test and was found here.
Both now read `B8 (T0)`, the bug-log id the rest of the F track uses in that same file, and the block above them says in the source what has no T1 row and why.

**Why this is Medium and not Low.**
Audit 3 ranked it first of A1's five criteria for product risk, and the risk is coverage rather than a known defect: the supergroup upgrade is one of the two defects [team-burndown-dev-brief.md](team-burndown-dev-brief.md) calls unrecoverable from inside the app, `docs/e2e-scenarios/tm4.md:66` now treats F05's behaviour as load-bearing for the H track, and M-9 had just finished demonstrating what a tier gap hides - three merge-introduced defects that every tier but T1 reported as fine.

**What is still open**, and is the decision this entry holds: whether to teach the e2e fake to upgrade a group and write the real T1 case.
The brief sized that as large ("needs the fake to model a supergroup upgrade mid-test, which no scenario does yet").
jd's ruling of 2026-09-25 was to register the deviation and retire the ids now, not to build it.
Until it is built, **F05's third criterion is unmet and recorded as unmet**, rather than covered by a test that was named as though it were.

## Low

| Id | Gap | Note |
| --- | --- | --- |
| L-1 | **F10, the pilot rig**: B3 wrong port silently, B4 credentials inherited from the shell, B10 the launcher cannot be stopped by script, B19 the two instances share one working tree | Rig only, no product code. Needed before LT-5 and nothing else. |
| L-2 | **G04's named fallback owner** | The orchestrator recorded Yousef as the only candidate in a two-person team and flagged it. jd has not confirmed the name. |
| L-3 | **Opening the same item twice mints a second item** | `createItemLink` is called again on a repeat open. Found by F03, not in B1 to B19, left alone as out of scope. Worth its own entry if it is real. |
| L-4 | **F03's and F06's two-width UI checks cannot be re-run** | **Narrowed 2026-09-21 by H06**, which committed its own rig as `scripts/verify-handover-browser.mjs` with an npm script, so the practice is fixed going forward. Neither F03's control nor F06's has a committed rig. **Widened 2026-09-25 to name F06**, which audit 3 found has the identical unreproducible criterion while only F03 was recorded; the only committed width rigs are `scripts/verify-m4-browser.mjs` and `scripts/verify-handover-browser.mjs`, both at 390px and 1280px, and neither touches `TeamStatusPanel`. Both halves are covered by jd's waiver of audit 3's A1, 2026-09-25. |
| L-5 | **F03's `409 prompt_already_complete` is untested at the HTTP tier, and its UI is stricter than its API** | The test drives the runtime directly and relies on the generic `WorkspaceError` handler every other route already uses. **Second half added 2026-09-25**, found by audit 3's finding 7: F03's row records both limits but only the first was registered. The panel enables the control on `AWAITING_RESPONSE` alone (`web/components/tasks/TeamThreadPanel.tsx:25`) while the route refuses only `DONE` and `SKIPPED`, so the UI forbids openings the API would allow. **This stopped being harmless at the reconcile and is now gap C3**, because `operationalState` no longer returns `AWAITING_RESPONSE` for a stored `BLOCKED` item. |
| L-6 | **F08's accepted trade** | An execute run that never ends leaves the anchor pinned and live rather than frozen and wrong. Judged the better failure and reversible if jd wants a bound. |
| L-7 | **H03 chose the handover context file path** | `.agent-console/handover.json`, inside the snapshot tree only, never in the developer's worktree. The worker's choice, not the design's. |
| L-8 | **H05's clean non-fast-forward merge is unreachable in one round** | Because the baseline gate is strict, an undiverged checkout always fast-forwards. The path exists and the merge probe exercises it; no fixture was contrived to reach it end to end. |
| L-9 | **`special_file` is a fourth capture refusal** | Implemented from protocol.md section 9; tm4's matrix names only three. Recorded rather than added to the table. |
| L-10 | **`h6-route-proxy.spec.ts:21` still cuts its call log by timestamp** | Same `call.at >= cutAt` shape F00B repaired in `l3F1.ts`. Left alone deliberately: the card records this file as already repaired under T20A, and re-cutting another task's repair with no failing symptom is churn. Residual risk flagged, not acted on. |
| L-11 | **F00B's `l3F1.ts` change is shared with T3 and was validated only on the T1 path** | `e2e/tests/t3/l3-f1-edits-live.spec.ts` imports the same helper and could not be run here, because T3 needs live Telegram credentials which are forbidden. The change is backend-agnostic (`telegramCalls()` returns an append-only array under both T1 and T3, so an index cut behaves identically), but it is untested on T3. |
| L-12 | **main carries `origin/main`'s 17 lint errors** | The `web` workspace lints at **19 problems, 17 errors and 2 warnings**, exit 1, and every error is in upstream's own files: 1 under `components/activity/`, 13 under `components/pipeline/` and 3 in `components/programs/ProgramDraftPanel.tsx`, whose only two commits are upstream's. `origin/main` does not pass lint either, and the F-track files lint clean on their own (`npx eslint components/tasks/TeamThreadPanel.tsx components/agents/TeamStatusPanel.tsx components/tasks/WorkItemDetail.tsx lib/workspacesApi.ts` is exit 0, no output). This is what audit 3 recorded as A2 FAIL on the lint tier, and **jd waived it on 2026-09-25**; nothing in the Team track can close it. Registered here so that no later claim of a green lint tier can be made by omission. |
| L-13 | **The `e2e` workspace's own test suite is in no tier any check names, and showed one failure nobody could name** | `npm run test --workspace e2e` is not in the root `npm test` and is not among the tiers A2 lists, so nothing routine runs it. Audit 4 saw it give `# pass 46 # fail 1` on a first invocation and 47/47 on seven consecutive re-runs, and could not recover the failing test's name because that run's output was filtered to summary lines. **Recorded as unverifiable rather than passed or failed**, which was the right call. These files are harness self-tests that start real servers, so a real failure here would be a failure of the instrument the whole track's evidence rests on. Registered 2026-09-26. **Seen a second time the same day, by the C3 worker, independently and on a different tree**: one failure on a first invocation, then 47/47 on three consecutive re-runs, and it also lost the failing test's name. **Two independent sightings is no longer a one-off.** Neither observer could name the test, and both lost it the same way - a first run filtered to summary lines - which is itself the lesson: capture full output on a first run of an unfamiliar suite. The C3 worker's guess was a port left in `TIME_WAIT` by a T1 run that finished about two minutes earlier, since these selftests boot harness environments on fixed ports; it offered that as a guess and did not claim it, and it is not confirmed. **What makes this worth a task rather than a note**: it is intermittent, it is in the instrument rather than the product, and nothing routine runs it, so its failure rate is unmeasured. |
| L-14 | **Two record leftovers audit 4 found** | TM4's `LT-5` has no row in [human-verification.md](human-verification.md) at all - not even one recording that it is blocked on F10 - while `LT-3` and `LT-4` each got a deferral row. Separately, H02's migration is **52** after the reconcile renumbered it, but the table it rebuilds is still named `task_control_action_v29` (`server/src/workspaces.ts:1763`) and its error string still reads "Migration 29" (`:1797`). Both are cosmetic - the internal temp-table name is invisible to users and the migration runs correctly - but the second will read as a contradiction to the next person who greps for migration numbers. Registered 2026-09-26. |

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

### L-4, the unreproducible two-width checks. Narrowed 2026-09-21 by H06, not closed.

H06 committed its two-width rig as `scripts/verify-handover-browser.mjs` with an npm script rather than running it once and deleting it, which is the shape L-4 recorded as missing. Neither F03's control nor F06's is covered by a committed rig, so L-4 is **narrowed, not fully closed**: the practice is fixed and the two specific gaps remain, which is why L-4 is still listed as open in the Low band above. The heading of this entry read "Closed" until 2026-09-25 while its own body said otherwise, which audit 3's finding 5 caught: a reader scanning headings got the wrong answer.

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

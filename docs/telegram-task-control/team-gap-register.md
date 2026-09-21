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

**Status: being fixed, task H06.**

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

**Status: Phase V, starting after H06.**

By jd's instruction of 2026-09-20, testing was parked while implementing.
Every task from F03 onward ran only its own narrow tests plus a composition set.

Not run once since: the full server suite, the full T1 suite, every burn-in, audit 3, audit 4 and the LT-4 re-run.

The risk jd accepted, restated: a regression introduced early is not found until Phase V, with later tasks stacked on top of it.
The mitigation is real - every task merged from its own branch by fast-forward, so Phase V can bisect by task - but until Phase V runs, **done means done by a task's own evidence, not proven harmless to everything else**.

## High

### H-1. A fixture breaks on its second run, and burn-ins re-run by definition

**Status: F00B, which is V1, the first thing in Phase V.**

`server/src/telegramSupergroupMigration.test.ts`, the case "the rewrite moves every place the old team chat id lives", passes 4/4 against a clean `AGENT_CONSOLE_REPO_ROOT` and then fails 3/4 against the same root.
Its fixture inserts a `team_roster` row under a fresh team id but the same group chat id and never removes it, so the sighting count climbs.

This is shared-state pollution, not the wall-clock fragility F00B was originally written for, and **F00B's original wording did not cover it**.
F00B has been widened to both kinds and its proof changed to three runs **against one unchanged root**, because three runs against three fresh roots would not have caught this at all.

It arrived in F05 and the orchestrator's verification missed it by using a fresh root each time.

### H-2. The three handover end-to-end rows have never run

**Status: unblocked by H06, then run in Phase V.**

`e2e/tests/t1/tm4-handover.spec.ts` carries TM-T1-H1, TM-T1-H2 and TM-T1-H3, every one `test.fixme`, so Playwright skips them silently.
They could not run: they need the surface C1 describes.

A skipped test nobody clears is exactly the defect shape this whole track burned down - a claim with no assertion behind it - so **Phase V is not finished while any of the three is still `fixme`**.

The unverified list is long and specific and is recorded in the tracker: delivered callback answers, the offline and renewal wordings, the 2.5 minute drop, the ten minute expiry, a mid-offer Team toggle, a workstation restarting mid-offer, the requirement question being delivered while the requester is stopped, D01, B28, and the transcript credential sweep.

### H-3. G02 still gates enabling handover

**Status: closes when H-2's rows pass.**

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

## Low

| Id | Gap | Note |
| --- | --- | --- |
| L-1 | **F10, the pilot rig**: B3 wrong port silently, B4 credentials inherited from the shell, B10 the launcher cannot be stopped by script, B19 the two instances share one working tree | Rig only, no product code. Needed before LT-5 and nothing else. |
| L-2 | **G04's named fallback owner** | The orchestrator recorded Yousef as the only candidate in a two-person team and flagged it. jd has not confirmed the name. |
| L-3 | **Opening the same item twice mints a second item** | `createItemLink` is called again on a repeat open. Found by F03, not in B1 to B19, left alone as out of scope. Worth its own entry if it is real. |
| L-4 | **F03's two-width UI check cannot be re-run** | The worker ran a headless fixture at 390px and 1280px and then deleted it rather than committing a rig script. The evidence was observed; it is not reproducible. |
| L-5 | **F03's `409 prompt_already_complete` is untested at the HTTP tier** | The test drives the runtime directly and relies on the generic `WorkspaceError` handler every other route already uses. |
| L-6 | **F08's accepted trade** | An execute run that never ends leaves the anchor pinned and live rather than frozen and wrong. Judged the better failure and reversible if jd wants a bound. |
| L-7 | **H03 chose the handover context file path** | `.agent-console/handover.json`, inside the snapshot tree only, never in the developer's worktree. The worker's choice, not the design's. |
| L-8 | **H05's clean non-fast-forward merge is unreachable in one round** | Because the baseline gate is strict, an undiverged checkout always fast-forwards. The path exists and the merge probe exercises it; no fixture was contrived to reach it end to end. |
| L-9 | **`special_file` is a fourth capture refusal** | Implemented from protocol.md section 9; tm4's matrix names only three. Recorded rather than added to the table. |

## Closed while this register was open

Nothing yet.
Entries move here with the task and commits that closed them, so the register shrinks visibly rather than being rewritten.

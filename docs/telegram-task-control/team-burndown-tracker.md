# Team burn-down tracker

Created: 2026-09-20

## Start here

Read this file, then [team-burndown-dev-brief.md](team-burndown-dev-brief.md) sections 2.1, 3, 6 and 7, then the open entries of [pilot-bug-log.md](pilot-bug-log.md).
A fixed entry says so at the top of the entry, with the task and commits that closed it, so anything without that banner is still open.

State as of 2026-09-20:

- main is at `25b64d9` in `/home/junaid/ai-workstation`, clean, **nothing pushed**; `origin/main` is far behind and staying that way by jd's decision.
- The pilot checkout `/home/junaid/ai-workstation-team-pilot` sits on `feature/team-telegram-pilot` at `dc3e9de`, already merged into main. It is the test rig, not where product code goes.
- Both pilot instances are stopped and nothing listens on 3100, 3200, 4100 or 4200.
- **Phase A is done.** F00A, F01 and F02 are merged; B12, B14 and B17 are closed, B17 apart from its pinned anchor.
- **F03 is in progress.** Every remaining task goes to a worker agent; the orchestrator composes cards, verifies, merges and tracks, and writes no product code.
- Order of the remaining tasks: F03, F05, F06, F07, F08, F09, then H01 to H05. Migration numbers start at **28**; F02 took 27.
- **Testing is parked.** By jd's instruction of 2026-09-20, tasks run only a typecheck and the narrow unit tests for what they changed. The full suites, every burn-in, both audits, the wall-clock sweep (F00B) and the LT-4 re-run all run in **Phase V**, after implementation finishes. See section 2.1 and section 6 of the brief.

Decisions jd settled on 2026-09-20, all now recorded in the plan:

| Decision | Ruling |
| --- | --- |
| R-B wording | Approved as drafted. F04 is **done**: R-B reads owner-initiated, and B15 is closed as resolved by decision. |
| B6 approach (F09) | Say it on the card. Name the recovery path on the personal question card; do **not** change `notifyWaitingTasks`' dedupe. A waiting task may still sit with dead buttons, and that is the accepted trade. |
| Wall-clock fixtures | Add **F00B**, a sweep before audit 3, because audit 2's 274/274 does not reproduce here. |
| Execution model | Orchestrator does Phase A; every task from Phase B onward goes to one worker agent each. |

| G01 | **Recorded 2026-09-20**, see [implementation.md](implementation.md) section 6b. The handover delegates nothing: the receiver asks to take the task over, accepts it, and resumes under their own login on their own machine, with no credential shared and no cross-account usage. Holds while acceptance stays an explicit human action. |

Still open. None of it blocks building, and none of it blocks the F track:

| Needed for | Open item |
| --- | --- |
| Enabling handover | **G02**. A record is **drafted** in [implementation.md](implementation.md) section 6c and needs jd's confirmation of one thing: that the roster is the trust boundary, so a malicious roster member is out of scope and the two residual limits are accepted. The tested-isolation half is produced by RTC-12 inside H04, so G02 closes when TM4 finishes, not before it starts. |
| Enterprise deployment | **G04**. A record is **drafted** in [implementation.md](implementation.md) section 6d. Items 1, 2 and 5 write down what is already true; jd should check **retention** and **operational owner**, which are real choices. |
| The control record, H02 | **G03**, Git host policy and signing verification. Largely supported already by the LG-1 pass of 2026-09-17, which proved custom refs and non-fast-forward rejection. |

| `H-TM-LT3`, `H-TM-LT4` | Real two-person runs with Yousef. The solo pilot is explicitly not a substitute, so **TM3 is not honestly done** until these run. |
| jd's call | `main` is far ahead of `origin/main` and nothing is pushed. |
| H01 | Skim `tm4.md` once written. The five handover rulings were settled on 2026-09-20 and are recorded in section 8 of [handover-rules.md](handover-rules.md), so H01 is no longer blocked. |

One standing warning that cost time twice: three tests in this suite take timestamps from the wall clock and assume they will differ, so they fail under load on a fast machine.
`h6-route-proxy.spec.ts` was repaired as T20A, the migration 26 fixture as F00A, and `S-L1-33` failed once under full-suite load then passed in isolation with and without the change.
Audit 2 recorded the server suite at 274/274; that figure does not reproduce here.
A deliberate sweep for wall-clock fixtures is worth doing before any audit claims a green suite.

Scope: the F track (defects B1 to B19 from [pilot-bug-log.md](pilot-bug-log.md)) and the H track (TM4 handover).
Plan of record: [team-burndown-dev-brief.md](team-burndown-dev-brief.md).

Starting commits:

- main: `dc3e9de544ab923344cf9425aeeef9510ee9ebf7`
- origin/main: `44ad5882fa792240860aff5468efd229a0b619c0`

Preconditions at tracker creation:

- The pilot branch `feature/team-telegram-pilot` was merged to main by fast-forward as `dc3e9de`, docs and one script only, no product code. Not pushed, by jd's decision.
- `git status` on main clean.
- Both pilot instances stopped by signalling their `concurrently` supervisors directly (B10).
- Latest applied migration is 26, so F02 owns 27.

Execution model, by jd's decision of 2026-09-20: the orchestrator implements Phase A (F01, F02) directly; every task from Phase B onward goes to one worker agent per task.

| Id | Track | Status | Worker agent id | Branch | Merged commits | Evidence summary | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F00A | F | done | orchestrator | `fix/F00A-migration-26-fixture-timing` | `b72f21e` | Pre-existing failure found on main at `dc3e9de`, not caused by F01: TM-T0-5-26 rejected its card as `prompt_not_blocked` because the fixture seeded the prior answer and the handoff's `completedAt` from the wall clock back to back, and both landed in the same millisecond (observed `04:04:39.166Z` for each). Fixture now completes the question strictly after the prior answer; test only, no product code. Stable 3/3. | 2026-09-20 |
| F04 | F | done | orchestrator | none, applied on main | `(with this commit)` | Documentation only. R-B amended to owner-initiated in the wording jd approved on 2026-09-20, and B15 closed as resolved by decision. Done by the orchestrator rather than a worker because the text was approved verbatim and the change is one table row. | 2026-09-20 |
| F02 | F | done | orchestrator | `fix/F02-close-the-thread` | `32ce63c..cfb9d55` | Closes B17 apart from its pinned anchor, and closes B14. Owns migration 27, which adds `closed_at` and `closed_command_id` to `item_link` in place, no rebuild needed. Behavioural red first at the T1 tier: 8 actions stayed armed on the item after a close where 0 were expected. Two design corrections found while building: retiring the anchor the way completion does makes the thread unroutable, because `telegramItemThreadForMessage` skips `ANCHOR_GONE`, so a reply would meet silence instead of a refusal; and marking a completed link closed would stop the anchor retiring at all, so the access message reads completion from the prompt instead. Green: new closed-thread T1 case, whole TM3 file 3/3 in 1.8m, TM-T0-5-27 across two boots, full server suite 279/279, typecheck clean. T15's expected item link row updated for the two new columns. | 2026-09-20 |
| F01 | F | done | orchestrator | `fix/F01-help-capabilities` | `506ea0a..7cca9cd` | Closes B12. Red proven at both tiers first: TM-T1-4 failed at `tm3-grants.spec.ts:137` and the new `teamItemViews.test.ts` failed 2/5. `/help` had no coverage at any tier beforehand. Root cause was that `renderTeamItemView` was never told who asked, so `askingPersonId` was added to the view state and threaded from `message.transportUserId`. Green: unit 5/5, TM-T1-4 1/1 in 1.2m, TM-T1-4 burn-in 3/3 in 1.9m, full server suite 279/279, typecheck 4/4 workspaces, web lint 0 errors and the 5 existing warnings. No live Telegram, credential, paid provider, remote write or push. | 2026-09-20 |
| F03 | F | in progress | `worker/F03` | `fix/F03-open-team-thread` | | Owner-side "Open Team thread" control (B2) and a named refusal when the prompt is already `DONE` or `SKIPPED` (B7). Started from main at `25b64d9`. | 2026-09-20 |

## Log

- 2026-09-20: Tracker created. F01 started directly by the orchestrator per the split execution model. Scope is the TM-T1-4 assertion gap for `/help` and `/access`, then the `/help` fix (B12).
- 2026-09-20: F01's regression run exposed a failure that reproduces on main without F01's changes, so it was split out as F00A and merged first, to keep F01's evidence on a green baseline. Audit 2 recorded the full server suite at 274/274; that no longer reproduces on this machine, and this is the second wall-clock fixture fragility after the `h6-route-proxy.spec.ts` one repaired as T20A. Worth a sweep for others before the next audit.
- 2026-09-20: F02 saw `S-L1-33` fail once under full-suite load, then pass 25/25 in isolation twice, with and without the change, and not recur on the clean re-run. Recorded as timing-sensitive rather than attributed either way. That is the third timing-fragile test after F00A and the `h6-route-proxy` one repaired as T20A, so a deliberate sweep is worth doing before an audit claims a green suite.
- 2026-09-20: F00A merged by fast-forward as `b72f21e`. F01 rebased onto it and merged by fast-forward as `7cca9cd`; both branches removed.

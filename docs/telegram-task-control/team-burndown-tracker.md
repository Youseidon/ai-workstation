# Team burn-down tracker

Created: 2026-09-20

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
| F01 | F | done | orchestrator | `fix/F01-help-capabilities` | `506ea0a..7cca9cd` | Closes B12. Red proven at both tiers first: TM-T1-4 failed at `tm3-grants.spec.ts:137` and the new `teamItemViews.test.ts` failed 2/5. `/help` had no coverage at any tier beforehand. Root cause was that `renderTeamItemView` was never told who asked, so `askingPersonId` was added to the view state and threaded from `message.transportUserId`. Green: unit 5/5, TM-T1-4 1/1 in 1.2m, TM-T1-4 burn-in 3/3 in 1.9m, full server suite 279/279, typecheck 4/4 workspaces, web lint 0 errors and the 5 existing warnings. No live Telegram, credential, paid provider, remote write or push. | 2026-09-20 |

## Log

- 2026-09-20: Tracker created. F01 started directly by the orchestrator per the split execution model. Scope is the TM-T1-4 assertion gap for `/help` and `/access`, then the `/help` fix (B12).
- 2026-09-20: F01's regression run exposed a failure that reproduces on main without F01's changes, so it was split out as F00A and merged first, to keep F01's evidence on a green baseline. Audit 2 recorded the full server suite at 274/274; that no longer reproduces on this machine, and this is the second wall-clock fixture fragility after the `h6-route-proxy.spec.ts` one repaired as T20A. Worth a sweep for others before the next audit.
- 2026-09-20: F00A merged by fast-forward as `b72f21e`. F01 rebased onto it and merged by fast-forward as `7cca9cd`; both branches removed.

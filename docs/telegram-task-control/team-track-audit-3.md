# Audit 3: the F track

> **Historical audit evidence.** Findings apply to the audited tree and date;
> later fixes do not rewrite this report.

Auditor: a fresh agent with no part in the build, run on 2026-09-25.
Checklist: section 4 of [team-track-dev-brief.md](team-track-dev-brief.md), unchanged.
Range: `dc3e9de..main`, where main's tip is `3e21628`.
Tasks in scope: F00A, F00B, F01, F02, F03, F04, F05, F06, F07, F08, F09, and F10, which was never started.
Tree: `<user-home>/aw-audit3`, a detached-HEAD worktree of `<user-home>/ai-workstation` at `3e21628`, with its own `npm install`.

Nothing was pushed, no remote ref was written, no T2 or T3 tier was run, no live Telegram credential or paid provider was used, no agent was spawned, nobody was contacted, and no product code, test or fixture was changed.
The only file this audit writes is this report.

## 0. Result

**FAIL**, on five checks: D1, D9, A1, A2 and A6.
Ten checks pass: D2 to D8, A3, A4, A5 and A7.
Nothing found is a live product defect, and every F-track fix this audit could re-verify is present on main and green.
Three of the five failures are record-keeping (D1, D9, A6), one is A2's lint tier, which is entirely upstream's and is a recorded, attributed fact rather than a finding against this work, and one is A1, where five acceptance criteria across F02, F03, F05, F06 and F00B are either unmet or not re-verifiable.
The detail, and what would close each one, is in the check sections below.

Recorded facts this audit was given and confirmed rather than re-litigated: `git log --merges dc3e9de..main` returns three commits, of which none is a task landing; 29 commits in the range are upstream author <git-author>'s and belong to no tracker row by design; nothing has ever been pushed, and `origin/main` moved because <git-author> pushed to the real remote; `npx eslint` in `web` reports 19 problems, 17 errors and 2 warnings, every error in upstream's own files.

## 1. Discipline, D1 to D9

### D1: every task has its own worker agent id and no id repeats. **FAIL**

Tracker rows in scope, worker agent id column:

| Task | Recorded id |
| --- | --- |
| F00A | `orchestrator` |
| F04 | `orchestrator` |
| F02 | `orchestrator` |
| F01 | `orchestrator` |
| F03 | `worker/F03` |
| F05 | `worker/F05` |
| F06 | `worker/F06` |
| F07 | `worker/F07` |
| F08 | `worker/F08` |
| F09 | `worker/F09` |
| F00B | `one worker` |

Command: `grep -n '^| F' docs/telegram-task-control/team-burndown-tracker.md` and the row extract above.

F03 to F09 each carry a distinct id and pass.
Four rows (F00A, F01, F02, F04) share the value `orchestrator`, which both repeats and is not a worker agent id.
That is authorized: operator's decision of 2026-09-20, recorded in the tracker's decision table and in section 2 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md), splits the work so the orchestrator implements Phase A itself.
F00A and F04 are outside the letter of that decision, which names F01 and F02, though both rows state their reason in place (F00A a test-only fixture repair found on the baseline, F04 one approved table row).
F00B's id is `one worker`, which is not an id at all, so its row cannot show that it ran in a fresh context.

The check as written does not hold, and it is recorded as failed rather than softened.
What would close it: an id in F00B's row, and operator's waiver in writing for the four orchestrator rows.

### D2: every task landed from its own branch by fast-forward, and the range is linear. **PASS**

```
$ git log --merges --format='%h %an %s' dc3e9de..HEAD
a641b0c Requester operator Reconcile main with origin/main by merge, not rebase
b855ec2 <git-author> Merge pull request #2 from <git-user>/pipeline-continuation-loop
fa92586 <git-author> Merge pull request #1 from <git-user>/pipeline-status-model
```

None of the three is a task landing.
`a641b0c` is the reconcile of `origin/main` into main, done by the orchestrator on operator's instruction of 2026-09-22 and recorded in tracker row R1.
The other two are <git-author>'s own pull-request merges, which arrived inside his 29 commits.

Over the F track's own window the history is strictly linear:

```
$ git log --merges --oneline b72f21e~1..e47becc
(no output)
```

Branch naming: the F track uses `fix/<id>-<slug>`, not `tm/<id>-*`, by section 2 of the burn-down brief, which amends the earlier brief for this track.
Every F row names such a branch, and the tracker log records each landing as a fast-forward with the worktree and branch removed.

### D3: nothing was pushed. **PASS**, with the recorded correction

```
$ git rev-parse origin/main
4fd0e655ee7fafdd9db65d253ac7628c415e8639
$ git branch -r --contains HEAD
(no output)
$ git rev-list --left-right --count origin/main...HEAD
0	365
```

`origin/main` is not the `44ad588` recorded at the top of the tracker, so the check as literally worded does not hold.
The cause is not a push from here: `4fd0e65` is <git-author>'s own commit of 2026-09-18, and the ref moved when a worker ran a `git fetch`, which is a remote read.
The substantive half holds exactly: no commit of ours is reachable from any remote ref, and main is 365 ahead and 0 behind.
The tracker recorded this on 2026-09-21 and asked that audit 3 use the honest form of the check, which is what is done here.

### D4: each task's commits touch only what its card covers. **PASS**

Per-commit `git show --stat` was read for all 57 commits of ours in the F window, against each task's row in section 3 of the burn-down brief.
No commit touches a file outside its card's subject.
Product and test files split as the cards require: F01, F03, F05, F07, F08 and F09 each begin with a tests-only red commit, and the papercuts of F09 land one commit each (`6596e57`, `4628ec7`, `711780c`, `41b2817`).
The whole F window touches no settings and no lint configuration:

```
$ git log --oneline b72f21e~1..e47becc -- server/src/settings.ts web/eslint.config.mjs
(no output)
```

Two observations, neither a scope violation.
F02's `32ce63c` carries its new T1 case and its product change in one commit, so F02's red-then-green is the only one in the track not verifiable from the branch alone.
F07's `ac42b6d` also edits `handover-rules.md` and the brief's H02 row, which is the migration renumbering its own row explains.

### D5: commit messages are imperative and carry no co-author line. **PASS**

Every subject in the F window is imperative (`Seed`, `Assert`, `Render`, `Make`, `Stop`, `Reproduce`, `Refuse`, `Rewrite`, `Repair`, `Keep`, `Issue`, `Pin`, `Compare`, `Bound`, `Retire`, `Carry`, `Name`, `Say`, `Read`, `Cut`, `Clear`, `Record`, `Close`, `Mark`, `Log`).

A per-commit sweep for trailers over the whole range finds 15 commits carrying one, and every one of them is <git-author>'s:

```
$ for c in $(git rev-list dc3e9de..HEAD); do ... grep -qi 'co-authored-by' ...; done
e053719|<git-user>|... || Co-authored-by: Cursor <cursoragent@cursor.com>
b2f2e33|<git-user>|... || Co-authored-by: Cursor <cursoragent@cursor.com>
8809a7b|<git-user>|... || Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
(12 more, all <git-user>)
```

No commit of ours carries a co-author line.

### D6: no task worktree or task branch is left behind. **PASS**

```
$ git worktree list
<user-home>/ai-workstation  3e21628 [main]
<user-home>/aw-audit3       3e21628 (detached HEAD)
<user-home>/aw-audit4       3e21628 (detached HEAD)
$ git branch --list 'tm/*' 'fix/*' -a
(no output)
$ git branch
* (no branch)
+ main
```

The two extra worktrees are the audit worktrees for audits 3 and 4, not task worktrees.
No `fix/*` or `tm/*` branch remains.

### D7: the slice's scenario table was committed, and operator's skim recorded, before that slice's first product code commit. **PASS by analogue**

The F track is a defect burn-down, not a progression slice, and it has no scenario table of its own, so the check has no literal subject in this range.
Its equivalents were all in place before the first F product commit `7cca9cd`:
[pilot-bug-log.md](pilot-bug-log.md) with B1 to B19 and [team-burndown-dev-brief.md](team-burndown-dev-brief.md) with the task cards both landed on the pilot branch, merged as `dc3e9de`, which is the range's starting commit.
operator's involvement in the range is recorded as four decisions of 2026-09-20 in the tracker's decision table (the R-B wording, the B6 approach, the wall-clock sweep, the execution model).

The one scenario table inside the range, `tm4.md`, belongs to the H track and to audit 4.
It is worth noting here only because line 66 of it asserts the F track's fixes as load-bearing, including F05's, which section A1 shows has no harness row.

### D8: every operator stop point has operator's answer recorded; no worker contacted operator or spawned an agent. **PASS**

The burn-down brief marks no F task as a operator stop point in the task tables.
The four decisions the F track actually needed are recorded with dates in the tracker's decision table, and each is reflected in the work: F04's wording (approved verbatim, landed in `a94da5e`), F09's B6 form (a sentence on the card, landed in `4628ec7`, dedupe untouched), F00B's existence, and the split execution model.
No row or log entry records a task as `blocked: operator`, and the tracker's log describes the orchestrator, not a worker, taking every question to operator.
This audit contacted nobody and spawned nothing.

### D9: the tracker agrees with git. **FAIL**

Every commit named by a `done` F row exists on main, and every product commit in the F window maps to a row.
Mapping verified by `git log --reverse --format='%h|%an|%ad|%s' dc3e9de..HEAD` against the rows: F00A `b72f21e`; F01 `506ea0a`, `7cca9cd`; F02 `32ce63c`, `cfb9d55`; F03 `fc01a2c`, `ff1bfe5`, `730fcde`; F05 `deb63fc`, `c0eeec7`, `d939dd0`, `70c0cab`; F06 `b43899c`, `cd35947`, `18190f4`, `b1b1143`; F07 `a5331a5`, `bdcc604`, `5d08a6c`, `46b2522`; F08 `9008c6f`, `4d081a9`, `e7d97cd`; F09 `e7032e9`, `6596e57`, `4628ec7`, `711780c`, `41b2817`, `8b93dd9`; F00B `4070156`, `581aafd`.

Three defects, the first two of them the reason for the FAIL:

1. **F04's row names no commit.** Its merged-commits cell reads `` `(with this commit)` ``, a self-reference that stopped resolving as soon as another commit landed.
   The commit is `a94da5e`, found by `git log -S "Amended by operator on 2026-09-19" -- docs/telegram-task-control/teammate-design.md`.
   D9 requires a `done` row to name commits that exist on main; this row names none.
2. **Seventeen commits of ours in the F window belong to no row.** They are the G01, G02 and G04 gate and handover-rules documents: `4bfd183`, `40366b2`, `3eb9b69`, `0cd9651`, `0547644`, `6ef7378`, `6303e01`, `744ce79`, `86fab96`, `d7273fa`, `53310c7`, `8039fcc`, `cadb207`, `25b64d9`, `a94da5e`, `5554c06`, `bb4121c`.
   They are explained by the brief's G01 row and the decision table, and they are documentation only, but D9's exception covers only the orchestrator's tracker and audit commits, and these are neither.
3. The 29 upstream commits are <git-author>'s, were never claimed, and are out of range rather than unexplained.
   No commit of ours lacks a row apart from the seventeen above.
   Recorded as given.

What would close it: F04's sha in its row, and either a row or a stated exception for the gate documentation commits.

## 2. Acceptance criteria, A1 to A7

### A1: every acceptance criterion re-verified on main by the auditor. **FAIL**

Criteria are taken from section 3 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md), plus the tracker row for F00A, which has no brief card.
Everything below was re-run or re-read on main at `3e21628` in this audit's own worktree.
Suite result lines are in A2 and A3; this section records the per-criterion verdict.

**F00A. PASS.** The fixture derives the later timestamp from the earlier rather than calling the clock twice: `server/test/teamGrants.test.ts:215` reads `completedAt: new Date(Date.parse(priorAnswer.createdAt) + 1).toISOString()`.
Test code only.
TM-T0-5-26 passes inside the server suite.

**F01. PASS.** `e2e/tests/t1/tm3-grants.spec.ts:123-145` sends both commands and asserts capability-limited output in both directions: before any grant `/help` contains `/task` and not `/answer`, `/resume` or `/context`; after the two grants it contains `/answer` and `/resume` and still not `/context` or `/grant`; the owner's `/help` carries `/grant` and `/close`.
`/access` is asserted unchanged in shape (`read only`, then `answer, resume`).
The product half is `askingPersonId` threaded into `renderTeamItemView` (`server/src/teamItemViews.ts:25`, `:190`, `:192`).
TM-T1-4 passes in the full T1 run and at 3 repeats in the burn-in.

**F02. FAIL on one criterion of seven.** Persisted closed state: migration 50 (F02's 27 renumbered by the reconcile) adds `item_link.closed_at` and `closed_command_id` in place, `server/src/workspaces.ts:1717-1727`.
Refusals: `taskControl.ts:339` rejects a tap with `item_closed`, and `runtime.ts:1350` refuses a granted command before minting a card.
Access refresh with no actions, an inert stale card and a durable `closed_at` row are all asserted end to end by the closed-thread T1 case, which passes.
The unmet criterion is *"retire and unpin the anchor the way completion does"*: `syncTeamItem` returns early for a closed link (`runtime.ts:1274`) and `finishCompletedTeamItems` only ever reaches a `DONE` or `SKIPPED` prompt (`runtime.ts:1321`), so a thread closed while its task is still blocked keeps its pinned anchor forever.
This is deliberate and explained in the B17 entry (retiring makes the thread unroutable), and the bug log says so at the top of the entry and in its header line.
It is still an acceptance criterion the track did not meet, and section 3 of this report records what is missing around it.

**F03. FAIL on one criterion of five, as not re-verifiable.** The control exists (`web/components/tasks/TeamThreadPanel.tsx`, mounted from `WorkItemDetail.tsx`), the client method exists (`web/lib/workspacesApi.ts:93`), and the route refuses a finished prompt with a specific error (`runtime.ts:372`, `409 prompt_already_complete`), asserted at `server/test/telegramLiveRuntime.test.ts:1114-1169` and by `web/components/tasks/teamThread.test.tsx`.
The fifth criterion, *"the UI is checked at both widths"*, cannot be re-verified: the fixture that produced that evidence was not committed.
Gap register L-4 records exactly this for F03.

**F04. PASS.** `teammate-design.md:63` reads amended to owner-initiated with operator's date, and B15 is closed by decision in the bug log.
Landed in `a94da5e`.

**F05. FAIL on one criterion of three.** The migration signal, the local rewrite, the compare-and-swap republish and the retry are all present and tested: `httpBotApi.ts:72-75` normalizes `migrate_to_chat_id` and `migrate_from_chat_id`, `workspaces.rewriteTeamChatId` moves every local row in one transaction (`workspaces.ts:4194`), `runtime.ts:938` republishes, and `adapter.ts:144` makes the upgrade the exception to anchor retirement.
`telegramSupergroupMigration.test.ts` and the runtime cases pass.
The third criterion, *"A harness case upgrades a group mid-test and shows the next anchor delivered to the new id with no manual repair"*, was not delivered: there is no T1 case, and the e2e fake cannot do an upgrade at all (`grep -rn "upgradeToSupergroup\|migrate_to_chat_id" e2e/src` returns nothing).
The substitute is a T0 runtime test, `telegramLiveRuntime.test.ts:1277`, which is honest work at a lower tier but carries the id **`TM-T1-8`**, an id that exists in no scenario table and no plan: `grep -rho "TM-T1-[0-9A-Za-z]*" docs/ | sort -u` lists 1, 1a, 1b, 2 to 7, H1 to H3, and nothing else.
The deviation is recorded in the tracker's log of 2026-09-20 and was accepted by the orchestrator, but it is not in the F05 row and it is not in the gap register, and `docs/e2e-scenarios/tm4.md:66` now asserts F05's behaviour as load-bearing for the H track.

**F06. FAIL on one criterion of four, as not re-verifiable.** Reissue exists and reuses creation's path: `runtime.reissueTeamJoinCode` (`runtime.ts:317`), the route at `workspaceApi.ts:266`, the panel action `Issue new join code` (`TeamStatusPanel.tsx:24`), the client method at `workspacesApi.ts:89`.
Both the reissue and the `roster_conflict` path are asserted at `telegramLiveRuntime.test.ts:946` and `:1005`, and the web assertions are in `teamJoinCode.test.tsx`.
The *"both widths"* criterion cannot be re-verified for the same reason as F03: no rig was committed.
Gap register L-4 names only F03, so this half of the same problem is unrecorded.

**F07. PASS.** Material-content comparison with the age normalized out (`card.ts:128` `renderedAge`, `:122` `RENDERED_AGE`, plus `withoutRenderedAge`), the coarse schedule (`ANCHOR_AGE_REFRESH_MS` one hour, phased per item by `anchorAgeInstant`), the undelivered-anchor check and per-thread back-off (`runtime.ts` `anchorSendDue`, `workspaces.telegramThreadAnchorDelivery`), the two behavioural tests (`telegramLiveRuntime.test.ts:1375` idle item not rewritten, `:1415` one row then a back-off), and the migration case (`teamItems.test.ts:193-214`, asserting version 51, which is F07's 28 renumbered).
All pass in the server suite.

**F08. PASS.** `completedSummary` (`teamItemViews.ts:112`) renders the completed anchor and is selected at `:129-133`; retirement waits for the run (`runtime.ts:1310` `teamItemRunEnded`, called at `:1328`); the race is asserted at `telegramLiveRuntime.test.ts:1488` and `:1522`.
All pass.

**F09. PASS.** B5 splits the roster labels (`personLabel` and `workstationLabel` in `teamRoster.ts` and `teamItemViews.ts`, with the cached-roster fallback of `8b93dd9`); B6's sentence is `EXPIRY_RECOVERY` at `liveFormat.ts:40`; B18's line is `teamItemViews.ts:259-260`, present for both `answer_and_resume` and `resume_saved`; the pluralization is `card.ts:92` with the assertions at `telegramCard.test.ts:216-218` and `:225`, including `at(90)` as the card asked and the `renderedAge` read-back that protects F07.

**F00B. FAIL on one criterion of three, as only partly re-runnable.** Both fixtures are repaired on main: `forgetTeamRoster` is called in a `finally` block in `telegramSupergroupMigration.test.ts`, and `e2e/src/scenarios/l3F1.ts` cuts the call log by index.
Test code only, confirmed by `git diff --stat 4070156~1 581aafd` (two files).
The proof criterion is *"the full server suite and the full T1 suite three times each against one unchanged repo root"*.
This audit re-ran the server suite three times against one unchanged root (A2) and the full T1 suite **once**, not three times: three T1 passes are about 80 minutes of exclusive harness time, which this audit did not have alongside the rest of the checklist.
So F00B's server half is re-verified and its T1 half is re-verified once.
Recorded as a FAIL of A1's "every criterion re-verified" rather than claimed.

**F10.** Never started, and correctly so: it is rig-only, recorded as deferred in gap register L-1 and needed only before LT-5.
B3, B4 and B10 stay open in the bug log with that pointer.
No claim to check.

### A2: typecheck, lint, the full server suite and the full T1 suite pass on main. **FAIL on the lint tier only**

Every tier was run by this auditor on main at `3e21628`, not taken from the tracker.

**Typecheck: PASS.**

```
$ npm run typecheck
> npm run typecheck --workspace shared && npm run typecheck --workspace server && npm run typecheck --workspace web && npm run typecheck --workspace e2e
(exit 0, no diagnostics)
```

**Full server suite: PASS, three times against one unchanged root.**
The workspace script points `AGENT_CONSOLE_DB` at a pid-specific temp file, so three plain invocations would each get a fresh database and could not reproduce F00B's proof.
The three runs below pin one database path across all three, which is the stricter reading:

```
$ cd server && AGENT_CONSOLE_DB=<one fixed path> SETTINGS_FILE=<one fixed path> \
    node --import tsx --test --test-concurrency=1 test/*.test.ts     # three times
=== run 1 exit 0 ===  # tests 618  # suites 14  # pass 618  # fail 0  # cancelled 0  # skipped 0  # todo 0   (119.3s)
=== run 2 exit 0 ===  # tests 618  # suites 14  # pass 618  # fail 0  # cancelled 0  # skipped 0  # todo 0   (108.3s)
=== run 3 exit 0 ===  # tests 618  # suites 14  # pass 618  # fail 0  # cancelled 0  # skipped 0  # todo 0   (108.3s)
```

618 of 618 on each run, `not ok` count zero, and the second and third runs are against the database the first one left behind, which is the shape that exposed the F08 and F00B finding.
This matches the tracker's figure exactly.

**Shared and web suites: PASS.**

```
$ npm run test --workspace shared     # tests 91  # pass 91  # fail 0  # skipped 0   (exit 0)
$ npm run test --workspace web        # tests 94  # pass 94  # fail 0  # skipped 0   (exit 0)
```

The web figure is only meaningful because M9's `b943650` widened `web`'s `test` script to every `*.test.tsx`, which is what finally runs F03's `teamThread.test.tsx` and F06's `teamJoinCode.test.tsx` routinely.
That was F06's own flag of 2026-09-20, registered as M-5 and closed on 2026-09-25.

**Full T1 suite: PASS.**

```
$ cd e2e && npx playwright test --project=t1
Running 127 tests using 1 worker
  ...
  127 passed (27.1m)
```

No failure, no skip, no flaky, no retry, and no `did not run` line.
This is an independent reproduction of M9's 127 of 127 on a separate worktree with its own `npm install`, which also confirms the tracker's claim that nothing after `250e085` touches a file outside `docs/`: `git diff --stat 250e085 HEAD` is one line of the tracker.

**Lint: FAIL, and not this track's doing.**

```
$ cd web && npx eslint .
✖ 19 problems (17 errors, 2 warnings)
(exit 1)
```

Exact tally by file: `components/pipeline/PipelineBoard.tsx` 9 errors and both warnings; `components/programs/ProgramDraftPanel.tsx` 3 errors; `components/activity/ActivityView.tsx`, `components/pipeline/DefinitionOfDonePanel.tsx`, `components/pipeline/PipelineDashboard.tsx`, `components/pipeline/StatusCatalogPanel.tsx` and `components/pipeline/SuiteFallbackEditor.tsx` one error each.
The recorded correction this audit was given says every error is under `components/activity/` or `components/pipeline/`; three of the seventeen are in `components/programs/ProgramDraftPanel.tsx`, so that figure needs one word widened.
It does not change the attribution, which this audit checked per file rather than assuming: `git log --format='%an' -- <file>` gives <git-user> only for `ProgramDraftPanel.tsx` (2 commits) and `PipelineBoard.tsx` (14), and for `ActivityView.tsx` eight <git-user> commits plus one of ours, which is the reconcile merge `a641b0c` itself and not an F task.

The F track's own web files lint clean:

```
$ cd web && npx eslint components/tasks/TeamThreadPanel.tsx components/agents/TeamStatusPanel.tsx \
    components/tasks/WorkItemDetail.tsx lib/workspacesApi.ts
(no output, exit 0)
```

So A2 is recorded as failed because the check says lint passes and it does not, while the substance is that the failure is upstream's, was inherited by the reconcile, is not reachable by any F task, and does not pass on `origin/main` either.
The 2-warning figure is confirmed; the older 11-warning claim does not reproduce and stays withdrawn.

### A3: burn-in at 3 repeats passes for every T1 scenario the range added. **PASS**

The F track added exactly one T1 scenario, F02's closed-thread case, and changed one, F01's TM-T1-4.
Both live in `e2e/tests/t1/tm3-grants.spec.ts`, which is the file V3's plan names for this track.

```
$ cd e2e && npx playwright test --repeat-each=3 --max-failures=1 --project=t1 tests/t1/tm3-grants.spec.ts
Running 9 tests using 1 worker
  ...
  9 passed (6.3m)
```

Nine executions, zero failures, zero flaky, zero retries, `--max-failures=1` never reached.
Per-repeat timings were stable: TM-T1-4 at 1.0m, 31.8s, 32.1s; the closed-thread case at 45.3s, 24.1s, 25.2s; TM-T1-5 at 51.3s, 52.6s, 51.9s.
The first repeat of each is slower because it pays the environment boot, which is the expected shape.

No F-track scenario is skipped or `fixme`: the full T1 run reports 127 passed with no skipped and no did-not-run line, and `grep -rn "test.fixme\|test.skip\|.only" e2e/tests/t1/*.spec.ts` matches only a comment in `tm4-handover.spec.ts` describing the rows H06 un-fixmed.

### A4: real checks due in the range are recorded as H-TM rows with date and outcome. **PASS**

`human-verification.md` carries four H-TM rows, each with a date and an outcome:
`H-TM-LT1` PASS 2026-09-16 with its four section 4.4 assumptions marked confirmed or disproved;
`H-TM-LG1` PASS 2026-09-17;
`H-TM-LT3` deferred by operator instruction 2026-09-17, with an explicit instruction not to mark PASS before the real operator and <git-author> run;
`H-TM-LT4` deferred by operator instruction 2026-09-18, on the same terms.

No new real check fell due inside the F track.
The one real re-check the F track creates is the LT-4 re-run of cases 2, 3, 11 and 12, which section 4 of the burn-down brief ties to F01, F02 and F03 landing, and which section 6 of the same brief sequences as **V5, after audit 3**
It updates `solo-team-thread-grant-check.md` rather than `human-verification.md`, so it produces no H-TM row either way.

The consequence is worth stating plainly, because A4 passing can read as more than it is: the F track's three user-facing fixes have no live evidence yet.
`solo-team-thread-grant-check.md:248` still records case 11 as `PARTIAL, see B17`, measured on 2026-09-20 before F02 landed.
Until V5 runs, every F-track claim rests on the fake tiers.

### A5: the section 5 invariants hold. **PASS**

- **Personal control unchanged.** The full T1 suite is the proof the invariant names, and it is green at 127 of 127, including every `l1-*` and `l3-*` personal-control spec.
- **`team.enabled` off by default.** `server/src/settings.ts:287-292` gives `team.enabled` `fallback: false`, and `:297-303` gives `team.handoverEnabled` the same.
  The F window touches `settings.ts` in no commit (D4).
  This audit did not enable either flag.
- **No token anywhere.** The token sweep is not a separate command here: `e2e/src/fixtures.ts:7` and `e2e/src/env/orchestrator.ts:373` run `sweep(...)` over the logs, the fake provider directory and the artifacts when each spec file's environment is disposed, and a finding fails the run.
  A 127-of-127 pass therefore carries a clean sweep for every environment in the suite.
  The dedicated case `S-L3-F1-22` ("the token is in no DTO, setting, operation, database row or agent environment") passes, as does `tm1-team-default-off`.
- **Group actors never enrolled for personal notifications, one owning workstation answers, no forum topics.** Covered by the TM1 to TM3 T1 specs, all green in the same run.

### A6: implementation.md has an entry per slice in the range with exact commands and counts. **FAIL**

```
$ grep -n "F0[0-9]\|burn-down\|F track" docs/telegram-task-control/implementation.md
(no output)
```

`implementation.md` has close-out entries for the Team track's own slices (TM0 and TM1 at line 21, TM2 at 187, TM3 at 214) and the G01, G02 and G04 records at sections 6b to 6d, but **no entry for the F track at all**: no commands, no counts, no per-task record.
The F track's equivalent evidence lives in the tracker rows, the tracker log and the bug log entries, which are detailed and candid, so the information exists; it is simply not where A6 requires it.
Nothing in the burn-down brief cancels A6, and section 8 of that brief still requires the orchestrator to report counts per tier.

What would close it: one F-track entry in `implementation.md` with the commands and the counts this audit records in A2 and A3.

### A7: any design fact a real check disproved is corrected in the design, the plan and the fake, with operator's approval recorded. **PASS**

The F track's one design-level correction of this kind is F04, and it is complete: the solo pilot disproved R-B's teammate-initiated direction (a teammate can never learn the owner's numeric prompt id, B15), `teammate-design.md:63` now reads owner-initiated and names operator's amendment date, B15 is closed as resolved by decision, and the tracker's decision table records operator approving the wording verbatim on 2026-09-20.
The plan side follows in the same commit `a94da5e`.
No fake change was needed, because the correction removes a flow rather than changing transport behaviour.

The other corrections the F track made (F02's anchor retirement, F05's upgrade exception to `ANCHOR_GONE`, F08's wording) came from reading the code rather than from a real check, so they are outside A7's subject.
Each is recorded in its bug log entry.

## 3. Findings the numbered checks do not name

These are not extra failures.
They are things a later reader would be misled by, found while re-verifying the checks above, listed so they can be fixed or accepted deliberately.

1. **B17's pinned anchor is open and unowned, and the gap register does not carry it.**
   The bug log is honest in place: the B17 entry says "apart from the pin", and its "Still open" paragraph says the unpin "belongs with the anchor lifecycle work in F07 and F08 rather than here".
   F07 and F08 did not do it, and neither entry claims to: `grep -n "pin" ` over the B9, B11 and B13 entries finds only the churn discussion and F08's completion unpin.
   Confirmed in the code: `syncTeamItem` returns at `runtime.ts:1274` for a closed link, so a closed item's anchor is never re-rendered, and `finishCompletedTeamItems` waits for the delivered payload to equal the rendered one, which for a closed item it never will.
   A thread closed on a still-blocked task keeps a pinned, stale anchor indefinitely.
   Meanwhile `e47becc`'s message and the tracker's log say "B1 to B19 are now all closed, deferred or pointed elsewhere", and [team-gap-register.md](team-gap-register.md), which the tracker calls the answer to "what is left", has no row for it.
   It should have one.

2. **F05's substitute test carries a scenario id that does not exist.**
   `server/test/telegramLiveRuntime.test.ts:1277` is named `TM-T1-8 (T0)`.
   `grep -rho "TM-T1-[0-9A-Za-z]*" docs/ | sort -u` returns TM-T1-1, 1a, 1b, 2, 3, 4, 5, 6, 7, H1, H2, H3 and the template `TM-T1-n`.
   There is no TM-T1-8 in any scenario table or in the plan, so the test's name asserts coverage of a row that was never written, in a tier the name does not belong to.
   This is the exact shape section 7 of the burn-down brief warns about, one level along: not a `must` clause with no assertion, but an assertion pointing at no clause.

3. **F06's two-width evidence is as unreproducible as F03's, and only F03 is recorded.**
   Gap register L-4 names F03's control alone.
   F06's row describes a headless render at 375px and 1280px, and no rig for it was committed: the only committed width rigs are `scripts/verify-m4-browser.mjs` and `scripts/verify-handover-browser.mjs`, both at 390px and 1280px, neither touching `TeamStatusPanel`.
   L-4 should name F06 too, or F06's check should be committed as a rig.

4. **The bug log's summary line is stale and contradicts its own entries.**
   Line 11 reads "Fixed so far: B12 by F01; B14 and B17 by F02, except B17's pinned anchor", and line 13 reads "Everything else is still open".
   Nine further entries carry a Fixed banner (B1, B2, B5, B6, B7, B8, B9, B11, B13).
   The mechanism the tracker tells a reader to trust (the banner at the top of each entry) is intact; the index above it is wrong.

5. **The gap register closes L-4 in a heading and reopens it in the body.**
   `### L-4, F03's unreproducible two-width check. Closed 2026-09-21 by H06.` is followed by "so L-4 is **narrowed, not fully closed**", and the Low band still lists L-4 as open.
   A reader scanning headings gets the wrong answer.

6. **Two smaller staleness items.**
   `server/test/teamGrants.test.ts:127` is still titled "TM-T0-5-27: migration 27 ..." although its body was correctly updated to assert version 50, which is confusing next to `teamItems.test.ts`, which was renamed to 51 in its comment.
   Every count in the F rows (F02's 279/279, F07's 67/67, F09's 157/157 and the rest) was measured before the reconcile and is not reproducible on main, where the server suite is 618; only the M9 row's figures describe this tree.

7. **F03's second recorded limit is not in the register.**
   Its row records both that the 409 is untested at the HTTP tier (register L-5) and that the UI is stricter than the API, enabling only on `AWAITING_RESPONSE` (`TeamThreadPanel.tsx:25`) while the route refuses only `DONE` and `SKIPPED`.
   Only the first is registered.

8. **What the F track's evidence cannot tell anyone.** Three things, each already recorded somewhere, worth saying in one place because together they bound what "the F track is complete" means.
   The fixes have no live confirmation: LT-4's re-run is V5, still unrun, and case 11 in the solo check still reads PARTIAL against the pre-F02 behaviour.
   One user-facing criterion (both widths, twice) rests on evidence nobody can reproduce.
   And M9's lesson applies here as much as anywhere: a green server suite is not evidence that a surface is wired to a user, which is precisely why F02's and F01's T1 rows matter and why F05's absence of one is the sharpest gap in the track.

## 4. How this audit was run

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm install` in `<user-home>/aw-audit3` | exit 0 |
| Full T1 | `cd e2e && npx playwright test --project=t1` | `127 passed (27.1m)` |
| Burn-in | `cd e2e && npx playwright test --repeat-each=3 --max-failures=1 --project=t1 tests/t1/tm3-grants.spec.ts` | `9 passed (6.3m)` |
| Server suite, 3 times, one root | `cd server && AGENT_CONSOLE_DB=<fixed> SETTINGS_FILE=<fixed> node --import tsx --test --test-concurrency=1 test/*.test.ts` | `# pass 618  # fail 0` each time |
| Shared | `npm run test --workspace shared` | `# pass 91  # fail 0` |
| Web | `npm run test --workspace web` | `# pass 94  # fail 0` |
| Typecheck | `npm run typecheck` | exit 0, four workspaces |
| Lint | `cd web && npx eslint .` | exit 1, `19 problems (17 errors, 2 warnings)` |
| Lint, F-track files only | `cd web && npx eslint components/tasks/TeamThreadPanel.tsx components/agents/TeamStatusPanel.tsx components/tasks/WorkItemDetail.tsx lib/workspacesApi.ts` | exit 0, no output |

Everything else was `git` and reading files.
No T2 or T3 run, no push, no remote write, no flag enabled, nothing fixed.

One rig note for the orchestrator.
`npm install` with the system npm (10.9.8 on Node 22.23.2) rewrites 145 lines of `package-lock.json`, dropping the `libc` fields a newer npm wrote, which is why the worker card says `npx -y npm@11 install`.
It changes nothing about the installed tree or the results above.
This audit restored the file, so the worktree holds this report and nothing else: `git status --short` lists only `?? docs/telegram-task-control/team-track-audit-3.md`.

## 5. What blocks what

A FAIL blocks the next task until a new task with its own worker fixes it or operator waives it in writing in the tracker, and the orchestrator reports the result to operator either way.
Ranked by what actually matters:

1. **A1's F05 gap** is the only one with product risk behind it, and the risk is coverage rather than a known defect: the supergroup upgrade, one of the two defects the brief calls unrecoverable from inside the app, is asserted only at the T0 runtime tier, and M9 has just finished demonstrating what a tier gap can hide.
   Closing it means teaching the e2e fake to upgrade a group, which is real work and was sized as such in the brief's own table ("F05 large: needs the fake to model a supergroup upgrade mid-test, which no scenario does yet").
2. **A1's F02 gap**, B17's pinned anchor, needs a decision rather than a fix: either a task owns the unpin, or the gap register records it as accepted with the reason the bug log already gives.
3. **A6, D9 and D1** are documentation, fixable in one pass: an F-track entry in `implementation.md` with the counts in section 4 above, F04's sha in its row, an id in F00B's row, and either rows or a stated exception for the seventeen gate documentation commits.
4. **A1's two-width halves** (F03 and F06) are one small rig each, in the shape H06 already committed, or an explicit acceptance from operator that the evidence is unreproducible.
5. **A2's lint tier** is upstream's and needs operator's call on whether main is allowed to carry `origin/main`'s lint debt.
   Nothing in the F track can close it.

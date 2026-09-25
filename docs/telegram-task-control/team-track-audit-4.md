# Audit 4: the H track

Auditor: a fresh agent with no part in the build, run on 2026-09-26.
Checklist: section 4 of [team-track-dev-brief.md](team-track-dev-brief.md), unchanged.
Range: `dc3e9de..HEAD`, where HEAD is `a23d1dd`.
Tasks in scope: H01, H01b, H02, H03, H04, H05, H06, H07, the TM4 handover build.
Tree: `/home/junaid/aw-audit4`, a detached-HEAD worktree of `/home/junaid/ai-workstation` at `a23d1dd`, installed with `npx -y npm@11 install`.

Nothing was pushed, no remote ref was written, no `git fetch` was run, no T2 or T3 tier was run, no live Telegram credential or paid provider was used, no agent was spawned, nobody was contacted, and no product code, test or fixture was changed.
`team.enabled` and `team.handoverEnabled` were not enabled.
The only file this audit writes is this report.

## 0. Result

**FAIL**, on five checks: **D1, D9, A1, A2 and A6**.
Ten checks pass: D2 to D8, A3, A4, A5 and A7.

No live product defect was found, and every H-track criterion that has an independent statement anywhere is met on main and green.
Two of the five failures are record-keeping (D1, D9), one is `implementation.md` having no TM4 entry at all (A6), one is A2's lint tier, which is entirely upstream's, and one is A1, where three of the eight tasks in range have no acceptance criteria written anywhere except the tracker row that is itself the evidence, and H07's close guard has server-tier proof only.

**jd's waivers of audit 3 do not cover this range** and were not applied to it.
The five failures here are judged on the H track's own evidence.

The sharpest single finding is not one of the five.
`e2e/tests/t1/tm4-handover.spec.ts:382-384` records that closing a thread while a handover is live is unasserted "because whether `/close` may happen at all mid-handover is M-4's open question and is jd's to rule".
jd ruled the next day, H07 built the guard, and nobody corrected the comment, so the only end-to-end spec for handover still tells its reader the question is open.
Detail under A1, H07.

Tier counts measured by this audit, on its own worktree, not taken from any document:

| Tier | Result |
| --- | --- |
| Typecheck, four workspaces | exit 0 |
| Web lint | **exit 1**, `19 problems (17 errors, 2 warnings)` |
| Full server suite, three times against one pinned root, database and settings file | `# pass 618  # fail 0` each time |
| Full T1 suite | `127 passed (23.0m)`, 0 failed, 0 skipped, 0 flaky |
| Burn-in, `tm4-handover.spec.ts` at 3 repeats | `9 passed (8.6m)`, 0 flaky |
| Shared | `# pass 91  # fail 0` |
| Web | `# pass 94  # fail 0` |
| e2e workspace unit suite | `# pass 46  # fail 1` once, then `# pass 47  # fail 0` seven times. See finding 6 |

**What the green tiers do and do not cover** is in section 3, finding 1, and it is the single most important thing in this report.

## 1. Discipline, D1 to D9

### D1: every task has its own worker agent id and no id repeats. **FAIL**

The agent id column of the H rows in [team-burndown-tracker.md](team-burndown-tracker.md), read as written:

| Task | Recorded id | Verdict |
| --- | --- | --- |
| H01 | `worker/H01` | ok |
| H01b | `` `worker/H01` resumed `` | **repeats H01's id** |
| H02 | `worker/H02` | ok |
| H03 | `worker/H03` | ok |
| H04 | `worker/H04` | ok |
| H05 | `worker/H05` | ok |
| H06 | `worker/H06` | ok |
| H07 | `one worker` | **not an id** |

Six of eight pass.
Two do not, and they fail in the two different ways audit 3 found on the F track.

H01b is not a fresh context by its own record: the cell says the H01 worker was resumed, so the check's stated purpose, that each task ran in a fresh context, is not met for H01b and is recorded as not met rather than argued away.

H07's cell is `one worker`, which names no agent.
The tracker itself anticipates this: the section "jd's waivers of audit 3" records that F00B's identical defect was fixed to `worker/F00B`, and that **"H07 is inside audit 4's range, so it is left as it stands rather than corrected ahead of its own auditor, and reported to jd instead."**
That is the right call and it does not change the check's result.

jd's execution-model decision of 2026-09-20 authorises the orchestrator running tasks directly, and jd's waiver of 2026-09-25 covers four F-track rows.
Neither covers H01b or H07.

### D2: every task landed from its own `tm/<id>-*` branch by fast-forward, and the range is linear. **PASS**, with the literal reading recorded

Literal check, as the evidence column words it:

```
$ git log --merges --format='%h %an %s' dc3e9de..HEAD
a641b0c Junaid Reconcile main with origin/main by merge, not rebase
b855ec2 Yousef Nourizadeh Merge pull request #2 from Youseidon/pipeline-continuation-loop
fa92586 Yousef Nourizadeh Merge pull request #1 from Youseidon/pipeline-status-model
```

Not empty, so the literal check fails.
This is the reading I was given as a carried-forward correction and it is recorded here in full rather than summarised: none of the three is a task landing.
`a641b0c` is the reconcile jd ordered on 2026-09-22; `b855ec2` and `fa92586` are upstream author Yousef's own pull-request merges, which arrived inside his 29 commits.

Honest check, over the H track's own span:

```
$ git log --merges 5b00ebe~1..1f01acd
(no output)
```

Every commit from H01's first to H07's last has exactly one parent, so the whole H track is linear.
Each task's tip is an ancestor of the next, confirmed pairwise with `git merge-base --is-ancestor`, which is the fast-forward property:

```
ok 5b00ebe -> 59a19a7   ok 59a19a7 -> 24c257d   ok 24c257d -> d5a528e
ok d5a528e -> bb77210   ok bb77210 -> a68ae98   ok a68ae98 -> 04dca86
ok 04dca86 -> 1f01acd   ok 1f01acd -> HEAD
```

Every H row names a `tm/<id>-*` branch, which is what D2 asks for by name: `tm/H01-tm4-scenarios`, `tm/H01b-tm4-rulings`, `tm/H02-control-record`, `tm/H03-capture-and-offer`, `tm/H04-accept-claim-run`, `tm/H05-return-and-apply`, `tm/H06-handover-surface`, `tm/H07-refuse-close-while-live`.

One notation point that is not a defect but will trip a reader: the tracker's commit-range cells are inclusive of the first sha, so `013fec5..24c257d` means three commits, while the same string as git syntax means two.
Every start sha I checked is a real first commit of its task, for example `013fec5 Add TM-T0-6 red against a control-record skeleton`.

### D3: nothing was pushed. **PASS** on the honest reading, **FAIL** on the literal one

Both readings are recorded, per jd's ruling of 2026-09-22 recorded as gap M-3.

Literal: `origin/main` is still the starting commit the tracker recorded. **FAIL.**

```
$ git rev-parse origin/main
4fd0e655ee7fafdd9db65d253ac7628c415e8639
```

The tracker records `origin/main: 44ad5882fa792240860aff5468efd229a0b619c0`.
It moved because a worker ran `git fetch --all` while the real remote had moved on, which is a remote read, not a write.

Honest: no commit of ours is reachable from any remote ref. **PASS.**

```
$ git branch -r --contains HEAD
(no output)
```

Nothing has ever been pushed from this machine, and this audit pushed nothing, fetched nothing and wrote no remote ref.

### D4: each task's commits touch only what its card covers. **PASS**

Every commit in the H range was read with `git show --stat` against its task row.
The 29 H-track commits are:

| Task | Commits | What they touch |
| --- | --- | --- |
| H01 | `5b00ebe` | `docs/e2e-scenarios/tm4.md` only, 152 insertions, documentation only as the card requires |
| H01b | `59a19a7` | `docs/e2e-scenarios/tm4.md` only |
| H02 | `013fec5`, `55e108c`, `24c257d` | `teamControlRecord.ts` and its test, `workspaces.ts`, `taskControl.ts`, `teamItemViews.ts`, `shared/src/index.ts` |
| H03 | `7d3fc6f`, `c1c0d4f`, `d5a528e` | `teamHandoverCapture.ts` and its test, `teamControlRecord.ts` |
| H04 | `1ad7dcc`, `b4801e4`, `a150b7b`, `53dfb10`, `bb77210` | `teamHandoverRun.ts`, `settings.ts`, `taskControl.ts`, `taskControlRenderer.ts`, `workspaces.ts`, `telegramSummary.test.ts`, the T1 spec |
| H05 | `123920e`, `72b68de`, `d1d075d`, `ec2f6cc`, `99132b4`, `a68ae98` | `teamResultApply.ts`, `teamHandoverCapture.ts`, `teamHandoverRun.ts`, `teamControlRecord.ts`, `taskControlRenderer.ts`, `workspaces.ts`, the T1 spec |
| H06 | `2926149`, `98cf162`, `b6b54cb`, `67f4cf5`, `8c3599e`, `8062cb2`, `04dca86` | `teamHandoverSurface.ts`, `integrations/telegram/runtime.ts` and `liveFormat.ts`, `workspaceApi.ts`, `web/components/tasks/*`, `web/lib/workspacesApi.ts`, `scripts/verify-handover-browser.mjs`, `web/package.json`, the T1 spec |
| H07 | `d300b05`, `f1050b7`, `1f01acd` | `teamControlRecord.ts`, `teamHandoverSurface.ts` and its test, `integrations/telegram/runtime.ts`, `taskControl.ts` and its test, `teamResultApply.test.ts` |

Nothing in the list is outside its task's subject.
Two items are worth naming rather than passing silently:

- H06's `98cf162` adds `scripts/verify-handover-browser.mjs` and two `web/package.json` scripts alongside the control itself.
  That is the control's own two-width evidence, not an unrelated fix, and the gap register records it under L-4.
  I ran it; see A1, H06.
- H07 is purely additive, which the tracker claims and which reproduces exactly:

```
$ git diff --shortstat d300b05^ 1f01acd
 7 files changed, 393 insertions(+)
```

H02's and H03's first commits each carry a test file **plus** a skeleton module that throws from every function, so their red is partly a stub red rather than wholly a behavioural one.
The tracker's log of 2026-09-21 says exactly that, unprompted, for both.
It is recorded here because it is a real limit on what "red first" proved, not because it is hidden.

### D5: commit messages are imperative and carry no co-author line. **PASS**

All 29 H-track subjects are imperative, for example `Build the item control record on refs/aw/items/<item>/control`, `Open the handover gate behind team.handoverEnabled`, `Refuse /close while a handover is live`.

```
$ for c in <the 29 H commits>; do git log -1 --format='%B' $c; done \
    | grep -inE 'co-author|co-authored|generated with|claude'
(no output, exit 1)
```

### D6: no task worktree or task branch is left behind. **PASS**

```
$ git worktree list
/home/junaid/ai-workstation  39d7935 [main]
/home/junaid/aw-audit4       a23d1dd (detached HEAD)

$ git branch --list 'tm/*' 'fix/*'
(no output)
```

The only extra worktree is this audit's own.
No `tm/*` or `fix/*` branch remains.

### D7: the slice's scenario table was committed, and jd's skim recorded, before that slice's first product code commit. **PASS**

```
93:1f96657 2026-09-21 07:13:58 Mark H01 in progress
94:5b00ebe 2026-09-21 07:19:07 Add the TM4 handover scenario table
95:8bf767d 2026-09-21 10:00:47 Settle the ref namespace, the offer deadline, row 4.4 and the T0 mapping
96:59a19a7 2026-09-21 10:01:13 Fold jd's four TM4 rulings into the scenario table
99:013fec5 2026-09-21 11:52:44 Add TM-T0-6 red against a control-record skeleton
```

`docs/e2e-scenarios/tm4.md` lands at `5b00ebe`, jd's skim and the four rulings it produced are recorded at `8bf767d` and folded into the table at `59a19a7`, and the first H-track product code commit is `013fec5`, two hours later.
Ancestry confirms the order rather than the timestamps alone: `5b00ebe` and `59a19a7` are both ancestors of `013fec5`.

### D8: every jd stop point has jd's answer recorded; no worker contacted jd or spawned an agent. **PASS**

The H track has one stop point marked **jd** in the brief: H01's skim.
It is recorded in the tracker's log of 2026-09-21 and in `tm4.md` itself, which carries the four rulings it produced.
The two later rulings the H track depends on, ruling 6 (the decline outcome) and ruling 7 (refuse `/close` while a handover is live), are recorded in the log of 2026-09-22 and in section 8 of [handover-rules.md](handover-rules.md), both marked **Ruled**.

Nothing in the range records a worker contacting jd or Yousef, or spawning an agent.
One constraint deviation is recorded in the tracker and is repeated here rather than left in a log nobody rereads: the H05 worker ran `git fetch --no-tags /home/junaid/ai-workstation main` once inside its worktree to locate `main` before rebasing, although its card said not to fetch in the product repository, and **reported it unprompted**.
It is a local path, no network and no remote write, and `origin/main` is unmoved by it.
A constraint that is bent and reported is worth more than one that is bent quietly, so this is recorded as a deviation and not as a failure of D8.

### D9: the tracker agrees with git. **FAIL**

The first half passes.
Every `done` H row names commits that exist on main, and every sha in every H row resolves and is an ancestor of HEAD.

The second half fails, narrowly and for a reason that is not the H track's.

```
$ git rev-list dc3e9de..HEAD | wc -l
186
$ ... of which by author:  157 Junaid, 29 Yousef/Youseidon
```

Yousef's 29 are out of range rather than unexplained, as I was given and as gap M-3 records.
Of the 157 that are ours, 90 are named by a tracker row and **67 are named by none**.

The tracker's stated exception, in the section "Commits in the F window that belong to no row", covers 16 of the 67, and **I verified its own claim rather than accepting it**, with the command the tracker itself gives:

```
$ for c in 4bfd183 40366b2 3eb9b69 0cd9651 0547644 6ef7378 6303e01 744ce79 \
           86fab96 d7273fa 53310c7 8039fcc cadb207 25b64d9 5554c06 bb4121c; do
    git show --name-only --format='' $c
  done | sort -u | grep -v '^docs/telegram-task-control/'
(no output, exit 1)
```

The claim holds exactly: all 16 touch only `docs/telegram-task-control/`.

The remaining 51 are the orchestrator's own tracker, audit and documentation commits, which is D9's own written exception.
**Two of the 51 carry changes that exception does not describe:**

| Commit | Subject | The part no row covers |
| --- | --- | --- |
| `5db1a21` | Record H02 as done and start H03 | adds `worktrees/` to `.gitignore` alongside the tracker edit |
| `e6125c4` | Retire F05's invented scenario ids and register the gap | edits `server/test/telegramLiveRuntime.test.ts`, renaming two test cases from `TM-T1-8` and `TM-T1-9` to `B8` |

```
$ git log --format='%h %s' dc3e9de..HEAD -- .gitignore
5db1a21 Record H02 as done and start H03

$ git show --stat --format='' e6125c4 | tail -4
 .../team-burndown-tracker.md |  3 ++-
 .../team-gap-register.md     | 27 ++++++++++++++++++++++
 server/test/telegramLiveRuntime.test.ts | 16 +++++++++--
```

`e6125c4` is a change to a **test file** that belongs to no row and is outside the stated documentation-only exception.
It is F-track remediation of audit 3's sharpest finding, done on jd's ruling of 2026-09-25, and it is a good change.
It still means the check's own sentence, "every commit on main in the range belongs to a row, apart from the orchestrator's own tracker and audit commits", is false as written.

Closing D9 costs one sentence: widen the stated exception to name these two commits and what they carry.

## 2. Acceptance criteria, A1 to A7

### A1: every acceptance criterion re-verified on main by the auditor. **FAIL**

Every criterion below was re-run or re-read by me on this worktree.
No worker report was available to me and no tracker cell was taken on trust.

**Three of the eight tasks in range have no acceptance criteria written anywhere except the tracker row that is itself their evidence.**
[team-burndown-dev-brief.md](team-burndown-dev-brief.md) section 5 gives a card with criteria for G01, H01, H02, H03, H04 and H05 and for nothing else.
`grep -n "H06\|H07\|H01b" team-burndown-dev-brief.md` returns nothing.
H01b, H06 and H07 were opened after the brief was written, H06 against gap C1 and H07 against jd's ruling 7, and their criteria live only in the gap register entry and in the orchestrator's own row.
A1 exists precisely to stop a tracker row standing in for a criterion, so for these three the check is **unverifiable as written**.
What I could do, and did, is verify every factual claim those three rows make; all of them reproduced.

#### H01, TM4 scenario table. Criteria met.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Commit `docs/e2e-scenarios/tm4.md` | PASS | `git show --stat 5b00ebe`: `docs/e2e-scenarios/tm4.md \| 152 ++++` , one file |
| Specifies TM-T0-6, TM-T0-7, TM-T1-H1 to H3 in the TM3 shape | PASS | `grep -oE "TM-T[01]-[0-9A-Za-z-]+" tm4.md \| sort \| uniq -c` gives TM-T0-6 (7), TM-T0-7 (8), TM-T1-H1 (6), TM-T1-H2 (5), TM-T1-H3 (6), plus TM-T0-5-29 (2) |
| Covers the open call's simultaneous accept | PASS | `tm4.md:112`, first clause of TM-T1-H2 |
| Covers a partial return by a receiver who cannot finish | PASS | `tm4.md:112`, fifth clause |
| Covers the proof required before a requester reacquires ownership | PASS | `tm4.md:112`, sixth clause |
| Covers the capture preview's secret warning | PASS | `tm4.md:86` and `tm4.md:99` |
| No product code in the commit | PASS | the one file above |
| jd's skim | PASS | tracker log 2026-09-21 and commit `8bf767d` |

Deviation, recorded in the row and reproduced here: the worker added `TM-T0-5-29` unasked, on the precedent that every prior migration has one.

#### H01b, folding jd's four rulings in. Claims verified; no card exists.

`59a19a7` touches `tm4.md` only.
Each claim the row makes reproduces: the ref subsection is settled and carries the LG-1 evidence; TM-T0-6 asserts the custom ref with no conditional; the 24-hour offer deadline is recorded at `tm4.md:58-60` **and attributed to the orchestrator's proposal accepted by jd** rather than to jd unprompted; the corrected form of handover rule 4.4 is asserted positively inside TM-T1-H2's sixth case.
The deadline is real in the product, not only in the table: `teamControlRecord.ts:106` is `export const OFFER_DEADLINE_MS = 24 * 60 * 60 * 1000`, with `expire_offer` guarded by it at lines 253 and 259.

#### H02, the item control record. Criteria met.

| Criterion | Result | Evidence |
| --- | --- | --- |
| `refs/aw/items/<item>/control` with `state.json` and `events/<command id>.json` | PASS | `teamControlRecord.ts:412` builds the ref; `:691` writes the tree as `events` plus `state.json`; `:730` and `:740` read them back |
| Fetch and compare-and-swap write, fast-forward or rejection only | PASS | `:746` and `:805` are `update-ref <ref> <next> <expected>`; `:799` is a plain `push` with no `-f`; `:803` classifies `non-fast-forward\|fetch first\|rejected` as a lost race |
| `item_link.control_head` finally written and read | PASS | written at `teamControlRecord.ts:542` and `teamHandoverRun.ts:467` via `updateItemControlHead` (`workspaces.ts:4261`); read back at `workspaces.ts:4268` |
| On an uncertain push, fetch and look for the command id before retrying | PASS | `:619-628`, `control_push_uncertain`, with the comment "never by a blind retry, so no event is ever recorded twice" |
| On a lost race, re-read and re-validate rather than re-applying | PASS | `:604` and `:617`, both `control_conflict` |
| Owns TM4's migration, number 29 or later, adding the seven designed actions | PASS | `workspaces.ts:1748-1796`. Renumbered to **52** by the reconcile. The widened CHECK lists `publish_offer`, `accept_offer`, `decline_offer`, `withdraw_offer`, `return_work`, `apply_result`, `request_changes`, matching `HANDOVER_ACTIONS` at `shared/src/index.ts:1573` |
| A table rebuild preserves every row and index | PASS | all 17 columns listed on both sides, both table CHECKs, all three foreign keys, the index recreated, `foreign_keys` disabled only inside the transaction with a `finally`, and `foreign_key_check` asserted afterwards |
| TM-T0-6 passes | PASS | `test/teamControlRecord.test.ts`: `# tests 15  # pass 15  # fail 0` |

#### H03, capture and offer. Criteria met.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Snapshot commit through a temporary index | PASS | `teamHandoverCapture.ts:218`, `:231` and `:529` all set `GIT_INDEX_FILE` before `write-tree`; `:200` explains the copy of `.git/index` |
| Branch `aw/handover/<item>` pushed | PASS | `teamControlRecord.ts:417` mints the name; `teamHandoverCapture.ts:624` is the push seam |
| Control record written as `OFFERED` with epoch 1 and the requested provider and model | PASS | `:717` "Only then publish OFFERED referencing them"; `:739-740` carry `requestedProvider` and `requestedModel` |
| Naming no receiver | PASS | `:673-674`, `/** The offer is an open call: it names no receiver (ruled 2026-09-20). */ receiver: null` |
| Preview lists every uncommitted file by path | PASS | `:29` and the `files` array asserted by the T0 suite |
| Flags credential shapes, which take their own confirmation | PASS | `:606` `requiredConfirmations` becomes `["credential_exposure","publish"]` when anything is flagged; `:710` refuses publish with 428 `credential_confirmation_required` |
| TM-T0-7 passes | PASS | `test/teamHandoverCapture.test.ts`: `# tests 19  # pass 19  # fail 0` |

#### H04, accept, claim and run. Criteria met on main, unmet at merge.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Receiver accepts and claims | PASS | `teamHandoverRun.ts`, and the claim's compare-and-swap asserted in `teamHandoverSurface.test.ts:284` |
| Runs in a worktree | PASS | `teamHandoverRun.ts:582`, `git worktree add -q --detach <dir> refs/remotes/origin/<branch>` |
| Under their own provider | PASS | RTC-12's matrix at `teamHandoverRun.ts:43` onward; `:143` and `:171` both carry "An omitted requirement is not permission" |
| Requirement questions cross workstations while the requester is stopped | PASS | `teamHandoverRun.ts:701-712` routes a `requirement` question to the requester; asserted end to end by TM-T1-H1 |
| TM-T1-H1 and TM-T1-H2 pass | PASS **on main** | `127 passed (23.0m)` includes both, at 27.7s and 1.7m |
| Server tier 34/34 | PASS | `test/teamHandoverRun.test.ts`: `# tests 34  # pass 34  # fail 0` |

**Deviation, and it matters.** At H04's merge on 2026-09-21 this criterion was **not** met: both T1 rows were `test.fixme` and had never run, which the tracker's log records candidly and in full on the same day.
They run and pass now because H06 built the surface they need.
A1 asks for the state on main, and on main the criterion holds.
The lesson the tracker draws is the right one and is repeated here: a `fixme` nobody clears is the unasserted-claim shape this track exists to burn down.

#### H05, return and apply. Criteria met on main, unmet at merge.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Return | PASS | `teamHandoverRun.ts:d1d075d` records the Result contract; `teamResultApply.ts` reconstructs it |
| Apply by ordinary merge | PASS | `teamResultApply.ts:385`, `git merge --no-commit --no-ff` in an isolated integration checkout, no strategy option, no conflict resolved |
| Then task complete | PASS | asserted end to end by TM-T1-H3 |
| TM-T1-H3 passes | PASS **on main** | in the 127, at 39.1s |
| The full T1 suite passes | PASS | `127 passed (23.0m)`, 0 failed, 0 skipped, 0 flaky |
| Burn-in at 3 repeats on the H scenarios | PASS | `9 passed (8.6m)`, 0 flaky |
| Server tier | PASS | `test/teamResultApply.test.ts`: `# tests 25  # pass 25  # fail 0`. The row claims 23; H07 added two to the same file, which accounts for the difference exactly |

Same deviation as H04: none of the last three held at H05's merge.
They were parked into Phase V by jd's instruction of 2026-09-20, and Phase V ran them.

#### H06, the handover surface. Claims verified; no card exists.

Its criteria are gap **C1**'s three named joins, which the register states as facts confirmed by the orchestrator.
I re-checked each one against main:

| C1's claim, negated by H06 | Result | Evidence |
| --- | --- | --- |
| `workspaceApi.ts` contains `handover` zero times | now six routes | `workspaceApi.ts:288`, one regex over `begin\|preview\|publish\|review\|apply\|request-changes` |
| `runtime.ts` never calls `registerHandoverTapHandler` | now called from `startSession` | `runtime.ts:666` is `startSession`, `:678` calls `control.registerHandoverTapHandler(...)` |
| Nothing schedules a control-record poll | now a third loop | `runtime.ts:871` `pollControlRecords(...)`, `:879` sleeps `controlReadIntervalMs`, default 5 seconds at `:75` |
| The three cards render for Telegram | PASS | `integrations/telegram/liveFormat.ts`, added whole by `8c3599e` |
| A requester control on the work-item detail | PASS | `web/components/tasks/HandoverControl.tsx`, 238 lines |
| Both settings still default false | PASS | `settings.ts:287-305`, `team.enabled` and `team.handoverEnabled` both `fallback: false`; `git diff --name-only 2926149^ 04dca86 \| grep -c settings.ts` is 0 |
| The two-width check | PASS, and **reproducible** | `cd web && npm run verify:handover-browser` prints `PASS: the handover control fits 390px and 1280px, states which capability is off, and refuses Publish until a flagged credential shape is confirmed.`, exit 0 |

The two-width rig is the right answer to audit 3's L-4 complaint and I want to be precise about what it proves.
It renders `HandoverControlView` into headless Chromium at 390 and 1280 with a hand-written CSS shim and asserts no horizontal overflow, the refusal wording, the flagged path and that Publish stays disabled until the exposure is confirmed.
It proves the **component's** layout and gating.
It does not open the real Next.js page, so it does not prove the control's placement inside the work-item detail at either width.

#### H07, refuse `/close` while a handover is live. Guard met at the server tier; **no end-to-end proof.**

Its criteria are jd's ruling 7 of 2026-09-22, recorded in the tracker log and as ruling 7 in section 8 of [handover-rules.md](handover-rules.md).

| Criterion | Result | Evidence |
| --- | --- | --- |
| `/close` refused while a handover is live | PASS at the server tier | `taskControl.ts:360-363`, rejects with `handover_live` and `liveHandoverCloseRefusal(live)` |
| The guard stands **before** `revokeItemGrants` and `closeItemLink` | PASS | the guard is line 362; `revokeItemGrants` is 364 and `closeItemLink` is 365 |
| Nine states refuse, five allow | PASS | `LIVE_HANDOVER_STATES` at `teamControlRecord.ts:59-62` lists nine of the fourteen in `CONTROL_STATES` at `:24-27` |
| No migration needed, `settings.ts` untouched, purely additive | PASS | `git diff --shortstat d300b05^ 1f01acd` is `7 files changed, 393 insertions(+)` |
| Server tier green | PASS | `test/taskControl.test.ts` `# pass 12`, `test/teamResultApply.test.ts` `# pass 25`, `test/teamHandoverSurface.test.ts` `# pass 17` |
| End to end | **NOT PROVEN** | no T1 row exercises the close guard |

I was told to treat this as a known end-to-end coverage gap rather than as covered, and the evidence supports that reading exactly.
`grep -rn "handover_live" e2e/` returns nothing, and `tm4-handover.spec.ts` never closes a thread.
The tracker's log of 2026-09-22 says the same in the worker's own words, and adds a second limit: the `/close` **text** command still mints its card and refuses on the tap rather than instead of the card.

**The T1 spec's own explanation of this gap is now false**, which is worse than the gap and is the single sharpest thing I found.
`e2e/tests/t1/tm4-handover.spec.ts:382-384` reads:

> Not asserted here, and recorded rather than implied: B28, closing or leaving the Telegram thread while a handover is live, **because whether `/close` may happen at all mid-handover is M-4's open question and is jd's to rule**

`git blame` puts that comment in `04dca86`, H06, on 2026-09-21.
jd ruled on it the next day, M-4's rule 4.5 is recorded **CLOSED** in the gap register, and H07 shipped the guard.
H07 did not update the comment, so the spec still tells its next reader that the case is unassertable pending a ruling that has already been made.
That is the same failure mode as an invented scenario id: a test file asserting something about coverage that is not true.



Two further H07 facts, both recorded rather than buried, both confirmed by me:

- `closeAfterHandover` at `server/src/teamHandoverRun.ts` permits a close in `OFFERED`, `WAITING_INPUT`, `PAUSED` and `RETURNED`, which ruling 7 calls live.
  H07 tried the same guard there, broke an H04 assertion, and reverted the whole attempt rather than weakening it.
  Registered as gap **M-7**, still open.
  It is not urgent because the function has no production caller, which I confirmed independently: `grep -rn "closeAfterHandover" server/src/ web/ e2e/` finds only its definition and its tests.
- The refusal wording names the item and what is outstanding, and deliberately does not invent a holder for `RETURNED` and `APPLYING`, where the record no longer carries one.

#### Why A1 is a FAIL and not a PASS

Five of eight tasks (H01, H02, H03, H04, H05) have criteria stated independently of the tracker, and every one of those criteria is met on main and re-verified here.
Three of eight (H01b, H06, H07) have no such statement, so the check's central demand, verification against something other than the row, cannot be satisfied for them.
H07 additionally has no end-to-end proof of the behaviour jd ruled on, which is the one part of this range with a user consequence behind it.

That is what a FAIL means here: a record and coverage failure, not a defect.

### A2: typecheck, lint, the full server suite and the full T1 suite pass on main. **FAIL on the lint tier only**

| Tier | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0, shared, server, web, e2e |
| Lint | `cd web && npx eslint .` | **exit 1**, `✖ 19 problems (17 errors, 2 warnings)` |
| Server suite | `cd server && AGENT_CONSOLE_REPO_ROOT=<pinned> AGENT_CONSOLE_DB=<pinned> SETTINGS_FILE=<pinned> node --import tsx --test --test-concurrency=1 test/*.test.ts`, three times | `# tests 618  # pass 618  # fail 0` each time, at 113.3s, 103.5s, 101.8s |
| Full T1 | `cd e2e && npx playwright test --project=t1` | `127 passed (23.0m)`, 0 failed, 0 skipped, 0 flaky |

The server suite was run three times against **one** unchanged root with `AGENT_CONSOLE_DB` and `SETTINGS_FILE` pinned as well as `AGENT_CONSOLE_REPO_ROOT`, because the workspace test script derives a database path from the shell pid and three plain invocations would each get a fresh database.
That is the stricter reading and it passes.
618 is the bar, as I was given, and it is what I measured.

Lint attribution, re-derived rather than accepted.
The 19 problems sit in seven files, and `git log` on each shows the authorship:

| File | Errors | Warnings | Authors |
| --- | --- | --- | --- |
| `components/activity/ActivityView.tsx` | 1 | 0 | Youseidon, plus the reconcile merge |
| `components/pipeline/DefinitionOfDonePanel.tsx` | 1 | 0 | Youseidon |
| `components/pipeline/PipelineBoard.tsx` | 9 | 2 | Youseidon |
| `components/pipeline/PipelineDashboard.tsx` | 1 | 0 | Youseidon |
| `components/pipeline/StatusCatalogPanel.tsx` | 1 | 0 | Youseidon |
| `components/pipeline/SuiteFallbackEditor.tsx` | 1 | 0 | Youseidon |
| `components/programs/ProgramDraftPanel.tsx` | 3 | 0 | Youseidon, two commits |

The correction I was given holds in every particular: 17 errors and 2 warnings, not 11 warnings, and the errors are not confined to `components/activity/` and `components/pipeline/`, because three are in `ProgramDraftPanel.tsx`.
No H-track file lints with an error; `HandoverControl.tsx`, `handoverControl.test.tsx` and `TeamThreadPanel.tsx` are all clean.

jd waived this tier for the F track on 2026-09-25 and registered it as L-12.
**That waiver does not extend to this range**, so A2 is recorded as FAIL on the lint tier, exactly as audit 3 recorded it, and nothing in the H track can close it.

### A3: burn-in at 3 repeats passes for every T1 scenario the range added. **PASS**

The range added exactly three T1 scenarios, TM-T1-H1, TM-T1-H2 and TM-T1-H3, all in `e2e/tests/t1/tm4-handover.spec.ts`.

```
$ cd e2e && npx playwright test --repeat-each=3 --max-failures=1 --project=t1 tests/t1/tm4-handover.spec.ts
  ✓  1 … TM-T1-H1 … (27.7s)   ✓  4 … (27.7s)   ✓  7 … (27.9s)
  ✓  2 … TM-T1-H2 … (1.7m)    ✓  5 … (1.7m)    ✓  8 … (1.7m)
  ✓  3 … TM-T1-H3 … (39.2s)   ✓  6 … (39.3s)   ✓  9 … (38.9s)
  9 passed (8.6m)
```

Zero flaky, zero retries, and the per-repeat times are within a second of each other, which is itself evidence there is no timing race in these rows.

I also swept the T1 tree for anything skipped: `grep -rn "test.fixme\|test.skip\|\.only(" e2e/tests/t1/` returns one **comment** in `tm4-handover.spec.ts` explaining that these rows used to be `fixme`, and no live skip anywhere.

### A4: real checks due in the range are recorded as H-TM rows with date and outcome. **PASS**, with the check's shape recorded

The check names audit 1's and audit 2's real checks and does not name audit 4's, so it does not fit this range as written.
Recording both the literal result and the substance:

Literally, no check the sentence names is in my range, so nothing is missing and the check passes vacuously.

Substantively, the H track's only real check is **LT-5**, and the brief itself makes it optional and blocked: "LT-5 is optional and comes after H05. It cannot run until F10 gives instance B its own clone."
F10 was never started and is deferred in gap register L-1.
So no real check was due, and none is missing.

One thing is worth flagging even though it does not fail the check.
[human-verification.md](human-verification.md) carries four H-TM rows, `H-TM-LT1`, `H-TM-LG1`, `H-TM-LT3` and `H-TM-LT4`, and the last two are **deferral** rows recording that the check did not happen and why.
TM4 has no such row at all: `grep -in "LT-5" human-verification.md` returns nothing.
The pattern the earlier slices set was to record the deferral rather than the silence, and TM4 broke it.

### A5: the section 5 invariants hold. **PASS**

| Invariant | Result | Evidence |
| --- | --- | --- |
| Personal control (L1 and L3) behaves exactly as before | PASS | the full T1 suite at 127, which is the brief's own stated proof, and includes every `l1-*` and `l3-*` spec green |
| No Telegram token shared, sent, logged, stored, returned or committed | PASS | `S-L3-F1-22` and `l1-capability-badge.spec.ts` both green inside the 127; repository sweep `git grep -nE "[0-9]{8,10}:AA[A-Za-z0-9_-]{32}"` finds one file, `server/test/telegramSummary.test.ts`, whose hit is the redaction test's own dummy corpus |
| `team.enabled` off by default | PASS | `settings.ts:287-294`, `fallback: false`; `tm1-team-default-off.spec.ts` and `l1-default-off.spec.ts` green |
| `team.handoverEnabled` off by default | PASS | `settings.ts:297-305`, `fallback: false`; `teamHandoverSurface.test.ts:348` asserts both defaults and that each route names the capability that refused it |
| Every state change is an action reference with a receipt and a revision check | PASS | the seven handover actions route through `task_control_action` and `assertHumanInputRevision`; `taskControl.ts:299-316` refuses a tap with `team_disabled`, `handover_disabled`, `invalid_action` or `action_not_available` before any state moves |
| Forum topics are not used | PASS | `runtime.ts:126` states it; item threads are C1's anchors and replies |
| Each slice owns its migration, and a table rebuild preserves every row and index | PASS | see H02 above |

A repository-wide check that no committed settings file turns either flag on: `git grep -n '"team.enabled": true'` outside tests and fixtures returns nothing.

### A6: `implementation.md` has an entry per slice in the range with exact commands and counts. **FAIL**

There is **no TM4 or H-track entry in `implementation.md` at all**.

```
$ grep -n "TM0\|TM1\b\|TM2\b\|TM3\b\|TM4\b" docs/telegram-task-control/implementation.md
21:  Team track TM0/TM1 close-out before audit 1, 2026-09-17:
187: Team track TM2 close-out, 2026-09-18:
214: Team track TM3 close-out, 2026-09-18:
1087:(TM4, plan section 3b and the definition of done for R-A).
…
```

Every line mentioning TM4 is forward-looking prose from the G01 and G02 records, written before the H track ran.
Section **6e** is a full close-out with commands and counts, and it is titled "F track close-out" and covers F00A to F10 only.
It was added on 2026-09-25 to close audit 3's identical A6 failure on the F track, and the H track was not given the same treatment.

This is the exact defect audit 3 found, one track over, and it is cheap to close: an H-track section in the shape of 6e, carrying the counts in section 0 of this report.

### A7: any design fact a real check disproved is corrected in the design, the plan and the fake, with jd's approval recorded. **PASS**

No live check ran in this range, so nothing was disproved by one.
Three design facts were disproved by work inside the range, and all three were corrected with jd's ruling recorded:

| Fact | Disproved by | Correction, with jd's approval |
| --- | --- | --- |
| The control branch sits at `aw/control/<task-id>` under `refs/heads/` ([protocol.md](protocol.md) section 4) | H01, against `teammate-design.md` and the LG-1 evidence | settled to `refs/aw/items/<item>/control`; tracker log 2026-09-21, folded into `tm4.md` at `59a19a7` |
| An offer never expires on its own (handover rules row 4.2) | H01, against protocol.md's own Offer record | [handover-rules.md](handover-rules.md):109, marked **Ruled**, corrected to 24 hours, with the value attributed to the orchestrator's proposal accepted by jd |
| A requester completing their task locally stops the receiver's run (handover rules row 4.4) | H01, as remote Stop across workstations, an excluded mechanism | handover-rules.md:135, marked **Ruled**, corrected to a recorded cancel request; asserted positively in `tm4.md:112` |

The fake was not contradicted by anything in this range.
Rulings 6 and 7 of 2026-09-22 are both recorded in section 8 of handover-rules.md, and section 8's title was changed from "The five rulings" to seven, so the document does not carry a stale count.

## 3. Findings the numbered checks do not name

**1. What the green tiers cover, and what they do not.**
This is the finding to carry forward, and it is not a criticism of the work.
The T1 suite is green at 127 and it proves that **the Telegram surface** of handover is wired to a person: `tm4-handover.spec.ts` publishes through the HTTP routes and then drives real taps on cards in the fake group, and the receiver's whole path is tap-driven.
It does **not** open a browser.
`grep -nE "page\.|browser|goto|getByRole|locator" e2e/tests/t1/tm4-handover.spec.ts` returns nothing.
So the requester's **web** control, `HandoverControl.tsx`, has no end-to-end proof that it is wired to the routes it calls: its evidence is a React unit test that renders it from props and the two-width rig that renders it into Chromium in isolation.
That is a strictly smaller claim than "TM4 reaches a user", and the gap is the same shape as the one gap M-9 found: a surface that compiles, lints, passes its unit tests and is reached by nobody.
Three defects of exactly that kind survived four tasks of server-tier green in this very track, and two of them, H06's epoch-dedupe and group-actor defects, were found only by driving a real tap.
Alongside it, **H07's close guard has server-tier proof only**, so the behaviour jd ruled on for data-loss reasons has never been exercised end to end, and the spec comment that explains why still cites an open question jd closed the following day.

**2. `implementation.md` is missing TM4 entirely**, which is A6 above but is worth naming separately because the file is what a later reader quotes.
As it stands, a reader of `implementation.md` would conclude the Team track ended at TM3 plus a defect burn-down.

**3. Stale figures in the gap register that a reader will quote.**
Three live entries carry numbers that later documents supersede, with no marker saying so:

- `team-gap-register.md:183`, inside **M-3**, still reads "server 486/617, four workspaces typecheck clean, web lint 17 errors and 11 warnings … This is why V4 is blocked on M-8."
  All three are superseded: the server suite is 618, the lint line is 17 errors and 2 warnings, and M-8 is closed.
- `team-gap-register.md`, inside **C2**'s V2 table, records "Full server suite 417/417" and "Lint | exit 0, **0 errors**, 5 warnings".
  Both were true before the reconcile and neither is true now; the lint line in particular now contradicts L-12 in the same file.
- `team-burndown-tracker.md:304` still reads "17 errors and 11 warnings", though line 317 withdraws it.
  That one is a dated log entry and is defensible; the two register entries are not, because the register is the answer to "what is left".

**4. The tracker's H-row table is broken into three by blank lines.**
Lines 117 and 119 of `team-burndown-tracker.md` are empty, between the H05 and H06 rows and between H06 and F00B.
In Markdown that ends the table and starts new ones, so H06 renders as a one-row table with no header and the rows after it render as a third.
A one-character fix, and worth doing because the tracker is the auditor's primary evidence.

**5. Cosmetic staleness left by the migration renumber.**
H02's migration is now 52, but the rebuilt table is still named `task_control_action_v29` and the failure message still reads `Migration 29 left N foreign-key violation(s)` (`workspaces.ts:1763`, `:1795`).
Harmless, and it will read as a contradiction to the next person who greps for migration numbers.

**6. A flake in the e2e workspace unit suite, observed once and not reproduced.**
`npm run test --workspace e2e` returned `# pass 46  # fail 1` on my first invocation and `# pass 47  # fail 0` on seven consecutive re-runs afterwards.
I cannot name the failing test: the first invocation's output was filtered to the summary lines and the detail was lost, and I could not reproduce it to recover it.
Recording it as an unreproduced flake rather than as a pass or a failure.
Two things about it are worth the next session's attention: this suite is in **no tier A2 names** and in no root `npm test` (root `test` runs shared, server and web only), and its files are harness self-tests that start real servers, so a flake here is a flake in the thing every T1 run depends on.
What would make it verifiable: run `npm run test --workspace e2e` a few times with full output retained, or add it to a tier something actually watches.

**7. No invented scenario id in the H track.**
Audit 3's sharpest F-track finding was a test named for an id that exists in no table or plan.
I checked the same thing here.
Every id used as a test-name prefix in the five H-track server test files, `TM-T0-6`, `TM-T0-7`, `TM-T0-5-29`, `TM-T1-H1` to `H3`, `RTC-12`, `C1`, `H07`, `B26` and `Q9`, resolves to a real, documented id in `tm4.md`, `handover-rules.md`, the engineering plan or the gap register.
Stating the negative result explicitly, because it is evidence the lesson was learnt.

**8. The two open C3 surfaces are not in this range.**
Gap **C3**, the two Team surfaces still comparing `operationalState` to `AWAITING_RESPONSE` by hand, is open, unreproduced, ruled by jd to get its own task, and I did not touch or investigate it.
For the record: `teamItemViews.ts:169` is TM2's and `web/components/tasks/TeamThreadPanel.tsx:25` is F03's, so neither belongs to H01 to H07.
It is relevant to this audit only as the standing proof that a green suite at every tier is consistent with a broken user surface, which is why finding 1 is worded the way it is.

**9. What the T1 rows deliberately do not reach, recorded by the rows themselves.**
`tm4-handover.spec.ts` carries its own honest coverage comments, which I read rather than assumed.
The simultaneous accept by two receivers is not reachable, because the harness has one requester and one receiver and a requester does not accept their own open call; a third environment is what it would need.
Also unreachable there and recorded: the 2.5 minute Telegram drop, the quota partial return, a mid-run requirement question, and an edit failure after a recorded application.
`tm4.md`'s TM-T1-H2 row specifies all of these as `must`.
The scenario table therefore promises more than the test asserts, which is the brief's own trap "a `must` clause with no assertion" (section 7).
The difference is that here it is written down in the spec, in the register and in the tracker, rather than discovered by an auditor.
It is not a check failure, because the server tier does assert the record's half of the simultaneous accept, but it is the reason nobody should read `9 passed` as "TM-T1-H2 is covered".

## 4. How this audit was run

| Step | Command | Result |
| --- | --- | --- |
| Install | `npx -y npm@11 install` in `/home/junaid/aw-audit4` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, four workspaces |
| Lint | `cd web && npx eslint .` | exit 1, `19 problems (17 errors, 2 warnings)` |
| Lint, per-file attribution | `cd web && npx eslint . -f json`, then `git log` on each file | 7 files, all upstream-authored |
| Server suite, 3 times, one pinned root, database and settings file | `cd server && AGENT_CONSOLE_REPO_ROOT=<pinned> AGENT_CONSOLE_DB=<pinned> SETTINGS_FILE=<pinned> node --import tsx --test --test-concurrency=1 test/*.test.ts` | `# pass 618  # fail 0` at 113.3s, 103.5s, 101.8s |
| Full T1 | `cd e2e && npx playwright test --project=t1` | `127 passed (23.0m)`, 0 failed, 0 skipped, 0 flaky |
| Burn-in, A3 | `cd e2e && npx playwright test --repeat-each=3 --max-failures=1 --project=t1 tests/t1/tm4-handover.spec.ts` | `9 passed (8.6m)` |
| H02's tier | `node --import tsx --test test/teamControlRecord.test.ts` | `# pass 15  # fail 0` |
| H03's tier | `node --import tsx --test test/teamHandoverCapture.test.ts` | `# pass 19  # fail 0` |
| H04's tier | `node --import tsx --test test/teamHandoverRun.test.ts` | `# pass 34  # fail 0` |
| H05's and H07's tier | `node --import tsx --test test/teamResultApply.test.ts` | `# pass 25  # fail 0` |
| H06's tier | `node --import tsx --test test/teamHandoverSurface.test.ts` | `# pass 17  # fail 0` |
| H07's close guard | `node --import tsx --test test/taskControl.test.ts` | `# pass 12  # fail 0` |
| H06's two-width rig | `cd web && npm run verify:handover-browser` | exit 0, `PASS: the handover control fits 390px and 1280px …` |
| Shared | `npm run test --workspace shared` | `# pass 91  # fail 0` |
| Web | `npm run test --workspace web` | `# pass 94  # fail 0` |
| e2e workspace unit | `npm run test --workspace e2e`, eight times | `# pass 46  # fail 1` once, `# pass 47  # fail 0` seven times |
| Binary-file trap sweep | `file` over every tracked `.ts`/`.tsx` under `server/src`, `shared/src`, `web/components/tasks`, `e2e/tests/t1` | all text, so no grep of them was silently empty |

Everything else was `git` and reading files.
No T2 or T3 run, no push, no `git fetch`, no remote write, no flag enabled, nothing fixed.

Rig notes for the orchestrator.
`npx -y npm@11 install` still rewrote `package-lock.json` in this worktree; I restored it with `git checkout -- package-lock.json`, and `git status --short` is now empty apart from this report.
The harness was exclusive throughout: the server runs, the T1 run, the burn-in and the e2e self-tests were all serialised, never two at once.
The full T1 pass took **23.0 minutes**, inside the 25 the handover predicts; the first six tests take about 2.5 minutes of it and the remaining 121 take about 20, so the warning not to extrapolate from the opening files is correct and I did not.

## 5. What blocks what

A FAIL blocks the next task until a new task with its own worker fixes it or jd waives it in writing in the tracker, and the orchestrator reports the result to jd either way.
Ranked by what actually matters:

1. **H07's missing end-to-end row** is the only failure with product risk behind it.
   The behaviour jd ruled on is a data-loss guard, and it is proven only at the tier that this track has twice watched be green over a broken surface.
   One T1 case that closes a thread while a handover is live, asserting the refusal reaches the phone, closes it.
   H07 itself judged that a row belongs and left it to Phase V rather than writing it unasked, which was the right call for a worker and is now due.
   The same task should correct `tm4-handover.spec.ts:382-384`, which still says the case cannot be asserted because jd has not ruled, a day after jd ruled.
2. **A1's three cardless tasks** (H01b, H06, H07) need criteria written down somewhere other than the row that reports them.
   Cheapest honest fix: add the three to section 5 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md) with the criteria they were actually held to, or record in the tracker that they were opened without cards and why.
   This is a record fix, not a rebuild; nothing about the work changes.
3. **A6** is one section in `implementation.md`, in the shape section 6e already has, carrying the counts in section 0 above.
   It will trip every later reader until it exists.
4. **D1 and D9** are two cells and one sentence.
   H07's `one worker` needs an id or a stated reason, H01b's cell needs to say plainly that the H01 worker was resumed and that this is a repeat, and D9's stated exception needs to name `5db1a21` and `e6125c4` and what they carry beyond documentation.
5. **A2's lint tier** is upstream's, is identical to what jd waived for the F track, and nothing in the H track can close it.
   It needs the same ruling extended to this range, or it will fail every audit from here on.

Not blocking, and offered as maintenance: findings 3, 4 and 5 of section 3, which are stale figures and rendering defects in the two documents every future session reads first.

# Team Track Audit 1 Rerun

Date: 2026-09-17
Auditor: independent audit agent for T01-T10 plus T10R/T10V
Audited branch: `audit/team-track-audit-1-rerun`
Audited head: `9152b3f1e36f778fe96895e754b7f48843b4c9b3` (`Track T10V completion`)
Tracker start: `37236e0af1c68c0852f9ede90afeb0643b42a7c7`
Tracker origin start: `44ad5882fa792240860aff5468efd229a0b619c0`

Overall result: **FAIL**

The remediation fixed the original technical failures: the full server suite
passes 239/239, the full T1 suite passes 116/116, focused S-L1-04 burn-in passes
3/3, and the three TM1 rows pass 9/9 at three repeats.

Audit 1 still cannot pass because the required `team.enabled` default-off gate
does not exist in product code. Team UI and API routes are exposed whenever the
personal Telegram transport is selected. This fails A5 and the standing
criterion on every Team task. A6 also fails because `implementation.md` does
not contain the final full-suite 239/239 and 116/116 commands and counts.

No live Telegram check was run by this auditor. H-TM-LT3 remains
scheduled/deferred by operator instruction and is not counted as a live pass.

## Discipline

| Check | Result | Evidence |
| --- | --- | --- |
| D1 fresh worker context | **PASS under controlling operator policy** | T01, T02, T03 and T10 have unique worker ids. T10R and T10V also have unique remediation worker ids. T04-T09 are recorded as `direct`; the operator explicitly authorized direct execution when no spawn mechanism was available, so those six rows are authorized fallback executions rather than an audit blocker. T03F is a separate remediation continuation and has its own worker id; its later direct continuation is recorded as operator-authorized after service-credit exhaustion. No id repeats among actual worker ids. |
| D2 own branch and linear fast-forward | **PASS** | `git log --merges 37236e0..HEAD --oneline` produced no output. Tracker rows record distinct branches for T01, T02, T04-T10, T10R and T10V. T03F is the remediation continuation of T03, not a second numbered T01-T10 task; its branch and commits complete T03. History from the tracker start through `9152b3f` is linear. |
| D3 nothing pushed | **PASS** | `git rev-parse HEAD main origin/main` returned `9152b3f1e36f778fe96895e754b7f48843b4c9b3`, the same main SHA, and `44ad5882fa792240860aff5468efd229a0b619c0`. `origin/main` still equals the tracker origin start. |
| D4 scoped commits | **PASS** | `git show --stat` for task commits shows T01 live script/evidence; T02 TM0 table; T03 harness helper/build isolation; T04 fake group support; T05 LG-1 probe; T06 TM1 table/defaults; T07 roster model; T08 creation flow; T09 join flow; T10 close-out docs; T10R S-L1-04/build remediation; and T10V TM1 product/test completion. No unrelated product change was found in those commits. |
| D5 messages imperative/no co-author | **PASS** | `git log --format='%B' 37236e0..HEAD | rg -qi 'co-authored-by'` found no co-author line. Task subjects are imperative, including `Add team roster model`, `Repair T10 audit verification`, and `Complete TM1 Playwright coverage`. |
| D6 cleanup | **PASS** | `git branch --list 'tm/*'` produced no output. `git worktree list` showed only main and this audit worktree; no Team task worktree remains. |
| D7 scenario-before-code | **PASS** | TM0 table `93c4e80` and skim `32fb000` precede T03/T04 product commits. TM1 table/defaults `7841848` precedes T07-T09 and T10V product commits. |
| D8 jd stops/no worker escalation | **PASS** | Tracker records T01 setup and delivery decision, T02 skim, T03 remediation/direct authorization, T05 repository/probe approval, T06 defaults and skim, and LT-3 deferral. No report or tracker evidence says a worker contacted jd/Yousef or spawned an agent. |
| D9 tracker agrees with git | **PASS** | Every task/remediation SHA named by the tracker exists on main through `9152b3f`. Product commits in the range map to T01-T10, T10R or T10V; remaining commits are tracker state, operator decisions, the first audit, or close-out clarification commits. T03 and T03F intentionally name the same remediation range because T03F completed T03 after its repeated verification failure. |

## Acceptance

| Check | Result | Evidence |
| --- | --- | --- |
| A1 auditor re-verifies criteria | **FAIL** | Automated TM0/TM1 behavior is green: TM0 contracts 2/2, server 239/239, T1 116/116, S-L1-04 burn-in 3/3 and TM1 burn-in 9/9. Required files, scenario ordering, H-TM records, token sweep and Git discipline were inspected. However, the standing `team.enabled` default-off acceptance criterion is not implemented, so not every criterion holds. Live LT-1/LG-1 evidence was inspected rather than rerun; no live Telegram check was permitted, and no remote push was made. |
| A2 typecheck/lint/full server/full T1 | **PASS** | `npm run typecheck`: exit 0 across shared, server, web and e2e. `npm run lint --workspace web`: exit 0 with 5 existing unused-parameter warnings and 0 errors. `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-audit1-rerun-server npm test --workspace server`: 239 tests, 239 pass, 0 fail. `npm run e2e --workspace e2e`: 116 passed in 19.9 minutes. |
| A3 three-repeat burn-in | **PASS** | `npm run e2e:burn-in --workspace e2e -- --project=t1 --repeat=3 tests/t1/l1-phone-authorization.spec.ts -g S-L1-04`: 3/3 passed in 48.0 seconds. `npm run e2e:burn-in --workspace e2e -- --project=t1 --repeat=3 tests/t1/tm1-team-roster.spec.ts`: 9/9 passed in 4.7 minutes, covering TM-T1-1, TM-T1-1a and TM-T1-1b three times each. |
| A4 H-TM real-check records | **PASS** | `human-verification.md` has H-TM-LT1 PASS dated 2026-09-16, H-TM-LG1 PASS dated 2026-09-17, and H-TM-LT3 explicitly scheduled/deferred until the full build. LT-3 is not represented as PASS. |
| A5 invariants/default-off/token isolation | **FAIL** | Personal-control regression coverage and token isolation pass: full T1 is 116/116; S-L1-28 and S-L3-F1-22 pass; a tracked-file token-shaped secret sweep excluding the intentional redaction fixture reports no match. But `rg --glob '!docs/**' --glob '!node_modules/**' 'team\.enabled' .` returns no product-code match. `AgentsView.tsx` renders `TeamStatusPanel`, `TeamCreatePanel` and `TeamJoinPanel` whenever `taskControlTransport === "telegram"`; `workspaceApi.ts` serves all `/api/task-control/team*` routes without a Team feature gate. The default-off claim in `implementation.md` is therefore not supported by the tree. |
| A6 implementation evidence | **FAIL** | The TM0/TM1 entry records historical task evidence and the T10R/T10V focused burn-ins. It does not record the final full server command/count of 239/239 or full T1 command/count of 116/116. It instead ends by saying full server/full T1 were not rerun for close-out and cites historical 237/237 and 113/113 evidence. That does not match A2's current-tree counts. |
| A7 corrected disproved design facts | **PASS** | H-TM-LT1 records that administrator bots receive replies and unanchored discussion, contrary to the original assumption. Operator approval is recorded, and `b75077c Model LT-1 administrator delivery` updates the design, plan, brief, live record and script. No later live check disproved another design fact. |

## Focused Evidence

- `node --import tsx --test --test-concurrency=1 e2e/src/tm0.selftest.test.ts e2e/src/tm0.fake.contract.test.ts`: 2 tests, 2 pass, 0 fail. The tests cover S-TM0-01/02/03/04/05/07/08.
- Full T1 includes the repaired `S-L1-04`, which passed in 9.0 seconds inside the 116/116 run.
- Full T1 includes TM-T1-1a, TM-T1-1b and TM-T1-1; all three passed before the remaining personal-control suite.
- The TM1 burn-in also checks the responsive status panel at 390x844 and 1440x1000 through TM-T1-1.
- `git diff --check 37236e0..HEAD` passed.
- Required scripts and tables are present: `lt1-two-bots-group.ts`, `lg1-repository-refs.ts`, `tm0.md` and `tm1.md`.

## Required Remediation

1. Add the real `team.enabled` setting with fallback `false`.
2. Gate Team UI and Team API/runtime state-changing paths on that setting while leaving personal Telegram behavior unchanged.
3. Add focused default-off coverage proving an existing personal Telegram setup cannot view or invoke Team capabilities until explicitly enabled.
4. Update `implementation.md` with the final full server, full T1 and burn-in commands/counts.
5. Rerun the affected checks and audit 1 before T11.

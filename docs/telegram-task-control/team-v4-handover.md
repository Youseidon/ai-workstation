# V4 handover: the audits, and the three questions waiting on operator

> **Archived session handoff.** Superseded by later V-series records and current
> implementation evidence.

> **CLOSED 2026-09-26. Superseded by [team-v5-handover.md](team-v5-handover.md).**
> operator answered all three questions in section 5 on 2026-09-25 and 2026-09-26; audit 4 has since run and FAILed, and both audits are routed.
> Figures in this file describe the tree before gaps C3 and C4 were closed: the T1 bar is now **134**, not 127, and the web bar **95**, not 94.
> Read the V5 handover for current state; use this one only for the reasoning behind the three questions.

Written 2026-09-25, by the orchestrator, for whoever picks this up in a fresh session.
This session closed gaps **M-9** and **M-5** and ran **audit 3**, which FAILed.
It ends with three decisions operator deferred to the next session, listed in section 5.

Read this first, then [team-burndown-tracker.md](team-burndown-tracker.md) and [team-gap-register.md](team-gap-register.md).
[team-m9-handover.md](team-m9-handover.md) and [team-reconcile-handover.md](team-reconcile-handover.md) are the equivalent files for the two closed gaps; both carry a CLOSED banner and corrections.

## 1. Where everything is

| Thing | Value |
| --- | --- |
| main | `<user-home>/ai-workstation`, clean. **M9 landed at `250e085`**; documentation commits follow, and nothing after it touches a file outside `docs/` |
| main vs `origin/main` | **364 ahead, 0 behind**. Still **nothing pushed, ever**; `git branch -r --contains HEAD` is empty |
| Worktrees | One, the checkout itself. No `fix/*` or `tm/*` branch remains. The two auditor worktrees were removed after their reports were harvested |
| **Full T1 suite** | **127 of 127.** Green twice on two separate trees: 24.4 minutes by the orchestrator, 27.1 minutes by audit 3 independently |
| Server suite | **618 of 618**, three times against one unchanged root. 617 plus one test M9 added |
| Shared suite | 91 of 91 |
| Web suite | **94 of 94**, up from 65 now that `npm test` runs the component tests |
| Typecheck | Clean on all four workspaces |
| Web lint | **19 problems, 17 errors and 2 warnings.** Identical on main and on the M9 branch |
| Audit 3, F track | **FAIL** on D1, D9, A1, A2, A6. Committed as `team-track-audit-3.md` |
| Audit 4, H track | **Not started.** operator deferred it to the next session |

The pilot checkout `<user-home>/ai-workstation-team-pilot` sits on `feature/team-telegram-pilot` at `dc3e9de`, long since merged into main.
It is the test rig, not where product code goes.

## 2. What M-9 turned out to be, and why it matters beyond itself

The previous handover said the T1 fake provider had not been told about upstream's new agent prompt.
That was true and it was a symptom. The cause was that `startExecute` carried **two prompt builders** after the reconcile - ours, choosing between bound tools, the `agent-step` launcher and the offline protocol, and upstream's, inlining the context unconditionally - and upstream's came second and overwrote the choice.

Fixing that exposed two more defects of the same kind. All three were merge-introduced, all three compiled, passed lint and left a green server suite, and **all three were present while the structural completeness checks of 2026-09-25 were reporting that nothing of ours was missing**:

| Defect | What a user got | Fix |
| --- | --- | --- |
| Two prompt builders, upstream's overwriting ours | On default settings - Host access off, Grok sandboxed - a saved-task run's only channel was a launcher its sandbox cannot reach. The run ended UNREPORTED with the work possibly done | One builder, channel chosen in `executeChannel` and handed to it |
| The launcher dropped the `options` a BLOCKED status carries | The phone's decision card offered nothing to choose between, and nothing downstream invents them | `agent-step blocked --options-file`, validated before the round trip |
| `BLOCKED` stopped reading as awaiting a response | **No blocked task's question card reached the phone at all, and no blocked task appeared in any list.** The feature's primary path | One predicate, `awaitsResponse`, asked by both consumers |

The third is the one to carry forward. A work item waiting on a person has two spellings in the status model: `BLOCKED`, stored and labelled "Needs you", and `AWAITING_RESPONSE`, the live overlay the model itself documents as an alias of it.
Ours returned the overlay; upstream's returns the stored name. **Neither is wrong**, which is exactly why a merge can swap them with nothing to complain, and the Telegram layer keyed on the overlay in two places.
operator confirmed on 2026-09-25 that a blocked task's card reaching the phone is the intended purpose, so it was repaired rather than accepted.

**The lesson the M-9 handover asked to be carried forward is now demonstrated rather than argued.** Structural checks cannot prove that what survived a merge is wired to a user surface. Only the end-to-end tier can. Do not let a green server suite stand in for it.

## 3. Audit 3's result, as evidence rather than as a verdict

**FAIL: 10 pass, 5 fail, no live product defect.**
It reproduced the full T1 suite independently at 127 of 127 on its own worktree, and the server suite at 618 of 618 three times - pinning `AGENT_CONSOLE_DB` as well as the repository root, because the workspace test script derives a database path from the shell pid, so three plain invocations each get a fresh database. That is the stricter reading and it also passes.

| Check | Why it failed | Character |
| --- | --- | --- |
| **D1** | F00A, F01, F02 and F04 all record the id `orchestrator`, which repeats and is not a worker id; F00B records `one worker`, which is not an id at all | Record-keeping. operator's split-execution decision of 2026-09-20 authorises the orchestrator running F01 and F02, but not F00A or F04 by its letter, and nothing covers F00B |
| **D9** | F04's row names no commit - its cell reads `` `(with this commit)` `` and the commit is `a94da5e`. And 17 commits of ours in the F window belong to no row: the G01/G02/G04 gate and handover-rules documentation | Record defect, documentation only. **Verified independently by the orchestrator** |
| **A1** | Five criteria across five tasks are unmet or not re-verifiable. Section 4 below | The substantive one |
| **A2** | Lint: 19 problems, 17 errors, exit 1 | Known, attributed, entirely upstream's files, and `origin/main` does not pass lint either |
| **A6** | `implementation.md` has **no F-track entry at all** - not one command or count, while TM0 to TM3 and the G-records are all present | Record gap, documentation only. **Verified independently by the orchestrator** |

It also raised seven findings no check names, of which three are worth acting on: the bug log's index line 11 says "everything else is still open" while nine entries carry Fixed banners; the register closes L-4 in a heading and reopens it in the body; and `teamGrants.test.ts:127` is still titled "migration 27" though its body asserts 50.

## 4. A1's five criteria, in the order they deserve attention

1. **F05, criterion 3.** It asked for a harness case that upgrades a group mid-test. **None exists, and the e2e fake cannot upgrade a group at all.** The substitute is a T0 runtime test at `telegramLiveRuntime.test.ts:1277` named **`TM-T1-8`**, an id that appears in no scenario table and in no plan. The deviation is candidly recorded in the tracker's log of 2026-09-20 but in neither F05's row nor the gap register, while `tm4.md:66` now treats F05's behaviour as load-bearing for the H track. **An invented scenario id in a test name is worse than a gap, because it reads as coverage.**
2. **F02.** "Retire and unpin the anchor the way completion does" was deliberately not done, because retiring makes the thread unroutable. The auditor verified the consequence in code: `syncTeamItem` returns early for a closed link (`runtime.ts:1274`) and `finishCompletedTeamItems` can never reach a closed-but-blocked item, so that anchor stays pinned and stale indefinitely.
3. **F03 and F06.** Both "checked at both widths" criteria are unverifiable: no rig was committed for either. Register entry L-4 names only F03.
4. **F00B.** Its proof criterion is three full server runs and three full T1 runs against one unchanged root. The auditor did the server half and ran T1 once, not three times, so the criterion is unproven rather than failed.

## 5. The three questions operator deferred to the next session

operator was asked all three on 2026-09-25 and chose to pick them up fresh rather than answer at the end of a long session. **Do not decide any of them in a fixture or a document; put them to operator.**

1. **How to route audit 3's five FAILs.** The brief's own rule is that a FAIL is either fixed by a new task with its own worker, or waived by operator in writing in the tracker. The orchestrator's recommendation, offered and not yet accepted: fix **D9** and **A6** as documentation commits, since both are cheap and both will trip the next auditor, and put **D1**, **A2** and **A1**'s criteria to operator as waivers with each deviation recorded in the gap register.
2. **Whether to run audit 4 over the H track now or after the F-track failures are resolved.** Its worktree instructions are in section 6. The brief's letter says a FAIL blocks the next task; the practical argument is that audit 4 covers a different track and having both results in hand makes one ruling possible instead of two.
3. **What to do about F05's missing harness case**, item 1 of section 4: register it as a deviation and retire the invented `TM-T1-8` id, build the fake's group-upgrade capability as a new task, or fold the evidence into V5's live run.

**Still stopping points, unchanged**: before V5, before any push, and on any audit FAIL.

## 6. Running audit 4, when operator rules on it

Launch a fresh agent with no part in the build. Give it section 4 of [team-track-dev-brief.md](team-track-dev-brief.md) **unchanged**, the **H track** (H01 to H07), the range starting at `dc3e9de`, and this tracker. It writes `team-track-audit-4.md`, and the orchestrator commits it.

It must be given the corrections in section 5 of [team-reconcile-handover.md](team-reconcile-handover.md) and section 5 of [team-m9-handover.md](team-m9-handover.md), **with three amendments this session made to them**:

- **A2 now passes on the T1 tier**, 127 of 127. The older note saying it fails is superseded.
- **The lint line is 17 errors and 2 warnings, not 11 warnings.** The errors and the attribution stand exactly as written. The warning figure never reproduced and is withdrawn.
- **The lint errors are not only under `components/activity/` and `components/pipeline/`.** Audit 3 caught this and the orchestrator confirmed it: **3 of the 17 are in `components/programs/ProgramDraftPanel.tsx`**, whose only two commits are upstream's. The attribution holds; the directory list did not.
- The server suite bar is **618**, not 617.

Tell it the harness is exclusive - **never two harness runs at once** - and that it owns the harness for its pass.

## 7. Things about the rig that will save the next session time

- **Budget about 25 minutes for a green T1 pass and about 45 for a red one.** A red run is *slower*, because a failing card scenario spends 30 seconds timing out. This session killed a healthy full run at twenty minutes on an estimate extrapolated from the first five tests, which happen to be the slow two-environment Team specs while the remaining hundred-odd are seconds each. operator challenged the estimate and was right. **Do not extrapolate from the first file.**
- **Run T1 from the `e2e` directory.** From the repository root it fails with `Project(s) "t1" not found`.
- **A fresh worktree needs `npm install`** (about 20 seconds) and will have the system npm rewrite `package-lock.json`. Restore it before committing: that churn is not yours.
- **The console ends the provider the moment a terminal status lands**, so a fake cannot log anything after its own final post. The T1 fake logs every launcher call *before* making it for exactly this reason.
- **`views.ts` was invisible to grep** until this session fixed it: it held a raw 0x00 where `[\x00-\x1f]` was meant, and **grep reports no matches in a binary file rather than saying it skipped it**. If a search of a source file returns nothing where you expect a hit, check `file` on it before concluding the symbol is absent.
- On T1 failure the harness logs are copied to `e2e/test-results/<test>/harness/`: `server.log`, `web.log`, `fake-provider.log` and `console.sqlite`. That directory is how every diagnosis this session was made.
- **`S-CLT-02` is stale and was deliberately left alone.** It asserts a real Claude run calls `get_context`, which inlined context makes optional rather than required. That scenario needs a paid provider, so it cannot be run here, and an assertion nobody can execute is not one to rewrite on reasoning alone.

## 8. Standing constraints, unchanged

No push and no remote write without operator's explicit approval, shown first.
No paid provider, no live Telegram credential.
Never two harness runs at once.
`team.enabled` and `team.handoverEnabled` both stay false by default.
Lint exists in the `web` workspace only.
Commit messages are imperative and carry **no co-author line of any kind**, which is both operator's standing rule and audit check D5.

## 9. What is left after the three questions

**V5**, the solo LT-4 re-run of cases 2, 3, 11 and 12 from [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md). **Stop and ask operator before starting it**: it needs the pilot rig with real Telegram bots, which collides with the standing no-live-credential rule.

Open afterwards and not part of completion: M-1 the two-person runs, M-6, M-7, L-1 to L-11, the 17 upstream lint errors, and whether anything is ever pushed.
operator's "keep it local" ruling of 2026-09-22 still stands.

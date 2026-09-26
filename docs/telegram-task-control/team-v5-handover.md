# V5 handover: the sprint to completion

**CLOSED 2026-09-26. Its successor is [team-v6-handover.md](team-v6-handover.md), which is the current working knowledge.**
C5 is closed, M-13 is reproduced, and V5 is four of seven cases done against live Telegram. This file's state table is superseded: T1 is now **140 of 140** and main is **404 ahead** at `698dcef`.

Written 2026-09-26, by the orchestrator, for the session that finishes this track.
This session routed **audit 3 and audit 4**, and closed gaps **C3** and **C4**.
What is left is **C5**, then **V5**, then the completion report. Section 3 is the whole remaining path.

Read this first, then [team-burndown-tracker.md](team-burndown-tracker.md) and [team-gap-register.md](team-gap-register.md).
[team-v4-handover.md](team-v4-handover.md), [team-m9-handover.md](team-m9-handover.md) and [team-reconcile-handover.md](team-reconcile-handover.md) are closed history. They carry figures later documents supersede; do not take a number from any of them without checking it here.

## 1. Where everything is

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation`, clean, tip `c6ff1ff` |
| main vs `origin/main` | **389 ahead, 0 behind. Nothing has ever been pushed**; `git branch -r --contains HEAD` is empty |
| Worktrees / task branches | One worktree, the checkout itself. **Zero** `fix/*` or `tm/*` branches |
| **Full T1 suite** | **134 of 134**, 0 flaky, 28.5 minutes, verified by the orchestrator on the merged tree |
| Server suite | **618 of 618, three times** against one root with `AGENT_CONSOLE_DB` and `SETTINGS_FILE` pinned |
| Shared / Web | 91 of 91 / **95 of 95** |
| Typecheck | Clean, four workspaces |
| Web lint | **19 problems, 17 errors, 2 warnings, exit 1.** Entirely upstream's files. Waived by jd, registered **L-12**. `origin/main` does not pass lint either |
| Audit 3, F track | **FAIL**, routed. `team-track-audit-3.md` |
| Audit 4, H track | **FAIL**, routed. `team-track-audit-4.md` |

The pilot checkout `/home/junaid/ai-workstation-team-pilot` is the **test rig only**. Product code never goes there, even though sessions are often launched from it.

## 2. What this session did, in one paragraph each

**Both audits FAILed on the same five ids** - D1, D9, A1, A2, A6 - for partly different reasons. jd routed both the same way on 2026-09-26: the record-shaped failures were fixed as documentation, and D1's authorization half, A2's lint tier and A1's unmeetable criteria were **waived by jd in writing**, which the brief's audit rule expressly allows. Every deviation a waiver covers was registered as a gap so that waiving it did not make it disappear: **M-10, M-11, L-4, L-12, L-13, L-14, L-15**. The waivers are in the tracker under "jd's waivers of audit 3" and "jd's waivers of audit 4".

**C3 was a live product defect and it was found by verifying a documentation sentence**, not by any suite. `operationalState` returns `BLOCKED` for a stored `BLOCKED` prompt where it returned `AWAITING_RESPONSE` before the reconcile; M-9 built `awaitsResponse` for exactly that and converted the two consumers it found, and **two Team-owned consumers still compared by hand**. On the primary Team path `/status` said `Decision: none waiting` while the decision card sat on the owner's phone, and the Open Team thread control was disabled with a self-contradicting sentence. Fixed, with the predicate moved to `shared/` so one definition serves both tiers. **This is the fourth defect of the M-9 family.**

**C4 gave H07's close guard the end-to-end row it was owed.** Tests only, no product change, no behaviour difference found. It is proven by **mutation**: with the guard disabled three rows go red and the control row stays green, so the close path still works and the refusal is what broke.

## 3. The remaining path, in order

### 3.1 C5, the last build task

Gap **C5** in the register is carded with six acceptance criteria under "The task, carded 2026-09-26". Its own worker, its own branch, its own worktree.

The claim it must settle: `e2e/tests/t1/tm4-handover.spec.ts` proves the **Telegram** surface and never opens a browser - `grep -nE "page\.|browser|goto|locator"` on it returns nothing - so `HandoverControl.tsx` has no end-to-end proof it is wired to the routes it calls. Its evidence is a props-rendered React test plus a rig that renders the component in isolation with a CSS shim.

Like C4 it carries a **mutation criterion instead of red-first**, because the code is already believed correct and a test that has never failed proves nothing. C1 was "present but not wired"; only a test that fails when the wiring breaks distinguishes those.

It is sized larger than C4 and its criterion 6 tells the worker to **stop and report rather than grow the task silently** if it needs more than one row or new fixtures.

### 3.2 V5, and it is a stop point

The LT-4 re-run, cases 2, 3, 11 and 12 of [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md).

**Ask jd before starting it.** It needs the pilot rig with real Telegram bots, which collides with the standing no-live-credential rule. That collision has never been resolved, only deferred, and it is the single thing standing between this track and its own definition of done.

### 3.3 The completion report

Section 8 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md) defines done. Measured honestly, **three of its five clauses are met**:

- met: B1-B14 and B17-B19 closed or explicitly deferred with a reason; B15 closed by F04's amendment with B16 a pointer to B11; the orchestrator's reporting.
- **not met: "Audit 3 and audit 4 pass."** Both FAILed. jd's written waivers satisfy the brief's *rule*, which offers waiver as an alternative to fixing, but they do not make the clause true. **Do not report this as met.**
- **not met: "LT-4's re-run rows are recorded."** That is V5.

The report owes jd: commits per task, counts per tier, burn-in results, the G01 decision, real checks and outcomes, both audit results, design corrections, and everything left open.

## 4. Decisions waiting on jd

1. **V5 itself**, per 3.2.
2. **Whether invariant A5 keeps holding** for `web/components/tasks/WorkItemDetail.tsx:245-249` and `web/components/tasks/WorkItemList.tsx:365`. Both are the same mechanism as C3 and reachable the same way: the first means the owner's own "Needs your input" banner and Respond button do not render on the item asking them a question; the second is C3's mirror image, branching on `BLOCKED` with **no `AWAITING_RESPONSE` branch at all**. They are personal-control surfaces, which A5 says this track leaves unchanged, so they were left alone. **The C3 harness now produces the exact state that would prove them**, so settling this is far cheaper than it was.
3. **L-13**, an intermittent failure in the `e2e` workspace's own selftests, seen **twice in one day by two independent agents** and never reproduced. It is in the instrument the track's evidence rests on, it runs in no tier any check names, so its failure rate is unmeasured.
4. **M-6, M-7, M-10, M-11** and the Low band remain open by design and need decisions rather than only work.

## 5. What this session learned that the next one should not relearn

- **Verifying a claim before writing it into a document is what found C3.** Audit 3's finding 7 looked harmless; checking it before recording it exposed a live defect that server 618/618, T1 127/127, web 94/94, four typechecks and a fresh auditor's independent reproduction were all consistent with. Re-run an auditor's or worker's number before repeating it: one was confirmed exactly, one was **false and withdrawn**.
- **Typecheck is the least informative tier here.** The killed C4 worker left a spec that typechecked cleanly and **would never have run** - `test.setTimeout` at file scope does not apply to a `beforeAll` hook - plus two assertions wrong against real output and one that matched a *different item's* card and would have passed while asserting nothing.
- **A mutation test is only evidence if its red is legible as the failure it is meant to show.** C4's draft drove every stage unconditionally, so with the guard disabled the later rows died as hook timeouts rather than verdicts. A red that says "timeout" proves nothing.
- **Do not invent a scenario id.** `TM-T1-8` and `TM-T1-9` were retired this session as ids appearing in no table and no plan; a C3 worker then reintroduced the family by taking the next free number and was sent back. Name tests for something real - a bug-log id (`B8 (T0)`) or a gap id (`C3 (T1)`, `C4 (T1)`). **Check `annotation` blocks too**, since a `covers` annotation is what a coverage tool reads. Put this rule in every worker card that may add a test; the C3 card lacked it, which is why it happened.
- **The orchestrator committed the same class of defect it was closing**, writing `..HEAD` into a commit cell while fixing F04's `(with this commit)`. Knowing about a defect class is not the same as not committing it.
- **A commit that touches anything outside `docs/telegram-task-control/` belongs to a task row**, whoever made it and however small. Audit 4 failed this session's own documentation commit for editing a test file.

## 6. Rig knowledge, unchanged and still true

- **The harness is exclusive. Never two runs at once.** C5 and any V5 work contend for it.
- **Run T1 from the `e2e` directory.** From the repository root it fails with `Project(s) "t1" not found`.
- **About 25 minutes for a green full T1 pass, 45 for a red one** - a red run is *slower*, because each failing card scenario spends 30 seconds timing out. **Never extrapolate from the first few tests**: the suite opens with the slow two-environment Team specs while the remaining hundred-odd take seconds each.
- **Run time is not a health signal.** The C4 spec took 3m07 cold and 42s warm on identical code. That is build-cache warmth, not flakiness.
- **Capture full output on a first run of any suite.** Two agents lost the same intermittent failure to a first run filtered to summary lines, and the orchestrator lost its own T1 detail by piping through `tail`.
- **Workers get killed by session rate limits** - five so far. **Tell every worker to commit each proof as it lands**; the four kills before that instruction existed lost work, the one after it did not.
- **A fresh worktree needs `npm install`** and the system npm rewrites `package-lock.json`. Restore it before committing; that churn is not yours. `npx -y npm@11 install` avoids it.
- On T1 failure the harness logs land in `e2e/test-results/<test>/harness/`: `server.log`, `web.log`, `fake-provider.log`, `console.sqlite`.
- **The console ends the provider the moment a terminal status lands**, so a fake cannot log anything after its own final post.
- **`file` saying `data` does not mean grep is blind.** GNU grep keys on NUL. `views.ts` had one and was genuinely invisible; `telegramViews.test.ts` has a stray `0x01`, is read by grep normally, and a worker's claim otherwise was withdrawn. Registered L-15.
- **`S-CLT-02` is stale and deliberately left alone.** It needs a paid provider and cannot run here.
- **Create worker worktrees yourself with `git worktree add`.** The Agent tool's own worktree isolation resolves its base branch against the session's directory rather than the project, and fails.

## 7. Standing constraints, unchanged

No push and no remote write without jd's explicit approval, shown first. Nothing has ever been pushed.
No paid provider, no live Telegram credential.
Never two harness runs at once.
`team.enabled` and `team.handoverEnabled` both stay false by default.
Lint exists in the `web` workspace only.
Commit messages are imperative and carry **no co-author line of any kind** - jd's standing rule and audit check D5.
Every task gets its own worker, its own branch and its own worktree, and lands by fast-forward.

**Stop and ask jd**: before V5, before any push, on any audit FAIL, and before changing a personal-control surface that invariant A5 covers.

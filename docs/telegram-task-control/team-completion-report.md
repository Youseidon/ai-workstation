# Team burndown: completion report

Written 2026-09-26 for jd, by the orchestrator.
This is the report section 8 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md) asks for.

**Read section 1 before anything else.** Two of section 8's five clauses are **not** met, and one
of those two cannot be made true by any amount of further work on this track.

## 1. Section 8's five clauses, with verdicts

| Clause | Verdict |
| --- | --- |
| 1. Audit 3 and audit 4 pass | **NOT MET, and it cannot be met.** Both FAILed. See section 8 |
| 2. B1 to B14 and B17 to B19 closed or explicitly deferred with a reason **in the bug log** | **MET, as of 2026-09-26.** It was not met when this report was started |
| 3. B15 closed by the F04 amendment; B16 stays a pointer to B11 | **MET** |
| 4. LT-4's re-run rows are recorded | **MET, as of 2026-09-26** |
| 5. The orchestrator reports the nine listed things to jd | **MET by this document** |

Two of these deserve their reasoning stated rather than a tick.

**Clause 1 is the one that matters.**
Audit 3 and audit 4 both **FAILed**, on the same five check ids, and jd routed both in writing with a
mixture of fixes and waivers.
The brief's own *rule* offers waiver as an alternative to fixing, and jd exercised it, so the track is
correctly routed and nothing is outstanding against jd's instructions.
**But the clause says the audits pass, and they did not.**
A waiver changes what must be done about a failure; it does not convert the failure into a pass.
This report will not record clause 1 as met, and no later document should either.

**Clause 2 was met only by fixing it today, and the gap is worth knowing about.**
B3, B4, B10 and B19 are the four rig items.
All four were genuinely deferred, to F10, and the reason was written down in **L-1** of the gap register
and in the tracker.
The clause asks for the reason to be **in the bug log**, and it was not in the bug log for any of the four.
So the clause read as met while being literally unmet, and reading the bug log was the only way to see it.
Four deferral statements were added, naming F10, the reason, and the fact that F10 is needed before LT-5
and nothing else.

## 2. Commits per task

Every task's own row in [team-burndown-tracker.md](team-burndown-tracker.md) carries its merged commit
range and its evidence.
This table is the index; the rows hold the detail.

| Task | Track | Merged commits | What it closed |
| --- | --- | --- | --- |
| F00A | F | `b72f21e` | Pre-existing fixture timing failure found on main, not caused by F01 |
| F01 | F | `506ea0a..7cca9cd` | B12 |
| F02 | F | `32ce63c..cfb9d55` | B17 apart from its pinned anchor, and B14. Owns migration 27 |
| F03 | F | `fc01a2c..730fcde` | B2 and B7 |
| F04 | F | `a94da5e` | B15, by the R-B amendment. Documentation only, one table row |
| F05 | F | `deb63fc..70c0cab` | B8 |
| F06 | F | `b43899c..b1b1143` | B1 |
| F07 | F | `a5331a5..46b2522` | B9 and B11, and B16 with it |
| F08 | F | `9008c6f..e7d97cd` | B13 |
| F09 | F | `e7032e9..8b93dd9` | B5, B6 and B18 |
| F00B | F | `4070156..581aafd` | Gap H-1, and V1 of Phase V |
| H01 | H | `5b00ebe` | TM4 handover rulings |
| H01b | H | `59a19a7` | |
| H02 | H | `013fec5..24c257d` | Migration 52 after the reconcile renumbered it |
| H03 | H | `7d3fc6f..d5a528e` | |
| H04 | H | `1ad7dcc..bb77210` | |
| H05 | H | `123920e..a68ae98` | |
| H06 | H | `2926149..04dca86` | Gaps C1 and H-2. Found two defects that no tier of reading had reached |
| H07 | H | `d300b05..1f01acd` | M-4's rule 4.5, the close-path data loss |
| V2 | V | none | Verification only |
| V3 | V | none | Gaps H-3 and G02. The correct outcome for a verification task |
| V4 | V | `65029d9`, `d4657a0..39d7935`, `84e77c9`, `36cb6bf..1f6bf6b` | Both audits, and their routing |
| C3 | V | `5c314b8..dfc7865` | Gap C3 |
| C4 | V | `77ed7ef` | Gap C4 |
| C5 | V | `12ddb8e..a109232` | Gap C5. **The last build task** |
| M-13 | V | `395fa16` | Reproduction only, no product change, under jd's prove-first ruling |
| R1, M8, M9 | - | see their rows | The reconcile and its consequences |

**C5 and M-13 had no rows in that table until today.**
Both were complete, both were described at length in the session log, and neither had a row, which is the
same record defect audit 3 failed D9 for.
Rows were written for both before this report was allowed to cite commits per task.

Sixteen commits belong to no task row, by a stated exception in the tracker, and the tracker carries a
command an auditor can run against that claim.

## 3. Test counts per tier

**Every number in this table except the T1 row was re-run by the orchestrator on 2026-09-26** and is a
first-hand reading, not a figure carried forward.

| Tier | Result | Provenance |
| --- | --- | --- |
| Server | **618 of 618**, 0 fail, 0 skipped, 133 seconds, exit 0 | **Re-run 2026-09-26 by the orchestrator.** Matches the C5 worker's figure |
| Shared | **91 of 91**, 0 fail, exit 0 | Re-run 2026-09-26 |
| Web | **95 of 95**, 0 fail, exit 0 | Re-run 2026-09-26 |
| Typecheck, all four workspaces | exit 0 | Re-run 2026-09-26. shared, server, web, e2e |
| **Full T1 end-to-end** | **140 of 140**, 0 flaky, 26.4 minutes | **NOT re-run for this report.** Run on main by the orchestrator earlier in this track |
| Web lint | **19 problems, 17 errors, 2 warnings, exit 1** | Re-run 2026-09-26. **L-12, waived by jd 2026-09-25** |
| F-track files lint, on their own | exit 0, no output | Re-run 2026-09-26 |
| `e2e` workspace self-tests | **unmeasured** | **L-13.** In no tier any check names |

**Why T1 was not re-run, stated rather than glossed.**
The live rig described in [team-v6-handover.md](team-v6-handover.md) section 2 is running against real
Telegram, and the standing constraint is that the harness is exclusive and contends with the rig.
Re-running T1 would have meant stopping the rig that V5's remaining cases need.
The 140 figure is the orchestrator's own run on main, not a worker's, and T1 moved 134 to 135 for C5's row
and then to 140 for M-13's five rows.

**The lint tier is red and is reported as red.**
All 17 errors are in upstream's own files, `origin/main` does not pass lint either, and the F-track files
lint clean on their own.
jd waived it on 2026-09-25 and nothing in this track can close it.
It is named here so that no later reader can infer a green lint tier from this report's silence.

## 4. Burn-in results

V3, 2026-09-22, both burn-in files at `--repeat=3 --max-failures=1`:

- `tm3-grants.spec.ts` at **9 passed (7.0m)**, covering TM-T1-4, TM-T0-2 closed thread, and TM-T1-5
- `tm4-handover.spec.ts` at **9 passed (8.8m)**, covering TM-T1-H1, H2 and H3

Eighteen executions, zero failures, zero flaky, zero retries, neither run reaching `--max-failures=1`.
Timings were near-identical across repeats, TM-T1-H1 at 27.5, 27.7 and 27.5 seconds, which is itself a
determinism signal and the payoff from V1.
The orchestrator re-ran the handover burn-in independently at **9 passed (10.0m)**, exit 0.
Audit 4 reproduced the TM4 burn-in at **9 of 9** on its own worktree.

## 5. The G01 decision

Recorded 2026-09-20 in [implementation.md](implementation.md) section 6b.

The handover delegates nothing, so a receiver resuming under their own login is ordinary use rather than
an authorization question.
**It holds only while acceptance stays an explicit human action and no credential is shared.**
Auto-accept re-opens it.
That condition is the decision's load-bearing half and should travel with it.

## 6. Real checks and their outcomes

**LT-4, the two-account Team thread and grant check.**
September's first pass, cases 0a to 12, was run by jd personally against the real bots on 2026-09-19 and
2026-09-20, and its rows are in
[solo-team-thread-grant-check.md](solo-team-thread-grant-check.md)'s Progress table.
The re-run that clause 4 asks for is in that document's **Re-run for V5** table and is described below.

**V5, 2026-09-26 and 2026-09-27, against the live rig with live Telegram credentials authorized by jd.**
**V5 is complete**: six cases PASS, one PARTIAL with its cause newly understood, one SKIPPED.

| Case | Outcome |
| --- | --- |
| 0a notifications and remote actions | **PASS** |
| 0b task waiting on a question | **PASS.** Card posted unprompted, `kind: personal_question`, both buttons, options parsed |
| 1 roster on both sides | **PASS.** `refs/aw/team` at `4255c668…`, confirmed by `git ls-remote` against GitHub itself, so the round trip is real |
| 2 open the item thread | **PASS.** `201`, item `awi1_63460787e23fa7d635890376`, anchor message 85, access message 87 reading exactly as specified. **The pin was verified through `getChat`**, not from the local `anchor` column |
| 12 default-off regression | **PASS, all three halves.** The phone half ran the full personal write-and-apply round trip with Team off, and the tap was verified genuine |
| 3 read-only views | **PASS.** Five replies to the anchor, each answered once by the owner's bot; instance B received every update and stayed silent |
| 11 close the thread | **PARTIAL.** B17 reproduces, and the second look corrected B17's own cause. Registered **M-15** |
| 10 cross-owner thread request | **SKIPPED**, B15, still not a real scenario |

**Cases 3, 11 and 12's phone half were run by jd personally on 2026-09-27**, from the script at
[v5-phone-script.md](v5-phone-script.md), because a bot token cannot type as a user.
Before handing it over, instance B was confirmed **live and long-polling**, so that case 3's "instance B
stays silent" is an assertion rather than a tautology: its process holds two established connections to
`api.telegram.org`.
That mattered: B received all five group updates and chose to emit nothing.

**Case 11 is the one PARTIAL, and the re-run was worth running for the cause rather than the verdict.**
B17 reproduced, but the second look showed B17's own explanation was wrong.
`closedAt` gates granted commands and not view commands, and the thread lookup filters on
`ANCHOR_GONE` only, so the `telegram_thread` row staying `ACTIVE` is **not** what keeps the views
answering and closing it would fix nothing.
That is registered as **M-15**, and the correction is written into B17.
The re-run also could **not** exercise the grant-ending criterion, because no grants ever existed on the
item, and the row says so rather than implying a pass.

**Case 12's browser half**, new today, was driven with Playwright against the live web app.
With Team on, `Team status`, `Join team` and the create panel render on `/agents` and `Team thread`
renders on the `WI_TC01` detail.
With Team off and the page reloaded, all four are gone from both surfaces.
Turning Team back on restores all four.
The criterion as written is met.

**The bots' group rights**, which V6 left open and jd had asserted, are now verified.
`getChatMember` was asked through **both** tokens independently, so neither answer rests on one bot's view.
Both are `administrator` with `can_pin_messages: true`.
jd was right.
The Team panel instruction that asks for this is emitted unconditionally and never asks Telegram, so it
is not evidence either way and polling it loops forever.

## 7. Everything found by running things rather than reading them

This track's most useful pattern, stated once because it recurs: **four separate defects were of the shape
"present, mounted, wired to nothing", and not one of them was found by reading.**
C1, C5, M-12 and now M-13.
Two more, both found today:

- **L-16.** Turning Team off leaves every Team panel on screen until the page is reloaded.
  Cause read rather than guessed: `settings_updated` carries only `providers`, and the web reducer applies
  only `providers`, so the snapshot holding `team.enabled` is never re-read.
  The server comment claiming every tab re-reads "both" overstates what the message carries.
  Low, because the API gate holds and the refusal a user sees names the real cause.
- **L-17.** `scripts/team-pilot-state.mjs` defaults to the calling checkout's own database.
  Run the way the check document documented it, it reads `main`'s leftover fixture and prints `team-7`
  with two members who do not exist, with no marker that it is a fixture.
  Worse than a wrong port, because it succeeds plausibly.
  The check document's command block has been corrected to pass the path for both instances.
- **M-15**, and with it a correction to **B17**, whose recorded cause was wrong.
  Found by running case 11 rather than by re-reading it, and the distinction between "the thread row says
  `ACTIVE`" and "the view path never checks `closedAt`" only appears when you ask which one the code
  actually reads. It reads neither for routing: the lookup filters on `ANCHOR_GONE` alone.

## 8. Both audit results

**Audit 3, over the F track: FAIL.**
Ten checks passed, five failed: D1, D9, A1, A2 and A6.
**No live product defect.**
It reproduced the full T1 suite independently at 127 of 127 on its own worktree and the server suite at
618 of 618 three times, pinning the database as well as the repository root.
Three failures were record-keeping, one was the known upstream lint tier, and A1 was five acceptance
criteria across F02, F03, F05, F06 and F00B that were unmet or not re-verifiable.
Its sharpest single finding: F05's criterion 3 asked for a harness case that upgrades a group mid-test,
none exists, and the substitute test was named `TM-T1-8`, **an id in no scenario table or plan**.

**Audit 4, over the H track: FAIL.**
The same five ids, for partly different reasons, ten checks passing, **no live product defect**.
It reproduced every tier itself: T1 127 of 127 in 23.0 minutes, server 618 of 618 three times on one
pinned root, the TM4 burn-in 9 of 9, shared 91, web 94, four typechecks, and the two-width handover rig
PASS at both widths.
All four corrections it was given reproduced exactly.
**It failed two of this session's own commits and was right both times.**

**Both were routed by jd in writing**, audit 4 mirroring audit 3: D9, A6 and D1's record halves fixed as
documentation commits; A2's lint tier and A1's remaining half waived, with every deviation registered as
M-10, M-11, L-4 or L-12.
Two of audit 4's findings became tasks rather than waivers, **C4** and **C5**, and audit 3's sharpest
finding was acted on rather than waived: F05's missing harness case is registered as **M-10**, and **two**
invented ids were retired, `TM-T1-9` as well as the `TM-T1-8` audit 3 named.

**What the audits are worth saying plainly**: two independent auditors, on fresh worktrees, reproduced
every tier and found **no live product defect** between them.
Every failure was a record defect, a waived upstream tier, or an acceptance criterion that could not be
re-verified.
That is a meaningfully different result from an audit that passes, and a better one than an audit that
passes by agreement.

## 9. Design corrections made

- **R-B amended to owner-initiated threads**, in the wording jd approved on 2026-09-20, by F04.
  This closed B15 by making the written requirement match what is built, rather than by building the
  teammate-initiated direction.
- **M-4's rule 4.5**, the close-path data loss, closed by H07.
- **The reconcile**, R1 and M8, which renumbered migrations and changed the run lifecycle, and the
  corrections V4's auditors were given as a result.
- **C3**: two Team surfaces compared `operationalState` to `AWAITING_RESPONSE` by hand, and the merge had
  moved that value.
  The correction was to ask the shared `awaitsResponse()` predicate.
- **Two invented scenario ids retired**, `TM-T1-8` and `TM-T1-9`, and the convention fixed going forward:
  name a row for its gap id, and check `annotation` blocks as well as test titles.
  C5 was the first task where that rule was in the card from the start.
- **F05's harness gap registered as M-10** rather than waived.

## 10. What is left open

Nothing is in flight.
No worktree, no task branch, `git status` clean, nothing ever pushed.

**Nothing needs jd personally any more.**
V5's three phone cases were run on 2026-09-27 and are recorded.
**Every clause of section 8 that can be met is now met**, and the one that cannot is clause 1.

**Open gaps, none blocking, in jd's own priority order from 2026-09-26:**

- **H-4**, high. The pilot's database isolation is broken on main and the guard's own advice
  (`AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1`) is what silently breaks it.
  Worked around in the rig by pinning `AGENT_CONSOLE_DB` per checkout.
  **The product fix is not done.**
- **M-13's canned-answer defect**, the sharpest open item on the board.
  A button that submits an answer on the owner's behalf and starts a run on it, with the dialog that
  should open already mounted and called by nothing.
- **M-12**, the requester's review-and-apply half has no web surface at all.
- **M-14**, a workstation that loses its database cannot rejoin a team it is already listed in, and
  `roster_conflict` covers at least two distinct states, one remote and one a stale local mirror.
- **M-15**, new on 2026-09-27: a closed item thread answers its view commands as though it were open and
  says nothing about being closed. This is what keeps check case 11 at PARTIAL across two runs.
  Like M-11 it needs a decision rather than obviously a fix: reading a closed thread's history may be
  correct, in which case the fix is one line of output.
- **M-6, M-7, M-10, M-11**, and **L-13**, **L-16**.
- **F10**, the rig task, carrying B3, B4, B10 and B19. Needed before **LT-5** and nothing else.
- **LT-5** itself, blocked on F10 and on B19 specifically: instance B needs its own clone.

## 11. jd's decisions this track is built on

Recorded here because a report that omits them reads as though the orchestrator chose them.

- **2026-09-20**: the orchestrator implements Phase A directly; every task from Phase B onward goes to
  one worker agent per task.
- **2026-09-20**: R-B amended to owner-initiated, wording approved verbatim.
- **2026-09-20**: G01, above.
- **2026-09-25 and 2026-09-26**: both audit FAILs routed, with named fixes and named waivers.
- **2026-09-26**: **live Telegram bot credentials authorized** for the orchestrator, an explicit exception
  to a standing rule.
  Every task record from that point states that a live credential **was** used.
- **2026-09-26**: jd runs cases 3 and 11 by phone; the orchestrator runs 2 and 12.
- **2026-09-26**: rebuild the rig fresh on main rather than updating it in place.
- **2026-09-26**: the roster push to the pilot repo is in scope, it being a throwaway repository separate
  from `ai-workstation`.
- **2026-09-26**: **prove first, then decide** on the A5 personal-control surfaces.
  That became M-13, and the reproduction found a worse defect than either surface it was aimed at, which
  is the argument for the ruling.

Standing and unchanged: no push and no remote write to `ai-workstation`, and nothing has ever been pushed.
No paid provider.
`team.handoverEnabled` stays false.

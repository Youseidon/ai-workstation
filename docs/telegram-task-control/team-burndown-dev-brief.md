# Dev brief: Team defect burn-down and handover

Written 2026-09-20 for the agent session that closes out the Team feature.
You are the **orchestrator**: you run the numbered tasks below, and you merge, track and report.
You implement Phase A yourself and give every later task to a fresh worker agent, per jd's decision in section 2.
jd is the operator and reviewer; Yousef is jd's teammate and the second person in every team scenario.

This brief follows [team-track-dev-brief.md](team-track-dev-brief.md), which built TM0 to TM3 and closed after audit 2.
It carries two tracks that share one ordering:

- the **F track**, which burns down the defects found by the solo pilot, recorded as B1 to B19 in [pilot-bug-log.md](pilot-bug-log.md)
- the **H track**, which builds TM4 handover, the only progression slice still open

The F track comes first, because two of its items are unmet `must` requirements of slices already marked done, and because TM4 builds directly on the item thread the F track repairs.

## 0. Do not start until

- The pilot branch `feature/team-telegram-pilot` is merged to main.
  It carries the bug log, the two solo check documents, `scripts/team-pilot-state.mjs` and this brief; nothing in it is product code.
  Until it lands, the ids this brief cites do not exist on main.
- `git status` on main is clean, and no other session is running the harness on this machine.
- Both pilot instances are stopped, since several F tasks touch files that `tsx watch` reloads under a live pilot.
  They were stopped on 2026-09-20 by signalling the `concurrently` supervisors directly, because B10 means signalling the launcher alone does nothing.
- Record the starting commit of main and of `origin/main` in the tracker; the audits use them.

## 1. Read first

1. [pilot-bug-log.md](pilot-bug-log.md): B1 to B19, the defect list this track burns down. Every F task names the entries it closes.
2. [teammate-design.md](teammate-design.md): the design of record. Section 5.4 is handover and is in scope for the H track only.
3. [engineering-plan.md section 3b](engineering-plan.md#3b-team-track-tm): the TM4 slice row and the G01 gate.
4. [engineering-standards.md](../engineering-standards.md): definition of ready and done.
5. [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md): how LT-4 was run, which cases passed, and why case 11 is PARTIAL.
6. [team-track-dev-brief.md](team-track-dev-brief.md) sections 5 and 6: the invariants and traps still apply in full.

## 2. Execution model

Unchanged from [team-track-dev-brief.md](team-track-dev-brief.md) sections 2.1 to 2.4: the same worker card template, the same report shape, no worker merges or pushes.
Three changes for this track.

jd's decision of 2026-09-20 splits the work, and Phase A is already done.
F01 and F02 were implemented directly by the orchestrator, because both defects were assertion gaps whose diagnosis was fresh.
**Every remaining task goes to one worker agent per task**, in its own worktree, started from its own task card, reporting in the shape section 2.4 of the earlier brief fixes.
The orchestrator composes the cards, verifies each report, merges, updates the tracker, and asks jd at the stop points; it does not write product code from here on.

The tracker is `docs/telegram-task-control/team-burndown-tracker.md`, created before task F01, with one row per task: id, track, status, worker agent id, branch, merged commits, evidence summary, date.

Branches are `fix/<id>-<slug>` on the F track and `tm/<id>-<slug>` on the H track.

### 2.1 Testing is parked until the end, with one exception

jd's instruction of 2026-09-20: run only minimal unit tests while implementing, and park the rest until implementation is finished.
That is Phase V in section 6, and it holds the full server suite, the full T1 suite, every burn-in, both audits and the LT-4 re-run.

**During a task, a worker runs only:** the typecheck for the workspaces it touched, and the narrow unit tests covering the code it wrote or changed.
It does not run the full server suite, the T1 suite or any burn-in, and it does not wait on them to report DONE.

**The one exception is reproducing a defect.**
On the F track a worker still shows the defect happening before it fixes it, because a defect nobody has reproduced is not understood well enough to fix, and because an unasserted `must` clause is exactly how B12 and B17 reached production past two audits.
That reproduction is a unit test wherever the defect can be reached at that tier, which for both Phase A tasks it was.
Where a defect can only be reached through a scenario suite, the worker writes that scenario, records that it is unverified, and Phase V runs it.
So the red-then-green evidence stays, at the cheap tier only.

**The risk jd is accepting, recorded once.**
Parking the suites means a regression introduced in an early task is not discovered until Phase V, with several tasks stacked on top of it, and the bisect cost lands there rather than in the task that caused it.
The mitigation is that every task keeps its own branch and merges separately, so Phase V can bisect by task.

## 3. F track: defect burn-down

Every task also carries the standing criteria: typecheck clean for the workspaces it touched, `team.enabled` still off by default, and the changed-file credential sweep still passes.
Lint, the full suites and the burn-ins belong to Phase V, per section 2.1.

### Phase 0, make the suite trustworthy (runs in Phase V as V1)

F00B is listed here because it belongs with the F track conceptually, but by jd's instruction of 2026-09-20 it runs at the start of Phase V rather than before F03, since its whole purpose is to make the parked suites trustworthy when they finally run.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F00B | Sweep the wall-clock fixtures. | Three tests here take timestamps from the wall clock and assume they will differ, so they fail under load on a fast machine: `h6-route-proxy.spec.ts` (repaired as T20A), the migration 26 fixture (repaired as F00A) and `S-L1-33`, which failed once under full-suite load then passed in isolation with and without the change. Find the rest, make each deterministic by deriving the later timestamp from the earlier one rather than from `Date.now()` twice, and prove it by running the full server suite and the full T1 suite three times each with no failure. Audit 2 recorded the server suite at 274/274 and that figure does not reproduce on this machine, so audit 3 cannot honestly claim a green suite until this lands. Test code only; any product change found necessary stops the task and is reported. | |

### Phase A, unmet must requirements

These two are not ordinary bugs.
Each contradicts a `must` scenario in a slice that passed burn-in and two audits, because the scenario never asserted the clause it claims to cover.
Fix the assertion gap and the behaviour in the same task, so the requirement and its evidence land together.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F01 | `/help` shows current capabilities (B12). | TM-T1-4 requires "`/access` and `/help` show only current capabilities" and is marked `must`; [tm3-grants.spec.ts](../../e2e/tests/t1/tm3-grants.spec.ts) never sends either command. Add those assertions to TM-T1-4, show them failing on main, then make `renderTeamItemView`'s `/help` arm render the asking member's granted commands and keep the read-only four for a member with none. `/access` output is unchanged. TM-T1-4 passes with burn-in at 3 repeats. | |
| F02 | `/close` actually closes (B17, B14). | TM-T0-2 lists "closed/completed thread" as a grant-matrix state; [teamGrants.test.ts](../../server/src/teamGrants.test.ts) covers only that closing revokes grants, which is the half that already works. Add matrix cases for a closed item refusing a new grant and refusing every granted command, show them failing, then: persist a closed state (migration 27, this task owns it), refuse granted commands and further grants against a closed item, retire and unpin the anchor the way completion does, and refresh the access message with no actions on the pass that closes it. The closing receipt keeps saying `Thread closed; grants ended.` and becomes true. | |

### Phase B, make R-B true

R-B is an accepted requirement that no human can reach today, in either direction.
jd decided on 2026-09-19 that the teammate-initiated direction is not a real scenario, which leaves the owner direction as the one that must work.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F03 | Owner-side control to open an item thread (B2, B7). | An "Open Team thread" action on the work-item detail, enabled when a roster exists and the task is awaiting a response, calling `POST /api/task-control/team/items` through a new client method in `workspacesApi.ts`. The route refuses a prompt that is already `DONE` or `SKIPPED` with a specific error instead of returning 201 and creating unusable rows. Server tests cover both the success and the refusal; the UI is checked at both widths. | |
| F04 | Amend R-B to owner-initiated (B15). | **Done 2026-09-20 by the orchestrator**, since the wording was approved verbatim and the change is one table row. R-B in [teammate-design.md](teammate-design.md) now reads owner-initiated, and B15 is closed as resolved by decision. | |

### Phase C, the two defects that can brick a live team

Both were observed on the pilot, and neither is recoverable from inside the app.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F05 | Survive a supergroup upgrade (B8). | A send that fails with `group chat was upgraded to a supergroup chat` is treated as a migration signal: read `parameters.migrate_to_chat_id`, rewrite the chat id in the roster record and in every local row that carries it, republish the roster by compare-and-swap, and retry the send. The `migrate_from_chat_id` service message is handled the same way. A harness case upgrades a group mid-test and shows the next anchor delivered to the new id with no manual repair. | |
| F06 | Reissue a join code (B1). | An "Issue new join code" action on the Team status panel for an existing roster, minting a fresh `inviteId` by compare-and-swap the way creation does, so a reload no longer strands a created team. Server tests cover reissue and the `roster_conflict` path that made this unrecoverable. | |

### Phase D, anchor lifecycle

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F07 | Bound the anchor writes (B9, B11). | Compare anchor payloads on material content with the rendered age normalized out, so an edit is queued only when task state changes, and refresh the age on a much coarser schedule. Separately, stop re-enqueuing while an undelivered anchor for that thread already exists, and back off per thread after a failed anchor. A test shows an idle open item producing no edit across a window that currently produces several, and a permanently failing anchor producing one row rather than an unbounded series. | |
| F08 | A completed anchor tells the truth (B13). | Render a completed anchor from the completed state, dropping the blocker and "If you wait" sections and showing the run as finished, and retire the anchor only once the run has actually ended. A test covers the race that froze the contradictory card: prompt `DONE` while its `agent_run` row has no `ended_at`. | |

### Phase E, papercuts

One task, several small fixes, each in its own commit.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F09 | Wording and small behaviour (B5, B6, B18, and the age pluralization). | B5: carry both the person's name and the configured workstation label, and render each where it belongs. B6: **jd chose on 2026-09-20 to say it on the card**, not to change the dedupe. Name the recovery path on the personal question card so replying with an answer is known to produce fresh buttons. Do not touch `notifyWaitingTasks`' dedupe: the task may still sit with dead buttons, and that is the accepted trade for no extra posting and no re-post loop. B18: name the outcome, not only the allowance, on the `Answer and resume` button or its footer. Age pluralization: [card.ts:88](../../server/src/integrations/telegram/card.ts#L88) renders `blocked 1 hours ago` for any item aged 90 to 119 minutes; fix the singular and assert `at(90)`. | |

### Phase F, the pilot rig

Not product code, and not required before a release.
It is required before LT-5, because LT-5 cannot observe a Git exchange on the current rig.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| F10 | Pilot rig isolation (B19, B4, B3, B10). | B19: instance B gets its own clone of the team remote and its workspace points at it, so the two sides exchange work the way two workstations would. B4: the provider credential variables join the list `run-team-pilot.mjs` already scrubs, so `env -u ANTHROPIC_API_KEY` stops being required. B3: the web dev script reads `WEB_PORT` from `.env`, or startup logs the allowed origins and expected port. B10: spawn the child detached and signal its process group, so a scripted stop actually stops the pilot. | |

## 4. Re-running LT-4

After F01, F02 and F03 land, re-run the affected cases from [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md) rather than the whole document.

Case 11 is currently PARTIAL because `/close` closed nothing; F02 is what makes it a pass.
Case 12 was deferred into this re-run on 2026-09-20 rather than run on its own, so it is part of the set, and its Team-on baseline is already recorded in the check document.
Case 3's `/help` result changes with F01, so its row needs re-recording.
Case 2 gains a supported route with F03 and should be re-run through the UI instead of curl.

`H-TM-LT4` stays unrecorded until the real two-person run happens, per the solo check's closing note.
A solo re-run updates the check document's progress table and nothing in `human-verification.md`.

## 5. H track: TM4 handover

The only open progression slice.

**What handover is, in jd's words, 2026-09-20.**
A requester needs help finishing a work item.
Their workstation creates a feature branch for that item and pushes it to the remote, and at the same time opens a Telegram thread asking available teammates to take the incomplete item up and finish it.
Once a teammate accepts, that teammate checks out the branch and works on it with their own workstation and their own settings, their own provider login and their own quota, and hands the completed item back to the requester.

H01 writes the scenario table from that description, and must reconcile two differences from the design of record before it does.

jd settled the open questions on 2026-09-20 and the design was amended to match, so nothing here is contradictory any more.
The offer is an **open call**: it names no receiver, any available teammate may accept, and the first accept wins by the shared update rather than by which tap reached the bot first.
B17, R-A, RTC-11 and protocol.md were all amended.
The control record is therefore what arbitrates a simultaneous accept, which is why H02 comes before H03.

The trigger is needing help, not only an allowance about to run out, and R-A now names both the quota warning and `/handover` on the anchor.
Its scope, from the [engineering plan](engineering-plan.md) TM4 row: a snapshot commit through a temporary index, branch `aw/handover/<item>`, the control record, offer, accept and claim, a worktree run, requirement questions across workstations, return, and apply by ordinary merge.

[handover-rules.md](handover-rules.md) maps the states, the invariants and every eventuality phase by phase, marking each as settled by the design or proposed and awaiting jd.
Read it before H01; its section 7 says which slice owns each new rule.

Two things are worth stating plainly before anyone starts.

Neither of TM4's two Git records exists yet.
`refs/aw/items/<item>/control` and `aw/handover/*` are referenced nowhere in `server/src`; the only Git-carried record built today is the roster `refs/aw/team`, and `item_link.control_head` is a placeholder column that no caller ever writes.
The control record is the harder half, because it carries state, epoch, requester, executor, branch and last command id, and its compare-and-swap rests on the host rejecting a non-fast-forward update of a ref outside `refs/heads`.
LG-1 already proved that holds on GitHub, recorded as task T05.

TM4's gates are not only G01, which an earlier version of this brief got wrong.
[engineering-plan.md:411-412](engineering-plan.md#L411-L412) requires the G01 record and G02 as revised, with G03 applying to the control record and G04 as jd's governance note.
G01 was recorded on 2026-09-20 and no longer blocks anything: the receiver accepts the task and resumes under their own login, so nothing is delegated and no credential is shared.
**G02 is what now gates enabling handover**, and it asks a different question, whether provider, bot, Git and signing credentials are isolated on each machine; a known gap is already recorded, the `.env` bot token being readable by any same-user process.
Building TM4 is blocked by none of them.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| G01 | Record the handover governance decision. | **Done 2026-09-20.** Recorded in [implementation.md](implementation.md) section 6b: the handover delegates nothing, so a receiver who accepts a task and resumes it under their own login is ordinary use. It holds only while acceptance stays an explicit human action and no credential is ever shared, so a move to auto-accept re-opens it. | |
| H01 | TM4 scenario table. | Commit `docs/e2e-scenarios/tm4.md` written from [handover-rules.md](handover-rules.md), whose five decisions jd settled on 2026-09-20, specifying TM-T0-6, TM-T0-7 and TM-T1-H1 to TM-T1-H3 in the shape the TM3 table uses. Cover the open call's simultaneous accept, a partial return by a receiver who cannot finish, the proof required before a requester reacquires ownership, and the capture preview's secret warning. No product code in the commit. | **jd**: skim. |
| H02 | The item control record. | `refs/aw/items/<item>/control` with `state.json` and `events/<command id>.json`, fetch and compare-and-swap write, fast-forward or rejection only; `item_link.control_head` finally written and read. On an uncertain push, fetch and look for the command id before retrying; on a lost race, re-read and re-validate rather than re-applying. Owns TM4's migration, **number 29 or later**, adding the seven designed actions. F02 took 27 and F07 took 28, the latter unplanned: bounding the anchor writes needed durable state saying which outbox rows were offered as an anchor, because `markTelegramThreadAnchorGone` clears the thread's pointer and an anchor and a `/task` reply render the same shape. Build the lifecycle from [protocol.md](protocol.md)'s table, which is authoritative, rather than a summary of it. TM-T0-6 passes. | |
| H03 | Capture and offer. | Snapshot commit through a temporary index, branch `aw/handover/<item>` pushed, then the control record written as `OFFERED` with epoch 1 and the requested provider and model, naming no receiver. The capture preview lists every uncommitted file by path and flags credential shapes, which take their own confirmation. TM-T0-7 passes. | |
| H04 | Accept, claim and run. | Receiver accepts and claims, runs in a worktree under their own provider, and requirement questions cross workstations while the requester is stopped. TM-T1-H1 and TM-T1-H2 pass. | |
| H05 | Return and apply. | Return, then apply by ordinary merge, then task complete. TM-T1-H3 passes; the full T1 suite passes; burn-in at 3 repeats on the H scenarios. | |

LT-5 is optional and comes after H05.
It cannot run until F10 gives instance B its own clone.

## 6. Ordering and gates

```
implementation, minimal unit tests only (section 2.1)
  F01, F02        unmet must requirements            (done)
  F04             R-B amended                        (done)
  F03             make R-B true
  F05, F06        stop a live team bricking
  F07, F08        anchor lifecycle
  F09             papercuts
  H01             TM4 scenario table
  H02             the item control record + migration 29
  H03             capture and offer
  H04             accept, claim, run, partial return
  H05             return and apply

Phase V, verification, once implementation is finished
  V1              F00B, the wall-clock fixture sweep
  V2              full server suite, full T1 suite, typecheck, lint
  V3              burn-ins: TM-T1-4, TM-T1-5, the closed-thread case, TM-T1-H1 to H3
  V4              audit 3 over the F track, audit 4 over the H track
  V5              LT-4 re-run, cases 2, 3, 11 and 12

deferred, needs people or a rig change
  F10             pilot rig isolation, only needed before LT-5
  LT-3, LT-4      real two-person runs with Yousef
  LT-5            optional, after F10 and H05
```

Phase V is where every parked suite runs, and it is not optional: no task in the list above is done in the sense the standing criteria mean until V2 and V3 have passed over it.
V1 comes first inside Phase V, because until the wall-clock fixtures are deterministic a red in V2 cannot be trusted to mean a real regression.

Run **audit 3** over the F track and **audit 4** over the H track, both inside Phase V, using section 4 of [team-track-dev-brief.md](team-track-dev-brief.md) unchanged.

Phases A to E are independent of each other and could be reordered, with one exception: migrations are handed out in order. F02 owns 27 and F07 owns 28, so any later task needing one takes 29 and up.
Do not run two harness tasks at once.

## 7. New traps, in addition to section 6 of the earlier brief

- **A `must` clause with no assertion.** B12 and B17 both shipped through burn-in and two audits because the scenario text claimed coverage the test did not have. When a task cites a scenario id, read the test, not the table.
- **The two-button answer card.** While a teammate holds both `answer` and `resume`, `/answer <text>` mints `Save answer` and `Answer and resume` together, and the second completes the owner's task, closes the item and revokes every grant. This ends a test session as easily as it ends a pilot run (B18).
- **`/resume` needs a saved answer.** With none, it is refused as plain text with no card, so a test that expects a resume card must save an answer first, or use `Answer and resume`.
- **Access-message buttons are positional.** The access message is edited in place, so its buttons appear wherever it was first posted, not at the bottom of the group. They are easy to miss and easy to wrongly conclude are absent (B14).
- **Saving an answer moves the prompt.** It goes `BLOCKED` to `TODO` with a hold and clears the pending question, after which a fresh `/answer` is refused with `409 prompt_not_blocked`. Order any scenario that needs a blocked prompt accordingly.
- **A closed thread is not closed today.** Until F02, do not build anything that assumes closure is enforced.

## 7b. Resuming in a fresh session

Read [team-burndown-tracker.md](team-burndown-tracker.md) first: it holds the starting commits, every task's status and evidence, and the log of what happened, and it is the only state carried between sessions.
Then read the open entries of [pilot-bug-log.md](pilot-bug-log.md); a fixed entry says so at the top of the entry, with the task and commits that closed it.

Rough order of magnitude for what is left, from the two tasks already done.
F01 took one session slice: two red tiers, the fix, a burn-in and a full suite.
Treat each of these as one worker task with its own branch, and expect the test work to be the larger half.

| Task | Size | Why |
| --- | --- | --- |
| F02 | large | Owns migration 27, changes authorization, the anchor lifecycle and the access refresh at once. The only task here that touches the schema. |
| F03 | medium | Web UI plus an API refusal; the UI half needs both widths checked. |
| F04 | small | Documentation only, and jd must confirm the wording. |
| F05 | large | Needs the fake to model a supergroup upgrade mid-test, which no scenario does yet. |
| F06 | small | One panel action and a compare-and-swap that already exists for creation. |
| F07 | medium | Two independent changes, a payload comparison and a per-thread back-off, each needing a test that watches for the absence of writes. |
| F08 | medium | Turns on a race the current code loses; the test is the hard part. |
| F09 | medium | Four unrelated small fixes, each its own commit, and jd must choose the B6 option. |
| F10 | medium | Rig only, no product code, and only needed before LT-5. |
| G01 | done | Recorded 2026-09-20. |
| H01 to H05 | very large | TM4 in five tasks. Neither of its two Git records exists yet, and the control record is the harder half. Budget more than the whole F track. |

Two standing constraints carried from every prior task: no live Telegram credential, no paid provider, no remote write and no push, and never two harness runs at once.

Sequence, gates and audits are in section 6.

## 8. Done means

Audit 3 and audit 4 pass; B1 to B14 and B17 to B19 are closed or explicitly deferred with a reason in the bug log; B15 is closed by the F04 amendment and B16 stays a pointer to B11; LT-4's re-run rows are recorded; and the orchestrator reports to jd the commits per task, test counts per tier, burn-in results, the G01 decision, real checks and outcomes, both audit results, design corrections made, and anything left open.

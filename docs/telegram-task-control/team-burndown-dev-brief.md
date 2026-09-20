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

jd's decision of 2026-09-20 splits the work.
Phase A, tasks F01 and F02, is implemented directly by the orchestrator, because both defects are assertion gaps whose diagnosis is fresh and whose fix depends on understanding how they escaped.
Everything from Phase B onward goes to one worker per task in its own worktree, as the earlier brief describes.

The tracker is `docs/telegram-task-control/team-burndown-tracker.md`, created before task F01, with one row per task: id, track, status, worker agent id, branch, merged commits, evidence summary, date.

Branches are `fix/<id>-<slug>` on the F track and `tm/<id>-<slug>` on the H track.

### 2.1 Every bug fix starts with a failing test

This is the rule that matters most on the F track, and it is why B12 and B17 shipped.
For each defect, the worker first writes the check that should already have caught it, at the tier the defect lives at, and shows it failing on unmodified main.
Only then does it fix the product code and show the same check passing.
The report must carry both results, the red one and the green one, as separate command outputs.

A worker that cannot make the check fail first stops and reports BLOCKED rather than writing the fix, because a defect nobody can reproduce is not understood well enough to fix.

## 3. F track: defect burn-down

Every task also carries the standing criteria: typecheck and lint clean, no test that passed before now fails, `team.enabled` still off by default, and the token sweep still passes.

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
| F04 | Amend R-B to owner-initiated (B15). | Documentation only, no product code. R-B in [teammate-design.md](teammate-design.md) is amended to owner-initiated threads, with jd's 2026-09-19 decision and its reasoning recorded, so the written requirement matches what is built. B15 is closed as resolved by decision, and the note that `/discuss` becomes reachable again if cross-member task visibility is ever built is kept. | **jd**: confirm the amended wording. |

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
| F09 | Wording and small behaviour (B5, B6, B18, and the age pluralization). | B5: carry both the person's name and the configured workstation label, and render each where it belongs. B6: either exclude expired actions from the notifier's dedupe so a still-waiting task gets a fresh card, or say on the card that replying with an answer produces fresh buttons. B18: name the outcome, not only the allowance, on the `Answer and resume` button or its footer. Age pluralization: [card.ts:88](../../server/src/integrations/telegram/card.ts#L88) renders `blocked 1 hours ago` for any item aged 90 to 119 minutes; fix the singular and assert `at(90)`. | **jd**: choose the B6 option. |

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
Its scope, from the [engineering plan](engineering-plan.md) TM4 row: a snapshot commit through a temporary index, branch `aw/handover/<item>`, the control record, offer, accept and claim, a worktree run, requirement questions across workstations, return, and apply by ordinary merge.

Two things are worth stating plainly before anyone starts.

Neither of TM4's two Git records exists yet.
`refs/aw/items/<item>/control` and `aw/handover/*` are referenced nowhere in `server/src`; the only Git-carried record built today is the roster `refs/aw/team`, and `item_link.control_head` is a placeholder column that no caller ever writes.
The control record is the harder half, because it carries state, epoch, requester, executor, branch and last command id, and its compare-and-swap rests on the host rejecting a non-fast-forward update of a ref outside `refs/heads`.
LG-1 already proved that holds on GitHub, recorded as task T05.

TM4 is gated on G01, which is jd's decision and not an engineering question.

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| G01 | Record the handover governance decision. | jd records whether a teammate running a handed-over task on their own login and subscription, after personally accepting it, counts as ordinary use of that subscription. TM4 may be built behind the disabled handover capability before this exists, but handover is enabled only after it. | **jd**: the decision, blocking enablement. |
| H01 | TM4 scenario table. | `docs/e2e-scenarios/tm4.md` committed, specifying TM-T0-6, TM-T0-7 and TM-T1-H1 to TM-T1-H3 in the shape the TM3 table uses. No product code in the commit. | **jd**: skim. |
| H02 | The item control record. | `refs/aw/items/<item>/control` with `state.json` and `events/<command id>.json`, fetch and compare-and-swap write, fast-forward or rejection only; `item_link.control_head` finally written and read. On an uncertain push, fetch and look for the command id before retrying; on a lost race, re-read and re-validate rather than re-applying. TM-T0-6 passes. | |
| H03 | Capture and offer. | Snapshot commit through a temporary index, branch `aw/handover/<item>` pushed, then the control record written as `OFFERED` with epoch 1, the named receiver and the requested provider and model. TM-T0-7 passes. | |
| H04 | Accept, claim and run. | Receiver accepts and claims, runs in a worktree under their own provider, and requirement questions cross workstations while the requester is stopped. TM-T1-H1 and TM-T1-H2 pass. | |
| H05 | Return and apply. | Return, then apply by ordinary merge, then task complete. TM-T1-H3 passes; the full T1 suite passes; burn-in at 3 repeats on the H scenarios. | |

LT-5 is optional and comes after H05.
It cannot run until F10 gives instance B its own clone.

## 6. Ordering and gates

```
F01, F02          unmet must requirements, first
F03, F04          make R-B true
F05, F06          stop a live team bricking
F07, F08          anchor lifecycle
F09               papercuts
  audit 3         after F09
LT-4 re-run       cases 2, 3 and 11
F10               rig, only needed before LT-5
G01               jd, blocking enablement
H01 to H05        TM4
  audit 4         after H05
LT-5              optional
```

Run **audit 3** after F09 and **audit 4** after H05, using section 4 of [team-track-dev-brief.md](team-track-dev-brief.md) unchanged.

Phases A to E are independent of each other and could be reordered, with one exception: F02 owns migration 27, so any later task needing a migration takes 28 and up.
Do not run two harness tasks at once.

## 7. New traps, in addition to section 6 of the earlier brief

- **A `must` clause with no assertion.** B12 and B17 both shipped through burn-in and two audits because the scenario text claimed coverage the test did not have. When a task cites a scenario id, read the test, not the table.
- **The two-button answer card.** While a teammate holds both `answer` and `resume`, `/answer <text>` mints `Save answer` and `Answer and resume` together, and the second completes the owner's task, closes the item and revokes every grant. This ends a test session as easily as it ends a pilot run (B18).
- **`/resume` needs a saved answer.** With none, it is refused as plain text with no card, so a test that expects a resume card must save an answer first, or use `Answer and resume`.
- **Access-message buttons are positional.** The access message is edited in place, so its buttons appear wherever it was first posted, not at the bottom of the group. They are easy to miss and easy to wrongly conclude are absent (B14).
- **Saving an answer moves the prompt.** It goes `BLOCKED` to `TODO` with a hold and clears the pending question, after which a fresh `/answer` is refused with `409 prompt_not_blocked`. Order any scenario that needs a blocked prompt accordingly.
- **A closed thread is not closed today.** Until F02, do not build anything that assumes closure is enforced.

## 8. Done means

Audit 3 and audit 4 pass; B1 to B14 and B17 to B19 are closed or explicitly deferred with a reason in the bug log; B15 is closed by the F04 amendment and B16 stays a pointer to B11; LT-4's re-run rows are recorded; and the orchestrator reports to jd the commits per task, test counts per tier, burn-in results, the G01 decision, real checks and outcomes, both audit results, design corrections made, and anything left open.

# Telegram test execution - 2026-09-28

> **Historical execution report.** Results and open findings apply to the
> checkout and environment used on this date. Later UI additions are labelled as
> addenda; this file is evidence, not current setup instructions. Personal names,
> account identifiers and machine-specific paths are redacted in this public copy.

This run used the existing scenario definitions in
[`e2e-scenarios/h6.md`](e2e-scenarios/h6.md),
[`e2e-scenarios/l1.md`](e2e-scenarios/l1.md), the L3 scenario files, and the
TM0-TM4 Team and handover scenario files.
The live run used the dedicated test bot and signed-in Telegram test client.
No credential values were printed.

## Result

Core Telegram transport and task-control behavior passed on both the fake and
real Telegram backends. The overall release gate is not green because the
operator app was not running, Claude quota was exhausted, and the T3 coverage
gate reports documented rows with no result.

| Layer | Result | Evidence |
| --- | --- | --- |
| Process hygiene | PASS | No abandoned Playwright, npm, browser, app-server, or harness process before the run; no test process remained afterward. |
| Live setup and secrets | PASS | Live file exists outside the repository with mode `0600`; all required keys are set; setup, identity, session-reuse, and secret-sweep cases passed. |
| H6 contracts/self-tests | 26/26 PASS | Proxy fidelity, long polls, cuts, stale state, bot guard, setup validation, sanitization, and contract replay. |
| Focused T1 fake-Telegram browser suite | 42/42 PASS | H6 guard/proxy/stale-state and L1 pairing, authorization, controls, races, restart, outage, expiry, redaction, capability, and panel cases. Runtime: 9.4 minutes. |
| Focused server Telegram suite | 131/132 PASS | All Telegram behavior passed. One settings-default test assumed no local `.env` workstation-label override and saw the configured `Requester workstation` value instead of the hostname. |
| Full T3 real-Telegram suite | 59 PASS, 3 FAIL, 1 NOT RUN | All executed H6 phone-driver, L1 task-control, Codex, L3 cards/views/edits, and route-recovery behavior passed. Runtime: 43.8 minutes against the 25-minute target. |
| Team/handover server suite | 177/177 PASS | Lifecycle and CAS races, expiry/restart, capture/publish, grants, receiver execution, contention, return/review/apply, conflicts, close guards, retention, roster, routing, and thread requests. |
| Team harness self-test | 1/1 PASS | Two isolated app environments shared fake Telegram and Git, exchanged updates and refs, survived a route cut, and shut down cleanly. |
| Web component suite | 8/8 PASS | Handover controls and the surrounding web UI component tests passed; web and E2E TypeScript checks passed. |
| Focused Team/handover browser suite | 28/28 PASS | Real pages covered blocked-item thread controls, close guards, publish, review/apply, held states, settings gates, roster, routing, anchors, grants, expiry/revoke, and full cross-workstation handover/return. Runtime: 10.4 minutes across two runs. |
| Responsive handover verifier | PASS | At 390px and 1280px: no horizontal overflow, capability-off reason visible, credential risk visible, open-call wording present, and Publish disabled until confirmation. |
| Contract recording | REVIEW | `e2e/contracts/telegram-bot-api.json` was refreshed with sanitized dates and message/update IDs; the diff is intentionally uncommitted. |

## UI and team handover coverage

The automated checks now cover the user-facing Team surfaces as well as the
server protocol. They exercised Team creation and join confirmation, roster
convergence after restart, live settings changes, item anchors and read-only
views, owner-only group routing, cross-owner thread consent, grants and their
revocation/expiry, handover preparation and publishing, held-item labels and
disabled owner actions, receiver execution, return review, and apply.

Two stale test-rig assumptions were repaired during the run:

- The harness build hash included `next-env.d.ts` and `tsconfig.tsbuildinfo`,
  although Next and TypeScript regenerate them for each teammate's dist
  directory. The two builds invalidated each other and exceeded Playwright's
  setup timeout. Generated files are now excluded and a regression test covers
  the hash behavior.
- The two-width verifier omitted the required `held` prop added to
  `HandoverControlView`. Its neutral fixture now supplies `held: null`.

### Web handover surface added after the run

The Tasks page now has a `Team handovers` view backed by a thin HTTP adapter
over the existing Git-carried handover engine. It lists requester and receiver
state, repository readiness, the local task/run, and exposes Accept, Decline,
Withdraw and Return where the state machine permits them. Accept uses the
existing receiver path, which fetches the offered branch and creates the
detached worktree in the already registered Team repository. No database
migration, control-record change, or new handover transition was introduced.

The existing Team thread panel now also reads and changes context, answer and
resume grants, and closes the thread with the existing live-handover guard.

| Case | UI check | Expected |
| --- | --- | --- |
| UI-HO-01 | From a waiting task, open its Team thread and publish a handover. | The requester sees the item in `Tasks > Team handovers` as `offered`, with Withdraw. |
| UI-HO-02 | Open `Team handovers` on workstation B. | The offer appears within five seconds with requester, provider, deadline and repository readiness. |
| UI-HO-03 | Use Decline on B. | The command is applied once and both workstations converge on the new status. |
| UI-HO-04 | Publish again and use Accept on B. | The offered branch is fetched, a detached worktree/task is created, the agent starts, and `Open task` selects it. |
| UI-HO-05 | Stop or finish the receiver run and use Return work. | A full or partial result is published and workstation A can review/apply it from its task detail. |
| UI-HO-06 | Toggle context, answer and resume in Team access. | The teammate's Telegram controls follow the selected grants; the owner remains implicit and read-only. |
| UI-HO-07 | Close the Team thread with no live handover, then with a live offer. | The first closes and revokes grants; the second is refused until the offer is withdrawn or returned/applied. |
| UI-HO-08 | Repeat the inbox checks at phone width. | Rows wrap without horizontal overflow and every available command remains reachable. |

Focused post-change checks: shared/server/web typechecks passed; 21 handover and
grant server tests passed; 2 handover/thread web component tests passed; both
`/tasks` and `/api/task-control/team/handovers` returned HTTP 200 from the
running development app.

### Live UI round trip

A real two-workstation run was subsequently reported as passed using the two
pilot bots and the shared GitHub Team repository. This section is a historical
operator narrative, not self-contained transport proof: the saved summary did
not include Telegram `SENT` message ids or callback/action receipts, nor did it
capture the transient result ref before apply deleted it.

- Requester task `WI_HANDOVER_SMOKE` published item
  `<redacted-item-id>` from the web handover control with Codex.
- The receiver discovered and accepted it from `Tasks > Team handovers`; this
  created workspace `handover-<redacted-item-id>` and started run
  `<redacted-run-id>`.
- Codex created `handover-smoke.txt` with the exact requested line and finished
  successfully. The receiver returned a `full` result from the web inbox.
- The requester reviewed, explicitly accepted and applied commit
  `8b77ec0542841f6f3f069eebab81fafe8fd5aef2` from the web task detail.
- Final state was `COMPLETED` at epoch 2, the requester work item was `DONE`,
  the applied file matched byte-for-byte, and the temporary remote branch was
  deleted while the control record remained.

A later instrumented attempt on 2026-09-29 found that the visible receiver
Accept and Return work buttons emitted no POST under Playwright; that attempt
was completed through the same web action routes instead. It must not be
described as receiver-button proof. See
[`live-two-workstation-roundtrip-20260929.md`](live-two-workstation-roundtrip-20260929.md).
The replacement verifier now requires durable Telegram deliveries, applied
action evidence, staged control/result refs, reverse return, and apply rather
than accepting configured bot/group constants.

The run exposed and fixed four integration gaps that local-bare Git fixtures
did not reveal: HTTPS remotes were incorrectly passed to `git --git-dir` during
package verification; Return work used a state label instead of the ended-run
signal; receiver run/worktree identity was not recovered after restart; and
successful apply did not call the existing handover-branch retention helper.

## Open findings

### TG-01: Claude provider capacity blocked two cases

- Failed: `S-CLT-02`, `S-CLT-27`.
- Not run because the serial prerequisite failed: `S-L1-31`, `S-CLT-03`, `S-CLT-29`.
- Recorded provider response: `You're out of extra usage`, resetting October 2 at 19:00 UTC.
- The run ended before any provider event or tool call, so this is not evidence
  of a Telegram transport defect.

Retest after quota is available:

```bash
npm run e2e:live --workspace e2e -- tests/t3/l1-live-claude.spec.ts
```

### TG-02: Operator-bot coexistence was not proven

Both parts of `S-H6-19` failed because
`http://127.0.0.1:4000/api/task-control/telegram` did not report the operator
app polling at the start of the run. The dedicated test bot itself remained
healthy throughout.

With the normal operator app running on port 4000 and its Live Telegram panel
showing `polling`, rerun:

```bash
npm run e2e:live --workspace e2e -- tests/t3/l1-live.spec.ts tests/t3/l1-live-route-cut.spec.ts
```

Expected: both `S-H6-19` parts pass, the operator bot ID remains distinct from
the test bot, `lastPollAt` advances through restarts and route cuts, and no
polling-conflict error appears.

### TG-03: T3 completion gate is incomplete and over target

`S-H6-36` failed because the run took 43.8 minutes and 24 documented L3 T3
row IDs had no result in the Playwright report. Some behavior may be exercised
under broader test titles, but the gate requires every row ID to be reported.
The missing IDs are recorded in `e2e/test-results/t3-run.json`.

### TG-04: Settings test is environment-sensitive

`S-L3-F3-13` expects the workstation-label default to be the hostname, while
the repository `.env` intentionally sets `TASK_CONTROL_WORKSTATION_LABEL`.
This is a test-isolation issue; the configured label behavior itself worked in
the Telegram runtime tests. The summary file passed 21/21 when rerun with the
hostname supplied as the explicit default.

## Human checks

Please record these against this run:

1. **S-H6-33 / S-L3-A-21, physical-phone look check:** open the dedicated test
   bot chat and inspect the latest question, answer, result, status/help, and
   edited cards. Confirm no clipped text; sensible section order and line
   breaks; collapsed details expand correctly; emoji/accents remain intact;
   literal markup stays literal; button labels fit; edits replace rather than
   stack messages.
2. **S-H6-34, agent-behavior check:** inspect the successful real Codex
   Save-answer/Resume exchange and confirm it used the phone answer sensibly.
   Repeat for Claude after TG-01 can be rerun.
3. **S-H6-35 / H-L1-14, optional second-account authorization:** from an
   unpaired Telegram account, send a normal message and `/start` with a wrong
   code, then attempt an old button. Expect no instruction to be recorded, no
   useful reply to the messages, and rejection of the button action.
4. **S-H6-19 setup:** keep the normal operator app polling its own bot while
   the focused coexistence rerun above executes.
5. **Real Team group and two-workstation handover:** with two actual Telegram
   accounts and two signed-in workstations, create/join a Team, publish a
   handover, accept and run it on the second workstation, return it, then apply
   it on the first. Confirm the group cards identify the right owner/holder and
   each command appears only once. The automated equivalent uses fake Telegram
   and cannot prove real account permissions, notification delivery, or device
   rendering.
6. **Full-page visual check:** inspect Agents settings and the Tasks handover
   panel on one phone-sized and one desktop viewport. Confirm labels, long
   branch/file names, credential warnings, held banners, and review conflicts
   remain readable and no controls overlap. Automation proves fit/overflow and
   behavior, but not subjective visual quality.

## Unattended UI-first campaign addendum

This addendum records the follow-on unattended campaign from the same date.
The campaign rediscovered the active topology instead of relying on the earlier
notes: the primary checkout was
`<user-home>/ai-workstation-team-pilot`, the secondary checkout was
`<user-home>/ai-workstation-team-pilot-b`, and both had uncommitted Team
handover UI/runtime changes. The primary dev stack was initially listening on
`4100/3100`; the secondary Team pilot stack was listening on `4200/3200`.
The primary stack was stopped so the Playwright harness could own its required
`4100/3100` ports. The secondary stack was left alone.

### Addendum result

| Layer | Result | Evidence |
| --- | --- | --- |
| Goal and safety preflight | PASS | Persistent goal created; git status and process/port inventory recorded; existing uncommitted changes preserved. |
| Typecheck | PASS | `npm run typecheck` passed for shared, server, web and e2e. |
| Server suite | REVIEW | Broad server run passed 632/634. `telegramLiveRuntime.test.ts` and `telegramSummary.test.ts` both passed on isolated rerun, confirming the broad failures were fixture/environment-sensitive. |
| Web component suite | PASS | `npm run test --workspace web` passed 102/102. |
| Shared package suite | PASS | `npm run test --workspace shared` passed 91/91. |
| E2E harness unit suite | PASS | `npm run test --workspace e2e` passed 48/48. |
| T1 browser/UI suite | REVIEW | Clean rerun passed 147/149 after freeing harness ports. The two deterministic failures are listed below. |
| T2 visual project | BLOCKED | `npm run e2e:visual --workspace e2e` reports no tests found. |
| T3 live tier | BLOCKED | Approval for real Telegram/GitHub stateful network execution was rejected by the reviewer, so no live traffic was sent. |
| Burn-in | BLOCKED | `npm run e2e:burn-in --workspace e2e` stopped on the known C3 browser failure after 2 passes. |

### New findings from addendum

#### TG-05: C3 Team thread button disabled for stored BLOCKED Team item

`tests/t1/c3-blocked-awaits-response.spec.ts` expects the task detail Team
thread panel to enable `Open Team thread` for a stored `BLOCKED` item whose
phone/team status says the owner needs to decide. The clean T1 browser run and
burn-in both found the button disabled:

```text
Locator: getByLabel('Team thread').getByRole('button', { name: 'Open Team thread' })
Expected: enabled
Received: disabled
```

Evidence:
`e2e/test-results/c3-blocked-awaits-response-744bd-rol-is-enabled-on-that-item-t1/trace.zip`
and `test-failed-1.png`.

#### TG-06: TM4 phone-style apply expects retained branch after apply

`tests/t1/tm4-handover.spec.ts` H3 failed twice. After requester phone-style
apply, the control record remained but the handover branch for the applied item
was absent; another handover branch from the fixture remained. The earlier web
review/apply browser case passed.

```text
Expected refs/heads/aw/handover/<item> to be present
Received refs included the control ref but not that branch
```

This may be a stale test expectation if successful apply is meant to delete the
temporary handover branch while retaining the control record; server tests and
the previous live report both describe branch deletion after apply.

Evidence:
`e2e/test-results/tm4-handover-TM-T1-H3-the--60d93-d-applies-it-from-his-phone-t1/trace.zip`.

# Solo two-account Team thread and grant check (LT-4 by yourself)

> **Historical one-machine pilot runbook and evidence record.** Bot names,
> labels, ports, paths and dates below belong to that rig. They are not general
> setup values. Use the [Team and Telegram user guide](../team-and-telegram-user-guide.md)
> for current product instructions.

Run this after [solo-team-join-check.md](solo-team-join-check.md) has passed and
the roster holds both people and both bots.
This is the LT-4 scope from [tm3.md](../e2e-scenarios/tm3.md): a real item
thread, real grants, and a real resume that starts exactly one run on the
owner's workstation.

What Git carries, and what this check does not reach.
The design gives the remote three machine records
([teammate-design.md](teammate-design.md), section 8.3): the roster
`refs/aw/team`, the item control record `refs/aw/items/<item>/control`, and the
handover branch `aw/handover/<item>`.
At the time this LT-4 runbook was written, only the roster portion was in its
scope, and it was genuinely remote-mediated:
each instance keeps its own bare mirror at `.agent-console/team/remote.git` and
compare-and-swap pushes with `--force-with-lease`
([teamRoster.ts:213-236](../../server/src/teamRoster.ts#L213-L236)), so case 1
does exercise a real round trip through GitHub.
The later TM4 implementation added per-item control refs, handover branches,
capture, receiver execution, return and requester apply. No case below proves
those later paths; the absence of a handover test is this runbook's historical
scope, not current product status. The dated two-workstation evidence is indexed
from [README.md](README.md).

Roles: account A is the owner (workstation label `Requester operator`, bot `<requester-bot-username>`,
instance A on ports 3100/4100), account B is the teammate (label `Requester operator`, bot
`<receiver-bot-username>`, instance B on ports 3200/4200).

## Command surface

View commands, usable by any team member, and accepting either an inline item
tag or a reply into the thread:

```
/task    /status    /access    /help          (optionally  awi1_<24hex>  or  #item_<24hex>)
```

Granted commands, which take no item argument and therefore **must be sent as a
reply to a message in that item's thread** (the pinned anchor, the access
message, or a card the bot posted):

```
/context      /answer <text>      /resume      /close
/grant <context|answer|resume|all>            /revoke [context|answer|resume|all]
```

Cross-owner request, sent anywhere in the group:

```
/discuss @<owner bot username> <promptId>
```

Grant capabilities are `context`, `answer` and `resume`; `all` is input
shorthand and is never stored as a capability.
Save answer needs `answer`; Answer and resume needs both `answer` and `resume`.
The owner never needs a grant on their own item.
Ordinary Team thread/grant action buttons expire after 10 minutes and are not
renewed automatically; issue the command again. Persistent handover offer and
Return-work reminders are a later exception: their existing local action refs
renew in place while the shared decision remains open, without another Telegram
post.

## Case 0a - turn on notifications and remote actions (precondition)

`setup:team-pilot` writes `TASK_CONTROL_NOTIFICATIONS_ENABLED=false` and
`TASK_CONTROL_REMOTE_ACTIONS_ENABLED=false` on purpose, and nothing in this
check works until both are on.
With notifications off, `notifyWaitingTasks` returns before posting anything
([runtime.ts:687](../../server/src/integrations/telegram/runtime.ts#L687)), so
no question card is ever pushed.
With remote actions off, every button tap is refused by `assertRemoteActions`
([taskControl.ts:203-204](../../server/src/taskControl.ts#L203-L204)), which
would fail cases 5 to 9.

Turn both on in instance A's Agents settings; the saved setting overrides the
`.env` default.
The notifier polls waiting tasks on a timer, so a question that was already
waiting is posted on the next pass rather than being lost.

Instance B needs neither: the teammate taps cards issued by the owner's bot, and
those callbacks are handled on the owner's workstation.

## Case 0b - a task waiting on a question (precondition)

Every later case needs one owner-side task in `AWAITING_RESPONSE`.
A question exists only when an execute run has finished and its handoff agent
returned `WAIT_FOR_HUMAN`, or listed a blocker with `requiresHuman`
([workspaces.ts:1138-1145](../../server/src/workspaces.ts#L1138-L1145)).

On instance A, in the throwaway team workspace, run a task whose prompt forces a
human decision, for example:
"Pick between storing amounts as integer cents or as decimal. Do not choose
yourself; stop and ask the human which one to use."

Pass: the Tasks view shows the task as Awaiting response, and account A's
private chat with `<requester-bot-username>` receives the personal question card.

`AWAITING_RESPONSE` is a derived operational state, not a stored one.
The prompts API reports `status: "BLOCKED"`, and
[operationalState.ts:10](../../server/src/operationalState.ts#L10) maps `BLOCKED`
to `AWAITING_RESPONSE`, which is what `notifyWaitingTasks` selects on
([workspaces.ts:1612](../../server/src/workspaces.ts#L1612)).
So a prompt sitting at `BLOCKED` with its run `DONE` is the pass, not a failure;
do not wait for a literal `AWAITING_RESPONSE` in the API response.

A run that fails still produces a question, because an unparsable or explicitly
waiting handoff recommendation becomes `WAIT_FOR_HUMAN`
([handoffCoordinator.ts:23](../../server/src/handoffCoordinator.ts#L23)).
That is enough for cases 2 to 6, but case 7 starts a real run, so the owner's
provider must actually work before that case.
Start instance A with `env -u ANTHROPIC_API_KEY` so the pilot uses the Claude
Code login rather than a key inherited from the launching shell.

## Case 1 - roster visible on both sides

Press Refresh team on both Agents pages.

Pass: both list two members and two distinct bot usernames, and the owner side
also shows the one-member invite link.

## Case 2 - open the item thread

There is no UI for this yet, so call the API on instance A:

```bash
curl -s http://127.0.0.1:4100/api/workspaces | python3 -m json.tool | head -40
curl -s http://127.0.0.1:4100/api/workspaces/<workspaceId>/prompts | python3 -m json.tool
curl -s -X POST http://127.0.0.1:4100/api/task-control/team/items \
  -H 'content-type: application/json' -d '{"promptId":<promptId>}'
```

Pass: the group receives a pinned anchor card for the item, plus an access
message reading `Item access / Requester operator: owner / Requester operator: read only / #item_<id>`.
The response carries the `awi1_...` item id; keep it for the view commands.

## Case 3 - read-only views for the teammate

From account B in the group, send `/task`, `/status`, `/access` and `/help`,
each as a reply to the anchor.

Pass: each is answered once, by the owner's bot only.
Instance B stays silent, and no receipt or state change is recorded.

## Case 4 - ungranted command is refused

From account B, reply to the anchor with `/resume`.

Pass: exactly one refusal naming the missing capability and the owner, in the
shape `Ask Requester operator to grant resume on this item.`
No action card appears and nothing starts.

## Case 5 - grant answer

From account A, reply to the anchor with `/grant answer`, then tap the grant
card that the owner's own bot posts.

Pass: the existing access message is **edited in place** to
`Requester operator: answer` - a second access message is a failure.
`/access` from either account then shows the same single capability.

## Case 6 - teammate answers

From account B, reply to the anchor with `/answer use integer cents`, then tap
Save answer on the card that arrives.

Pass: one action card, issued by the owner's bot and bound to account B; one
APPLIED receipt; the answer is visible on instance A's task.
Tap the same button a second time: the first receipt is returned, and no second
answer is written.

## Case 7 - grant resume and start the run

From account A, reply to the anchor with `/grant resume`.
From account B, reply with `/resume`.

Pass: the card names the owner's allowance, in the shape
`Uses Requester operator's <provider> allowance.`
Tapping it starts exactly one run **on instance A**, with the task's last
provider and model, under the owner's settings.
Instance B starts nothing.

## Case 8 - revoke beats an open card

With a fresh card visible to account B, have account A reply `/revoke resume`
and tap the revoke card, then have account B tap the older card.

Pass: the access message is edited in place again; the late tap is rejected with
the current reason; no run starts; the revoked grant keeps its history rather
than leaving a second active row.

## Case 9 - expiry is not renewed

Have account B trigger a fresh card, wait past the 10-minute action expiry, then
tap it.

Pass: the tap is rejected as expired, and no replacement card appears by itself.
Account B must send the command again to get a new card.

## Case 10 - cross-owner thread request (SKIPPED, see B15)

Skipped on 2026-09-19 by operator's decision, and kept here because it becomes live
again if cross-member task visibility is ever built.
The command needs the owner's numeric prompt id, which no teammate can obtain,
and the owner cannot run it against their own item.
The item that cases 8, 9 and 11 use was opened with the case 2 curl instead.

From account B, send `/discuss <requester-bot-username> <promptId>` for a different
owner-side task.

Pass: account A receives an owner-bound confirmation card before any task
content is shared, and only after account A confirms does the item thread and
its anchor appear in the group.

## Case 11 - close the thread

From account A, reply to the anchor with `/close`.

Pass: the thread closes, and account B's granted commands stop working on that
item.
`/close` from account B is refused, since close is owner-only.

## Case 12 - default-off regression

Turn Team off in instance A's Agents settings.

Pass: the Team panels disappear, the team API routes answer 403 `team_disabled`,
and personal task control in the private chat still works exactly as before.
Turn Team back on afterwards.

## Progress

Update this table at the end of each case, so the next session starts from fact
rather than from the transcript.

| Case | Result | Date | Note |
| --- | --- | --- | --- |
| 0a notifications and remote actions | PASS | 2026-09-19 | Both enabled in instance A settings. |
| 0b task waiting on a question | PASS | 2026-09-19 | Run twice. First WI_TC02 (cents versus decimal). Re-run for the second item as WI_TC03, prompt 4, UTC versus local timezone; card sent as outbox 78. |
| 1 roster on both sides | PASS | 2026-09-19 | Two people, two bots, after the supergroup reset. |
| 2 open item thread | PASS | 2026-09-19 | Anchor pinned and access message posted; opened by curl, see B2. |
| 3 read-only views | PASS | 2026-09-19 | All four answered once, by the owner bot only; teammate bot silent. |
| 4 ungranted command refused | PASS | 2026-09-19 | `/resume` and `/context` both refused, naming the capability. |
| 5 grant answer | PASS | 2026-09-19 | Access message edited in place (outbox 35 edits 14); wrong-actor tap rejected. |
| 6 teammate answers | PASS | 2026-09-19 | One card bound to account B, Save answer only; one APPLIED receipt, response 16; second tap replayed as `Already applied.` with no second answer. |
| 7 grant resume and start the run | PASS | 2026-09-19 | Card read `Uses Requester operator's claude allowance.`; one run `<redacted-run-id>` on instance A, claude, model null; instance B started nothing. The run completed the task, which auto-closed the item: see B13, B14. |
| 8 revoke beats an open card | PASS | 2026-09-20 | Run off the `Answer and resume` button on card outbox 148, since `/resume` is refused while no answer is saved. `resume` revoked 02:27:05Z; access message edited in place (outbox 151 edits 80) to `Requester operator: answer`. Late tap of `tc_Hk3mHo-sHcs70SyInPet8zD2` at 02:27:51Z REJECTED `grant_required`, `Ask Requester operator to grant resume on this item.`, `started` 0 and `run_id` null; prompt 4 stayed BLOCKED with no new run. One `resume` row keeping `granted_at` 02:07:12Z with `revoked_at` 02:27:05Z, no second active row. |
| 9 expiry is not renewed | PASS | 2026-09-20 | Card outbox 145 minted 02:13:03Z with both `save_human_response` and `answer_and_resume`; `Save answer` tapped at 02:24:16Z, REJECTED `action_expired`, `response_id` null, `started` 0, `run_id` null. Prompt 4 stayed BLOCKED with no HUMAN_RESPONSE remark and no hold row. No replacement card appeared in the 11 minutes of waiting: the only outbox row was 146, an anchor age edit (B11). Refusal posted as outbox 147 with no actions attached. |
| 10 cross-owner thread request | SKIPPED | 2026-09-19 | Not a real scenario: a teammate can never learn the owner's prompt id, and the owner cannot `/discuss` their own item. See B15. Item for cases 8, 9 and 11 opened by curl instead, the case 2 route. |
| 11 close the thread | PARTIAL, see B17 | 2026-09-20 | Two of three criteria hold. `/close` from account B refused as owner-only (outbox 153, no card); after account A closed at 02:30:34Z the grants ended and `/answer` from B was refused with `Ask Requester operator to grant answer on this item.` (outbox 157). But the thread did not close: `telegram_thread` 10 stayed `ACTIVE` with `status_message_id` 79, the anchor stayed pinned and churning, and `/task` from B still returned the whole item at 02:37Z. |
| 12 default-off regression | DEFERRED | 2026-09-20 | operator's decision: folded into the LT-4 re-run that F01 to F03 require, rather than run on its own. Baseline captured while Team was on: `/api/task-control/team` 200 with the roster, `/api/task-control/team/refresh` 405. With Team off both must answer 403 `team_disabled`, and the 405 becoming a 403 is the check that the gate sits in front of method routing ([workspaceApi.ts:63](../../server/src/workspaceApi.ts#L63)). |

### Re-run for V5, 2026-09-26

September's rows above are the first pass and are left exactly as they stand, because
audits 1 to 4 cite them.
This table is the **re-run** the F01 to F03 rows and section 8's "LT-4's re-run rows are
recorded" clause ask for.
It was run against the live rig described in [team-v6-handover.md](team-v6-handover.md)
section 2, with **live Telegram credentials**, authorised by operator on 2026-09-26.

V5's scope is cases 2, 3, 11 and 12.
Cases 4 to 9 are recorded here as out of that scope rather than left blank, so that no
later reader mistakes a blank for an untried case.

| Case | Result | Date | Note |
| --- | --- | --- | --- |
| 0a notifications and remote actions | PASS | 2026-09-26 | Both on via `PUT /api/settings`, persisted to `.agent-console/settings.json`. Precondition, not part of V5's scope. |
| 0b task waiting on a question | PASS | 2026-09-26 | Run `<redacted-run-id>` on `claude-sonnet-4-5`. Prompt 1 `WI_TC01` `BLOCKED`; card posted unprompted as outbox 3, `kind: personal_question`, both buttons, options parsed. |
| 1 roster on both sides | PASS | 2026-09-26 | Two people, two bots, on both instances. `refs/aw/team` moved to `4255c668…`, confirmed by `git ls-remote` against the pilot remote itself, so the GitHub round trip is real. |
| 2 open item thread | **PASS** | 2026-09-26 | `POST /api/task-control/team/items {"promptId":1}` on 4100 answered `201` with `{"item":{"itemId":"<redacted-item-id>"}}`. Anchor posted as outbox 8, Telegram message **85**, `kind: view`, `anchor=1`; access message as outbox 9, Telegram message **87**, `kind: team_item_access`, text exactly `Item access / Requester operator: owner / Requester operator: read only / #item_63460787e23fa7d635890376`. New `telegram_thread` 4, `subject_kind: item`, `ACTIVE`. `item_link` row with `role: requester`, `epoch: 1`, no grants. **The pin was verified against Telegram, not from the local `anchor` flag**: `getChat` reports `pinned_message.message_id = 85`, from `aiws_helper_bot`, carrying the item tag. |
| 3 read-only views | **PASS** | 2026-09-27 | Run by operator from account B, 01:15Z to 01:20Z. **All five sends were genuine replies to the anchor**, `replyToMessageId: 85` on every inbox row, not bare commands resolving to the only open item. `/task`, `/access`, `/status`, `/help<requester-bot-username>` and `/help` were each answered **exactly once** by `<requester-bot-username>`: outbox 21, 22, 23, 24, 25 as Telegram messages 89, 91, 93, 95, 97. **Instance B received all five group updates (<redacted-update-id-range>) and emitted nothing into the group.** That is the case's real assertion, and it holds against a bot that was listening rather than one that was absent. **No state change on either side**: zero receipts, zero grants, zero new actions, prompt 1 still `BLOCKED`, `item_link` not closed, thread 4 still `ACTIVE`. Two findings beyond the criterion, both good. **`/help` is capability-derived and proved so**: [teamItemViews.ts:192-202](../../server/src/teamItemViews.ts#L192-L202) answers for the asking member, read-only commands plus whatever their grants unlock plus the owner's own set if they are the owner, so a teammate holding no grants correctly sees exactly the four view commands. **This is positive evidence that B12's fix by F01 works**, and it retires the orchestrator's own warning that B12 might bite here. And the `@botname` mention form, `/help<requester-bot-username>`, is handled identically to the bare form. One thing to read correctly: instance B did send one message, at 01:15:17 in **its own private chat** with `<receiver-bot-username>`, answering a stray `/task` with the generic command list. **It disclosed nothing** - B holds zero prompts and zero item links - and it is B's personal control surface rather than the team thread, so it is outside this case, which is about the group. |
| 4 ungranted command refused | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 5 grant answer | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 6 teammate answers | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 7 grant resume and start the run | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 8 revoke beats an open card | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 9 expiry is not renewed | not re-run | 2026-09-26 | Outside V5's scope. September's row stands. |
| 10 cross-owner thread request | SKIPPED | 2026-09-26 | Still not a real scenario. See B15. |
| 11 close the thread | **PARTIAL, B17 reproduces. See M-15** | 2026-09-27 | Run by operator, 01:22Z to 01:24Z. **Two of three criteria hold.** `/close` from account B **refused as owner-only**, outbox 26 message 99, no card. `/close` from account A produced a confirmation card (outbox 27, message 101) and then `Done: Thread closed; grants ended.` (outbox 28, message 102), and **`item_link.closed_at` is set** to `01:23:09.401Z` with its `closed_command_id`, which is F02's fix working. The access message was **edited in place**, outbox 29 editing outbox 9, not reposted. **But the thread did not close, for the second time.** `/task` from account B **one minute later returned the entire item** - blocked-on text, both options, `State: blocked`, `History: first run` - with nothing saying the thread is closed. `telegram_thread` 4 is still `ACTIVE` and its `updated_at` was never touched, and message 85 is still pinned. **The cause is now known and it is not what September recorded**, which is why this is registered as **M-15** rather than left as a repeat: `closedAt` gates granted commands and **not** view commands, because `handleTeamItemMessage` falls through to the view renderer with no check. And `telegramItemThreadForMessage` filters on `state <> 'ANCHOR_GONE'` only, so **closing the thread row would not fix it**. The `ACTIVE` row is cosmetic here. The pinned anchor is **M-11**'s accepted trade under operator's waiver. **This re-run is weaker than September's on one criterion and says so**: no grants ever existed on this item, so `grants ended` was vacuous and the "account B's granted commands stop working" criterion was **not exercised**. September's run did exercise it, with real grants that ended. |
| 12 default-off regression | **PASS, all three halves** | 2026-09-27 | **API half**: Team on, `/api/task-control/team` `200` and `team/refresh` `405`; Team off, `team` `403 team_disabled`, `team/refresh` **`403`** and `team/items` `403`. The `405` becoming a `403` and then **back to `405`** when Team was restored is the assertion, in both directions: the gate sits in front of method routing. `team.enabled` also disappears from `.agent-console/settings.json` entirely rather than being stored as `false`. **Browser half**: Playwright against the live web on 3100. `Team status`, `Join team` and the create panel on `/agents`, and `Team thread` on the `WI_TC01` detail, all present with Team on, all gone with Team off **after a reload**, all restored when it goes back on. Defect **L-16** found and registered: without a reload none of them go. **Phone half, run by operator 01:32Z to 01:42Z with Team off, and it went further than the criterion asks.** Reads first: `/status` (outbox 31, message 35) and `/blocked` (outbox 32, message 38) answered normally in the private chat, and **both payloads were checked for leakage and contain no `awi1_`, no `#item_`, and no grant or access language**. Then the whole personal write-and-apply path: a reply of `Integer cents is fine` at 01:42:01 minted a **fresh card with live buttons** carrying the draft (outbox 33, message 40), and a **real `callback` update, <redacted-update-id>**, applied it at 01:42:29, giving the receipt `Done: Answer saved; task remains waiting.` (outbox 34, message 41) and a new card showing the saved answer (outbox 35, message 42). **The tap was genuine, not an auto-submit** - that was checked, because M-13's canned-answer defect is exactly this shape on the web surface, and this surface is clean. One state change, and it is **by design, not a defect**: prompt 1 moved `BLOCKED` to `TODO` with a `human_response_hold` row, because `respondToBlockedPrompt` is called with `hold: true` and `promptOptions` computes `ready: !humanResponseHeld && status === "TODO"`, so the answer is held rather than ready. `started: false`, `run_id: null`, and `agent_run` stayed at 1, so **no run started**. **Consequence for the rig**: prompt 1 is no longer `BLOCKED` and its question is answered and held, so the state cases 2, 3 and 11 ran against is consumed. All three were finished first. |

**Case 12 is complete and passes on all three halves.**
Its browser half passes the criterion as written, which says the panels disappear
and does not mention reloading.
The stale-until-reload behaviour is recorded as L-16 rather than folded into this row,
because the API gate does hold and the refusal a user sees names the real cause.

Findings so far are in [pilot-bug-log.md](pilot-bug-log.md), B1 to B19, which is **closed at B19**.
The V5 re-run's own finding, a trap in the state printer below, is **L-17** in [team-gap-register.md](team-gap-register.md).
B16 was merged into B11 on 2026-09-20 and is kept as a pointer.

## Resuming in a fresh session

Each case is self-contained once the state is known.
Print the state instead of re-deriving it:

```bash
# Always pass the path, for BOTH instances. See L-17: with no argument this reads the
# calling checkout's own database and prints a plausible, wholly fake team.
node scripts/team-pilot-state.mjs ~/ai-workstation-team-pilot/.agent-console/console.sqlite    # A
node scripts/team-pilot-state.mjs ~/ai-workstation-team-pilot-b/.agent-console/console.sqlite  # B
```

That gives the roster, both actors, the open item and its grants, every
unexpired action and the last group messages, which is everything a case needs.

State as of 2026-09-20 02:45Z, for reference:

- **Both instances are running**, restarted at 01:59:53Z after the box slept
  overnight. If nothing is listening on 4100 or 4200, start them before anything
  else
- team `<redacted-team-id>`, supergroup `<telegram-group-id>`
- owner `Requester operator` / `<requester-bot-username>` on ports 3100/4100; teammate `Requester operator` /
  `<receiver-bot-username>` on 3200/4200
- workspace 1 (`Team pilot workspace`), suite 1 (`Suite_TC1`)
- prompts: 2 `WI_TC01` DONE, 3 `WI_TC02` DONE, **4 `WI_TC03` still BLOCKED after
  cases 8, 9 and 11, with no answer ever saved and no new run**, 5 `WI_TC04` TODO
  and held as a spare
- prompt 4 asks UTC versus local timezone for run log timestamps; run
  `<redacted-run-id>` DONE, personal question card outbox 78, its buttons long
  expired
- prompt 5 is deliberately unrun, so a completed prompt 4 does not strand the
  session the way prompt 3 did (B7)
- items: `<redacted-item-id>` (prompt 3), DONE and closed, and
  **`<redacted-item-id>` (prompt 4), open**, anchor outbox 79 and
  access message outbox 80, opened by curl at 13:54Z on 2026-09-19
- the item was closed by `/close` at 02:30:34Z, which ended its grants but did
  not close it in any other sense (B17), so it is still `ACTIVE` with its anchor
  pinned at message 39 and still taking a periodic edit (B11)
- grants on it, all written 2026-09-20: `answer` 02:06:53Z revoked 02:30:34Z,
  `resume` 02:07:12Z revoked 02:27:05Z by case 8, and `context` granted 02:42:04Z
  **after the close and still active**, which is the B17 probe rather than
  anything a later case needs.
  Revoke it before treating this item as closed.
  The access message is outbox 80 / message 41, edited in place every time, which
  is why its buttons never appear at the bottom of the group (B14)
- the grant buttons that were on outbox 80 before that expired at 14:04:30Z and
  were tapped late at 14:31Z, which is where the two
  `Not applied: This action expired.` lines in the group came from
- instance A has notifications and remote actions on; instance B has both off
  and needs neither

Start instance A with `env -u ANTHROPIC_API_KEY npm run dev:team-pilot` (B4).

### Run sheet from here

Case 0b has been re-run and the item is already open on prompt 4, so the next
step is the re-grant and then case 8.
Case 10 is skipped (B15).
Everything below is a phone action unless it says otherwise.

The live thread is `<redacted-item-id>`, tagged
`#item_70e8584ed9e957f9fd198dd8` in the group, anchored by outbox 79 with the
access message at outbox 80.

**Re-grant before case 8.**
Grants are per item, and the ones from cases 5 and 7 died with the closed
thread, so the new item starts with none.
From account A, reply into the new thread with `/grant answer`, tap the card,
then `/grant resume` and tap that card.

Do not tap the grant buttons that are already sitting on the access message.
B14 puts them there on every access refresh, but they carry the ordinary
ten-minute expiry and are never renewed, so on an item that has been open longer
than that they are visible, tappable and dead.
Tapping one answers `Not applied: This action expired.`
Send `/grant <capability>` to mint a fresh card, and tap that one within ten
minutes.

**`/resume` needs a saved answer, so neither case 8 nor case 9 uses it.**
Corrected on 2026-09-20 after `/resume` from account B was refused with
`There is no saved answer to resume with.`
([taskControl.ts:283](../../server/src/taskControl.ts#L283),
[runtime.ts:1006](../../server/src/integrations/telegram/runtime.ts#L1006)).
The refusal is plain text with no actions attached, so no card is minted and
nothing can be tapped.
On the previous item an answer had already been saved in case 6; this item starts
with none, which is why the earlier run sheet's `/resume` step does not work
here.

Do not solve that by saving an answer first.
Saving one is safe for the trap, because `saveHumanResponse` holds the response
and returns `started: false`
([humanInput.ts:58-60](../../server/src/humanInput.ts#L58-L60)), but it moves the
prompt to `TODO` and clears the pending question
([workspaces.ts:2056](../../server/src/workspaces.ts#L2056),
[workspaces.ts:1144](../../server/src/workspaces.ts#L1144)), after which a fresh
`/answer` is refused with `409 prompt_not_blocked`
([workspaces.ts:2053](../../server/src/workspaces.ts#L2053)) and case 9 loses its
card.

Both cases therefore work off the two-button `/answer` card instead, which exists
only while prompt 4 is `BLOCKED`: case 9 lets it expire, case 8 revokes underneath
it.
Neither writes anything when it passes, so prompt 4 stays `BLOCKED` throughout and
the two cases can run in either order.
They were run 9 then 8 on 2026-09-20.

**Case 9 - expiry is not renewed.**
From account B, reply `/answer use UTC` to get a fresh card, then leave it for
more than 10 minutes and tap `Save answer`.
The tap must be rejected as expired, and no replacement card may appear by
itself.
This case writes nothing when it passes, so prompt 4 stays `BLOCKED` for case 8.

Two buttons to leave alone while the clock runs.
The card's own `Answer and resume` completes prompt 4 if it is tapped before it
expires, which is the trap.
The `Revoke answer` button that the access refresh leaves on the access message
(B14) kills the grant that mints the card.

**Case 8 - revoke beats an open card.**
Use the `Answer and resume` button rather than a `/resume` card, so that no
answer is ever saved and prompt 4 never leaves `BLOCKED`.
While the teammate holds both `answer` and `resume`, `/answer <text>` mints a
card with two buttons, `Save answer` and `Answer and resume`, and the second one
is resume-capable
([teamGrants.ts:15](../../server/src/teamGrants.ts#L15)).
That is what makes it a valid subject for this case, and it is also the trap:
tapping it while `resume` is granted completes prompt 4.

From account B, reply `/answer use UTC` for a fresh two-button card, and do not
tap it.
From account A, reply `/revoke resume` and tap the revoke card, then confirm in
the database that the grant is revoked before going on.
Only then have account B tap `Answer and resume` on the older card.
It must be rejected with `grant_required` naming `resume`
([taskControl.ts:277](../../server/src/taskControl.ts#L277)), and no run may
start.

The window between that card appearing and the revoke landing is the one place in
cases 8 to 12 where a tap would complete prompt 4, so keep it short and tap
nothing inside it.

**Case 11 - close the thread.**
From account A, reply `/close` into the thread.
Check that `/close` from account B is refused first, since close is owner-only.

**Case 12 - default-off regression.**
Deferred on 2026-09-20 into the LT-4 re-run; see the progress table for the
Team-on baseline already captured.
Turn Team off in instance A's Agents settings, check the panels disappear, the
team API answers 403 `team_disabled`, and personal task control still works.
Verify the personal side with a read-only command such as `/status`, not by
tapping prompt 4's personal question card, whose `answer_and_resume` button
completes the task.
Turn Team back on afterwards.

**The trap.**
Do not let a resume succeed on prompt 4 while cases 8, 9 and 11 are outstanding.
A successful resume completes the task, and completion closes the item and
revokes every grant, which is exactly what ended the previous session.
Cases 8 and 9 are safe on that point, because both end in a rejected tap.
There are two `answer_and_resume` buttons in play, and either one completes
prompt 4.

The first is in the group, and it was missed when this section was first written.
Once the teammate holds both `answer` and `resume`, every `/answer <text>` card
carries `Answer and resume` beside `Save answer`
([teamGrants.ts:15](../../server/src/teamGrants.ts#L15)), so the teammate can
complete the owner's task with one tap for the ten minutes that card is live.
Observed 2026-09-20 at 02:13:03Z: outbox 145 carried
`tc_rakrz1pgNcrkKmwbx11H4U8E` (`save_human_response`) and
`tc_9UCKC8kxTz9nBO9R_b9yqKre` (`answer_and_resume`) together.
Cases 8 and 9 both put that card on screen deliberately, so the rule while either
is running is to tap only what the case says and only when it says to.

The second is the personal question card in account A's private chat, which
carries its own `answer_and_resume` and completes prompt 4 from the owner side.
Leave that card alone and let its buttons expire.
If prompt 4 is completed by accident, do not try to reuse it: start prompt 5
instead, take it to a question the same way, and re-run case 10 on prompt 5.

Starting a run outside the UI, if prompt 5 is ever needed, is a websocket
message rather than a REST call:

```bash
# from the repo root, against instance A
node -e '
const ws = new WebSocket("ws://127.0.0.1:4100/ws");
ws.addEventListener("open", () => ws.send(JSON.stringify(
  { kind: "run", workspaceId: 1, promptId: 5, provider: "claude", model: null })));
setTimeout(() => process.exit(0), 8000);
'
```

## Recording the result

LT-4 is a required real-phone check.
Because one person holds both accounts, record the outcome as a solo functional
check, and do not mark `H-TM-LT4` PASS until the real two-person run happens.

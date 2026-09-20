# Team pilot bug log

Defects found while running the solo two-account Team checks on 2026-09-19 and
2026-09-20.
See [solo-team-join-check.md](solo-team-join-check.md) and
[solo-team-thread-grant-check.md](solo-team-thread-grant-check.md) for the
checks that exposed them.
None of these is fixed yet.

## B1 - a created team's join code cannot be recovered

Severity: high, because it strands a created team with no way to invite anyone.

`confirmTeamCreate` returns the join code once
([runtime.ts:242-261](../../server/src/integrations/telegram/runtime.ts#L242-L261))
and nothing persists it; it lives only in the panel's React state
([TeamCreatePanel.tsx:12](../../web/components/agents/TeamCreatePanel.tsx#L12)).
A page reload loses it, `teamCreateStatus()` returns null once the pending
create is cleared, and creating again fails with `roster_conflict` because
`publishRoster` is called with `expectedRevision: null` against an existing
`refs/aw/team`.

Repro: create a team, confirm it, reload the Agents page.

Suggested fix: an "Issue new join code" action on the Team status panel for an
existing roster, minting a fresh `inviteId` the same way creation does.

## B2 - no UI to open a Team item thread

Severity: high; the owner has no supported way to start a thread on their own
item, which is the feature's primary flow.

`POST /api/task-control/team/items` exists
([workspaceApi.ts:126-129](../../server/src/workspaceApi.ts#L126-L129)) but no
web code calls it, and `workspacesApi.ts` has no client method for it.
There is no Telegram path either: `/discuss` is deliberately teammate-to-owner
only, and returns without acting when the requester and the owner are the same
member
([runtime.ts:handleTeamThreadRequest](../../server/src/integrations/telegram/runtime.ts#L723)).
So the owner's only route is curl.

This contradicts R-B in [teammate-design.md](teammate-design.md#L63), which says
either person may open the thread on either person's item.
The only thread that can be opened without curl is one the teammate requests
with `/discuss @<owner bot> <promptId>` and the owner then confirms, which also
requires the teammate to already know the owner's numeric prompt id.

The gap looks structural rather than deliberate: the engineering plan gives TM1
"team status in the panel" and gives TM2 the Telegram-side anchor, routing and
read-only views, and no slice ever assigns an owner-side control in the web UI.

Suggested fix: an "Open Team thread" action on the work-item detail for a task
that is awaiting a response, once a roster exists.

## B3 - `npm run dev` in a pilot checkout serves the wrong port silently

Severity: medium, because the symptom names neither the port nor the cause.

`dev:web` resolves the port with the shell expansion `${WEB_PORT:-3000}`, and
npm does not load `.env`, so a plain `npm run dev` serves on 3000 while the
backend reads `.env` and allows only the configured origin.
The only evidence is `rejected websocket upgrade from origin http://localhost:3000`
([index.ts:233-238](../../server/src/index.ts#L233-L238)), and REST calls fail
silently in the browser because `applyCors` omits the header for an unlisted
origin ([index.ts:31-39](../../server/src/index.ts#L31-L39)).

Suggested fix: read `WEB_PORT` from `.env` in the web dev script, or log the
allowed origins and the expected web port at server startup.

## B4 - the pilot inherits provider credentials from the launching shell

Severity: medium; it defeats the isolation the pilot setup otherwise enforces.

`setup:team-pilot` isolates ports, database and bot token, and the README says
not to copy another workstation's provider credentials.
But `claude.apiKey` defaults from the `ANTHROPIC_API_KEY` environment variable
([settings.ts:156-163](../../server/src/settings.ts#L156-L163)), so a key
exported by the launching shell becomes the app-level setting and is passed
explicitly to the SDK
([claude.ts:192-193](../../server/src/adapters/claude.ts#L192-L193)),
overriding a working Claude Code login.
The adapter already strips an inherited key when no app-level key is set
([claude.ts:194-198](../../server/src/adapters/claude.ts#L194-L198)); the
problem is that the environment variable does not arrive as inherited, it
arrives as the setting's default.
Observed as `billing_error` from a console key with no credit, while the same
machine's Claude Code login worked.

Workaround: start the pilot with `env -u ANTHROPIC_API_KEY`.

Suggested fix: add the provider credential variables to the list
`run-team-pilot.mjs` already scrubs from the child environment
([run-team-pilot.mjs:73-93](../../scripts/run-team-pilot.mjs#L73-L93)), or show
in settings that a key came from the environment rather than from this pilot.

## B5 - the Team roster stores a person's Telegram name as the workstation label

Severity: low, but it makes every Team card disagree with every personal card.

`confirmTeamCreate` and `confirmTeamJoin` both set
`workstationLabel: actor.label`
([runtime.ts:253](../../server/src/integrations/telegram/runtime.ts#L253),
[runtime.ts:415](../../server/src/integrations/telegram/runtime.ts#L415)),
where `actor.label` is the paired Telegram user's display name, not
`TASK_CONTROL_WORKSTATION_LABEL`.
Team views then render that value as the workstation, including the literal
line `Owner workstation: <value>`
([teamItemViews.ts:81](../../server/src/teamItemViews.ts#L81)).

Observed: the personal question card said `Junaid pilot` while the roster for
the same workstation held `Jj`, the Telegram display name of the paired
account.
Reproduced on the live group 2026-09-19: the item anchor's breadcrumb reads
`· Jj ·` and its footer reads `Owner: Jj`, and `/status` prints
`Owner workstation: Jj`, for the same machine whose personal card says
`Junaid pilot`.

Suggested fix: carry both, and render the configured workstation label where a
workstation is named and the person's name where a person is named.

## B6 - an expired personal question card is never replaced

Severity: medium; a task can sit awaiting a response with no usable card.

`notifyWaitingTasks` skips any prompt that already has an action for the current
question revision
([runtime.ts:686-697](../../server/src/integrations/telegram/runtime.ts#L686-L697)),
and the check ignores `expires_at`
([workspaces.ts:1598-1601](../../server/src/workspaces.ts#L1598-L1601)).
Actions expire after 10 minutes, so once the first card's buttons expire, no
further card is posted for that revision, even though the task is still
awaiting a response.

Observed: prompt 1 was awaiting a response for more than an hour with one sent
card whose actions expired at 09:07 and no replacement.

The recovery path exists but is undiscoverable: replying to the card with answer
text mints a fresh card
([runtime.ts:704-714](../../server/src/integrations/telegram/runtime.ts#L704-L714)).

Suggested fix: either exclude expired actions from the dedupe so the poller
re-posts, or say on the card that replying with an answer produces fresh
buttons.

## B7 - opening a Team item on a completed task silently does nothing

Severity: medium; the call reports success and leaves unusable rows behind.

`openTeamItem` validates the prompt, creates the item link and calls
`syncTeamItem`
([runtime.ts:298-307](../../server/src/integrations/telegram/runtime.ts#L298-L307)),
which deliberately skips the anchor when the prompt is `DONE` or `SKIPPED`
([runtime.ts:925-928](../../server/src/integrations/telegram/runtime.ts#L925-L928)).
Nothing reports that skip: the API answers `201` with an item id, and the caller
is left with an `item_link` row and a `telegram_thread` row whose
`status_message_id` stays null, with no message in the group.

Observed: prompt 2 was answered and resumed from the phone at 10:29 and
completed at 10:30; the item opened at 10:36 returned
`{"item":{"itemId":"awi1_84e1..."}}` and posted nothing.

Suggested fix: refuse with a specific error when the prompt is already
complete, rather than creating a link and returning success.
The rows are otherwise harmless - the poller posts the anchor if that prompt
becomes active again - but the caller has no way to know the thread was not
created.

## B8 - a supergroup upgrade permanently wedges the team

Severity: high; the team becomes unusable and cannot be repaired from the app.

Telegram upgrades a basic group to a supergroup on ordinary actions such as
granting administrator rights, and the chat id changes when it does.
The Bot API then rejects every send to the old id with
`400 Bad Request: group chat was upgraded to a supergroup chat`, returning the
new id as `parameters.migrate_to_chat_id`.

Nothing in the codebase reads `migrate_to_chat_id`, and nothing handles the
`migrate_from_chat_id` service message; the only mentions of supergroups are
inbound chat-type checks
([runtime.ts:1137](../../server/src/integrations/telegram/runtime.ts#L1137),
[runtime.ts:1153](../../server/src/integrations/telegram/runtime.ts#L1153)).
The roster's `groupChatId` is fixed at creation and there is no path to change
it, so every group message fails forever.

Observed 2026-09-19: the pilot group was upgraded, and every anchor and access
message failed with that 400 while the roster still held the pre-upgrade id.

Recovering by hand means rewriting the id in `team_roster.group_chat_id` and the
cached `record_json`, in the two `task_control_actor` rows whose `topic_id` is
the team sentinel, in `telegram_thread.chat_id`, and in `refs/aw/team` on the
shared repository, on both workstations.

Suggested fix: treat the 400 as a migration signal, rewrite the chat id in the
roster and local rows, republish the roster, and retry the send.
At minimum, surface the condition instead of failing silently forever.

## B9 - a failing anchor is re-enqueued on every poll pass, without bound

Severity: high; it is an unbounded write loop against a failing send.

`syncTeamItem` enqueues the anchor whenever the thread has no
`status_message_id` ([runtime.ts:926-928](../../server/src/integrations/telegram/runtime.ts#L926-L928)),
and `syncTeamItemAnchors` runs that for every item link on every pass of the
deliver loop ([runtime.ts:912-919](../../server/src/integrations/telegram/runtime.ts#L912-L919)).
When the send fails permanently, the message id is never set, so each pass
enqueues another row that fails the same way.
The per-row logic correctly declines to retry, which hides the fact that the
producer never stops.

Observed during B8: outbox rows 11 to 36 were created in about 64 seconds, one
roughly every 2.5 seconds, all `FAILED` against the same chat, with no upper
bound and no back-off.

Suggested fix: back off per thread after a failed anchor, and stop re-enqueuing
while an undelivered anchor for that thread already exists.

## B10 - the pilot launcher's signal handlers do not stop the pilot

Severity: low for interactive use, moderate for anything scripted.

`run-team-pilot.mjs` spawns `npm run dev` and installs handlers that forward
`SIGINT` and `SIGTERM` to that child
([run-team-pilot.mjs:97](../../scripts/run-team-pilot.mjs#L97),
[run-team-pilot.mjs:117-119](../../scripts/run-team-pilot.mjs#L117-L119)).
The signal reaches `npm`, which does not pass it to its own child, so the
`concurrently` supervisor and both dev servers keep running and the launcher's
`exit` handler never fires
([run-team-pilot.mjs:121-124](../../scripts/run-team-pilot.mjs#L121-L124)).

Observed 2026-09-19: `kill -INT` on the launcher left all four listeners
(3100, 3200, 4100, 4200) up after six seconds; the instances stopped only after
a `SIGTERM` sent directly to the `concurrently` processes.

Ctrl+C in an attached terminal still works, because the terminal signals the
whole foreground process group rather than the launcher alone.
So this only bites non-interactive stops: scripts, supervisors, CI, or an agent
stopping the pilot on the operator's behalf - which is exactly when a wedged
instance is hardest to notice.

Suggested fix: spawn the child with `detached: true` and signal its process
group, or spawn the supervisor directly instead of going through `npm`.

## B11 - an open item's anchor is rewritten on a timer, forever

Severity: medium; it burns a Telegram edit per open item on a timer for no
informational gain, and it is unbounded in time.

Merged 2026-09-20: this was recorded twice, as B11 from the first item and B16
from the second, before anyone noticed the two described the same defect.
Both observations are kept below because they cover different phases of it.

`syncTeamItemAnchors` runs on every delivery tick, which is every second
([runtime.ts:165](../../server/src/integrations/telegram/runtime.ts#L165),
[runtime.ts:645](../../server/src/integrations/telegram/runtime.ts#L645)), and
`syncTeamItem` enqueues an edit whenever the desired payload differs from the
delivered one by `JSON.stringify` equality
([runtime.ts:929-932](../../server/src/integrations/telegram/runtime.ts#L929-L932)).

The payload embeds a relative age: `blockedAt` is a timestamp that "the card
turns into an age at delivery"
([telegramSummary.ts:65-66](../../server/src/telegramSummary.ts#L65-L66)), which
`formatCard` renders as "blocked 29 min ago".
That string changes on its own, so the comparison never settles and an edit is
queued whether or not anything about the task changed, with no change a reader
would notice beyond the age counter.
How often depends on the item's age, because `ageText` coarsens the counter
([card.ts:80-90](../../server/src/integrations/telegram/card.ts#L80-L90)): once a
minute below 90 minutes, once an hour below 48 hours, then once a day.

Observed 2026-09-19 on the first item: outbox rows 15, 16, 17, 18, 19, 21, 23,
27, 29, 30, 32, 36, 37 and 40, each an `edit` targeting outbox 13, one per minute
at a fixed offset, while nothing about the task changed.

Observed 2026-09-19 on item `awi1_70e8584ed9e957f9fd198dd8`: outbox rows 81
through 118 are 38 consecutive edits to the anchor, outbox 79, one per minute
from 13:54:52 to 14:31:52, each differing only in `blocked N min ago` counting
40 up to 77.
Nothing else changed in that window; no command was sent and no grant existed.

Confirmed across the overnight stop on that same item: rows 125 to 132 are
per-minute edits reading `blocked 82 min ago` up to `blocked 89 min ago`, row 133
crosses to `blocked 1 hours ago`, and rows 134 to 137 are then hourly at 15:14Z,
16:14Z, 17:17Z and 01:59Z.
So the churn decays rather than stopping, and the per-minute phase is only the
first 90 minutes of an item's life.

That is about 89 `editMessageText` calls in an item's first 90 minutes, then
roughly 24 a day for as long as it stays open, and the cost scales with open
items rather than with activity, against a group that Telegram rate limits.
Every edit also re-marks the message as edited in every member's client and keeps
the pinned anchor churning there.
An item closed by `/close` keeps doing this forever, because that path never
retires the anchor (B17).

Suggested fix: exclude the rendered age from the equality check, or compare a
payload with the age field normalized, so an edit is queued only when the task
state actually changes. Refreshing the age on real changes, and otherwise on a
much coarser schedule, would keep the display useful without the churn.

## B12 - `/help` does not reflect granted capabilities

Severity: low, but it leaves the granted commands undiscoverable.

The TM3 scenario table requires that "`/access` and `/help` show only current
capabilities" ([tm3.md](../e2e-scenarios/tm3.md), TM-T1-4).
`/access` does this correctly.
`/help` does not: its arm of `renderTeamItemView` returns a fixed four-line list
of the read-only commands with no branch on grants
([teamItemViews.ts](../../server/src/teamItemViews.ts)), so it prints the same
text before and after a grant and never mentions `/answer`, `/resume`,
`/context`, `/close`, `/grant` or `/revoke`.

A teammate therefore has no in-Telegram way to learn which commands a grant has
just unlocked; the refusal message names a capability, not the command that
uses it.

Confirmed from source; the live re-check of `/help` after the `answer` grant was
not run before this session ended.

Suggested fix: render the granted commands for the asking member, and keep the
read-only four for a member with no capabilities.

## B13 - a completed item's final anchor contradicts itself and is never corrected

Severity: medium; the contradictory card is the permanent record of the item in
the group, and nothing ever edits it again.

`renderTeamItemAnchor` marks completion only in the hint line, by swapping
`State: <state>` for `Completed`
([teamItemViews.ts:64-70](../../server/src/teamItemViews.ts#L64-L70)).
The rest of the card comes from `formatCard(summary, ...)`, which still renders
the blocker section, the "If you wait" line and the run history, none of which
branch on completion.

`finishCompletedTeamItems` then retires the anchor as soon as the delivered
payload equals the payload computed from the completed state
([runtime.ts:947-949](../../server/src/integrations/telegram/runtime.ts#L947-L949)),
and once the thread is `ANCHOR_GONE` `syncTeamItem` returns without editing a
completed item
([runtime.ts:926-928](../../server/src/integrations/telegram/runtime.ts#L926-L928)).
So whatever the last edit happened to say is frozen in the group forever.

Observed 2026-09-19 after case 7, outbox 69, the message still pinned-then-
unpinned in the group:

```
State line:  Completed · Owner: Jj
Body:        Blocked on: ... Required human action: Choose whether amounts ...
             If you wait: This task and its pipeline stay paused; other
             workspaces continue.
History:     - 22:58 claude (running)
```

The run is shown as `(running)` because the anchor was rendered at 12:58:53,
while the prompt was already `DONE` but the `agent_run` row had no `ended_at`
yet; it was set at 12:58:57.
The comparison at 12:58:56 matched that same stale payload, so the anchor was
retired in exactly that state.

A reader is left with a card that says the task is complete, tells them it is
blocked on a decision, tells them nothing will move until they choose, and shows
the run still going.

Suggested fix: render the completed anchor from the completed state, dropping
the blocker and "If you wait" sections and showing the run as finished, and
retire the anchor only once the run has actually ended.

## B14 - closing an item arms fresh grant buttons on the closed item

Severity: low when the item closed because its task completed, high when it was
closed by `/close` on a task that is still blocked.
The "revoked again on the next pass" reasoning below holds only in the first
case; see B17 for the second, where nothing ever revokes the restored grant.

When a task completes, `finishCompletedTeamItems` revokes every grant and
refreshes the access message
([runtime.ts:941-944](../../server/src/integrations/telegram/runtime.ts#L941-L944)).
That refresh goes through the ordinary access renderer, which unconditionally
attaches one `grant` action per capability
([runtime.ts:886](../../server/src/integrations/telegram/runtime.ts#L886)), and
`liveFormat` turns each into an inline button
([liveFormat.ts:100-108](../../server/src/integrations/telegram/liveFormat.ts#L100-L108)).

So the last thing the closing refresh does is publish `Grant context`,
`Grant answer` and `Grant resume` buttons on an item that has just been closed,
live for the usual ten minutes.

Observed 2026-09-19 at 12:58:56, on the item closed by case 7: outbox 70 reads
`Junaid: read only` and carries actions `tc_UVYD55NWgT5`, `tc_raGajku4gLU` and
`tc_XZwn6gIsFL_`, all `grant`, all unexpired until 13:08:56, against prompt 3
which is `DONE` and a thread which is `ANCHOR_GONE`.

Tapping one writes a grant on a completed item; the next pass of
`finishCompletedTeamItems` revokes it and refreshes the access message again, so
the owner sees `Done: Granted resume.` followed by the access line reverting to
`read only`.
It does not loop, because the pass only refreshes when it actually revoked
something.

The buttons are delivered, but they are hard to reach, which caps how often this
is hit in practice.
The access message is edited in place, which case 5 requires, so every refresh
rewrites the original message rather than posting a new one, and `editMessageText`
does forward the keyboard
([httpBotApi.ts:162](../../server/src/integrations/telegram/httpBotApi.ts#L162)).
The consequence is positional: the buttons appear on a message sitting wherever
the access message was first posted, not at the bottom of the group.
Observed 2026-09-20: all four refreshes of that item's access message, outbox 140,
143, 151 and 156, edited message 41, which was first sent at 13:54:30Z the day
before, so the fresh buttons never showed up in the current conversation and jd
could not find them while looking for them.
They are reachable by scrolling back, which is how the two expired taps at 14:31Z
on 2026-09-19 happened, so this is friction rather than protection.

Suggested fix: refresh the access message with no actions when the refresh is
the one that closes the item.

## B15 - R-B is unreachable in both directions, so `/discuss` has no usable entry point

Severity: scope note rather than a defect. Recorded because R-B is an accepted
requirement that nothing currently satisfies, not because the teammate flow is
worth building as it stands.

R-B says either person may open a Telegram thread about a work item, on either
person's item
([teammate-design.md, R-B](teammate-design.md)).
Neither direction is usable by a human today.

The owner direction has no UI, which is B2: `POST /api/task-control/team/items`
exists but no web code calls it, and the owner cannot use `/discuss` on their
own item because `handleTeamThreadRequest` returns without acting when the
requester and the owner are the same member
([runtime.ts:1052](../../server/src/integrations/telegram/runtime.ts#L1052)).
Curl is the owner's only route.

The teammate direction is worse, and is the part B2 undersells. `/discuss`
requires a numeric prompt id
([teamThreadRequests.ts:28](../../server/src/teamThreadRequests.ts#L28)), and
nothing in the product ever shows one to a teammate:

- the roster carries members, group chat, remote url and invite ids, and no task
  data at all ([teamRoster.ts:20-29](../../server/src/teamRoster.ts#L20-L29))
- the Team status panel renders the team id and members, and no task list
  ([TeamStatusPanel.tsx](../../web/components/agents/TeamStatusPanel.tsx))
- the group has no discovery command: every group message routes straight into
  the thread-request and item handlers
  ([runtime.ts:1162](../../server/src/integrations/telegram/runtime.ts#L1162)),
  so the workstation status view that lists waiting tasks is reachable only from
  the owner's private chat
- the shared item control record is per item and only exists once a thread is
  open, so it is downstream of the problem

So the only way a teammate can name a prompt id is for the owner to read it out
of their own database and say it aloud, at which point the owner would rather
open the thread themselves, which is B2.

jd's decision on 2026-09-19: the teammate-initiated scenario is not real, so the
discovery gap is not worth closing. Case 10 was skipped on that basis. The
cleaner resolution is to amend R-B down to owner-initiated threads so the
written requirement matches what is built, rather than leaving an accepted
requirement silently unmet. If cross-member task visibility is ever built,
`/discuss` becomes reachable and case 10 becomes worth running again.

## B16 - merged into B11

The second recording of the anchor edit churn, kept as a pointer because the
number was already cited elsewhere. See B11.

## B17 - `/close` ends the grants but does not close the thread

Severity: high; the command reports `Thread closed; grants ended.` while the
thread stays open, keeps churning, and can have its access restored permanently
by a button the close itself published.

`close_thread` does exactly two things
([taskControl.ts:258-261](../../server/src/taskControl.ts#L258-L261)): it calls
`revokeItemGrants` and records a receipt reading `Thread closed; grants ended.`
Nothing marks the thread closed, retires the anchor, or unpins it, and the card
that mints the action promises both halves: `Close this item thread and end every
active grant.`
There is no stored notion of a closed item to mark: `item_link` carries only
`item_id`, `prompt_id`, `role`, `epoch` and `control_head`.

The product does have a graceful retire, and `/close` does not use it.
`markTelegramThreadAnchorGone` is reached from `finishCompletedTeamItems`, which
also unpins the anchor
([runtime.ts:947-956](../../server/src/integrations/telegram/runtime.ts#L947-L956)),
and otherwise only from the adapter's permanent-failure paths
([adapter.ts:128](../../server/src/integrations/telegram/adapter.ts#L128),
[adapter.ts:139](../../server/src/integrations/telegram/adapter.ts#L139),
[adapter.ts:158](../../server/src/integrations/telegram/adapter.ts#L158)).
Both of those require the prompt to be `DONE` or `SKIPPED`
([runtime.ts:942](../../server/src/integrations/telegram/runtime.ts#L942)), so a
thread closed on a still-blocked task is never retired.

Observed 2026-09-20 on item `awi1_70e8584ed9e957f9fd198dd8`, prompt 4 `BLOCKED`,
closed by account A at 02:30:34Z:

- the receipt said `Thread closed; grants ended.` and both grants were revoked,
  `answer` at 02:30:34.423Z and `resume` already at 02:27:05.085Z
- `telegram_thread` row 10 for that item stayed `state ACTIVE` with
  `status_message_id 79`, against row 8 for the item that completion closed,
  which is `ANCHOR_GONE`
- the anchor stayed pinned and kept taking its periodic edit (B11)
- `/task` from account B at 02:37Z, after the close, still answered in full with
  the blocker text, the required human action, both options with their pros and
  cons, and `State: awaiting response · Owner: Jj`

That last point is the user-visible shape of the defect: the owner ends the
teammate's granted access, the bot confirms `Thread closed`, and the teammate can
still pull the whole work item out of the group afterwards.
Read-only views were never grant-gated, which case 3 established deliberately, so
the defect is not that `/task` ignores grants; it is that closing a thread is
advertised and receipted as an end state that nothing in the system represents.

The third consequence is the one that matters, and it also corrects B14's
severity. That entry called the grant buttons harmless because "the next pass of
`finishCompletedTeamItems` revokes it", which is true only while the prompt is
complete. `revokeItemGrants` has exactly two production callers, this close path
and that completion sweeper
([taskControl.ts:259](../../server/src/taskControl.ts#L259),
[runtime.ts:943](../../server/src/integrations/telegram/runtime.ts#L943)), and the
sweeper skips every prompt that is not `DONE` or `SKIPPED`.

So on a thread closed while its task is still blocked, the closing access refresh
publishes `Grant context`, `Grant answer` and `Grant resume`
(observed as outbox 156, refs `tc_Yx9pV7N-h-abyb9-BVVgBQXN`,
`tc_7yoQSKZDp8Yo25HRIrXfNafl` and `tc_lCDqXtTeHbUPWTXitzIcI8WP`, live until
02:40:34Z), and a tap on any of them restores that capability with nothing left in
the system that will ever revoke it.

Confirmed end to end on 2026-09-20, on the item closed at 02:30:34Z, using the
ordinary command rather than those buttons:

- `/grant context` from account A was accepted on the closed thread, minting card
  outbox 159 rather than any refusal
- the tap applied at 02:42:04.363Z, receipted `Done: Granted context.`, and the
  access message was edited to `Junaid: context` (outbox 161)
- the grant was still active after 63 checks over the following three minutes,
  during which the one-second delivery loop had about 180 opportunities to sweep
  it
- `/context` from account B then returned the item's objective and open question
  in full

So a closed thread accepts new grants, keeps them, and serves granted commands
from them. `/close` gates nothing on the write path either.

Suggested fix: give a closed item a persisted closed state, refuse granted
commands and further grants against it, retire and unpin its anchor the way
completion does, and refresh the access message with no actions on the pass that
closes it (which is also B14's fix).

## B18 - a teammate holding answer and resume is one tap from completing the owner's task

Severity: low as designed, but it is a sharp edge worth stating, and it is
undocumented outside the command surface table.

While the teammate holds both `answer` and `resume`, every `/answer <text>` mints
a card with two buttons rather than one: `Save answer`, which needs `answer`, and
`Answer and resume`, which needs both
([runtime.ts:999-1000](../../server/src/integrations/telegram/runtime.ts#L999-L1000),
[teamGrants.ts:15](../../server/src/teamGrants.ts#L15)).
The second one saves the answer and starts the run, so it completes the owner's
task, which closes the item and revokes every grant.

This is intended: it is what "Answer and resume needs both `answer` and `resume`"
means, and the capability model is working exactly as written.
It is recorded because the consequence is invisible at the point of use.
The two buttons sit side by side with similar labels, and the only thing that
distinguishes the card when the second one is present is the footer
`Uses <owner>'s <provider> allowance.`
([runtime.ts:1001](../../server/src/integrations/telegram/runtime.ts#L1001)),
which names whose credits are spent and not that the task completes, the item
closes and every grant ends.

Observed 2026-09-20 at 02:13:03Z: card outbox 145 carried
`tc_rakrz1pgNcrkKmwbx11H4U8E` (`save_human_response`) and
`tc_9UCKC8kxTz9nBO9R_b9yqKre` (`answer_and_resume`) together, ten minutes live,
on prompt 4, while cases 8, 9 and 11 all still needed that prompt to stay blocked.
An earlier session had already lost its item to exactly this completion, from the
owner's personal card.

Suggested fix: extend that footer, or the button label, to name the outcome as
well as the allowance, so the two buttons are distinguishable by consequence and
not only by wording.

## Unconfirmed

- The `Goal:` line on the personal card may truncate without the ellipsis that
  `lineText` appends ([telegramSummary.ts:111-113](../../server/src/telegramSummary.ts#L111-L113)).
  Not yet reproduced; the observed text may simply have been copied short.

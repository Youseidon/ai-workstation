# V5 phone script: cases 3, 11 and case 12's phone half

> **Archived one-off phone script.** Bot names, ports, paths and live-rig state
> below are historical evidence, not reusable setup instructions.

Written 2026-09-26 for operator, by the orchestrator.
These are the only V5 cases a bot token cannot run, because they need a second
human account typing in the group.
Everything else in V5 is done; see [team-v6-handover.md](team-v6-handover.md)
section 3.

Do the three parts **in the order below**.
Part B closes the item thread, so part A has to happen first.

## The rig, as it stands right now

| Thing | Value |
| --- | --- |
| Group | `<telegram-group-name>`, supergroup `<telegram-group-id>` |
| **The anchor to reply to** | Telegram message **85**, the pinned one, first line `#item_63460787e23fa7d635890376` |
| Access message | Telegram message **87**, `Item access / Requester operator: owner / Requester operator: read only` |
| Item | `<redacted-item-id>`, prompt 1, `WI_TC01`, `BLOCKED` |
| Grants on it | **none**, which is what these two cases want |
| Account A, owner | `Requester operator` / `<requester-username>` / `<requester-user-id>`, paired to `<requester-bot-username>` |
| Account B, teammate | `Requester operator` / `<receiver-user-id>`, paired to `<receiver-bot-username>` |

Both bots are administrators with **Pin messages**, checked through the Bot API
from both tokens, so that step is done and needs nothing from you.

**Do not tap the three grant buttons on message 87.** They were minted at
`13:59:36Z` and expired ten minutes later. A tap now is correctly refused as
`action_expired`, and that refusal is case 9's subject, not case 3's - it would
only muddy this run.

Reply on a phone by long-pressing message 85, choosing **Reply**, then typing.

## Part A - case 3, read-only views for the teammate

**As account B**, in the group, send these four **as replies to message 85**, one
at a time, waiting for each answer before sending the next:

```
/task
/status
/access
/help
```

What should happen, and what I will check afterwards:

- each command is answered **exactly once**
- every answer comes from **`<requester-bot-username>`**, the owner's bot
- **`<receiver-bot-username>` says nothing at all** - this is the real assertion of
  the case, and it is worth something because that bot is confirmed live: its
  process holds two open long-poll connections to `api.telegram.org` right now
- nothing is recorded as a receipt and no state changes

**Correction, made after part A ran.** This script first warned that `/help` might
not reflect granted capabilities, citing B12. That warning was wrong: **B12 was
fixed by F01**, and `/help` is capability-derived - it answers for the asking
member, read-only commands plus whatever their grants unlock. A teammate holding
no grants correctly sees exactly the four view commands, which is what happened.
Nothing to watch for here.

**Part A is done and PASSED**, 2026-09-27, 01:15Z to 01:20Z. Details are in the
re-run table in [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md).

## Part B - case 11, close the thread

**First, as account B**, reply to message 85 with:

```
/close
```

Expect a refusal naming close as owner-only, posted by `<requester-bot-username>`, with
no card attached.

**Then, as account A**, reply to message 85 with:

```
/close
```

Expect the thread to close and account B's commands on that item to stop.

**This is where to look hardest.** September recorded case 11 as PARTIAL under
**B17**: the grants ended and `/answer` from B was refused, but the thread did
not actually close - it stayed `ACTIVE`, the anchor stayed pinned and kept
churning, and `/task` from B still returned the whole item seven minutes later.
If that repeats, the case is PARTIAL again for the same reason and B17 is
confirmed a second time. So after A's `/close`, please **send `/task` from
account B once more**, as a reply to message 85, and tell me whether it answers
with the item or refuses.

## Part C - case 12's phone half, personal control with Team off

This one needs Team switched off, and I do not want to leave the rig that way,
so tell me when you are ready and I will switch it off and back on around you.
If you would rather do it yourself: instance A's web app at
**http://localhost:3100/agents**, the Team section, `team.enabled`.

**Correction, made before part C ran.** This script first said to check that the
existing question card's buttons still work. **They cannot**: both actions on card
message 33 expired at `2026-09-26T13:20:29Z`, ten minutes after it was posted, and
that is B6's accepted trade rather than a Team-off symptom. Tapping them would be
refused as `action_expired` whether Team were on or off, so it tests nothing here.

With Team **off**, in your **private** chat with `<requester-bot-username>`:

1. `/status` - should answer normally
2. `/blocked` - should still list `WI_TC01`
3. **Reply to the question card, message 33, with any answer text**, for example
   `Integer cents`. This is the live personal-control path: the handler calls
   `postQuestion` with your text, which mints a **fresh card with live buttons**
   carrying your draft. It does **not** save or resume anything by itself, so it is
   safe to do and changes no task state.

Then stop, and let the orchestrator diff the new card against the Team-on baseline
it captured from card 33 before the toggle. Do **not** tap the fresh card's buttons
unless you decide to: `Save answer` records an answer, and `Answer and resume`
starts a real agent run on a real provider.

The point of the case is that turning Team off takes away Team and **nothing
else**. The API half of this already passed and the browser half passed today;
this is the last third.

Be aware of **L-16**, found today: with Team off, any Team panel already open in
a browser tab stays on screen until the page is reloaded. That is a known
cosmetic defect, not something for you to chase here.

## When you are done

Tell me which parts you ran and what you saw.
I will read the two databases and both bots' message history, record the rows in
[solo-team-thread-grant-check.md](solo-team-thread-grant-check.md)'s re-run
table, and take the results into the completion report.

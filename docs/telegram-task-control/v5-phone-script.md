# V5 phone script: cases 3, 11 and case 12's phone half

Written 2026-09-26 for jd, by the orchestrator.
These are the only V5 cases a bot token cannot run, because they need a second
human account typing in the group.
Everything else in V5 is done; see [team-v6-handover.md](team-v6-handover.md)
section 3.

Do the three parts **in the order below**.
Part B closes the item thread, so part A has to happen first.

## The rig, as it stands right now

| Thing | Value |
| --- | --- |
| Group | `AI_WS`, supergroup `-1004359741812` |
| **The anchor to reply to** | Telegram message **85**, the pinned one, first line `#item_63460787e23fa7d635890376` |
| Access message | Telegram message **87**, `Item access / Jj: owner / Junaid: read only` |
| Item | `awi1_63460787e23fa7d635890376`, prompt 1, `WI_TC01`, `BLOCKED` |
| Grants on it | **none**, which is what these two cases want |
| Account A, owner | `Jj` / `jshay96` / `8973262519`, paired to `@aiws_helper_bot` |
| Account B, teammate | `Junaid` / `6525517234`, paired to `@ai_test_pilot_1_bot` |

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
- every answer comes from **`@aiws_helper_bot`**, the owner's bot
- **`@ai_test_pilot_1_bot` says nothing at all** - this is the real assertion of
  the case, and it is worth something because that bot is confirmed live: its
  process holds two open long-poll connections to `api.telegram.org` right now
- nothing is recorded as a receipt and no state changes

One known wrinkle, already logged, so do not treat it as a new failure: **B12**
says `/help` does not reflect granted capabilities. With no grants on this item
its list may read as though commands are available that are not.

## Part B - case 11, close the thread

**First, as account B**, reply to message 85 with:

```
/close
```

Expect a refusal naming close as owner-only, posted by `@aiws_helper_bot`, with
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

With Team **off**, in your **private** chat with `@aiws_helper_bot`, check that
personal task control is untouched:

- the question card for `WI_TC01` that is already in that chat still has both its
  buttons, and tapping one still works
- `/status` in the private chat still answers normally

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

# Case 11 re-run: the phone half, with real grants

Written 2026-09-27 for jd, by the orchestrator, as the closing item of the plan's Phase 2.
This is the **only** step in Phase 2 that a bot token cannot run: creating a grant needs a real user to type in the group and a real user to tap a card, and a bot token can do neither.

## Why the re-run exists

Case 11 has been **PARTIAL twice**, and the 2026-09-27 run was weaker than September's on one criterion and said so: **no grants ever existed on that item**, so "the grants ended" was vacuous and the criterion "account B's granted commands stop working" was never exercised.
So the re-run needs an item that carries **real grants** at the moment it is closed.

## What changed under it since the last run, and what that adds to the pass bar

Two of case 11's three criteria already held. The one that failed - "the thread closes" - has since been fixed, so this run has **more** to check than the last one, not less.

| Fixed | By | New thing to see |
| --- | --- | --- |
| **M-15** | P-B2 | Every read-only command on the closed thread **says it is closed**. `/status`, `/access` and `/help` carry the line `This item thread is closed.`; `/task` carries `Thread closed` in its footer |
| **M-15**, record half | P-B2 | `telegram_thread.state` for the item becomes **`CLOSED`**, where both previous runs left it `ACTIVE` |
| **M-11** | P-C1 | The anchor is **edited into a final closed card and unpinned**. Both previous runs left it pinned and churning |

## Before you start

The rig must be **running** and on current `main`. Check with:

```
ss -ltnp | grep -E ':(3100|4100|3200|4200)\s'          # four listeners
node scripts/team-pilot-state.mjs ~/ai-workstation-team-pilot/.agent-console/console.sqlite
```

Pass the database path explicitly. With no path the script reads `main`'s fixture and prints a **wholly fake team** - that is L-17.

**Do not use prompt 1 / item `awi1_63460787e23fa7d635890376` for this.** It is the fixture P-A3 and the handover work reference, it carries jd's own held answer `Integer cents is fine`, and closing it would spend it. This script creates a fresh item instead.

## Step 0 - a fresh blocked item, no phone needed

Run this from `~/ai-workstation-team-pilot`. It creates a work item, blocks it, and opens a Team thread for it.

```
# 1. a task to block on
curl -s -X POST http://127.0.0.1:4100/api/workspaces/1/programs \
  -H 'Origin: http://localhost:3100' -H 'Content-Type: application/json' \
  -d '{"name":"Case 11 re-run","overview":""}'
# take the program id from the reply, then
curl -s -X POST http://127.0.0.1:4100/api/programs/<PROGRAM_ID>/suites \
  -H 'Origin: http://localhost:3100' -H 'Content-Type: application/json' \
  -d '{"name":"Close with grants","overview":""}'
curl -s -X POST http://127.0.0.1:4100/api/suites/<SUITE_ID>/prompts \
  -H 'Origin: http://localhost:3100' -H 'Content-Type: application/json' \
  -d '{"title":"WI_C11","content":"Choose the retry ceiling: 3 or 5."}'
```

Then get that prompt to `BLOCKED`. The cheapest honest way is the web app on <http://localhost:3100/tasks>: run the item, let the agent stop on the decision. **A provider run costs budget**, so if you would rather not spend one, answer this instead and the orchestrator will find a cheaper route - there is no API that sets `BLOCKED` without a run, by design.

Once it reads `BLOCKED`, open the Team thread:

```
curl -s -X POST http://127.0.0.1:4100/api/task-control/team/items \
  -H 'Origin: http://localhost:3100' -H 'Content-Type: application/json' \
  -d '{"promptId":<PROMPT_ID>}'
```

The group gets a **pinned anchor** whose first line is `#item_<...>` and an **Item access** message. Note both message numbers; every step below replies to the anchor.

## Step 1 - real grants, which is the whole point

**As account A (`Jj`)**, reply to the anchor:

```
/grant answer
```

A card appears with a `Grant` button. **Tap it as account A.** The Item access message should be **edited in place** to read `Junaid: answer`, not reposted.

Then do the same for `resume`:

```
/grant resume
```

Tap `Grant`. Access should read `Junaid: answer, resume`.

**Do these within ten minutes of the card appearing.** A card minted and left expires, and a late tap is correctly refused as `action_expired` - that is case 9's subject and it would muddy this run.

**Check the grants are real before closing anything:**

```
node -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/junaid/ai-workstation-team-pilot/.agent-console/console.sqlite");
console.log(db.prepare("SELECT item_id,person_id,capability,granted_at,revoked_at FROM item_grant WHERE revoked_at IS NULL").all());'
```

Two rows with `revoked_at` null. **If this prints nothing, stop** - closing now would repeat the exact weakness this re-run exists to remove.

## Step 2 - account B's granted command works

**As account B (`Junaid`)**, reply to the anchor:

```
/answer Use three
```

A card bound to account B appears with `Save answer`. **Tap it as account B.** You should get an applied receipt. This is what proves the grant was live, so that step 4's refusal means something.

**Do not tap anything labelled `Answer and resume`.** A successful resume completes the task, and completion closes the item and revokes every grant by itself - which would end the run before `/close` is tested. Only `Save answer`.

## Step 3 - the close

**As account B first**, reply to the anchor:

```
/close
```

**Pass:** refused as owner-only, with no confirmation card.

**Then as account A**, reply to the anchor:

```
/close
```

A confirmation card appears. **Tap `Close thread` as account A.**

**Pass:** the reply says `Done: Thread closed; grants ended.`

## Step 4 - what is new, and what two runs have never seen

Within a minute or so of the close, check all five:

1. **The anchor is no longer pinned**, and its text now ends with `Thread closed`. It should be the **same message, edited** - not a new one. (M-11, new)
2. **As account B**, reply `/answer Use five` to the anchor. **Pass:** refused, naming the capability - `Ask Jj to grant answer on this item.` This is the criterion the last run could not exercise.
3. **As either account**, reply `/status` to the anchor. **Pass:** it still answers, **and** carries the line `This item thread is closed.` (M-15, new)
4. Repeat 3 for `/access`, `/help` and `/task`. All four answer. `/task` carries `Thread closed` in its footer; the other three carry the full sentence.
5. Read the rows back:

```
node -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/junaid/ai-workstation-team-pilot/.agent-console/console.sqlite");
console.log("link:",db.prepare("SELECT item_id,closed_at,closed_command_id FROM item_link WHERE closed_at IS NOT NULL").all());
console.log("thread:",db.prepare("SELECT subject_id,state,status_message_id FROM telegram_thread WHERE subject_kind=?").all("item"));
console.log("grants:",db.prepare("SELECT capability,granted_at,revoked_at FROM item_grant").all());'
```

**Pass:** `closed_at` set with its `closed_command_id`; the item's thread row reads **`CLOSED`**, not `ACTIVE`; both grants carry a `revoked_at`.

## What to send back

The five answers from step 4, plus the message numbers. The orchestrator writes the row into [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md) and converts case 11 from PARTIAL, or records exactly which criterion still fails and why.

**If any of the five fails, that is a finding, not a mistake in this script.** Send what you saw. Criteria 1, 3, 4 and the thread row are all first-time checks of code that landed today with harness proofs but no phone proof.

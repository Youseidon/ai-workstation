# Team and Telegram user guide

This is the user-facing guide for personal Telegram control and two-person Team
handover. The features are off by default. Each workstation keeps its own app
state, bot credential, provider login and working copy.

For protocol details, test evidence and historical implementation records, see
the [Telegram task-control documentation index](telegram-task-control/README.md).

## Before you start

Each person needs:

- their own workstation running AI Workstation with Node.js 22 or newer;
- at least one supported coding provider installed and authenticated;
- their own Telegram account and their own Telegram bot;
- Git credentials that can fetch and push the shared private repository; and
- a local clone of that shared repository registered as a workspace in the app.

The Team repository is the private repository that carries the team's shared
roster, handover records and work. It can also be the project repository, but it
is not the AI Workstation source repository unless that is deliberately the
project being worked on. Both people must have access to the same remote URL.

Use one bot and one local AI Workstation identity per workstation. Do not copy
another workstation's `.agent-console` directory, database, bot token or
provider credentials.

## Install and start the app

For a normal installation:

```bash
npm install
cp .env.example .env
npm run serve
```

Open <http://localhost:3000>. `npm run serve` is the normal non-watching mode.
The side-by-side pilot scripts use separate ports and disposable state; they are
an operator test rig, not part of ordinary Team setup.

## Connect your personal Telegram bot

1. Open **Agents → Set up Telegram**.
2. Follow the link to [BotFather](https://t.me/BotFather), send `/newbot`, and
   answer BotFather's two prompts.
3. Paste the token into **Bot token**, then choose **Save bot and continue**.
4. Choose **Create pairing link**. Open the bot from the link and tap **Start**,
   or send the displayed `/start <code>` command in a private chat with the bot.
5. Check the Telegram identity shown by the app. Choose **Confirm pairing** only
   when it is yours.
6. Choose **Enable personal controls** if the setup flow offers it. The flow
   enables **Enable task control**, the Telegram transport, **Notifications**
   and **Remote actions**.
7. Confirm that the **Live Telegram** card says **connected** and the setup flow
   says **ready**.

Pair in a private chat. A group cannot be paired as the workstation owner. A
wrong or expired pairing code is deliberately silent; create a new link.

### Token storage and security

The server validates the token directly with Telegram and stores it in an
owner-readable local credential file under `.agent-console`. It is not stored
in Git, the app database or the ordinary settings file, and it is not returned
by the API after submission. A process running as the same operating-system
user can still read local credentials, so the workstation account remains a
security boundary.

Treat the token like a password. Never paste it into chat, a task prompt, a
repository, a command line, or a shared `.env` file. Existing installations may
still read `TELEGRAM_BOT_TOKEN` at startup, but the Agents setup flow is the
supported path for normal users.

## Create a Team

Do this on the workstation that will create the roster:

1. Create a private Telegram group and add the other person.
2. Add both personal bots. Promote both bots to administrator and grant **Pin
   Messages** and **Invite Users**. Telegram group privacy mode does not prevent
   administrator bots from receiving group updates.
3. In **Agents → Task Control**, turn on **Enable Team** and save.
4. Under **Team**, enter the shared private Git repository URL and choose
   **Create team**.
5. Send the displayed `/team <code>` command in the private group.
6. When the app reports that the group was verified, choose **Confirm team**.
7. Send the resulting `awj1...` join code to the other person through a private
   channel. The code contains no bot or Git credential, is single-use and
   expires after 24 hours.

Choose **Issue new join code** if the first code expires or is lost. Issuing a
new code does not immediately invalidate an older unused code; an unused code
remains valid until it is used or expires.

## Join a Team

On the second workstation:

1. Complete the personal Telegram setup above with a different bot.
2. Clone the shared private repository locally, make sure its remote matches the
   URL in the join code, and register the clone as a workspace in the app.
3. Turn on **Enable Team** in **Agents → Task Control** and save.
4. Under **Join team**, paste the `awj1...` code and choose **Check code**.
5. Review the result and choose **Join team**.
6. Follow the instruction to add this workstation's bot to the private group as
   an administrator. The owner may also need to send the one-member Telegram
   invite shown by their **Team status** panel.
7. On both workstations, choose **Refresh team** and confirm that both people,
   workstation labels and bot usernames appear.

The join is refused when the repository cannot be reached, no local workspace
tracks the same remote, the code expired or was already used, or the remote
roster changed in a conflicting way.

## Repository readiness

The **Tasks → Team handovers** view shows **Ready · _workspace_** when this
workstation has a usable local workspace for the Team remote. **Setup required**
means Accept is unavailable; the row includes the reason. Decline can remain
available even when the repository is not ready.

Before accepting work, check that:

- the local clone has the expected private remote;
- your Git credentials can fetch and push it;
- the working directory exists and is not another workstation's shared folder;
- the requested provider is installed and authenticated locally; and
- your local permissions and sandbox settings are appropriate.

Telegram coordinates people and actions. The Git remote carries the roster,
handover control history, captured work and returned commits. Telegram does not
carry repository contents, and Git does not carry bot tokens, provider
credentials or private-chat history.

## Open a Team item thread

Select a task that **Needs you** and use **Open Team thread**. The app posts and
pins an item anchor in the Team group. Under **Team access**, the owner can grant
the teammate any combination of **context**, **answer** and **resume**.

- `context` permits read-only task context.
- `answer` permits saving an answer for that item.
- `resume` permits starting work after an answer; answering and resuming needs
  both `answer` and `resume`.

Use **Close thread** when discussion is finished. Closing revokes active grants
and retires the anchor. A thread cannot close while a handover is live; withdraw
the offer or finish the return/apply flow first.

Ordinary Team item command buttons expire after ten minutes and are not renewed
automatically. The teammate must issue the command again. Persistent handover
offers and Return-work reminders are different: while the shared decision is
still open, the workstation renews their existing local action references in
place without repeatedly posting new Telegram messages.

## Start and publish a handover

1. Turn on **Enable handover** on both workstations and save. **Enable Team**
   must also remain on.
2. Open the task detail and find **Hand over to the team**.
3. Choose the requested agent and select **Prepare handover**.
4. Review the preview. It lists the uncommitted files, total size, branch and
   ignored files that will not be included.
5. If a file resembles a credential, stop and remove or ignore it. Publishing a
   secret puts it in remote history. The UI permits an explicit risk
   confirmation, but that is not a safe default.
6. Choose **Publish offer**. The offer names no receiver; the first eligible
   teammate to accept through the shared record wins.

Preparation opens the item thread if necessary. Publishing pushes the captured
package before advertising the offer, so a receiver is not told to accept work
that the remote cannot supply.

## Receive and return work

Open **Tasks → Team handovers**. The view refreshes periodically and also offers
**Refresh**.

- **Accept** claims the offer, fetches the package, creates the receiver's local
  task/worktree and starts it under that workstation's own provider login,
  settings and quota.
- **Decline** records that person's decision for the current offer. It does not
  accept or run anything.
- **Open local task** opens the task linked to the receiver's run.
- When the run has ended, **Return work** publishes a full or partial result for
  requester review. A stopped or incomplete run can be returned as partial;
  the label is not automatic requester acceptance.

Accept and Decline disappear when the offer deadline passes. A stale Telegram
tap is rejected with its current reason. Refresh the handover view after the
record is renewed; do not assume an expired tap was applied.

Accepted and declined decisions for an epoch are final. A delayed duplicate tap
cannot reverse them. If two people accept at once, the shared Git update decides
the winner and the loser is told that the offer was already claimed.

Returning work is also final for that epoch: the receiver cannot replace it with
a second Return. The requester can apply it or use **Request changes**, which
opens a new epoch with a fresh offer.

## Review returned work

On the requester workstation, open **Tasks → Team handovers** and choose
**Review returned work**, or return to the original task and use that panel.

1. Choose **Check for returned work**.
2. Review the result commit, evidence and any warnings or refused conditions.
3. If it meets the request, check **This result meets what I asked for** and
   choose **Apply result**. A partial result cannot complete the original task.
4. Otherwise enter specific requirements under **What still needs changing**
   and choose **Request changes**. This creates a fresh offer epoch.

Apply is explicit and remains final once recorded. It does not infer acceptance
from an agent's `DONE` text. If the requester checkout diverged or the merge is
unsafe, Apply stops and reports the conflict instead of overwriting local work.

## Withdraw an offer

The requester can choose **Withdraw** in **Tasks → Team handovers** while the
offer is still withdrawable. Withdrawal prevents later acceptance and remains
final. It does not undo work already claimed by a receiver.

## Loading, empty, error and offline states

- **Loading team handovers…** means the first shared-state read is in progress.
- **No open team handovers** means the open filter has no current offers,
  active work or returned results.
- **No team handovers yet** means the all-items view has no history.
- On an error, the panel either shows the last loaded rows or tells you to use
  **Refresh**. Treat cached rows as status only until a refresh succeeds.
- **retrying** in **Live Telegram** means the local bot is backing off after a
  Telegram error. Queued or failed delivery counts are shown in the same card.
- If a workstation is offline, Telegram or Git may retain information, but no
  state is accepted, running or applied until the responsible workstation
  durably acknowledges it.
- **Setup required** on a handover means repository readiness failed. Fix the
  local workspace or Git access; repeated Accept attempts do not bypass it.

## After a workstation restart

The shared roster and handover control record remain in the Git remote, and the
local database retains the linked task and action receipts. After restarting:

1. start the app and confirm **Live Telegram** reconnects;
2. choose **Refresh team**;
3. open **Tasks → Team handovers** and refresh it; and
4. inspect the local task before starting or returning work.

The app reconstructs receiver task/run identity when it can and will not apply a
recorded action twice. A provider process that was running during the restart may
have been interrupted; the shared handover record does not prove that process
continued. Use the task's restart/recovery state and return only work that is
actually present in the receiver worktree.

Disabling Team during an offer does not delete the shared record. Re-enabling
Team allows the workstation to read it again.

## Disconnect, rotate and disable

- To stop a Telegram account controlling this workstation, use **Unpair** beside
  it in the **Live Telegram** card. This does not revoke the bot token.
- To rotate a bot token, revoke it in BotFather. When the app reports **token
  rejected**, open **Agents → Manage Telegram**, paste the replacement and pair
  again if required. Revocation creates an outage until the replacement is
  saved.
- To switch this workstation to a different bot, open **Agents → Manage
  Telegram**, choose **Use a different bot** and paste the new bot's token.
  The phone paired with the previous bot is unpaired and a pairing link for the
  new bot opens by itself.
  One case needs a manual step: a phone that was paired before the workstation
  started remembering pairings beside the token.
  If the bot is changed before the workstation has started once on the old bot
  with that version, the phone stays listed as paired but receives nothing,
  because it has never opened the new bot.
  Use **Unpair** beside it, then pair again with the new bot.
- To disable Team locally, turn off **Enable handover** first, then **Enable
  Team**, and save. Personal Telegram can remain enabled.
- Before decommissioning a team, withdraw open offers, return or apply claimed
  work, close item threads, and remove both the person and their bot from the
  private Telegram group.

The current UI does not provide a complete remove-teammate or leave-Team action
for the shared Git roster. Removing someone only from Telegram, or merely
turning Team off on one workstation, does not rewrite that roster. Until an
administrator workflow is added, do not reuse the old roster after membership
changes; disable Team on both workstations and create a new Team for the reduced
membership. This is a product limitation, not a hidden setup step.

## Safety limits

- Team is intended for a small, trusted group. Accepting a handover runs another
  member's repository content with the receiver's local tools and credentials.
- Local file modes do not protect secrets from another process running as the
  same operating-system user.
- The preview detects known credential shapes but cannot prove that a package is
  secret-free. Review every path before publishing.
- Do not share a live SQLite database or one working directory between
  workstations.
- Do not interpret Telegram connectivity as workstation liveness, or an agent's
  success statement as requester acceptance.
- Per-task topics are not guaranteed in every Telegram group configuration; the
  pinned item anchor and item tag remain the routing reference.

## Test-harness setup is different

The live test harness uses dedicated test bots, a signed-in Telegram test client,
isolated ports, disposable databases and explicit evidence capture. Its setup is
documented in [Live Telegram setup for the end-to-end harness](e2e-live-setup.md).
The side-by-side pilot scripts and dated runbooks under
[`docs/telegram-task-control`](telegram-task-control/README.md) are operator/test
material. Normal users should not copy their bot names, ports, paths, `.env`
token instructions or repository URLs.

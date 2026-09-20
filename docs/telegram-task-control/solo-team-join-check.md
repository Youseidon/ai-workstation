# Solo two-account Team join check (LT-3 by yourself)

This is the LT-3 "Join" check from
[teammate-design.md](teammate-design.md) section 8.4, run by one person with two
Telegram accounts instead of two people.
It proves the teammate connect path end to end: create team, join code, join,
roster with two people and two bots.

Everything runs on one machine.
Account A plays the owner (jd), account B plays the teammate (Yousef).

## One-time setup (about 15 minutes)

### 1. Two bots

From either Telegram account, ask @BotFather for two bots and keep both tokens
out of chat and out of the shell history.
Bot A belongs to the owner workstation, bot B to the teammate workstation.
It does not matter that one account created both; the bot owner is never used as
authority.

### 2. One shared private repository

Create an empty private Git repository, for example
`git@github.com:<you>/aw-team-pilot-shared.git`, and give it one initial commit
so clones are not empty.
This is the Team repository that carries `refs/aw/team`; it is not the repository
holding this application branch.

One GitHub account is enough for both sides.
The roster's identity is Telegram-derived (`telegramUserId`, `botId`,
`botUsername`), `refs/aw/team` holds a blob rather than commits, and no Git
author identity is ever read, so both instances can push with the same
credentials.
A second GitHub account would only exercise repository access separation, which
is outside this check.

### 3. One private group

From account A, create a private group, add account B, then add both bots.
Promote both bots to administrator with **Pin Messages** and **Invite Users**
enabled; the `/team` command is refused without both rights.

### 4. Two Telegram sessions at once

Keep account A on the phone app and account B on Telegram Desktop or
web.telegram.org, or use two accounts in one Telegram Desktop.
You need both signed in simultaneously to send and receive as each side.

### 5. Two app instances

Instance A is this checkout: ports 3100 (web) and 4100 (server), bot A token in
`.env`.
Instance B is a second, separate checkout on different ports:

```bash
git clone --branch feature/team-telegram-pilot --single-branch \
  /home/junaid/ai-workstation-team-pilot ~/ai-workstation-team-pilot-b
cd ~/ai-workstation-team-pilot-b
npm run setup:team-pilot -- --label "Teammate pilot" --server-port 4200 --web-port 3200
```

The setup command asks for bot B's token through a hidden prompt.
Never copy instance A's `.env`, `.agent-console` or bot token into instance B;
the check is only meaningful if the two workstations share nothing but the group
and the repository.

Instance B also needs a local clone of the shared repository registered as a
workspace, because the join refuses a code whose remote no workstation tracks:

```bash
git clone git@github.com:<you>/aw-team-pilot-shared.git ~/team-shared
```

Add `~/team-shared` as a workspace in instance B's UI before joining.

## The check (about 10 minutes)

Start both instances (`npm run dev:team-pilot` in each checkout).

### Owner side, <http://localhost:3100/agents>

1. Confirm the Live Telegram panel shows connected.
2. Pair a phone: send `/start <code>` to bot A **from account A** in a private
   chat, then press Confirm pairing.
3. Turn on Team in Task Control settings and save.
   The Team panels appear only with transport Telegram and Team on.
4. In the Team panel, paste the shared repository URL and press Create team.
   The panel shows a `/team <code>` command.
5. Send that exact `/team <code>` in the group **from account A**.
   The bot replies "Team group verified" and the panel enables Confirm team.
6. Press Confirm team and copy the `awj1...` join code.

### Teammate side, <http://localhost:3200/agents>

7. Pair a phone: send `/start <code>` to bot B **from account B**, then Confirm
   pairing.
8. Turn on Team and save.
9. Paste the join code, press Check code, then Join team.
   The panel answers with "Ask the team owner to add @<botB> as an administrator
   with Pin messages, then send your one-member invite link."

### Back on the owner side

10. Press Refresh team.
    The roster re-reads `refs/aw/team` and the panel lists both members with
    both bot usernames, plus a one-member, one-hour invite link for the teammate.

## Pass criteria

- Both Agents pages show the same team id.
- Both panels list two members and two distinct bot usernames.
- The owner panel offers the one-member invite link.

## Gotchas

- Push access: the owner's workstation pushes `refs/aw/team` and the teammate's
  pushes the roster update, so `git ls-remote` and push must work from this shell
  for the shared repository.
  The same credentials serve both instances; only the two Telegram accounts must
  differ, because a shared account would collapse the two members into one.
- The `/team` command counts only from the account paired to that workstation;
  sending it from account B does nothing on instance A.
- The create code expires after 10 minutes and the join code after 24 hours, and
  the join code is single use, so a second attempt needs a fresh Create team.
- Both bots receive group messages, which is expected; each workstation answers
  only for what it owns.
- Instance B must have a workspace whose `origin` matches the join code's remote
  URL exactly, or Check code refuses with `team_workspace_missing`.

## What this does not prove

This covers the join path only.
Item threads, grants and handover are separate checks, and handover is not built.
Because one person holds both accounts, this does not reproduce the stopwatch
part of LT-3 (a second person's own setup time), so record it as a solo
functional join check rather than marking H-TM-LT3 PASS.

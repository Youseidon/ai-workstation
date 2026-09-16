# Review notes on the teammate design proposal

Status: first review pass by the implementing session, 2026-09-16, for jd's design review of [teammate-design-proposal.md](teammate-design-proposal.md).
None of this is decided; it is input for the review.

## Context the review should know

- The proposal was written by a subagent from a brief; it invented the name "Sara" for jd's teammate; replaced with Yousef, jd's actual teammate, on 2026-09-16.
- `~/OPINIONS.md` does not exist, so the proposal could not use jd's recorded opinions.
- jd's requirements, confirmed in conversation on 2026-09-15:
  - R-A handover when LLM allowance runs low, and R-B a work-item thread for clarification between two teammates with grantable slash commands on the starter's workstation.
  - Telegram carries all messaging and notifications; the shared GitHub repo carries files.
  - One bot (jd's); teammates never touch BotFather; a teammate's Telegram setup under a minute; the teammate's workstation may hold the token; no dependency on jd's workstation being online.
  - Simple, robust, and a lean evidence plan (not another L1-sized test effort).
  - Burn-in now uses 3 repeats, not 20.

## Decisions jd made in the review, 2026-09-16

These five supersede the proposal and the notes below wherever they disagree.
The rest of the proposal is still under review.

1. **One bot per person, owned by that person. No shared bot, no relay, no token ever shared.**
Supersedes the earlier relay decision taken on the same day, which existed only to work around the single shared bot.
Each person creates their own bot in BotFather, guided by the app, exactly as the existing L1 setup already does, and each workstation long-polls its own bot exactly as today.
The team's private supergroup holds both bots.
Telegram then routes by construction: a callback goes to the bot that posted the card, a reply goes to the bot whose message it answers, so the workstation that owns an action receives its own updates directly and no machine speaks for another.
Each bot runs with privacy mode on (`can_read_all_group_messages` false), which by itself gives the "store only task-related inputs" filter the proposal built by hand at the poller.
This removes the relay service, the poll-role election and 409 handling (D18 as written), `refs/aw/relay`, the relay queue table, the ownership-code prefix on callback data, the "passed on" toasts and questions Q1, Q6 and Q10.
D02 largely reverts to its accepted text; Git goes back to carrying files plus the roster and handover records only, which restores R-C.
Costs jd accepted: a teammate uses BotFather once, so setup is about 3 minutes rather than under a minute (R-D revised); jd adds the teammate's bot to the group and grants it Manage topics once per teammate, because bots cannot add bots; and a workstation offline for more than about 2.5 minutes still loses uncollected taps, which is the solo behaviour jd already accepted in commit 800fb9a.
2. **No shared secrets anywhere.**
The join code carries team id, group chat id, repository remote and invite id, and no token.
It stays single-use with a 24-hour expiry to keep strangers off the roster, but it is no longer a credential.
Each person's private chat with their own bot is private by construction, not by convention, so the trust note the shared-bot design needed disappears.
To verify in a real check: with privacy mode on, whether a plain `/status` in a topic reaches both bots or only the `@`-addressed one; if only the addressed one, group commands use `@botname` or buttons.
3. **Handover moves code on an ordinary Git branch** (note C), with a small compare-and-swap record so only one claim wins.
Drops S-TM-10, S-TM-12 and most of slices TM6 and TM8.
4. **Either person may start an item thread** on any item, including one the other owns (R-B as written).
The item's owner still holds every decision and every grant, so D19 changes only in who may open the topic.
6. **Item threads use C1's anchor and replies, not forum topics.**
C0 recorded on 2026-09-16 (commit 4c33bdb) that the bot has no topics setting in BotFather and that a two-member group cannot become a forum at all, so "one topic per item" is unbuildable for a two-person team.
An item thread is instead a pinned anchor card in the one team group, with every later message replying to that anchor and carrying the project-scoped tag, exactly as C1 already does for personal control.
The thread registry keeps the seam, so real topics can be switched on later without a redesign, in the same way C2 waits for a recording.
Accepted costs: the team group is one flat stream when several items are shared at once, and there is no per-item mute.
5. **Evidence plan trimmed** (note D): most logic in T0, about 15 T1 scenarios for threads and grants, about 6 more when handover lands, burn-in at 3 repeats, plus the short real checks.

## Prior art checked before writing the claim record, 2026-09-16

Read on jd's instruction, to decide whether to depend on an existing project for the one-winner claim in decision 3.
Conclusion: implement it in the app, about a hundred lines, and take two details from the projects below.

| Project | What it is | Why not a dependency |
| --- | --- | --- |
| [agent-sync](https://github.com/ssheleg/agent-sync) | Python 3 CLI plus bash hooks, MIT. Cross-machine claims over Git refs, TTL leases by default with a Git backend for true mutual exclusion. | CLI only, not a library, a Python runtime added to a Node app, and 3 stars. The technique is what matters, not the package. |
| [Grite](https://github.com/neul-labs/grite) | Rust binary, MIT, 18 stars, distributed on npm, Cargo, pip and Homebrew. An append-only event log in `refs/grite/wal` with a materialized local view, plus TTL locks in `refs/grite/locks/<hash>`. | It is an issue tracker we do not need, its locks are TTL and clock-based where this design deliberately uses none, and it would add a Rust binary to ship and update. |
| [AgentConduit](https://github.com/aididhaiqal/AgentConduit) | TypeScript, MIT. FIFO fenced leases over SQLite, with a Hub for multi-machine use. | Multi-machine mode needs a hub and a shared SQLite, which is the central service this design avoids. 7 commits, 0 stars. |
| [Multica](https://github.com/multica-ai/multica) | The mature agent-team platform: Go backend, Postgres, a daemon per machine. | Requires a central self-hosted server, and it assigns work to agents rather than handing a live task to another person's workstation and subscription. |

Taken from them:

- agent-sync states the rule this design already assumed, that "the remote's non-fast-forward rejection _is_ the CAS", and it too avoids clocks for exclusion.
That is independent confirmation of protocol 4 and of dropping the lease file the proposal considered.
- Grite's retry loop, fetch, re-apply local-only events on the new head, push again, is the right shape for our retry, with one difference to write down: our control records are state transitions, not commutative events, so the loser must re-validate the transition against the new state, not blindly re-append. A claim that lost stays lost.
- Grite's "uncertain push" case matches the proposal's rule of looking for the command id after a fetch before retrying.
- Neither project's TTL leases are needed here: handover is human-paced, and a stale claim is resolved by a person, not a timer.

Useful side finding: Grite ships custom refs under `refs/grite/*` against GitHub as its normal mode of operation, which is evidence that LG-1, the check that GitHub accepts `refs/aw/*` pushes and fetches, should pass.

## Recorded defaults the design reuses

Checked against the baseline defaults table in [README](README.md), the engineering defaults in [engineering-plan.md](engineering-plan.md), [protocol.md](protocol.md) and the L1/L3 entries in [implementation.md](implementation.md).

Reused unchanged, nothing for jd to decide:

| Default | Recorded as |
| --- | --- |
| New capabilities are off until explicit local setup, and gate status is surfaced | README defaults, engineering defaults |
| Quota warning at 5% of a reported window; a quota reading older than 120 seconds is stale | README defaults |
| Approval validity 24 hours; expiry does not stop an already running attempt | README defaults |
| One quota warning per window or reset identity; status messages update in place | README defaults |
| Telegram carries approved titles, structured questions and sanitized evidence only | README defaults |
| No automatic purge; a team retention policy is still required (G04) | README defaults |
| Pairing challenge single-use, expires after 10 minutes, confirmed locally | protocol section 2 |
| An action reference is validated on actor, chat, topic, message, bot, revision, epoch and expiry | protocol section 7 |
| Outbox per-row retry schedule, bot-wide pause on 429, a queued edit of a message replaced rather than stacked | L1 implementation entries |
| Errors classified as rate limited, transient, unauthorized, conflict or rejected, and rebuilt token-redacted | L1 implementation entry |
| Workstation label setting, defaulting to the OS hostname | engineering-plan RTC, L3 entry |
| Shared contracts versioned; an unknown required version is rejected, an unknown optional one kept | engineering defaults |
| Burn-in at 3 repeats | current project default |

Also reused unchanged once decision 1 removed the relay:

| Default | Recorded as |
| --- | --- |
| Telegram polling: 25-second long poll, save updates before advancing the offset | README defaults. Each workstation polls its own bot, so this is today's behaviour with no change at all. |
| Shared status: milestones at once, an observation at most every 60 seconds, unknown after 180 seconds | README defaults, reused for item threads. |

Narrowed, not changed:

| Recorded default | Now covers |
| --- | --- |
| Shared-record discovery every 5 seconds, backing off with jitter to at most 60 seconds | The records Git still carries: the roster, the handover branch and the claim record. It never carried Telegram updates in the end. |

New values this design needs, proposed, none recorded yet:

| Value | Proposed |
| --- | --- |
| Team action expiry (taps in item threads) | 10 minutes, as in proposal 5.3 |
| Grant lifetime | Until revoked, the thread closes or a handover starts (Q3) |
| Join code | Single use, 24-hour expiry, no longer a credential |
| Item topic name | Capped at 128 characters |

## Structural points to decide first

A. One shared bot also slows personal control.
Whichever workstation polls receives every update, including the other person's private-chat taps and replies.
When the other workstation polls, a personal tap goes through the Git relay (about 5-15 seconds) instead of about 1 second, and its toast can only say "passed on".
Recommendation: a preferred poller (jd's workstation takes polling back whenever it is online), so jd's personal control stays as today and only the teammate's updates are relayed while jd is online.

B. Reading the relay every 10 seconds is about 8,600 Git calls per workstation per day against GitHub.
Recommendation: check the relay ref with `git ls-remote` and fetch only when it changed; add a rate check to LG-1; fall back to a slower interval if GitHub throttles.

C. Handover can use ordinary Git branches instead of custom checkpoint and apply machinery.
The proposal captures a checkpoint through a temporary index, stores it under custom refs, and applies a checkpoint-to-result diff after checking the tree still matches.
Simpler: handover commits to a branch `aw/handover/<item>` and pushes it (asking first if the tree is dirty); the teammate's app works in a worktree of that branch and pushes the result to it; Apply is a normal fast-forward or merge in the requester's checkout, stopping with Git's own conflict handling.
This removes S-TM-10, S-TM-12 and most of TM6 and TM8; the one-winner claim still needs a small compare-and-swap record.

D. The evidence plan is still large: 49 scenarios (14 T0, 35 T1) plus a two-workstation harness slice (H10).
Recommendation: move ownership, grants, poll role and join-code logic into T0; keep T1 to about 15 scenarios for threads (4 polling, 4 routing, 2 join, 5 threads and grants) and about 6 more when handover lands; keep H10 to two environments on separate ports sharing one fake Telegram.

## Recommended answers to the proposal's open questions

| # | Recommendation |
| --- | --- |
| Q1 | Superseded: push to a relay on jd's own host (decision 1 above). |
| Q2 | Yes, personal items stay in private chats. |
| Q3 | A grant lasts until revoked, the thread closes, or a handover starts. |
| Q4 | Yes, Answer and resume needs both `answer` and `resume`. |
| Q5 | Reject and reissue a relayed tap whose action expired. |
| Q6 | No longer applies: there is no repository relay to read. |
| Q7 | jd only. |
| Q8 | Record the G01 decision when TM7 starts, not now. |
| Q9 | Yes, but only when Apply is a clean fast-forward or merge (C). |
| Q10 | No longer applies: the relay queue lives on jd's host, not in the repository. |
| Q11 | Yes, symmetric. |
| Q12 | 3 repeats (jd's burn-in preference, which supersedes the proposal's 10). |

## Also confirm

- In the team group, replies to messages the bot did not send get no "That message is not a task question" hint, so two workstations never both answer one reply.
- Measured Telegram limits the design relies on (2026-09-15): callback answer within about 15 seconds of the tap; an unconfirmed tap is dropped about 145 seconds after it is made; a sent message is visible before its sendMessage response returns; a second `getUpdates` poller gets 409; topics must be enabled per bot (C0 records the rest).

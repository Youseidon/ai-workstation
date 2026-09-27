# V6 handover: finishing V5 and the completion report

> **CLOSED 2026-09-27. Superseded by [team-v7-handover.md](team-v7-handover.md).** V5 is finished and the completion report is written. Take no number from this file.

Written 2026-09-26, by the orchestrator, for the session that finishes this track.
This session closed **C5**, the last build task, reproduced **M-13**, and took **V5** from blocked to four of seven cases done against live Telegram.
Read this first, then [team-burndown-tracker.md](team-burndown-tracker.md) and [team-gap-register.md](team-gap-register.md).

[team-v5-handover.md](team-v5-handover.md), [team-v4-handover.md](team-v4-handover.md), [team-m9-handover.md](team-m9-handover.md) and [team-reconcile-handover.md](team-reconcile-handover.md) are **closed history**. Take no number from any of them without checking it here.

## 1. Where everything is

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation`, clean. Tip was `698dcef` when this document was written and has moved since; read `git log -1` rather than this cell |
| main vs `origin/main` | **Ahead by 404 when written and still climbing, 0 behind. Nothing has ever been pushed**; `git branch -r --contains HEAD` is empty |
| Worktrees / task branches | One worktree, the checkout itself. **Zero** `fix/*` or `tm/*` branches |
| **Full T1 suite** | **140 of 140**, 0 flaky, 26.4 minutes, run by the orchestrator on main |
| Server suite | **618 of 618, re-run by the orchestrator 2026-09-26**, 0 fail, 133 seconds, exit 0. Matches the C5 worker's figure |
| Shared / Web | 91 of 91 / 95 of 95, unchanged |
| Web lint | 19 problems, 17 errors, 2 warnings. Upstream's files, waived by jd, **L-12**. Leave it |
| Audit 3 / Audit 4 | Both **FAIL**, both routed by jd's written waivers |

T1 moved 134 → 135 (C5's row) → **140** (M-13's five rows).

## 2. THE RIG IS LIVE. Read this before touching anything.

Two pilot instances are **running right now** against **real Telegram**, under jd's authorization of 2026-09-26. Do not wipe them, do not `setup:team-pilot` over them, and do not start a T1 harness run while using them.

| | Instance A (owner) | Instance B (teammate) |
| --- | --- | --- |
| Checkout | `/home/junaid/ai-workstation-team-pilot` | `/home/junaid/ai-workstation-team-pilot-b` |
| Ports | web 3100, api 4100 | web 3200, api 4200 |
| Bot | `@aiws_helper_bot` (`8262291110`) | `@ai_test_pilot_1_bot` (`8998251911`) |
| Person | `Jj` / `jshay96` / `8973262519` | `Junaid` / `6525517234` |
| Workstation label | `Junaid pilot` | `Teammate pilot` |
| Workspace | 1 `Team pilot workspace` | 1 `pilot-project` |

Both on main's tip. Both databases **pinned per checkout** by `AGENT_CONSOLE_DB` in their `.env` - see **H-4**; without that pin they share one database and the two-workstation isolation is a fiction.

- Team `awt1_h0XDkrOF02ItMy73`, supergroup `-1004359741812`, roster remote `https://github.com/psyba96/ai-workstation-team-pilot-workspace-20260918-d8c1` at `refs/aw/team` = **`4255c668…`**. **Correction, 2026-09-26**: this document first said `2475e47…`, which was wrong. `4255c668…` is confirmed three ways - the `team_roster` row on both instances, the local mirror's `refs/aw/team`, and `git ls-remote` against GitHub itself. The wrong value was a figure captured before instance B's join pushed the roster, and recorded without being re-read.
- Workspace tree shared by both instances at `/home/junaid/ai-workstation-team-workspace` (that is **B19**, a rig limit, not a product one).
- **Prompt 1 `WI_TC01` is `BLOCKED` with its question card already delivered** to chat `8973262519`, outbox row 3, both buttons live. That is the item cases 2, 3 and 11 run against.
- Start either instance with `env -u ANTHROPIC_API_KEY npm run dev:team-pilot` (B4).
- Backup of the pre-rebuild rig, and of September's roster ref, is at `/home/junaid/pilot-rig-backup-20260926/`.

**Both bots' group rights are verified, 2026-09-26, and this replaces the open question V6 first left here.**
`getChatMember` was asked through **both** tokens independently, so neither answer rests on one bot's view:
`@aiws_helper_bot` (`8262291110`) and `@ai_test_pilot_1_bot` (`8998251911`) are each `status: administrator`
with `can_pin_messages: true`. jd's statement was correct.
Two details worth keeping. First, `@ai_test_pilot_1_bot` has `can_manage_topics: false`, and **that is
harmless**: `runtime.ts:124-128` records under C0 that topics are unavailable to these bots at all, so C1
organises the flat chat by tag, card and replies and nothing ever calls `createForumTopic`. `getChat`
confirms the group is not a forum. Second, the panel instruction that asks for this is still emitted
unconditionally and still proves nothing - **do not poll it**; ask Telegram, as above.

**Instance B is live and long-polling**, which is what makes case 3's "instance B stays silent" an assertion
rather than a tautology. Proof that does not use `pgrep`: `ss -ltnp` shows four distinct listeners
(`4100` pid 117123, `4200` pid 117484, `3100` pid 117135, `3200` pid 117504), and `ss -tnp` shows pid
117484 holding **two established connections to `149.154.166.110:443`**, which is `api.telegram.org`.

## 3. V5 is complete: six PASS, one PARTIAL, one SKIPPED

| Case | Result | Evidence |
| --- | --- | --- |
| 0a notifications and remote actions | **PASS** | both on via `PUT /api/settings`, persisted to `.agent-console/settings.json` |
| 0b task waiting on a question | **PASS** | run `run_2636609e` on `claude-sonnet-4-5`; prompt 1 `BLOCKED`; card posted unprompted, `kind: personal_question`, both buttons, options parsed |
| 1 roster on both sides | **PASS** | two people two bots on both instances; `refs/aw/team` moved `aa92159…` → `2475e47…`, so the GitHub round trip is real |
| 12 default-off regression | **PASS on the API half** | Team on: `200` / `405`. Team off: both `403 team_disabled`, `items` `403`. **The `405`→`403` is the assertion**: the gate sits in front of method routing. Personal control unaffected. **Browser half now PASS too**, 2026-09-26, driven with Playwright on 3100: `Team status`, `Join team` and the create panel on `/agents`, and `Team thread` on the `WI_TC01` detail, are all present with Team on, all gone with Team off **after a reload**, and all restored when it goes back on. **Still owed: the phone half only** - the private chat behaving unchanged. One defect found, registered **L-16**, not fixed: with no reload every panel stays, and the `Open Team thread` button stays enabled, though clicking it `403`s with a message that names the real cause |
| **2 open the item thread** | **PASS 2026-09-26** | `201`, item `awi1_63460787e23fa7d635890376`. Anchor = Telegram message **85** (outbox 8), access message = **87** (outbox 9) reading `Item access / Jj: owner / Junaid: read only`. `telegram_thread` 4 `ACTIVE`, `item_link` `role: requester` `epoch: 1`, no grants. **Pin verified through `getChat`**, not from the local flag |
| **3 read-only views** | **PASS 2026-09-27** | Run by jd from account B. All five sends were genuine replies to anchor 85, each answered exactly once by `@aiws_helper_bot`, and **instance B received every group update and emitted nothing into the group**. No receipts, no grants, no state change. `/help` proved capability-derived, which retires the B12 warning |
| **11 close the thread** | **PARTIAL, B17 reproduces. M-15** | `/close` from B refused as owner-only; `/close` from A set `item_link.closed_at`. But `/task` from B a minute later returned the whole item. **The cause is not the `ACTIVE` thread row**: `closedAt` gates granted commands and not reads, and the thread lookup filters on `ANCHOR_GONE` only, so closing the row would fix nothing. No grants ever existed, so the grant-ending criterion was **not exercised** |

Case 10 stays SKIPPED (B15). Cases 4 to 9 are **not** in V5's scope - V5 is cases 2, 3, 11 and 12 only.

**Record the rows in [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md)'s Progress table as a re-run**, without overwriting September's rows: audits 1 to 4 cite them.

**The clause is "LT-4's re-run rows are recorded", not that they pass.** A case recorded PARTIAL with a reason satisfies section 8; a blank does not.

## 4. What is left after V5

The completion report. Section 8 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md) defines done, and **two of its five clauses cannot be reported as met**:

- **"Audit 3 and audit 4 pass"** - both FAILed. jd's written waivers satisfy the brief's *rule*, which offers waiver as an alternative to fixing, but they do not make the clause true.
- **"LT-4's re-run rows are recorded"** - **now satisfied, 2026-09-26.** Every case has a row in the re-run table in [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md), including cases 3 and 11 as NOT RUN with the reason, and cases 4 to 9 as out of V5's scope rather than blank. The clause asks that rows be recorded, not that they pass.

The report owes jd: commits per task, counts per tier, burn-in results, the G01 decision, real checks and outcomes, both audit results, design corrections, and everything left open. **G01**: recorded 2026-09-20 in `implementation.md` section 6b - the handover delegates nothing, so a receiver resuming under their own login is ordinary use; it holds only while acceptance stays an explicit human action and no credential is shared, so auto-accept re-opens it.

## 5. jd's decisions this session, all 2026-09-26

1. **Live Telegram bot credentials authorized** for the orchestrator. An explicit exception to a standing rule; every task record from here must say a live credential **was** used.
2. **jd runs cases 3 and 11 by phone**; the orchestrator runs 2 and 12. Bot tokens cannot type as a user.
3. **Rebuild the rig fresh on main** rather than updating in place.
4. **Roster push to the pilot repo is in scope**, it being a throwaway repo separate from `ai-workstation`.
5. **Prove-first on the A5 surfaces** - reproduce, no product change. That became **M-13**.

## 6. New gaps, all registered this session

- **H-4** - the pilot's database isolation is broken on main and the guard's own advice (`AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1`) is what silently breaks it. Worked around in the rig; **the product fix is not done**.
- **M-12** - `handoverReview`, `applyHandover` and `requestHandoverChanges` have **no caller in `web/`**. The requester's review-and-apply half has no web surface.
- **M-13** - reproduced. The row has no `AWAITING_RESPONSE` branch and offers nothing to press; the detail page is degraded but not a dead end; and **its "Review and respond" button submits a canned answer on the owner's behalf** because the banner and the response box are gated on mutually exclusive states. `HumanInputDialog` is mounted and **never opened**. Probably upstream's, not an M-9 regression.
- **M-14** - a workstation that loses its database cannot rejoin a team it is already listed in, and `roster_conflict` covers at least two distinct states, one remote and one a stale **local** mirror.
- **L-16** - turning Team off leaves every Team panel on screen until the page is reloaded. `settings_updated` carries only `providers`, and the web reducer applies only `providers`, so the settings snapshot holding `team.enabled` is never re-read. The server comment claiming every tab re-reads "both" overstates what the message carries. Low: the API gate holds and the refusal names the cause.
- **L-17** - `scripts/team-pilot-state.mjs` defaults to the calling checkout's database and prints `main`'s leftover fixture as a real team, `team-7` / `jd-laptop` / `yousef-desktop`, with no marker. The check document's own command block invited this and has been corrected to pass the path for both instances.

## 7. What this session learned that the next should not relearn

- **`pgrep -f "<pattern>"` matches the shell running it.** This cost two false "still running" readings and one `pkill` that killed its own shell mid-script. Check what matched before believing it, or match on a port instead.
- **The Team panel's setup instruction never clears.** `runtime.ts:501-507` emits it unconditionally whenever a teammate exists and never asks Telegram. Polling it loops forever.
- **Pairing and team codes live 10 minutes.** Do not mint one for an absent operator.
- **`roster_conflict` has a local cause as well as a remote one.** Clearing the remote ref is not enough; `.agent-console/team/remote.git` caches its own copy.
- **The check document's own explanations are stale**, though its steps are sound: case 0b cites `operationalState.ts:10` mapping `BLOCKED` to `AWAITING_RESPONSE`, which the reconcile moved. The behaviour is nonetheless correct because `promptsAwaitingResponse()` goes through the shared `awaitsResponse()` predicate, which accepts both spellings. **Verified, not assumed** - had it still compared by hand, no card would ever post.
- **A worker killed by a rate limit lost nothing**, for the second time, because commit-each-proof was in its card. Keep putting it there.
- **Verifying before recording keeps paying.** This session it caught an `api.telegram.org` claim that was wrong because the grep was scoped to the wrong directory - recorded as a correction rather than amended away.
- **It kept paying in V5 too, twice.** This document's own `refs/aw/team` value was wrong, and only checking it against `git ls-remote` found that; it is corrected in section 2 rather than amended away. And case 2's pin was confirmed through `getChat` rather than from the local `anchor` column, which is the flag rather than the fact.
- **A default argument can print a convincing lie.** `team-pilot-state.mjs` with no path read `main`'s fixture database and printed `team-7` with two members who do not exist. Nothing marked it as a fixture. **Pass the path explicitly and read the header line the printer echoes**, which is the only thing in the output that would have given it away. That is L-17, and it was briefly filed as a bug-log `B20`, an id the design documents already use.
- **A helpful-looking instruction can be nobody's caller.** L-16's cause was found by reading what `settings_updated` actually carries, next to a server comment asserting it carries more. The comment was the wrong thing to trust; the reducer was the right one.

## 8. Standing constraints

No push and no remote write **to `ai-workstation`**; nothing has ever been pushed. The roster push to the pilot repo is authorized and is a different repository.
No paid provider. **Live Telegram credentials are authorized** as of 2026-09-26.
Never two harness runs at once, and the live rig contends with the T1 harness.
**`team.handoverEnabled` no longer "stays false". Lifted by jd on 2026-09-27.**
The constraint existed for **G02**, the authorization gate, which required evidence that isolation held before a teammate could run a work item under their own login and quota - and **H-3** required that evidence at three repeats rather than one.
**G02 and H-3 closed on 2026-09-22**, both tiers at three repeats, with `TM-T1-H1:225-227` additionally asserting that no credential reaches the transcript across all six burn-in repeats.
So the sentence outlived its reason by five days and was copied forward into every handover written since. **That is the same failure as the "nothing has ever been pushed" claim**: a constraint that stopped applying and kept being repeated.
The two residual risks jd accepted on 2026-09-20 are unchanged and are **not** blockers: the `.env` bot token is readable by any same-user process, and accepting a handover means another member's code runs with your own credentials in the environment. In the rig both members are jd on one machine, so the second is empty there.
`team.enabled` is **on** in the rig by necessity and off by default in the repo; the repo default for `handoverEnabled` also stays `false` and only the rig turns it on.
Commit messages imperative, **no co-author line of any kind**.
Every task gets its own worker, branch and worktree, and lands by fast-forward.

**Stop and ask jd**: before any push, on any audit FAIL, before changing a personal-control surface A5 covers, and before anything destructive to the live rig or the pilot remote.

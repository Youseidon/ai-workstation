# V7 handover: the Team track is verified, and the forward plan is carded

Written 2026-09-27, by the orchestrator, for the session that executes the plan.
The previous session **finished V5**, wrote the **completion report**, and then turned the open items into a prioritised, carded plan with **jd's ruling on every decision**.

Read in this order:
1. **[team-plan-cards.md](team-plan-cards.md)** - what you actually do. One card per task, and the rules every card inherits.
2. **[team-forward-plan.md](team-forward-plan.md)** - priority bands, the six phases, and jd's thirteen decisions.
3. **[team-completion-report.md](team-completion-report.md)** - what was done and what the tiers stand at.
4. [team-gap-register.md](team-gap-register.md) and [pilot-bug-log.md](pilot-bug-log.md) for detail on any id.

[team-v6-handover.md](team-v6-handover.md) and earlier are **closed history**. Take no number from them without checking it here.

## 1. THE RIG IS LIVE, and it is in a state that matters

Two pilot instances are **running against real Telegram** under jd's authorisation of 2026-09-26.
**Do not wipe them, do not run `setup:team-pilot` over them, and never start a T1 harness run while using them** - the harness is exclusive and contends with the rig.

| | Instance A (owner) | Instance B (teammate) |
| --- | --- | --- |
| Checkout | `/home/junaid/ai-workstation-team-pilot` | `/home/junaid/ai-workstation-team-pilot-b` |
| Ports | web 3100, api 4100 | web 3200, api 4200 |
| Bot | `@aiws_helper_bot` (`8262291110`) | `@ai_test_pilot_1_bot` (`8998251911`) |
| Person | `Jj` / `8973262519` | `Junaid` / `6525517234` |

- Team `awt1_h0XDkrOF02ItMy73`, supergroup `-1004359741812` (`AI_WS`), roster ref `refs/aw/team` = **`4255c668…`**, confirmed against GitHub itself.
- Databases **pinned per checkout** by `AGENT_CONSOLE_DB` in each `.env`. Without that pin they share one database - that is **H-4 / P-A2**, and the guard's own advice is what breaks it.
- Both bots are **verified administrators with Pin messages**, checked through both tokens. `@ai_test_pilot_1_bot` lacks `can_manage_topics`, which is harmless: topics are unavailable to these bots at all (C0), nothing calls `createForumTopic`, and the group is not a forum.
- Start either instance with `env -u ANTHROPIC_API_KEY npm run dev:team-pilot` (B4).
- Print rig state with the path **given explicitly**: `node scripts/team-pilot-state.mjs ~/ai-workstation-team-pilot/.agent-console/console.sqlite`. With no path it reads `main`'s fixture and prints a **fake team** - that is **L-17 / P-D1**.

**The rig's task state has moved, and P-A3 cares about it.** Prompt 1 `WI_TC01` is now **`TODO`** with a `human_response_hold` on response 4, whose content is jd's own `Integer cents is fine`, saved from Telegram during V5 case 12. The item thread `awi1_63460787e23fa7d635890376` is **closed** (`item_link.closed_at` set) though `telegram_thread` 4 still reads `ACTIVE`, and message **85** is still pinned.

That state is exactly the one **M-13's widened half** is reachable from: the detail page is showing a **"Continue with saved answer"** button which, if pressed, replaces jd's answer with a canned string and starts a run. **Do not press it except as part of P-A3's reproduction.**

## 2. State of the repository

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation`, clean. Read `git log -1`; this cell will be stale |
| vs `origin/main` | **415+ ahead, 0 behind.** `origin/main` is `4fd0e65`. **199 commits are on no remote ref at all** |
| Ever pushed | **One branch, once**: `origin/feature/team-telegram-pilot` at `5018409`, 2026-09-18, an ancestor of `dc3e9de`, still on GitHub. It holds **no** burndown work. The blanket phrase "nothing has ever been pushed" is **wrong** and should stop being written |
| Worktrees / task branches | One worktree, the checkout itself. **Zero** `fix/*` or `tm/*` |
| **Full T1** | **140 of 140**, 26.4 minutes. **Still valid**: every commit since `395fa16` is docs-only |
| Server | **618 of 618**, 0 fail, 133s, re-run by the orchestrator 2026-09-26 |
| Shared / Web | **91 of 91** / **95 of 95**, re-run 2026-09-26 |
| Typecheck | exit 0 across shared, server, web, e2e |
| Web lint | **19 problems, 17 errors**, exit 1. Upstream's files. **L-12, waived. Leave it** |
| `e2e` self-tests | **Unmeasured. L-13 / P-B4** |
| Audits 3 and 4 | Both **FAIL**, both routed by jd's written waivers |

## 3. What the previous session finished

**V5 is complete**: cases 0a, 0b, 1, 2, 3 and 12 **PASS**, case 11 **PARTIAL**, case 10 **SKIPPED**.
Cases 3, 11 and 12's phone half were run by **jd personally** on 2026-09-27, because a bot token cannot type as a user.
Every case has a row in the re-run table in [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md), September's rows untouched.

**C2 closed** - V4 and V5 were its last items. **The critical band is empty of build work**; P-A2, P-A3 and P-A4 are critical because of what they are, not because anything is unbuilt.

**Section 8's clauses**: clause 2 met (by fixing it - four rig deferrals had their reason only in the gap register, not the bug log, so the clause read as met while being unmet), clause 3 met, clause 4 met, clause 5 met by the report. **Clause 1 can never be met.**

## 4. jd's decisions, all 2026-09-27

Thirteen, one at a time, each put with its evidence first. The full table is section "jd's decisions" of the plan. The ones that change how you work:

- **The push goes last** (P-A1), after every other item. The 199-commit exposure is accepted deliberately.
- **`team.handoverEnabled` no longer "stays false".** It existed for gate **G02**, which closed **2026-09-22** with both tiers at three repeats. The constraint outlived its reason by five days and was copied into every handover in between. **jd asking "why is handover switched off" is what surfaced it.**
- **jd wants every Team feature tested on the rig, handover included**, which is why F10 was promoted to **P-A4**: handover is a Git exchange and B19's shared working tree makes it unobservable.
- **Ruling 7 wins** on M-7: a stopped-but-unreturned item is still held.
- **Build** M-12's web surface, against the orchestrator's recommendation.
- **Yousef confirmed** as G04's fallback owner. A second machine is intended but unscheduled, so P-A4's clone is built as a **real** second clone.

## 5. What this session learned that the next should not relearn

- **A closure should name the constraint it releases.** G02 closed and nobody lifted `handoverEnabled`. Five days and several documents later, jd had to ask.
- **Grep the whole docs tree before minting an id.** A new bug-log `B20` was created for the state-printer trap - and `B20` was already taken by the design documents' own B series, which runs past B28 and is cited by ruling 4 and by `teamControlRecord.ts`. It is now **L-17**, the bug log is **closed at B19** with a note saying why, and the slip is recorded in L-17 because it was made one message after warning jd about that exact hazard.
- **Check a line number before putting it in a card.** Two in the register were stale: `taskControl.ts:321` is really `:341`. Checking `WorkItemDetail.tsx:245` is what found **M-13's second, sharper half** - a button labelled "Continue with saved answer" that discards the saved answer.
- **Argument order can make a command lie.** `git rev-list --count --not --remotes HEAD` returns `0` because `--not` swallows `HEAD`. The real figure is `git rev-list --count HEAD --not --remotes` = **199**.
- **`pgrep -f` matches its own shell.** Use a port and a PID: `ss -ltnp`, `ss -tnp`.
- **Verify a remote claim against the remote.** Case 2's pin was confirmed with `getChat`, not from the local `anchor` column, which is the flag rather than the fact. The roster ref in V6 was wrong until `git ls-remote` was run.
- **A deferral recorded in the wrong document is not recorded.** Clause 2 asks for a reason **in the bug log**; it was in the gap register.

## 6. Standing constraints

No push and no remote write to `ai-workstation` **until P-A1**, which jd is asked about first. The roster push to the pilot repo is authorised.
No paid provider. **Live Telegram credentials are authorised** as of 2026-09-26, and every task record must say a live credential **was** used where it was.
Never two harness runs at once, and **the live rig contends with the T1 harness**.
`team.enabled` on in the rig, off by default in the repo. `team.handoverEnabled` **on in the rig** from P-A4, off by default in the repo.
Every task gets its own worker, branch and worktree, and lands by **fast-forward**. Commit messages imperative, **no co-author line**.

**Stop and ask jd**: before any push, on any audit FAIL, before changing a personal-control surface **A5** covers beyond what P-A3 already authorises, and before anything destructive to the live rig or the pilot remote.

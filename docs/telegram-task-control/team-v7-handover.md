# V7 handover: the Team track is verified, and the forward plan is carded

Written 2026-09-27, by the orchestrator, for the session that executes the plan.
The previous session **finished V5**, wrote the **completion report**, and then turned the open items into a prioritised, carded plan with **jd's ruling on every decision**.

**The session's first action was P-A0**: reproduce M-13's saved-answer half, which was written into the register from a code read rather than a test. jd ruled this on 2026-09-27. It changed no product code, and it **falsified the register's severity claim** - see section 1 and the register's M-13 entry.

**One thing is waiting on jd**: V5 case 11's re-run with real grants, the closing item of Phase 2. See [case11-rerun-script.md](case11-rerun-script.md).

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
| Team workspace | `/home/junaid/ai-workstation-team-workspace` | `/home/junaid/ai-workstation-team-workspace-b` - **its own clone since 2026-09-27, P-A4** |
| Ports | web 3100, api 4100 | web 3200, api 4200 |
| Bot | `@aiws_helper_bot` (`8262291110`) | `@ai_test_pilot_1_bot` (`8998251911`) |
| Person | `Jj` / `8973262519` | `Junaid` / `6525517234` |

- Team `awt1_h0XDkrOF02ItMy73`, supergroup `-1004359741812` (`AI_WS`), roster ref `refs/aw/team` = **`4255c668…`**, confirmed against GitHub itself.
- Databases **pinned per checkout** by `AGENT_CONSOLE_DB` in each `.env`. Without that pin they share one database - that is **H-4 / P-A2**, and the guard's own advice is what breaks it.
- Both bots are **verified administrators with Pin messages**, checked through both tokens. `@ai_test_pilot_1_bot` lacks `can_manage_topics`, which is harmless: topics are unavailable to these bots at all (C0), nothing calls `createForumTopic`, and the group is not a forum.
- Start either instance with `npm run dev:team-pilot`. **B4 is fixed as of 2026-09-27**: the launcher scrubs the provider credential variables, so the old `env -u ANTHROPIC_API_KEY` prefix is no longer needed. It is harmless if you keep typing it.
- Stop either instance by signalling its **launcher** (`run-team-pilot.mjs`). **B10 is fixed**: the child is detached and the handler signals its process group, so the launcher now takes the whole tree down - verified at four listeners to zero in under four seconds. Signalling the `concurrently` supervisors still works and is what the old instructions said.
- Print rig state with the path **given explicitly**: `node scripts/team-pilot-state.mjs ~/ai-workstation-team-pilot/.agent-console/console.sqlite`. With no path it reads `main`'s fixture and prints a **fake team** - that is **L-17 / P-D1**.

**The rig's task state has moved, and P-A3 cares about it.** Prompt 1 `WI_TC01` is now **`TODO`** with a `human_response_hold` on response 4, whose content is jd's own `Integer cents is fine`, saved from Telegram during V5 case 12. The item thread `awi1_63460787e23fa7d635890376` is **closed** (`item_link.closed_at` set) though `telegram_thread` 4 still reads `ACTIVE`, and message **85** is still pinned.

**P-A0 ran on 2026-09-27 and falsified the register's reading of that state.** The register said the detail page was showing a "Continue with saved answer" button one click from replacing jd's answer with a canned string and starting a run. Neither part holds:

- The hold makes `operationalState` report `AWAITING_RESPONSE` ([operationalState.ts:30](../../server/src/operationalState.ts#L30)), so the rig's banner reads **"Needs your input" / "Review and respond"**. The saved-answer label appears only where no answer is held.
- Pressing either button in that state is refused by the server: `respondToBlockedPrompt` takes only a stored `BLOCKED` prompt or one with a live pending question, so the POST returns **409**, the canned string is never stored, and `startRun` is never reached.

So the answer is safe on the rig, and the remaining defect is a **dead button** rather than a destructive one. The register's M-13 entry carries the reproduction, the struck-through claims and the evidence. **Still do not press it on the rig** - not because it is dangerous, but because the rig's state is the fixture for P-A3 and for V5 case 11's re-run.

## 2. State of the repository

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation`, clean. Read `git log -1`; this cell will be stale |
| vs `origin/main` | **428+ ahead, 0 behind.** `origin/main` is `4fd0e65`. **212 commits are on no remote ref at all** - the figure moves with every commit, so read it rather than quoting this cell: `git rev-list --count HEAD --not --remotes`, argument order as written |
| Ever pushed | **One branch, once**: `origin/feature/team-telegram-pilot` at `5018409`, 2026-09-18, an ancestor of `dc3e9de`, still on GitHub. It holds **no** burndown work. The blanket phrase "nothing has ever been pushed" is **wrong** and should stop being written |
| Worktrees / task branches | One worktree, the checkout itself. **Zero** `fix/*` or `tm/*` |
| **Full T1** | **142 of 142**, 28.4 minutes, re-run on main 2026-09-27 as the **Phase 1 gate**, with the live rig stopped by port for its duration. 142 is 140 plus P-A0's two rows. Owed again when product code changes |
| Server | **618 of 618**, 0 fail, re-run 2026-09-27 after P-A2 |
| Shared / Web | **91 of 91** / **95 of 95**, re-run 2026-09-27 after P-A3 |
| Typecheck | exit 0 across shared, server, web, e2e |
| Web lint | **19 problems, 17 errors**, exit 1. Upstream's files. **L-12, waived. Leave it** |
| `e2e` self-tests | **47 of 47**, measured 2026-09-27 by P-B4. Its own tier: **`npm run test:harness`**, about 4.5 minutes. Not in root `npm test` - it builds the web app, which would roughly triple that tier's time; jd's call |
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
`team.enabled` on in the rig, off by default in the repo. `team.handoverEnabled` is **on in both rig instances as of 2026-09-27**, written to each checkout's `.agent-console/settings.json` and read back from both, off by default in the repo.
Every task gets its own worker, branch and worktree, and lands by **fast-forward**. Commit messages imperative, **no co-author line**.

**Stop and ask jd**: before any push, on any audit FAIL, before changing a personal-control surface **A5** covers beyond what P-A3 already authorises, and before anything destructive to the live rig or the pilot remote.

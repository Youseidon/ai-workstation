# V6 handover: finishing V5 and the completion report

Written 2026-09-26, by the orchestrator, for the session that finishes this track.
This session closed **C5**, the last build task, reproduced **M-13**, and took **V5** from blocked to four of seven cases done against live Telegram.
Read this first, then [team-burndown-tracker.md](team-burndown-tracker.md) and [team-gap-register.md](team-gap-register.md).

[team-v5-handover.md](team-v5-handover.md), [team-v4-handover.md](team-v4-handover.md), [team-m9-handover.md](team-m9-handover.md) and [team-reconcile-handover.md](team-reconcile-handover.md) are **closed history**. Take no number from any of them without checking it here.

## 1. Where everything is

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation`, clean, tip `698dcef` |
| main vs `origin/main` | **404 ahead, 0 behind. Nothing has ever been pushed**; `git branch -r --contains HEAD` is empty |
| Worktrees / task branches | One worktree, the checkout itself. **Zero** `fix/*` or `tm/*` branches |
| **Full T1 suite** | **140 of 140**, 0 flaky, 26.4 minutes, run by the orchestrator on main |
| Server suite | 618 of 618 (C5 worker's run; **not** re-run by the orchestrator) |
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

- Team `awt1_h0XDkrOF02ItMy73`, supergroup `-1004359741812`, roster remote `https://github.com/psyba96/ai-workstation-team-pilot-workspace-20260918-d8c1` at `refs/aw/team` = `2475e47…`.
- Workspace tree shared by both instances at `/home/junaid/ai-workstation-team-workspace` (that is **B19**, a rig limit, not a product one).
- **Prompt 1 `WI_TC01` is `BLOCKED` with its question card already delivered** to chat `8973262519`, outbox row 3, both buttons live. That is the item cases 2, 3 and 11 run against.
- Start either instance with `env -u ANTHROPIC_API_KEY npm run dev:team-pilot` (B4).
- Backup of the pre-rebuild rig, and of September's roster ref, is at `/home/junaid/pilot-rig-backup-20260926/`.

## 3. V5: four of seven cases done

| Case | Result | Evidence |
| --- | --- | --- |
| 0a notifications and remote actions | **PASS** | both on via `PUT /api/settings`, persisted to `.agent-console/settings.json` |
| 0b task waiting on a question | **PASS** | run `run_2636609e` on `claude-sonnet-4-5`; prompt 1 `BLOCKED`; card posted unprompted, `kind: personal_question`, both buttons, options parsed |
| 1 roster on both sides | **PASS** | two people two bots on both instances; `refs/aw/team` moved `aa92159…` → `2475e47…`, so the GitHub round trip is real |
| 12 default-off regression | **PASS on the API half** | Team on: `200` / `405`. Team off: both `403 team_disabled`, `items` `403`. **The `405`→`403` is the assertion**: the gate sits in front of method routing. Personal control unaffected. **Still owed**: Team panels disappearing (browser) and the private chat behaving unchanged (phone) |
| **2 open the item thread** | **NOT RUN** | curl, orchestrator's to do. `POST /api/task-control/team/items {"promptId":1}` |
| **3 read-only views** | **NOT RUN** | **jd's phone.** From account B in the group, `/task` `/status` `/access` `/help`, each as a reply to the anchor |
| **11 close the thread** | **NOT RUN** | **jd's phone.** `/close` from B must be refused as owner-only; then `/close` from A |

Case 10 stays SKIPPED (B15). Cases 4 to 9 are **not** in V5's scope - V5 is cases 2, 3, 11 and 12 only.

**Record the rows in [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md)'s Progress table as a re-run**, without overwriting September's rows: audits 1 to 4 cite them.

**The clause is "LT-4's re-run rows are recorded", not that they pass.** A case recorded PARTIAL with a reason satisfies section 8; a blank does not.

## 4. What is left after V5

The completion report. Section 8 of [team-burndown-dev-brief.md](team-burndown-dev-brief.md) defines done, and **two of its five clauses cannot be reported as met**:

- **"Audit 3 and audit 4 pass"** - both FAILed. jd's written waivers satisfy the brief's *rule*, which offers waiver as an alternative to fixing, but they do not make the clause true.
- **"LT-4's re-run rows are recorded"** - true only once cases 2, 3 and 11 are recorded.

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

## 7. What this session learned that the next should not relearn

- **`pgrep -f "<pattern>"` matches the shell running it.** This cost two false "still running" readings and one `pkill` that killed its own shell mid-script. Check what matched before believing it, or match on a port instead.
- **The Team panel's setup instruction never clears.** `runtime.ts:501-507` emits it unconditionally whenever a teammate exists and never asks Telegram. Polling it loops forever.
- **Pairing and team codes live 10 minutes.** Do not mint one for an absent operator.
- **`roster_conflict` has a local cause as well as a remote one.** Clearing the remote ref is not enough; `.agent-console/team/remote.git` caches its own copy.
- **The check document's own explanations are stale**, though its steps are sound: case 0b cites `operationalState.ts:10` mapping `BLOCKED` to `AWAITING_RESPONSE`, which the reconcile moved. The behaviour is nonetheless correct because `promptsAwaitingResponse()` goes through the shared `awaitsResponse()` predicate, which accepts both spellings. **Verified, not assumed** - had it still compared by hand, no card would ever post.
- **A worker killed by a rate limit lost nothing**, for the second time, because commit-each-proof was in its card. Keep putting it there.
- **Verifying before recording keeps paying.** This session it caught an `api.telegram.org` claim that was wrong because the grep was scoped to the wrong directory - recorded as a correction rather than amended away.

## 8. Standing constraints

No push and no remote write **to `ai-workstation`**; nothing has ever been pushed. The roster push to the pilot repo is authorized and is a different repository.
No paid provider. **Live Telegram credentials are authorized** as of 2026-09-26.
Never two harness runs at once, and the live rig contends with the T1 harness.
`team.handoverEnabled` stays false; `team.enabled` is **on** in the rig by necessity and off by default in the repo.
Commit messages imperative, **no co-author line of any kind**.
Every task gets its own worker, branch and worktree, and lands by fast-forward.

**Stop and ask jd**: before any push, on any audit FAIL, before changing a personal-control surface A5 covers, and before anything destructive to the live rig or the pilot remote.

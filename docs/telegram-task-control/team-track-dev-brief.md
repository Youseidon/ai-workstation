# Dev brief: Team track TM0 to TM3

Written 2026-09-16 for the agent session that runs the build of the team features.
You are the **orchestrator**: you run 20 numbered tasks that build slices TM0, TM1, TM2 and TM3, each done by a fresh worker agent, and you merge, track and report.
You do not write product code yourself.
jd is the operator and reviewer; Yousef is jd's teammate and the second person in every team scenario.

jd authorizes this orchestrator, and only this orchestrator, to spawn one background worker agent per task and one auditor agent at each audit point.
No worker spawns agents.

## 0. Do not start until

- The four L1 defects in [engineering plan](engineering-plan.md) step 7a are fixed and committed: Telegram answers unlabelled in the task timeline, the capability badge claiming "Telegram configured" without a token, the "-0 AVAILABLE" header, and `npm run dev` no longer reloading.
  Check `git log` and `implementation.md`; if any is still open, stop and tell jd.
  The team track goes after them by jd's decision of 2026-09-16, because TM0 changes the harness ports and the fake Telegram.
  If those fixes added a migration, the team track's migration numbers move up accordingly.
- `git status` on main is clean, and no other session is running the harness on this machine.
- Record the starting commit of main and of `origin/main` in the tracker; the audits use them.

## 1. Read first

1. [teammate-design.md](teammate-design.md): the design of record. Sections 4, 5.1 to 5.3, 5.5, 6 and 7 hold the build detail. Section 5.4 (handover) is out of scope.
2. [engineering-plan.md section 3b](engineering-plan.md#3b-team-track-tm): slices, crucial scenarios and definition of done. Its ids (TM-T0-n, TM-T1-n) are the ones every task uses.
3. [engineering-standards.md](../engineering-standards.md): definition of ready and done.
4. The C1 entries in [implementation.md](implementation.md) and [l3-c1.md](../e2e-scenarios/l3-c1.md): item threads reuse C1's anchor, reply and tag mechanism.
5. [human-verification.md](human-verification.md): the row format for H-TM rows.

`teammate-design-proposal.md` and `teammate-design-review-notes.md` are history describing rejected designs; do not build from them.

## 2. Execution model

### 2.1 Roles

| Role | Context | Does | Never does |
| --- | --- | --- | --- |
| Orchestrator (you) | One session per slice. At each slice boundary jd starts a fresh session with this brief; the tracker is the only state carried over. | Composes each task card, spawns the worker, verifies the report, merges, updates the tracker, asks jd at stop points, runs the audits. | Writes product or test code, pushes, runs two harness tasks at once. |
| Worker | A fresh background agent per task, in its own git worktree (`isolation: "worktree"`), started with only its task card. | Exactly one task: builds, tests, commits on its task branch, reports. | Merges to main, pushes, starts another task, spawns agents, contacts jd or Yousef, edits the tracker. |
| Auditor | A fresh background agent at task 10 and task 20, read-only except for its audit report. | The checklist in section 4. | Fixes what it finds. |

### 2.2 One task, start to finish

1. **Card.** Build the worker's prompt from the template in 2.4 and the task's row in section 3. The card is self-contained: the worker has no memory of earlier tasks.
2. **Spawn.** One worker, in the background, in a new worktree, on branch `tm/<task id>-<slug>` created from the current tip of main. Mark the task `in progress` in the tracker with the worker's agent id.
3. **Wait.** Do not poll. The worker's completion notification wakes you. If the worker reports it is blocked on jd, go to 2.3.
4. **Verify.** Check the report against every acceptance criterion of the task. Re-run on the task branch the cheap checks the report cites (typecheck, lint, the T0 tests named by the task, the task's T1 scenarios). If anything fails or is missing, send the worker back with `SendMessage` naming exactly what is missing; do not fix it yourself.
5. **Merge.** Main must be green and linear:
   - The branch is rebased onto main by the worker before reporting; confirm with `git merge-base --is-ancestor main <branch>`.
   - `git merge --ff-only <branch>` on main. No merge commits, no squashing that loses the worker's commit messages.
   - Remove the worktree and delete the branch.
   - Never push.
6. **Track.** Update the task's tracker row (status `done`, merged commit range, evidence summary) and commit the tracker on main by itself.
7. **Next.** Harness tasks run strictly one at a time, because every worktree shares the harness ports. A documentation-only task that runs no harness may run in parallel with another task.

### 2.3 Stop points and blocking

- A task marked **jd** in section 3 cannot finish without jd. Ask jd once, with exactly what is needed, and send a push notification if jd may be away. Set the task to `blocked: jd` meanwhile.
- A worker never asks jd itself. It reports `BLOCKED` with the question, and you ask.
- If a real check disproves a design fact, stop the track, record the finding in the tracker, and ask jd before any worker changes the design, the plan or the fake.
- A task that fails verification twice is set to `blocked: review` and brought to jd rather than retried a third time.

### 2.4 Worker card template

```text
You are a worker on the Team track, task <id>: <title>.
Repository: /home/junaid/ai-workstation, in your own worktree on branch tm/<id>-<slug>, created from main at <sha>.

Goal: <one sentence from the task row>.
Acceptance criteria (all must hold, each with evidence in your report):
<numbered list from the task row>

Read before starting: docs/telegram-task-control/team-track-dev-brief.md sections 5 and 6, plus <the design and plan sections named in the task row>.

Rules:
- Only this task. If it needs something outside it, stop and report BLOCKED.
- Install with `npx -y npm@11 install` in your worktree. Server tests need an isolated AGENT_CONSOLE_REPO_ROOT.
- Commit on your branch in small commits with imperative messages. No co-author line. A small unrelated fix goes in its own commit and is listed in your report.
- Before reporting: rebase onto main, rerun the checks, and make sure `git status` is clean.
- Never push, never merge to main, never spawn agents, never contact anyone.

Report, in this exact shape:
STATUS: DONE | BLOCKED | FAILED
BRANCH and COMMITS: <branch>, <sha list with messages>
FILES CHANGED: <list>
ACCEPTANCE CRITERIA: for each: the criterion, PASS or FAIL, the command run and its result line
TESTS: T0 count, T1 count, burn-in result where required
DEVIATIONS: anything done differently from the card or the design, and why
QUESTIONS FOR JD: only if BLOCKED
```

### 2.5 The tracker

`docs/telegram-task-control/team-track-tracker.md`, created by the orchestrator before task 1.
It holds the starting commits of main and `origin/main`, then one row per task: id, slice, status, worker agent id, branch, merged commits, evidence summary, date.
It is the orchestrator's memory across fresh sessions and the auditor's primary evidence, so it is updated and committed after every task.

## 3. Tasks

Every task also carries the standing criteria: typecheck and lint clean, no test that passed before now fails, `team.enabled` still off by default, and the token sweep still passes.

### TM0 Harness

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| T01 | LT-1 script: two bots in one group (design 8.4). | Script committed under `e2e/scripts/`; run against real Telegram; results recorded as row H-TM-LT1 in `human-verification.md`; each assumption in design 4.4 marked confirmed or disproved. | **jd**: a second throwaway bot, its token put by jd in `~/.config/ai-workstation/e2e-live.env` (never in chat), and a group containing both bots. |
| T02 | TM0 scenario table. | `docs/e2e-scenarios/tm0.md` committed with harness self-test scenarios, including the delivery rules T01 recorded. No product code in the commit. | **jd**: skim. |
| T03 | Two environments side by side. | Port offsets let two app environments run at once; a harness helper starts both against one shared fake Telegram and one bare repository per test; its self-test passes; the full existing T1 suite passes unchanged. | |
| T04 | Group features in the fake. | The fake supports a second bot and second user, group membership and administrator rights (`getChatMember`), pinning, `createChatInviteLink` and joining by it, and privacy-mode delivery exactly as T01 recorded; `network.cutGit()` per environment; fake contract tests pass. | |

### TM1 Team and roster

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| T05 | LG-1 script: repository refs (design 8.4). | Script committed; run against the repository jd named; results recorded as row H-TM-LG1. **If a non-fast-forward push to `refs/aw/*` is accepted, the track stops here** and jd decides the fallback. | **jd**: which repository, and an explicit OK to push test refs to it. |
| T06 | TM1 scenario table, and the four defaults. | `docs/e2e-scenarios/tm1.md` committed; jd's answer on the four defaults in design section 10 item 2 recorded in `implementation.md`. | **jd**: skim and the defaults. |
| T07 | Migration 24 and the roster model. | Migration 24 adds `team_roster` and the group actor sentinel with its unique index; the join code encoder and decoder; the `refs/aw/team` read and compare-and-swap write. TM-T0-3, TM-T0-4 and the migration 24 case of TM-T0-5 pass. | |
| T08 | Create team. | The Agents page Create team flow; the workstation observes `/team <code>` in the group, checks administrator rights, confirms locally and pushes the roster; group actors created, never enrolled for personal notifications. Covered by server tests and by the harness setup that TM-T1-1 uses. | |
| T09 | Join team. | The Agents page Join team flow with a code carrying no credential; the remote check; the roster push; the "ask jd to add your bot" step on both panels; the one-member invite link. TM-T1-1 passes with burn-in at 3 repeats; UI checked at both widths. | |
| T10 | TM1 close-out. | `implementation.md` entry with exact commands and counts for TM0 and TM1; H-TM rows present; tracker complete. LT-3 is scheduled with jd and Yousef or recorded. Then **run audit 1** (section 4) before T11. | **jd**: LT-3 with Yousef. |

### TM2 Item threads

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| T11 | TM2 scenario table. | `docs/e2e-scenarios/tm2.md` committed. | **jd**: skim. |
| T12 | Migration 25 and item ids. | `telegram_thread` rebuilt to allow `item` with rows and indexes preserved and C1 threads unchanged; `item_link`; item id minting; group tags built from the item id. The migration 25 case of TM-T0-5 passes. | |
| T13 | Anchors and read-only views. | Item anchor posted, pinned, edited in place, unpinned at completion and recreated after ANCHOR_GONE; `team` summary audience hides quota and local paths; `/task`, `/status`, `/access` and `/help` answer from the owning workstation. TM-T1-6 passes. | |
| T14 | Group routing rules. | Owner answers, other workstation silent, addressed-to-another ignored, unknown item answered once by the typer's own workstation, anchor discussion dropped, no "That message is not a task question" in the group. TM-T0-1, TM-T1-2 and TM-T1-3 pass. | |
| T15 | Starting a thread on the other person's item. | Request card from the requester's bot; anchor only after the owner confirms; nothing shared before. TM-T1-7 passes. | |
| T16 | TM2 close-out. | Full T1 suite passes; burn-in of TM2's new T1 rows at 3 repeats; `implementation.md` entry; tracker complete. | |

### TM3 Grants

| Id | Task | Acceptance criteria | jd |
| --- | --- | --- | --- |
| T17 | TM3 scenario table. | `docs/e2e-scenarios/tm3.md` committed. | **jd**: skim. |
| T18 | Migration 26 and the grant model. | `task_control_action` rebuilt with the widened check, rows and indexes preserved; `item_grant`; grant evaluation. TM-T0-2 and the migration 26 case of TM-T0-5 pass, including pre-upgrade cards answering and resuming exactly once. | |
| T19 | Grant cards and granted commands. | Grant and revoke cards, the access message edited in place, `/context`, `/answer` and `/resume` checked at tap time, teammate removal ending actors and grants. TM-T1-4 and TM-T1-5 pass. | |
| T20 | TM3 close-out. | Full T1 suite passes; burn-in of TM3's new T1 rows at 3 repeats; LT-4 recorded as an H-TM row; `implementation.md` says R-B is ready to enable. Then **run audit 2** (section 4). | **jd**: LT-4 with Yousef. |

TM4 (handover) is not part of this brief.

## 4. Audits

Audit 1 runs after T10 and must pass before T11 starts.
Audit 2 runs after T20 over T11 to T20 and closes the brief.
Each audit is a fresh auditor agent with no part in the build, given this section, the task range and the tracker.
It writes `docs/telegram-task-control/team-track-audit-<n>.md` with PASS or FAIL and the evidence for every check, and the orchestrator commits it.

### 4.1 Discipline

| # | Check | Evidence |
| --- | --- | --- |
| D1 | Every task in the range has its own worker agent id, and no id repeats: each task ran in a fresh context. | Tracker |
| D2 | Every task landed from its own `tm/<id>-*` branch by fast-forward; main's history over the range is linear with no merge commits. | `git log --merges <start>..main` is empty |
| D3 | Nothing was pushed: `origin/main` is still the starting commit recorded in the tracker. | `git rev-parse origin/main` |
| D4 | Each task's commits touch only what its card covers; unrelated fixes are separate commits and listed in the report. | `git show --stat` per commit against the task row |
| D5 | Commit messages are imperative and carry no co-author line. | `git log --format=%B <start>..main` |
| D6 | No task worktree or `tm/*` branch is left behind. | `git worktree list`, `git branch --list 'tm/*'` |
| D7 | Each slice's scenario table was committed, and jd's skim recorded, before that slice's first product code commit. | Commit order and tracker |
| D8 | Every stop point marked **jd** has jd's answer recorded; no worker contacted jd or Yousef or spawned an agent. | Tracker and reports |
| D9 | The tracker agrees with git: every `done` row names commits that exist on main, and every commit on main in the range belongs to a row, apart from the orchestrator's own tracker and audit commits. | Tracker against `git log` |

### 4.2 Acceptance criteria

| # | Check | Evidence |
| --- | --- | --- |
| A1 | Every acceptance criterion of every task in the range is re-verified on main by the auditor, not taken from the worker's report. | Commands rerun, with result lines |
| A2 | Typecheck, lint, the full server suite and the full T1 suite pass on main at the end of the range. | Counts |
| A3 | Burn-in at 3 repeats passes for every T1 scenario the range added. | Burn-in output |
| A4 | Real checks due in the range are recorded as H-TM rows with date and outcome (audit 1: LT-1, LG-1 and LT-3 or its scheduled date; audit 2: LT-4). | `human-verification.md` |
| A5 | Invariants of section 5 hold: personal control unchanged, no token in the database, logs, API responses or repository, `team.enabled` off by default. | Token sweep, full T1, settings default |
| A6 | `implementation.md` has an entry per slice in the range with exact commands and counts that match A2 and A3. | `implementation.md` |
| A7 | Any design fact a real check disproved is corrected in the design, the plan and the fake, with jd's approval recorded. | Diffs and tracker |

A FAIL blocks the next task until it is fixed by a new task with its own worker, or jd waives it in writing in the tracker.
The orchestrator reports the audit result to jd either way.

## 5. Invariants no task may break

- Personal control (L1 and L3) behaves exactly as before, with `team.enabled` on or off. The full T1 suite is the proof.
- No Telegram token is ever shared, sent, logged, stored in the database, returned by an API or committed. Each person's token stays in their own `.env`.
- Every state change is an action reference with a receipt and a revision check, applied on the workstation that owns the item. A slash command that changes state only renders a card; the tap is the action.
- In the team group: only the owning workstation answers, a command addressed to another bot is ignored, an unknown item gets one error from the typer's own workstation, and "That message is not a task question" is never sent.
- Group actors are never enrolled for personal notifications.
- Forum topics are not used. Item threads are C1's anchor and replies.
- Each slice owns its migration, and a table rebuild preserves every row and index.

## 6. Known traps

- **SQLite NULLs in unique indexes.** `task_control_actor` is unique on `(transport, transport_user_id, chat_id, topic_id)`; NULLs are distinct, so group actors need the sentinel `topic_id`.
- **CHECK constraints.** `telegram_thread.subject_kind` and `task_control_action.action` both have one, so widening either means a table rebuild.
- **Tags.** C1's tag is built from the local task id, which differs between the two machines; team tags come from the item id.
- **Message ids.** A Bot API message id and a GramJS client message id are only equal on the fake. The C1 live spec failed on this (commit 0f820c4); compare in the right id space.
- **Bots cannot add bots.** Adding Yousef's bot to the group is jd's manual step; do not automate it.
- **Administrator delivery.** LT-1 recorded that administrator bots receive group commands, replies to either bot's messages and unanchored discussion even when `getMe.can_read_all_group_messages` is false. Fake Telegram must model that broad delivery; team routing correctness comes from ownership filters and quiet drops, not privacy mode.
- **Harness hygiene.** Never edit `server/src` or `e2e/src` while a harness run is in flight. Copy real-provider event logs out of `e2e/test-results` before a new Playwright run, because it clears the directory. A T3 run re-records `e2e/contracts/telegram-bot-api.json`; restore it with `git checkout` if the shapes did not change.
- **Skipped live evidence.** On A2 and C1 the building agents did not write the live part and it had to be added afterwards. A task whose criteria include a real check is not done without it.

## 7. Done means

Audit 2 passes, R-B is ready to enable per `implementation.md`, and the orchestrator reports to jd: the commits per slice, test counts per tier, burn-in results, real checks and outcomes, both audit results, design corrections made, and anything left open.

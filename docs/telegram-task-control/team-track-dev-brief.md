# Dev brief: Team track TM0 to TM3

Written 2026-09-16 for a development agent building the team features.
You build slices TM0, TM1, TM2 and TM3 of the Team track, in that order, and nothing else.
jd is the operator and reviewer; Yousef is jd's teammate and the second person in every team scenario.

## 0. Do not start until

- The four L1 defects in [engineering plan](engineering-plan.md) step 7a are fixed and committed: Telegram answers unlabelled in the task timeline, the capability badge claiming "Telegram configured" without a token, the "-0 AVAILABLE" header, and `npm run dev` no longer reloading.
  Check `git log` and `implementation.md`; if any is still open, stop and tell jd.
  The team track goes after them by jd's decision of 2026-09-16, because TM0 changes the harness ports and the fake Telegram that those fixes also use.
- No other session is running the harness on this checkout.
  If one is, work in your own git worktree or wait.

## 1. Read first, in this order

1. [teammate-design.md](teammate-design.md): the design of record. Sections 4, 5.1 to 5.3, 5.5, 6 and 7 are the build detail. Section 5.4 (handover) is out of scope for you.
2. [engineering-plan.md section 3b](engineering-plan.md#3b-team-track-tm): the slices, the crucial scenarios and the definition of done. Its scenario ids (TM-T0-n, TM-T1-n) are the ones you use.
3. [engineering-standards.md](../engineering-standards.md): definition of ready and done, which this brief does not repeat.
4. The C1 entries in [implementation.md](implementation.md) and [l3-c1.md](../e2e-scenarios/l3-c1.md): item threads reuse C1's anchor, reply and tag mechanism, so read how it was built and tested.
5. [human-verification.md](human-verification.md): the row format for the H-TM rows you add.

Do not read `teammate-design-proposal.md` or `teammate-design-review-notes.md` for build detail.
They are history and describe rejected designs (a shared bot, a relay, forum topics).

## 2. The loop for every slice

1. **Test design, then stop.**
   Write the slice's scenario table in `docs/e2e-scenarios/tm<N>.md`, starting from the section 3b scenarios for that slice, with the given, when and then of each and its tier.
   Commit it and stop for jd's skim.
   Do not write product code before jd answers.
2. **Build default-off.**
   Everything sits behind `team.enabled`, which is off by default.
3. **Test.**
   The slice's T0 scenarios in the server suite, its T1 scenarios in the harness, and burn-in of the new T1 rows at 3 repeats.
   After TM2 and after TM3, run the full T1 suite (`cd e2e && npm run e2e`), because those slices touch the outbox, actor lookup and thread registry that L1 and L3 use.
4. **Real check.**
   A slice with a real check in section 3b is not done until that check is recorded.
   On A2 and C1 the building agents skipped the live part and it had to be added afterwards; do not repeat that.
5. **Record.**
   An `implementation.md` entry with exact commands and counts, and H-TM rows in `human-verification.md` for the real checks.
6. **Commit** on main with its tests.
   Never push.
   Do not add an agent co-author line.
   A small unrelated fix you notice goes in its own commit; anything larger is flagged to jd, not bundled.

## 3. Slice order and the points where you need jd

| Step | You do | You need from jd |
| --- | --- | --- |
| Before TM0 | Script LT-1 (design section 8.4): two bots in one group, record what each receives. If the result differs from design section 4.4, correct 4.4, the plan and the fake, and tell jd what changed. | A second throwaway bot, whose token jd puts in `~/.config/ai-workstation/e2e-live.env` himself (never ask for a token in chat), and a group with both bots in it. |
| TM0 | Harness: two environments on offset ports, one fake Telegram with two bots, one bare repository per test, group rights, invite links, the privacy-mode delivery rules LT-1 recorded, `network.cutGit()` per environment. | Skim of `tm0.md`. |
| Before TM1 | Script LG-1: push, fetch and compare-and-swap `refs/aw/*`, attempt a non-fast-forward push, push an `aw/handover/*` branch. | The repository to use and an explicit OK to push test refs to it. |
| Before TM1 | Nothing. | Confirmation of the four defaults in design section 10, item 2, or "take as proposed". |
| TM1 | Team and roster, per plan section 3b. | Skim of `tm1.md`; then LT-3, which needs Yousef, scheduled by jd. |
| TM2 | Item threads and the group routing rules. | Skim of `tm2.md`. |
| TM3 | Grants and migration 24. | Skim of `tm3.md`; then LT-4 with Yousef on both phones. |

**If LG-1 shows GitHub accepts a non-fast-forward push to `refs/aw/*`, stop.**
The fallback is ordinary branches for the roster and control record, which is a different implementation, and jd decides it.

## 4. Invariants you must not break

- Personal control (L1 and L3) behaves exactly as before, with `team.enabled` on or off. The full T1 suite is the proof.
- No Telegram token is ever shared, sent, logged, stored in the database or returned by an API. Each person's token stays in their own `.env`.
- Every state change is an action reference with a receipt and a revision check, applied on the workstation that owns the item. A slash command that changes state only renders a card; the tap is the action.
- In the team group: only the owning workstation answers, a command addressed to another bot is ignored, an unknown item gets one error from the typer's own workstation, and "That message is not a task question" is never sent.
- Group actors are never enrolled for personal notifications.
- Forum topics are not used. Item threads are C1's anchor and replies.
- Migration 24 rebuilds `task_control_action` to widen its CHECK, preserving every row and index, and pre-upgrade cards still answer and resume exactly once.

## 5. Known traps

- **SQLite NULLs in unique indexes.** `task_control_actor` is unique on `(transport, transport_user_id, chat_id, topic_id)`; NULLs are distinct, so group actors need a sentinel `topic_id`.
- **Tags.** C1's tag is built from the local task id, which differs between the two machines. Team tags come from the team-wide item id.
- **Message ids.** A Bot API message id and a GramJS client message id are only equal on the fake. The C1 live spec failed on this (commit 0f820c4); compare in the right id space.
- **Bots cannot add bots.** Adding Yousef's bot to the group is a manual step for jd; do not try to automate it.
- **Privacy mode.** A reply to a bot's own message is delivered even in privacy mode, so anchor discussion reaches the owner's bot and must be dropped quietly.
- **Harness hygiene.** Install packages with `npx -y npm@11 install`. Server tests need an isolated `AGENT_CONSOLE_REPO_ROOT`. Never edit `server/src` or `e2e/src` while a harness run is in flight. Copy real-provider event logs out of `e2e/test-results` before any new Playwright run, because it clears the directory. A T3 run re-records `e2e/contracts/telegram-bot-api.json`; restore it with `git checkout` if the shapes did not change.

## 6. Stop and ask jd when

- The design and the code disagree, or a real check disproves a design fact.
- A change would widen scope beyond the slice, or touch TM4 (handover).
- An action reaches outside this machine: pushing to GitHub, creating bots, messaging Yousef or anyone else.
- You would start another agent or thread. jd asks for those explicitly.

## 7. Done means

TM3 is committed with its tests, the full T1 suite passes, LT-3 and LT-4 are recorded as H-TM rows, and `implementation.md` says R-B is ready to enable.
Report to jd with: the commits, test counts per tier, burn-in results, the real checks and their outcomes, any design corrections made, and anything left open.

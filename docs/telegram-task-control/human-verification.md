# M1/M2 human verification checklist

Scope: M1 personal task-control foundation and M2 local execution
safety/quota advisor, including its M2b/M2c/M2d hardening continuations
(local task-control robustness, local start-unknown recovery UX and local
START_UNKNOWN operator classification), all with fake services only. Do not
use a live Telegram bot, private Git remote, paid/provider execution,
teammate subscription delegation or automatic quota actions for these checks.

Numbering note: M2b, M2c and M2d were previously labelled M3, M4 and M5 in
this file. That collided with the engineering plan's own formal M3
("Checkpoint and Shared Control Storage"), M4 ("Named Teammate Claim and
Receiver Execution") and M5 ("Shared Questions, Return, Apply and Further
Handoff"), none of which exist in this codebase. M2b/M2c/M2d are local
hardening slices within formal M2's scope only; see `implementation.md` for
the full explanation. Formal M3, M4 and M5 have no rows here because they are
unimplemented, not because they were skipped in this checklist.

Note: M2c (local start-unknown recovery UX, the read-only warning surface)
has no rows in this checklist; it was recorded only in `implementation.md`.
That gap predates this update and is not backfilled here to avoid claiming
human verification that was never actually recorded.

Expected commit topics:

- fake Telegram task-control foundation;
- settings-backed task-control capability and fake Telegram adapter;
- M1 fake-service completion with pairing, sanitized rendering, adapter callback
  dispatch, fake E2E coverage and this checklist.
- M2 durable start-intent ownership, restart reconciliation and advisory quota
  warnings.
- M2b fake Telegram quota-warning invariants, Agents quota-warning UI checks
  and stronger ownership/recovery edge-case coverage.
- M2d local START_UNKNOWN operator classification (known stopped/no spawn),
  classification API/UI and task-control setup status badge.

## Preconditions

- Work from a clean checkout.
- Do not place live bot tokens, provider credentials or private remote URLs in
  settings or docs.
- Prefer an isolated copy without `.agent-console` for mutation checks:
  `rsync -a --exclude .git --exclude .agent-console --exclude node_modules ./ /tmp/aw-m1-human-check/`

## Reviewer test cases

Automated status reflects the isolated verification run recorded in
`implementation.md` on 2026-09-13. Human status reflects Junaid's M1
fake-service verification sign-off on 2026-09-13.

| ID | Case | Steps | Expected result | Automated status | Human status |
| --- | --- | --- | --- | --- | --- |
| H-M1-01 | Default-off capability | Start the server or inspect `TaskControlService.capability()` with default settings. | Capability reports disabled/default-off and G01-G04 remain blocked. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-02 | Settings are visible | Open Agents settings and inspect Task Control, or inspect `server/src/settings.ts` and `web/components/agents/AgentsView.tsx`. | Task Control has enablement, notifications, remote actions, transport and bot ID fields; defaults do not enable remote actions. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-03 | Fake pairing | Run `server/src/taskControl.test.ts`. | Pairing is single-use, expires and rejects wrong chat/topic. Usernames are not authority. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-04 | Fake question render | Run `server/src/taskControl.test.ts`. | Rendered phone payload redacts localhost URLs and secret-like values; no raw run IDs or transcript dumps are included. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-05 | Durable fake outbox | Run `server/src/telegramAdapter.test.ts`. | Send failure is recorded, retry can mark the same outbox item sent, and no task state changes merely because send failed. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-06 | Durable fake inbox | Run `server/src/telegramAdapter.test.ts`. | Updates are stored before the cursor advances; duplicate updates are ignored by primary key. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-07 | Fake E2E Save then Resume | Run `server/src/telegramAdapter.test.ts`. | Fake adapter posts a question, processes callback updates, saves an answer, reissues current actions and resumes exactly once. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-08 | Wrong actor/bot/topic | Run `server/src/taskControl.test.ts`. | Wrong actor, bot and topic are rejected with durable receipts and no task mutation. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-09 | Stale revision | Run `server/src/taskControl.test.ts`. | A changed task/question rejects the old action; no answer is saved. | PASS | PASS - Junaid, 2026-09-13 |
| H-M1-10 | Disabled remote actions | Run `server/src/taskControl.test.ts`. | Remote callbacks are rejected while remote controls are disabled. Local Stop remains outside this feature. | PASS | PASS - Junaid, 2026-09-13 |
| H-M2-01 | Durable effective-directory reservation | Run `server/src/startIntent.test.ts`. | Aliased workspace paths produce exactly one active `workspace_start_intent`; the competing start is rejected. | PASS | Pending |
| H-M2-02 | Reservation before provider discovery | Run `server/src/runService.test.ts`. | Source-order regression confirms `reserveStartIntent` precedes awaited provider discovery. | PASS | Pending |
| H-M2-03 | Restart unknown ownership | Run `server/src/startIntent.test.ts`. | Start-after-spawn and unreleased start-intent rows classify as `START_UNKNOWN` and stay unreleased. | PASS | Pending |
| H-M2-04 | Fake Telegram start-path ownership | Run `server/src/startIntent.test.ts`. | Fake Telegram Answer and resume saves the answer but reports resume failure when another durable owner holds the workspace. | PASS | Pending |
| H-M2-05 | Advisory quota warning | Run `server/src/quotaAdvisor.test.ts`. | Fresh 5% remaining usage emits one warning with choices and dedupe; stale/unavailable/missing/above-threshold inputs do not warn. | PASS | Pending |
| H-M2b-01 | Agents quota warning UI | Run `npm run test:quota-ui --workspace web`. | Healthy quota renders no warning; fresh 5% warning renders; missing/unavailable usage does not warn; duplicate warning identities dedupe; choices are display-only text; warning markup has narrow/wide overflow guards. | PASS | Pending |
| H-M2b-02 | Fake Telegram quota warning | Run `server/src/taskControl.test.ts`. | Warning payload is sanitized, queued in fake outbox only, creates no callback action and does not mutate task/run/pipeline state on queue or delivery. | PASS | Pending |
| H-M2b-03 | Ownership classification edges | Run `server/src/startIntent.test.ts`. | Start-before-spawn and start-after-spawn remain `START_UNKNOWN`; known no-spawn and known stopped release ownership; recovery refuses `START_UNKNOWN` and succeeds only after explicit known-stopped classification. | PASS | Pending |
| H-M2b-04 | START_UNKNOWN UI gate | Inspect `implementation.md` M2b remaining gates. | No blind release UI was invented; future UI must say ownership is unknown and require provider process confirmation before recovery. | PASS | Pending |
| H-M2d-01 | Operator classifies known stopped | Run `server/src/startIntent.test.ts`. | Classification API records the confirmed classification, releases the start intent as `KNOWN_STOPPED` and writes an audited `prompt_status_event`; recovery then succeeds. | PASS | Pending |
| H-M2d-02 | Stale/active classification refused | Run `server/src/startIntent.test.ts`. | A stale `expectedStartIntentId` is rejected with `start_intent_changed`; classification is refused while the run is still active in memory (`run_active`). | PASS | Pending |
| H-M2d-03 | Known no-spawn unblocks recovery | Run `server/src/startIntent.test.ts`. | After a `known_no_spawn` classification, `recoverPrompt` succeeds where it previously refused with `start_unknown`. | PASS | Pending |
| H-M2d-04 | Classification UI controls | Run `npm run test:quota-ui --workspace web`. | ContextPicker and Tasks work-item detail show "Mark known stopped"/"Mark no spawn" next to the existing START_UNKNOWN warning, behind a confirm dialog; no blind release action is offered. | PASS | Pending |
| H-M2d-05 | Task Control setup status | Run `server/src/taskControl.test.ts`. | Capability response exposes `setup` (`disabled`/`fake_only`/`telegram_configured`) without leaking bot token/chat identifiers; Agents settings render it as a badge/reason string. | PASS | Pending |
| H-M2d-06 | No regression across server suite | Run `npm test --workspace server`. | All server test files pass (141 tests), confirming the `workspaces.ts` recovery-detection query change did not affect unrelated suites. | PASS | Pending |

## Command evidence

Human UI evidence:

- Junaid confirmed `http://localhost:3011/agents` shows the Task Control section
  with Enable task control, Notifications, Remote actions, Transport and Bot ID
  controls.
- Junaid confirmed all M1 human verification cases pass for the local
  fake-service scope.
- Runtime was corrected by running the backend with `ALLOWED_ORIGINS` including
  `http://localhost:3011` and `http://127.0.0.1:3011`; WebSocket acceptance from
  `http://localhost:3011` was verified locally.

Use an isolated copy for DB-backed tests where possible:

```bash
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2-test node --import tsx --test --test-concurrency=1 server/src/runService.test.ts server/src/startIntent.test.ts server/src/quotaAdvisor.test.ts server/src/consult.test.ts
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2-full npm test --workspace server
node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts server/src/telegramAdapter.test.ts server/src/humanInput.test.ts
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2b-server node --import tsx --test --test-concurrency=1 server/src/quotaAdvisor.test.ts server/src/taskControl.test.ts server/src/startIntent.test.ts
npm run test:quota-ui --workspace web
npm run typecheck --workspace shared
npm run typecheck --workspace server
npm run typecheck --workspace web
npm run lint --workspace web -- lib/providerUsage.ts components/agents/usage.tsx components/agents/usage.test.tsx
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2d-verify node --import tsx --test --test-concurrency=1 server/src/humanInput.test.ts server/src/pipelineScheduler.test.ts server/src/operationalState.test.ts server/src/taskControl.test.ts server/src/startIntent.test.ts
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2d-full npm test --workspace server
npm run test:quota-ui --workspace web
npm run typecheck --workspace shared
npm run typecheck --workspace server
npm run typecheck --workspace web
npm run lint --workspace web -- app/page.tsx components/ContextPicker.tsx components/agents/AgentsView.tsx components/recovery.test.tsx components/tasks/TasksView.tsx components/tasks/WorkItemDetail.tsx
```

Known blockers outside M1/M2 (including M2b/M2c/M2d) fake/local behavior:

- `npm run lint --workspace web` currently fails on pre-existing React lint
  findings outside the M1/M2 touched-file slice.
- `npm run build --workspace web` is blocked in this environment by Next/Turbopack
  build issues recorded in `implementation.md`.
- No system Chromium/Chrome binary is available in this environment. M2b uses a
  scripted React-render UI check for the passive Agents quota warning surface;
  a future browser harness should add visual screenshot checks.
- `START_UNKNOWN` has no existing UI data path/pattern before M2d. M2b documents
  this as a remaining UI gate rather than adding blind release/recovery
  controls; M2d adds the classification controls but is still local-only, as
  its rows above record.
- The engineering plan's formal M3, M4 and M5 milestones remain entirely
  unimplemented (no package/manifest capture, no shared Git control storage,
  no named teammate claim/receiver execution, no shared questions/apply/
  further-handoff). Nothing in this checklist is evidence toward them.

## Stop conditions

Stop verification and report blocked if a check requires any of the following:

- live Telegram Bot API calls or a real bot token;
- Git remote fetch/push or protected-ref policy evidence;
- provider subscription delegation, paid/API execution or real LLM execution;
- automatic pause, provider switch, spending, teammate delegation or takeover
  from a quota warning;
- credential/secret isolation certification;
- enterprise governance, retention or data-audience approval.

M1/M2 (including M2b/M2c/M2d) are verified only for local fake-service
personal task control, local execution ownership, advisory quota warnings and
local START_UNKNOWN operator classification. This is not evidence that live
Telegram setup, teammate takeover, shared Git transfer or production
delegation is ready, and it is not evidence toward the plan's formal M3, M4
or M5 milestones, which remain unimplemented.

## L1 live personal Telegram checklist

Scope: milestone L1 (RTC-17 to RTC-20), one operator and their own bot, in a private chat.
The M1/M2 stop conditions above do not apply to this section: L1 deliberately uses the live Bot API and real local agent runs.
Teammate transfer, group topics and Git transfer remain out of scope and gated by G01-G03.

### L1 preconditions

- `TELEGRAM_BOT_TOKEN` is set in the repository root `.env` (gitignored), and the server was restarted after setting it.
- Agents page: Enable task control, Notifications and Remote actions are on, Transport is Telegram, and all four changes are saved.
- The Live Telegram panel shows connected, and the operator's phone is paired through Pair a phone with local confirmation.
- Use a throwaway workspace for any case that resumes work, because resume starts a real provider run.
- Claude and Codex both work for saved-task cases with Host access off; Claude reports through typed progress tools (implementation.md, tenth slice).
- Do not edit files under `server/src` while a live case is running: `npm run dev` restarts the server on change and interrupts in-flight runs.
- Do not record bot usernames, chat or user IDs, or tokens in this file.

### L1 test cases

Automated status refers to `server/src/telegramBotApi.test.ts` and `server/src/telegramLiveRuntime.test.ts`, which drive the real HTTP client and runtime against a stubbed Bot API at the fetch layer, and to the harness scenarios named in the Harness scenario column ([`docs/e2e-scenarios/l1.md`](../e2e-scenarios/l1.md)).
T1 runs a scenario on the fake Telegram; T3 runs the same scenario on the dedicated test bot through `npm run e2e:live` ([setup](../e2e-live-setup.md)).
Live status refers to the operator's own bot and phone against the real app and database.
Evidence rule approved 2026-09-14, for rows not yet passed: a real-Telegram run of the end-to-end harness (tier T3 in [`docs/e2e-harness-plan.md`](../e2e-harness-plan.md): a dedicated test bot, an automated client on the operator's account, an isolated app) plus the operator's phone look check also satisfies Live.
A fake-Telegram harness run (T1) counts as Automated only.

| ID | Case | Steps | Expected result | Harness scenario (tier) | Automated status | Live status |
| --- | --- | --- | --- | --- | --- | --- |
| H-L1-01 | Default-off, no network | Run with task control disabled, with the Fake Telegram transport, and with no token. | No Bot API call is made; the panel shows off or no token; pairing is refused. | S-L1-01 (T1) | PASS | Pending |
| H-L1-02 | Token isolation | Inspect logs, `/api/task-control/*`, `/api/settings` and a full database dump. | The token appears nowhere; it is removed from `process.env` at boot so agent processes do not inherit it. | S-L1-28 (T1, T3) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS for a stubbed-Telegram run of the real app, 2026-09-14; a sweep after real-bot use is H-L1-17; live satisfied 2026-09-16 by T3 plus the phone look check |
| H-L1-03 | Connect and long poll | Start the server with the token and live settings. | The panel shows connected with the bot identity; polling uses a 25s window. | S-L1-02 (T1, T3); S-L1-30 (T1) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-14, after the connect-timeout fix in known issues; live satisfied 2026-09-16 by T3 plus the phone look check |
| H-L1-04 | Pairing with local confirmation | Pair a phone, send `/start <code>` from the private chat, confirm in the local panel. | The observed Telegram identity is shown before confirmation; the bot confirms pairing; a wrong code gets no reply; a group chat is refused. | S-L1-03 (T1, T3); S-L1-04, S-L1-30 (T1) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-14 (happy path only); live satisfied 2026-09-16 by T3 plus the phone look check |
| H-L1-05 | Human-in-the-loop to completion | Start a saved task whose agent must block on an owner decision; reply to the phone card; tap Answer and resume. | The task blocks; the phone card shows the agent's blocker reason; the reply produces an answer card; the tap records one APPLIED receipt linked to one new run; the task finishes DONE using the answer. | S-L1-05 (T1, T3); S-L1-31 (T3, real Claude) | PASS (stubbed Telegram, stubbed start); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-14, see evidence below; live satisfied 2026-09-16 by T3 plus the phone look check |
| H-L1-06 | Save answer, resume later | Reply, tap Save answer; later tap Resume with saved answer on the follow-up card. | Save starts nothing and keeps the task waiting with the saved answer; resume starts exactly one run. | S-L1-06 (T1, T3); S-L1-32 (T3, real Codex) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-07 | Offline, short gap | With a task waiting, stop the server; reply or tap on the phone; restart within 10 minutes. | Telegram holds the update; it is processed once after restart. | S-L1-14 (T1, T3) | Partial: durable offset and inbox processing after restart; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-08 | Offline, long gap | With an answer card open, stop the server shortly before its buttons expire (10 minutes after the card), tap Answer and resume, and restart after they expire but within 2 minutes of the tap. | "Not applied: This action expired" is sent and the current question is reissued; local state is unchanged. | S-L1-15 (T1 short TTL, T3 real 10 min) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-09 | Answer on both surfaces | With a phone answer card open, answer the same task in the local UI, then tap the phone button. | The phone tap is rejected because the question changed; only the local answer stands. | S-L1-10 (T1, T3) | Covered by H-M1-09 (fake); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-10 | Double tap | Tap Answer and resume twice quickly. | One run starts; the second tap shows "Already applied." with no extra message. | S-L1-07 (T1, T3) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-11 | Network drop and recovery | Disconnect the workstation network for about a minute, then reconnect. | The panel shows retrying with the sanitized error, then connected; messages queued during the outage are delivered once. | S-L1-16 (T1); S-L1-17 (T1 and T3 through the route proxy) | PASS (429, network failure, send retry); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-12 | Restart while waiting | Restart the server while a question card is pending. | No duplicate notification; replying to the existing card still works. | S-L1-19 (T1, T3) | Partial: durable offset; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-13 | Pipeline step | Block a step in a running pipeline, answer and resume from the phone. | The owning pipeline resumes and continues to its next step. | S-L1-21 (T1, T3) | PASS (stubbed pipeline starter); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-14 | Unknown Telegram user | From a second Telegram account, message the bot and send `/start` with a wrong code. | No reply and nothing recorded as an instruction; a stranger's button tap is rejected. | S-L1-22 (T1; T3 only with a second account) | PASS | Pending |
| H-L1-15 | Controls off and unpair | Turn Remote actions off and tap; then Unpair the chat. | The tap is rejected and changes nothing; after unpairing, no notifications arrive and old buttons are rejected. | S-L1-23, S-L1-24 (T1, T3) | PASS for remote actions off; unpair not automated; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-16 | Resume cannot start | Disable the task's provider, then Answer and resume. | "Answer saved, but resume did not start" is reported and the answer is kept. | S-L1-25 (T1, T3) | Covered by H-M2-04 (fake); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-17 | Token sweep after live use | Search logs, API responses and the real database for the token secret. | No match anywhere. | S-L1-28 (T1, T3) and the automatic sweep after every run | Not applicable; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L1-18 | Blocked task shows its reason | Let an agent block with a BLOCKER remark and inspect the phone card. | The card shows the latest blocker text, not a generic prompt. | S-L1-05 (T1, T3); S-L1-31 (T3) | PASS; T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-14, via H-L1-05; live satisfied 2026-09-16 by T3 plus the phone look check |

### L1 live evidence

Phone look check (harness T4, [`S-H6-33`](../e2e-scenarios/h6.md)): PASS on rendering, 2026-09-16, operator on the physical phone, against the T3 run of 2026-09-15.
Cards, answer cards, result messages and edited cards render correctly: no clipped text, line breaks and the collapsed detail kept, button labels read well.
Recorded at the same time, and not a rendering defect: the operator judged the card content too thin to decide from.
A question card should carry an identifier, a one-line description of the task, the work item's history, where it fits in the larger project, the context around the question, and the options with their trade-offs, in labelled sections.
That is an L3 change to the task summary model (RTC-22), tracked in the engineering plan; it does not hold the L1 close-out.
After a T3 run that includes the LIVE rows, open the test bot chat on the phone and record here whether the cards, answer cards, result messages and edited cards read well (length, line breaks, button labels, no clipped text), with the run date.

H-L1-05, verified 2026-09-14 against the real database, with a Codex saved task in a throwaway workspace and Host access off:

- 11:44:38Z the run started; 11:44:48Z the agent reported BLOCKED ("The weekly report colour is an owner decision that has not been made yet.") without creating any file.
- 11:44:49Z the question card, carrying that blocker text, was sent to the paired phone.
- 11:45:11Z the operator's reply produced an answer card with Save answer and Answer and resume.
- 11:45:15Z the Answer and resume tap recorded one APPLIED `answer_and_resume` receipt linked to a new run, and the phone received "Done: Answer saved and resume requested."
- 11:45:32Z the resumed run finished DONE with verification "contains exactly one line: Red"; the workspace file held exactly the operator's answer.
- Exactly two runs exist for the task: the blocking run and the single resumed run.

### L1 known issues found during live testing

- Node's default 250ms per-address connect attempt made every Bot API call fail with `ETIMEDOUT` on a network with no IPv6 route and slow IPv4 to Telegram.
  Fixed by `setDefaultAutoSelectFamilyAttemptTimeout(2500)` at server startup; reproduced before and verified after with plain Node `fetch`.
- The phone card for a task blocked by its own agent showed only "This task needs your input."
  Fixed in `taskControlRenderer.ts` to show the latest BLOCKER or DECISION_NEEDED remark, with a regression test.
- Fixed 2026-09-14: with Host access off, Claude saved-task runs were told to `curl` their context, which `acceptEdits` refuses, so they blocked without doing the task.
  Claude now reports through typed progress tools (implementation.md, tenth slice).
- Open: answers submitted from Telegram are recorded as ordinary `USER · HUMAN_RESPONSE` remarks; the task timeline does not show that they came from Telegram.
- Found 2026-09-15 by the first T3 run: a reply sent within about a second of a card could reach the server before the card's `sendMessage` response, and was answered "That message is not a task question".
  Fixed: a reply or navigation tap whose message is not yet known waits for the delivery in progress (S-L1-33, T0 and T1).
- Found 2026-09-15: Telegram drops a button tap the bot has not collected about 2.5 minutes after it is made (measured: pending at 141 seconds, gone at 151); messages are kept.
  A tap made while the workstation is offline for longer is lost: the phone shows a spinner and nothing happens, and the server never learns of it.
  H-L1-08 was rewritten to stay within that limit.
  Decided by the operator 2026-09-16: accept this and build nothing for it.
  A tap lost to a long outage stays lost; the question card is still open, so the answer can be given again by replying.
- Open: `npm run dev` stopped reloading on source changes after repeated restarts in one session; restart it manually after pulling server changes.

## L3 personal Telegram surface checklist

Scope: milestone L3 (RTC-21 to RTC-26), one operator in their own private chat.
Rows are added as each slice lands; the scenarios behind them are in the L3 tables under [`docs/e2e-scenarios`](../e2e-scenarios/).
Live status is satisfied by the T3 scenarios named plus the phone look check.

| ID | Case | Steps | Expected result | Harness scenario (tier) | Automated status | Live status |
| --- | --- | --- | --- | --- | --- | --- |
| H-L3-01 | Message updates in place | Trigger a status update of a message already on the phone, twice. | The same message changes text in place; no new message stacks; buttons that should remain still work. | S-L3-F1-05, S-L3-F1-10 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-02 | Edit of a deleted message | Delete a bot message on the phone, then trigger an edit of it. | Nothing reappears; the edit is recorded failed once and not retried; other messages keep arriving. | S-L3-F1-12 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-03 | Edits during a network drop | Cut the workstation's route to Telegram, trigger several updates of one message, restore. | The message ends showing the latest update, delivered once; the panel shows retrying, then connected. | S-L3-F1-15 (T1); S-L3-F1-16 (T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-04 | Reply stays in its topic | In a chat with topics, send a message in a topic that the bot answers. | The reply appears in the same topic, never in General or another topic. | S-L3-F2-02, 04 (T0); S-L3-F2-14 (T3, blocked on C0) | PASS (T0) | Blocked on C0 |
| H-L3-05 | Upgrade keeps the L1 chat working | Upgrade a workstation with an L1 paired chat and a pending card; reply to and tap the pre-upgrade card. | No duplicate or lost message; the pre-upgrade card still answers and resumes once. | S-L3-F1-04 (T0) | PASS (T0) | Pending |
| H-L3-06 | Decide from the card | Let a pipeline step block after a handoff brief is ready, then read the card on the phone without opening the laptop. | The card shows workstation, workspace, program and suite, pipeline position, task, goal, progress with verification counts, each blocker with its required action, the recommendation and what happens if you wait; line breaks in the blocker are kept. | S-L3-A-01, S-L3-A-13 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-07 | Collapsed details | On the same card, look at the details, then expand them. | Details are collapsed by default and expand to decisions and assumptions, important files and the full completed list; no stray markup, no local addresses, no secrets. | S-L3-A-01, S-L3-A-10, S-L3-A-11 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-08 | Card without a brief | Let a task block with only a blocker remark and no handoff. | The card shows the blocker text with its line breaks and no empty sections or details. | S-L3-A-02 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-09 | Very long card | Let a task block with an oversized brief containing emoji, CJK and accented text. | The card arrives; breadcrumb, first blocker and action are intact; shortened sections say so; no broken characters. | S-L3-A-05 to S-L3-A-08 (T0), S-L3-A-06 (T1) | PASS (T0, T1) | Pending |
| H-L3-10 | Workstation label | Change the workstation label in the Agents page, then let a task block; reset the label and repeat. | The first card shows the new label, the second the hostname; earlier cards are unchanged. | S-L3-F3-13, S-L3-A-14 (T1) | PASS (T1) | Pending |
| H-L3-40 | What is the workstation doing | With tasks running, blocked and failed, send `/status` on the phone. | Counts, active pipelines with step position and the quota headline match the laptop; the view shows "as of HH:MM"; nothing starts. | S-L3-B-01, S-L3-B-02 (T0, T1, T3) | PASS (T0, T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-41 | Drill down in one message | Send `/tasks blocked`, tap a task, tap Back, tap Refresh. | Each tap changes the same message in place; the task view shows the same summary as the question card; no new messages stack. | S-L3-B-12 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-42 | Command menu | Type `/` in the bot chat. | The command list from `/help` appears; filters are not in the menu. | S-L3-B-29 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-43 | Long list | With more tasks than fit one page, open `/tasks ready` and page through. | Every page is readable; every task appears exactly once. | S-L3-B-26 (T0, T1) | PASS (T0, T1) | Pending |
| H-L3-45 | Help and card replies | Send plain text and an unknown command; then reply to a question card. | Plain text and the unknown command get `/help`; the card reply still produces an answer card that works. | S-L3-B-10, S-L3-B-20 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-46 | Views after restart | Leave a view on the phone, restart the workstation, tap its buttons. | Old view buttons still navigate by editing the same message; no duplicates. | S-L3-B-32 (T1, T3) | PASS (T1); T3 PASS 2026-09-15 (real Telegram, test bot) | PASS - 2026-09-16 (T3 plus the phone look check) |
| H-L3-47 | Views change nothing | Use every command and button with a blocked task. | No run starts, no answer is recorded, the task stays blocked. | S-L3-B-14, S-L3-B-37 (T1) | PASS (T1) | Pending |
| H-L3-48 | Stranger gets nothing | From a second Telegram account (optional), send `/status` to the bot. | No reply and no task information. | S-L3-B-23 (T1) | PASS (T1) | Optional |


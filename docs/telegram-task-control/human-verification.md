# M1/M2/M3 human verification checklist

Scope: M1 personal task-control foundation, M2 local execution safety/quota
advisor and M3 local task-control robustness with fake services only. Do not use
a live Telegram bot, private Git remote, paid/provider execution, teammate
subscription delegation or automatic quota actions for these checks.

Expected commit topics:

- fake Telegram task-control foundation;
- settings-backed task-control capability and fake Telegram adapter;
- M1 fake-service completion with pairing, sanitized rendering, adapter callback
  dispatch, fake E2E coverage and this checklist.
- M2 durable start-intent ownership, restart reconciliation and advisory quota
  warnings.
- M3 fake Telegram quota-warning invariants, Agents quota-warning UI checks and
  stronger ownership/recovery edge-case coverage.

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
| H-M3-01 | Agents quota warning UI | Run `npm run test:quota-ui --workspace web`. | Healthy quota renders no warning; fresh 5% warning renders; missing/unavailable usage does not warn; duplicate warning identities dedupe; choices are display-only text; warning markup has narrow/wide overflow guards. | PASS | Pending |
| H-M3-02 | Fake Telegram quota warning | Run `server/src/taskControl.test.ts`. | Warning payload is sanitized, queued in fake outbox only, creates no callback action and does not mutate task/run/pipeline state on queue or delivery. | PASS | Pending |
| H-M3-03 | Ownership classification edges | Run `server/src/startIntent.test.ts`. | Start-before-spawn and start-after-spawn remain `START_UNKNOWN`; known no-spawn and known stopped release ownership; recovery refuses `START_UNKNOWN` and succeeds only after explicit known-stopped classification. | PASS | Pending |
| H-M3-04 | START_UNKNOWN UI gate | Inspect `implementation.md` M3 remaining gates. | No blind release UI was invented; future UI must say ownership is unknown and require provider process confirmation before recovery. | PASS | Pending |

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
AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m3-server node --import tsx --test --test-concurrency=1 server/src/quotaAdvisor.test.ts server/src/taskControl.test.ts server/src/startIntent.test.ts
npm run test:quota-ui --workspace web
npm run typecheck --workspace shared
npm run typecheck --workspace server
npm run typecheck --workspace web
npm run lint --workspace web -- lib/providerUsage.ts components/agents/usage.tsx components/agents/usage.test.tsx
```

Known blockers outside M1/M2/M3 fake/local behavior:

- `npm run lint --workspace web` currently fails on pre-existing React lint
  findings outside the M1/M2 touched-file slice.
- `npm run build --workspace web` is blocked in this environment by Next/Turbopack
  build issues recorded in `implementation.md`.
- No system Chromium/Chrome binary is available in this environment. M3 uses a
  scripted React-render UI check for the passive Agents quota warning surface;
  a future browser harness should add visual screenshot checks.
- `START_UNKNOWN` has no existing UI data path/pattern. M3 documents this as a
  remaining UI gate rather than adding blind release/recovery controls.

## Stop conditions

Stop verification and report blocked if a check requires any of the following:

- live Telegram Bot API calls or a real bot token;
- Git remote fetch/push or protected-ref policy evidence;
- provider subscription delegation, paid/API execution or real LLM execution;
- automatic pause, provider switch, spending, teammate delegation or takeover
  from a quota warning;
- credential/secret isolation certification;
- enterprise governance, retention or data-audience approval.

M1/M2/M3 are verified only for local fake-service personal task control, local
execution ownership and advisory quota warnings. This is not evidence that live
Telegram setup, teammate takeover, shared Git transfer or production delegation
is ready.

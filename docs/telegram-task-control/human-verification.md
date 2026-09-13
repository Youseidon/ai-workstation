# M1 human verification checklist

Scope: M1 personal task-control foundation with fake services only. Do not use a
live Telegram bot, private Git remote, paid/provider execution or teammate
subscription delegation for these checks.

Expected commit topics:

- fake Telegram task-control foundation;
- settings-backed task-control capability and fake Telegram adapter;
- M1 fake-service completion with pairing, sanitized rendering, adapter callback
  dispatch, fake E2E coverage and this checklist.

## Preconditions

- Work from a clean checkout.
- Do not place live bot tokens, provider credentials or private remote URLs in
  settings or docs.
- Prefer an isolated copy without `.agent-console` for mutation checks:
  `rsync -a --exclude .git --exclude .agent-console --exclude node_modules ./ /tmp/aw-m1-human-check/`

## Reviewer test cases

Status reflects the isolated verification run recorded in
`implementation.md` on 2026-09-13. A human reviewer should independently inspect
the code paths and rerun the commands before release.

| ID | Case | Steps | Expected result | M1 status |
| --- | --- | --- | --- | --- |
| H-M1-01 | Default-off capability | Start the server or inspect `TaskControlService.capability()` with default settings. | Capability reports disabled/default-off and G01-G04 remain blocked. | PASS |
| H-M1-02 | Settings are visible | Open Agents settings and inspect Task Control, or inspect `server/src/settings.ts` and `web/components/agents/AgentsView.tsx`. | Task Control has enablement, notifications, remote actions, transport and bot ID fields; defaults do not enable remote actions. | PASS |
| H-M1-03 | Fake pairing | Run `server/src/taskControl.test.ts`. | Pairing is single-use, expires and rejects wrong chat/topic. Usernames are not authority. | PASS |
| H-M1-04 | Fake question render | Run `server/src/taskControl.test.ts`. | Rendered phone payload redacts localhost URLs and secret-like values; no raw run IDs or transcript dumps are included. | PASS |
| H-M1-05 | Durable fake outbox | Run `server/src/telegramAdapter.test.ts`. | Send failure is recorded, retry can mark the same outbox item sent, and no task state changes merely because send failed. | PASS |
| H-M1-06 | Durable fake inbox | Run `server/src/telegramAdapter.test.ts`. | Updates are stored before the cursor advances; duplicate updates are ignored by primary key. | PASS |
| H-M1-07 | Fake E2E Save then Resume | Run `server/src/telegramAdapter.test.ts`. | Fake adapter posts a question, processes callback updates, saves an answer, reissues current actions and resumes exactly once. | PASS |
| H-M1-08 | Wrong actor/bot/topic | Run `server/src/taskControl.test.ts`. | Wrong actor, bot and topic are rejected with durable receipts and no task mutation. | PASS |
| H-M1-09 | Stale revision | Run `server/src/taskControl.test.ts`. | A changed task/question rejects the old action; no answer is saved. | PASS |
| H-M1-10 | Disabled remote actions | Run `server/src/taskControl.test.ts`. | Remote callbacks are rejected while remote controls are disabled. Local Stop remains outside this feature. | PASS |

## Command evidence

Use an isolated copy for DB-backed tests where possible:

```bash
node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts server/src/telegramAdapter.test.ts server/src/humanInput.test.ts
npm run typecheck --workspace shared
npm run typecheck --workspace server
npm run build --workspace server
npm run typecheck --workspace web
cd web && npx eslint lib/workspacesApi.ts components/agents/AgentsView.tsx
```

Known blockers outside M1 fake behavior:

- `npm run lint --workspace web` currently fails on pre-existing React lint
  findings outside the task-control slice.
- `npm run build --workspace web` is blocked in this environment by Next/Turbopack
  build issues recorded in `implementation.md`.

## Stop conditions

Stop verification and report blocked if a check requires any of the following:

- live Telegram Bot API calls or a real bot token;
- Git remote fetch/push or protected-ref policy evidence;
- provider subscription delegation, paid/API execution or real LLM execution;
- credential/secret isolation certification;
- enterprise governance, retention or data-audience approval.

M1 is verified only for local fake-service personal task control. It is not
evidence that live Telegram setup, teammate takeover or production delegation is
ready.

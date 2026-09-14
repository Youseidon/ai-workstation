# Implementation plan and release evidence

Parent: [Design baseline](README.md). Contracts: [User flows](user-flows.md) and
[Protocol](protocol.md). Do not start a broad refactor to implement these modules.
The design itself grants no permission to deploy, push branches, configure live
bots, send messages or run another person's subscription.

## 0. Current implementation status

Development is authorized. No further product decision is required for the local
control foundation. G01-G04 remain evidence/deployment gates, not unanswered
questions blocking all code. An unresolved gate never defaults to approval.

Implemented first slice (P1 foundation, not completion of P1):

- Local input dialog offers Save answer independently of provider availability,
  Answer and resume, and Resume with saved answer.
- Saving adds a persistent task hold in SQLite migration 15. No provider is called.
  The task remains in attention; normal task starts cannot bypass this hold.
- A question/context revision binds the local dialog's submission. Changed task
  instructions or a newer question reject the old submission without saving it.
  Drafts remain available for explicit review against the new question.
- Failed resume restores an existing saved-answer hold. Late completion callbacks
  retain the waiting task and preserve a separate pipeline pause.
- Existing local API callers remain compatible. The new save endpoint requires
  a revision; legacy endpoints are not authorized remote-control interfaces.

API: `GET /api/prompts/:id/activity` includes `humanInput.revision` and
`humanInput.savedResponseId`. `POST /api/prompts/:id/save-human-response` requires
`content` and `expectedRevision`. Existing `respond-and-continue` accepts
`expectedRevision` with either `content` or the returned `responseId`.

Not delivered by this slice: Telegram enrollment/polling, remote identities,
durable remote command receipts, process-level crash reconciliation, quota
warnings, shared Git records, or subscription-sponsored execution. The local
revision hash is not a substitute for the shared version/epoch protocol.

Next slice is the disabled-by-default Telegram adapter with pairing and durable
inbox/outbox, wired only through validated personal-task actions. It must add
remote authorization and replay protection before accepting execution commands.

Verification on 2026-09-13: all 11 server test files passed in a temporary app
copy, including save/no-provider, stale/competing answers, failed resume, start
hold and late-callback tests. Shared/server/web type checks and lint for the
changed frontend files passed. Chromium checks passed at 1440x1000 and 390x844:
real fixture answer saves, stale-draft review, saved-answer display, no horizontal
dialog overflow, and simulated provider unavailability. Browser resume was
intercepted; no live LLM task or Telegram message was sent. The user's working
database was not used for tests. This evidence does not complete P1 or G01-G04.

Implemented second slice (M1 fake task-control foundation, not live Telegram):

- Added shared task-control capability/action/receipt contracts.
- Added additive SQLite migration 16 for enrolled task-control actors, opaque
  action references, idempotent command receipts and a Telegram outbox queue.
- Added a default-off `TaskControlService` with fake Telegram enrollment for
  tests, question-card/action creation, durable outbox state and callback routing
  only to Save answer and Answer and resume.
- Added `GET /api/task-control/capability`, which reports Telegram task control
  disabled by default and keeps G01-G04 visible as blocked production gates.
- Added client API typing for the capability endpoint.

This slice still does not connect a real Telegram bot, poll Telegram, expose fake
callback routes, enroll real devices, publish Git records, start teammate
execution, certify provider delegation or prove runtime secret isolation. The
fake service is a local test boundary only.

Verification on 2026-09-13 in `/tmp/ai-workstation-task-control-check`, copied
from the repo with `.agent-console` excluded and local `node_modules` symlinked:

- `node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts server/src/humanInput.test.ts` passed. Covered default-off capability status, fake outbox failure, wrong actor rejection, stale revision rejection, Save answer, reissued Answer and resume, and duplicate callback idempotency.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run build --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npx eslint lib/workspacesApi.ts` from the `web` directory passed for the
  touched frontend file.
- `npm run lint --workspace web` remains blocked by pre-existing lint findings
  outside this slice: `web/components/pipeline/RuleChip.tsx`,
  `web/components/pipeline/RulePopover.tsx`,
  `web/components/tasks/TasksView.tsx`, `web/lib/providerUsage.ts`, plus existing
  unused-variable warnings. No live Telegram messages, paid/provider execution,
  Git pushes/fetches or remote mutations were performed.

Implemented third slice (M1 settings and fake Telegram adapter skeleton):

- Added default-off Task Control settings for enablement, notifications, remote
  actions, transport and local bot identity. These settings are exposed in the
  existing Agents settings page under a separate Task Control section.
- Changed the task-control singleton to read capability state from settings while
  keeping all production gates blocked.
- Routed `/api/task-control/capability` through the top-level server router.
- Added additive SQLite migration 17 for durable fake Telegram inbox records and
  polling cursors.
- Added a fakeable Telegram adapter and fake Bot API implementation for polling
  updates and sending queued outbox messages without network access.
- Added test cleanup helpers so fake transport tests do not leave bot/action
  records behind after ordinary test runs.

This slice still does not implement live Bot API calls, real pairing challenges,
real Telegram callback routes, topic rendering, production setup UI, shared Git
records or teammate execution. Setting `taskControl.transport=telegram` is only a
reserved value until a live adapter is implemented and explicitly authorized.

Verification on 2026-09-13 in `/tmp/ai-workstation-task-control-settings-lSERl5`,
copied from the repo with `.agent-console` excluded and local `node_modules`
symlinked:

- `node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts server/src/telegramAdapter.test.ts server/src/humanInput.test.ts` passed. Covered dynamic settings-backed capability, fake polling cursor advancement, duplicate update handling, durable fake outbox failure/retry, Save answer, Answer and resume and callback idempotency.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run build --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npx eslint lib/workspacesApi.ts components/agents/AgentsView.tsx` from the
  `web` directory passed for touched frontend files.
- `npm run lint --workspace web` remains blocked by the same pre-existing lint
  findings outside this slice.
- `npm run build --workspace web` in the isolated symlinked copy was blocked by a
  Turbopack limitation with `web/node_modules` pointing outside the project root.
  Running it in the real checkout first failed under sandboxed network because
  Next could not fetch Google fonts; the escalated rerun got past that and then
  hit a Turbopack/PostCSS worker `EPERM` while binding a local port. The webpack
  fallback `npm run build --workspace web -- --webpack` failed before app
  compilation with `Could not parse output from TypeScript's --showConfig`.
  These build failures are recorded as harness/build-system blockers, not
  evidence of production readiness.

No live Telegram messages, paid/provider execution, Git pushes/fetches or remote
mutations were performed. A short-lived local fake transport record cleanup was
run against `.agent-console/console.sqlite` for test IDs prefixed `fake-poll-`,
`fake-send-`, `fake-bot` and `fake-tg-`; no user task, provider or workspace
records were intentionally changed.

Implemented fourth slice (M1 fake-service completion):

- Added durable pairing challenges with expiry, single-use consumption and
  chat/topic binding for fake setup verification.
- Added sanitized phone-question rendering for personal task-control cards.
- Added adapter-side processing of durable fake callback updates into
  task-control receipts.
- Added fake E2E coverage for pairing, rendered question delivery, callback
  save, reissued resume and duplicate callback idempotency.
- Added [M1 human verification checklist](human-verification.md) with reviewer
  test cases and stop conditions.

M1 is complete for local fake-service personal task control. The live Telegram
adapter, real Bot API polling, real setup/pairing UX, teammate transfer, Git
publication, provider subscription delegation and enterprise release claims remain
default-off or blocked by G01-G04.

Verification on 2026-09-13 in `/tmp/ai-workstation-m1-finish-ZwINsb`, copied
from the repo with `.agent-console` excluded and local `node_modules` symlinked:

- `node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts server/src/telegramAdapter.test.ts server/src/humanInput.test.ts` passed. Covered M1 fake E2E, pairing replay/expiry/context mismatch, wrong actor/bot/topic, stale revision rejection, sanitized phone payloads, durable inbox/outbox, duplicate updates and resume-once behavior.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run build --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npx eslint lib/workspacesApi.ts components/agents/AgentsView.tsx` from the
  `web` directory passed for touched frontend files.
- `npm run lint --workspace web` remains blocked by pre-existing lint findings
  outside M1: `web/components/pipeline/RuleChip.tsx`,
  `web/components/pipeline/RulePopover.tsx`,
  `web/components/tasks/TasksView.tsx`, `web/lib/providerUsage.ts`, plus existing
  unused-variable warnings.

Local database hygiene after running the focused tests in the real checkout:
querying task-control fake prefixes in `.agent-console/console.sqlite` returned
zero rows for `task_control_actor`, `task_control_action`,
`task_control_receipt`, `telegram_outbox`, `telegram_inbox` and
`telegram_poll_cursor`. No live Telegram messages, paid/provider execution, Git
pushes/fetches or remote mutations were performed.

Implemented fifth slice (M2 local execution safety and quota advisor):

- Added additive SQLite migration 19 for durable `workspace_start_intent`
  records keyed by effective working directory. Active rows distinguish
  `START_INTENT`, `RUNNING`, `KNOWN_STOPPED`, `KNOWN_NO_SPAWN` and
  `START_UNKNOWN`.
- `startExecute` now reserves ownership before awaited provider discovery and
  records no-spawn/stopped outcomes for provider, validation and launch failures.
- Restart reconciliation preserves unknown ownership for start-before-spawn and
  start-after-spawn records instead of blindly releasing the workspace. Operator
  recovery refuses `START_UNKNOWN` until the user confirms the provider process
  is not still running.
- UI, pipeline retry/resume and fake Telegram answer-and-resume paths all route
  through the same start reservation/hold checks.
- Added `server/src/quotaAdvisor.ts`, producing advisory-only fresh low-quota
  warnings with window identity, freshness and dedupe. The advisor does not
  pause work, switch providers, spend, delegate or mutate execution state.
- Added passive quota-warning display to the existing Agents plan-usage panel and
  fake Telegram outbox rendering for warning notifications. These surfaces show
  choices only; they do not add action callbacks.
- Added `AGENT_CONSOLE_REPO_ROOT` for isolated test database roots so tests can
  run without mutating the user's live `.agent-console` DB.

M2 remains local/fake-service only. It does not enable live Telegram, shared Git
transfer, provider-paid execution, teammate delegation, production deployment or
external integrations. Unfinished integrations remain default-off.

Verification on 2026-09-13 in isolated roots under `/tmp`:

- `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2-test node --import tsx --test --test-concurrency=1 server/src/runService.test.ts server/src/startIntent.test.ts server/src/quotaAdvisor.test.ts server/src/consult.test.ts` passed. Covered reservation-before-provider source order, aliased effective-directory ownership, restart reconciliation to `START_UNKNOWN`, fake Telegram resume-path ownership, and quota advisor freshness/dedupe/threshold behavior.
- `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m2-full npm test --workspace server` passed all 15 server test files without using the live console DB.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npm run lint --workspace web -- lib/providerUsage.ts components/agents/usage.tsx components/agents/AgentsView.tsx` passed for touched frontend files.

Known blockers outside M2 behavior:

- No browser automation script is present for these touched UI files. The UI
  change is passive rendering in an existing panel and was covered by TypeScript
  and touched-file ESLint.
- Live Telegram, production Bot API setup, Git transfer, subscription delegation,
  teammate takeover and external deployment gates remain blocked/default-off by
  G01-G04 and by explicit M2 scope.

Rollback/default-off behavior:

- Reverting this slice leaves migration 19 additive and inert. Active ownership
  rows can be inspected and released by marking terminal states if a local
  operator confirms no provider process remains.
- Task Control settings still default off. `taskControl.transport=telegram`
  remains a reserved value, not a live integration.
- Quota warnings are advisory JSON/UI/outbox payloads only; ignoring a warning
  leaves existing approved work unchanged.

Numbering correction (2026-09-14): the three slices below were previously
labelled M3, M4 and M5 in this file and in `human-verification.md`. That
collided with this plan's own formal M3 ("Checkpoint and Shared Control
Storage", RTC-09/10), M4 ("Named Teammate Claim and Receiver Execution",
RTC-11/12) and M5 ("Shared Questions, Return, Apply and Further Handoff",
RTC-13/15) in section 3 above, none of which exist in this codebase: there is
no `taskTransfer` module, no package/manifest/roster schema, no offer/claim/
receiver code and no shared-question/apply/handoff code anywhere in `server/src`
or its migrations. Every slice below is local hardening and UI work that stays
within formal M2's scope (RTC-06 through RTC-08: effective-directory
reservation, process supervision/`START_UNKNOWN` reconciliation and the quota
advisor). They are relabelled M2b, M2c and M2d accordingly. Formal M3, M4 and
M5 remain entirely unimplemented; do not read the M2b/M2c/M2d labels below as
progress toward them.

Implemented sixth slice (M2b local task-control robustness):

- Added isolated server coverage for fake Telegram quota-warning notifications.
  The warning payload is sanitized, queued only through the fake outbox, creates
  no callback action rows and does not mutate prompt, run, pipeline or human
  response state when queued or marked delivered.
- Strengthened ownership tests for start-before-spawn, start-after-spawn,
  known no-spawn, known stopped and recovery refusal while ownership is
  `START_UNKNOWN`. Recovery is allowed only after an explicit known-stopped
  classification.
- Added scripted Agents quota-warning UI coverage in
  `web/components/agents/usage.test.tsx`, exposed as
  `npm run test:quota-ui --workspace web`. The test covers healthy usage, fresh
  5% warnings, missing/unavailable usage, duplicate provider/window/reset
  identity dedupe, display-only warning choices and narrow/wide overflow guard
  markup.
- Added UI dedupe for quota warnings by provider/window/reset identity and
  break-word/min-width constraints on the passive warning block. The block still
  has no action buttons or links.
- No persistence changes or migrations were added for M2b.

M2b remains local/fake-service only. It does not enable live Telegram, shared
Git transfer, provider-paid execution, teammate delegation, production
deployment, external integrations or automatic quota actions. Unfinished
integrations remain default-off.

Verification on 2026-09-13:

- `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m3-server node --import tsx --test --test-concurrency=1 server/src/quotaAdvisor.test.ts server/src/taskControl.test.ts server/src/startIntent.test.ts` passed. Covered quota advisor freshness/dedupe/thresholds, fake Telegram quota-warning outbox/action/state invariants and ownership classification edge cases.
- `npm run test:quota-ui --workspace web` passed. Covered scripted React-render checks for the Agents quota warning display.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npm run lint --workspace web -- lib/providerUsage.ts components/agents/usage.tsx components/agents/usage.test.tsx` passed for touched frontend files.

Known blockers and remaining gates outside M2b behavior:

- `START_UNKNOWN` does not yet have a visible UI affordance. Existing prompt and
  operation DTOs expose `recoverable`, not the underlying start-intent
  classification/detail, so M2b documents this as a remaining UI gate instead of
  inventing a blind release/recovery surface. Future UI must clearly say
  ownership is unknown, must not offer blind release and must direct the user to
  confirm provider process state before recovery.
- This environment has no system Chromium/Chrome binary available, so the M2b
  UI check is a scripted React-render test rather than a live browser screenshot
  test. It verifies the passive markup, advisory-only controls and mobile/desktop
  overflow guard classes; a future browser harness can add visual overlap
  screenshots without changing M2b behavior.
- Live Telegram, production Bot API setup, Git transfer, subscription
  delegation, teammate takeover and external deployment gates remain
  blocked/default-off by G01-G04 and by explicit M2b scope.

Rollback/default-off behavior:

- Reverting M2b removes only tests, the UI warning dedupe helper, stable warning
  test selectors and overflow guard classes. No schema rollback is required.
- Task Control settings still default off. `taskControl.transport=telegram`
  remains a reserved value, not a live integration.
- Quota warnings remain advisory UI/outbox payloads only; ignoring, rendering,
  queueing or delivering a warning leaves existing approved work unchanged.

Implemented seventh slice (M2c local start-unknown recovery UX and browser harness):

- Added an additive `PromptOption.recovery` DTO with `none`, `recoverable` and
  `start_unknown` states. The DTO exposes only fixed UI guidance and does not
  include start-intent detail, raw process facts, provider credentials, external
  IDs or secrets.
- `START_UNKNOWN` remains server-blocked: `recoverPrompt` still rejects it until
  a local server-side classification changes the previous start to known stopped
  or no spawn. Known recoverable prompts continue to expose `recoverable: true`
  and keep the existing recovery behavior.
- The Chat work-item picker and Tasks work-item list/detail surfaces now show an
  existing warning/badge pattern for unknown ownership. The warning says
  ownership is unknown, directs the user to confirm provider process state before
  recovery and explains that recovery stays blocked until the server knows the
  previous start is stopped or no spawn.
- The START_UNKNOWN affordance offers no blind release/recovery action. Merely
  viewing Chat or Tasks performs no stop, start, pause, provider switch, spend,
  delegation, takeover or execution-state mutation.
- Added `scripts/verify-m4-browser.mjs` and `npm run verify:m4-browser` as a
  fake-fixture browser harness for mobile and desktop overflow/passive-control
  checks when Playwright/Chromium is available. (Script/npm-script names keep
  their original `m4` spelling; renaming them is a separate, non-doc change.)
- No persistence changes or migrations were added for M2c.

M2c remains local/fake-service only. It does not enable live Telegram, shared
Git transfer, provider-paid execution, teammate delegation, production
deployment, external integrations or automatic quota actions. Unfinished
integrations remain default-off.

Verification on 2026-09-13 in isolated roots under `/tmp`:

- `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-m4-start-unknown node --import tsx --test --test-concurrency=1 server/src/startIntent.test.ts server/src/operationalState.test.ts server/src/quotaAdvisor.test.ts server/src/taskControl.test.ts` passed. Covered START_UNKNOWN API/DTO/recovery behavior, known-stopped recovery reclassification, operational visibility, existing quota advisor invariants and fake Telegram advisory-only warning delivery.
- `npm run test:quota-ui --workspace web` passed. Covered healthy/no warning, fresh 5% warning, stale/unavailable/missing no-warning cases, duplicate provider/window/reset dedupe, display-only quota choices, START_UNKNOWN required copy, no blind release/recovery action and narrow/wide overflow guard markup.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npm run lint --workspace web -- components/ContextPicker.tsx components/tasks/WorkItemDetail.tsx components/tasks/WorkItemList.tsx components/recovery.test.tsx components/agents/usage.tsx components/agents/usage.test.tsx` passed for touched frontend files.
- `npm run verify:m4-browser` was attempted and failed before exercising UI
  behavior because this environment has no `playwright` package installed:
  `Cannot find package 'playwright' imported from scripts/verify-m4-browser.mjs`.
  The script is documented and ready to run with a local Playwright module or
  `--playwright` path; executed coverage for this environment is the React
  render test above.

Known blockers and remaining gates outside M2c behavior:

- Live browser screenshots remain blocked by the missing Playwright/Chromium
  dependency in this environment. The added harness records the exact fake
  fixture and viewport assertions to run once that dependency is available.
- There is still no live Telegram Bot API setup, Git transfer, subscription
  delegation, teammate takeover, provider-paid execution or external deployment
  approval. G01-G04 remain production/external gates.
- Manual operator classification from START_UNKNOWN to known stopped/no spawn is
  still a local server-side operation; M2c only exposes safe UI state and keeps
  recovery blocked until that classification exists.

Rollback/default-off behavior:

- Reverting M2c removes the additive DTO field, passive UI warnings, render tests
  and optional browser harness. No schema rollback is required.
- Task Control settings still default off. `taskControl.transport=telegram`
  remains a reserved value, not a live integration.
- Quota warnings remain advisory UI/outbox payloads only; rendering, queueing or
  delivering a warning leaves runs, pipelines, tasks and callback actions
  unchanged.

Implemented eighth slice (M2d local START_UNKNOWN operator classification):

- Added `workspaces.classifyStartUnknown` and
  `POST /api/prompts/:id/classify-start-unknown`, closing the M2c gap where
  `START_UNKNOWN` had no path to `known stopped`/`known no spawn`. The operator
  must pass `confirmed:true` and the `expectedStartIntentId` currently shown by
  the DTO.
- Classification is refused with a distinct `WorkspaceError` code if: the choice
  is not a valid classification (`validation_error`); confirmation is missing
  (`confirmation_required`); the prompt does not exist (`not_found`); the
  in-memory run is still active (`run_active`); the start intent is no longer
  `START_UNKNOWN`, or a newer start intent or run exists (`start_intent_changed`
  / `run_changed`, stale-optimistic-concurrency).
- A successful classification updates the `workspace_start_intent` row to
  `KNOWN_STOPPED` or `KNOWN_NO_SPAWN`, releases it, and records an audit
  `prompt_status_event` row with actor `USER` naming the confirmed
  classification. `recoverPrompt` then behaves exactly as it already did for a
  known-stopped/no-spawn intent.
- `PromptOption.recovery` gained an optional `startIntentId` so the UI can
  address the specific unresolved start; it still exposes no raw start-intent
  detail, process facts, provider credentials, external IDs or secrets.
- `TaskControlCapability` gained a `setup` field (`disabled` / `fake_only` /
  `telegram_configured`), surfaced as a badge and reason string in Agents
  settings in place of the previous static fake-only copy. This is a status
  label only; it does not change `remoteActionsEnabled` or gate behavior.
- `ContextPicker` and the Tasks work-item detail panel add "Mark known stopped"
  / "Mark no spawn" actions next to the existing `START_UNKNOWN` warning, each
  behind a confirm dialog that requires the operator to state they checked the
  local provider process state outside Agent Console. No blind release/recovery
  action is offered; recovery remains a separate, explicit action after
  classification.
- No new migrations; reuses the existing `workspace_start_intent` and
  `prompt_status_event` tables from M2/M2c.

M2d remains local/fake-service only. It does not enable live Telegram, shared
Git transfer, provider-paid execution, teammate delegation, production
deployment, external integrations or automatic quota actions. Unfinished
integrations remain default-off.

Verification on 2026-09-14 in isolated roots under `/tmp`:

- `AGENT_CONSOLE_REPO_ROOT=<isolated tmp root> node --import tsx --test --test-concurrency=1 server/src/humanInput.test.ts server/src/pipelineScheduler.test.ts server/src/operationalState.test.ts server/src/taskControl.test.ts server/src/startIntent.test.ts` passed (74 tests). Covered the four new classification tests (records classification, rejects stale `expectedStartIntentId`, rejects while a run is active in memory, and recovery succeeds after a known-no-spawn classification), plus existing human-input, pipeline-scheduling, operational-state and task-control/recovery regression coverage.
- `AGENT_CONSOLE_REPO_ROOT=<isolated tmp root> npm test --workspace server` passed all 141 tests across the full server suite, confirming no regression from the `workspaces.ts` recovery-detection query change.
- `npm run test:quota-ui --workspace web` passed (8 tests), including the updated `recovery.test.tsx` assertions for the new "Mark known stopped"/"Mark no spawn" controls and their `flex-wrap` layout.
- `npm run typecheck --workspace shared` passed.
- `npm run typecheck --workspace server` passed.
- `npm run typecheck --workspace web` passed.
- `npm run lint --workspace web -- app/page.tsx components/ContextPicker.tsx components/agents/AgentsView.tsx components/recovery.test.tsx components/tasks/TasksView.tsx components/tasks/WorkItemDetail.tsx` passed for touched frontend files.

Known blockers and remaining gates outside M2d behavior:

- Classification is a local, unauthenticated-by-transport server action gated
  only by the existing local UI; it is not wired to any Telegram/remote actor
  and inherits no new authorization model.
- Live browser screenshot coverage is still blocked by the missing
  Playwright/Chromium dependency noted under M2c; the new buttons are covered by
  the React-render tests above, not a live browser check.
- There is still no live Telegram Bot API setup, Git transfer, subscription
  delegation, teammate takeover, provider-paid execution or external deployment
  approval. G01-G04 remain production/external gates.
- The plan's formal M3 (RTC-09/10, checkpoint/shared Git storage), M4
  (RTC-11/12, named teammate claim) and M5 (RTC-13-15, shared questions,
  return, apply, further handoff) are all unimplemented; this slice, like M2b
  and M2c before it, does not address any of them.

Rollback/default-off behavior:

- Reverting M2d removes the classification endpoint/method, the additive
  `startIntentId`/`setup` fields, the new UI actions and their tests. No schema
  rollback is required; `START_UNKNOWN` simply stays server-blocked as it was
  after M2c.
- Task Control settings still default off. `taskControl.transport=telegram`
  remains a reserved value, not a live integration.

## 1. Current code: useful pieces and actual gaps

| Existing location | Reuse | Gap that must not be assumed solved |
| --- | --- | --- |
| [humanInput.ts](../../server/src/humanInput.ts) | Save-only, question-bound local submissions, retry continuation and preserve owning pipeline. | Remote actor authorization and durable command receipts remain to be added. |
| [agentContext.ts](../../server/src/agentContext.ts) | Structured task instructions, history and clarification context. | Raw output is not an approved export and includes local references. |
| [handoffCoordinator.ts](../../server/src/handoffCoordinator.ts) | Existing local handoff evidence and successor handling. | It launches an LLM to produce a brief and may auto-start a successor; a Telegram transfer needs explicit authority and a no-LLM capture path. |
| [workspaces.ts](../../server/src/workspaces.ts) | Local persistence, run events, task relationships, migrations, durable local start-intent ownership and unknown-start reconciliation. | Local IDs/database are not shared identity; `START_UNKNOWN` still requires explicit local confirmation before release. |
| [runService.ts](../../server/src/runService.ts) | Start a saved task in a selected local directory with durable reservation before provider discovery. | This is local-only ownership, not cross-workstation transfer or provider process attestation. |
| [runHub.ts](../../server/src/runHub.ts) | Observed local events, stop request and completion signal. | In-memory ownership alone does not survive restart or coordinate machines. |
| [pipelineScheduler.ts](../../server/src/pipelineScheduler.ts) | Pipeline ownership, retry/recovery and progression through the shared local start reservation. | Delegation/transfer records remain out of scope. |
| [settings.ts](../../server/src/settings.ts) | Existing settings, permission flags, UI metadata. | Settings are largely provider/global, including host-access overrides. There is no complete enforceable per-workspace transfer policy or separate secret broker today. |
| [claudePermissions.ts](../../server/src/lib/claudePermissions.ts) | Existing provider-specific rule handling. | Best-effort rule matching is not a security sandbox or proof against arbitrary shell execution. |
| [adapters](../../server/src/adapters/types.ts) | Provider checks, run/interrupt and usage hooks. | Add a tested capability contract for identity/billing attribution, effective permissions, pause/process observation and quota window applicability. |
| [registry.ts](../../server/src/adapters/registry.ts) | Existing account usage polling and cache feeding advisory quota warnings. | Current one-minute cache is not a quota reservation or exact remaining-token count. |
| [index.ts](../../server/src/index.ts) | Local API and event wiring. | No internet-facing multi-user authorization. Keep it local; Telegram must invoke validated internal services, not expose generic REST access. |
| [shared types](../../shared/src/index.ts) | Existing task/provider/event contracts. | Add versioned task-control/transfer schemas; no mutation of provider IDs into account identities. |

These observations come from repository inspection on 2026-09-13. Follow existing
module patterns where compatible. Do not rewrite the monolithic workspace store,
replace the database, or add a workflow framework just for this enhancement.

## 2. Proposed module boundaries

Names below are proposed locations, not files that already exist.

| Module | Proposed location | Responsibilities and exclusions |
| --- | --- | --- |
| Telegram adapter | `server/src/integrations/telegram/` | Bot client, polling/inbox, outbox, pairing, topic renderer and callback adapter. Does not decide pipeline semantics or execute arbitrary commands. |
| Task control | `server/src/taskControl/` | Validated actions, questions, approvals, permission comparisons, journals and workspace holds. Uses existing run/human-input services. |
| Quota advisor | `server/src/quotaAdvisor.ts` | Advisory events from available telemetry; no automatic failover or pause. |
| Task transfer | `server/src/taskTransfer/` | Package/manifest validation, controlled Git storage, signed task records, import, assignment, result reconciliation. No shared SQLite. |
| UI integration | Existing task detail, human-input and settings components | Connect Telegram, preview export, display pending actions, local permission deltas and result review. No new dashboard required. |
| Shared contracts | `shared/src/` | Explicit schema versions, IDs, events, state transitions and stable error categories. |

One local Node backend runs these modules. A custom relay, central worker fleet,
open recipient marketplace and generic chat agent are outside the baseline.
Abstract a notification transport only at the real task-event/action interface;
do not build unused integrations for other channels.

Task eligibility: saved pipeline tasks are first. Custom/ad-hoc prompts must obtain
a persisted task identity/context record before Telegram control or export. Do not
silently lose support for them or treat an ephemeral prompt as durable. Implement
their persistence as a later explicit phase step using existing task storage.

## 3. Delivery phases

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| P0 | Validate selected provider feasibility, bot routing, safe process observation and Git ref policy in isolated fixtures. | G01-G03 evidence recorded; unresolved capabilities explicitly disabled. No live messages or subscriptions without separate setup authorization. |
| P1 | Personal Telegram control for saved tasks: pairing, organized questions, Save answer, Answer and resume, observed status and reconnect. | One real fixture task asks, receives an authorized answer and resumes once; no team machinery required. |
| P2 | Advisory quota control plus persisted holds/checkpoint preview; support persisted ad-hoc tasks. | 5% warning does not stop work; explicit pause works; capture survives zero quota. |
| P3 | Named teammate transfer through independent bots and private Git. | Two isolated installations publish, discover, accept and start one checkpoint under recipient-local policy. |
| P4 | Mid-run question, return/apply, crash recovery and further handoff. | Requester can answer executor bot while source app is offline; return applies once and does not overwrite divergence. |
| P5 | Operational hardening and deployment acceptance. | Required failure tests, security review, backup/restore, compatibility and team governance gates pass. |

P1 is useful on its own. G01 can block a provider's P3 execution without blocking
personal Telegram controls. Do not represent P1 or a mocked two-worker test as a
working personal-subscription handoff. Do not use an API account to quietly pass
a test whose requirement is subscription allowance.

## 4. Acceptance scenarios

Use isolated database/repository fixtures. Several existing tests derive SQLite
paths from repository location; never run mutation tests against the user's live
workstation data. Start with fake providers and a fake Telegram HTTP endpoint.
Use a real bot only in an explicitly authorized test chat; report what was sent.

| Test ID | Scenario | Required observation |
| --- | --- | --- |
| T01 | Personal input with Save answer then Resume | Answer saved with no run; later action starts the owning task once. |
| T02 | Answer and resume, duplicate callbacks, delivery retry | One recorded decision and one attempt for the command. |
| T03 | Wrong user/chat/topic/bot, forwarded button, anonymous actor | Action rejected; no task/status mutation. |
| T04 | Edited answer, conflicting response, stale question | Applied record unchanged; conflict or new revision explicit. |
| T05 | Pairing replay, expired challenge, device replacement | No silent reassignment of identity or bot credentials. |
| T06 | Bot host offline before/after acceptance card exists | No false acknowledgement; recover/reissue after lost updates. |
| T07 | Telegram send timeout, removal, throttling, topic-close failure | Durable retry/status, bounded noise; task outcome independent of presentation. |
| T08 | 5% fresh/stale/missing telemetry; reset; multiple tasks | Correct advisory only, owner-private usage, no repeated warning storm. |
| T09 | Quota reaches zero before summary | File/context capture and notification need no LLM. |
| T10 | UI start races Telegram start/provider discovery | Exactly one workspace reservation succeeds, including aliased paths. |
| T11 | Pipeline auto-retry/restart during delegation | Persisted hold prevents a second source executor. |
| T12 | Provider parent exits but mutating child remains | No source release or successor start until supervision reconciles it. |
| T13 | User edits during snapshot / new and binary files | Unstable candidate rejected; approved staged and unstaged state preserved. |
| T14 | Secret, traversal, escaping symlink, malicious hook/config, missing LFS/submodule | No leak/implicit code execution; explicit exclusion or unsupported requirement. |
| T15 | Wrong hash, wrong repository, missing artifact, partial upload | Package not executable; offer not published prematurely. |
| T16 | Accept versus withdraw; concurrent claim | One valid shared transition; rejected actor cannot run. |
| T17 | Push success with lost acknowledgement | Event discovered on fetch; no duplicate shared decision. |
| T18 | Rewritten control history, invalid signature or revoked key | Shared start disabled; last trusted state retained for inspection. |
| T19 | Receiver's requested access within local permission | Acceptance starts without requester confirmation or redundant permission prompt. |
| T20 | Extra access / hard denial / imported allow rule / later tool escalation | Local delta prompt, deny, or unknown state; no automatic global permission change. |
| T21 | Provider/bot/Git/signing secrets probed by task tools | Protected even under the supported existing workspace policy; uncertified configuration cannot be released. |
| T22 | Requester offline; executor asks requirements question | Requester answers executor bot; answer binds to current question and resumes only as explicitly selected. |
| T23 | Revised task or expired approval while queued | No start under stale authority. |
| T24 | Crash before/after spawn; duplicate run request | Identified existing attempt or START_UNKNOWN; no blind retry. |
| T25 | Network partition and remote cancellation | Current owner not reassigned; stop pending visibly until acknowledged. |
| T26 | Deployment/external write timed out | Outcome inspected before replay; no claim of exactly-once external effects. |
| T27 | Further handoff with pending questions | Same global task/conversation, new epoch/package, original decision ownership preserved. |
| T28 | Partial result, false success, missing verification | Result labelled accurately; no automatic DONE or pipeline progression. |
| T29 | Original dirty tree unchanged/diverged; apply twice | Preserve baseline or require reconciliation; repeated apply is idempotent. |
| T30 | Crash midway through file application/DB update | Recover by recorded pre/target manifests; pipeline does not advance prematurely. |
| T31 | Closed topic, reopening, deleted chat message | Task decisions retained; old approvals cannot reactivate. |
| T32 | Older worker/newer schema, downgrade with pending commands | Unsupported action refused; no destructive migration or reinterpretation. |
| T33 | Backup restored while task owned by another worker | Reconcile remote head/epoch before any start; stale backup cannot reacquire ownership. |
| T34 | Integration disabled or participant revoked | Future remote starts rejected; local stop usable; offline revocation limitation visible. |
| T35 | Cancel queued/start-racing work; resume after executor-imposed pause | Pending starts invalidated and any spawned process reconciled; requester resume cannot clear executor's hold. |
| T36 | Review/apply races request-changes or source reacquisition | One shared transition wins before source files change; partial application keeps source ownership and the task paused. |

Acceptance must trace back to [B01-B29](user-flows.md#8-lifecycle-decision-coverage)
and [I01-I12](protocol.md#1-invariants). Add a test for any newly discovered branch
before treating its implementation as complete. Unit tests that merely duplicate
conditionals are insufficient for crash/race guarantees; use independent process
and repository fixtures to exercise actual boundaries.

## 5. Enterprise readiness within the chosen scope

Enterprise-grade is a release claim requiring evidence, not a reason to introduce
more servers. The baseline remains one trusted team and local execution.

| Area | Required before enterprise release |
| --- | --- |
| Threat model | Trace untrusted Telegram input, hostile task files/prompt injection, stolen device/bot keys, Git tampering and confused-authority paths. Document host-admin trust and offline revocation limits. |
| Secret management | Local protected storage, minimal process environment, redaction, no secrets in provider prompts/task artifacts/URLs in logs; test real tool isolation. |
| Audit | Append-only action/decision IDs with signer, actor evidence, version, outcome and timestamps; protected remote history. Do not claim administrator-proof immutability. |
| Data policy | Team approves Telegram summaries, permitted repository audience, storage region, retention and deletion procedures. Git clones/backups and Telegram copies mean deletion is not automatically global. |
| Observability | Per-task/command correlation; inbox/outbox backlog age; last Git sync; worker observation age; stale decisions; failed starts/applications; no raw prompt content as default metrics. |
| Reliability targets | Benchmark notification, discovery, resume and recovery latency under documented online conditions; team chooses SLOs after measurements. No universal 24/7 guarantee while worker hosts sleep. |
| Operations | Named owner for each bot/workstation and project remote; documented rotate/revoke/re-pair, missed-update recovery, failed-transfer and unknown-process procedures. |
| Backup and restore | Back up local journals/rosters and protected shared records; validate restore against live ownership before enabling workers. Encrypt/protect backup secrets. |
| Upgrade and rollback | Version negotiation, additive migrations where possible, preserved pending commands and disabled unsupported actions. Rollback cannot restore expired grants or remove holds. |
| Emergency controls | Local remote-control disable, local stop independent of internet, and key/participant revocation. No outage-driven takeover bypass. |
| UX | Test requester/executor on phones, expired buttons, accessibility, task/topic separation, and accurate delivery-versus-execution language. |

## 6. Change-execution checklist

1. Read all four design documents; identify affected decisions, branches and
   invariants in the implementation task. Resolve contradictory requirements in
   docs before changing behaviour.
2. Implement the smallest phase slice using existing services. Preserve local
   user edits and existing task/provider semantics outside the explicit changes.
3. Keep all Telegram publishing, remote Git mutation and live agent execution
   disabled by default. Tests use isolated fakes/fixtures until authorized setup.
4. Verify the slice's relevant acceptance scenarios plus existing affected tests
   and type checks. UI changes also require local design guidance and interaction
   checks. Do not claim unrelated existing lint failures were introduced or fixed.
5. Record actual supported provider/runtime/auth versions and G01-G04 evidence.
   Unresolved gates must be visible in capability status, not buried in comments.
6. Update these docs and release notes with implemented versus deferred behaviour.
   Mark the phase complete only when runtime evidence meets its exit criteria.

## 7. Evidence still required

At this implementation checkpoint, no Telegram bot has been connected, no peer
handoff protocol has been implemented, no remote deployment has been configured,
and no provider delegation or security boundary has been certified. The docs are
ready to guide phased implementation; they are not evidence that G01-G04 passed.

Do not convert undecided governance values into fabricated requirements. G04
requires the team to choose storage location and retention before enterprise
deployment. This does not block local development or the other specifications.

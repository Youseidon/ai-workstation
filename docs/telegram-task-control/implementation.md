# Implementation plan and release evidence

Parent: [Design baseline](README.md). Contracts: [User flows](user-flows.md) and
[Protocol](protocol.md). Do not start a broad refactor to implement these modules.
The design itself grants no permission to deploy, push branches, configure live
bots, send messages or run another person's subscription.

## 0. Current implementation status

Team track TM1 defaults accepted by jd, 2026-09-17:

- Team action cards expire after 10 minutes.
- An item grant lasts until it is revoked, the item thread closes or handover starts.
- A join code is single use and expires after 24 hours.
- An item id is short and opaque. Its group tag is built from that id and follows C1's tag rules.

The corresponding implementation scenarios are in
[`tm1.md`](../e2e-scenarios/tm1.md). LT-3, the real two-person join check, is
parked until the full team build at jd's direction.

Team track TM0/TM1 close-out before audit 1, 2026-09-17:

- Scope closed here: TM0 harness and TM1 team/roster evidence through T10. T10
  is a close-out/documentation task only; audit 1 runs immediately after its
  tracker completion.
- TM0 automated evidence from the tracker:
  - T01 `node --import tsx e2e/scripts/lt1-two-bots-group.ts`: H-TM-LT1 PASS.
    Both administrator bots reported `can_read_all_group_messages=false`; both
    received plain commands, addressed commands, replies to either bot message
    and unanchored discussion. The fake and design were corrected to model this
    broad administrator delivery.
  - T02 `git diff --check main...tm/T02-tm0-scenario-table`: passed; `npm run
    typecheck`: passed; `docs/e2e-scenarios/tm0.md` has jd skim approval.
  - T03F `node --import tsx --test --test-concurrency=1
    e2e/src/tm0.selftest.test.ts`: passed. `npm run typecheck`: passed.
    `npx playwright test e2e/src/h2-fake-provider-inline.spec.ts`: 4/4 passed
    after restoring the fake-provider launcher executable bit. Full T1:
    `npm run e2e` passed 113/113 in 16.5 minutes.
  - T04 `node --import tsx --test --test-concurrency=1
    e2e/src/tm0.fake.contract.test.ts`: passed. This is 1 node-test covering
    S-TM0-03, S-TM0-04 and S-TM0-05: group roster/admin rights, pinning,
    one-use invites and broad administrator delivery. The TM0 self-test and
    workspace typecheck also passed.
- TM1 automated and live evidence from the tracker:
  - T05 `node --import tsx e2e/scripts/lg1-repository-refs.ts`: H-TM-LG1 PASS
    against the repository jd approved for disposable probes. Custom
    `refs/aw/*` refs were accepted, a divergent non-fast-forward update was
    rejected, an `aw/handover/*` branch was accepted and both probe refs were
    deleted.
  - T06 `git diff --check`: passed. `docs/e2e-scenarios/tm1.md` records jd's
    skim approval, the four defaults above and LT-3 deferred until the full
    build.
  - T07 `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t07-verify node --import
    tsx --test --test-concurrency=1 server/src/teamRoster.test.ts`: focused T0
    roster suite passed 4/4 at the time; `npm test --workspace server` passed
    237/237; `npm run typecheck`: passed.
  - T08 `node --import tsx --test --test-concurrency=1
    server/src/telegramLiveRuntime.test.ts`: focused runtime suite passed
    23/23, including TM-T1-1a's group command, administrator-rights,
    local-confirmation and temporary bare-remote roster path. Full server suite
    passed 237/237; `npm run typecheck --workspace server` and `npm run
    typecheck --workspace web` passed.
  - T09 sandboxed rerun of `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t09-verify
    node --import tsx --test --test-concurrency=1 server/src/teamRoster.test.ts`
    failed with `spawnSync git EPERM`; the unsandboxed rerun
    `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t09-verify-escalated node
    --import tsx --test --test-concurrency=1 server/src/teamRoster.test.ts`
    passed 5/5. `npm run typecheck --workspace server`: passed. `npm run
    typecheck --workspace web`: passed.
- T10 reruns in this worktree:
  - This worktree was created without dependencies. Initial `npm run typecheck
    --workspace server`, `npm run typecheck --workspace web` and
    `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t10-roster node --import tsx
    --test --test-concurrency=1 server/src/teamRoster.test.ts` failed before or
    at dependency loading because `tsc`/`tsx` and type packages were absent.
  - After linking the already-installed local dependency tree with `ln -s
    /home/junaid/ai-workstation/node_modules node_modules` (no network install),
    `npm run typecheck --workspace server`: passed; `npm run typecheck
    --workspace web`: passed.
  - Sandboxed `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t10-roster node
    --import tsx --test --test-concurrency=1 server/src/teamRoster.test.ts`
    exited `ERR_TEST_FAILURE` with no subtest detail. Unsandboxed
    `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t10-roster-unsandboxed node
    --import tsx --test --test-concurrency=1 server/src/teamRoster.test.ts`
    passed 5/5: TM-T0-3 join-code round trip/tamper/expiry, TM-T0-4 in-memory
    compare-and-swap, TM-T0-4 Git compare-and-swap to `refs/aw/team`,
    TM-T0-3 single-use invite consumption and TM-T0-5 migration 24 group-actor
    duplicate protection.
  - `team.enabled` remains default-off by absence: the settings file exposes
    only `taskControl.enabled`, `taskControl.notificationsEnabled` and
    `taskControl.remoteActionsEnabled`, all with `fallback: false`; no
    `team.enabled` setting or live token/identifier was added.
- Not rerun by T10: full server suite and full T1 suite. Cite existing tracker
  summary only: T07/T08 full server suite passed 237/237, and T03F full T1
  passed 113/113. There is no verified 239/239 full-server count in this
  close-out evidence.

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

Implemented ninth slice (L1 live personal Telegram control, RTC-17 to RTC-19, with first RTC-20 evidence):

- `server/src/integrations/telegram/httpBotApi.ts` implements `TelegramBotApi` against api.telegram.org: 25s `getUpdates` long polling, `sendMessage`, `answerCallbackQuery` and `getMe`.
  There is no webhook.
  Errors are classified as rate limited (Telegram `retry_after`), transient, unauthorized, conflict or rejected, and every thrown error is rebuilt from a token-redacted message without the raw fetch error or its cause.
- Raw updates are normalized before persistence to task-related fields only (callback reference, sender, chat, message, reply target, text).
- `credentials.ts` reads `TELEGRAM_BOT_TOKEN` once at boot and deletes it from `process.env`, so spawned agent processes do not inherit it.
  The token object redacts itself under string conversion, JSON serialization and inspection.
  The token is not in settings, the database, API responses, DTOs or the UI.
- `runtime.ts` supervises the live transport from server startup and on every settings change.
  It runs only when task control is enabled, the transport is `telegram` and a token was supplied; otherwise it makes no network call.
  It provides long polling with backoff, a durable outbox sender with per-row retry schedules and a bot-wide pause on 429, a notifier that posts each waiting task once per question revision, local-confirmed pairing, and status for the Agents panel.
- Answer flow: the question card asks for a reply; the reply produces an answer card whose Save answer and Answer and resume buttons submit exactly that text.
  Telegram callback data cannot carry the text, so it is bound to the action references.
  Card actions are rebound to the real Bot API message id after sending.
  Expired, stale or wrong-message taps are rejected with a durable receipt and the current question is reissued.
- `TaskControlService` validation, receipts and revision binding are unchanged.
  The adapter gained optional hooks, a retry schedule and one behaviour change: a deterministic `WorkspaceError` rejection, such as remote actions being disabled, is recorded and marked processed instead of blocking the inbox.
- Migration 20 adds `telegram_outbox.next_attempt_at`, `telegram_outbox.sent_message_id` and `telegram_action_content`.
- Local API: `GET /api/task-control/telegram`, pairing `POST`/`DELETE /api/task-control/telegram/pairing`, `POST /api/task-control/telegram/pairing/confirm`, and `DELETE /api/task-control/telegram/actors/:id`.
  The Agents page adds a Live Telegram panel with status, paired chats and pairing.
- Found and fixed during live testing: a 2500ms per-address connect attempt at startup (Node's 250ms default failed every Bot API call on a network without IPv6), and blocked-task phone cards now show the latest blocker remark.

Verification on 2026-09-14:

- `AGENT_CONSOLE_REPO_ROOT=<isolated tmp root> npm test --workspace server` passed 155 tests: the 141 existing tests unchanged, including the fake-transport suites, plus 14 new L1 tests.
  A later renderer regression test was verified to fail before its fix and pass after it (22 task-control, adapter and runtime tests passing).
- New tests were mutation-checked: removing environment scrubbing, error redaction, message-id binding, the rate-limit pause, duplicate-tap detection or unknown-actor filtering each makes a test fail.
- `npm run typecheck` passed for shared, server and web; `npm run test:quota-ui --workspace web` passed 8 tests; `npx eslint` passed for the touched frontend files.
- The real server and web app were run in an isolated root with only api.telegram.org routed to an in-process stub: pairing, question, reply, Save answer, Resume with saved answer and duplicate tap behaved as designed, the token was absent from logs, API responses and the database, and SIGTERM stopped the long poll and exited in 215ms.
  Screenshots at 1440px were checked for the connected, waiting-for-code, observed-identity and paired panel states.
- Live, with the operator's own bot and phone: connection, pairing, and a saved Codex task that blocked on an owner decision, was answered and resumed from the phone, and finished DONE using the answer.
  Record H-L1-05 in `human-verification.md` has the timeline.

L1 is not complete.
RTC-20 still requires live Save answer then Resume with saved answer, and the offline workstation cases; see the pending rows H-L1-06 to H-L1-17 in `human-verification.md`.

Known gaps:

- With Host access off, Claude saved-task runs are instructed to `curl` their context, which `acceptEdits` refuses; this predates L1.
- FIXED 2026-09-16: Telegram-originated answers are labelled in the task timeline.
  Applied task-control receipts are now exposed on human-response remarks as `source: "telegram"`; ordinary local/browser human responses remain `source: "local"` and keep the `USER · HUMAN_RESPONSE` label.
  The task activity UI renders Telegram-sourced human responses as `Telegram · HUMAN_RESPONSE`.
  Evidence:
  - `npx -y npm@11 install` completed: added 496 packages, audited 501 packages, 0 vulnerabilities.
  - `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-l1d1-human-input-final node --import tsx --test --test-concurrency=1 server/src/humanInput.test.ts server/src/telegramAdapter.test.ts` passed: 2 tests, 2 pass, 0 fail.
  - `npm exec --workspace web -- node --import tsx --test components/recovery.test.tsx` passed: 1 test, 1 pass, 0 fail.
  - `npm run typecheck --workspace shared` passed.
  - `npm run typecheck --workspace server` passed.
  - `npm run typecheck --workspace web` passed.
  - `npm run lint --workspace web` passed with 0 errors and 5 pre-existing warnings in `web/components/pipeline/PipelineHeader.tsx`.
- The bot token in `.env` is readable by any process running as the same user; this is the G02 isolation limit and is not addressed by L1.

Rollback/default-off behavior:

- Setting the transport back to Fake Telegram, disabling task control, or removing the token stops all Bot API traffic and leaves task state untouched.
- Migration 20 is additive; older code ignores the new columns and table.

L1D3 precondition cleanup (dev reload check), 2026-09-16:

- The L1 step 7a note that `npm run dev` stopped reloading after repeated restarts was not reproducible on current main.
- Added `scripts/check-dev-reload.mjs`, a local-only regression probe. It starts the root `npm run dev`, waits for the server and web app, edits `server/src/index.ts` so `/api/health` returns a unique `devReloadProbe` token, edits `web/app/page.tsx` so the rendered page contains the same unique token, verifies both changes without manual restart, stops the root dev command, restores the files and repeats.
- Added `WEB_PORT` support to the root `dev:web` script so this check can use unused local ports while preserving the default web port of 3000. The server port is still controlled by the existing `PORT` environment variable.
- Verification: `npx -y npm@11 install` completed in the L1D3 worktree; `DEV_RELOAD_STARTS=6 DEV_RELOAD_SERVER_PORT=4300 DEV_RELOAD_WEB_PORT=3300 node scripts/check-dev-reload.mjs` passed with `PASS 6/6 repeated npm run dev starts reloaded server and web source changes`.
- No live Telegram, provider execution, harness run or remote mutation was performed.

Implemented tenth slice (step 7a defect: Claude saved-task runs through typed progress tools):

- Scenario table: [`scenarios/claude-sdk-tools.md`](scenarios/claude-sdk-tools.md), 31 rows written by a separate test-design pass before implementation.
- `server/src/agentProgressApi.ts` now owns the agent Progress API rules: credential authentication, scope match, read-only role refusal, context, state, remarks and status.
  The HTTP route in `index.ts` and the new tools both call it, so the rules cannot drift apart.
- `server/src/adapters/claudeProgressTools.ts` defines `get_context`, `post_remark` and `post_status` with `tool()` and `createSdkMcpServer()`; refusals come back as readable tool errors carrying the same code as HTTP.
- Adapters declare `supportsProgressTools`; only Claude does. `startExecute` binds the tools to the run credential for saved-task execute runs on such adapters and passes them through `startRun` to the adapter.
  Consult, clarify and handoff runs get no tools.
- The Claude run prompt carries the reporting contract and names the tools; it contains no `curl`, bearer token or API URL. `get_context` returns the work item only.
  A first live smoke showed why: when reporting instructions arrived only inside a tool result, Claude Haiku treated them as a possible prompt injection and stopped.
- Permission mode, sandbox and Bash rules are unchanged; the tool path is used with Host access on or off. Codex, Grok and Cursor keep the HTTP or inline path.
- `zod` is a direct server dependency (installed with npm 11 to match the lockfile format).

Verification on 2026-09-14:

- `AGENT_CONSOLE_REPO_ROOT=<isolated tmp root> npm test --workspace server` passed 169 tests, including 13 new tool tests and a consult test rewritten from a source-text check into a behaviour check.
- A targeted mutation check removed MCP registration, the read-only role check, the tools-only context form, the request id schema and credential authentication; each made a test fail.
  One surviving mutant exposed a dead branch, which was removed.
- `npm run typecheck` passed.
- Real Claude (Haiku 4.5) through `ClaudeAdapter` with `acceptEdits`, Host access off, an isolated database and real tool bindings: a small file task called `get_context`, posted PROGRESS and VERIFICATION remarks and DONE, with no Bash call, no permission denial and no run token in the stored history.
  A second task that needed owner credentials also reported through the tools, but Haiku judged it DONE after writing the draft rather than BLOCKED; that is model judgement, not transport, and BLOCKED through the tool is covered deterministically in T0.
- Not yet run: the T3 harness scenarios S-CLT-02, S-CLT-03, S-CLT-27 and S-CLT-29 (real Claude with the phone), which run in harness slice H6.

Harness evidence for L1 (harness slices H5 and H6, [`docs/e2e-harness-plan.md`](../e2e-harness-plan.md)), 2026-09-15:

- Scenario tables: [`l1.md`](../e2e-scenarios/l1.md) (32 rows) and [`h6.md`](../e2e-scenarios/h6.md) (36 rows), each from a separate test-design pass.
- T1 (fake Telegram, fake agent): the full suite passed 68 of 68.
  Burn-in ran every L1 and H6 T1 scenario 20 times: 820 of 820 passed.
  `coverage-matrix.mjs --scope S-L1 --tiers T1`: no must gaps; should rows S-L1-20, S-L1-26 and S-L1-30 are not implemented.
- T0: server 179 passed; e2e 39 passed, with S-H6-30 blocked until a real contract recording exists.
- Real providers: dry runs of S-CLT-02, S-L1-31 (Claude Haiku 4.5) and S-L1-32 (Codex, gpt-5.5) on the fake Telegram passed.
  They found that Codex cannot use gpt-5.4-mini on a ChatGPT account and that the block check accepted a SYSTEM fallback; both were fixed.
- T3 (real Telegram): not run.
  Every T3 row is blocked on the operator's one-time setup ([`e2e-live-setup.md`](../e2e-live-setup.md)); `npm run e2e:live` lists them as blocked.
  The L1 Live column stays Pending until a T3 run and the phone look check.

Implemented eleventh slice (L3 F1 and F2, RTC-21: outbox edits and topic-aware replies):

- Scenario table: [`l3-f1-f2.md`](../e2e-scenarios/l3-f1-f2.md), 40 rows from a separate test-design pass.
  Its six operator questions were answered with the table's recommendations, pending the operator's review: a harness-only edit trigger; a deleted-target edit counts as one failed row; topic-bound actor paths are T0 until C2; a reply from the wrong topic stays silent; a reply to a closed or deleted topic fails once and is never redirected; unpairing drops queued edits.
- Migration 21 adds `operation` (`send` or `edit`), `target_outbox_id` and `payload_version` to `telegram_outbox`; existing rows become sends unchanged.
- `enqueueTelegramEdit` addresses a send row of the same bot, so an edit cannot target another chat's or bot's message.
  A queued or retrying edit of the same message is replaced, not stacked; a retrying edit keeps its schedule.
  A delivery that raced a newer edit leaves the row queued, so the newest content is always sent last.
- An edit waits until its send has a message id, and fails without a Bot API call when the send failed for good.
- `editMessageText` exists on the live client and the fake transport; "message is not modified" is success, and the other 4xx responses are permanent.
- Replies (hints, pairing notices, tap results, the unpair notice) go to the chat and topic they answer; replies to cards still resolve only to send rows.
- Harness-only routes under `/api/task-control/telegram/harness/outbox` queue a send and edits of it; they do not exist outside `AGENT_CONSOLE_HARNESS=1`.
- Tests: 9 new server tests for F1 (including a migration from a rebuilt version 20 database), 5 new runtime tests for F2, and 14 T1 scenarios for F1 through the route proxy.
  F2's forum topic rows run at T0; the T1 topic rows (S-L3-F2-02, 03, 07, 10 to 13, 15) need a topic option on `PhoneDriver.send`, and S-L3-F2-14 is blocked on C0.

Implemented twelfth slice (L3 F3, RTC-22: task summary model):

- Scenario table: [`l3-f3-a.md`](../e2e-scenarios/l3-f3-a.md) (F3 rows) from a separate test-design pass.
  F3's operator questions were answered with defaults pending review:
  - a brief counts only if it completed after the latest execute run started;
  - the position is the suite flowchart step, shown whether or not a pipeline run is active;
  - "If you wait" has five fixed lines (no pipeline, waiting, paused, stopped, saved answer held);
  - redaction was widened to `ghp_`, GitHub fine-grained tokens, bearer tokens, bot tokens and scheme-less or `0.0.0.0` local addresses;
  - the workstation label allows up to 64 characters on one line, and empty means the hostname.
- `server/src/telegramSummary.ts`: `taskSummary(promptId, "owner")` returns breadcrumb, title, objective, completed work, verification counts, human blockers with required actions, decisions, important files, recommendation and "If you wait", from the latest current READY brief, else the latest BLOCKER or DECISION_NEEDED remark, else the title alone.
  It reads the operations snapshot, handoffs and prompt history only, never the all-runs session loader, and writes nothing.
- Line and block text forms share one redaction; the L1 card sanitizer uses it too. Caps never split a surrogate pair and declare the shortening.
- Setting `taskControl.workstationLabel` (Task Control group, default hostname).
- Tests: 10 server tests (F3-01 to F3-13 T0), one T1 spec for the label on the Agents page (burn-in 20 of 20), full T1 85 of 85 with L1 unchanged (S-L3-F3-15).
- Found and fixed on the way, in their own commits: the Agents page showed no error for a refused setting save, and web lint failed on the harness build directory.

Implemented thirteenth slice (L3 A, RTC-23: context-rich question cards):

- Scenario table: [`l3-f3-a.md`](../e2e-scenarios/l3-f3-a.md) (A rows).
  Operator questions answered with the table's recommendations, pending review:
  - never shortened: breadcrumb, title, "If you wait" and the reply hint;
  - blockers are kept whole up to a per-item cap, listed while they fit (the first always), and the rest declared;
  - the answer on answer cards is shown in full above the recommendation, and shortened last with a note that the buttons submit it in full;
  - the L1 card locators became one helper (`isCardFor`), with no assertion weakened;
  - a message whose entities Telegram rejects is resent once without them;
  - no real-provider handoff (S-L3-A-20) until close-out.
- `server/src/integrations/telegram/card.ts` renders the F3 summary general to specific within 4096 UTF-16 units. Details (decisions, important files, full completed list) go in one `expandable_blockquote` entity with UTF-16 offsets. When too long, the card shrinks in the spec's order and says what it shortened. Cuts never split surrogate pairs, ZWJ sequences or combining marks.
- Card payloads carry the summary taken when the card was queued; rows queued by L1 keep the L1 layout.
- Harness: `PhoneMessage.entities` on both drivers; the fake Telegram server enforces the text length and entity bounds; the fake agent can post a BLOCKER-kind remark and returns handoff briefs as plain output.
- Tests: 8 formatter tests (T0), 10 T1 scenarios (burn-in 200 of 200), a T3 spec for A's live rows, full T1 95 of 95 with L1 unchanged.
- Findings for the operator:
  - the handoff parser caps each brief list at 30 items, so a card reports "30 passed" for a brief with more checks;
  - every blocked task records a BLOCKER remark (from the status reason), so a title-only card cannot occur today (S-L3-A-03 is T0 only).

Implemented fourteenth slice (L3 B, RTC-24: read-only status commands):

- Scenario table: [`l3-b.md`](../e2e-scenarios/l3-b.md) (42 rows).
  Operator questions answered with defaults pending review:
  - `/quota` shows the last cached usage and never fetches;
  - `done` means COMPLETE with last activity in the past 24 hours (the snapshot has no completion time);
  - `blocked` is AWAITING_RESPONSE only, and WAITING_DEPENDENCY and SKIPPED appear in no list;
  - plain text keeps its L1 first sentence as the start of `/help`, with no buttons, so no L1 test changed;
  - only registered commands take priority over a card reply, so `/usr/local is fine` is still an answer;
  - an unknown `/tasks` filter shows the filter buttons, a bare `/task` shows help, commands are case-insensitive, and a command for another bot is ignored;
  - navigation edits only messages the bot sent as views;
  - `/task` uses the card budget;
  - views answer whatever Remote actions and Notifications are set to;
  - "as of" is local time, with the date when not today;
  - views show workspace names only.
- `server/src/integrations/telegram/views.ts`: a registry of pure views over the operations snapshot, F3 summaries and cached usage. It covers `/status`, `/tasks [filter]`, `/running`, `/blocked`, `/pipelines`, `/quota`, `/task <key or id>` (with a picker for ambiguous keys) and `/help`, paginated at 10 items. The same list feeds `setMyCommands`.
- Navigation buttons carry `nv_` data of at most 64 bytes that encodes the target view, so they work after a restart. Taps are routed before task control (never a receipt) and edit the view message through the F1 edit path, so bursts coalesce.
- The runtime parses registered commands after the actor check and before the reply check. Unpaired chats and strangers get nothing.
- Tests: 7 registry tests (T0), 11 T1 scenarios (a mutation that sends views instead of editing them is caught), and a T3 spec for B's live rows.
- Not implemented from the table: rows needing a usage seam (S-L3-B-08), completion-time seams (S-L3-B-06), recorded Bot API limits (S-L3-B-30), fault-injection variants for navigation (S-L3-B-19, 31, 34), topics (S-L3-B-40, blocked on C2), and several should rows.

Implemented fifteenth slice (L3 A2, RTC-22 and RTC-23: a card the operator can decide from):

- Scenario table: [`l3-a2.md`](../e2e-scenarios/l3-a2.md) (14 rows), deliberately lean because the operator asked for minimal testing on this slice.
  Its open questions were answered by the operator before implementation:
  - options belong to the blocking status, not the task, so a new block replaces them and a stale list never reaches a later question;
  - the phone gets the last three runs and the most recent previous answer, with a count of the rest;
  - at most four options, each advantage or disadvantage capped at 200 characters, every cut declared;
  - the age reads "blocked 14 min ago" and is computed at delivery, not stored;
  - the identifier on the card is its tag, whose id half is a word `/task` already accepts, and the summary also carries the task key for the same purpose;
  - the tag is project-scoped (`#acme_t142`) so two projects never share one, and it always contains a letter because Telegram makes no hashtag of `#123`.
- The card (`server/src/integrations/telegram/card.ts`) is now labelled sections in the order a phone reads them: the tag; `Task: <title>`; the age and breadcrumb; the question and its required action; the options with their trade-offs; the operator's answer on answer cards; the recommendation and "If you wait"; the reply hint; then one `expandable_blockquote` holding context ("where it fits", goal, progress), history and details.
  A section with no data is absent entirely, not an empty heading.
- The summary (`server/src/telegramSummary.ts`) gained `key`, `tag`, `blockedAt`, `breadcrumb.nextStep`, `history` and `options`.
  History reads the existing run, status-event and remark records; nothing new is stored for it.
  The tag is a hashtag-safe project slug (at most 16 characters, disambiguated with the workspace id when another project's name reduces to the same slug, compared without case because Telegram matches hashtags that way) and the task's own id after a `t`.
  The id, not the task key, carries the identity: a key can repeat across programs, and `/task` already offers a picker when it does, so a key-based tag would name more than one task.
- The progress contract gained an optional `options` list on a BLOCKED `post_status`, over HTTP and through the in-process Claude tools, named in both run prompts.
  Migration 22 stores it on `prompt_status_event`. Options are reported by the agent only: no model is called while a card is rendered, and no trade-off is generated.
- Budget: the shrink order is details, history, context, recommendation, then blockers after the first, then the answer, and only as a last resort the options, so the question, its action and the options survive. Every shortening is declared as before.
- Tests: 2 new formatter tests and 8 new summary and contract tests at T0 (server suite 229 of 229), and 3 new T1 scenarios, S-L3-A2-11, 12 and 13 (full T1 110 of 110 in 15.2 minutes; burn-in of the three new rows 9 of 9 at the default 3 repeats).
  The slice A scenarios were updated where A2 deliberately changed the layout, with no behavioural assertion weakened.
- Findings for the operator:
  - S-L3-A-01 and S-L3-A-02 could not be kept literally unchanged: A2 moves the goal and progress into the collapsed section and adds a header, so their line-by-line layout assertions were rewritten. Every assertion about buttons, receipts, runs, human responses, redaction and `parse_mode` is unchanged, and the L1 rows (S-L1-05, 06, 18) needed no edit because `Task: <title>` is still the card's second line.
  - The phone now sees two entities on a card: the app's blockquote and the `hashtag` Telegram adds for the tag. The bot still sends exactly one entity and no `parse_mode`.
  - A run whose status post is refused ends without a status, so the system blocks the task itself; such a block has no options, which is the right outcome but means a rejected `post_status` still costs the agent its run.
- Not implemented from the table: S-L3-A2-13a's real-Telegram half and S-L3-A2-14 (both need the test bot), and nothing else was deferred.

Implemented sixteenth slice (L3 C1, RTC-25: thread registry and a chat organised without topics):

- Scenario table: [`l3-c1.md`](../e2e-scenarios/l3-c1.md) (8 rows), deliberately lean because the operator asked for minimal testing on this slice, and adding no tier, driver capability or fake.
  C0 is blocked on Telegram, so this slice is the no-topic organisation of the flat chat, not a step towards C2.
- Migration 23 adds `telegram_thread(bot_id, chat_id, subject_kind, subject_id, topic_id, status_message_id, state, created_at, updated_at)` with one row per subject per chat, plus `telegram_outbox.thread_id`.
  `subject_kind` is `task` or `workstation`; `pipeline` and the L2 kinds are added when they exist.
  `status_message_id` holds the outbox row carrying the subject's anchor, not a Bot API id: that row already records the delivered message id, so the registry never keeps a second copy of it that could disagree.
- Every enqueue now names its subject, and the thread decides the destination. Topics are unavailable to this bot, so every subject resolves to the paired chat with `topic_id` null, which is exactly L1 behaviour; a reply still lands in the topic of the message it answers, so F2 is unchanged and C2 can fill the column later.
- Every message about a task carries that task's tag, appended as its own last line, from A2's `taskTag` (through a new `taskTagFor(promptId)`); the tag is never re-derived here. Workstation messages (pairing, help, views, unpair, quota) carry none.
- The first question card for a task is registered as that task's anchor. Later messages for the task are sent with `reply_to_message_id` set to it, resolved at delivery from the anchor row's recorded message id, so a row queued before the anchor was delivered still quotes it. Result and receipt messages are always their own replies, never edits of the anchor.
- `/status` maintains the chat's one control panel: the first one is registered and pinned once, and every later `/status` brings it up to date in place through the F1 edit path. The pin is attempted exactly once per panel and a refusal is only logged, so it can never fail the message.
- Recovery: an edit that fails permanently (the operator deleted the message) marks that subject's anchor gone, as does a send that fails permanently; the next message for the subject is registered as the new anchor and, for the workstation, pinned again.
- `TelegramLiveStatus` gained `topics: { available, note }`, and the Live Telegram panel says topics are not available for this bot and how the chat is organised instead.
- Tests: 4 new T0 tests in `telegramLiveRuntime.test.ts` covering the registry, the tag, the anchor and replies, the pin and the deleted-panel recovery (server suite 233 of 233), and 3 new T1 scenarios, S-L3-C1-10, 11 and 12 (full T1 113 of 113 in 15.7 minutes, with S-L1-05, S-L1-06, S-L1-18, S-L3-A-01, S-L3-A-02, S-L3-A2-11, S-L3-A2-12 and S-L3-B-12 unchanged; burn-in of the three new rows 9 of 9 at the default 3 repeats).
  The fake Telegram server gained `reply_to_message_id` (with `allow_sending_without_reply`) and `pinChatMessage`, mirroring the Bot API; no new tier, driver capability or fake was added.
- Findings for the operator (also recorded as questions 1 and 2 of the table):
  - "The question card is the task's living status, edited in place through its lifecycle" cannot be taken literally without rewriting rows the operator required to keep passing: S-L1-05 and S-L1-06 wait for a new answer card, S-L1-11 for a new card when the question changes, S-L3-A-01, S-L3-A-02 and S-L3-A2-11 for a new card once a brief arrives, and S-L1-09, S-L1-10 and S-L1-13 tap buttons on older cards that an edit would strip. This slice therefore anchors the first card and replies to it, and edits only the control panel in place.
  - The same applies to `/status`: one panel edited in place versus the B rows that expect a reply to every command. The command still answers with its own message, and the pinned panel is refreshed in place alongside it.
  - Two T0 assertions on the exact text of a result message became `startsWith`, because the tag is now a line below it. No behavioural assertion was weakened.
  - The reply uses `reply_to_message_id` with `allow_sending_without_reply`, the form the plan names; current Telegram also offers `reply_parameters`. A T3 recording should confirm the form before C2.
- Not implemented from the table: nothing was deferred at T0 or T1; S-L3-C1-13 is the existing suites passing again, not a test of its own.

L1 T3 close-out (real Telegram through the harness test bot and the operator's signed-in client), 2026-09-15/16:

- The first T3 runs found differences between the fake and real Telegram, fixed in the harness and the fake (commits cad5b04 to c1c7723):
  - slow IPv4 connects to Telegram;
  - the real client's chat filter, and its refusal to send empty text;
  - Telegram's 15-second window for answering a callback;
  - Telegram's own message entities;
  - uncollected taps dropped about 2.5 minutes after they are made, with S-L1-15 and H-L1-08 fitted to it;
  - the S-H6-30 fake aligned with a 25-step real recording.
- They also found two product races, both fixed (9168074, cb74fce): a reply or tap that arrives before its card's `sendMessage` returns now waits for the delivery in progress instead of being answered "That message is not a task question".
- Full T3 run: 61 of 61 scenarios passed in 43.4 minutes.
  S-H6-36 still fails: the runtime is over its 25-minute target, and 24 L3 T3 rows have no test yet.
- After cb74fce: real Claude (Haiku 4.5) and Codex (gpt-5.5) scenarios passed 3 of 3; server tests 219 of 219.
- Burn-in on real Telegram: driver rows S-H6-01 to 08 and 10 passed 180 of 180 (20 repeats); proxy rows S-H6-11, 12, 13/14 and 16 passed 15 of 15 (3 repeats, 2026-09-16). S-H6-15 is T0 only.
- Full T1 after cb74fce: 107 of 107 (2026-09-16).
- `human-verification.md` records T3 PASS for 27 H-L1 and H-L3 rows. Their Live column stays Pending until the operator's phone look check (S-H6-33).
- Open operator decision: a tap made while every polling workstation is offline for more than about 2.5 minutes is lost silently.

L1D2 precondition cleanup (Agents header negative-zero display), 2026-09-16:

- `CountUp` now normalizes only JavaScript negative zero at the presentation boundary, including initial render, animation rounding and custom `format` callbacks. Meaningful negative values such as `-1` still render as negative.
- The Agents header `available` stat continues to pass its provider count through `CountUp`, so page-load and transition renders cannot produce `-0 AVAILABLE`.
- Pre-fix failure probe: `node --input-type=module -e "import assert from 'node:assert/strict'; assert.equal((-0).toLocaleString(), '0');"` failed with `AssertionError [ERR_ASSERTION]: '-0' !== '0'`.
- Focused tests: `npm run test:quota-ui --workspace web` passed 3 test files, 3 of 3 subtests, including the new `CountUp` negative-zero regression.
- Web checks: `npm run typecheck --workspace web -- --tsBuildInfoFile /tmp/l1d2-web.tsbuildinfo` passed; `npm run lint --workspace web` passed with 0 errors and 5 existing warnings in `web/components/pipeline/PipelineHeader.tsx`.

L1D4 precondition cleanup (Telegram configured-without-token badge), 2026-09-16:

- Current code already applies the live token state from commit b39ae1c: when Task Control settings use live Telegram but no boot-time token was loaded, `withLiveTokenState` reports setup `telegram_missing_token` with a `TELEGRAM_BOT_TOKEN` reason instead of leaving the settings-derived `telegram_configured` value.
- The Agents badge map renders `telegram_missing_token` as "Telegram token missing"; "Telegram configured" remains only the label for the true configured setup.
- Added a minimal UI regression test for the badge map; no product behaviour changed.
- Verification:
  - `npx -y npm@11 install` completed in the L1D4 worktree after one sandboxed DNS failure; the approved rerun added 496 packages, audited 501 packages, 0 vulnerabilities.
  - `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-l1d4-token-badge-rerun node --import tsx --test --test-concurrency=1 server/src/taskControl.test.ts` passed: 1 test file, 1 of 1 pass, 0 fail.
  - `npm run test:quota-ui --workspace web` passed: 4 test files, 4 of 4 pass, 0 fail, including `components/agents/badge.test.tsx`.
  - `npm run typecheck --workspace server` passed.
  - `npm run typecheck --workspace web` passed.

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

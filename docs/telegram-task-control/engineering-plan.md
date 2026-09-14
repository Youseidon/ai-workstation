# Executable engineering plan

Parent: [Design baseline](README.md). Contracts: [User flows](user-flows.md),
[Protocol](protocol.md) and [Implementation evidence](implementation.md).
Repository standards: [Engineering standards](../engineering-standards.md).

This plan is documentation only. It does not approve live Telegram setup, Git
publication, provider subscription delegation, security certification or
runtime implementation. Previous completion claims are accepted only where the
current source and tests support the claimed behaviour.

## 1. Baseline

| Requirement area | Status | Evidence and discrepancy |
| --- | --- | --- |
| Local saved answer and explicit resume | Implemented and verified by code/test inspection | `humanInput.ts`, `workspaces.ts`, `pipelineScheduler.ts`, `HumanInputDialog.tsx` and `humanInput.test.ts` cover Save answer, Answer and resume, saved-answer retry, stale revision rejection and duplicate submissions. These are local UI/API workflows, not Telegram workflows. |
| Revision-bound local question submission | Implemented and verified by code/test inspection | `humanInputState()` hashes prompt, latest decision/event, handoff and hold state; save requires `expectedRevision`. Legacy local `respondToBlockedPrompt` callers may omit a revision and therefore are not remote-control safe. |
| Persistent local answer hold | Implemented and verified by code/test inspection | SQLite migration 15 adds `human_response_hold`; prompt readiness and pipeline end handling respect it. This is not the shared epoch/ownership protocol. |
| Pipeline resume preservation after local answer | Implemented and verified by code/test inspection | The scheduler resumes owning suite/named pipelines and preserves saved holds on failed resume. This does not establish cross-workstation delegation or crash-safe orphan-process reconciliation. |
| Provider detection, settings and account usage telemetry | Partially implemented | Existing adapters expose availability, permission display and usage where providers support it. There is no capability contract for billing attribution, subscription delegation, quota-window applicability, process supervision or secret isolation. |
| Local handoff brief/successor workflow | Partially implemented | `handoffCoordinator.ts` can run an LLM handoff and start a local successor. It is not Task Transfer: it lacks factual no-LLM package capture, shared Git records, named teammate acceptance and return/apply review. |
| Workspace/run concurrency | Implemented (M2) | Migration 19 adds `workspace_start_intent` with a unique active index on effective directory; `reserveStartIntent` runs before awaited provider detection and is shared by all start paths. Verified by aliased-path race tests. |
| Startup recovery | Implemented for ownership (M2/M2d); process proof still absent | `reconcileStartIntentsForRestart` classifies unreleased intents as `START_UNKNOWN`, recovery refuses them, and `classifyStartUnknown` lets an operator record known-stopped/no-spawn to release the gate. The app still cannot itself prove an OS subprocess stopped; that remains an operator confirmation, not a machine fact. |
| Telegram enrollment, polling, inbox/outbox and rendering | M1 complete with fakes | Shared task-control contracts, SQLite migrations 16-18, settings-backed capability, fake pairing, durable fake inbox/cursor records, sanitized rendering and a durable outbox queue exist. No live Telegram client, real long-poll daemon, real setup/pairing UX or real device enrollment is implemented. |
| Remote actor authorization and command receipts | M1 complete with fakes | Opaque action references, fake callback validation, adapter-side fake callback dispatch and idempotent receipts exist for personal Save answer and Answer and resume. Real Bot API callback receipting and shared-command publication are not implemented. |
| Quota advisor | Implemented (M2/M2b) | `quotaAdvisor.ts` evaluates real `collectAccountUsage()` telemetry behind `/api/providers/usage` with freshness, window/reset dedupe and advisory-only choices; rendered in the Agents UI. It never pauses, switches provider or spends. Delivery to a phone is still fake-outbox only, pending L1. |
| Shared Git control history and package/result refs | Not implemented | No administrative checkout, roster validation, signed control branches, package manifests, result application or force-rewrite detection exist. |
| Named teammate transfer | Not implemented | No offer, claim, receiver-local policy comparison, isolated checkout, return/apply or further-handoff lifecycle is implemented. |
| Personal-subscription teammate execution | Blocked by external evidence | Gate G01 requires provider-supported delegation and quota/billing evidence. Development may use fixtures, but affected production execution must remain disabled. |
| Provider/runtime secret isolation for unattended team execution | Blocked by external evidence | Gate G02 requires tested isolation for provider, bot, Git and signing credentials. Existing same-user file modes or prompt rules are insufficient evidence. |
| Remote integrity and governance | Blocked by external evidence | Gates G03-G04 require Git host policy, signing verification, roster authority, data audience, storage, retention and owner decisions. |
| CI workflows | Not implemented in this checkout | No `.github` directory exists locally. Mandatory checks must therefore be documented and run manually until CI is added. |

Observed discrepancies:

- The README correctly labels the Telegram task-control design as a planned
  enhancement, not an available feature.
- `implementation.md` says all server tests and frontend checks passed on
  2026-09-13, but this plan did not rerun DB-backed tests because current tests
  load the repository database path. Treat that as prior evidence to preserve,
  not fresh verification.
- Existing "handoff" code and incident reports describe local successor runs.
  They must not be counted as Telegram control, teammate takeover, Git transfer
  or subscription-sponsored execution.
- Current provider availability can report a CLI as available even when a
  selected model fails at execution time; quota/advisor work must preserve the
  exact runtime cause instead of collapsing it into a generic blocker.

## 2. Remaining requirement traceability

| ID | Requirement | Benefit and observable behaviour | Decisions/invariants | Gap and dependencies | Acceptance evidence | Milestone |
| --- | --- | --- | --- | --- | --- | --- |
| RTC-01 | Feature gates and setup state | Users can enable notifications/control intentionally; disabled integrations reject queued remote starts with clear status. | D01, D03, I01, B01 | M1 fake scope complete: shared capability status, default-off settings, a capability API endpoint and settings-page controls exist. Real pairing/setup UX remains a live-integration task. | Current evidence: disabled-by-default capability test, dynamic settings-backed capability test and disabled remote-action rejection. | M1 |
| RTC-02 | Telegram pairing and roster identity | Only enrolled Telegram users/bots can act; usernames are labels only. | D02, D04, I01, B02-B03 | M1 fake scope complete: fake actor records, pairing challenge expiry/replay/context checks and wrong actor/chat/topic/bot validation exist. Real device replacement UX and roster audit remain for live setup. | Current evidence: fake pairing, expiry, replay, wrong actor, wrong bot and wrong topic tests. | M1 |
| RTC-03 | Durable Telegram inbox/outbox | Offline/retry behaviour is visible and no update is lost before offset advancement. | D15, I03, B07 | M1 fake scope complete: durable outbox rows, failed-send state, durable inbox rows, polling cursor, fakeable Bot API adapter and callback dispatch exist. Live long-poll daemon and provider throttling policy remain future work. | Current evidence: fake send timeout/failure/retry state, duplicate update handling, offset advancement after persistence and fake E2E callback processing. | M1 |
| RTC-04 | Personal task action routing | A Telegram answer maps to the current question and can Save answer or Answer and resume once. | D11, I07-I08, B08-B12 | M1 fake scope complete: adapter-dispatched callbacks route into `humanInput` through action validation; legacy local API remains separate. Real Bot API callbacks remain disabled until live setup/gates. | Current evidence: fake E2E task saves, reissues current actions, resumes once; duplicate and stale callbacks rejected. | M1 |
| RTC-05 | Task status rendering | Phone status separates execution, decision and receipt state without leaking raw logs. | D13, I12, B05, B07 | M1 fake scope complete: sanitized question payload separates execution, decision and receipt status. Rich status age rendering remains for live transport polish. | Current evidence: rendered fake question payload redacts localhost/secret-looking content and omits raw transcript/run internals. | M1 |
| RTC-06 | Atomic effective-directory reservation | UI, pipeline, retry, recovery and Telegram starts cannot race in aliased workspaces. | I02, I08, protocol section 6 | Add durable reservation/start-intent before async provider checks; use realpath/effective directory. | Race tests for UI versus Telegram/provider discovery; crash before/after spawn. | M2 |
| RTC-07 | Process supervision and crash reconciliation | The app does not release ownership or retry blindly when process state is unknown. | D15, I02, I12, B13, B23 | Track process identity outside task files; classify START_UNKNOWN; operator recovery path. Depends on RTC-06. | Parent-exit/child-running and restart tests. | M2 |
| RTC-08 | Quota advisor | Low fresh quota warns and offers choices without pausing, spending or delegating automatically. | D07, D14, I04, B06 | Build `quotaAdvisor.ts` over account usage with freshness/window identity and dedupe. | Fresh/stale/missing/reset/multi-task tests; no automatic state mutation. | M2 |
| RTC-09 | Factual checkpoint preview | A user can freeze/review transferable files and context without using remaining LLM quota. | D05-D06, I06, protocol section 9 | Add package manifest capture preserving worktree/index; reject unstable, unsupported or secret-containing candidates. Depends on RTC-06/07. | File, binary, staged, symlink, hook, LFS/submodule and mutation-during-capture tests. | M3 |
| RTC-10 | Shared Git enrollment and integrity | Cross-workstation state is durable, ordered, signed and protected from replay/rewrites. | D05, I03, I06, G03 | Add administrative checkout, roster pinning, signed control commits, fast-forward update/retry logic. Depends on external G03 for production. | Fake remote tests for conflict, uncertain push, rewritten history, invalid signature and old schema. | M3 |
| RTC-11 | Named offer and receiver claim | A named teammate can accept and run on their workstation without second requester approval. | D08-D10, I01-I03, I11, B17-B20 | Add offer/claim records, receiver discovery, local policy comparison and preparation states. Depends on RTC-09/10 and provider capability model. | Two isolated installs with fake providers publish, discover, accept and start one task. | M4 |
| RTC-12 | Provider capability and permission contract | Incoming tasks run only within enforceable local limits; unknown access remains waiting. | D09-D10, I05, I10-I11, G01-G02 | Extend adapter contracts for billing attribution, effective permissions, quota scope, process observation and secret isolation status. | Capability matrix; tests for within-limit, delta prompt, hard deny and unknown enforcement. | M4 |
| RTC-13 | Mid-run shared questions | The requester can answer the executor bot while the source workstation is offline. | D13, I07, B09-B12, B22 | Shared question/answer records, executor bot rendering and resume validation. Depends on RTC-10/11. | Offline source test with current executor receiving answer and resuming once. | M5 |
| RTC-14 | Return, review and apply | Returned work is inspected and applied once by requester, without overwriting divergence. | D12, I06-I09, protocol section 10 | Add result refs, apply intent, manifest comparison, integration checkout and pipeline hold reconciliation. | Apply, apply-twice, divergence and crash-mid-apply tests. | M5 |
| RTC-15 | Further handoff, cancel and close | One task conversation survives blockers, revisions, cancellation and later takeovers. | D13, I02, B25-B29 | Epoch advancement, approval invalidation, topic close best-effort reporting and lifecycle recovery. | Further-handoff, cancel-race, closed-topic and revocation tests. | M5 |
| RTC-16 | Backup, restore and rollback | A local SQLite database holding all task history can be recovered after corruption, bad migration or failed upgrade. | D01 | Add a documented and exercised backup/restore path for the app database, plus per-migration rollback notes. | Restore a backup into an isolated root and confirm task/run history survives a simulated bad migration. | M6 |
| RTC-17 | Live Telegram Bot API client | Messages actually reach the operator's phone instead of an in-memory fake. | D02, D15, protocol section 7 | Implement `TelegramBotApi` against real `getUpdates` long-poll and `sendMessage`; persist updates before advancing the offset, durable retry with server-specified backoff, never log tokens embedded in Bot API URLs. | Live smoke test against a real bot; rate-limit/429 and network-failure handling; duplicate update rejection. | L1 |
| RTC-18 | Live bot credential and pairing setup | An operator can enrol their own bot without pasting a secret into a UI label field or a committed file. | D01, D02, G02 | Add real token storage outside the settings label field and outside git; real pairing/enrolment against a live chat ID reusing existing challenge validation. | Token never appears in API responses, logs, DTOs or the database dump; pairing rejects a wrong chat/actor live. | L1 |
| RTC-19 | Live adapter runtime wiring | The adapter actually runs: today `TelegramAdapter` is instantiated nowhere outside its own test. | I03, D15 | Instantiate and supervise the adapter in server startup when transport is live and a token is configured; reconnect/backoff lifecycle and visible transport status; default-off preserved. | Server start/stop with transport live and disabled; reconnect after forced network failure; no polling when unconfigured. | L1 |
| RTC-20 | Live personal operation evidence | The capability is judged by a real delivered message, not a fixture. | D16 | Record a real end-to-end operation: question posted to the operator's phone, button tap, local state change. | One live run evidencing Save answer and Answer and resume from the phone, plus the observed failure behaviour when the workstation is offline. | L1 |
| RTC-21 | Telegram message edits and topic-aware replies | A status or navigation message updates in place instead of stacking new messages; a reply lands in the topic it answers. | D15, D17, protocol section 7 | The Bot API wrapper has only `sendMessage`; `enqueueText` hardcodes `topicId: null`. Add an outbox edit operation and pass the incoming topic through. | Fake and stubbed-HTTP tests: edit coalescing, "message is not modified" treated as success, edit of a deleted message, reply routed to the incoming topic. | L3 |
| RTC-22 | Task summary model | Every phone surface describes a task from the same structured facts. | D17, B21 | No shared summary exists; the question renderer reads only title, status and question text. Build a pure model over the handoff brief, blocker remarks and pipeline position. | Fixture tests: brief present, brief absent with blocker remark, no pipeline, pipeline step, sanitized fields. | L3 |
| RTC-23 | Context-rich question cards | A phone question card carries enough context to decide without the laptop. | D17, user-flows section 2 | The card drops the stored `HandoffBrief`; `sanitizeTelegramText` flattens line breaks and cuts at 1200 characters. Render from RTC-22 with a section budget. | Formatter tests for section priority under the 4096 limit, expandable detail entity offsets (emoji, non-Latin), no markup parsing, graceful fallback without a brief. | L3 |
| RTC-24 | Read-only status commands | The operator can ask what is running, blocked or failed and drill down, without any state change or LLM call. | D17, user-flows section 9, B30 | Only `/start <code>` and replies are handled; every callback goes to task control. Add command parsing, a view registry and a separate navigation callback route. | Command and navigation tests for each view, unpaired actor ignored, navigation never produces a receipt, pagination under the size limit, `setMyCommands` registration. | L3 |
| RTC-25 | Thread registry | Every phone message belongs to a subject (a task or the workstation) that maps to one thread. | D17, user-flows section 1 | No subject-to-thread mapping exists. Add a registry with a no-topic mode that preserves today's behaviour. | Registry tests: subject lookup, no-topic mode unchanged from L1 behaviour, status message id tracked per subject. | L3 |
| RTC-26 | Per-task topics | Each task has its own topic with a pinned status message; workstation-wide messages have their own topic. | D04, D17, user-flows section 1, protocol section 7 | Topic support in a private bot chat is unverified; pairing refuses topics and actor lookup matches `topic_id` exactly. Requires the C0 live check first. | Live C0 record; fake tests for lazy creation ordering, closed/reopened topics, deleted-topic recreation and private-chat actor authorization across topics. | L3 |

Product questions to keep separate from engineering defaults:

- G04 governance: Telegram audience, Git host/storage location, retention,
  operational owner and enterprise data policy.
- Whether any provider supports teammate-sponsored subscription execution under
  the requested model. Do not substitute paid API execution for D14.
- Which providers/configurations pass G02 for unattended team execution.

Engineering defaults:

- Use fake Telegram and fake Git remotes for implementation tests until setup is
  explicitly authorized.
- Store shared contracts in versioned shared schemas; reject unknown required
  versions.
- Keep all new integration capabilities default-off and surface gate status in
  capability responses.

## 3. Milestones

### M1: Personal Telegram Control Foundation

Status: complete for local fake-service personal task control. Live Telegram
setup and production use remain disabled by external/setup gates.

Scope: RTC-01 through RTC-05 for saved tasks only. Exclusions: teammate transfer,
Git publication, quota advisor and custom/ad-hoc prompt persistence.

Entry criteria: accepted design docs, local standards adopted, fake Telegram
provider available, no live bot token required.

Tasks and files:

- Add integration settings and capability status in `server/src/settings.ts`,
  `workspaceApi.ts`, `shared/src/index.ts` and setup UI.
- Create `server/src/integrations/telegram/` with fakeable Bot API client,
  durable inbox/outbox migrations, polling loop and renderer.
- Create `server/src/taskControl/` for action references, actor validation,
  question revision checks and idempotent command receipts.
- Wire personal actions to `humanInput.ts`; keep old local endpoints compatible
  but not usable as remote authority.

State/API/permission changes: additive SQLite migrations for bot/device/person,
Telegram message, action and receipt records; local-only setup endpoints; no
internet-facing generic REST API.

Failure/retry/recovery: persist updates before offset advancement; retry sends
with backoff; duplicate callbacks resolve to the same receipt; stale actions
re-render current choices; offline bot never claims execution happened.

Tests/gates/rollback: fake Telegram unit and integration tests plus affected
server tests, `npm run typecheck`, `npm run build --workspace server`,
`npm run lint --workspace web` if UI changed. Rollback is disable integration
settings and leave local questions intact.

Definition of done: a fixture saved task posts a question, accepts Save answer,
then later Answer and resume starts exactly one local run. Wrong actor/chat/topic,
duplicates, stale revision and send failure are demonstrably handled.

### M2: Local Execution Safety and Quota Advisor

Scope: RTC-06 through RTC-08. Exclusions: shared Git transfer and production
delegation claims.

Entry criteria: M1 merged; current start paths inventoried; provider usage
semantics documented per adapter.

Tasks and files:

- Add durable effective-directory reservations and START_INTENT records in
  `workspaces.ts`, `runService.ts`, `pipelineScheduler.ts` and recovery paths.
- Extend `activeRuns`/`runner` supervision enough to distinguish known stopped,
  known no-spawn and START_UNKNOWN.
- Implement `server/src/quotaAdvisor.ts`, state records and UI/Telegram warnings.

Behaviour: reservation occurs before awaited provider detection; every resume and
retry path checks holds/reservations. Quota warnings are advisory only, deduped by
account/window and stale after the configured freshness interval.

Tests/gates/rollback: race tests across UI/pipeline/Telegram starts, crash
reconciliation fixtures and account-usage edge cases. Rollback keeps the old
start paths disabled for remote actions if reservations fail.

Definition of done: two concurrent start requests for aliased workspace paths
produce one durable start intent; 5% fresh quota warning presents choices and
does not mutate execution state without explicit action.

### M3: Checkpoint and Shared Control Storage

Scope: RTC-09 and RTC-10. Exclusions: receiver execution and result application.

Entry criteria: M2 safety in place; private Git remote policy documented for
fixtures; package schema approved.

Tasks and files:

- Add `server/src/taskTransfer/` for factual package capture, manifest hashing,
  unsupported artifact detection and private administrative Git checkout.
- Add shared schemas for package, task, offer, event and roster records.
- Implement signed fast-forward control updates, fetch/validate/retry and
  uncertain-push reconciliation.

Behaviour: publish immutable package objects before OFFERED; never mutate the
developer branch/index/remote; reject force-rewritten or unsupported histories.

Tests/gates/rollback: isolated repository fixtures for worktree/index states,
malicious paths/hooks, push races and signature/schema failures. Production
cross-workstation use remains disabled until G03 is satisfied.

Definition of done: local package preview and fixture remote OFFERED record can
be created and validated, but no teammate starts from it yet.

### M4: Named Teammate Claim and Receiver Execution

Scope: RTC-11 and RTC-12. Exclusions: result apply and enterprise release.

Entry criteria: M3 complete; G01/G02 status recorded for the selected provider
or fake provider used for development.

Tasks and files:

- Add receiver discovery and Accept/Decline rendering through the receiver bot.
- Implement local permission comparison, grantable delta prompts and hard-deny
  handling.
- Create isolated receiver checkout and start the linked task with recorded
  effective permissions and provider capability evidence.

Behaviour: named receiver acceptance is sufficient to start only when current
offer/package/deadline/roster/local policy all validate. Busy receivers queue and
revalidate before start.

Tests/gates/rollback: two-install fixture tests with fake providers; provider
capability tests for billing attribution and secret isolation. If G01/G02 are
unresolved, production receiver execution stays disabled while fixtures pass.

Definition of done: two isolated local installations publish, discover, accept
and start one checkpoint under receiver-local policy. No paid/live provider run
is used as evidence for subscription delegation.

### M5: Shared Questions, Return, Apply and Further Handoff

Scope: RTC-13 through RTC-15. Exclusions: enterprise deployment claims.

Entry criteria: M4 complete; result schema and apply recovery design approved.

Tasks and files:

- Add shared question/answer records and executor-bot resume handling.
- Implement result refs, return publication, review/apply UI, apply intent,
  integration checkout and manifest reconciliation.
- Add epoch advancement for further handoff, cancellation and close/reopen flows.

Behaviour: requester answers bind to current question and task revision even when
source workstation is offline. Apply is idempotent and refuses divergence rather
than overwriting unrelated work.

Tests/gates/rollback: offline source answer, partial result, apply twice,
divergence, crash-mid-apply, further handoff and cancel-race fixtures. Rollback
must preserve source holds and shared records.

Definition of done: requester reviews and applies a returned result once; partial
or failed results remain accurately labelled and do not advance the pipeline as
complete.

### M6: Durability and Release Checks

Scope: RTC-16 plus repeatable checks for whatever capabilities are enabled.

Entry criteria: the capabilities being released are implemented and evidenced.

Tasks and files:

- Add an exercised backup/restore path for the app SQLite database and
  per-migration rollback notes.
- Add CI workflows running the existing typecheck/lint/test commands, or record
  why the manual equivalent is sufficient for a single-operator tool.

Behaviour: unresolved gates block only affected capabilities and are visible to
users. Passing tests alone is not security or provider eligibility evidence.

Tests/gates/rollback: relevant T01-T36 acceptance scenarios for enabled
capabilities; a restore drill against an isolated database root.

Definition of done: a corrupted or bad-migrated database can be restored with
task history intact, and the enabled capability set has repeatable checks.

Removed from this milestone on 2026-09-14 as ceremony for a single-operator
local tool: threat-model document, operational runbook, separate gate-evidence
documents, provider-specific certification paperwork and a published release
report. `implementation.md` already is the evidence record; G01-G04 already
carry their own required evidence. Reinstate these only if this tool is ever
released to people other than its operator.

## 3a. Live enablement track (L)

The L track carries the work that turns the fake transport into a real one. It
is deliberately numbered separately from M1-M6 because it does not sit in that
dependency chain: L1 depends only on M1 and M2, both complete, so it is
buildable now, while L2 is blocked behind the transfer machinery of M3/M4.
L3 depends only on L1 and is buildable before L2; it is numbered after L2 only because it was planned later.

### L1: Live Personal Telegram Control

Scope: RTC-17 through RTC-20, for one operator and their own bot. Exclusions:
group topics, teammate offers, Git transfer, any second workstation.

Entry criteria: M1 and M2 complete (both are); operator has created a bot and
holds its token. No other gate applies (D16).

Gates: G01-G03 do not apply, as no teammate, subscription delegation or shared
remote is involved. G04 does not apply per D16; the data audience is the
operator's own private chat.

Tasks and files:

- Implement a real `TelegramBotApi` in `server/src/integrations/telegram/`
  alongside the existing fake, selected by configuration.
- Add real token storage and enrolment; keep `taskControl.botId` as the label
  field it already is and never put the secret there.
- Wire and supervise `TelegramAdapter` in server startup, which today runs
  nowhere outside its own test.

Behaviour: the existing `TaskControlService` validation, receipts, revision
binding and sanitisation are unchanged and already tested; only the transport
becomes real. Default-off is preserved; an unconfigured install polls nothing.

Tests/gates/rollback: existing fake-transport tests continue to run unchanged as
the regression suite; new coverage for 429/backoff, reconnect and offset
durability against a stubbed HTTP layer. Rollback is switching transport back to
fake or disabled, which leaves all local task state untouched.

Definition of done: a real message from the operator's own bot arrives on the
operator's own phone; a button tap there performs Save answer and, separately,
Answer and resume, evidenced by an actual local run. A fixture does not satisfy
this milestone.

### L2: Live Group Telegram Surface

Scope: the shared group/topic surface for teammate work: offer visibility,
receiver Accept/Decline rendering and shared status in a project topic.

Entry criteria: L1 complete, plus M3 and M4, since there is no assignment to
render and no receiver to accept until packages and claims exist.

Gates: G01, G02, G03 and G04 all apply here in full.

Definition of done: an offer published by M3/M4 machinery is visible in the team
topic and a named receiver's acceptance starts exactly one linked task on their
own workstation. Not startable until its entry criteria are met.

### L3: Personal Telegram Surface

Planned 2026-09-14.
L1 made the phone reachable; L3 makes it usable.
It serves three goals: enough context on the phone to make an informed decision, one clean thread per item, and a way to ask the workstation what is happening.

Scope: RTC-21 through RTC-26, for one operator in their own private chat.

Exclusions (queued as follow-ups after L3, see the end of this section): starting tasks or pipelines from the phone, a Stop control, asking the agent for clarification, LLM free chat, handoff brief version 2, group topics (L2).

Entry criteria: step 7a complete, per its own rule.
L1 work committed, so L3 diffs review on their own.
F1 and C2 change the outbox and actor lookup that the L1 rows exercise, so the L1 harness scenarios (T1 per slice, T3 at close-out) must pass again after each of those slices; the harness makes this automatic rather than a manual repeat.

Gates: G01-G04 do not apply (D16, D17).
No slice starts a run, spends quota or widens what an actor may change.

#### Code facts this plan is built on (checked 2026-09-14)

- `HandoffBrief` (`shared/src/index.ts`) already stores objective, completed and pending work, verification passed/failed, blockers with `requiredAction`, decisions and assumptions and a recommendation. The phone card uses none of it.
- `renderPersonalQuestion` and `sanitizeTelegramText` (`server/src/taskControlRenderer.ts`) send title, status and question only, collapse all whitespace and cut at 1200 characters.
- `TelegramBotApi` (`server/src/integrations/telegram/botApi.ts`) has `sendMessage` only; every card is a new message.
- `enqueueText` (`server/src/integrations/telegram/runtime.ts`) hardcodes `topicId: null`.
- `taskControlActorFor` (`server/src/workspaces.ts`) matches `topic_id IS ?` exactly, and pairing refuses messages sent in a topic.
- `TelegramAdapter.processPendingCallbacks` sends every callback to `taskControl.handleCallback`; a callback that is not an action reference would be answered "Not applied".
- Action references are `tc_` plus 24 base64url characters.
- `workspaces.sessions()` loads every event of every run and must not back a phone command; use `operations()` for lists and `latestRunActivity()` for one task.
- No workstation label setting exists.
- `topicOf` (`server/src/integrations/telegram/httpBotApi.ts`) reads `message_thread_id` only when `is_topic_message` is true; its behaviour for private-chat topics is unverified.

#### Slices, in build order

**F1: outbox edit operation (RTC-21).**
Add `editMessageText` to `LiveTelegramBotApi`, `HttpTelegramBotApi` and the fake.
Outbox rows gain an operation (`send` or `edit`); an edit targets the `sent_message_id` of an earlier row.
Queued edits to the same message coalesce to the latest.
Telegram's "message is not modified" response counts as success; an edit to a message that no longer exists is recorded as failed without retry.
Existing rows migrate as `send`.

**F2: topic-aware replies (RTC-21).**
`enqueueText` takes the incoming message's `topicId`, so every reply lands in the thread it answers.

**F3: task summary model (RTC-22).**
Add a pure `taskSummary(promptId, audience)` in `server/src/telegramSummary.ts` (or alongside the renderer).
It returns structured, sanitized fields: breadcrumb (workstation label, workspace, program/suite, pipeline step x/y), objective, completed work, verification counts, blockers with required action, decisions and assumptions, recommendation, and a deterministic "if you wait" line derived from the pipeline rule.
Source order: latest READY handoff brief, then the latest BLOCKER or DECISION_NEEDED remark, then the task title alone.
`audience` is `owner` only for now; it is the hook for L2 team cards, which must hide account quota (user-flows section 3).
Add a workstation label setting, defaulting to the OS hostname.
Split sanitization into a line form (collapse whitespace) and a block form (keep line breaks, cap per section); both keep the existing secret and localhost redaction.

**A: context-rich question cards (RTC-23).**
Render `personal_question` from F3 per user-flows section 2.
Allocate the 4096-character budget by priority: breadcrumb, blocker and action text first, then recommendation, then completed work and verification, then objective, then decisions.
Long detail goes in an `expandable_blockquote` message entity; still no `parse_mode`, so task text can never inject markup.
The formatter returns entities with UTF-16 offsets.

**B: read-only status commands (RTC-24).**
Implement user-flows section 9.
`handleMessage` parses `/command` after the actor check and before the reply-to check; unknown commands and plain text get `/help`.
Views live in a registry (`server/src/integrations/telegram/views.ts`): each entry is a name, arguments and a pure function over `OperationsSnapshot` plus F3, returning a formatted message. The same registry feeds `setMyCommands`.
Navigation buttons use the `nv_` callback prefix (protocol section 7). The adapter routes `nv_` callbacks to a new `onNavigation` hook before task control; the hook checks the actor, answers the callback and edits the message through F1.
`/task` renders the same F3 summary as the question card.

**C0: live topic check (RTC-26). Operator involvement required for BotFather settings only.**
Against the harness test bot (never the operator's own bot), before any C1/C2 code: the operator enables topics for the bot in BotFather; the rest is scripted with the harness's real-Telegram backend: call `createForumTopic` in the private chat, send with `message_thread_id`, edit and close a topic, delete a topic, reply from the user client inside a topic, and record the exact update fields received.
The recorded responses become contract fixtures for the fake Telegram server's topic support.
Record the result in `implementation.md`.
If private-chat topics are unsupported, the design already names the fallback (user-flows section 1): a private group containing only the operator and the bot, with topics. Do not fall back to one flat multi-task chat.

**C1: thread registry (RTC-25).**
Add a migration for `telegram_thread(bot_id, chat_id, subject_kind, subject_id, topic_id, status_message_id, state, created_at, updated_at)`.
`subject_kind` is `task` or `workstation` now; `pipeline` and L2 kinds can be added later.
Every enqueue resolves its destination through `threadFor(subject)` instead of choosing a topic.
Until C2 is enabled, every subject resolves to the paired chat with no topic, which is exactly L1 behaviour; the Live Telegram panel reports "topics not set up".

**C2: per-task topics (RTC-26).**
Create a task topic lazily, on that task's first phone message; name it with the task key and title, capped at 128 characters.
A `create_thread` outbox operation precedes rows for that subject; those rows wait for the topic id and are held, not sent to General, if creation fails.
Close the topic when the task reaches COMPLETE or SKIPPED; reopen it if the task becomes active again.
If the operator deletes a topic, mark the thread gone and recreate it once on the next message.
Workstation-wide output (quota warnings, commands sent outside a task topic, `/help`) goes to one Workstation topic.
Change actor authorization and pairing per protocol section 7: a private-chat actor is authorized in every topic of that chat; group actors stay topic-bound, so the M1 wrong-topic tests keep their meaning.
A reply to a card must arrive in that card's thread.

#### Tests, gates and rollback

Fake-transport and stubbed-HTTP tests for every slice; the existing L1 fake suite stays the regression suite.
If the end-to-end harness ([`docs/e2e-harness-plan.md`](../e2e-harness-plan.md)) exists by then, each slice also adds its H-L3 scenarios to it: T1 per slice, T3 and the phone look check at close-out.
Run `npm run typecheck`, the affected server tests with an isolated `AGENT_CONSOLE_REPO_ROOT`, `npm run build --workspace server`, and `npm run lint --workspace web` if the setup panel changes.
Add live rows H-L3-* to `human-verification.md` as each slice lands.
Rollback: commands and cards are formatter changes and revert cleanly; C2 is behind a setting and turning it off returns every subject to the paired chat without a topic.

#### Definition of done

On the operator's real phone: a blocked task's card shows workstation, workspace, pipeline position, objective, progress and blocker, without opening the laptop; `/status` and `/tasks blocked` answer from current state and drill down to `/task` by button in one edited message; the task's messages live in its own topic, which closes when the task completes.

#### Queued follow-ups, not part of L3

Plan these after L3 is done, in this order:

1. Status message and Stop control in each task thread (finished, failed, needs recovery). Stop goes through receipts and revision checks and never claims a stop before the local runner confirms it (D15).
2. Ask the agent: a read-only consult on a question card, showing which provider answers and capping the answer length.
3. Starting from the phone: Run from `/tasks`, Play from `/pipelines`, quota choices as buttons. Requires an explicit provider choice on the card and the durable start-intent reservation. Requires the Claude Host-access defect (step 7a) to be fixed.
4. Handoff brief version 2 with an optional `options` field (label and consequence per option), so cards can show choices and their consequences; needs handoff prompt changes.

LLM free chat was considered and dropped on 2026-09-14: the operator's need ("what's running?") is answered deterministically by section 9 commands without quota or invented answers.

## 4. Critical path and feasibility experiments

Critical path: RTC-01 → RTC-02 → RTC-03 → RTC-04 establishes the personal
control *logic*, but against a fake transport it delivers nothing to a phone and
is therefore not yet useful to an operator. RTC-17 → RTC-19 (L1) is what makes
that logic reachable, and it is the shortest path to the first genuinely useful
capability. Cross-workstation work is a separate chain: RTC-06/07 safety (done)
before RTC-09/10 storage, then RTC-11/12 receiver execution, then RTC-14 apply,
with L2 rendering it in a group topic only once those exist.

High-risk experiments to run before building broad surfaces:

- Provider delegation and billing: determine whether the selected provider
  supports G01 without sharing credentials or switching to paid API execution.
- Secret isolation: prove G02 for bot/Git/signing/provider credentials under the
  exact supported permission modes.
- Git remote integrity: verify protected refs, force-push/deletion prevention
  and SSH signing verification with the chosen host.
- Process supervision: demonstrate START_UNKNOWN handling for crash before spawn,
  after spawn and parent-exit/child-mutating cases.

Next implementation-ready milestone: L1. M1 and M2 are complete, so L1 is
unblocked today and is the only remaining work between the current state and an
operator actually controlling tasks from their phone. Building it requires no
gate resolution (D16), only a bot token its operator creates.

Update 2026-09-14: L1 is implemented and in live verification (steps 6-7a).
The next implementation-ready milestone after the step 7a close-out is L3, starting with slice F1.

A note this plan got wrong the first time: building M1 entirely against fakes
was reasonable for proving the ownership, revision and receipt logic, but
leaving the live transport unscheduled meant the feature could not reach a user
at all. Fake-first is a testing strategy; it is not a delivery milestone. Future
milestones that stub an external dependency must schedule the real one in the
same plan revision.

## 5. Execution steps to completion

Use this sequence to take the design to a working, released capability. Stop at
each evidence gate; do not silently continue into the next production capability
when its gate is unresolved. A step is not complete because its code exists: it
is complete when its stated evidence exists.

Commit discipline for this plan:

- Commit by coherent milestone or reviewable sub-slice, not by incidental edit
  order. Separate design/standards, migrations/contracts, runtime behaviour,
  tests and evidence docs when doing so improves review clarity.
- Never include unrelated workspace edits merely because they are present in the
  working tree. Inspect `git status --short` and the staged diff before each
  commit, and preserve user changes that are outside the active slice.
- A commit that changes behaviour must include its relevant fake-service tests,
  schema/API contract updates and documentation evidence unless there is a
  recorded reason to split them.
- Keep unfinished integrations default-off in the same commit that introduces
  their contracts or persistence, so a checkout at any commit does not expose a
  half-enabled external capability.
- Do not commit live tokens, provider credentials, Telegram identifiers from a
  real chat, private remote URLs, local database files or generated test
  artifacts. Production/external setup evidence belongs in redacted docs only.

Steps removed on 2026-09-14 as process ceremony that produced no artifact: a
plan-approval step and an issue-creation step (this repository has no issue
tracker), and a final "publish a release report" step duplicating
`implementation.md`. Completed steps are kept for sequence, marked DONE.

1. Prepare isolated test infrastructure. DONE.
   A repeatable way to run server tests against a temporary app database via
   `AGENT_CONSOLE_REPO_ROOT`, plus fake Telegram/provider adapters. This is a
   prerequisite for any claim of verified behaviour.

2. Implement M1 behind disabled local settings. DONE.
   Build setup state, Telegram pairing, durable inbox/outbox, personal task
   rendering and Save answer / Answer and resume routing for saved tasks only.
   Use fake Telegram tests first. Do not configure a live bot unless explicitly
   authorized.

3. Verify and review M1. DONE.
   Evidence recorded: wrong actor/chat/topic rejection, replay/expiry handling,
   send retry recovery, save-only without provider, resume-once behaviour and no
   raw transcript/secret/localhost leakage. Passing M1 does not imply teammate
   transfer is implemented, nor that any message reaches a phone.

4. Implement M2 local safety. DONE, including M2b/M2c/M2d continuations.
   Effective-directory reservation, durable start intent, START_UNKNOWN
   classification and recovery, and quota advisor state, shared by UI, pipeline,
   retry, recovery and Telegram entry points.

5. Verify and review M2. DONE.
   Evidence recorded: concurrent aliased-workspace starts produce one attempt,
   crash-before/after-spawn cases are classified, parent-exit/child-running is
   not released automatically, and 5% quota warnings never pause, switch provider
   or request takeover without explicit action.

6. Implement L1 live personal Telegram. IMPLEMENTED, NOT YET COMMITTED.
   Implement the real Bot API client, real token storage and enrolment, and
   adapter startup wiring. Keep the fake transport as the regression suite. The
   operator supplies the bot token; do not generate, request or store a live
   credential without an explicit instruction to do so.
   Code and automated evidence are recorded in `implementation.md` (ninth slice).

7. Verify L1 against a real bot. IN PROGRESS.
   Required evidence: a real message received on the operator's phone, Save
   answer and Answer and resume each driving one real local run, correct
   behaviour when the workstation is offline, and no token in any log, API
   response, DTO or database dump. Fixtures cannot satisfy this step.
   Recorded so far (2026-09-14): a real message on the operator's phone, pairing, and Answer and resume driving one real local run to DONE (H-L1-05).
   Remaining rows are tracked in `human-verification.md` (H-L1-06 to H-L1-17).

7a. Close out L1 before step 8.
    Do these before starting the G01-G03 feasibility experiments or any enhancement of the Telegram integration.
    Items are grouped by who has to act; none of them requires a gate decision.

    Operator decisions:

    - Commit the L1 work in reviewable pieces: the L1 change (server, shared, web, tests, `.env.example`), the unrelated env-var wrapping fix in `web/components/SettingField.tsx` as its own commit, and the documentation updates.
    - Decide whether the Live Telegram panel should appear as soon as the transport is Telegram, instead of only after task control is enabled and saved.
      Today the page gives no feedback until both are saved, which made setup look unresponsive.
    - Superseded 2026-09-14: the one-off stubbed-Telegram app harness is not kept as a script; the end-to-end harness ([`docs/e2e-harness-plan.md`](../e2e-harness-plan.md)) replaces it.

    Live verification (completes step 7):

    - H-L1-06: Save answer, then Resume with saved answer, each from the phone.
    - H-L1-07 and H-L1-08: workstation offline for less than, and more than, 10 minutes.
    - H-L1-17: token sweep of logs, API responses and the real database after live use.
    - The remaining rows (H-L1-09 to H-L1-16) are high value but not required to close RTC-20; run them where practical.
    - Decided 2026-09-14: these rows run through the end-to-end harness in [`docs/e2e-harness-plan.md`](../e2e-harness-plan.md), built after the L1 commit (slices H0 to H6), instead of by hand.
      The harness runs each row on a fake Telegram and on real Telegram through a dedicated test bot and an automated client on the operator's account.
      Evidence rule for this step, approved by the operator: a real-Telegram harness run (T3) plus the operator's phone look check counts as live; fake-Telegram runs (T1) never do.
      Resulting order for step 7a: commit L1, fix the Claude Host-access defect (needed by the Claude real-provider scenario), build H0 to H6, run the rows, then the remaining close-out items.

    Local cleanup (operator's real database):

    - Delete the throwaway workspaces "L1 Telegram test" (its task was left in START_UNKNOWN by a dev-server restart during testing) and "L1 HITL test", and their `/tmp/l1-telegram-test` and `/tmp/l1-hitl-test` directories.
    - Delete leftover `alias-*` and `ws-*` workspaces pointing at `/tmp/intent-work-*`, created by an earlier test run that did not use an isolated `AGENT_CONSOLE_REPO_ROOT`.

    Defects found during L1, to fix or explicitly defer:

    - With Host access off, Claude saved-task runs are told to `curl` their context, which the `acceptEdits` permission mode refuses, so they block without doing the task.
      `savedPromptExecuteReachabilityProblem` does not account for Claude.
      This predates L1 but makes phone-driven resume unusable with Claude, so fix it before any enhancement that starts work remotely.
      Fix design, decided 2026-09-14: give Claude typed in-process tools instead of a `curl` instruction.
      - Use the Agent SDK's `tool()` and `createSdkMcpServer()` (available in the installed 0.1.77) to expose `get_context`, `post_remark` and `post_status` to Claude execute runs.
      - Each tool is bound to its run and enforces the same rules as the HTTP Progress API: the run credential's scope and expiry, and read-only runs (consult, clarify) may not post remarks or status. Share the server-side handlers with the HTTP endpoints rather than duplicating them.
      - Claude's saved-task prompt names the tools instead of `curl`; no shell or network permission is added, and the `acceptEdits` mode is unchanged.
      - `zod` is currently only a transitive dependency; add it to `server/package.json` explicitly.
      - Other providers keep the HTTP Progress API or the inline path, unchanged.
      - Scenario table (product-facing, operator skims): Claude execute run on the tool path reaches DONE, reaches BLOCKED with a blocker remark that produces a phone card, a consult run is refused on `post_remark`, an expired run credential is refused, and the inline path for sandboxed providers is unchanged.
    - Answers submitted from Telegram are not labelled as coming from Telegram in the task timeline, although receipts record the link.
    - The task-control capability badge reports "Telegram configured" from settings alone, even when no token is loaded; the Live Telegram panel shows the true state.
    - The Agents header sometimes renders "-0 AVAILABLE" at page load; the cause in `CountUp` was not reproduced and needs investigation before a fix.
    - `npm run dev` stopped reloading on source changes after repeated restarts in one session; confirm whether this is reproducible.

    Documentation refresh, once step 7 is complete:

    - Update the section 1 baseline rows for Telegram enrollment, polling and action routing, which still say no live client exists.
    - Update the README status line, which still says no live bot exists.
    - Mark steps 6 and 7 DONE.

    Telegram enhancements are not part of this close-out; they are planned as L3 (step 7b) and start only after it.

    Build sequence for this step and the next, as one list (the harness plan's slice order, merged):

    1. Commit the L1 work in reviewable pieces (above).
    2. Fix the Claude defect with typed SDK tools (above).
    3. Harness slices H0 to H4 (foundations, orchestrator and guard, fake provider CLI, fake Telegram, time seams).
    4. Harness slice H5: test-design pass for L1, then L1 scenarios on the fake backend.
    5. Harness slice H6: real Telegram backend, test bot, real Claude and Codex scenarios.
    6. Run the L1 rows through the harness (T1 and T3) plus the phone look check; finish the remaining close-out items above; mark steps 6 and 7 DONE.
    7. Harness slices H7 (UI coverage) and H8 (workflow integration). H7 may run in parallel with L3.
    8. Step 7b (L3).
    9. Harness slice H9 (mutation testing) before L3 close-out.

7b. Implement L3 personal Telegram surface.
    Build the slices of section 3a L3 in order: F1, F2, F3, A, B, then C0 (live, with the operator), C1, C2.
    A and B do not depend on C0-C2 and are useful even if topics slip.
    Each slice starts with a test-design pass and a scenario table the operator skims (engineering standards, definition of ready), and adds its scenarios to the harness.
    Commit each slice separately with its tests and an `implementation.md` evidence entry.
    Required evidence: the L3 definition of done observed through a T3 harness run plus the operator's phone look check, plus H-L3 rows in `human-verification.md`.
    Queued follow-ups (status and Stop, Ask the agent, starting from the phone, brief version 2) are planned only after this step.

8. Run feasibility experiments for G01-G03.
   Record provider delegation/billing facts, provider/runtime secret-isolation
   facts and Git protected-ref/signing facts. If evidence is missing, keep the
   affected production capability disabled and continue development only with
   fixtures where useful.

9. Implement M3 package and shared-control storage.
   Build factual checkpoint preview, manifest hashing, unsupported artifact
   rejection, administrative Git checkout, signed control history and
   fast-forward conflict handling. Exclude receiver execution.

10. Verify and review M3.
    Required evidence: stable worktree/index capture, staged/unstaged/binary
    coverage, path traversal and escaping symlink rejection, hook/filter safety,
    partial upload handling, push conflict handling, rewritten history rejection
    and unsupported schema refusal.

11. Obtain production decision for G03 before enabling cross-workstation offers.
    The selected Git host must protect control refs from force updates/deletion
    and support the chosen signing verification process. Without this, M3 remains
    a local/fixture capability.

12. Implement M4 named teammate claim with fake providers first.
    Add offer discovery, receiver bot Accept/Decline, local policy comparison,
    grantable delta prompts, hard-deny handling, isolated receiver checkout and
    one linked receiver-local run.

13. Verify and review M4.
    Required evidence: two isolated installations publish/discover/accept/start
    one task, only the named receiver can claim, busy receiver queues and
    revalidates, permission deltas are local to executor, and unknown enforcement
    blocks start.

14. Implement L2 live group Telegram surface.
    Render offers, Accept/Decline and shared status in the team topic against the
    real Bot API built in L1. Blocked until steps 12-13 exist, since there is no
    assignment to render before then.

15. Resolve G01 and G02 before enabling production teammate execution.
    Provider-supported subscription delegation and tested credential isolation
    are release blockers. Do not use API billing, owner consent alone, shared
    credentials or warning-only sandboxing as substitutes.

16. Implement M5 shared questions and return/apply.
    Add executor-bot mid-run questions, requester answers while source is
    offline, result publication, Review and apply, apply intent, manifest
    reconciliation, crash recovery, cancellation and further handoff epochs.

17. Verify and review M5.
    Required evidence: offline requester answer resumes once, returned work is
    labelled full/partial/error accurately, apply refuses divergence, repeated
    apply is idempotent, crash-mid-apply does not advance the pipeline
    prematurely, and further handoff preserves task identity and decision
    ownership.

18. Complete M6 durability and release checks.
    Add an exercised database backup/restore path, per-migration rollback notes,
    and CI running the existing typecheck/lint/test commands.

19. Obtain G04 governance approval. Team/enterprise scope only.
    Record team-approved Telegram audience, repository/storage location,
    retention/deletion expectations and operational owners before claiming an
    enterprise or team production release. Per D16 this does not gate L1
    personal control, which needs only its operator's own setup decision.

20. Run release verification for the enabled subset.
    Execute the relevant T01-T36 acceptance scenarios, the required
    type/lint/test checks, browser checks for changed UI and any explicitly
    authorized live smoke tests. Record exact commands, the fixture/live
    distinction and outcomes in `implementation.md`.

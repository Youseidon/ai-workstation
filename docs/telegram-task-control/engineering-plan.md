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
| Workspace/run concurrency | Partially implemented | `runHub` and pipeline queues prevent many local concurrent starts by workspace ID. `runService.ts` checks `runHub` after provider detection and has no durable effective-directory reservation shared by all start paths. |
| Startup recovery | Partially implemented | Startup marks DB rows interrupted and handoffs failed. It does not prove managed subprocesses stopped, locate exact attempts after crash or protect delegation holds. |
| Telegram enrollment, polling, inbox/outbox and rendering | M1 complete with fakes | Shared task-control contracts, SQLite migrations 16-18, settings-backed capability, fake pairing, durable fake inbox/cursor records, sanitized rendering and a durable outbox queue exist. No live Telegram client, real long-poll daemon, real setup/pairing UX or real device enrollment is implemented. |
| Remote actor authorization and command receipts | M1 complete with fakes | Opaque action references, fake callback validation, adapter-side fake callback dispatch and idempotent receipts exist for personal Save answer and Answer and resume. Real Bot API callback receipting and shared-command publication are not implemented. |
| Quota advisor | Not implemented | Usage polling exists, but no 5% advisor, freshness model, deduplication, action choices or non-mutating warning state exists. |
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
| RTC-16 | Operational release evidence | Development can progress with fixtures, while production capabilities remain blocked until gates pass. | G01-G04 | Add release checklist, threat model, backup/restore and governance records. | Evidence file references provider docs/tests; unresolved gates shown as disabled capabilities. | M6 |

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

### M6: Operational Hardening and Release Gates

Scope: RTC-16 plus release readiness for the selected production subset.

Entry criteria: M1-M5 development evidence complete or explicitly scoped out.

Tasks and files:

- Add threat model, operational runbook, backup/restore, upgrade/rollback and
  gate evidence documents.
- Add CI workflows or equivalent documented manual release checklist.
- Run provider-specific certification for any production-enabled teammate
  execution path.

Behaviour: unresolved gates block only affected production capabilities and are
visible to users. Passing tests alone is not security or provider eligibility
evidence.

Tests/gates/rollback: full acceptance matrix T01-T36 for enabled capabilities,
manual release review and documented rollback per schema/capability.

Definition of done: selected release scope has evidence for every enabled
capability; disabled capabilities explain their missing gate.

## 4. Critical path and feasibility experiments

Critical path: RTC-01 → RTC-02 → RTC-03 → RTC-04 establishes useful personal
control. Cross-workstation work then depends on RTC-06/07 safety before RTC-09/10
storage, then RTC-11/12 receiver execution, then RTC-14 apply.

High-risk experiments to run before building broad surfaces:

- Provider delegation and billing: determine whether the selected provider
  supports G01 without sharing credentials or switching to paid API execution.
- Secret isolation: prove G02 for bot/Git/signing/provider credentials under the
  exact supported permission modes.
- Git remote integrity: verify protected refs, force-push/deletion prevention
  and SSH signing verification with the chosen host.
- Process supervision: demonstrate START_UNKNOWN handling for crash before spawn,
  after spawn and parent-exit/child-mutating cases.

First implementation-ready milestone: M1. It has a clear user-visible workflow,
can be built entirely with fakes plus local task records, and does not require
G01-G04 approval for production teammate execution.

## 5. Execution steps to completion

Use this sequence to take the plan from approved design to release. Stop at each
approval or evidence gate; do not silently continue into the next production
capability when its gate is unresolved.

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

1. Approve this plan and standards.
   Confirm M1 as the first implementation slice, confirm that all new
   integrations stay default-off, and record any design changes before coding.

2. Create implementation issues from RTC-01 through RTC-16.
   Each issue must name its user benefit, affected modules, acceptance tests,
   external gates and rollback path. Do not combine unrelated milestones into one
   broad implementation issue.

3. Prepare isolated test infrastructure.
   Add or document a repeatable way to run server tests against a temporary app
   database, fake Telegram Bot API, fake Git remote and fake provider adapters.
   This is a prerequisite for M1 and blocks claims of verified behaviour.

4. Implement M1 behind disabled local settings.
   Build setup state, Telegram pairing, durable inbox/outbox, personal task
   rendering and Save answer / Answer and resume routing for saved tasks only.
   Use fake Telegram tests first. Do not configure a live bot unless explicitly
   authorized.

5. Verify and review M1.
   Required evidence: wrong actor/chat/topic rejection, replay/expiry handling,
   send retry recovery, save-only without provider, resume-once behaviour and no
   raw transcript/secret/localhost leakage. Passing M1 does not imply teammate
   transfer is implemented.

6. Implement M2 local safety.
   Add effective-directory reservation, durable start intent, START_UNKNOWN
   recovery and quota advisor state. Ensure UI, pipeline, retry, recovery and
   Telegram entry points share the same ownership checks.

7. Verify and review M2.
   Required evidence: concurrent aliased-workspace starts produce one attempt,
   crash-before/after-spawn cases are classified, parent-exit/child-running is
   not released automatically, and 5% quota warnings never pause, switch provider
   or request takeover without explicit action.

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

14. Resolve G01 and G02 before enabling production teammate execution.
    Provider-supported subscription delegation and tested credential isolation
    are release blockers. Do not use API billing, owner consent alone, shared
    credentials or warning-only sandboxing as substitutes.

15. Implement M5 shared questions and return/apply.
    Add executor-bot mid-run questions, requester answers while source is
    offline, result publication, Review and apply, apply intent, manifest
    reconciliation, crash recovery, cancellation and further handoff epochs.

16. Verify and review M5.
    Required evidence: offline requester answer resumes once, returned work is
    labelled full/partial/error accurately, apply refuses divergence, repeated
    apply is idempotent, crash-mid-apply does not advance the pipeline
    prematurely, and further handoff preserves task identity and decision
    ownership.

17. Complete M6 operational hardening.
    Add threat model, release checklist, runbook, backup/restore, upgrade and
    rollback procedures, emergency controls, observability and CI or an approved
    manual-release substitute.

18. Obtain G04 governance approval.
    Record team-approved Telegram audience, repository/storage location,
    retention/deletion expectations and operational owners before claiming an
    enterprise or team production release.

19. Run final release verification for the enabled subset.
    Execute the relevant T01-T36 acceptance scenarios, mandatory type/lint/build
    checks, browser checks for changed UI and any explicitly authorized live
    smoke tests. Record exact commands, fixture/live distinction and outcomes.

20. Publish an evidence-based release report.
    List implemented, partial, disabled and blocked capabilities; include
    unresolved gates; state whether live messages, remote Git mutations or paid
    provider execution occurred; and document rollback steps for the enabled
    features.

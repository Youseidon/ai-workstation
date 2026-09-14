# Engineering standards

These standards apply to changes in this repository. They reuse the existing
README contracts, package scripts, task-control design docs and test files rather
than replacing them. When a feature-specific document is stricter, follow the
stricter rule.

## Mandatory for every code change

- Scope changes to the requested behaviour. Preserve unrelated user edits,
  database records, workspace files and provider settings.
- Read the affected design, API and data contracts before editing. If code and
  docs disagree, resolve or document the discrepancy before claiming completion.
- Keep runtime authority explicit: validate inputs at module boundaries, name
  state owners, reject unknown required schema versions and use stable error
  codes for unexpected states.
- Maintain least privilege. Secrets, provider credentials, bot tokens, Git
  credentials and signing keys must not enter prompts, task packages, browser
  payloads, logs or test fixtures.
- Make retries idempotent at the command/action boundary. Duplicate delivery,
  browser retry or uncertain remote acknowledgement must reuse the recorded
  action/result where possible.
- Treat concurrency and crash recovery as design concerns, not incidental bugs.
  Any change that starts, resumes, stops, retries, schedules or applies work must
  define ownership, locking/reservation and recovery behaviour.
- Use additive, backward-compatible migrations where possible. Migrations must
  preserve existing rows, run once, tolerate older data and avoid destructive
  reinterpretation of pending work.
- Add focused tests for the changed branch and at least one failure path when the
  change touches validation, persistence, concurrency, credentials, provider
  execution, external I/O or user-visible workflow.
- Use isolated test databases, repositories, work directories and fake providers
  for mutating tests. Do not run tests against the user's live `.agent-console`
  database or real workspaces unless explicitly authorized for that run.
- Do not send live Telegram messages, push/fetch a real project remote, execute
  paid/provider work, mutate remote services or start another person's
  subscription-backed task without explicit setup authorization.
  Standing authorization (2026-09-14): the harness T3 tier may message the
  dedicated test bot's private chat through the operator's automated client, and
  run the one real Claude and one real Codex scenario at milestone close-out
  ([harness plan section 10](e2e-harness-plan.md#10-operator-decisions)).
  The operator's own bot is never used by tests.
- Keep unfinished integrations default-off. Capability responses and UI states
  must say what is disabled and why.
- Completion reports must be evidence-based. Passing tests may support behaviour;
  it is not proof of security, provider approval, billing eligibility or
  enterprise readiness.

## Required checks

Run the smallest set that covers the blast radius, then record the exact commands
and outcome in the change summary.

| Change type | Blocking checks before merge |
| --- | --- |
| Shared types or cross-package contracts | `npm run typecheck --workspace shared`, plus affected server/web type checks. |
| Server behaviour, persistence, scheduling or adapters | Relevant `node --import tsx --test --test-concurrency=1 ...` tests in an isolated app/database copy, plus `npm run typecheck --workspace server`. |
| Web UI or client API changes | `npm run typecheck --workspace web`, `npm run lint --workspace web`, and browser/interaction checks for the affected view. |
| Package-wide contract or release change | `npm run typecheck`; run `npm run build` when build output or package integration is affected. |
| Visual layout changes | Browser checks at desktop and mobile widths; verify no text overlap, horizontal overflow or broken interaction. |
| Telegram, Git, provider or external-service integrations | Fake-provider/fake-service tests must pass. Live-service checks run through the harness T3 tier (below) rather than by hand; other live smoke tests require explicit authorization; unresolved external gates block affected production capability. |
| Behaviour change in a slice the end-to-end harness covers | T0 tests above, `npm run e2e` (T1) and `node e2e/scripts/coverage-matrix.mjs --scope <slice> --tiers T1` with no must gaps; every new or changed scenario passes `npm run e2e:burn-in` (20 runs); `node e2e/scripts/coverage.mjs --base <slice base>` with each uncovered changed line in a critical file covered or explained. |
| Web change in a harness-covered view | Additionally `npm run e2e:visual` (T2) once harness slice H7 provides it: no console errors, overflow, overlap or serious accessibility violations at both widths; screenshot diffs reviewed, new-screen baselines approved by the operator. |
| Milestone close-out with a phone or real-provider surface | `npm run e2e:live` (T3) with every T3 row passing, the operator's phone look check (T4) recorded in the milestone's human checklist, and the mutation testing report once harness slice H9 exists. T3 rows blocked on setup are reported as blocked, never as passed. |
| Database migrations | Migration test from an older schema fixture plus verification that pending runs, holds and history keep their meaning. |

Merge is blocked by failing type checks, failing relevant tests, lint failures in
touched web code, migration failures, unhandled authorization/secret exposure,
missing tests for a newly introduced failure path, or a must-priority scenario
from the slice's scenario table that is missing or failing. Release is also blocked by
any unresolved external gate for the capability being released.

Known limitation: this checkout has no `.github` workflow directory. Until CI is
added, reviewers must require the manual checks above as merge evidence.

## Recommended practices

- Prefer existing modules and local patterns over new frameworks. Add an
  abstraction only when it owns a real boundary, such as Telegram transport,
  task-control validation, quota advice or package transfer.
- Keep schemas versioned and close to shared types. Prefer a maintained validator
  or existing structured parsing over ad hoc string parsing.
- Use fake providers and fixture repositories for race, retry, crash and external
  effect tests before any live service test.
- For frontend work, follow `web/AGENTS.md`, inspect the installed Next.js docs
  when changing framework-sensitive code, and keep operational screens dense and
  usable rather than landing-page styled.
- Add documentation only where it records a decision, contract, acceptance
  evidence or operational procedure that future implementers need.

## Execution contract

Definition of ready before coding:

- The requirement has a stable ID or issue reference, user benefit, observable
  behaviour, affected modules, acceptance evidence and known gates.
- Product questions, engineering choices and external release gates are separated.
- Required fake services, isolated databases/repositories and rollback path are
  identified.
- A scenario table for the slice exists, written by a test-design pass that did
  not implement the slice, derived from its requirement, decision, acceptance and
  verification IDs, and skimmed by the operator for product-facing slices (for
  internal tooling slices, such as the test harness itself, the review pass checks
  the table instead). See
  [test case design and coverage ownership](e2e-harness-plan.md#12-test-case-design-and-coverage-ownership).
  This applies once the end-to-end harness exists (slice H5 onward); until then,
  the table is still required and its scenarios run as T0 tests.
- Any design change has renewed approval when it changes an accepted decision,
  weakens an invariant, expands data exposure, enables external mutation, changes
  billing/provider authority or alters who can start/stop/apply work.

Required change summary:

- State what changed and what was intentionally excluded.
- List files/modules touched and any schema/API/state-machine changes.
- Include acceptance checklist results with exact commands and whether they were
  run in isolated fixtures.
- Include the coverage matrix result for the slice's IDs, missing should-priority
  scenarios, explanations for uncovered branches in changed critical files, and at
  milestone close-out the mutation testing result.
- Name remaining risks, partial work and blocked release gates.
- State explicitly when no live messages, paid execution or remote mutations were
  performed.

Review requirements:

- Security, authorization, credential handling, migrations, external I/O,
  scheduling/concurrency and result application require engineering-lead review.
- High-severity defects block merge and release. Medium-severity defects block
  release unless explicitly accepted with mitigation. Low-severity defects may be
  deferred only with a tracked follow-up and no misleading completion claim.
- Reviewers must challenge claims that are not backed by code, tests, logs,
  screenshots or external provider/governance evidence.
- Reviewers must challenge coverage gaps: in-scope IDs without a passing scenario,
  failure paths asserted only through the UI, assertions that cannot fail, and
  unexplained uncovered branches or surviving mutants in critical modules.

Reporting rules:

- Report **verified** only when the behaviour is implemented and the relevant
  checks/evidence were actually observed.
- Report **partial** when a local component works but the full user workflow,
  remote actor, production gate or failure path is missing.
- Report **blocked** when progress depends on unavailable external evidence,
  authorization, provider capability, governance decision or a repeated
  unrecoverable technical condition.
- Never present passing tests alone as proof of security, subscription
  delegation, provider terms compliance or production readiness.

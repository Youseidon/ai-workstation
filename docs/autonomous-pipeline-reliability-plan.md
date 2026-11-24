# Autonomous pipeline reliability implementation plan

Status: Reviewed; local implementation built; production rollout gated  
Date: 20 November 2026  
Repository: ai-orchestration  
Audience: Product owner and the AI implementing the change

Implementation and validation: [autonomous-pipeline-reliability-implementation.md](autonomous-pipeline-reliability-implementation.md). The production canary and live S1-02 recovery have not been performed.

## Intended outcome

The operator supplies requirements, authority boundaries and a finite resource budget, then presses Play. The application plans bounded work, executes it, checks evidence, recovers from ordinary technical failures, and delivers the result without repeated manual Resume actions.

The application owns scheduling, progress accounting and completion. Agents propose edits, plans and outcomes; agent prose does not decide whether another session is warranted or whether requirements are satisfied.

Unattended operation has three legitimate outcomes: verified delivery; an actionable exception for an external dependency or undelegated decision; or an explicit exhausted budget with preserved work and a recovery report. There is no honest guarantee of completion through arbitrary outages or unlimited ambiguity. Routine compiler failures, dropped final messages, context turnover and provider interruptions should be handled automatically.

This is an implementation proposal. Reviewing it does not authorize changing the live pipeline, deploying code, rewriting requirements, or migrating the live database.

## Decisions recommended for approval

1. Retain the existing TypeScript application, SQLite database and provider adapters. Introduce a durable supervisor inside this application; do not introduce Temporal, Redis, a message broker or a new hosted dependency for the first implementation.
2. Separate the original requirement, its execution plan, individual work units and worker attempts. Give each a stable identity and distinct completion meaning.
3. Replace unlimited agent-requested continuation with server-authorized continuation and automatic recovery. A limit on one worker triggers another strategy while the approved requirement budget remains.
4. Make verification evidence and its freshness authoritative. An agent message, successful process exit, commit count or edited inventory document is insufficient.
5. Run one writer per repository and one heavy command per resource pool by default on the current 8 GiB WSL configuration. Increase concurrency only after measurements support it.
6. Ask the operator only for credentials, a material decision outside delegated authority, an action requiring existing approval, or exhaustion of the approved recovery envelope. The normal recovery path has no Resume button dependency.

## What the current application does

The following findings describe the inspected working tree. The implementation must inspect it again because other changes and the live S1-02 run can advance.

| Finding | Existing location | Consequence |
| --- | --- | --- |
| Agent CONTINUE bypasses the continuation allowance. | [pipelineScheduler.ts](../server/src/pipelineScheduler.ts), continuation | A station can start unlimited additional sessions. |
| A test explicitly preserves that behavior. | [pipelineScheduler.test.ts](../server/test/pipelineScheduler.test.ts), agent_continue test | Editing one condition without changing the contract and tests is incomplete. |
| Normal station continuation starts another execute run without native session reuse. | [pipelineScheduler.ts](../server/src/pipelineScheduler.ts), startCurrentStation | Repeated setup and rediscovery consume time and context. |
| Saved work-item execution rejects ordinary resumeSessionId unless it is the operator redirect path. | [runService.ts](../server/src/runService.ts), startExecute | Native continuation needs a supported API contract, not just one extra scheduler argument. |
| Checkpoints and decomposition already exist. | [gitChanges.ts](../server/src/gitChanges.ts), [workspaces.ts](../server/src/workspaces.ts), agentDecomposeTransaction | Extend these capabilities instead of building a second task hierarchy. |
| A successful tool result resets the repeated-call counter, including unchanged polling. | [runner.ts](../server/src/runner.ts), emit | Liveness is mistaken for useful progress. |
| Existing budgets primarily belong to individual runs. | [runner.ts](../server/src/runner.ts), [settings.ts](../server/src/settings.ts) | New runs and replans can multiply total effort without one delivery-wide ceiling. |
| Review, command criteria and child closure gates exist. | [completionAudit.ts](../server/src/completionAudit.ts), [definitionOfDone.ts](../server/src/definitionOfDone.ts) | Reuse them, but require complete criterion coverage and current evidence. |
| Workspace writer ownership and scheduling queues are primarily in memory. | [gitChanges.ts](../server/src/gitChanges.ts), [pipelineScheduler.ts](../server/src/pipelineScheduler.ts) | Crash recovery needs durable effect ownership and reconciliation in addition to the existing instance lock. |
| The UI presents a continuation maximum that excludes voluntary continuations. | [RunConfidenceStrip.tsx](../web/components/pipeline/RunConfidenceStrip.tsx) | Operators cannot interpret the displayed maximum as a limit on total runs. |

S1-02 was observed with repeated voluntary continuations, no tracked children, and different commits closing different operations. This is productive work organized inefficiently, not evidence that every session discarded its predecessor's code. The inventory reported 31 unchecked operations in the latest inspected progress note. That count is a historical observation, not an input to hard-code into recovery.

The recent Grok instruction fix explicitly passes root AGENTS.md through --rules. The managed MaterioForge commands also exist and have completed real builds. Preserve those fixes. They do not themselves supply the execution and delivery controls proposed here.

## Product behavior

A large station becomes a parent with a visible plan. The UI shows the current child, accepted implementation progress, pending verification and the supervisor's last decision. Checkpoints remain inside a worker session unless a genuine execution boundary requires a successor.

A normal automatic sequence is:

~~~mermaid
flowchart TD
    A[Freeze requirement and authority] --> B[Plan bounded work units]
    B --> C[Validate coverage and dependencies]
    C --> D[Select eligible work and reserve resources]
    D --> E[Execute with checkpointed progress]
    E --> F[Evaluate current evidence]
    F -->|Unit accepted| G[Schedule next eligible unit]
    G --> D
    F -->|Work remains or failure| H[Diagnose and choose recovery]
    H -->|Budget and authority remain| D
    H -->|External dependency| I[Wait for known event or notify once]
    H -->|Envelope exhausted| J[Preserve work and emit exception report]
    F -->|Implementation complete| K[Run assigned verification stages]
    K -->|All delivery obligations passed| L[Deliver and advance]
    K -->|Repairable failure| H
~~~

The supervisor is deterministic application code. Planner, worker and reviewer are bounded agent roles, not competing authorities over scheduling.

## Requirement and plan model

### Requirement contract

At pipeline intake, persist the original prompt and its version hash. Extract stable requirement IDs and acceptance criteria, with source spans back to that prompt. Record scope exclusions, allowed mutation classes, verification timing, dependencies and the approved resource envelope.

An agent may propose a criterion extraction; it cannot silently replace the original requirement with a weaker version. Validate identifiers and coverage mechanically, then review semantic faithfulness against the original text. If a material ambiguity cannot be resolved within delegated authority, produce one focused decision request with evidence.

Preserve existing workspace, suite and prompt instructions. Record which versions governed each attempt.

A genuine operator requirement change creates a new contract version and invalidates affected evidence. Preserve its history and map the changed criteria explicitly. Autonomous replanning does not have that authority.

### Work units

Reuse the current prompt parent-child model and dependency records where possible. Add metadata rather than another independently scheduled task hierarchy.

Each unit must have:

- A stable unit ID, parent requirement ID and plan revision.
- A named subset of acceptance criteria and concrete targets such as operation IDs, paths or scenarios.
- Required inputs, explicit dependencies and a bounded output.
- A build or verification recipe with an assigned phase.
- A handoff packet, estimates and a budget allocation inherited from its parent.
- A reason it can be completed and checked as one coherent piece.

Group related work by domain, shared source inputs and verification prerequisites. Do not choose one endpoint per task by default, and do not enforce an arbitrary universal endpoint count.

A planner must cover every original criterion, preserve ordering constraints, avoid cycles, and identify the final integration and verification owners. One criterion can require several units; that relationship must be explicit.

Automatic decomposition uses the current hierarchy limits as a starting constraint. If those limits cannot represent a legitimate plan, produce an explicit product decision rather than silently expanding the hierarchy.

### Replanning

Replan automatically when measured effort, repeated failure or unresolved coverage shows the current unit is poorly shaped. Preserve accepted units and split only the remaining scope. New units inherit the original requirement, budget lineage and unresolved obligations.

A replan cannot remove acceptance criteria, turn missing checks into waivers, refresh the root budget, or relabel an unfinished target as completed. Record the exact before-and-after coverage map and why the change should improve execution.

The first planner should operate at intake. The recovery planner should receive only the remaining contract, accepted evidence, failures and relevant source context.

Plan activation is a server decision inside the operator's existing authority envelope. It does not introduce a manual approval screen for every decomposition. Require owner review only when the proposal changes original acceptance, authority or the approved budget.

## Durable records

The records below define durable responsibilities. Extend existing prompt, run, criterion and result tables where the meaning already fits; add tables only for responsibilities without a suitable owner. Do not create a second evidence store or task scheduler for the same facts. Names may be adjusted to fit repository conventions; ownership and invariants may not.

| Record | Purpose and important fields |
| --- | --- |
| delivery_contract | Original prompt version, authority, criterion manifest, verification obligations, current plan revision and delivery phase. |
| execution_plan | Requirement ID, immutable revision, coverage map, dependency graph, rationale and status. |
| work_unit_meta | Existing prompt ID, assigned criteria and targets, plan revision, input fingerprint, budget lineage and recovery stage. |
| execution_event | Append-only transition and decision ledger, sequence, event ID, actor, attempt ID, payload hash and timestamp. |
| dispatch_outbox | Durable effects committed with transitions, stable effect ID, claim state, due time and deduplication key. |
| execution_lease | Repository or resource ownership, owner attempt, expiry, process identity and monotonically increasing fencing token. |
| budget_ledger | Reservations and actual usage for all actors, charged to unit, requirement and pipeline. |
| evidence | Criterion, producer, recipe, source fingerprint, environment fingerprint, artifacts, result and freshness. |
| command_task | Command recipe, owning unit and attempt, resource lease, process identity, deadline, progress observations and exit facts. |
| recovery_case | Failure signature, remedies tried, resulting evidence, next strategy and remaining recovery authority. |

Keep agent_run and current history as the attempt and compatibility records. Do not reconstruct critical counters solely from retention-limited transcript events or natural-language remarks.

Use short SQLite transactions for state and effect decisions. Do not hold a transaction open during a provider call, Git operation, build or test. SQLite serializes writers and WAL supports concurrent reading; this supports a local durable queue without another service. [SQLite isolation](https://www.sqlite.org/isolation.html)

## Scheduler and crash recovery

Persist the execution decision and its dispatch intent atomically. A separate dispatcher executes that effect and records its outcome. Use an outbox and idempotent consumers so a crash between committing a transition and starting a worker does not lose work or duplicate it. [Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

Required dispatch sequence:

1. Read the contract, desired pipeline state, current plan, evidence and budget.
2. Select work whose dependencies and phase permit it.
3. Reserve budget and claim the repository/resource lease in one transaction; append the decision and outbox effect.
4. Reconcile the effect's stable OS identity before spawning.
5. Launch outside the database transaction; register the process and lease generation.
6. Accept events only for the current attempt and fencing token.
7. On exit or timeout, persist facts, evaluate evidence and schedule the next decision.

A stable systemd unit identity per effect can help reconcile the crash window between OS spawn and database acknowledgement. Do not promise exactly-once arbitrary shell effects. Use durable intent, idempotent dispatch and reconciliation, with extra idempotency for any authorized external mutations.

Fencing rejects stale database updates; it does not stop an old process writing files. Confirm the old writer and its descendants are dead before transferring a shared-tree writer lease. If liveness is uncertain, quarantine that execution and do not launch a second writer into the same tree.

On restart, restore decisions, reservations, processes and leases before scheduling. Persist desired state separately: an operator PAUSED or STOPPED pipeline stays that way. Auto-resume applies only when the persisted desired state is RUNNING. A lease timeout alone does not prove the old writer is gone.

Retain the existing database instance lock. The lease design complements it and does not authorize a second console against the same live database.

## Continuation and context

Replace the current unconditional continuation branch with a server-owned decision. CONTINUE becomes a request containing:

~~~json
{
  "requestId": "unique-operation-id",
  "unitId": "stable-unit-id",
  "planRevision": 2,
  "expectedGeneration": 7,
  "reason": "context_boundary",
  "checkpointCommit": "full-commit-id",
  "completedCriterionIds": ["criterion-a"],
  "evidenceIds": ["evidence-a"],
  "remainingTargetIds": ["operation-b", "operation-c"],
  "nextAction": "Implement the remaining ownership check"
}
~~~

The server checks coverage, evidence, expected generation and remaining budget before granting another attempt. Agent-requested, failed, unreported and budget-ended successor attempts all consume the appropriate durable allowances.

A normal checkpoint does not end the session. The worker continues until its unit is implemented or a legitimate boundary is reached. Update agentContext, agent-step help and protocol responses together.

Support ordinary saved-item native resume in runService, not only operator redirects. Reuse a native session only for the same unit lineage, compatible provider/model, permissions and instructions. Issue fresh run credentials every time. If instructions changed, the adapter must deliver the new instructions explicitly.

When a session is exhausted, corrupted or repeatedly failing, use a fresh one with a structured handoff. Include the current plan revision, accepted criteria, relevant commits, current check results, remaining targets, failed approaches and next action. Do not send the entire accumulated conversation by default.

Logical work identity must survive fresh execution identity. Temporal's continuation model illustrates that distinction: a successor can keep a logical workflow identity while receiving a new run identity and explicit carried state. This proposal applies that principle inside the current application. [Continue as new](https://docs.temporal.io/develop/go/workflows/continue-as-new)

## Evidence and progress

Track three separate signals:

| Signal | Examples | What it establishes |
| --- | --- | --- |
| Liveness | Provider heartbeat, tool response, process exists | Something is responding. |
| Work advancement | Relevant source edits, new scenario, advancing compiler output | Work is underway; it may still be incorrect. |
| Accepted progress | Fresh checks for an assigned criterion, reviewed artifact satisfying an obligation | A bounded obligation has been satisfied. |

Unchanged polling, repeated reads, generated timestamps and copied progress remarks do not reset a stall detector. A commit alone does not establish correctness. Conversely, accepted verification can be useful progress without a new source change.

Use the declared task phase when judging progress. Discovery and diagnosis receive a bounded investigation milestone and must produce findings or a concrete plan; they should not be killed because no implementation criterion passed in the first few minutes.

Invalidate evidence when relevant inputs change. Record recipe version, actual effective source inputs including dirty/untracked inputs, generated artifacts, lockfiles, toolchain and relevant environment. Git HEAD alone is insufficient.

Start with conservative dependency fingerprints. Reuse results across unrelated edits only when the affected source/dependency closure is known. For .NET this includes transitive project references, analyzers, contracts and build properties. When that closure is uncertain, invalidate broadly rather than preserve a stale pass.

Completion evaluation must enumerate every required criterion for the current phase. A reviewer returning COMPLETE with one favorable check cannot close a contract containing other unchecked criteria. Check missing IDs, unknown IDs, duplicate contradictory results, stale source versions and empty coverage. Reviewers cannot overwrite command facts with prose.

Source stability is part of the evidence contract. Execute checks against an immutable snapshot or hold a write barrier over the relevant inputs. Compare input fingerprints before and after execution; discard a result if relevant inputs changed during the check. A test completing successfully against a changing tree is not a reusable pass.

## Verification phases and delivery

A work unit's implementation can be accepted before a deliberately deferred verification stage runs. Keep that distinction visible and durable.

For S1-02, implementation includes the approved binding changes, authored scenarios, fixtures, successful permitted compilations and an exact handoff to S1-06. Business tests remain assigned to S1-06. Do not make S1-02 wait on a later stage that cannot start until S1-02 advances.

Record deferred checks as verification obligations owned by S1-06, linked to criterion IDs and relevant inputs. Closing the implementation node advances the pipeline but displays verification pending. The requirement or pipeline is not delivered until every mandatory final obligation has passed on the relevant resulting code.

Distinguish these outcomes in the domain model and UI:

- Worker process finished.
- Unit implementation accepted.
- Required verification pending.
- Requirement delivery verified.
- Awaiting an external dependency.
- Recovery envelope exhausted.

Map these onto existing StepStatus values through explicit compatibility rules. Do not add another independent status engine. The server must remain the single owner of transitions.

Final completion should include a concise delivery report: requirement coverage, final commit, actual checks and results, deferred or waived obligations, and limitations. A waiver requires the same authority as changing the requirement; an agent cannot invent it.

## Autonomous recovery

Use a bounded recovery ladder. The normal response to a limit is a new justified strategy, not an immediate manual Resume request.

| Observed condition | Automatic response | Evidence required before continuing |
| --- | --- | --- |
| Process exited without final status | Inspect checkpoint and criterion evidence; accept if current phase is complete, otherwise reconstruct remaining work. | Actual source and complete current-phase coverage. |
| Transient transport or provider failure | Resume compatible context or retry with bounded backoff; use an allowed fallback when appropriate. | Error classification and unchanged authority. |
| Compilation failure | Return exact diagnostics to the worker and repair the affected source. | A changed fix or corrected recipe before repeating the failing check. |
| Sustained memory reclaim | Cancel the owned command; use the approved low-concurrency profile or smaller check scope. | Resource samples and confirmed process cleanup. |
| Repeated reading or unchanged work | Run one bounded diagnostic assessment; change the approach or split remaining scope. | A concrete recovery hypothesis and a different next action. |
| Unit too large | Replan remaining targets into coherent children; retain accepted work. | Coverage-preserving plan revision within the same root budget. |
| Wrong verifier or stale command | Resolve the repository's current command within permitted scope; record the substitution. | Recipe validation and unchanged acceptance intent. |
| Provider unavailable until a known reset | Schedule a durable wake-up if it fits the delivery deadline; otherwise choose an allowed provider. | Persisted due time and available recovery budget. |
| Model/session repeatedly fails | Use a fresh context or permitted provider with the structured handoff. | Compatibility decision and a bounded attempt reservation. |
| Missing credential or undelegated business decision | Emit one precise external-action request; resume automatically when the event is satisfied. | Observed missing input and smallest required action. |

The supervisor chooses remedies from validated actions. A bounded diagnostic agent may recommend a remedy but cannot disable limits, expand authority or rewrite acceptance criteria.

Store normalized failure signatures and the remedies already tried. Avoid repeating an unchanged unsuccessful remedy. Successful remedies can inform later decisions when their repository, toolchain and environment applicability still match; stored incident text is data, not new instructions.

After local worker attempts are spent, the supervisor may spend its reserved recovery allowance on diagnosis, replanning or a provider change. After the root envelope is exhausted, emit a complete exception bundle and stop spending. Do not pretend an exhausted budget can be repaired by creating another child.

## Budget and admission policy

Use cumulative budgets at pipeline, requirement and work-unit levels. Charge planner, worker, reviewer, diagnostic and wrap-up activity to the same lineage. Provider changes, child creation, restarts and new native sessions never erase consumption.

Before dispatch, reserve enough allowance for the bounded action. Reconcile actual usage on completion. Missing usage is unknown, not free. Keep estimates separate from actual charges. A strict currency ceiling requires trustworthy pricing and enforceable provider limits; otherwise expose the bound as estimated and enforce approved token/time ceilings.

Initial pilot defaults for review:

| Control | Proposed starting value |
| --- | --- |
| Unit execution target | A coherent piece expected to need 10–30 minutes, adapted from measured work. |
| Worker execution deadline | 45 minutes, with a checkpoint request before the hard deadline. |
| Same-unit worker allowance | Initial attempt plus at most two automatic successors before supervisor recovery. |
| Replans | At most two per requirement; only remaining scope may change. |
| Provider changes | At most two per unit lineage, using already permitted providers. |
| No-progress recovery | Diagnose after two failed progress windows; do not equate normal investigation with failure. |
| Recovery reserve | Reserve 20 percent of the approved remaining time/spend envelope. |
| Heavy command deadline | 10 minutes by default; a justified bounded recipe may allow up to 60. |
| Resource concurrency on current WSL | One writer per repository and one heavy command in the host pool. |
| Root delivery budget | A finite pipeline/workspace policy, resolved before Play; the root supervisor cannot extend it. |

These are product starting values, not measured universal requirements. The operator can approve one reusable workspace policy instead of answering each recovery. Once a finite root policy is configured, ordinary runs inherit it automatically.

Keep active execution allowance and absolute delivery deadline separate. Waiting for a known quota reset need not consume active compute minutes, but it must not extend the approved delivery deadline.

Propagate reservations to every ancestor. Scheduling a child must atomically reserve ancestor capacity; otherwise many individually bounded children can still exhaust the machine or spend.

A manual resume or budget amendment records an explicit additional allocation and its reason. It must not silently reset historical usage or no-progress history.

## Managed commands and resource supervision

Promote the repository wrapper into a server-owned command-task service. Agents request a named check recipe through agent-step; the application owns locking, deadlines, process groups, logs, evidence and admission.

Retain the current MaterioForge wrapper as a thin compatible entry point. Do not duplicate its process supervisor in several unrelated layers. Choose one implementation boundary, with a local CLI client for developer use and a durable server record for pipeline work.

A command recipe specifies its executable/arguments, working directory, input dependencies, expected exit semantics, permitted phase, timeout, resource profile and mutation class. This lets the engine distinguish compilation, tests and generation, and reject a test during a compile-only station.

Read-only reviewers can request an authorized recipe from the server-owned verifier without receiving direct file-write or unrestricted shell capabilities. Run verifier side effects such as build outputs in the managed execution environment. Do not relax a reviewer's native sandbox just to obtain a test result.

Use one host resource pool for agent commands, definition-of-done commands, verifier commands and generators. De-duplicate concurrent identical checks; reuse completed checks only when their input fingerprints match.

The engine must track the underlying command until completion even when a provider moves it into a background task. A successful status poll does not close or restart its command deadline.

Observe process-tree CPU, RSS, relevant output changes, cgroup pressure and task age. Treat sustained memory pressure plus absent advancement as a resource problem. Silence or high CPU alone is insufficient. Distinguish live output heartbeats from actual command progress.

Deliver instruction versions explicitly through each adapter and record an instruction manifest/hash with the attempt. Extend the existing Grok --rules regression to the provider capability contract. Also preserve mode, permission and credential boundaries when resuming.

A CLI with unrestricted internal shell execution can bypass a cooperative wrapper. Do not label that as enforced command mediation. Define adapter capability levels:

1. Brokered execution: tool execution can be intercepted or constrained to the managed service.
2. Cooperative CLI execution: instructions and wrappers cooperate, with OS containment and supervisor deadlines as the enforceable outer controls.

Use brokered adapters where strict command policy is required. For cooperative adapters, keep hard resource/time enforcement, detect unmanaged heavy work where observable, and report the enforcement level. Do not claim that PATH shims or a prompt alone prevent absolute-path execution. Building a secure universal shell interceptor is a separate project, not a hidden prerequisite for the first release.

Keep the existing 3/4 GiB run limits as the measured starting policy on this machine; managed Identity and API builds completed under them. Adjust profiles from evidence within preapproved allocations. Do not routinely increase WSL memory, remove hard limits, disable analyzers or delete caches.

## Agent and operator API contracts

Extend the existing authenticated agent routes and agent-step client. Every mutation carries a request ID, active execution generation and plan revision, and returns the persisted decision and remaining allowance. Credentials are scoped to one attempt and its permitted capabilities.

| Operation | Agent capability | Server responsibility |
| --- | --- | --- |
| Propose plan or revised remaining plan | Planner or authorized worker | Validate coverage, dependencies, original authority and cumulative budget before activation. |
| Request named check | Worker or reviewer, subject to phase | Validate recipe and inputs, reserve resources, deduplicate and return a durable command-task ID. |
| Checkpoint | Active writer | Capture owned changes and bind the resulting commit to the current unit without ending the session. |
| Report evidence | Worker proposal or trusted verifier | Distinguish claims from runner facts; validate IDs and input versions. |
| Request continuation | Active worker | Evaluate progress and remaining obligations, then authorize continuation, recovery, completion or an exception. |
| Report outcome | Active worker or verifier | Apply the shared completion evaluator; a process exit is not a delivery verdict. |
| Read execution state | Authorized agent or operator | Return the current contract, plan, evidence, obligations, owned command tasks and decision summary. |

Keep legacy agent-step calls compatible during migration by normalizing them into the new decision service. Missing structured evidence must never activate the old unlimited branch. Return a useful machine-readable correction when the request needs current IDs or a checkpoint. A timeout or retried API request must return the same persisted result instead of duplicating an attempt or budget reservation.

## Operator interface

The primary status should describe requirement progress, not the last process exit.

Example:

~~~text
S1-02 Access bindings
Implementation 5 of 7 work units accepted
Verification pending at S1-06
Current work Supplier and procurement access
Worker attempt 2 of 3
Recovery Changed strategy after repeated ownership-check failure
Budget 42 percent of approved execution allowance used
~~~

Expose accepted criteria versus agent-reported progress, the current unit, remaining targets, cumulative cost/time, next planned action and the reason for any strategy change.

Use an event timeline for actions such as checkpoint reused, native session resumed, verification reused, provider changed and scope split. Show finite automatic allowances and the remaining root envelope; never display a failure-only limit as a maximum on all continuations.

Routine automatic recovery should not require user acknowledgement. External action requests need one clear task, supporting evidence and automatic resumption after satisfaction. Exhaustion reports need the preserved checkpoint, missing criteria, remedies tried and smallest useful next decision.

A permanently visible Pause and Stop remain operator controls. Their desired state survives restarts.

## Recovering S1-02 after rollout

Perform this through supported application services and a controlled scheduler transition.

1. Request a cooperative checkpoint at the current safe boundary. Do not lose newly completed work, reset Git, or treat an old progress note as current truth.
2. Capture the original requirement, latest checkpoint, current changes, real operation inventory and existing handoff evidence. Recompute remaining targets from authoritative contracts and handlers. Inventory prose is a lead, not completion proof.
3. Import completed batches as historical implementation evidence with provenance and unverified final obligations. Do not schedule their implementation again merely because a new plan exists.
4. Plan roughly four to eight coherent children from the actual remaining targets. Candidate clusters are payment and finance access, supplier/procurement/quotes access, project/workforce access, technical/admin surfaces, and the final canonical-permission and coverage pass. The planner must validate the current domain boundaries and counts rather than copy this illustrative list.
5. Bind each operation target to its child and assign the existing S1-06 verifier every deferred obligation. Preserve grants, public routes, scope exclusions and the no-business-tests rule at S1-02.
6. Publish the plan revision and explicit remaining budget in one transaction. Retire old scheduling intents without deleting history; fence old attempt credentials.
7. Resume automatically on the next eligible child. A completed child cannot return to READY after restart.
8. Close S1-02's implementation phase only when all child implementation and handoff obligations pass. Continue through the authorized pipeline to S1-06. Deliver only after final verification succeeds.

The migration must account for already spent effort. Approving a remaining-work budget is a new allocation with history retained, not a reset disguised as migration.

## Implementation work packages

Each package must leave the application runnable and include the relevant tests. Do not start by rewriting the whole scheduler.

| Order | Package | Concrete deliverable and completion test |
| --- | --- | --- |
| 0 | Characterize and capture | Snapshot current transition rules and S1-02-like history. Add failing tests for unlimited voluntary continuation, polling counted as progress, missing criterion coverage and lost dispatch after a crash. |
| 1 | Durable identity and limits | Add contract/plan/unit metadata, execution events and budget accounting. Every successor consumes durable lineage allowance; a restart cannot reset it. Recovery reservations exist before enforcing automatic recovery. |
| 2 | Dispatch and ownership | Add outbox dispatch, stable effect identities, leases/fencing and startup reconciliation. Crash injection proves no concurrent replacement writer and no duplicate successor. |
| 3 | Automatic planning | Add coverage-checked initial decomposition and remaining-only replanning. Existing child prompts remain the executable units; accepted work is retained. |
| 4 | Command and evidence service | Unify managed command admission, phase restrictions, fingerprints, process supervision and fresh results. Polls cannot renew command deadlines or satisfy progress checks. |
| 5 | Recovery and continuation | Add the deterministic recovery ladder, compatible saved-item native resume and structured fresh handoff. Exhausted local attempts trigger bounded automatic strategy changes. |
| 6 | Completion and visibility | Require complete phase-specific criterion coverage, materialize deferred obligations and publish truthful UI status and delivery reports. |
| 7 | Canary and recovery | Run isolated fault scenarios, shadow the live scheduler without dispatching, then enable the new engine on one approved requirement at a safe boundary. Recover S1-02 using the preceding procedure. |

Packages 1 and 2 may share a migration, but launch invariants must land together. Package 4 may reuse a repository-local process supervisor; do not make the app depend on MaterioForge-specific source paths.

Key source areas:

| Concern | Existing files to extend | Suggested isolated modules |
| --- | --- | --- |
| Types and transition explanations | shared/src/index.ts, shared/src/pipelineRules.ts, shared/src/statusModel.ts | shared/src/executionPlan.ts |
| Schema and persistence | server/src/workspaces.ts | server/src/executionStore.ts, server/src/evidenceStore.ts |
| Scheduling | server/src/pipelineScheduler.ts | server/src/executionSupervisor.ts, server/src/dispatchOutbox.ts |
| Agent starts and prompts | server/src/runService.ts, server/src/agentContext.ts, server/bin/agent-step.mjs | server/src/unitHandoff.ts |
| Resource monitoring | server/src/runner.ts, server/src/adapters/resourceContainment.ts | server/src/commandTasks.ts, server/src/resourceAdmission.ts |
| Criteria and review | server/src/definitionOfDone.ts, server/src/completionAudit.ts, server/src/suiteVerification.ts | server/src/evidenceEvaluator.ts, server/src/recoveryPolicy.ts |
| API | server/src/workspaceApi.ts, server/src/index.ts | Reuse existing route conventions and authentication. |
| UI | web/components/pipeline, web/components/activity, web/components/agents, web/lib/workspacesApi.ts | Extend the existing inspector and shared status model. |

Module names are proposed boundaries, not a demand for one file per noun. Avoid placing every new concern back into workspaces.ts.

## Required acceptance scenarios

1. Twenty consecutive agent CONTINUE requests cannot create twenty unbudgeted writer sessions.
2. Reaching a unit's attempt limit automatically chooses an authorized recovery action while root budget remains; the user is not asked to press Resume.
3. A repaired ordinary failure reaches delivery without any additional operator action.
4. Splitting a unit or changing provider does not reset root time, cost, attempt usage or failure history.
5. A completed unit remains closed after restart, replay, provider fallback and plan revision.
6. Repeated tool polls and identical reads cannot masquerade as accepted progress or extend a command deadline.
7. A long, quiet compiler that is advancing receives its bounded allowance; sustained reclaim without advancement triggers the approved recovery profile.
8. Crash before dispatch, after dispatch, after OS spawn and after result persistence each reconcile to at most one active writer for the effect.
9. Late results from a stale attempt cannot change current task status; an old filesystem writer is confirmed dead before another owns the same tree.
10. Operator PAUSED and STOPPED states survive every restart path.
11. A successful check is reused only for matching source, recipe, toolchain and relevant environment; dirty edits, changed contracts, mid-check mutations or dependency changes invalidate it.
12. A reviewer cannot close a task by omitting required criteria, naming unknown IDs, returning empty checks or relabeling stale evidence.
13. Implementation completion with deferred S1-06 obligations advances correctly without claiming verified delivery or deadlocking on that future stage.
14. A planner that drops a requirement, weakens an acceptance criterion, creates a cycle or reopens accepted scope is rejected.
15. Lost native session state causes one bounded fresh handoff with current instructions and credentials; revoked launchers cannot mutate the new attempt.
16. One stalled station does not authorize violating dependencies or stage order. Already eligible independent work may proceed only within the declared policy.
17. All normal technical failures in the fixture corpus recover unattended. True missing credentials yield one deduplicated actionable request and automatic resumption after resolution.
18. No provider capability screen claims strict command enforcement when execution is only cooperative.
19. An S1-02 replay fixture reuses accepted batches, completes a bounded remaining plan, runs the assigned final verification and produces a coverage-linked delivery report.
20. Unknown usage or a failed telemetry write cannot create free work or unbounded dispatch.

Use deterministic clocks and fixture adapters for scheduler and recovery tests. Add real subprocess tests for locks, cancellation, process cleanup and crash windows. Browser tests should assert truthful state and recovery behavior using mocked providers. Reserve live provider calls for a bounded canary; do not use a live console database in tests.

## Rollout and rollback

Add an execution engine version and policy snapshot to each requirement. Shadow mode computes and records proposed decisions without spawning, mutating work-item status or sending operator messages. Compare decisions against the current scheduler.

Do not switch a requirement between engines mid-command. Drain to a checkpoint, reconcile active processes and effects, then adopt it transactionally. Old callbacks are fenced. Legacy history is retained and imported evidence remains explicitly unverified where fresh checks are required.

Back up the live database and confirm restore before a production migration. Use the existing versioned migration mechanism. Test upgrade and rollback on an isolated copy, not by manually changing the live SQLite file.

A feature flag may stop new-engine dispatch, but rollback must not revive the unlimited legacy loop on adopted tasks. Drain or hold those tasks with their ledger intact. Destructive schema rollback is not the recovery path.

Canary success requires both successful delivery scenarios and injected recoverable failures, with zero unnecessary operator interventions, no duplicate writers, correct accounting and no false completion. Measure useful work per session, repeated setup, verification reuse, recovery success, time/cost per accepted unit and exception quality. Report results before enabling every workspace.

No migration or deployment is part of reviewing this plan.

## Handoff instructions for the implementing AI

Treat this proposal as the implementation specification after the owner approves it. Begin with package 0 and implement in the stated order.

Inspect the current working tree and applicable instructions first. This repository already contains unrelated uncommitted work; do not reset, overwrite or bundle it. Preserve the Grok instruction-delivery fix and the existing managed build tests.

Read the scheduler, saved-item resume guard, decomposition transaction, completion evaluator and current UI policy explanations before editing. Replace the test that deliberately requires unlimited voluntary continuations and update the policy contract, persisted counters, protocol and UI together.

Use disposable databases and settings files for tests. Existing commands include npm run typecheck and the package test scripts. Targeted server tests must set AGENT_CONSOLE_DB and SETTINGS_FILE to disposable paths before importing persistence modules. Read scripts before running broad checks. Do not run the live scheduler against a copied database that still points at real workspace directories.

Keep data and migrations additive, transitions auditable and external effects idempotent. Demonstrate the acceptance scenarios with test output and a canary report. Do not stop after updating prompts, adding a continuation cap, or drawing a new dashboard: the implementation is complete only when the supervisor recovers, verifies and delivers within its approved envelope.

## Architecture references

These references explain the underlying execution patterns; they are not a recommendation to replace the current application stack.

- [Temporal continuation](https://docs.temporal.io/develop/go/workflows/continue-as-new) distinguishes logical work identity from a new execution and carries state explicitly.
- [Temporal retry policy](https://docs.temporal.io/encyclopedia/retry-policies) documents bounded attempts, backoff and overall execution deadlines.
- [Temporal activity failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures) separates worker heartbeats from durable progress details.
- [AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) covers committing state and dispatch intent together and handling duplicate delivery.
- [SQLite isolation](https://www.sqlite.org/isolation.html) describes serialized writers and transaction visibility.


# Autonomous pipeline reliability implementation

Date: 20 November 2026  
Specification: [autonomous-pipeline-reliability-plan.md](autonomous-pipeline-reliability-plan.md)  
Status: Live pilot stopped after exhausting its recovery allowance; no live unit accepted. Corrections deployed and validated with 664 tests. [Current correction and proposed bounded pilot](../.artifacts/pipeline-reliability/budget-exhaustion-20261122/report.md). A new allocation has not been approved.

## Review and implementation decisions

The existing unlimited voluntary-continuation test described a real scheduler contract, not an incidental conditional. All automatic legacy CONTINUE successors now consume its displayed allowance. Adopted requirements additionally retain cumulative accounting across native sessions, provider changes, child work, review, replanning and restart. A manual Resume cannot erase their ledger.

A successful compiler is insufficient to establish the original requirements. Intake always adds an independent semantic review obligation anchored to the original prompt hash, in addition to existing required command criteria. This obligation is visible to the supervised engine and does not change legacy completion behavior in shadow mode. Review must cover all required criterion IDs; unknown IDs, duplicates, stale inputs and contradictory COMPLETE reports are refused.

Child units may contribute scoped targets to a criterion. A complete integration owner remains required for every criterion. Plans preserve accepted units and remaining target IDs. Derived deferred checks must quote an exact original source span naming an existing verifier and retain its required gates. This supplies a bounded way to describe later verification without silently weakening the original contract or making implementation wait on its own successor.

Multiple requirements in one approved budget scope may share an enabled final verifier. The verifier has one physical owner and one dispatch; its gates include every enabled consumer. Dispatch waits for every consumer's dependencies, and one transaction accepts the fresh evidence for all consumers. Shadow intake cannot change active verification gates. A verifier already accepted cannot be reopened by another contract.

The implementation extends the existing prompt hierarchy and `dod_result` evidence store. It introduces no external service, second task hierarchy, live database rewrite script, or application dependency on MaterioForge paths. The existing Grok instruction delivery change and managed build behavior remain intact.

## Implementation boundaries

| Area | Implementation |
| --- | --- |
| Contracts, plans, versions, accounting | `shared/src/executionPlan.ts`, `server/src/executionStore.ts`; additive schema migration 44 |
| Deterministic dispatch and recovery | `server/src/executionSupervisor.ts`, `server/src/recoveryPolicy.ts`, existing scheduler |
| Process ownership | Durable dispatch IDs, repository and command leases, scoped credentials, generation checks, Linux process identities and systemd unit reconciliation |
| Commands | `server/src/commandTasks.ts`, `server/src/dodCommands.ts`, shared host pool, absolute deadlines, cgroup containment where available, output and resource observations |
| Evidence | Existing `dod_result`, source/recipe/environment/toolchain fingerprints, before/after source stability, current-phase coverage |
| Session handoff | Compatible saved-item native resume, fresh credentials, instruction/permission manifests, bounded structured handoff |
| Operator visibility | Execution panel, finite worker and root allowances, deferred verification, recovery history, exceptions, coverage-linked report |
| Protocol | `agent-step execution`, `check`, `plan`, structured continuation, generation/revision fields, durable command/checkpoint request handling |

State and reservations commit before dispatch. Provider launches, Git operations and builds execute outside database transactions. A lease expiry cannot release a filesystem writer. Uncertain processes retain ownership and are quarantined; known managed commands remain tracked after their provider stops. Reconciliation can proceed once process death is established. Pause and Stop persist through restart.

Writer settlement fences attempt credentials while retaining repository ownership through evidence acceptance. A restart resumes this finalization from the durable settled effect. Periodic reconciliation neither accepts a still-running worker's DONE claim nor releases ownership held by an active finalization callback.

Currency limits are not represented as hard guarantees. Actual reported usage and conservative reservations are accounted cumulatively; missing usage consumes its reservation. Time and attempt limits remain finite. systemd gives OS-owned runtime and aggregate resource limits; the process-group fallback provides cancellation and identity checks with more conservative crash reconciliation.

## Using the candidate

1. Select a saved station's configuration and open **Autonomous execution**. Capture a finite remaining-work allowance in shadow mode. The original prompt and its criterion manifest are retained.
2. Inspect the plan and shadow decisions. Enable the supervisor at a checkpoint with no active writer. Existing tasks are not silently adopted and no engine switches mid-command.
3. Play the owning pipeline. Every writer and reviewer reserves allowance before it starts. Local attempt exhaustion selects bounded diagnosis, remaining-only replanning or a permitted provider strategy. Provider availability waits have durable wake times.
4. Implementation closure can advance to an explicitly assigned verifier while the requirement displays verification pending. Verified delivery requires all planned obligations and fresh evidence.

The operator API is `/api/prompts/:id/execution`. GET returns the contract, plan, accounting, event history and coverage report. POST actions include `adopt`, `plan`, `enable`, `budget`, `amend`, `pause`, and `stop`. Intake requires a finite policy; `budgetScope` can share a ceiling across related contracts. Shared scopes require the same approved policy snapshot. A budget amendment retains consumption and records an explicit reason; a waiting RUNNING requirement can then resume automatically. A requirement amendment versions the original text, invalidates affected work conservatively and retains usage/history.

`AGENT_CONSOLE_SUPERVISOR_HOLD=1` stops supervised dispatch while retaining contracts, leases and accounting. It does not route adopted work back into legacy scheduling. Restoring the old schema is not a production rollback strategy.

All currently exposed provider command capabilities are labeled cooperative. Native CLI execution can bypass a named-command wrapper. These controls do not claim universal shell interception or a new security boundary around the console's existing trusted operator HTTP API.

## Validation

Validation runs use disposable databases, temporary workspaces and fixture providers. No test starts the scheduler against the live database or a copy naming real workspaces.

The fixture corpus covers:

- Voluntary continuation caps; local-attempt recovery reaching verified delivery from one Play.
- Dirty edits, recipe changes, missing/unknown/duplicate criteria, original requirement review, and deferred implementation/verification phases.
- Durable dispatch reservations, replay/conflicting requests, process survival, crash windows before dispatch/after claim/after spawn/after result persistence, and refusal to transfer ownership while a writer may live.
- Pause/Stop durability; closed units remaining closed; compatible native-session reuse; failure signatures and bounded remedy selection.
- Unknown usage and a failed telemetry write retaining reservations; explicit budget allocations retaining consumption.
- Checkpoint response loss and retries preserving later uncommitted edits.
- Isolated v43→v44 upgrade, legacy row preservation, integrity/foreign-key checks, backup restoration and repeat upgrade.
- Desktop/mobile browser states for deferred checks, verified delivery, recovery and exhausted allowance, using mocked API data.
- Shared final-verifier acceptance across multiple requirements, shadow isolation, and ownership held through acceptance and crash recovery.

Final release checks passed on 20 November 2026:

| Check | Result |
| --- | --- |
| `npm test` | 654 passed: shared 102, server 444, web 108; zero failed, skipped or cancelled |
| `npm run typecheck` | All three workspaces passed |
| `npm run build` | Shared/server build and Next.js production build passed |
| `node scripts/verify-execution-browser.mjs` | Desktop/mobile assertions passed; no browser errors or horizontal overflow |
| `npm run verify:contrast` | All three themes passed |
| `git diff --check` | Passed |

Logs, screenshots and machine-readable results are saved in [`.artifacts/pipeline-reliability`](../.artifacts/pipeline-reliability). The browser script uses the existing `CHAT_PLAYWRIGHT_MODULE` and `CHAT_BROWSER_EXECUTABLE` overrides when Playwright is installed outside the project. This validation used the pre-existing temporary Playwright installation and cached Chromium; it added no project dependency.

These checks establish local fixture behavior and build readiness. They do not establish production-provider canary results or completion of live MaterioForge requirements.

## Production rollout gate

The 20 November local implementation performed no live migration, deployment, pipeline mutation or provider launch. The owner subsequently approved the proposed canary and restart on 22 November. The [rollout report](../.artifacts/pipeline-reliability/canary-20261122/report.md) records the verified backup, observed canary defects and corrections, independent acceptance, retained charges and actual S1-02 restart. Live MaterioForge delivery is ongoing and is not claimed complete.

A read-only console snapshot at 2026-11-20 10:03:51 UTC identified the current target as workspace 1 (`materio-forge`), program `MITAUG`, suite 57, S1-02 prompt 262, with final verifier S1-06 prompt 266. The suite pipeline was STOPPED with `operator_stop`; the console reported no active process for S1-02's last interrupted run. Historical prompts with the same S1-02 key are not the target. This observation is not OS-level death confirmation and must be refreshed before rollout. The stopped pipeline has been left stopped.

Packages 0–6 and the isolated fault scenarios are implemented. The approved package 7 pilot captured shadow adoption without dispatch, completed the controlled provider canary after documented corrections, and restarted S1-02 through supported services. Broader enablement remains gated; production work continues under its finite approved envelope.

The specification requires a backed-up and restore-tested live database, an approved finite remaining-work allocation, a safe checkpoint, process reconciliation and controlled adoption of one requirement. The current live operation inventory and checkpoint must be recomputed at that boundary; the historical unchecked-operation count in the proposal must not be used as today's input.

After those inputs and authority are supplied, the remaining operational sequence is: back up and verify restore on an isolated copy; checkpoint/drain; migrate using the application migration mechanism; adopt the actual remaining S1-02 plan and S1-06 obligations with historical implementation retained; run a bounded provider canary with injected recovery; review its delivery and accounting report before broader enablement.

### Approved rollout allocation

Target prompt 262 and its remaining S1 stage sequence, retaining verifier 266 and existing order. First inspect the actual worktree, process identities, checkpoint and protected-operation inventory without dispatch. Preserve completed batches as historical implementation; fresh final proof remains outstanding. Derive the remaining children from that inventory rather than the historical count of 31. Preserve each requirement's original exclusions and authority. Adopt other requirements only where necessary for shared verification and with the same finite scope; do not enable every workspace.

The owner approved this allocation and restart on 22 November 2026. It is active as one shared scope, including all canary charges; it has not been reset:

| Limit | Proposed allocation |
| --- | --- |
| Total attempts, including workers, reviewers and recovery | 24 |
| Cumulative active time, including reservations | 12 hours |
| Accounted tokens, including reservations and unknown usage | 6,000,000 |
| Absolute deadline | 24 hours after approved rollout starts |
| Each worker | 45 minutes; 250,000 tokens |
| Ordinary attempts per unit | 3 |
| Reserved recovery attempts | 6, within the 24 total |
| Recovery time/token reserve | 20% of the totals |
| Remaining-plan revisions / provider changes | 2 / 2 |
| Concurrency | One repository writer; one managed heavy command |

Token accounting is not a dollar spend cap; missing usage consumes its reservation and observed overages remain recorded. Provider access and existing authority boundaries still apply. The deadline was computed at rollout start and is recorded in the live report. Any additional allocation requires a new explicit approval and must retain existing consumption.

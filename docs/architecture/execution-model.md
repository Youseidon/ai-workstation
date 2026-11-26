# Execution model

| | |
|---|---|
| Status | Baseline specification |
| Audience | Solution architect, developer, product owner |
| Depends on | [Domain model](../domain/domain-model.md), [business requirements](../product/business-requirements.md) |

This document specifies how work moves. The nouns are defined in the domain model. If a screen and this document disagree about what Play, Done, or Resume mean, this document wins until someone changes it on purpose.

## 1. Kinds of agent run

Every child is an agent run with a role and a source. The source is what the console shows under the run. The role is what the locks and the Git rules key on.

| Source | Role | Writable | Clean Git required | Holds the writer lock |
|---|---|---|---|---|
| Custom conversation, mode Run | `execute` | yes | no, but the checkpoint rule still applies to its own commits | yes |
| Saved work item | `execute` | yes | yes, plus a repository with at least one commit | yes |
| Custom conversation, mode Ask | `consult` | no | no | no |
| Clarification on a work item | `consult` | no | no | no |
| Suite or work-item verification | `consult` or the reviewer's role as recorded | no | no | no |
| Completion audit | review path, stored so it is not a second writer | no | no | no |
| Handoff brief | `handoff` | no | no | no |
| Program author | `author` | the author is not a read-only sandbox; the brief tells it not to edit | the author holds the writer lock | yes |
| Instruction proposal | `author` | proposes text; apply is a later operator act | holds the writer lock while it runs | yes |
| Wrap-up after a budget or manual stop | `execute` | may checkpoint the partial work | the finalisation turn exists to commit that partial work | the lock it already held |

**Decision EX-01.** "Read-only" is a product obligation enforced by role, lock, and prompt. It is a hard sandbox only where a provider's own mechanism says so, and only where the station policy requires that mechanism to be verified. The author role is the worked example: it holds the writer lock because the product will not pretend a brief is a sandbox.

## 2. Before a child starts

The runtime refuses, with a reason, and starts no child, when any of these hold:

| Condition | Refusal the operator can read |
|---|---|
| Workspace directory is missing | The directory no longer exists. |
| Saved work item, path is not a Git repository | A Git repository is required. |
| Saved work item, repository has no commit | An initial commit is required. |
| Saved work item, working tree is dirty | Resolve your own changes. Ask remains available. |
| Another writable run holds this workspace | The workspace is busy. |
| A fourth consultation is requested | The consultation limit is three. |
| Another account, or this account, already writes this repository | The Git repository is busy. |
| Model is outside the account ceiling | The model is not allowed by the access tier. |
| Provider is disabled, missing, or not authenticated, and assumption is off | The provider's own reason. |
| Protected Cursor station whose sandbox cannot be verified | Enforcement could not be verified. The run does not start. |
| Supervised contract is in shadow mode and the caller asked for a live dispatch | Shadow mode records. It does not dispatch. |

Pipeline refusals become a wait or a park with `start_refused:<code>`, not an agent `error`. The operator's next action is Resume after they have removed the cause, or a change of assignment.

## 3. Locks

| Lock | Scope | Holders |
|---|---|---|
| Workspace writer | One workspace | One `execute` or `author` run |
| Consultation slots | One workspace | Up to three `consult` runs |
| Git repository | One repository root, across every account on the installation | One writer |
| Work item execute | One work item | One active `execute` run |
| Pipeline run | One pipeline definition | One non-terminal pipeline run |

A consultation does not take the Git writer lock. Two accounts may read. They may not both write.

Locks are released when the run reaches a terminal state, including on process crash recovery: a run whose child is gone is not left holding the lock forever. Crash recovery is specified in [section 8](#8-restart).

## 4. What the agent is allowed to ask Hydra

During a run the agent uses `agent-step`. The verbs and the refusal codes are the contract in [service contracts](../interfaces/service-contracts.md). The execution rules those verbs must honour:

| Verb | Rule |
|---|---|
| `context`, `state`, `execution`, `check`, `inbox` | Read. No library mutation. |
| `remark` | Append a remark. Do not change status. |
| `reply` | Deliver an answer the operator already submitted, or record the agent's side of an aside. |
| `checkpoint` | Commit this run's changes with a valid subject. Refuse if the subject is empty or longer than 72 characters. Do not stage the operator's pre-existing changes. |
| `done`, `continue`, `blocked`, `decompose` | Terminal or structural handoff. If the tree is dirty, refuse with `git_commit_required` and do not change status. |
| `ask` | Park for a human answer. This is a real wait, unlike a sentence in the transcript that says "waiting". |
| `plan` | Submit a supervised plan. The plan is validated before it is stored. An invalid plan does not bump the revision. |
| `decompose` | Create child work items. Depth is finite. Title collisions refuse the post and keep the children already created. |
| `propose-program`, `propose-suite`, `revise` | Write the draft. Do not insert a program. |
| `repair-verify` | Re-run or repair verification evidence under the same rules as any other command criterion. |

**Decision EX-02.** A terminal handoff is a transaction with the checkpoint. Status does not move to a handoff state while uncommitted work remains. Budget expiry and operator stop are the exception that proves the rule: they grant one short finalisation turn whose job is the checkpoint, then they end.

## 5. Ordinary pipeline scheduling

### 5.1 Choosing the next station

A station is ready when:

- its stored status does not satisfy its dependents' need for it to be finished, and it is not skipped,
- every dependency satisfies a dependency, per the status catalogue,
- no active execute run holds it,
- an assignment resolves.

Assignment resolution order:

1. Station override on this pipeline, when set.
2. Suite assignment on this pipeline.
3. House default from pipeline policy.

The first eligible provider in that chain is the one that starts. Eligibility uses the provider's ready state, the model ceiling, and, only when automatic reassignment is on, the provider's reported allowance and cooling state.

**Decision EX-03.** Unknown usage does not make a provider ineligible. A provider that reports an exhausted window, or that is inside a cooling period after a classified failure, is ineligible for automatic reassignment. With automatic reassignment off, the assigned provider is the one that is tried, and a failure waits for the operator.

Cooling and transient-failure classification live in one policy module. Adapters report failures. They do not invent wait durations.

Default house fallback order, used when reassignment is on and the policy has not been edited: Codex, Claude, Cursor. A handoff row records the source run, the successor, and the recommendation. The stored assignment is unchanged so the next Play still starts from the operator's choice.

### 5.2 When a station ends

| Ending | What the scheduler does |
|---|---|
| Done, and blocking definition-of-done criteria passed | Apply `onDone`: `continue` advances, `stop` ends the pipeline, `skip_rest` skips the remainder of the stage. |
| Explicit continue handoff | Run the same station again on the same tree. A productive continue does not spend the unfinished allowance. |
| Unfinished: crash, missing report, failed verification, budget stop | Apply `onUnfinished`. `continue` spends one of the allowance and runs again. `skip` marks the station skipped and moves on. `wait` parks for the operator. |
| Allowance spent, and review-after-continuations is on | One read-only review, then park at `continuations_exhausted` if still unfinished. |
| Provider cannot run, reassignment off or no eligible fallback | Park at `provider_unavailable` or `no_provider_available`. |
| Agent called `ask`, or a human gate the policy does not waive | `WAITING_HUMAN` with `human_question`. |
| `onUnfinished` is `wait`, or the station posts blocked and the rule waits | Park. |
| Operator pause | Finish the current agent when pause mode is graceful, then start nothing. Immediate pause interrupts. |
| Operator stop | Interrupt the agent if policy says stop interrupts, end the pipeline run, leave finished stations finished. |

Default policy, which the field table may override per account:

| Policy | Default |
|---|---|
| Pause mode | graceful |
| Stop interrupts the agent | yes |
| On server restart | auto-resume |
| Max continuations | 4 |
| Review after continuations | yes |
| Definition-of-done enforcement | block |
| Default on unfinished | continue |
| Default on done | continue |

**Decision EX-04.** A sentence in the work item that asks for a human, and the value `wait` appearing in prose, do not park the pipeline. The park is the station's `onUnfinished` value, the agent's `ask` verb, or an operator control. Product copy shall not tell the operator otherwise.

**Decision EX-05.** Waiving a human review continues the pipeline and records the waiver. It does not record the review as passed. Command criteria with enforcement `block` still block.

### 5.3 Resume

| Parked because | Resume does |
|---|---|
| Continuations exhausted | Records the operator's decision, grants a fresh allowance, continues the same tree. |
| Provider unavailable | Tries again, or uses the assignment the operator changed first. |
| Dirty tree or Git refusal | Tries the preconditions again. Does not clean the tree. |
| Human question | Continues only once the answer is recorded, or the operator explicitly waives. |
| Supervised budget exhausted | Does not renew the allowance. A new allocation is a different act. |
| Force-stopped agent | Continues the station and does not spend a continuation for the force-stop. |

## 6. Definition of done

A criterion has a kind, a scope, an enforcement, and results.

| Kind | Passes when |
|---|---|
| `PROSE` | A human, a reviewer, or an agent source records `PASSED`, according to who is allowed to satisfy it. Prose never passes itself by being present in the prompt. |
| `COMMAND` | The server runs the command in the workspace, the exit code is zero, and the result source is `RUNNER`. |
| `CHILDREN_CLOSED` | Every child work item is in a status that satisfies dependencies. |

| Enforcement | Effect |
|---|---|
| `block` | An unmet criterion prevents Done. This is the default. |
| `warn` | The gap is recorded and the transition may proceed. |
| `off` | The criterion is stored and is not evaluated as a gate. |

Command bounds: timeout default 120 seconds, minimum 1 second, maximum 600 seconds, output retained up to 16,000 bytes, command text up to 2,000 characters. The `## Verify` fenced shell block in a work item is the authoring format for command criteria. The parser, not the agent, extracts the commands.

Results are `PASSED`, `FAILED`, or `UNVERIFIED`. Sources are `AGENT`, `REVIEWER`, `RUNNER`, and `HUMAN`. A `RUNNER` result is the only result that satisfies a blocking command criterion. An agent that writes "tests passed" into a remark does not.

**INV, restated for execution.** A work item becomes `DONE` only through a path the catalogue allows: the agent's accepted status post, a reviewer's applied `COMPLETE` verdict, or the operator's own completion act. Each of those paths checks blocking criteria first.

Suite verification is a stored artefact: kind, provider, model, state, verdict, per-item checks, and its own event log. It can cover a suite or one work item. It is evidence. It is not a second pipeline.

Completion audit verdicts are `COMPLETE`, `INCOMPLETE`, and `UNVERIFIABLE`. The audit run is read-only. Applying the verdict is a recorded update to the work item. An unapplied audit changes nothing about status.

## 7. Checkpoints and change capsules

At the start of a writable work-item run the runtime records the repository root, the branch, and the base commit.

A checkpoint:

- has a single subject line, imperative, at most 72 characters,
- creates a commit of the run's changes on top of the base lineage,
- refuses if a hook rejects the commit, and surfaces that as a Git wait reason rather than amending or skipping hooks,
- refuses if the branch no longer descends from the base, and does not rebase.

The change capsule then moves to `COMMITTED` with head, file counts, and commit count, or to `UNCHANGED`, `NEEDS_COMMIT`, or `UNAVAILABLE` as the domain model defines.

Decompose and further continues keep using the same lineage. A later station on the same tree sees the checkpoint as a normal commit. The operator's uncommitted work from before the run is never part of that lineage because the run would not have started while it existed, for a saved work item, and because the checkpoint staging rule excludes it in general.

## 8. Restart

| Situation | Required behaviour |
|---|---|
| Live console starts, pipeline run is non-terminal, stop reason is the crash or `server_restart`, policy is `autoResume`, the run is less than 24 hours old | Re-queue the current station on the same tree. Do not mark it done or failed because the process vanished. |
| Policy is `resumeSameRun` | Resume that run without creating a new one. |
| Policy is `newRun` | The operator starts a new run. Finished stations stay finished. |
| The operator had stopped the pipeline | Leave it `STOPPED`. |
| The process is a development sandbox | Do not auto-resume, regardless of copied policy values. |
| A child is found dead and the run row is still `running` | Settle the run as `error` or `interrupted` according to whether a stop was requested, release locks, and let the pipeline rules decide the station. |

**Decision EX-06.** Process death is not a verdict on the work. The work's verdict comes from a checkpoint, a definition of done, or an operator act.

## 9. Supervised execution

Ordinary continuations are not an allowance. A delivery contract is an allowance, and it is opt-in per requirement.

### 9.1 What the operator records

- The original requirement text and its hash.
- Criteria, each pinned to a source span and a phase (`implementation` or `verification`).
- A policy of positive finite limits: max attempts, max active milliseconds, max tokens, a deadline in the future, a worker reservation for time and tokens, per-unit attempts, recovery attempts, max replans, max provider changes.
- The engine: `shadow` first, `supervised` only after the operator has seen shadow decisions and enabled it.

Validation rejects a worker reservation larger than the envelope, a recovery reserve that consumes the whole attempt budget, a recovery reserve that leaves less than the required headroom in the envelope, and a deadline that has already passed.

### 9.2 Plan

A plan is a revision, strictly one greater than the previous revision, of work units. Each unit names an existing work item, one or more criteria of the matching phase, at least one target, dependencies inside the plan, and a rationale. The plan has no duplicate units, no cycles, no dropped original criteria, and at least one non-contribution owner for every criterion. Unit count is at most 157.

A replan keeps every accepted unit identical and keeps every remaining target. The validator rejects the plan otherwise. Rejection does not increment the stored revision.

### 9.3 Budget ledger

Each dispatch reserves worker time and worker tokens up front. Settlement writes the actuals. If the provider returns no token usage, `unknown_usage` is set and the reserved tokens are consumed in full. The ledger is the source of "how much of the allowance is gone". The run's own usage columns remain the source of the usage report. They are not averaged together to fill a null.

When reserved plus consumed would exceed the contract, the supervisor does not dispatch. The pipeline parks with the execution budget reason. Resume is not an allocation. A new allocation appends a contract version with the operator's reason and leaves usage, accepted units, and recovery cases in place.

### 9.4 Phases

`implementation` then `verification` then `delivered`. Verification criteria are not satisfied by the implementation unit that authored them when the station policy says verification is deferred. Deferred stations name a verifier. Their command criteria may be marked supervisor-only so an implementation agent cannot satisfy them by running the check itself.

### 9.5 Shadow

Shadow mode persists the decisions, the plan validations, and the would-be dispatches. The outbox does not enter `RUNNING`. Enabling the supervisor applies to a subsequent Play. It does not retroactively execute the shadowed actions.

### 9.6 Recovery

A recovery case records a signature, a remedy, and evidence, unique on that tuple per unit. Recovery attempts come out of the policy's recovery reserve. A recovery that would exceed it parks like any other exhausted budget.

## 10. Asides

An aside is a run message with a direction and a delivery:

| Delivery | When |
|---|---|
| `native` | The provider accepted the text mid-turn. |
| `inbox` | The provider will see it at the next `agent-step` check-in. |
| `resume` | The operator chose to interrupt and deliver by resuming the session. |

Messages are `QUEUED`, `DELIVERED`, or `SUPERSEDED`. A newer aside supersedes an undelivered one rather than queueing an unbounded stack. The agent confirms delivery by reading the inbox. The operator sees the delivery state.

## 11. Reporting relationship

The execution model emits the facts the usage report is allowed to show:

- per run, the usage columns, null if unknown,
- the provider and model actually used, including after a handoff,
- the estimate from the rate table, labelled as an estimate,
- sessions with no rate, listed as unpriced,
- sessions with unknown tokens, listed as unmeasured.

The report shall not backfill Cursor tokens, shall not treat a null as zero, and shall not change a true zero into unknown. CSV export uses the same selection as the report window, not the client's text filter.

## 12. Operator-visible reasons

Wait and stop reasons are a closed vocabulary. The console shows the specified sentence for each code. New codes are added here and in the policy module together.

| Code | Sentence the operator sees |
|---|---|
| `operator_stop` | You stopped it. |
| `server_restart` | The server restarted mid-run. |
| `nothing_ready` | Nothing on the flowchart was ready to run. |
| `blocked_on_dependencies` | Every remaining station is waiting on another one. |
| `on_done_stop` | A station's rule said stop when done. |
| `skip_rest` | A station's rule skipped the rest of the stage. |
| `no_provider` | A station had no agent assigned. |
| `provider_unavailable` | The assigned agent could not run. Reassignment is off, or none was eligible. |
| `no_provider_available` | Every configured provider is unavailable or cooling. |
| `start_failed` | The agent process failed to start. |
| `worktree_dirty` | The working tree has changes no agent run accounts for. |
| `human_question` | The agent asked a question only you can answer. |
| `station_rule_wait` | This station's rule is to wait when it does not finish. |
| `review_running` | A read-only reviewer is checking the station. |
| `continuations_exhausted` | The unfinished allowance ran out and the station is not done. |
| `execution:budget_exhausted` | The approved allowance is exhausted. Resume will not renew it. |
| `start_refused:git_repository_busy` | Another agent is still writing in this Git repository. |
| `start_refused:workspace_busy` | Another run is already in progress in this workspace. |
| `start_refused:prompt_run_active` | This work item still has a live session. |
| `start_refused:git_operation_failed` | Git could not commit the leftover work. A hook is the likely cause. |
| `start_refused:git_history_rewritten` | The branch no longer descends from where the run started. |
| `start_refused:git_repository_required` | The workspace directory is not a Git repository. |
| `start_refused:git_initial_commit_required` | The repository has no commits yet. |
| `start_refused:invalid_directory` | The workspace directory no longer exists. |

The product shall not replace these sentences with a generic "something went wrong" when the code is known.

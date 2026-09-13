# User flows and decision contracts

Parent: [Design baseline](README.md). Runtime rules: [Protocol](protocol.md).
Every task action below has a version, authorized actor and durable receipt.
Disabled choices MUST explain the unmet condition. An unknown condition MUST NOT
be silently interpreted as approval, success or completion.

## 1. Conversation and status

One task keeps one conversation across attempts, questions and further handoffs.
The user creates/chooses the authorized Telegram group during setup; the app can
create task topics after permission checks. It does not promise automatic group
creation or automatically add people. Personal tasks can use a topics-enabled
private bot chat where supported, or a private project group containing the owner
and bot. Unsupported topic setup must be reported, not mixed into an unstructured
multi-task thread.

Each bot maintains its own task status message, labelled with workstation and
role. The originating bot pins the task overview; the executing bot pins its
execution status when taking over. Do not have bots compete to edit one another's
messages. The overview links the active executor/status and published checkpoint.

Status presents three independent facts:

| Dimension | Examples |
| --- | --- |
| Execution | Running; pause requested; paused; finished; status unknown since a stated time. |
| Decision | Awaiting requester answer; answer saved; permission decision needed; superseded. |
| Action receipt | Received; waiting for publication; queued; starting; applied; rejected. |

Only milestones, warnings and questions create notifications. Streamed tokens,
routine tool output and full logs remain in the local UI. Details in Telegram
expand sanitized context; they must not link a phone to an inaccessible localhost
URL. A protected remote details page would be a separate later capability.

## 2. Personal task needs input

Trigger: the task has a concrete unresolved dependency or user decision.

1. The local app records a question with task/revision, intended respondent,
   what is blocked, relevant evidence, options/consequences and execution status.
2. The bot posts it in that task's conversation. Reply identifies the question.
3. The requester can choose Save answer, Answer and resume, Ask for clarification,
   Change instructions, or Leave waiting.
4. Save answer records a decision but holds execution. Answer and resume records
   the same decision plus an explicit resume command; it is not a second prompt.
5. Resume checks current question/revision, local permissions, pipeline ownership,
   provider availability and approval validity. Failure preserves the answer and
   offers Resume with saved answer after the specific problem is resolved.

For initial release, a required input pauses this task and its dependent pipeline.
Other workspaces continue. Optional suggestions are discussion, not blockers.
Do not invent new parallel scheduling within a blocked workspace. Clarification
may use an already authorized read-only provider; report unavailable capacity and
allow human clarification without requiring another LLM call.

An ordinary chat message is not a task instruction. A reply submitted through the
answer flow shows the selected question and offers the two save actions. The
explicit action is the confirmation; do not add another generic confirmation.

## 3. Advisory quota decision

Trigger: a fresh reported limiting window reaches at most 5% remaining.
Show which window, estimated remaining percentage, observation time, current
task activity, and whether the figure is fresh. Account usage is visible only to
its owner by default; a team topic receives a generic capacity warning.

| Choice | Effect | While waiting / failure |
| --- | --- | --- |
| Continue | Acknowledge this quota warning; keep the currently authorized execution and pipeline policy. | Does not authorize new spending, accounts or broader tools. Hard exhaustion becomes a different event. |
| Prepare to pause | Hold new pipeline starts; request controlled interruption, then checkpoint and optionally summarize. | No promise to finish the current implementation step. If stopping cannot be established, show status unknown and do not release ownership. |
| Request takeover | Choose a named recipient; freeze and capture, review the exact export, then publish and offer it. | No new receiver starts before publication and confirmed release of the old writer. Failed export leaves the original task held with retry/resume choices. |
| Change provider | Present an explicit provider/model/authentication selection and any billing change, then stop/checkpoint before replacement. | No implicit API fallback or imported credential. Missing compatible provider leaves the task waiting. |
| Pause now | Interrupt without waiting for an optional summary; save available file state after writing stops. | Show pause requested until confirmed; preserve uncertainty around in-flight external actions. |

No response to the quota warning means existing approved work continues. The
warning is not permission to schedule a handoff or to pause. A configured hard
runtime/spend limit still applies because it was separately authorized.

The advisor considers only windows known to constrain the active authentication
mode/model. Missing telemetry is unknown; no extrapolated percentage is labelled
as measured. Prefer the most restrictive applicable reported remaining allowance.
Manual hints may be shown as user estimates but cannot trigger automatic control.

| Divergence | Resolution |
| --- | --- |
| Another provider call consumes the remainder first | Preserve files/events without LLM dependency; show actual exhaustion and recovery choices. |
| Usage data becomes stale or fetch is throttled | Mark stale/unknown and back off; do not pause or repeatedly alert. |
| Window resets before action | Supersede the warning after fresh evidence; do not undo a user's pause. |
| Task completes first | Close the quota decision for that task; preserve result review. |
| Several tasks use the same account | Deduplicate the account/window warning, identify affected tasks, and require task-scoped actions. Never imply one task has reserved the remaining allowance. |
| Same warning is delivered twice | Reuse its ID and status message; do not prompt again. |

## 4. Named teammate takeover

The source app holds the original task/pipeline, establishes no managed writer
remains, and publishes a package plus an offer naming the receiver and workspace.
The sender approves the exact frozen export once before publication; any later
file change requires a new capture and preview. There is no requester confirmation after the
receiver accepts. More than one eligible teammate may discuss the request, but
only the named receiver can accept this offer.

The receiving app discovers published offers through Git. Its own bot posts
Accept and run / Decline with the task, checkpoint, requested provider/model,
existing effective permissions, required additions and locally applicable limits.
That bot receives the callback. Do not put the only execution approval button on
the sender's bot and assume Telegram will route it to the receiver.

On acceptance, the receiver checks the current offer and claims it through the
shared protocol. A compatible idle workspace starts with no additional question.
A busy workspace queues it until available and revalidates before starting.
Missing setup produces an actionable preparation state, not a fake running state.
Requested permission additions prompt the executor locally. They do not prompt
the original requester or expand global settings.

Offline nuance: if the receiving app has not discovered the offer, its acceptance
message cannot yet exist. If it goes offline after posting the message, a button
tap is pending Telegram delivery, not acknowledged acceptance. Do not promise a
bot-generated response while its host is asleep. On reconnect, recover from Git
and local records, then reissue any unanswered/expired decision as necessary.

## 5. Mid-task questions and changed instructions

The current executing bot posts questions in the existing task topic. It can
receive the requester's answer while the requester's workstation is offline.

| Subject | Decision owner | Other participants |
| --- | --- | --- |
| Requirements, acceptance criteria, scope | Original requester | May discuss or propose an answer. |
| Local files, tool access, provider or allowance | Current executor | Cannot grant access to someone else's machine/account. |
| Restricted project infrastructure | Locally configured resource owner | Until configured, keep the request unresolved. |
| Unclear responsibility | Requester assigns a permitted decision owner | No LLM inference of authority. |

Answers bind to question revision and current task requirements, not to the
latest chat message. Concurrent confirmed answers resolve once; later submissions
are shown as conflicts. A material instruction change creates a new task revision
and supersedes affected unanswered questions. Adding a comment does not.

Within existing task scope and receiver permissions, an authorized Answer and
resume needs no additional approval. A change to task scope, provider, limits or
required access shows only the relevant delta to the executor. Approval reuse
must not silently authorize a different task. No response to required input keeps
the affected execution waiting; there is no default answer or timeout approval.

## 6. Stopping, cancellation and another takeover

Pause keeps the task resumable. Cancel withdraws the offer or requests cancellation
of execution; it does not roll back files or external effects. Skip is a separate
requester decision with pipeline consequences and never means success.

A user may request cancellation of a pending offer. If acceptance raced with
cancellation, the shared history decides which happened first. Once claimed,
cancellation requires the current executor to acknowledge stopping before anyone
else takes ownership. A machine being unreachable does not permit takeover.

The executor can return partial work, decline further work, or prepare another
handoff. The next offer requires the original requester's authorization of the
next recipient/audience, unless that recipient was explicitly preauthorized for
this task. The next receiver's acceptance is sufficient to start within local
limits. Never share project state with a new party merely because quota ran out.

## 7. Returned work and topic closure

1. Executor stops writing, publishes the result checkpoint and verification
   report, and selects Return work. A partial result is labelled partial.
2. Both humans see the result in Telegram; the source app discovers its durable
   reference even if it missed the message.
3. Requester chooses Review, Request changes, or Review and apply. Review uses
   sanitized summary/diff evidence in Telegram and full inspection in the local UI.
4. Apply requires the original workspace to match its recorded export baseline,
   including uncommitted files. Divergence creates a separate integration checkout
   for review; never overwrite the original tree or silently resolve conflicts.
5. Successful application updates the original task after checking acceptance
   evidence. An already user-paused/stopped pipeline stays so; an otherwise eligible
   pipeline may resume as authorized by Review and apply.
6. Close the topic after accepted application and no unresolved decisions. Keep
   records. If a bot lacks closing permission, record the task complete and report
   the presentation failure separately. Manual topic closure does not complete work.

Request changes creates a revised offer. The executor approves renewed work;
the requester does not separately approve the executor's acceptance. A reopened
task creates a new revision; old buttons and grants remain invalid.

## 8. Lifecycle decision coverage

Every implementation scenario must map to one of these rows and a protocol
transition. Unrecognized conditions produce a named unresolved state, not an
automatic best guess.

| ID | Decision point | Governing rule |
| --- | --- | --- |
| B01 | Integration enabled / disabled / notifications only | Setup grants explicit capabilities; disabling remote controls rejects queued starts. |
| B02 | Pairing, device replacement, member revocation | Verified mapping and current local trust policy; no username-based authority. |
| B03 | Personal, project or restricted audience | Confirm correct audience before publication; topics are not access isolation. |
| B04 | Sensitive or incomplete export | Preview permitted material and omissions; reject missing required state. |
| B05 | Human blocker, quota, throttle, tool/provider failure, cancellation, unknown | Preserve distinct stop reasons; unknown is never classified as quota exhaustion by default. |
| B06 | Advisory warning versus enforced limit | Warn without altering execution; enforce only previously approved hard limits. |
| B07 | Delayed, failed or duplicate notification | Durable outbox, status age and explicit reissue; no false delivery claim. |
| B08 | Answer, defer, ignore or redirect | Required question waits; advisory warning does not stop work. |
| B09 | Requester, executor or resource-owner decision | Check permission for the action, not merely topic membership. |
| B10 | Discussion versus instruction | Explicit question submission/action establishes an instruction. |
| B11 | Duplicate, edited or competing decisions | One accepted versioned transition; edits never rewrite applied decisions. |
| B12 | Expired or superseded action | Reject with current state and fresh choices; do not silently rebind. |
| B13 | Stop acknowledged, hung tool, orphan process | No release until writing stopped; uncertain external effects require inspection. |
| B14 | Task pause, pipeline hold, skip, cancel | Separate scopes; no accidental pipeline advancement. |
| B15 | Checkpoint complete, unstable, missing artifact, LLM unavailable | Artifact validation determines readiness; summary is optional enrichment. |
| B16 | Publication complete, partial or interrupted | Reference becomes actionable only after objects are retrievable. |
| B17 | Named receiver accepts/declines, others volunteer | Named assignment only; no second requester confirmation. |
| B18 | Requested permissions within limits / additions / hard deny | Start, prompt for the delta locally, or reject respectively. |
| B19 | Receiver busy, offline, unprepared or unavailable | Queue/prepare transparently; revalidate before starting. |
| B20 | Old executor active, released or unknown | Ownership transfer needs confirmed release. |
| B21 | Context missing, contradictory, outdated or oversized | Preserve authoritative requirements; declare omissions; do not guess. |
| B22 | Mid-run instruction, provider or access change | Record revision and check scope before applying. |
| B23 | Disconnect, restart, duplicate delivery, late result | Reconcile operation/run identity; unknown starts are not retried automatically. |
| B24 | External action outcome uncertain | Inspect before replay; file checkpoint cannot undo external changes. |
| B25 | Further takeover | Preserve conversation/history; publish latest state with fresh recipient authority. |
| B26 | Full, partial, failed or uncertain result | Evidence and claimed completion remain separate. |
| B27 | Result already applied, compatible or conflicting | Idempotent application or explicit reconciliation. |
| B28 | Close, cancel, supersede or reopen | Chat presentation never changes task outcome by itself. |
| B29 | Revocation, deletion, retention or lost credentials | Stop future authority, reconcile active work and report deletion limits. |

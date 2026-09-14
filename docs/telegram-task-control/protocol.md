# Runtime and cross-workstation protocol

Parent: [Design baseline](README.md). User contract: [User flows](user-flows.md).
This specification describes required future behaviour, not existing guarantees.

## 1. Invariants

| ID | Invariant |
| --- | --- |
| I01 | Every executable action identifies an enrolled actor, exact task scope and receiving workstation. |
| I02 | A shared task has at most one authorized executor. Ownership expiry is not proof of process termination. |
| I03 | Telegram messages are views and inputs; validated task records determine transitions. |
| I04 | A quota warning never changes execution without an explicit action or a separately configured hard limit. |
| I05 | No task files, message, LLM output or imported configuration can grant permissions to itself. |
| I06 | Published files and context are immutable and versioned together. A different package invalidates the previous start approval. |
| I07 | Receiving an answer, saving an answer, starting execution and completing execution are separate facts. |
| I08 | Duplicate delivery cannot authorize a duplicate run. Uncertain external effects cannot be made exactly-once by a local transaction. |
| I09 | Local pipeline ownership remains local; a delegated task holds its source pipeline until reconciled. |
| I10 | Provider, bot, Git and control-signing credentials are never included in task packages, Telegram output or task-tool environments. |
| I11 | Supported existing local permissions do not trigger a second approval. Extra access is an executor-local decision scoped to the task. |
| I12 | No claim of pause, release, completion, application or notification delivery is inferred from an LLM statement alone. |

## 2. Identities and enrollment

Generate random global IDs for project, workstation, person, task, offer, question,
command and result. Existing numeric workspace/prompt IDs are local mappings only.
Copying an app directory to another machine MUST require new workstation enrollment.

Each workstation holds one unique bot token, a control-signing key and a local
allowlist mapping stable Telegram user IDs to enrolled people/project roles.
Usernames and display names are labels only. The owner links Telegram through a
single-use random pairing challenge, expiring after 10 minutes, confirmed in the
authenticated local setup UI with the observed Telegram identity. No pairing via
an arbitrary group message, self-declared ID, or task file.

Team onboarding enrolls project remote, permitted task groups, person IDs, device
IDs and device public keys. The project owner approves this roster; workstations
pin its authority out of band at setup. Roster updates are signed by that owner
and monotonic. A task package cannot replace the roster or supply its own trusted
verification key. Revocation needs a fresh roster before new starts; inability to
fetch current authorization prevents new shared starts, not local Stop.

Git commit author names and Telegram messages forwarded by another person are
not authentication. Anonymous group-admin identities cannot authorize actions.
Validate callback sender, chat, topic, originating bot/message and stored action.
Linking a bot to a group does not grant members filesystem access.

Threat boundary: this is one trusted team, not mutually hostile tenant hosting.
Device signatures detect untrusted writers and rewritten history; they do not
prove a human clicked a button if the receiving workstation itself is compromised.
Repository administrators can delete or rewrite data unless host policy prevents
it. Do not advertise non-repudiation or protection against a malicious host owner.

## 3. Record contracts

Use versioned structured schemas shared by all modules; reject unknown required
fields/versions and invalid transitions. Hash the exact stored immutable bytes;
do not hash a reserialized object whose property ordering may change. Use a
maintained schema validator or existing repository pattern, not regex parsing.

| Record | Required information |
| --- | --- |
| Task | Global task/project/source IDs; requester; local mapping; requirements revision; current epoch; lifecycle; executor; package reference; open questions; result reference. |
| Offer | Offer/task IDs; named receiver person/workstation/workspace; task revision; package hash; requested provider/model/auth mode; access requirements; start deadline; source-release evidence. |
| Package | Schema version; base commit; checkpoint commit; staged/working-tree manifests; file hashes/modes; explicit exclusions; context blob/hash; setup requirements; unresolved side effects; creator/epoch. |
| Question | ID and revision; task requirements revision/epoch; decision type; allowed respondent; evidence; options; required/optional flag; answer and resolution state. |
| Approval | Actor evidence; offer/task/question scope; package hash; provider/model/auth mode; local policy fingerprint; accepted limits; creation/deadline; originating message/action IDs. |
| Command | Unique ID; action; target task/epoch/decision revision/workstation; approval reference; expected state; payload hash; receipt state; resulting run/result ID. |
| Event | Unique ID; event type; parent control commit; task revision/epoch; signer workstation; observed actor/channel; timestamp; payload; prior/new state. |
| Run attempt | Command ID; preallocated run ID; task/epoch; effective permissions; process identity; execution observations; terminal evidence. |
| Result | Result/task/epoch IDs; input package hash; result commit; verification evidence; full/partial classification; external-effect uncertainties; executor release evidence. |

A control commit advancing a status observation does not invalidate a valid
question or acceptance button. Those bind to requirements revision, offer/package,
question revision and epoch; concurrency control separately binds to the current
control-branch head. Material scope changes advance requirements revision.

Approval deadline defaults to 24 hours. It applies to queued start/resume, not
the lifetime of an already running attempt. New provider/model, changed package,
permission increase or changed task scope requires new approval of the difference.
Clock synchronization is required for unattended shared starts; detected clock
skew over five minutes blocks them with a setup error.

## 4. Shared storage and conflict resolution

Configure an explicit private remote for each project. Use a separate app-owned
Git administrative checkout, outside agent access, to manage transfer metadata.
Do not change the developer's branch, index or remote configuration to publish.

Branch layout (under `refs/heads/`; names are reserved by this feature):

```text
aw/team/<project-id>                  signed project enrollment history
aw/control/<task-id>                  ordered task state and event history
aw/checkpoint/<task-id>/<package-id>   published immutable checkpoint
aw/result/<task-id>/<result-id>       published immutable returned version
```

Control branches contain a current `state.json` plus append-only
`events/<event-id>.json`. Each update is a single-parent signed commit whose parent
is the validated current head. Device signatures use Git SSH signing with enrolled
Ed25519 public keys; verify using Git's supported verification facilities, not a
custom signature parser. All events must pass actor/transition validation, even
when the Git signature is valid. Record branches are not merged into product code.

Publication protocol:

1. Fetch and validate current roster and task history against the last trusted
   head. Reject force-rewritten, malformed, unauthorized or unsupported history.
2. Recheck the semantic preconditions of the requested action.
3. Create one update from that head and push only that explicit branch as a
   normal fast-forward. The remote MUST prohibit force updates and deletions of
   control history. Immutable checkpoint/result refs must prohibit replacement.
4. If another writer won, fetch again and re-evaluate the action. Never merge
   conflicting `state.json` files or blindly rebase an already-invalid acceptance.
5. On an uncertain push outcome, fetch and search for the event/command ID before
   retrying. If present, return its existing outcome.

The successful remote branch update is the shared decision point. A local JSON
write, sent Telegram message or callback receipt alone is not a global claim.
Git stores ordering, not physical process exclusion or instantaneous revocation.

Upload immutable package objects first and verify they are retrievable from the
remote. Only then publish OFFERED referencing them. A failure before OFFERED may
leave an unreferenced artifact but cannot create an executable incomplete offer.
Result publication follows the same rule. No multi-branch atomicity is assumed.

## 5. Lifecycle and ownership

Local execution phase, pending decisions and connectivity are separate from the
shared handoff lifecycle. A quota warning can coexist with RUNNING.

| From | Event and authorized actor | To | Required condition |
| --- | --- | --- | --- |
| LOCAL | Request takeover, current authorized owner | PREPARING | Persist source pipeline/workspace hold before interrupting. |
| PREPARING | Checkpoint/release published, source executor | OFFERED | Managed writers stopped; package verified; named recipient authorized. |
| PREPARING | User abandons preparation | LOCAL | No executable offer exists; resume requires explicit user instruction. |
| OFFERED | Accept and run, named receiver | CLAIMED | Current offer/package, valid deadline, roster and successful shared update. |
| OFFERED | Decline / withdraw / expire | WITHDRAWN | Receiver may decline; requester may withdraw; expiry cannot affect an existing claim. |
| CLAIMED | Preparation complete, executor | STARTING | Policy/capability checks, idle workspace reservation, durable start intent. |
| CLAIMED | Busy/offline dependency | CLAIMED | No spawned run; show reason; revalidate on retry. |
| STARTING | Worker observes run started | RUNNING | Command maps to exactly one identified attempt. |
| STARTING | Known no-spawn failure | CLAIMED | Preserve acceptance until expiry; unknown spawn outcome requires reconciliation. |
| RUNNING | Required question or permission decision | STOP_REQUESTED | Record blocker and hold scheduling; request controlled stop. |
| WAITING_INPUT | Save answer, authorized respondent | WAITING_INPUT | Persist answer; explicit Resume or Answer and resume is still required. |
| WAITING_INPUT / PAUSED | Authorized resume | STARTING | Current answer/scope and policy; unresolved questions block start. |
| CLAIMED / STARTING / RUNNING / WAITING_INPUT | Pause / cancel / transfer request | STOP_REQUESTED | Hold scheduling and invalidate pending starts; executor reconciles any spawn race before acknowledging. |
| STOP_REQUESTED | Executor proves writing stopped | WAITING_INPUT or PAUSED | WAITING_INPUT for a required blocker; otherwise PAUSED. Record side-effect uncertainty; do not infer business success. |
| RUNNING | Run ends | PAUSED | Record full/partial/error outcome; publishing a return is a separate action. |
| PAUSED | Return work, executor | RETURNED | Immutable result and release evidence published; incomplete work labelled partial. |
| RETURNED | Review and apply, requester | APPLYING | Expected source baseline/result validated; source claims a new epoch for application before changing original files. |
| APPLYING | Application reconciled successfully | COMPLETED or PAUSED | COMPLETED only if acceptance criteria met; partial application remains resumable. |
| RETURNED | Request changes, requester | OFFERED | New revision/package and fresh receiver acceptance. |
| PAUSED | Authorized further takeover | OFFERED | Fresh source release/package; authorized next recipient; increment epoch. |
| PAUSED / WITHDRAWN | Confirm cancellation / close request | CANCELLED | No active writer or outstanding start; preserve files and history. |
| COMPLETED / CANCELLED | Reopen, requester | LOCAL | New requirements revision; all prior execution approvals stay invalid. |

WITHDRAWN and RETURNED release an offer/executor, not the original pipeline hold.
The source may reacquire ownership only through a validated shared update when no
other executor can still start/run. Failure to acquire leaves the source held.
Unexpected transitions return a stable error code with current state.

Action authority is explicit: requester and current executor may request Pause or
Cancel for this task; only the current executor can acknowledge physical stop or
release. Either may explicitly resume within an existing executor-approved grant,
but requester actions cannot override an executor's local pause, remote-control
disable or denied permission. An executor-imposed hold needs that executor's
release. Requirements answers remain requester-owned; access decisions remain
executor-owned. Neither role may override an unresolved required decision owned
by the other. Project administrators manage enrollment, not implicit task answers.

A stopped WAITING_INPUT task can prepare another handoff only after retaining its
unanswered questions in the package and following the same release/recipient
authorization checks. Save answer does not remove an independent pause/cancel hold.
Cancellation while already PAUSED still invalidates queued commands before closing.
WITHDRAWN may return to LOCAL through explicit requester reacquisition; RETURNED
reacquires through APPLYING. Applying a partial result leaves the source owning a
PAUSED task. Applying a complete result leaves the source owning COMPLETED; any
pipeline continuation remains subject to its independent holds. None of these
operations silently reactivates a previous executor's grant.

The initial source owns epoch 0. Publication of a handoff increments the epoch;
acceptance claims only that offered epoch. Reassignment, withdrawal/reissue and
source reacquisition advance it so old commands cannot become valid again.

There is no automatic ownership reassignment on timeout, stale heartbeat or
network loss. Releasing ownership requires confirmed stop of the run and managed
mutating subprocesses. Local shutdown/crash reconciliation MUST account for orphan
processes. A database row marked INTERRUPTED alone is not sufficient evidence.
If physical stop cannot be established, hold execution and require local operator
inspection. The first release has no force-takeover button that pretends otherwise.

## 6. Local reservations, start intent and reconnect

Reserve a workspace atomically before asynchronous provider checks. Use a durable
local reservation for task/epoch/command with uniqueness on the effective workspace
directory, not just a UI workspace ID. All entry points, including existing UI,
pipeline, retry, recovery and Telegram starts, must respect it and delegation holds.
Human editors are outside this lock; detect changes before capture/application.

Allocate run ID and commit a START_INTENT before spawning. The supervisor records
the run identity and process handle outside task-controlled files. On crash, locate
that exact attempt and determine whether it started or is still alive. If that
cannot be determined, show START_UNKNOWN and require reconciliation rather than
retrying. Delivery is at-least-once; external effects are not promised exactly-once.

Reconnect order: restore local command journal; inspect owned processes; fetch
current roster/control history; reconcile epochs/commands; re-render Telegram
decisions; then consider valid queued starts. Do not release a delegation hold
merely because ordinary startup recovery marked a local run interrupted.

During an outage, an already authorized run may continue within its existing
limits. It cannot acquire new authority, widen permissions or reassign ownership.
Local Stop always works without Git. Its acknowledgement/result is published once
connectivity returns. Remote cancellation/revocation cannot guarantee instant stop
of an unreachable machine; the UI must retain that distinction.

## 7. Telegram delivery and action routing

Each local bot has one long-poll receiver with a durable inbox and outbox. Persist
incoming updates keyed by bot identity and update ID before advancing the offset.
Processing failure does not lose the update. Validate payloads and ignore unknown
chats/users; never log tokens embedded in Bot API URLs.

Button callback data contains a random opaque action reference, not executable
code or trusted authorization fields. Resolve it to a stored action and validate
actor, chat/topic/message, bot, revision, epoch and expiry. Answer the callback
promptly with receipt/rejection; report actual application separately. Do not
interpret a repeated callback as a new command.

Personal commands commit locally. Shared decisions commit through the Git protocol
before being described as accepted/applied. A Telegram callback can be received
while Git is unavailable: show waiting to record, do not start, and retry only
while its semantic preconditions and deadline remain valid.

Each executing bot posts questions so it receives replies directly from the
designated requester. The requester workstation need not forward the answer.
Bots discover assignments/results from Git, not from interpreting each other's
messages. No bot-to-bot visibility setting is required for correctness. Group bot
permissions must support explicit replies and topic management where used; store
only task-related inputs, not the full group conversation.

Telegram undelivered updates expire after at most 24 hours. Local pending questions
and Git records do not. On reconnect after a gap, show unresolved questions again;
do not invent unseen answers from chat history. A bot cannot guarantee an immediate
acceptance receipt while its own workstation is offline.

Send failures use a durable retry queue and server-specified backoff. A timeout
after send may have produced a visible message: duplicate notifications are
possible, but every copy references the same decision and cannot duplicate work.
Edits/deletion of chat messages never revoke or mutate an already applied record.
Revocation/correction is an explicit new versioned action.

### 7a. Personal surface routing (milestone L3, D17)

Navigation callbacks.
Callback data starting `nv_` is a navigation request for a read-only view, not an action reference.
It carries only a view name and short identifiers, fits Telegram's 64-byte limit, and grants nothing.
The adapter routes it before task control; the handler checks the actor, answers the callback and edits the message.
It creates no receipt.
Any button that changes state MUST use an action reference (`tc_`), never `nv_`.

Outbox operations.
Outbox rows carry an operation: `send`, `edit` (targets the sent message of an earlier row) or `create_thread`.
Queued edits to one message coalesce to the latest.
"Message is not modified" is success.
Rows for a subject whose thread is not yet created wait for it; if creation fails they are held, never redirected to another thread.

Threads.
A thread registry maps each subject (a task, or the workstation) to a chat, an optional topic and a status message.
Senders address a subject, not a topic.
A reply to an incoming message goes to that message's topic.

Actor scope across topics.
An actor paired in a private chat is authorized in every topic of that chat, because a private chat has no other members.
An actor enrolled in a group stays bound to its chat and topic.
A reply that answers a card MUST arrive in that card's thread; otherwise it is rejected like a reply to a non-question.

## 8. Permission contract

Let L be permissions explicitly configured by the receiver for this workspace,
including its approved provider settings and explicit prompt restrictions. Let R
be the requested capabilities declared by the incoming task. Prompt text alone
does not implement L. Natural-language permission requirements that cannot be
mapped to enforceable capabilities are UNKNOWN and need local clarification.

| Comparison | Behaviour |
| --- | --- |
| R is contained in L and can be enforced | Start after acceptance without another permission prompt. |
| R exceeds L but the additions are grantable | Show the exact additions in the receiver's local UI. Grant once for this task/revision or decline; do not edit global settings. |
| R violates a local hard denial | Reject that capability; a Telegram approval cannot override it. |
| R or the adapter's enforcement is unknown | Do not treat unknown as allowed. Explain the missing policy/capability and keep preparation waiting. |

Existing permissions are not compared as an ordinal list of strings such as
"plan < edit < full". They include path scopes, tool/command rules, network and
host resources, configured runtime/turn/spend limits, and policy sources. The
comparison must use enforceable capabilities with explicit deny precedence.
An omitted requirement is not permission: check newly requested tools at runtime.

Use the receiver's trusted policy for the fresh checkout. Imported project settings,
hooks, MCP definitions, agent instructions and scripts are task data, not authority
to widen that policy or invoke credential helpers. Recheck policy at start/resume
and tool boundaries. A broader global setting changed after approval does not
silently expand the task grant; a narrower setting is enforced.

Effective task access is the locally approved scope, subject to hard denials and
adapter enforcement. If host access was already granted for that workspace, do
not add an arbitrary second confirmation, but certify its interaction with secret
isolation before offering unattended team execution (G02).

Broker/control files, bot tokens, signing keys, Git credentials and other tasks'
data MUST be outside the task executor's readable/writable boundary. Only the
provider authentication component may access its own LLM credential. Existing
same-user environment inheritance/file modes are not proof of this isolation.
Provider support must demonstrate this boundary; a warning or regex-based shell
filter cannot replace it. No personal account chats, billing or settings API is
exposed through the handoff protocol.

## 9. Checkpoint and context format

Capture only after source scheduling is held and managed writers are stopped.
Observe the tree before and after capture; if files changed, discard the candidate
and retry or ask the local editor to stop. Use separate Git/index operations that
preserve the user's HEAD, staging choices and existing worktree.

Package content:

- Base repository identity/commit, complete approved working-tree snapshot and
  separate staged-state metadata, including new/deleted/renamed/binary files and
  executable bits. Record excluded files and whether required setup can recreate them.
- Objective, acceptance criteria, original/requester instructions, ordered confirmed
  revisions/answers, unresolved questions and latest executor observations.
- Completed/pending work, important files, observed commands/test results, failed
  checks and known uncertain external actions. Distinguish recorded facts from an
  optional model summary and never mark that summary authoritative over decisions.
- Dependency lockfiles, setup requirements and supported environment description.
  Secrets are provisioned separately by the receiver, never requested through chat.
- Stable references and hashes for all required artifacts. If an oversized context
  needs a concise entry point, keep the full approved evidence retrievable and list
  omissions. Do not silently truncate acceptance criteria or decisions.

Generate the factual package without LLM calls. A bounded read-only summary may
enrich it after an explicitly requested pause/handoff if quota permits; its failure
does not invalidate captured evidence. No unconditional summary call at 5%.

Do not execute setup while importing. Verify repository enrollment, path bounds,
hashes and supported file types first. Reject path traversal, escaping symlinks and
special device files. Never execute imported Git hooks, filters, credential helpers
or installer scripts just to inspect a package. First release supports ordinary
Git files and safe internal symlinks; required LFS objects, submodule contents or
external artifacts without implemented verified transfer stop preparation with
UNSUPPORTED_ARTIFACT. Do not pretend their pointer files are the full project.

The receiver creates a fresh isolated checkout linked to a locally approved
workspace policy. No source machine absolute paths, provider sessions, running
services, OS state or entire SQLite database are restored. The new model session
inspects files and evidence before repeating any prior action.

## 10. Result application and recovery

Record the original working-tree and staged baseline at export. Keep it recoverable.
Compare the current original workspace with that complete baseline before applying
the result delta from input checkpoint to result checkpoint. Checking only HEAD
misses uncommitted divergence. Never overwrite unrelated changes or push/merge a
protected product branch automatically.

Application spans files and SQLite, so it is not one atomic transaction:

1. Claim APPLYING in shared history, hold the original workspace and persist
   APPLY_INTENT with result ID, expected
   pre-apply manifest and target manifest; retain a recoverable pre-apply snapshot.
2. Validate and apply the delta through an isolated integration checkout. Before
   updating the original, recheck its baseline; on conflict keep it unchanged and
   offer explicit review. Preserve unrelated index state.
3. Record observed target hashes and APPLY_FILES_DONE; update task acceptance and
   pipeline state once; publish RESULT_APPLIED with the same result/action ID.
4. On restart, compare the tree with pre/target manifests. If target is present,
   finish bookkeeping without applying again. A partial/unknown tree requires
   recovery; do not retry destructive application or advance the pipeline.

A received DONE statement without required evidence is not automatic acceptance.
Review and apply may accept a declared partial result but cannot label it complete.
Telegram close/edit failure must not roll back a successfully recorded application.

# Handover rules and eventualities (TM4)

Written 2026-09-20, before TM4 is built, so the scenario table in `tm4.md` and the H tasks in [team-burndown-dev-brief.md](team-burndown-dev-brief.md) can be written from a settled set of rules.

This builds on the design of record: section 5.4 of [teammate-design.md](teammate-design.md) settles the shape, section 5.5 lists the offline cases, and the boundary cases B01 to B28 in [user-flows.md](user-flows.md) state the principles.
Nothing here overrides those.
Each row below carries one of three marks.

- **Settled** restates the design of record, so it needs nothing from anyone.
- **Ruled** is one of the five decisions jd made on 2026-09-20, recorded in section 8 with the design amendments each required.
- **Proposed** is a rule this document adds that follows from the invariants in section 2 rather than from a product choice, such as never force-pushing, or taking ordering from epochs rather than from two machines' clocks. These need no decision to build, and H01 flags any that jd wants to change while writing `tm4.md`.

Nothing here blocks implementation.

## 1. What is involved

Four parties and six systems, which is why so much of this document is about disagreement between them.

| Party | Acts through |
| --- | --- |
| Requester, the person who needs help | Their phone, their own bot, their own workstation |
| Receiver, the person who takes the work | Their phone, their own bot, their own workstation |
| Requester's workstation | Its SQLite database, its provider login, its Git checkout |
| Receiver's workstation | Its own SQLite database, its own provider login, its own checkout |

| System | Carries | Fails how |
| --- | --- | --- |
| Telegram group | Every human message, the anchor, cards | Drops uncollected taps after about 2.5 minutes offline; holds messages 24 hours |
| Two bots | Each workstation's own delivery | One token revoked stops only that person's bot |
| GitHub remote | The `aw/handover/<item>` branch and `refs/aw/items/<item>/control` | Unreachable, rejected push, force-push, branch deleted |
| Control record | State, epoch, requester, executor, branch, last command id, plus `events/<command id>.json` | Compare-and-swap rejection is the arbiter, never a silent overwrite |
| Two providers | Each side's own quota and settings | Either side can exhaust or fail independently |
| Two databases | Local task, item link, actions, receipts | Either can be lost or restored from an older copy |

## 2. Invariants

These hold in every case below. A rule that would break one of these is wrong, however convenient.

1. **One holder at a time.** Exactly one workstation may be running the item's work at any moment, and the control record decides which. A claim that lost stays lost.
2. **No credential ever moves.** Each workstation uses its own provider login, its own bot token and its own Git credentials. This is what the G01 record in [implementation.md](implementation.md) section 6b depends on.
3. **Every state change is an action with a receipt.** A slash command renders a card; the tap is the action. Duplicate delivery returns the first receipt and changes nothing.
4. **The record is append-only in effect.** Transitions are fast-forward or compare-and-swap; an uncertain push is resolved by fetching and looking for the command id, never by blind retry.
5. **Nothing is applied to the requester's checkout without the requester's own action.** The receiver can return work; only the requester applies it.
6. **The phone never changes an outcome by itself** (B28). Closing or leaving a thread does not complete, cancel or reassign work.
7. **Distinct stop reasons stay distinct** (B05). Quota exhaustion, a tool failure, a human blocker and an unknown stop are never collapsed into each other.
8. **The requester's local task keeps its pipeline hold** until the work is applied or the handover ends, so nothing downstream advances on a half-finished item.

## 2b. The action set the design already fixes

TM4's own migration adds exactly these seven actions ([teammate-design.md:337](teammate-design.md)): `publish_offer`, `accept_offer`, `decline_offer`, `withdraw_offer`, `return_work`, `apply_result`, `request_changes`.
Each is a tap with a receipt, like every other action in this product.

`decline_offer` exists, so declining is a recorded decision rather than silence.

There is deliberately **no release action**, and an earlier draft of this document was wrong to propose adding one.
A receiver who cannot finish uses `return_work` and the result is labelled partial, which [protocol.md](protocol.md) already specifies and which releases the executor.
Seven actions remain the whole set.

## 3. States

**The lifecycle is already specified, in [protocol.md](protocol.md), and that table is authoritative.**
An earlier draft of this document invented a six-state machine of its own before that table had been read, which was wrong twice over: it duplicated an existing specification, and it proposed a `RELEASED` state that protocol.md already covers by other means.

Its states are `LOCAL`, `PREPARING`, `OFFERED`, `CLAIMED`, `STARTING`, `RUNNING`, `WAITING_INPUT`, `PAUSED`, `STOP_REQUESTED`, `RETURNED`, `APPLYING`, `COMPLETED`, `CANCELLED` and `WITHDRAWN`, with the authorized actor and the required condition on every transition.
H02 builds that table, not a summary of it.

Three of its rules matter enough to restate here, because the rest of this document leans on them.

**A receiver who cannot finish returns partial work; there is no separate release.**
`PAUSED` to `RETURNED` is "Return work, executor. Immutable result and release evidence published; **incomplete work labelled partial**."
`RETURNED` then goes to `OFFERED` again by the requester's Request changes, with a new revision and fresh acceptance.
So the capability jd asked for on 2026-09-20 exists already and needs no new state and no eighth action.

**Returning is itself the release.**
"WITHDRAWN and RETURNED release an offer/executor, not the original pipeline hold."
The requester's own pipeline hold survives, which is invariant 8.

**Reacquisition is possible but must be proven, not asserted.**
"The source may reacquire ownership only through a validated shared update when no other executor can still start/run. Failure to acquire leaves the source held."
That is B20, ownership transfer needs confirmed release.
The requester is not powerless: either party may request Pause or Cancel, but "only the current executor can acknowledge physical stop or release", and requester actions cannot override an executor's local pause or denied permission.


## 4. Phase by phase

### 4.1 Trigger and capture

| Eventuality | Handling | Status |
| --- | --- | --- |
| Requester asks for help | A quota warning card in their private chat, or `/handover` on the item's anchor. Existing grants end when handover starts. | Settled, 5.4 step 1 |
| A run still owns the workspace | Capture waits until no run owns it; it never snapshots a moving tree. | Settled, 5.4 step 2 |
| Capture content | A snapshot commit of tracked and untracked non-ignored files through a temporary index, so HEAD, index and worktree are untouched, plus a context file: objective, requirements, answers, open questions, completed and pending work, verification, recommended provider. | Settled, 5.4 step 2 |
| Unsupported content | Symlinks escaping the tree, submodule contents and LFS objects stop the capture with a named reason. | Settled, 5.4 step 2 |
| An untracked file holds a secret | **Warn, do not refuse**, by jd's ruling of 2026-09-20. The preview lists every uncommitted file being published, by path, and flags any that match a known credential shape. Flagged matches take their own confirmation rather than riding along with the ordinary Publish tap, so proceeding is always deliberate. Accepted risk, recorded: a secret pushed to a shared remote stays in that remote's history, so deleting the file afterwards does not unpublish it. The cheap mitigation is to gitignore the file and re-capture. | Ruled |
| Repository is enormous, or capture would push very large objects | Capture reports size before publishing and the requester confirms. No silent multi-hundred-megabyte push. | **Proposed** |
| The item is already closed by `/close` | Refuse the handover. A closed item is an end state that refuses every action (F02), and starting a handover on one would contradict that. | **Proposed** |
| The task completes locally during capture | Abandon the handover and say so. Completion revokes grants and ends the item; there is nothing left to hand over. | **Proposed** |

### 4.2 Publish and offer

| Eventuality | Handling | Status |
| --- | --- | --- |
| Requester reviews before publishing | A preview, then Publish offer. Branch `aw/handover/<item>` is pushed, then the record as `OFFERED` with epoch 1, requested provider and model. | Settled, 5.4 step 3 |
| Remote unreachable at publish | Nothing is offered. Threads, grants and personal control are unaffected because they never touch the remote; the handover retries and says what it is waiting for. | Settled, 5.5 |
| Push rejected, non-fast-forward on the record | Compare-and-swap lost. Re-read the record and re-validate rather than retrying; report the state that actually exists. | Settled, section 8.3 |
| Push outcome uncertain | Fetch and look for this command id before retrying, so an offer is never published twice. | Settled, section 8.3 |
| Receiver's workstation is off when the offer is published | The requester sees "Waiting for <receiver>"; the Accept card appears when it returns. | Settled, 5.5 |
| Who the offer goes to | **Open call.** The offer names no receiver and is posted to the thread; any available teammate may accept and the first accept wins. B17, R-A and RTC-11 were amended on 2026-09-20 to match. | Ruled |
| Nobody accepts, indefinitely | **Corrected 2026-09-21 by jd's ruling.** The offer **does** expire, and expiry moves it from `OFFERED` to `WITHDRAWN`. The default is **24 hours**, matching [protocol.md](protocol.md)'s approval deadline default; the value was the orchestrator's proposal and jd accepted it with the ruling. Expiry cannot affect an existing claim, which protocol.md's transition row already requires. What does not expire is the requester's freedom to re-offer. The ten-minute action expiry still applies to the card and is a separate thing. This row previously said the offer never expires, which contradicted protocol.md's own Offer record, its 24-hour approval default and the `expire` event on the `OFFERED` to `WITHDRAWN` transition; since that table is the authority this track builds from, the derived rule was wrong. Found by H01. | Ruled |

### 4.3 Discover, accept, claim

| Eventuality | Handling | Status |
| --- | --- | --- |
| Discovery | The receiver's workstation reads the shared record on its poll, 5 seconds by default, and posts its own Accept and run card from its own bot. | Settled, 5.4 step 4 |
| Receiver's settings differ | Their workstation compares requested provider, model, Host access and sandbox mode with its own workspace settings before offering to run. Within limits it starts; a delta is prompted locally; a hard deny is rejected (B18). | Settled, 5.4 step 4 and B18 |
| Claim races a withdraw | The claim fails with the current state, and the loser re-validates rather than retrying blindly. A claim that lost stays lost. | Settled, 5.4 step 5 |
| Two receivers accept at once | Real, now that the offer is an open call. The control record's compare-and-swap makes exactly one win, decided there rather than by which tap reached the bot first; the loser is told who holds it and their card goes inert. This is why the record must exist before the offer does, and why H02 precedes H03. | Ruled |
| Receiver declines | `decline_offer` is one of the designed actions, so declining is recorded rather than silent. What follows is not specified: the offer stays `OFFERED` for others under an open call, or returns to the requester as unclaimed under a named one. | Action settled, outcome **Proposed** |
| Receiver busy, offline or unprepared | Queue and prepare transparently, and re-validate settings immediately before starting rather than at claim time (B19). | Settled, B19 |
| Teammate removed from the roster while `OFFERED` | Their group actor is disabled and their grants revoked, so their Accept card goes inert. The offer stays open for a remaining member, or is withdrawn. | **Proposed** |
| Team disabled on either side mid-offer | Team routes answer 403 and cards stop applying. The record is untouched, so the handover resumes when Team is re-enabled. Personal control is unaffected. | **Proposed** |

### 4.4 The receiver runs

| Eventuality | Handling | Status |
| --- | --- | --- |
| Normal run | A worktree of the branch, linked to a local task, started through the normal start path, with progress posted on the anchor. | Settled, 5.4 step 6 |
| Requirement question mid-run | Posted by the receiver's workstation and issued to the requester as actor, so it applies while the requester is offline. Access, provider and allowance questions are asked to the receiver locally. | Settled, 5.4 step 6 |
| Mid-run instruction, provider or access change | Record the revision and check scope before applying (B22). | Settled, B22 |
| Receiver exhausts their own quota | The run stops with quota as its distinct reason (B05), and the receiver returns the work with its commits so far, **labelled partial**, which releases them. The requester then applies what is usable or requests changes, which re-offers it. Never silently re-offered, and never passed to a third party, because further handoff beyond a return is excluded. | Settled, protocol.md |
| **Receiver goes silent indefinitely** | The requester cannot seize a claimed item, because that would run two agents on one item. The requester may ask, and the receiver's workstation may release; a claim only ends by the receiver's action or by the receiver's workstation reporting its run dead. | **Proposed** |
| Receiver's run crashes or the process is orphaned | No release until writing has stopped, and uncertain external effects require inspection (B13). An unknown start is not retried automatically (B23). | Settled, B13 and B23 |
| Requester regains quota and wants it back | They may request Pause or Cancel, but **only the current executor acknowledges physical stop or release**, and a requester action never overrides an executor's local pause or denied permission. Reacquiring ownership needs a validated shared update proving no other executor can still start or run; failing that, the requester stays held. That is B20, ownership transfer needs confirmed release. No seizing, and no reclaim that skips the proof. | Settled, protocol.md |
| **Requester's task is completed locally while claimed** | **Corrected 2026-09-21 by jd's ruling.** Completion records a **cancel request**; the receiver's own workstation stops its run and acknowledges; and the item is **not closed until it has**. The receiver is told plainly that the requester completed it, and the branch is kept until the requester deletes it. This row previously said the receiver's run "is stopped", which is remote Stop across workstations: an exclusion listed in section 5 of this document, and a contradiction of ruling 4 and B20, under which only the current executor acknowledges physical stop or release. Found by H01, which wrote TM-T1-H2 to this corrected form because the uncorrected one needs a mechanism TM4 does not build. | Ruled |
| **Both sides push to the branch** | The receiver owns the branch while `CLAIMED`. The requester does not push to it; if they have, the receiver's push is rejected non-fast-forward, and the receiver reports the divergence rather than force-pushing. Force-push is never used by the product. | **Proposed** |
| **A human force-pushes or deletes the branch on GitHub** | Detected on the next fetch. The handover stops with a named reason and the record is not advanced; recovery is a fresh epoch, because the captured state is gone. | **Proposed** |
| Local database lost or restored from an older copy on either side | The control record on the remote is authoritative for state; the local row is a cache. A workstation whose cache is behind re-reads the record and does not re-apply transitions whose command ids already appear. | **Proposed** |
| Clock skew between workstations | **Ordering** never depends on comparing the two machines' clocks: it comes from the record's epoch and command ids, never from timestamps. **Deadlines do** depend on clocks, which matters more since the 2026-09-21 ruling that offers expire: the ten-minute action expiry, the 24-hour offer and approval defaults. [protocol.md](protocol.md) already requires clock synchronization for unattended shared starts and blocks them on detected skew over five minutes, which is the mitigation. Qualified on 2026-09-21; this row previously said no rule depended on the clocks at all. | **Proposed**, as qualified |

### 4.5 Return, review, apply

| Eventuality | Handling | Status |
| --- | --- | --- |
| Return | Result commits pushed on the same branch, then `RETURNED`. The requester is offered Review, Request changes and Apply. | Settled, 5.4 step 7 |
| Requester offline when work is returned | The completion report is visible at once; Apply waits for the requester's workstation. | Settled, 5.5 and D01 |
| Apply, clean | Fetch and merge in the requester's checkout. A clean fast-forward or merge completes the task, releases the pipeline hold and records `APPLIED`. | Settled, 5.4 step 7 |
| Apply, conflicting | Stops with Git's own conflict state and says so. The phone only offers Apply when the merge is clean. | Settled, 5.4 step 7 and Q9 |
| Apply twice | Idempotent: the first receipt is returned and no second merge happens (B27). | Settled, B27 |
| Request changes | Opens a new epoch and a fresh offer. | Settled, 5.4 step 8 |
| **Requester's checkout moved on while claimed** | The merge is the reconciliation, and a conflict is reported rather than resolved automatically. Apply is offered only when clean, so a moved checkout shows as a conflict, not a silent overwrite. | **Proposed** |
| Result partial, failed or uncertain | Evidence and claimed completion stay separate (B26). A returned branch is not a claim that the work is right; the requester reviews. | Settled, B26 |
| **Apply while the item was closed by `/close`** | Refuse. A closed item accepts no action (F02); reopening is a new item. | **Proposed** |

### 4.6 Cross-cutting, any phase

| Eventuality | Handling | Status |
| --- | --- | --- |
| Tap while the other workstation is offline under about 2.5 minutes | Delivered on return and applied if the action has not expired. | Settled, 5.5 |
| Tap while offline longer | Telegram drops it. On return the workstation renews the open card's buttons with "Buttons renewed after this workstation was offline. Tap again if you already did." | Settled, 5.5 |
| Tap after the 10-minute action expiry | Rejected with the expiry reason. No card is renewed automatically; the person sends the command again. | Settled, 5.5 |
| Group upgraded to a supergroup | Each workstation rewrites its roster copy, group actors, thread rows and anchor pointers to the new chat id before processing anything else, and treats the old id as unusable until it has. | Settled, 5.5, and B8 in [pilot-bug-log.md](pilot-bug-log.md) is the open defect |
| One bot's token revoked | Only that person's bot stops. The other person's control is unaffected. | Settled, 5.5 |
| Repository unreachable | Threads, grants and personal control continue. Handover steps retry and say what they are waiting for. | Settled, 5.5 |
| Two items handed over at once | Each has its own item id, branch and record, and they do not interact. One workstation may hold at most one running item per workspace, so the second waits. | **Proposed** |

## 5. What is deliberately excluded

From the plan's TM4 exclusions, so nobody designs for them: a third team member, further handoff beyond a return to the requester, remote Stop across workstations, package signing and device keys, and any hosted relay.
A receiver who cannot finish returning partial work is a return to the requester, not a further handoff, so it stays inside this boundary.

## 6. What still gates enabling

G01 is recorded, and G02 and G04 were both recorded on 2026-09-20.
**G02 is still the remaining gate**, because only its decision half is done: jd confirmed that the roster is the trust boundary and accepted the two residual limits, one of which is the `.env` bot token being readable by any process running as the same user. Its evidence half is RTC-12's capability matrix, built inside H04, so G02 closes when TM4 finishes rather than before it starts.
G03 applies to the control record and is largely supported by the LG-1 pass of 2026-09-17.
G04 is recorded in [implementation.md](implementation.md) section 6d: control records are kept as the audit trail and handover branches are deleted once applied or cancelled, and jd owns operations with a named fallback.
None of them blocks building TM4 behind the disabled capability.

## 7. Where the new rules land in the slices

| Slice | Gains |
| --- | --- |
| H01 | Writes `tm4.md` from this document, and settles the open items in section 8 first. |
| H02 | TM4's migration, which adds the seven designed actions, and the control record built to [protocol.md](protocol.md)'s lifecycle table: its states, authorized actors, required conditions, epochs, command ids, compare-and-swap, uncertain-push resolution and the local cache rules. Migration number is **29 or later**: F02 took 27, and F07 took 28 on 2026-09-21 for the `telegram_outbox.anchor` column that bounds the anchor writes. |
| H03 | Capture with the secret and size rules, the preview listing untracked files, refusal on a closed or completed item, and publish. |
| H04 | Discovery, settings re-validation, claim races, decline, release, receiver quota exhaustion, and the no-unilateral-reclaim rule. |
| H05 | Return, apply, conflict, idempotent re-apply, request changes and the new epoch. |

## 8. The five rulings, settled 2026-09-20

1. **Open call, not a named receiver.** The offer names nobody and the first accept wins. Amended in B17 ([user-flows.md](user-flows.md)), R-A ([teammate-design.md](teammate-design.md)) and RTC-11 ([engineering-plan.md](engineering-plan.md)), so the design no longer contradicts the build.
2. **The trigger is needing help, not only a quota warning.** R-A amended to name both the quota warning and `/handover` on the anchor. This was never a blocker, because 5.4 step 1 already offered both.
3. **A receiver may hand work back unfinished.** jd ruled yes, and it turned out to need nothing new: [protocol.md](protocol.md) already returns partial work with `return_work`, labels it partial and releases the executor. The `RELEASED` state and `release_work` action this document first proposed were withdrawn on the same day, before any code was written, because they duplicated that.
4. **No seizing a claimed item.** jd ruled the requester cannot take it back. protocol.md is more precise and is what H04 builds: either party may request Pause or Cancel, only the executor acknowledges stop or release, and reacquiring ownership needs a validated shared update proving no executor can still run (B20).
5. **Capture warns about secrets rather than refusing.** jd's decision, against the recommendation in the first draft of this document, which was to refuse. The preview lists every uncommitted file by path and flags credential shapes, and a flagged match takes its own confirmation. The accepted risk is recorded in section 4.1: a secret reaching a shared remote stays in its history.

No decision blocks implementation. The rows still marked **Proposed** are derived rules rather than open questions, as the note at the top explains; H01 raises any jd wants changed.
G02 still gates enabling handover, and that is evidence rather than a decision.

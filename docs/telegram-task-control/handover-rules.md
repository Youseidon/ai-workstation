# Handover rules and eventualities (TM4)

Written 2026-09-20, before TM4 is built, so the scenario table in `tm4.md` and the H tasks in [team-burndown-dev-brief.md](team-burndown-dev-brief.md) can be written from a settled set of rules.

This builds on the design of record: section 5.4 of [teammate-design.md](teammate-design.md) settles the shape, section 5.5 lists the offline cases, and the boundary cases B01 to B28 in [user-flows.md](user-flows.md) state the principles.
Nothing here overrides those.
Each row below is marked **Settled** when it restates the design, or **Proposed** when it is new and needs jd's ruling; the open ones are collected in section 8.

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

## 3. States

The control record's state, with who may move it and what must be true.

| State | Meaning | May move it | Leaves to |
| --- | --- | --- | --- |
| `OFFERED` | Branch pushed, help requested, nobody holds it | Requester withdraws; receiver claims | `CLAIMED`, `WITHDRAWN` |
| `CLAIMED` | One receiver holds it and may run | Receiver returns or releases; requester cannot take it back unilaterally | `RETURNED`, `RELEASED` |
| `RETURNED` | Receiver pushed result commits and stopped | Requester applies or requests changes | `APPLIED`, next epoch `OFFERED` |
| `APPLIED` | Merged into the requester's checkout, task complete | Terminal | terminal |
| `WITHDRAWN` | Offer ended before anyone claimed | Terminal for that epoch | new epoch `OFFERED` |
| `RELEASED` | Receiver gave it back unfinished | Requester re-offers or resumes locally | new epoch `OFFERED`, or local resume |

**Proposed:** `RELEASED` is new. The design has withdraw and return but no way for a receiver to hand back work they could not finish, which is the single most likely real outcome after quota exhaustion on the receiving side.

Every transition writes `events/<command id>.json` and bumps nothing but its own state; **epoch** increases only when the requester re-offers after `RETURNED`, `WITHDRAWN` or `RELEASED`.

## 4. Phase by phase

### 4.1 Trigger and capture

| Eventuality | Handling | Status |
| --- | --- | --- |
| Requester asks for help | A quota warning card in their private chat, or `/handover` on the item's anchor. Existing grants end when handover starts. | Settled, 5.4 step 1 |
| A run still owns the workspace | Capture waits until no run owns it; it never snapshots a moving tree. | Settled, 5.4 step 2 |
| Capture content | A snapshot commit of tracked and untracked non-ignored files through a temporary index, so HEAD, index and worktree are untouched, plus a context file: objective, requirements, answers, open questions, completed and pending work, verification, recommended provider. | Settled, 5.4 step 2 |
| Unsupported content | Symlinks escaping the tree, submodule contents and LFS objects stop the capture with a named reason. | Settled, 5.4 step 2 |
| **An untracked file holds a secret** | Capture publishes untracked non-ignored files to a shared remote, so a local `*.env.local`, key or dump that nobody gitignored would leave the machine. The preview must list every untracked file being published, by path, and capture must refuse known credential shapes outright rather than warn. | **Proposed** |
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
| **Named receiver or open call** | The design says named: B17 is "Named assignment only", and 5.4 step 3 writes a named receiver. jd described an open call to available teammates. With two members these are the same flow; with three they are not. | **Open, section 8** |
| Nobody accepts, indefinitely | The offer does not expire on its own. The requester sees it is still unclaimed and may withdraw. Ten-minute action expiry applies to the card, not to the offer. | **Proposed** |

### 4.3 Discover, accept, claim

| Eventuality | Handling | Status |
| --- | --- | --- |
| Discovery | The receiver's workstation reads the shared record on its poll, 5 seconds by default, and posts its own Accept and run card from its own bot. | Settled, 5.4 step 4 |
| Receiver's settings differ | Their workstation compares requested provider, model, Host access and sandbox mode with its own workspace settings before offering to run. Within limits it starts; a delta is prompted locally; a hard deny is rejected (B18). | Settled, 5.4 step 4 and B18 |
| Claim races a withdraw | The claim fails with the current state, and the loser re-validates rather than retrying blindly. A claim that lost stays lost. | Settled, 5.4 step 5 |
| **Two receivers claim at once** | Only possible under an open call. Compare-and-swap makes exactly one win; the loser is told who holds it and their card goes inert. This is why the control record must exist before the offer does. | **Proposed** |
| Receiver declines | The offer stays `OFFERED` for others, or returns to the requester as unclaimed under a named offer. Declining is recorded, so the requester can see it was seen and refused. | **Proposed** |
| Receiver busy, offline or unprepared | Queue and prepare transparently, and re-validate settings immediately before starting rather than at claim time (B19). | Settled, B19 |
| Teammate removed from the roster while `OFFERED` | Their group actor is disabled and their grants revoked, so their Accept card goes inert. The offer stays open for a remaining member, or is withdrawn. | **Proposed** |
| Team disabled on either side mid-offer | Team routes answer 403 and cards stop applying. The record is untouched, so the handover resumes when Team is re-enabled. Personal control is unaffected. | **Proposed** |

### 4.4 The receiver runs

| Eventuality | Handling | Status |
| --- | --- | --- |
| Normal run | A worktree of the branch, linked to a local task, started through the normal start path, with progress posted on the anchor. | Settled, 5.4 step 6 |
| Requirement question mid-run | Posted by the receiver's workstation and issued to the requester as actor, so it applies while the requester is offline. Access, provider and allowance questions are asked to the receiver locally. | Settled, 5.4 step 6 |
| Mid-run instruction, provider or access change | Record the revision and check scope before applying (B22). | Settled, B22 |
| **Receiver exhausts their own quota** | The run stops with quota as its distinct reason (B05), and the receiver is offered Release, which returns the work unfinished with its commits so far. Not silently re-offered, and never re-offered to a third party, because further handoff beyond a return is excluded. | **Proposed** |
| **Receiver goes silent indefinitely** | The requester cannot seize a claimed item, because that would run two agents on one item. The requester may ask, and the receiver's workstation may release; a claim only ends by the receiver's action or by the receiver's workstation reporting its run dead. | **Proposed** |
| Receiver's run crashes or the process is orphaned | No release until writing has stopped, and uncertain external effects require inspection (B13). An unknown start is not retried automatically (B23). | Settled, B13 and B23 |
| **Requester regains quota and wants it back** | They ask; they do not take. The requester may cancel the item outright, which ends the handover and discards the branch, or wait for a release. There is no unilateral reclaim of a running item. | **Proposed** |
| **Requester's task is completed locally while claimed** | The receiver's work becomes irrelevant. The item ends, the receiver is told plainly that the requester completed it, and their run is stopped. The branch is kept until the requester deletes it. | **Proposed** |
| **Both sides push to the branch** | The receiver owns the branch while `CLAIMED`. The requester does not push to it; if they have, the receiver's push is rejected non-fast-forward, and the receiver reports the divergence rather than force-pushing. Force-push is never used by the product. | **Proposed** |
| **A human force-pushes or deletes the branch on GitHub** | Detected on the next fetch. The handover stops with a named reason and the record is not advanced; recovery is a fresh epoch, because the captured state is gone. | **Proposed** |
| Local database lost or restored from an older copy on either side | The control record on the remote is authoritative for state; the local row is a cache. A workstation whose cache is behind re-reads the record and does not re-apply transitions whose command ids already appear. | **Proposed** |
| Clock skew between workstations | No rule depends on comparing the two machines' clocks. Ordering comes from the record's epoch and command ids, never from timestamps. | **Proposed** |

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
`RELEASED` as proposed above is a return to the requester, not a further handoff, so it stays inside this boundary.

## 6. What still gates enabling

G01 is recorded. **G02 is the remaining gate**: tested isolation for provider, bot, Git and signing credentials, and a known gap is already recorded, the `.env` bot token being readable by any process running as the same user.
G03 applies to the control record and is largely supported by the LG-1 pass of 2026-09-17.
G04 is jd's one-time governance note.
None of them blocks building TM4 behind the disabled capability.

## 7. Where the new rules land in the slices

| Slice | Gains |
| --- | --- |
| H01 | Writes `tm4.md` from this document, and settles the open items in section 8 first. |
| H02 | The control record, its states including `RELEASED`, epochs, command ids, compare-and-swap, uncertain-push resolution and the local cache rules. |
| H03 | Capture with the secret and size rules, the preview listing untracked files, refusal on a closed or completed item, and publish. |
| H04 | Discovery, settings re-validation, claim races, decline, release, receiver quota exhaustion, and the no-unilateral-reclaim rule. |
| H05 | Return, apply, conflict, idempotent re-apply, request changes and the new epoch. |

## 8. Open, and needing jd

1. **Named receiver or open call.** B17 says "Named assignment only", and 5.4 writes a named receiver into the offer; jd described an open call to available teammates. Recommendation: build the open call, since it is what jd wants and the control record makes it safe, and amend B17 and R-A to match rather than leaving the design contradicting the build. It changes nothing while the team has two members.
2. **The trigger wording.** R-A says the trigger is an allowance about to run out; jd described needing help. The design already supports both in practice, because 5.4 step 1 offers `/handover` on the anchor as well as the quota warning. Recommendation: amend R-A to name both.
3. **`RELEASED`.** Confirm that a receiver who cannot finish may hand work back unfinished, and that it returns to the requester rather than to another teammate.
4. **No unilateral reclaim.** Confirm that a requester may not seize a claimed item, and that their escape hatch is cancelling the item rather than taking it back.
5. **Secrets in capture.** Confirm that capture refuses known credential shapes outright rather than warning, and that the preview lists every untracked file by path.

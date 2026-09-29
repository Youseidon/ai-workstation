# M-16 design: align the owner's surfaces with the handover the backend already knows about

> **Implemented design record.** Retained for rationale and acceptance evidence;
> it is not a pending implementation plan.

Written 2026-09-27, **rewritten 2026-09-28** for operator, by the orchestrator.
**Implemented 2026-09-28.** This remains the reviewed design record; later
status corrections are called out rather than rewriting its history.

## 0. Why this was rewritten, and what it replaces

The first version of this design added a member to the status model: a new `AWAITING_RETURN` display status, a catalog entry with its own precedence and rollup semantics, a schema column on `item_link` with a migration to cache the control state, and a change to `operationalState` - a function 26 files read - followed by an audit of 30 hand-keyed comparisons.

**operator asked two questions, one after the other, and both found real over-reach.**

1. *"Is P-B5 really needed?"* - answered by reproducing it, which found **M-17**: the owner could answer, run and complete an item a teammate was actively holding, and those actions **worked**. That was a live work-loss path, and **P-A5 closed it on 2026-09-28** with a narrow server guard.
2. *"Is it a design overhaul or just aligning UI state to backend state?"* - it was an overhaul, and alignment does the job.

**Two facts checked on 2026-09-28 dismantled the reason for the overhaul.**

- `workspaces.operations()` is synchronous, but the `/api/operations` route that calls it is **async**. So the fact can be attached above the sync builder, where awaiting is free.
- The cost the cache existed for is not real. Only an item link carrying a `control_head` needs a read at all, and the read is of the **local** bare control clone - no network. On the live rig: `item_link rows: [{"role":"requester","hasHead":0,"n":1}]`. **Zero reads.** Normally none, occasionally one.

So the cache was designed before the uncached cost was measured. **The migration, the new status, the catalog entry and the `operationalState` change are all dropped.**

## 1. What is actually wrong, after P-A5

P-A5 closed the loss. What remains is that the owner's surfaces **say the wrong thing** about an item a teammate is holding. Observed on 2026-09-28, with the shared record `RUNNING` and the executor another person:

```
row badge:      Needs you
attention flag: true
row buttons:    ["Respond"]
detail buttons: … "Respond and resume", "Retry with existing context", "Mark complete"
```

Three complaints, and that is the whole list:

1. It claims the item **needs the owner**. It does not; it needs the receiver.
2. It sits on the owner's **attention list** for the whole handover.
3. It offers buttons that P-A5 now **refuses** - which makes them dead buttons of exactly the shape M-13 was.

## 2. The design

One fact, carried to the surfaces that need it. No new state, no schema change, nothing in `operationalState`.

### 2.1 One new DTO field

`OperationsPrompt` gains:

```ts
/**
 * The live handover holding this item, or null. M-16: the surfaces used to infer
 * this from prompt status, which they cannot do, so they said "Needs you" about
 * work a teammate was running.
 */
heldByTeammate: { itemId: string; state: string; executor: string | null } | null;
```

Filled in the **`/api/operations` route**, which is already async, by reusing **`liveHandoverHolding`** from `server/src/teamHandoverHold.ts` - the function P-A5 already built, proved and shipped. The route:

1. takes the sync snapshot as today;
2. collects the prompt ids whose requester item link carries a `control_head` - one indexed query;
3. reads the local control record for each - normally none;
4. sets the field, and forces `attention` to `false` on those prompts.

**Nothing else changes server-side.** `operationalState` still returns `BLOCKED`, which is true: the item *is* blocked, and it is also handed over. Those are two facts, and the second now has somewhere to live.

### 2.2 Three small reads of it, in `web/`

- **`WorkItemList`** - the row badge reads `Held by <executor>` instead of `Needs you`, and `RowAction` returns null rather than `Respond`, because `awaitsResponse` is true and the action is refused.
- **`WorkItemDetail`** - the `:407` branch's buttons are disabled with the reason, and a line says who holds it. P-A5's refusal message is the wording to reuse rather than invent.
- **`TeamThreadPanel`/`HandoverControl`** - "Prepare handover" already refuses a second handover server-side; it is disabled here with the reason, for the same "do not offer what will be refused" rule F03 established.

### 2.3 What is deliberately *not* done

- **No new display status.** `STEP_DISPLAY_STATUSES` is a closed set that 26 files read, and adding to it means every switch, label map and catalog lookup must handle it or silently render nothing. That is the widening risk, and it buys nothing the DTO field does not.
- **No schema column and no migration.** Measured, not assumed: see 0.
- **No change to `operationalState`.** The reconcile moving that function is what caused C3.
- **No audit of the 30 hand-keyed comparisons.** They are all still correct: the item really is `BLOCKED`. Nothing about them was the defect.
- **No timeout or escalation** for a receiver who goes quiet. `RETURNED` already raises the review card; a receiver who never returns is a person problem.

## 3. Proof plan

- **Server:** the route sets `heldByTeammate` and clears `attention` while the record is live for the requester's link, and sets null when it is the executor's link, when the state is terminal, and when no handover exists. The `executor` link case is the one that matters - P-A5 found that a guard over every link would break the receiver's own run.
- **Web:** the three surfaces render from the field, from props alone, as F03 and F06 require.
- **T1:** one row, built from `m17-handover-hold.spec.ts`'s crossing, asserting that while a teammate holds the item the owner's row says `Held by` and **offers no Respond**, and that it goes back afterwards. That row is the only thing that proves the surfaces are wired rather than merely present, which is the failure mode this track has hit three times.

## 4. Resolved label question

The other three questions in the first version existed only because of the new status, and are retired with it.

**Answered by operator on 2026-09-28: resolve the label.** The route resolves the
executor through the roster it already holds, so the badge reads `Held by
Requester operator` when `personLabel` exists and falls back to the stable person id only
for older/unnamed roster entries. The implementation is centralized in
`web/components/tasks/handoverHold.ts`.

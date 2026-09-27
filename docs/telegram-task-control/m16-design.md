# M-16 design: task state reads the handover control record

Written 2026-09-27 for jd, by the orchestrator, as P-B5's design half.
**Nothing here is built.** jd's ruling of 2026-09-27 was that this is its own designed task, not an append to a bug fix, and that the design is reviewed before any code.

## 1. What is actually missing

`teamControlRecord.ts` already holds the model: fourteen `CONTROL_STATES`, a transition table that checks from-state, event, authorised actor and condition before writing, stored outside the prompt in a git record that `item_link.control_head` points at, versioned by `epoch`.
`LIVE_HANDOVER_STATES` and `isLiveHandoverState()` already express "this handover is outstanding".

What is missing is the other direction: **`operationalState` knows nothing about any of it.**
So there is no task-level answer to "is this item with someone else right now", and every surface that needs one infers it from prompt status by hand.

Measured rather than asserted, on `main` at `a8d644b`:

| Thing | Count |
| --- | --- |
| Files reading `operationalState` | **26** |
| Hand-keyed `operationalState === …` / `!== …` comparisons | **30**, across **13** files |
| Worst single file | `WorkItemDetail.tsx`, **12** |

That is the common cause behind C3, M-13 and M-15, and all three are now fixed individually. This task is about the cause.

## 2. The constraint that decides the design

`operationalState(prompt, hasHumanQuestion)` is **synchronous and pure**, and it is called **once per prompt** inside the operations-snapshot builder, which loops every workspace, program and suite.

The control record is a **git** record. Reading it is async and does process-level I/O.

So the one thing this design may not do is read the control record inside `operationalState`. A snapshot over N prompts would do N git reads. Three options were considered:

| Option | Verdict |
| --- | --- |
| Read the record in `operationalState` | **No.** Synchronous callers, per-prompt loop, git I/O |
| Make `operationalState` async | **No.** It is read by 26 files and by the snapshot builder's inner loop; this is the change that caused C3, amplified |
| **Mirror the state locally, pass it in as an overlay** | **Yes.** Follows a precedent the code already has |

The precedent matters: `PromptOption.humanResponseHeld` is already a local fact threaded into `operationalState` for exactly this purpose, and `hasHumanQuestion` is already a second parameter computed once per prompt by the caller. This design extends a pattern rather than inventing one.

## 3. The design

### 3.1 A local mirror of the control state

`item_link` already mirrors two fields of the shared record: `control_head` and `epoch`. Add a third, `control_state`, maintained in exactly the same places and by the same writes.

- Nullable `TEXT`, with a `CHECK` over the fourteen `CONTROL_STATES`. **Null means "no handover has ever started on this item"**, which is distinct from `LOCAL`.
- Written wherever `control_head` is written today - `updateItemControlHead` is the single choke point - so it cannot drift independently of the head it belongs to.
- It is a **cache, and the design says so out loud.** The shared record stays authoritative; nothing decides a transition from this column. It answers one question for display, and any write path keeps reading the record.

**This needs a migration**, and P-B2 taught this track a specific lesson about those: migration order in `workspaces.ts` is **source order, not number order**, so it goes after every block that rebuilds `item_link`. That is checked before it is written, not after it fails.

### 3.2 One new display status

`AWAITING_RETURN` joins `STEP_DISPLAY_STATUSES`, with jd's own words as its label: **"Awaiting return handover"**.

It reports that the item is **held by someone else** - the control state is in `LIVE_HANDOVER_STATES` and the executor is not this workstation.

Catalog entry, following `AWAITING_RESPONSE`'s shape:

| Field | Value | Why |
| --- | --- | --- |
| `storable` | `false` | A live overlay, derived every read, never written to `prompt.status` |
| `satisfiesDependency` | `false` | Work that is out with someone else is not a satisfied prerequisite |
| `blocksParent` | `true` | A parent with a handed-over child must say so |
| `needsAttention` | **`false`** | **The one judgement call. See 3.4** |
| `precedence` | `25` | Below `AWAITING_RESPONSE`'s 30: an item waiting on *this* owner outranks one that is out with someone else, because only the first is actionable here |

### 3.3 Precedence inside `operationalState`

Inserted as one branch, immediately **after** `WORKING` and **before** the person-waiting overlay:

```
1. WORKING            - a live local process outranks everything. Unchanged.
2. AWAITING_RETURN    - NEW: the item is out with another workstation.
3. AWAITING_RESPONSE  - a person here has been asked something. Unchanged.
4. …everything else, unchanged.
```

`WORKING` stays first deliberately: if a local process is running, that is what the operator needs to see, and a stale mirror must never hide a live run.

### 3.4 `needsAttention: false`, and why that is the arguable part

An item out with a teammate needs **no attention from this owner** - that is the point of handing it over - so counting it in the attention list would put permanent noise there for the duration of every handover.

The cost: an item whose receiver has gone quiet is invisible on this workstation's attention list. There is no timeout in this design, and **it is not the place for one**: `RETURNED` already raises the review card, and a receiver who never returns is a person problem, not a status problem.

**If jd wants the opposite**, it is one field, and the design would rather be told than guess.

### 3.5 `awaitsResponse` is NOT extended

`awaitsResponse()` is the shared predicate that C3 exists because of, and it now gates the "Respond" affordances P-A3 added to the work-item row.

`AWAITING_RETURN` must **not** join it. A handed-over item offers this owner nothing to respond to; the executor holds it, and only the executor releases it (B20, ruling 4). Adding it would put a live Respond button on an item this workstation may not act on - the exact shape of defect M-13 was.

A separate predicate, `isAwaitingReturn(state)`, is added for the surfaces that want to ask.

## 4. What changes at the call sites

The 30 hand-keyed comparisons are the risk, and the plan is to **enumerate and decide every one before changing any**, recording the decision per site. Three outcomes only:

1. **Unchanged** - the comparison is about something else entirely (`DONE`, `WORKING`, `READY`).
2. **Widened to a predicate** - it is asking "is a person waiting", and should ask `awaitsResponse` rather than name a state. This is C3's own remedy applied to the rest of the file.
3. **Newly handles `AWAITING_RETURN`** - it renders an action that a handed-over item must not offer, or a label it must change.

Category 3 is the one that can regress a surface, and it is where the T1 rows go.

**A new display status is a widening, and widenings are where this breaks.** Any `switch` over the status set, any label map, any catalog lookup that assumes a closed set, will silently render nothing for a state it has never seen. The audit above is how they get found rather than discovered.

## 5. Proof plan

Every claim gets evidence at the tier that can hold it.

- **Shared:** the catalog entry and both predicates, including that `awaitsResponse` is unchanged and that `isAwaitingReturn` is true for exactly `LIVE_HANDOVER_STATES`.
- **Server:** `operationalState` returns `AWAITING_RETURN` when the mirror says a live handover with another executor, and does **not** when the executor is this workstation, when the state is terminal, or when a local process is running. Plus the migration's placement: a boot-twice check, as `teamItems.test.ts` already does for `telegram_thread`.
- **T1:** the rows that matter, because a green server suite has been consistent with a broken user surface three times on this track. At least: an item handed over reads "Awaiting return handover" on the work-item row and the detail page, and **offers no Respond affordance**; and when it returns, the state goes back.
- **Mutation:** the mirror is made stale on purpose, and the row must still not claim a live run is a handover. That is the failure mode a cache introduces, so it gets its own proof.

## 6. What this design deliberately does not do

- **It does not remove `hasHumanQuestion`.** Folding it into the same overlay is tempting and is a second change; C3 came from moving this function.
- **It does not touch the Telegram views' own state text** beyond making the new state renderable. M-15's fix already made the closed case honest.
- **It does not add a timeout, an escalation, or a nudge** for a receiver who goes quiet. See 3.4.
- **It does not unify the 30 comparison sites into one helper.** Category 2 above widens the ones that are asking the wrong question; a full rewrite of every surface's status logic is a different, larger task and would bury this one's evidence.

## 7. Questions for jd, before any code

1. **`needsAttention: false`** for `AWAITING_RETURN` - agreed, or should a handed-over item stay on the attention list? (3.4)
2. **The label.** "Awaiting return handover" is jd's own phrase; the row badge will read **"Awaiting return"** for width. Acceptable?
3. **Scope of the call-site audit.** The plan touches the comparison sites that are *wrong* (category 2) as well as those that *must* change (category 3). Category 2 is the C3 remedy applied more widely and is the more valuable half - but it widens the diff. Take both, or category 3 only?
4. **Precedence 25, below `AWAITING_RESPONSE`.** An item that is both out with a teammate and has an unanswered question here reports `AWAITING_RESPONSE`. Agreed?

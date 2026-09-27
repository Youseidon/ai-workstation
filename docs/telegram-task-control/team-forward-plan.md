# Team track: forward plan and priority register

Written 2026-09-27 for jd, by the orchestrator, at jd's request for one prioritised list with new ids.
This supersedes scattered "what is left" lists.
The result of the work already done is in [team-completion-report.md](team-completion-report.md).
Every gap's detail stays in [team-gap-register.md](team-gap-register.md) and [pilot-bug-log.md](pilot-bug-log.md); this file assigns priority and sequence, and does not restate evidence.

## The id scheme, and why it is prefixed

jd asked for `A1`, `B1`, `C1`, `D1` by criticality.
**Bare letters could not be used**, because every one of them is already taken in this track:
`A1` to `A7` and `D1` to `D9` are the audit check ids that audits 3 and 4 report against,
`B1` to `B19` are the bug log entries, and the design documents carry a second, overlapping B series that runs past B28,
and `C1` to `C5` are the critical gaps the C track closed.
Reusing them would silently break existing cross-references and would repeat the invented-id mistake that already cost this track two retired ids, `TM-T1-8` and `TM-T1-9`.

So the criticality letters are kept exactly as jd assigned them and namespaced with `P-`:

| Band | Meaning |
| --- | --- |
| **P-A** | Critical. Risks the whole track, or is a live defect on a trust boundary |
| **P-B** | High. A feature is incomplete or a surface lies to the user |
| **P-C** | Medium. Real, bounded, and safe to schedule |
| **P-D** | Low. Cosmetic, record-keeping, or rig-only |
| **P-E** | Accepted. No action, recorded so it is not re-litigated |

**Old ids are authoritative for detail and are kept in every row.** This file adds a priority, never replaces a reference.

## The register

| New id | Old id | What it is | Why this band | Next action |
| --- | --- | --- | --- | --- |
| **P-A1** | jd's rulings of 2026-09-22 and **2026-09-27** | **199 commits exist on this machine and nowhere else.** `origin/main` is `4fd0e65` and is **415 behind**. No commit of this track is on any remote | Losing one disk loses the entire F, H, V and C tracks, M-13, and every record | **DECIDED 2026-09-27 by jd: the push happens LAST, after every other item on this list is complete.** So it is scheduled, not open. The exposure is accepted deliberately in the meantime, and it grows with each task until then |
| **P-A0** | **M-13**, the widened half | **Reproduce the saved-answer banner path.** No product change | It was written into the register from a code read and a database reading, with **no test reaching `TODO` with a `HUMAN_RESPONSE` remark**. That is the stage C3 was at when jd refused to accept it | **The session's first action.** Add the row, watch it fail, and settle whether the run consumes the canned remark or the held response |
| **P-A2** | **H-4** | Pilot database isolation is broken on main, **and the guard's own advice `AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1` is what silently breaks it** | A safety mechanism that recommends the thing that defeats it. Worked around in the rig, so the product defect is live and unproven against | Product fix, own task. Reproduce first on a clean checkout |
| **P-A3** | **M-13** | **Review and respond submits a canned answer on the owner's behalf and starts a run on it.** The banner and the response box are gated on mutually exclusive states, and `HumanInputDialog` is mounted with nothing opening it | It writes an answer no human typed, onto a personal-control surface, then spends provider budget acting on it | Fix. The dead `HumanInputDialog` is probably the intended path already built |
| **P-B1** | **M-12** | The requester's review-and-apply half has **no caller in `web/`** at all | The handover feature is half-built. Same shape as C1, C5 and P-A3: present, mounted, wired to nothing | Build the surface, or scope handover down explicitly |
| **P-B2** | **M-15** | A closed item thread answers `/task`, `/status`, `/access` and `/help` as though it were open, and says nothing about being closed | It is why check case 11 is PARTIAL on two separate runs, and a teammate cannot tell a dead thread from a live one | **Decision**: reading closed history is defensible, so this may be one output line rather than a refusal |
| **P-B3** | **M-14** | A workstation that loses its database cannot rejoin a team it is already listed in, and `roster_conflict` covers two distinct causes, one remote and one a stale local mirror | An unrecoverable state reachable by ordinary mishap, behind an error message that names the wrong cause | Fix the rejoin path and split the error |
| **P-A5** | **M-17** | **While a teammate holds a handed-over item, the owner can answer it, start a competing local run and mark it DONE - and it works.** Reproduced 2026-09-28: two workstations ran one item at once, the owner's run completed the task, the receiver was still working, nothing warned anyone | **Critical.** A live work-loss path on a trust boundary. `isLiveHandoverState` has one consumer in the whole product, the `/close` guard | **Narrow guard first**, refusing start, respond, retry and complete while the handover is live, naming the executor. It closes the loss without touching `operationalState`, and does not wait on P-B5 |
| **P-B5** | **M-16** | **Task state does not read the handover control record.** The 14-state control record already exists and is authoritative; `operationalState` knows nothing about it, so every surface infers person-waiting state from prompt status by hand | This is the **common cause** of C3, M-13 and M-15. Fixing the class beats fixing members one at a time | **Design task, properly sized.** jd's ruling of 2026-09-27: raise it separately rather than inside a bug fix, because `operationalState` is read by every surface and the reconcile moving it is what caused C3 |
| **P-B4** | **L-13** | The `e2e` workspace's own self-tests are in **no tier**, and gave one unexplained failure on a first run **twice, to two independent observers**, both of whom lost the test's name | **This is the instrument the entire track's evidence rests on**, and its failure rate is unmeasured. It is banded above its nuisance value for that reason alone | Put it in a tier, capture full output on first runs, and name the failing test |
| **P-C1** | **M-11** | A closed-but-blocked item keeps its pinned anchor forever | Measured rather than argued: the anchor churned hourly for **11 consecutive hours**, and stopped dead at the close, so there is no runaway loop. Only the stale pin remains | **Decision**, already waived once. Either own the unpin or let the trade stand |
| **P-C2** | **L-16** | Turning Team off leaves every Team panel on screen until the page reloads | The API gate holds and the refusal names the real cause, so it cannot act. Cosmetic but on a default-off safety switch | Small fix: broadcast the settings snapshot, not just `providers` |
| **P-C3** | **M-10** | F05's supergroup upgrade has no harness case | A closed high-severity bug with no end-to-end proof | Write the case. Name it for the gap id |
| **P-C4** | **M-6** | Fixtures leak rows into the shared root, and one product lookup depends on row order | A latent flake source and a real ordering dependency in product code | Fix the lookup; isolate the fixtures |
| **P-C5** | **M-7** | `closeAfterHandover` contradicts ruling 7 and nothing owns the reconciliation | An unruled contradiction between code and a written ruling | Rule it, then make the code agree |
| **P-A4** | **F10**, carrying **B3, B4, B10, B19**, plus lifting the handover flag | The rig task, **promoted to critical on 2026-09-27**. B19's shared working tree means the two instances see each other's files without fetching, so **handover's Git exchange is unobservable on this rig** | jd wants every Team feature including handover tested on the rig. Handover **is** a Git exchange - snapshot commit, `aw/handover/<item>`, control record, return, apply by merge - so without B19 you can drive every tap and prove nothing | Give instance B its **own clone**; fix B3, B4 and B10 while in that script; turn `team.handoverEnabled` **on** in both instances. Rig only, no product code |
| **P-C7** | **LT-5** | The two-**machine** two-person handover smoke with Yousef, 10 minutes | **Deferred by jd 2026-09-27** to "a much later time". Once P-A4 lands, the rig proves the Git exchange between two clones on one machine; LT-5 is the only proof across two real machines | Needs a Yousef date. Optional in the brief, and it stays optional |
| **P-D1** | **L-17** | `team-pilot-state.mjs` defaults to the calling checkout's database and prints a plausible, wholly fake team | Rig only, and the documented command block is already corrected | One line: require the path |
| **P-D2** | **L-14** | LT-5 has no row in `human-verification.md`; migration **52** still rebuilds a temp table named `task_control_action_v29` with a "Migration 29" error string | Cosmetic, but the second half will read as a contradiction to the next person who greps migration numbers | Tidy |
| **P-D3** | **L-15** | A stray `0x01` byte in `server/test/telegramViews.test.ts` | Hygiene. Verified **not** a grep-visibility trap, unlike the real NUL that was | Tidy |
| **P-D4** | **L-12** | Web lint: 19 problems, 17 errors, every one in upstream's files. `origin/main` does not pass either | **Waived by jd 2026-09-25.** Nothing in this track can close it | None. Never claim a green lint tier |
| **P-D5** | **M-1** | The two-person runs with Yousef have never happened | Needs a second person, not code | Schedule with a person |
| **P-D6** | **M-3** | Audit check D3 will fail for the wrong reason | Affects future audits, not the product | Fix the check's wording before the next audit |
| **P-D7** | **L-1** to **L-11**, incl. **L-4** | Rig limits, accepted trades, and narrowed notes. L-4's unreproducible width checks are waived | Recorded so nothing is closed by omission | Mostly leave |
| **P-E1** | Section 8 clause 1 | **"Audit 3 and audit 4 pass" can never be met.** Both FAILed. jd's waivers satisfy the brief's *rule*, which offers waiver instead of fixing, but a waiver does not turn a failure into a pass | Permanently unachievable, by construction | **None.** Recorded so no later document reports it as met, and so nobody re-runs the audits expecting a different verdict |

## What is not on this list, and why

- **Re-running T1.** Checked rather than assumed: **every commit since `395fa16` is docs-only**, so T1's **140 of 140** still describes the current product code exactly. It is owed again only when product code changes, which makes it part of P-A2 and P-A3 rather than an item of its own.
- **Re-running the other tiers.** Server **618/618**, shared **91/91**, web **95/95** and four typechecks were all re-run on 2026-09-26 by the orchestrator.
- **V5, and the whole check.** Complete: six PASS, one PARTIAL, one SKIPPED, all rows recorded.
- **C2.** Closed 2026-09-27; V4 and V5 were its last outstanding items.

## jd's decisions, all 2026-09-27

Taken one item at a time, with the evidence for each put to jd before the question.
Recorded here because a plan that omits them reads as though the orchestrator chose them.

| Item | Decision |
| --- | --- |
| **P-A1** push | **Goes last**, after every other item is complete. The exposure of 199 local-only commits is accepted deliberately in the meantime |
| **P-A2** H-4 | **Fix the script *and* the guard's message.** `pilotEnv()` emits `AGENT_CONSOLE_DB`, and the guard stops recommending `AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1` - it recommends pinning instead. Touches one file outside this track, accepted |
| **P-A3** M-13 | **Full fix.** Open the already-mounted `HumanInputDialog` from the banner, remove the canned fallback so `respond()` can never submit an unauthored answer, and add the missing `AWAITING_RESPONSE` branch to the row. The T1 spec currently asserts the defect and passes; **inverting it is its own commit** |
| **P-A4** F10 | **Full rig work, promoted to critical.** Instance B gets its **own clone**, B3, B4 and B10 fixed in the same script, and `team.handoverEnabled` turned **on** in both instances. jd wants every Team feature including handover tested on the rig, and handover is a Git exchange that B19's shared tree makes unobservable |
| **P-B1** M-12 | **Build the web surface** for handover review, apply and request-changes. Against the orchestrator's recommendation, which was to rule it a phone action; jd's call. It is provable end to end because the harness already has `HANDOVER_ON` |
| **P-B2** M-15 | **Answer the view, say it is closed, and write the thread row to `CLOSED` too.** The row change is for record correctness, not routing - nothing reads it for routing - so every reader of `telegram_thread.state` is audited before it changes |
| **P-B5** M-16 | **Its own designed task**, not folded into a bug fix, because `operationalState` is read by every surface and the reconcile moving it is what caused C3 |
| **P-C1** M-11 | **Retire and unpin the anchor on close**, as completion does, **sequenced after P-B2**. jd's P-B2 ruling is what makes this safe: once a closed thread says so, the routability the pin was preserved for buys nothing |
| **P-C5** M-7 | **Ruling 7 wins: a stopped-but-unreturned item is still held.** `isLiveHandoverState` is authoritative. Deciding argument: the asymmetry - picking H04 wrongly loses work, picking ruling 7 wrongly costs one explicit step |
| **P-C7** LT-5 | **Deferred to much later.** Confirmed as genuinely intended but unscheduled, so the B19 clone in P-A4 is built as a **real second clone** and doubles as preparation |
| **P-D5** M-1 | Stays open, intended, unscheduled. Same person-dependency as P-C7 |
| **L-2** | **Yousef confirmed** as G04's named fallback owner. Closes L-2 |
| **M-6** | **Product tiebreak only.** Make `taskControl.ts:321` deterministic; leave the six leaking fixtures as untidiness rather than risk |

Three further decisions, taken **2026-09-27** once Phases 0 to 3 had landed:

| Item | Decision |
| --- | --- |
| **L-13's tier** | **Keep `npm run test:harness` as its own named tier**, out of root `npm test`. The harness self-tests build the web app, so folding them in roughly triples that tier's runtime, and a tier people stop running is worse than a named one they run on purpose. The orchestrator proposed this and jd confirmed it |
| **L-18** | **Fold into P-B5.** The banner's over-broad condition and its two inverted labels stay registered and unfixed for now, because `M-16` is the structural answer to all three instances - each is a surface inferring person-waiting state from prompt status by hand - and fixing them separately would be done twice |
| **Pilot workspace pushes** | **Authorised for handover proofs.** A branch may be pushed to the pilot *workspace* repository where a handover proof needs the exchange to travel through the shared remote, which is the path the product itself uses. This is the disposable pilot workspace repo only; **`ai-workstation` is still untouched until P-A1** |

**One standing constraint was lifted**: `team.handoverEnabled stays false`. It existed for gate **G02**, which closed 2026-09-22, and it had been copied forward for five days. jd asking "why is handover switched off" is what surfaced it.

## Execution plan

Standing model, unchanged: **every task gets its own worker, its own branch and its own worktree, and lands on main by fast-forward.** Commit messages imperative, no co-author line. Nothing is pushed until P-A1.

**Two scheduling constraints bind the whole plan.** The T1 harness is **exclusive** and contends with the live rig, so a T1 run and rig work can never overlap. And T1 is the only proof that merged code reaches a user, so every phase that changes product code ends with a T1 run rather than beginning with one.

### Phase 0 - prove the claim before acting on it

| Order | Task | Why here |
| --- | --- | --- |
| 0 | **P-A0**, reproduce M-13's saved-answer half | jd's decision of 2026-09-27. The orchestrator widened M-13 from a code read and recorded it in the same voice as the half that had earned five green rows. It runs first, changes no product code, and hands P-A3 a red row instead of an argument |

The rig must be **stopped** for it, because the harness contends on ports - but the harness builds its own environments, so the row does not depend on the rig's state.

### Phase 1 - stop the bleeding, then make handover testable

| Order | Task | Why here |
| --- | --- | --- |
| 1 | **P-A3**, M-13's canned answer | The only item that actively does the wrong thing to a user right now. Its reproduction already exists, so the fix has a red row waiting once the assertions are inverted |
| 2 | **P-A2**, H-4 | A documented setup path that silently destroys the isolation the rig depends on, and a guard that recommends the destructive move |
| 3 | **P-A4**, F10 and the handover flag | Rig only, and it unblocks every handover proof in phases 2 and 4. Do it before anything that needs to observe a Git exchange |

Phase 1 ends with a **full T1 run** on main, the rig stopped for its duration.

### Phase 2 - close semantics, in dependency order

| Order | Task | Why here |
| --- | --- | --- |
| 4 | **P-B2**, M-15 | Must precede P-C1. Audit every reader of `telegram_thread.state` first |
| 5 | **P-C1**, M-11 | Safe only once the thread is self-describing |
| 6 | **P-C5**, M-7 | Independent of 4 and 5, but the same area. The `:955` rewrite is its own commit citing jd's ruling |

Phase 2 ends by re-running **V5 case 11 with real grants**, which the last run could not exercise, to convert it from PARTIAL.

### Phase 3 - the small fixes, one commit each

| Order | Task |
| --- | --- |
| 7 | **M-6**'s product tiebreak |
| 8 | **P-C2**, L-16, broadcast the settings snapshot rather than only `providers` |
| 9 | **P-D1**, L-17, require the path in `team-pilot-state.mjs` |
| 10 | **P-D2** and **P-D3**, L-14 and L-15 record and hygiene tidy-ups |
| 11 | **L-2**, record Yousef |

### Phase 4 - the remaining build and the instrument

| Order | Task | Why here |
| --- | --- | --- |
| 12 | **P-B4**, L-13 | Before any further audit. An unmeasured instrument undermines whatever an audit concludes |
| 13 | **P-B1**, M-12's web surface | Needs P-A4's rig to prove, and a C5-style T1 row under `HANDOVER_ON` |
| 14 | **P-B3**, M-14 | Rejoin path and the two-cause `roster_conflict` split |
| 15 | **P-C3**, M-10 | F05's missing harness case |

### Phase 5 - the model change

| Order | Task |
| --- | --- |
| 16 | **P-B5**, M-16: task state reads the handover control record. Designed first, then built. This is the one that stops C3, M-13 and M-15 having successors |

**Added 2026-09-28, ahead of P-B5**, after jd asked whether P-B5 was really needed and the answer was reproduced rather than argued:

| Order | Task | Why here |
| --- | --- | --- |
| 15a | **P-A5**, M-17's narrow guard | It is the live half of M-16 and it does not need M-16's model change. A teammate's work can be destroyed today, in one click, with no warning. Refuse start, respond, retry and complete while `isLiveHandoverState` holds, and name the executor. **Before** P-B5, because P-B5 is the class and this is the loss |

### Phase 6 - the push

| Order | Task |
| --- | --- |
| 17 | **P-A1**: the first push of this work to a remote that has never received any of it. 415 commits and climbing, against an `origin/main` that has 29 of Yousef's pipeline commits main does not have. **Not a formality** - it is its own task with its own plan, and jd is asked before it runs |

### What stays untouched

**P-D4** (L-12, the red lint tier) and **P-E1** (section 8 clause 1) are closed to action by jd's waivers.
**P-D6** (M-3) is fixed only if another audit is scheduled.
**P-D7** (L-1 to L-11) is left alone apart from the parts P-A4 retires.

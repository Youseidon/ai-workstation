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
| **P-A2** | **H-4** | Pilot database isolation is broken on main, **and the guard's own advice `AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1` is what silently breaks it** | A safety mechanism that recommends the thing that defeats it. Worked around in the rig, so the product defect is live and unproven against | Product fix, own task. Reproduce first on a clean checkout |
| **P-A3** | **M-13** | **Review and respond submits a canned answer on the owner's behalf and starts a run on it.** The banner and the response box are gated on mutually exclusive states, and `HumanInputDialog` is mounted with nothing opening it | It writes an answer no human typed, onto a personal-control surface, then spends provider budget acting on it | Fix. The dead `HumanInputDialog` is probably the intended path already built |
| **P-B1** | **M-12** | The requester's review-and-apply half has **no caller in `web/`** at all | The handover feature is half-built. Same shape as C1, C5 and P-A3: present, mounted, wired to nothing | Build the surface, or scope handover down explicitly |
| **P-B2** | **M-15** | A closed item thread answers `/task`, `/status`, `/access` and `/help` as though it were open, and says nothing about being closed | It is why check case 11 is PARTIAL on two separate runs, and a teammate cannot tell a dead thread from a live one | **Decision**: reading closed history is defensible, so this may be one output line rather than a refusal |
| **P-B3** | **M-14** | A workstation that loses its database cannot rejoin a team it is already listed in, and `roster_conflict` covers two distinct causes, one remote and one a stale local mirror | An unrecoverable state reachable by ordinary mishap, behind an error message that names the wrong cause | Fix the rejoin path and split the error |
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

## Suggested sequence

**P-A1 is settled and goes last.** jd ruled on 2026-09-27 that the push happens after every other item is complete.
It stays banded **P-A** rather than being demoted, because the exposure is real and accepted rather than absent, and because the last task on this track is therefore a push to a remote that has never received any of it - which is a substantial piece of work in its own right, not a formality. Recorded risk jd is accepting: the divergence grows with every task, and the reconcile gets harder the longer it waits.

**Then the two product defects, one task each, worker and worktree as usual.** P-A2 then P-A3. Both need reproducing first: P-A2 on a clean checkout, because the rig masks it, and P-A3 already has its reproduction in `m13-personal-surfaces.spec.ts`, so the fix has a red row waiting.

**Then one decision sitting, cheap, to clear the register.** P-B2, P-C1 and P-E1 need rulings rather than work, and P-B2's ruling decides whether it is a one-line fix or a behaviour change.

**Then a single small-fix commit each** for P-C2 and P-D1, which are one-line changes with clear causes, and P-D2 and P-D3 as tidy-ups.

**Then the real remaining build**: P-B1, the requester's missing web surface, which is the last half-built thing in the feature.

**P-B4 before the next audit**, because an unmeasured instrument undermines whatever the audit concludes.

**P-A4 early, because it unblocks testing rather than being tidy-up.** jd's instruction of 2026-09-27 is that every Team feature, handover included, is tested on the rig. That needs instance B's own clone, so F10 is promoted out of the medium band.

**P-C7 (LT-5) stays deferred**, by jd, to a much later time. It needs a person, not code.

**A standing constraint was lifted on 2026-09-27**: `team.handoverEnabled stays false` existed for gate **G02**, which **closed on 2026-09-22** with both tiers at three repeats. The sentence outlived its reason by five days and was copied into every handover in between. It took jd asking "why is handover switched off" to surface it. Recorded, because it is the same shape as the "nothing has ever been pushed" claim corrected the same day: **a closure should name the constraint it releases.**

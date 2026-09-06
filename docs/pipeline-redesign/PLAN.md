# Pipeline redesign — plan for review

Goal: a pipeline that runs a whole suite unattended, and only stops for a question that genuinely
needs a human. Everything below is derived from this repo's code and from the live database
(`~/.local/state/agent-console/console.sqlite`, read from a copy), not from the README.

---

## 1. What the data says actually stops the pipeline

34 S6 pipeline runs, 149 agent runs, 24 audits, 17 handoffs. Ranked by damage:

| # | Cause | Evidence | Share |
|---|---|---|---|
| 1 | **Server restart killed the run.** The console runs under `tsx watch`; every code edit (the pipeline being "fixed" while it runs) restarts the server, kills the agent, marks the pipeline INTERRUPTED, and nothing resumes without a click. | 22 of 34 pipeline runs ended `server_restart`. 8 stations were re-marked "no active run" on boot. | 65 % of pipeline runs |
| 2 | **The tool-call budget killed productive runs.** Sub-steps get 50 % of 250 = **125 tool calls**. Cursor/grok make ~30 calls/min, so a sub-step dies in 3–4 min while still reading files. The 80 % warning is only visible in Progress API responses, so an agent that has not posted a remark yet never sees it. | 23 runs stopped by budget (13 × `tool_calls:125`, 6 × `tool_output_bytes:512K`, 3 × `tool_calls:250`, 2 × input tokens). **S6-09.1 today: 4 identical deaths in 20 min, 4 audits, then parked `retry_exhausted`. Zero code written.** | ~40 % of unfinished stations |
| 3 | **Agents forgetting to report is not the problem.** Exactly **1** run in the whole history "ended done without posting a status". Every other UNREPORTED/forced-BLOCKED was caused by (1), (2), or a process crash. The audit/handoff/UNREPORTED machinery was built for a problem the orchestrator mostly creates itself. | 30 forced BLOCKED + 23 UNREPORTED; 1 genuine | — |
| 4 | **The reviewer loop is expensive and redundant.** A run killed at 125 tool calls is obviously incomplete; sending a read-only Claude to confirm it, then "remediating" with the *same 125 budget*, repeats the death. | 24 audits → **23 INCOMPLETE, 1 COMPLETE**. 27 Claude read-only runs = **30.5 M input tokens**. Reviewer budget raise applied only 5 times. | cost, no progress |
| 5 | **Handoffs spend a run to say "continue".** And the "prepare a handoff first" gate on Resume blocked the operator even when no agent had run. | 17 handoffs, 15 recommended CONTINUE | cost + friction |
| 6 | **Provider outages park the rail.** Codex "model at capacity", Claude weekly limit → FAILED → park/stop. No fallback. | 14 `ERROR` execute runs; `start_failed` stop | avoidable stops |
| 7 | **Rigid rules manufacture BLOCKED.** "decompose refused: a sibling with that name already exists" → agent posted BLOCKED → human needed. "Execution window cannot complete" → BLOCKED. | 3 of 10 agent BLOCKEDs were not human questions | avoidable parks |
| 8 | **Context bloat.** Each run gets ~8 KB workspace description + 7 KB AGENTS.md/CLAUDE.md (already loaded by the CLI — duplicated) + ~5 KB protocol boilerplate + 8 remarks. The S6 playbook that every module item says to follow is **not** in a S6-09.x sub-step's context at all. | measured from `workspace`, `agentContext.ts` | slower, costlier runs |
| 9 | **Too many knobs, added one incident at a time.** 4 on-blocked rules × 5 unfinished statuses × reviewer matrix (4 triggers × 3 verdicts × 6 actions) × handoff trigger × audit mode × DoD enforcement × reconfigure allowlist × two coexisting pipeline systems. Nobody can predict what happens when a run ends. | `pipelineRules.ts`, `statusModel.ts`, `pipelineScheduler.ts` (1 171 lines) | unpredictability |

The 7 genuinely human BLOCKEDs (Stripe credentials, AWS creds, route-ownership decision) are the
only stops that *should* have happened.

---

## 2. Design: "the rail keeps moving"

One rule replaces the interlocking: **a station that ends has three outcomes, and only one of them
stops the rail.**

| The run ended… | Outcome | What the rail does |
|---|---|---|
| Agent posted DONE **and** the server's own verification commands passed | `DONE` | advance |
| Agent posted BLOCKED with a concrete human action | `BLOCKED` | park — the only human stop |
| Anything else: budget reached, crash, restart, verification failed, unreported | `CONTINUE` | re-run the same station on the same tree with the agent's own wrap-up notes, up to N times (default 4); then one read-only review; then park |

Invariants kept from `HANDOFF.md`: never infer an outcome (a continuation is a re-run, not a
verdict), one writer (`writeStatus`), BLOCKED is a question, DB out of reach, tables-not-if-chains.

### P1 — Stable host (fixes #1)
- `npm run serve`: build + run server and web **without watch**; documented as the only way to run a live pipeline. Optional pm2/systemd unit.
- Boot guard: `npm run dev` refuses to start against a DB whose instance lock is held by a `serve` process unless `AGENT_CONSOLE_DB` points elsewhere. Development happens on a DB copy and another port.
- `pipeline.onRestart = autoResume` (new default): on boot, INTERRUPTED runs resume by themselves; the station whose agent died is reset to TODO keeping the tree and re-run as a continuation. No button, no handoff gate.

### P2 — Budgets that guard money and thrash, not productivity (fixes #2, #3)
- Defaults: tool calls **off as a kill** (or ≥ 1 000), wall clock 90 min, input tokens unchanged (that is the money), no-progress detector unchanged. **No sub-step halving** — sub-steps *are* the unit of work.
- **Wrap-up turn instead of a silent kill.** When a budget is reached: interrupt, then **resume the same provider session** (`cursor-agent --resume`, `codex exec resume`, Claude SDK `resume`, grok/copilot session id — all five support it) with a 10-tool-call / 3-min allowance and one instruction: post a PROGRESS remark (verified / remaining as instructions / files touched), then `agent-step done` if everything is verified, else `agent-step continue --remaining "…"`. If the wrap-up itself fails, the stop reason becomes the brief and the continuation happens anyway.
- New `agent-step continue` command → status `TODO` with trigger `continuation` and the brief attached. Replaces handoff briefs (the agent that did the work writes its own, for free, from context it already has).

### P3 — One continuation loop (fixes #4, #5, #9)
- Scheduler: UNREPORTED / FAILED-transient / CONTINUE / verification-failed → `continuation n/N` on the same station. Count lives in the status ledger (survives resets).
- After N: one read-only review (kept as escalation, default provider ≠ source), then park with reason `continuations_exhausted` + the last brief.
- **Removed**: automatic handoff (trigger, requirement, pre-resume gate), `recover` rule and recover provider, reviewer `remediate`/`reconfigure` directives and budget multipliers, `auditOnBlocked` automation (manual audit button stays), reviewer matrix (collapses to *enabled / provider / model*).
- Station rule collapses to: `provider`, `model`, `fallbackProviders[]`, `onDone: continue|stop`, `onUnfinished: continue|skip|wait`, `maxContinuations`.
- `pipelineRules.ts` / `statusModel.ts` transition tables shrink accordingly; the Rules panel renders the smaller tables.

### P4 — DONE means the server verified it (fixes #4 properly)
- A work item may carry a fenced `## Verify` block of shell commands (the importer and `decompose` parse it into DoD `COMMAND` criteria; the item editor shows them). Suite-level defaults for S6: `dotnet build src/backend/MaterioForge.slnx` (0 warnings) and `node harness/replay.mjs --target http://localhost:8080 --only-implemented`.
- Agent posts DONE → server runs the item's COMMAND criteria → all pass → DONE. Any fail → **not** NEEDS_REVIEW-park: a `CONTINUE` with the real command output as the brief. Model-judged PROSE criteria stay optional and default off.
- This is where an independent check has value (a wrong DONE loses work); auditing *unfinished* runs (where it always says INCOMPLETE) does not.

### P5 — Provider resilience (fixes #6)
- Per-station/pipeline ordered `fallbackProviders`. `run_start_failed`, or a fatal error with zero tool calls, or an error text matching capacity/rate-limit/quota/auth → start the next provider immediately; does **not** count as a continuation; the failing provider is marked cooling for 30 min.
- Error classification lives in one table (`transientErrorPatterns`) that a test enumerates.

### P6 — Context diet (fixes #8)
- Workspace description becomes orchestration-only (~1.5 KB). Repository rules live only in AGENTS.md/CLAUDE.md, which the CLIs load themselves — stop sending them twice.
- New suite field **standing instructions** (≤ 2 KB) sent to every item in the suite; S6's carries the compact playbook and points at `harness/module-playbook.json`.
- Protocol + Progress API boilerplate compressed to ~1 KB; `agent-step help` carries the long form.
- History shrinks to: latest continuation brief, latest VERIFICATION remark, human responses, dependency results.

### P7 — Decompose fixes (fixes #7)
- A resumed parent may decompose again (children appended with unique keys, e.g. `S6-08.8`).
- Remove "report BLOCKED if it will not fit the window" wording everywhere; a leaf that runs out simply gets a continuation.

### P8 — Cleanup (from HANDOFF "what is left")
- Delete the legacy suite-play path and `prompt_pipeline_rule`; `agent_run_event` retention (per-run cap + age); `reviewer_config` orphan sweep; drop settings that no longer govern anything (a switch that changes nothing is worse than none — the codebase's own rule).

### P9 — Materio-forge work-item edits
- Every remaining S6 item and sub-step gets a `## Verify` block (namespace replay + build) so DONE is mechanical.
- Replace window/BLOCKED language with continuation semantics ("bank progress with PROGRESS remarks; if stopped you will be resumed on the same tree").
- Applied through the existing `scripts/rewrite-prompts.mjs` + an edits JSON, via the API (never SQL).

---

## 3. Delivery order and the prompts I will write

Each prompt is self-contained (objective, why, exact files, invariants, acceptance checks, what not
to touch), written for a developer AI, stored in `docs/pipeline-redesign/prompts/`.

| Prompt | Delivers | Unblocks |
|---|---|---|
| `00-read-first.md` | Shared preamble every prompt links to: hazards (migration `PRAGMA foreign_keys`, live DB, dev-server = deployment), verification commands, style, invariants. | all |
| `01-stable-host.md` | P1 | the #1 killer |
| `02-budget-and-wrapup.md` | P2 | the #2 killer |
| `03-continuation-loop.md` | P3 | removes the audit/handoff/remediate chain |
| `04-server-verified-done.md` | P4 | trustworthy DONE |
| `05-provider-fallback.md` | P5 | outages |
| `06-agent-context.md` | P6 | cost, playbook visibility |
| `07-decompose.md` | P7 | manufactured BLOCKEDs |
| `08-cleanup.md` | P8 | DB size, dead code |
| `09-materio-forge-items.md` | P9 | the S6 prompts themselves |

01–03 are the ones that end the brick wall; 04–05 make it trustworthy; 06–09 make it cheap and
clean. Dependencies: 03 needs 02; 04, 05 and 08 need 03; 07 and 09 need 06; 09 also needs 04.
01 and 06 are independent and can be run first or in parallel.

## 4. Decisions (taken 2026-09-06)

1. **N = 4** continuations per station, counted since the last operator action. After that, one
   read-only review, then park on `continuations_exhausted`.
2. **Budgets**: 90 min wall clock per run, 1 000 tool calls as a safety ceiling (not a working
   limit — every budget stop gets a wrap-up turn), 8 MB tool output, no sub-step halving. Input
   tokens and the no-progress detector unchanged: those are the money and the thrash guards.
3. **Reviewer matrix, remediation, reconfigure and automatic handoff are removed**, not disabled.
   The manual audit button and the single post-N review stay.
4. **The in-flight `pipeline-status-model` diff was committed** as `b2f2e33` for history; nothing
   builds on it.
5. No interim settings note in the prompts.

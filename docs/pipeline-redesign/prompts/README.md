# Pipeline redesign — prompts for the developer AI

Each file is one self-contained session for a developer AI working in this repository. Hand over
`00-read-first.md` together with exactly one numbered prompt per session. The plan and the diagnosis
behind them is `../PLAN.md`.

| # | Prompt | What it ends | Needs |
|---|---|---|---|
| 00 | `00-read-first.md` | — (preamble: hazards, invariants, how to work and report) | — |
| 01 | `01-stable-host.md` | Pipelines killed by the dev server; nothing resuming after a restart | — |
| 02 | `02-budget-and-wrapup.md` | Sub-steps killed at 125 tool calls with nothing written down | — |
| 03 | `03-continuation-loop.md` | The audit → remediate → handoff → retry → recover chain | 02 |
| 04 | `04-server-verified-done.md` | DONE on an agent's word alone | 03 |
| 05 | `05-provider-fallback.md` | Parking on "model at capacity" / rate limits | 03 |
| 06 | `06-agent-context.md` | 40 KB contexts that omit the parent's brief and the playbook | — |
| 07 | `07-decompose.md` | "sibling already exists" and "report BLOCKED" manufactured parks | 06 |
| 08 | `08-cleanup.md` | Two pipeline systems, 160 k events, dead tables and settings | 03, 05 |
| 09 | `09-materio-forge-items.md` | S6 items whose verification is prose | 04, 06 |

Suggested order: 01, 02, 03 (the brick wall ends here), then 06, 04, 05, 07, 09, 08.

Every prompt ends with acceptance criteria, the verification to run, and what the commit message
must state. The developer AI is expected to run `npm run typecheck && npm test && npm run build` and
the named live scenario on a disposable database before reporting — and to say what it did not
verify.

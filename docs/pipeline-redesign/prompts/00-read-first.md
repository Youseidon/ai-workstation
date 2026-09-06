# 00 — Read this before any prompt in this folder

You are a developer AI working on `~/projects/ai-orchestration`: a self-hosted console that drives
local CLI coding agents (Claude Code, Codex, Cursor, Grok, Copilot) through a pipeline of work
items. Node/TypeScript monorepo — `shared/` (types and rule tables), `server/` (HTTP + WebSocket,
SQLite via `better-sqlite3`, hand-rolled versioned migrations in `server/src/workspaces.ts`),
`web/` (Next.js). The owner runs it against a real project (`~/projects/materio-forge`) whose
progress lives in `~/.local/state/agent-console/console.sqlite` (~200 MB, 160 k transcript events).

The prompts `01`–`09` in this folder each deliver one part of the redesign described in
`../PLAN.md`. Read `PLAN.md` §1–§2 once; it is the "why". Then do exactly one prompt per session.

---

## The three hazards

### 1. The dev server is a deployment
`npm run dev` runs the server under `tsx watch`. **Saving a file restarts the server and kills every
agent run in flight, and applies any new migration to the live database immediately.** 22 of the
owner's 34 pipeline runs died this way. Before you start:

```bash
# Never develop against the live database or the live port.
cp ~/.local/state/agent-console/console.sqlite /tmp/dev.sqlite
AGENT_CONSOLE_DB=/tmp/dev.sqlite PORT=4100 NEXT_PUBLIC_AGENT_SERVER_URL=http://127.0.0.1:4100 npm run dev
```
(After prompt 01 lands, `npm run dev:sandbox` does this for you.) If a live pipeline is running on
port 4000, do not touch it. Tell the owner when a change needs the live server restarted.

### 2. `PRAGMA foreign_keys` is a no-op inside a transaction
Migration 22 once deleted 135 025 transcript events this way. If a migration rebuilds a table, the
pragma goes **outside** `db.transaction(...)` in a `try/finally`; `server/src/migrationSafety.test.ts`
enforces this — do not weaken it. Prefer `ALTER TABLE … ADD COLUMN` (safe, no rebuild) over
rebuilds. Prove every migration on a copy first: row counts per table + `PRAGMA integrity_check` +
`PRAGMA foreign_key_check`, before and after, in a standalone script — not by saving `workspaces.ts`.

### 3. SQL `CHECK` constraints duplicate TS unions by hand
`agent_run.role` is `CHECK(role IN ('execute','consult','handoff','review'))`; `pipeline_step`'s
actions and `pipeline_run.state` are checked the same way. Widening a TS union without a migration
fails at runtime and `tsc` will not tell you. `prompt.status`, `prompt_remark.kind` and
`prompt_status_event.trigger_id` are **not** constrained — new statuses/kinds/triggers need only the
TS tables.

---

## Invariants that survive the redesign

1. **Never infer an outcome.** A run that ends without posting is `UNREPORTED` — never `DONE`,
   `FAILED` or `BLOCKED`. The redesign *re-runs* such a station (a continuation); it never decides
   for it. `DONE` requires an agent post **and** the server's own verification.
2. **One writer.** Every `prompt.status` change goes through `writeStatus` in `workspaces.ts`. Do
   not add a direct `UPDATE prompt SET status`.
3. **`BLOCKED` is a question, not unfinished work.** Only an agent posts it, only with a concrete
   human action. It is the one thing that parks the rail for a human. Never continue past it
   automatically.
4. **The scheduler is re-entrant.** `applyExecuteEnded` must stay idempotent under replay (see the
   `live.currentRunId !== runId` guard and the ordering comments in `applyOnBlocked`).
5. **Rules are data, not `if` chains.** Ordered tables in `shared/src/pipelineRules.ts` and
   `shared/src/statusModel.ts`, enumerable by tests, rendered by the Rules panel. When you *remove*
   behaviour, remove its rows and its settings; a switch that changes nothing is worse than none.
6. **`shared/src/index.ts` re-exports by name, never `export *`** (ESM/tsx linking quirk; comment
   in the file explains).
7. **The database stays out of every workspace directory** (`assertDatabaseOutOfReach`).
8. **Every status change records its cause**: `trigger_id`, `rule_id`, `evidence_json` on
   `prompt_status_event`. New behaviour gets new trigger/rule ids, and the "Why this status" panel
   must be able to render them.

---

## How to work

- **Locate before you edit.** File names below are current as of commit `b2f2e33`; line numbers
  drift. Use `rg` to find the symbol named in the prompt.
- **Match the surrounding style.** Server code is dense and single-line in places (`workspaces.ts`
  especially); do not reformat. Comments explain *why* and often name the regression that motivated
  the code — write yours the same way.
- **Tests assert claims, not implementation.** Read `server/src/statusLedger.test.ts` and
  `shared/src/statusModel.test.ts` for the house style. Every prompt lists the claims to lock down.
- **Removing code is part of the job.** When a prompt says remove, remove: the code path, its
  settings field in `server/src/settings.ts`, its rows in the rule tables, its UI, its tests. Leave
  database *tables* alone unless the prompt says otherwise (prompt 08 drops them safely).
- **Verification before you report:**
  ```bash
  npm run typecheck && npm test && npm run build
  ```
  Then exercise the real thing on a disposable database:
  ```bash
  PORT=4137 AGENT_CONSOLE_DB=/tmp/verify.sqlite node --import tsx server/src/index.ts
  ```
  and drive it with `curl`. Each prompt names the scenarios to run.
- **Report honestly.** In the commit message and your final message: what changed, what it fixes,
  what you verified, and anything you did *not* verify. The owner reads commit messages.
- **Do not** touch `~/projects/materio-forge` except where prompt 09 says to, and then only through
  the console's API.

## Vocabulary

- **Station**: a top-level work item on a pipeline. **Sub-step**: a child created by `decompose`.
- **Rail**: the scheduler's automatic advance from one station to the next.
- **Park**: the rail stops in `WAITING_HUMAN` with a `wait_reason`.
- **Continuation** (new in this redesign): re-running the same station on the same working tree,
  carrying the previous run's own wrap-up notes as the brief. Counted per work item in the ledger.
- **Wrap-up turn** (new): a short follow-up turn on the *same provider session* after a budget
  stop, whose only job is to record what is verified and what remains.
- **Agent door**: `POST /api/agent/runs/:runId/{remarks,status,decompose,…}` and the `agent-step`
  launcher (`server/bin/agent-step.mjs`, per-run shim in `server/src/agentShim.ts`).

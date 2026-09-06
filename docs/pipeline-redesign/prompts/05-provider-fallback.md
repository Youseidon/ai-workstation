# 05 — Provider fallback for outages, capacity and rate limits

Read `00-read-first.md` first. Requires prompt 03 (the continuation loop is what this sits in front
of). Independent of 04.

## Objective

A provider that cannot start, is at capacity, has hit its quota, or fails before doing any work is
swapped for the next one on the station's fallback list — immediately, without spending a
continuation and without parking.

## Why

Recorded stops that were nothing to do with the work: Codex "Selected model is at capacity. Please
try a different model." (fatal, before the first tool call), Claude "process exited with code 1"
after a weekly-limit message, a `start_failed` pipeline stop, and 14 execute runs ending `ERROR`.
Under the old rules each of these became `FAILED` → a park or a `retry_exhausted` stop, and the
owner had to come back, notice, pick another provider by hand and Play. The console already knows
five providers; it should use them.

## Scope

### 1. Classify how a run failed

`shared/src/providerFailure.ts` (pure, tested):

```ts
export type FailureClass = "transient_provider" | "crash" | "unknown";
export const TRANSIENT_PATTERNS: readonly { id: string; pattern: RegExp; because: string }[] = [
  { id: "capacity",   pattern: /at capacity|overloaded|try (a different|another) model/i, because: "The provider reported it is at capacity." },
  { id: "rate_limit", pattern: /rate limit|too many requests|\b429\b/i,                      because: "The provider rate-limited the run." },
  { id: "quota",      pattern: /quota|usage limit|weekly limit|credit|insufficient.*balance/i, because: "The account is out of allowance for now." },
  { id: "auth",       pattern: /unauthori[sz]ed|\b401\b|not logged in|login required|invalid.*api key/i, because: "The provider rejected the credentials." },
  { id: "network",    pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i, because: "The provider could not be reached." },
];
export function classifyFailure(args: { errorText: string; toolCalls: number; startFailed: boolean }): { class: FailureClass; id: string | null; because: string };
```

Rules: `startFailed` → `transient_provider/start_failed`; any pattern match → `transient_provider`;
otherwise if `toolCalls === 0` → `transient_provider/died_before_work` (an agent that never got to
work has told you nothing about the work); otherwise `crash`. A table, so the Rules panel can list
it and a test can enumerate it.

### 2. The station's fallback list

- `PromptPipelineRule` gains `fallbackProviders: ProviderId[]` (ordered, may be empty).
- Migration N+1: `ALTER TABLE pipeline_step ADD COLUMN fallback_providers TEXT NOT NULL DEFAULT '[]'`
  (JSON array; same on `prompt_pipeline_rule` until prompt 08 removes it). Validate on write: known
  provider ids, no duplicates, not equal to the station's own provider.
- Suite default: `suite.default_fallback_providers` via the existing `suitePipelineDefaults` /
  `updateSuitePipelineDefaults` (ALTER TABLE ADD COLUMN on `suite`). Resolution order mirrors
  `resolveExecuteTarget`: station → play request → suite default → **house default**
  `pipeline.fallbackProviders` (new settings field, comma-separated, default `codex,claude,cursor`).
- Web: the station rule editor and the suite defaults form get an ordered multi-select of the other
  providers; `ProviderChip` styling as elsewhere.

### 3. Cooling

`server/src/providerHealth.ts` (in-memory, no table): `markCooling(provider, id, minutes)`,
`isCooling(provider)`, `cooling(): { provider, until, because }[]`. Default cooling: `capacity` and
`rate_limit` 10 min; `quota` and `auth` 60 min; `network` 2 min; `start_failed`/`died_before_work`
5 min. Expose in `GET /api/providers` as `cooling: { until, because } | null` per provider so the
header pill shows it (small badge; tooltip carries `because`).

### 4. Where it plugs in

In `pipelineScheduler.applyExecuteEnded`, **before** the decision table's `FAILED → continuation`
row:

1. `classifyFailure` on the run's recorded error text (`agent_run_event` last `error` event, or the
   `start_failed` exception message) and `tool_calls`.
2. If `transient_provider`: `markCooling`; pick the first provider in the resolved fallback list that
   is `available` and not cooling and not the one that just failed. If found: `writeStatus TODO`
   with new trigger `provider_fallback` ("The agent could not run, so the station was started with
   another provider."), `rule_id: "provider-fallback"`, `evidence_json: { from, to, failure: id,
   because }`; then `startCurrentStation` with `{ provider: to, model: null }` (the fallback's own
   default model — the failing model is usually the problem). This does **not** consume a
   continuation.
3. If nothing is available: fall through to the continuation row (the same provider may recover by
   the time it re-runs) with the failure class in the cause text. If the *continuation* also cannot
   start, park with `wait_reason = "no_provider_available"` and the cooling table in the evidence.
4. `startCurrentStation`'s `start_failed` path (currently `terminate(STOPPED, "start_failed")`) goes
   through the same fallback before it ever terminates.

Also apply the fallback to the **wrap-up** run (prompt 02) and the post-N **reviewer**: if their
provider is cooling, pick another; if none, skip the wrap-up (continuation without notes) / skip the
review (park directly).

### 5. Rules surface

- `STATUS_TRIGGERS` += `provider_fallback`; `STEP_TRANSITIONS` row `provider-fallback` above
  `run-crashed`/`run-start-failed` (condition "The agent process could not run for a reason that
  says nothing about the work", `to: TODO`, `next: "rule"`).
- `STOP_REASON` += `no_provider_available`; a `TRANSITIONS` row for it (primary `resume`).
- Rules panel: a small table of `TRANSIENT_PATTERNS` (id, because) and the cooling durations.

## Out of scope

Retrying inside a provider (their CLIs do that), changing budgets, anything about DONE.

## Acceptance criteria

1. `classifyFailure` test enumerates every pattern with a real error string taken from the live
   history (the two quoted above must be in it) plus a genuine crash after 40 tool calls →
   `crash`.
2. A station whose provider fails at start with a capacity message is running on the next fallback
   provider within one scheduler tick, with a `provider_fallback` ledger row and **no**
   `continuation` row; the failed provider shows as cooling in `/api/providers`.
3. A fallback provider that is itself cooling is skipped; with all cooling, the station takes a
   normal continuation; if that cannot start either, the pipeline parks `no_provider_available`.
4. Fallback lists resolve station → play → suite → house default, and the editor validates them.
5. Migration proven on a copy (row counts unchanged; defaults `'[]'`).
6. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

Disposable database; make a fake adapter for provider A that throws "Selected model is at capacity"
on start and a real Codex as fallback; Play; paste the ledger rows and the `/api/providers` cooling
entry. Then set every fallback to the failing fake and confirm the `no_provider_available` park.

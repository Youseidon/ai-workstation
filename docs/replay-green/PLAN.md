# Native remainder — make `harness/replay.mjs` print ALL GREEN

Status: plan only. Do not implement from this file.

- Ordered stations: [`INDEX.md`](INDEX.md)
- Paste-ready prompts: [`prompts/`](prompts/)
- Console load: [`LOAD.md`](LOAD.md)

Workspace: `/home/youseidon/projects/materio-forge`, branch `backend-infra`.
Orchestration: `~/projects/ai-orchestration`. Program `backend-transition`.
S8-01 (prompt id 63, station UNREPORTED) stays parked. These are **new** stations.

## Verdict this plan is answering

The S8-01 strangler job is done in the working tree. The red gate is hidden S6
remainder. Catalog `x-implementation=dotnet` (882/882) only means Kestrel maps
the route. 343 of those handlers still HTTP to `Platform:MockBaseUrl`
(`http://127.0.0.1:5050`). YARP used to hide the 30 never-mapped routes. With
YARP gone they 404.

Deleting the 14 `MockBaseUrl` call sites without native handlers does not green
the suite. It turns 1,290 `500-internal` comparisons into a different wrong body.

## Numbers (not stale)

Re-read 2026-09-11 from `harness/replay-report/summary.json`. Same snapshot as
the S8-01 full mock-offline replay that ended 2026-09-11T06:09Z
(`--reset-between-passes`, inScopeOnly + catalogTrajectory).

| | |
|---|---|
| Compared | 3406 |
| Passed | 1945 |
| Failed | **1461** |
| missingGolden / skipped / outOfScope | 0 / 0 / 1303 |
| Catalog endpoints | 882 |

| Kind | Comparisons | Unique routes |
|---|---:|---:|
| `500-internal` | 1290 | 343 |
| `other-to-404` | 104 | 30 |
| `body-only` | 58 | 21 |
| `mock-501-to-404` | 9 | 2 |

Do not re-run the full suite to refresh these. Query the sharded tree:

```
jq '.counts.byKind' harness/replay-report/summary.json
jq '.failures[] | select(.namespace=="<ns>")' harness/replay-report/catalog.json
```

A later `node harness/replay.mjs` overwrites `harness/replay-report.json` with a
full blob. The tree under `harness/replay-report/` is the S8-01 snapshot. Prefer
`--namespace` / `--route`. `port.mjs verify` reads `results.failed` and
`failures[0:10]` from the index file — do not empty `failures` by hand.

## What already happened (do not redo)

Banked by S8-01 (keep these diffs):

- YARP catch-all, package, timeout / circuit-breaker / transformer / fallthrough / proxy logging: removed.
- Unmatched route → `ApiErrorWriter` 404 (`Not found` / `NotFound` / `correlation_id`). `GET /no/such/route` is 404, never 502.
- `mock` service removed from `docker-compose.yml`. Infra profile is postgres / dynamodb / localstack / dynamodb-init.
- `node harness/replay.mjs --target mock` exits 2 with a removed-target message.
- `infra/30-compute.yaml`: task definition 1 container (api). Mock ECR / log / IAM / env removed. Deploy workflow no longer builds or passes a mock digest.
- `dotnet build` was green after those removals.

Not done, and not this plan's first wave: deploy, deployed replay, rollback.
Codex refused to deploy a red revision. Keep that. That remainder is `S8-01b`,
after local ALL GREEN.

Working tree is dirty with S8-01 + leftover S7 frontend files. New stations must
not revert the strangler removals and must not tidy unrelated S7 diffs.

## Key decisions

1. **New S6-16…S6-49 stations, not a continuation of S8-01.** S8-01's strangler
   job is complete in the tree. Native ports are S6 remainder that burndown
   marked complete. S8-01 stays parked (UNREPORTED) until local green, then only
   deploy/rollback remains (`S8-01b`). S8-02 (delete `prototype/backend/`) stays
   after that.
2. **Do not write a "remove 14 call sites" prompt as the vehicle.** That is
   `S6-49`, after ALL GREEN. The 14 clients back 343 mapped-but-proxied routes
   plus 30 never-mapped routes.
3. **Namespace gates, then one full suite.** Each port prompt proves
   `--namespace` (and `--route` while iterating). Full
   `--reset-between-passes` is `S6-48` only.
4. **Two admin 501 goldens recapture from live `:8080` 404** (`S6-47`). Do not
   implement a fake `501 MockBackendError`. `harness/rebaseline.mjs` captures
   from the mock container and cannot recapture these. Use
   `replay.mjs --dump-actuals` against `:8080`. Recapture nothing else unless
   A/B `:5050` (diagnostic only) vs `:8080` proves prototype drift.
5. **Body-only last among a module's routes**, except `agents` / `pipelines` /
   `voice` which are already mostly native (`S6-45`).
6. **Prototype remains the behavioural oracle while porting.** A/B `:5050` vs
   `:8080` is allowed as a diagnostic with the mock up. The gate that closes a
   prompt is mock-down replay against `:8080`.
7. **Two patterns, diagnosed per route, never assumed from the file name.**
   BIM/Takeoff `ApplyAsync` after `ProxyAsync` is still pure proxy
   (`BimService` is a one-liner around the bridge). Cart/Coupons/Qa/Catalogue
   writes are true dual-write (native body, mock side-effect). Checkout and
   `DisputeService` are mock-first, not dual-write.

## Preconditions (every port prompt)

```
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5050/health  # 000 / refused
```

If `:8080` is down:

```
npm run dev:infra          # postgres, dynamodb, localstack, dynamodb-init. No mock.
npm run dev:migrate        # only if the volume is cold
npm run dev:api            # host API, hot. Never docker compose up --build api to check work.
```

Live-target env (or every authenticated comparison 401s):

```
export MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z
export MF_DETERMINISTIC=1
export MF_DETERMINISTIC_SEED=2654435769
export MF_JWT_SECRET=materioforge-deterministic-harness-secret
```

`harness/restart-host-api.sh` still exports `Platform__MockBaseUrl=http://127.0.0.1:5050`.
Leave it until `S6-49`. Native handlers must not read it.

Do not `docker compose down` between sessions.

Stripe work (`S6-43`): `npm run preflight:stripe` then `npm run dev:stripe`.
Host access on the agent console is required.

## Architecture to implement against

Worked native example:
`src/backend/src/modules/MaterioForge.Access/Endpoints/PoliciesEndpoints.cs`

Playbook: `harness/module-playbook.json`. Mapping: `src/backend/module-map.json`
(where the handler goes). Prompt grouping: `harness/s6-modules.json` (which
namespaces a historical S6 item owned). They differ.

Spec for every route: `contracts/schemas/<ns>.schema.json` +
`harness/goldens/<ns>/` + `prototype/backend/services/<ns>*.js`.
`node harness/port.mjs dossier --route "<method> <path>"` slices those.

- Thin endpoint → domain directory → Postgres/Dynamo.
- Routes from `MaterioForge.Contracts.Routes`. No capability attributes.
  `.AllowAnonymous()` only when anonymous-by-design.
- Errors through the S3-05 problem-details writer with every extension member
  the golden expects.
- Money is `decimal` / `numeric(18,4)`. GST 10% AU.
- Port mock oddities. Do not silently "fix" them.
- Cross-module reads through published `Contracts/I*.cs`. Cross-module writes
  through domain events.

### Pattern A — pure proxy (most of the 1,290)

`MapProxy` / `service.ProxyAsync` / `bridge.SendAsync` → `:5050`. Examples:

- `MaterioForge.Bim/Domain/BimService.cs` (one-liner around `MockBimStateBridge`)
- `MaterioForge.Takeoff/Domain/TakeoffService.cs` (same)
- `EstimatingEndpointHelpers.MapProxy`, `ProjectsEndpointHelpers.MapProxy`,
  `TenderEndpointHelpers.MapProxy`
- Entire files: `EstimatorEndpoints.cs`, `EstimationWorkflowEndpoints.cs`,
  `TenderEndpoints.cs`, `WorkEndpoints.cs`, `WorkPackagesEndpoints.cs`,
  `ProjectWorkflowsEndpoints.cs`, BIM GETs, etc.

BIM/Takeoff writes that call `service.ProxyAsync` then `bridge.ApplyAsync` are
still Pattern A: both calls hit the mock. Dropping `ApplyAsync` alone still 500s.

### Pattern B — true dual-write (small)

Native `*Service` already returns the golden; `ApplyAsync` still hits `:5050`
and the exception becomes 500.

| Namespace | Routes | File |
|---|---|---|
| cart | DELETE /cart, DELETE /cart/items/{id}, POST /cart/items, POST /cart/merge | `CartEndpoints.cs` (GET cart is already native-only) |
| catalogue | POST /products | `CatalogueEndpoints.cs` |
| coupons | POST /coupons/create, POST /coupons/collect, DELETE /coupons/delete | `CouponsEndpoints.cs` |
| qa | POST /qa/submit-question | `QaEndpoints.cs` |
| webhooks | POST /webhooks/subscriptions | `WebhooksEndpoints.cs` (`MirrorCreateAsync` before native `CreateAsync`) |

Drop the mock side-effect. Do not rewrite the native service unless namespace
replay is still red after the drop.

### Not dual-write (easy to mix up)

- **Checkout.** `StripeCheckoutService.InitiateAsync` requires a mock
  `checkout_session_id` before Stripe. Native session id first, then
  `--namespace checkout` and `--namespace payments`.
- **Orders dispute.** `DisputeService` is mock-first (`bridge.SendAsync` then
  persist). Native create, then drop the bridge call.
- **Search.** `SearchService.RecordPartiesAsync` / `RecordsAsync` still
  `ForwardAsync` to `:5050`. S6-15.5 blessed `POST /search/records`
  success+validation goldens from .NET-with-mock-up. Match those goldens; do
  not recapture.
- **Finance remaining aggregations.** `MockSidecarClient` +
  `FinanceService.OrgCostRollupAsync` + `BuilderAnalyticsRollup`.
- **Agent runs.** `AgentRunExecutor.GetMockAsync` still HTTP to `:5050`.

### Existing Domain directories — wire before writing new ones

These already exist and are used as published contracts by *other* modules.
The MapProxy endpoints in their owning module do not use them. Prefer them:

| Directory | Module | Used by endpoints today? |
|---|---|---|
| `ProjectDirectory` / `IProjectDirectory` | Projects | No (other modules yes) |
| `EstimateDirectory` / `IEstimateDirectory` | Estimating | No (other modules yes) |
| `EstimateLineDirectory` | Estimating | event handlers, not estimator endpoints |
| `TakeoffLineDirectory` / `ITakeoffLineDirectory` | Takeoff | No (other modules yes) |
| `ProjectWorkflowTransitionService` | Projects | yes, but still calls the bridge after `PersistTransitionAsync` |
| `RateLibraryDirectory` | Estimating | rate-library endpoints (already native) |
| `CartService` | Ordering | yes — dual-write |
| `CatalogueService` / `CouponsService` / `QaService` | Catalogue | yes — dual-write |

`QuotesCaptureParity` overlays mock responses for the two mapped quote routes.
Keep the overlay against native results if the goldens still require it; prove
with `--namespace quotes`.

## Waves

Done for a wave = those namespaces have **zero** rows in
`harness/replay-report/catalog.json` (S8-01 snapshot kinds) **and** a fresh
`--namespace` replay prints ALL GREEN with `failed: 0`.

Cheap check while iterating:

```
node harness/replay.mjs --target http://localhost:8080 --route "<METHOD> <path>"
node harness/port.mjs verify --route "<METHOD> <path>" --flip
```

`--flip` only when the report it just wrote has zero failures. Never flip from
an old report. Never flip a namespace that still 500s.

### Wave 0 — dual-write (`S6-16`)

Namespaces: cart, catalogue (POST /products only), coupons, qa.
Comparisons: 14+4+11+4 = 33. Routes: 9.

```
node harness/replay.mjs --target http://localhost:8080 --namespace cart
node harness/replay.mjs --target http://localhost:8080 --namespace coupons
node harness/replay.mjs --target http://localhost:8080 --namespace qa
node harness/replay.mjs --target http://localhost:8080 --route "POST /products"
```

Done: `500-internal` for those namespaces is 0. Do not delete
`MockCartStateBridge` / `MockCatalogue*StateBridge` yet (checkout and other
catalogue writes may still need the type until later waves). Stop calling
`ApplyAsync` from these endpoints.

### Wave 1 — projects spine (`S6-17`…`S6-22`)

Historical S6-02 + workers/workerPortal (S6-10) + unmapped savedWork/builderOrg.
Order so later modules can call `IProjectDirectory`.

| ID | Namespaces | Routes | Snapshot cmp | Gate |
|---|---|---:|---:|---|
| S6-17 | projects reads | 9 | part of 81 | `--namespace projects` still red until S6-18 |
| S6-18 | projects writes | 10 | rest of 81 | `--namespace projects` → 0 failed. Unmapped `GET /projects/{id}/cost-model` is finance (`S6-44`), not this. |
| S6-19 | projectWorkflows | 26 | 39 | `--namespace projectWorkflows` |
| S6-20 | workPackages | 19 | 76 | `--namespace workPackages` |
| S6-21 | clientDecisions + savedWork | 5 + 3 unmapped | 21 + 10 | `--namespace clientDecisions` and `--namespace savedWork` |
| S6-22 | workers + workerPortal + builderOrg | 1 + 2 + 2 unmapped | 5 + 7 + 7 | three `--namespace` gates |

S6-19 is 26 routes. Allowed to decompose into GET vs write if the budget
warning fires. Do not start workPackages from inside S6-19.

Files: `MaterioForge.Projects/Endpoints/{Projects,ProjectWorkflows,WorkPackages,ClientDecisions,Workers,WorkerPortal}Endpoints.cs`,
`ProjectsEndpointHelpers.MapProxy`, `MockProjectsStateBridge`.
savedWork lives in Tendering (`module-map.json`). builderOrg lives in Identity
(no `MapEndpoints` today).

### Wave 2 — work (`S6-23`, `S6-24`)

`WorkEndpoints.cs` is all `MapProxy`. 28 routes / 100 cmp.

```
node harness/replay.mjs --target http://localhost:8080 --namespace work
```

S6-23 reads (13 GET), S6-24 writes (15). Done: work `500-internal` is 0.

### Wave 3 — estimating (`S6-25`…`S6-31`)

96 mapped-but-proxied estimator-family routes. Split by endpoint file.

| ID | File / ns | Routes | Snapshot cmp |
|---|---|---:|---:|
| S6-25 | `EstimatorEndpoints.cs` | 14 | part of 186 |
| S6-26 | `EstimatorAiRunsEndpoints.cs` | 14 | part of 186 |
| S6-27 | `EstimatorAiEndpoints.cs` | 8 | part of 186 |
| S6-28 | assemblies + sections + benchmarks | 6+7+1 | rest of 186 |
| S6-29 | estimationWorkflow GETs | 13 | part of 136 |
| S6-30 | estimationWorkflow writes | 18 | rest of 136 |
| S6-31 | estimateLines + costData + estimationDecisions + estimatorPortal | 5+6+2+2 | 20+27+8+6 |

`--namespace estimator` is red until S6-25…S6-28 are all done. Sub-steps prove
`--route`. The last of S6-25…S6-28 runs `--namespace estimator`.

Wire `EstimateDirectory` / `EstimateLineDirectory` into these handlers.

### Wave 4 — takeoff (`S6-32`…`S6-37`)

Largest pile: 317 takeoff + 12 takeoffImport comparisons, plus 1 unmapped DWG
route and 2 body-only routes.

| ID | Slice | Routes |
|---|---|---:|
| S6-32 | takeoff reads (plan-docs, presence, lines, worksheets, classification, converters, personas, prefs) | 17 |
| S6-33 | run / line / scale writes | 15 |
| S6-34 | match / slip-sheet / sheet-index | 11 |
| S6-35 | worksheet / export / presence writes / rfq / prefs | 11 |
| S6-36 | `TakeoffQuantityEndpoints` + body-only `DELETE /takeoff/quantity/delete-plan-document` | 18 |
| S6-37 | DWG + import + unmapped `PATCH /takeoff/dwg/update-layers` + body-only `PATCH /takeoff/dwg/update-scale` | 8+3+1+1 |

`GET /takeoff/converters` is attributed to both `bim` and `takeoff` in the
failure catalog (same route, both namespaces). **S6-32 owns it.** S6-38 skips it.

```
node harness/replay.mjs --target http://localhost:8080 --namespace takeoff
node harness/replay.mjs --target http://localhost:8080 --namespace takeoffImport
```

Wire `TakeoffLineDirectory`. Replace `TakeoffService` one-liner; do not leave
`ProxyAsync`.

### Wave 5 — BIM (`S6-38`, `S6-39`)

28 routes / 109 cmp minus the shared converters route.

S6-38: BIM GETs (10). S6-39: writes (17). Replace `BimService`; it is not a
domain service.

```
node harness/replay.mjs --target http://localhost:8080 --namespace bim
```

### Wave 6 — tender + quotes (`S6-40`, `S6-41`)

S6-40: tender 18 routes / 78 cmp (`TenderEndpoints.cs` MapProxy).
S6-41: quotes — 2 mapped 500s (`GET /quotes/get-quotes`, `POST /estimates/{id}/quotes`)
plus 9 unmapped 404s (38 cmp). Total quotes 45.

Unmapped quotes to `MapEndpoints` on `QuotesEndpoints.cs`:

- GET /quotes/get-quote
- GET /quotes/get-public-quote
- PATCH /quotes/update-quote
- POST /quotes/create-version
- POST /quotes/mark-quote-viewed
- POST /quotes/{id}/send
- POST /quotes/{id}/share
- POST /public/quotes/{token}/respond
- POST /public/quotes/{token}/share

```
node harness/replay.mjs --target http://localhost:8080 --namespace tender
node harness/replay.mjs --target http://localhost:8080 --namespace quotes
```

### Wave 7 — leftovers (`S6-42`…`S6-46`)

| ID | Namespaces | What it is | Gate |
|---|---|---|---|
| S6-42 | search | Pattern A ForwardAsync. 2 routes / 8 cmp | `--namespace search` |
| S6-43 | checkout, payments, orders | native checkout session id; refund; native dispute; body-only GET /orders | three `--namespace` |
| S6-44 | finance, invoices, milestones | org-cost-rollup sidecar; unmapped cost-model; unmapped progress-payment-schedules (also body-only); unmapped milestone-payments | three `--namespace` |
| S6-45 | pipelines, voice, agents | mostly native; 3 pipelines + 4 voice unmapped; body-only pipelines/voice/agents (scoreboard confidence 0.5714 vs 0.15) | three `--namespace` |
| S6-46 | webhooks, analytics, commercial | drop webhook MirrorCreate; native `BuilderAnalyticsRollup`; body-only credit register | three `--namespace` |

Unmapped leftovers (wave of "never wired"):

- milestones: GET /milestone-payments, POST …/approve, …/release, …/schedule
- voice: GET /voice/notes, POST /voice/notes, POST …/confirm, POST …/discard
- pipelines: GET /pipelines/list-runs, GET /pipelines/node-types, POST /pipelines/validate-graph
- invoices: GET/POST /projects/{id}/progress-payment-schedules, PATCH /progress-payment-schedules/{id}
- builderOrg: GET /builder-org/get-settings, PATCH /builder/org/settings (owned by S6-22)
- GET /projects/{id}/cost-model (finance)

`PipelinesEndpoints.cs` today maps only list + create. The other pipeline
routes that already exist somewhere else are body-only — fix those last inside
S6-45, not as a separate mystery pile.

### Wave 8 — admin 501 recapture (`S6-47`)

Routes (only these):

- GET /admin/orgs/{orgId}/feature-overrides
- PATCH /admin/orgs/{orgId}/feature-overrides

Goldens: `harness/goldens/admin/GET_admin-orgs-by-feature-overrides/*.json`
and `harness/goldens/admin/PATCH_admin-orgs-by-feature-overrides/*.json`.

Live API correctly returns 404 ProblemDetails (S8-01 unmatched-route contract).
Goldens expect `501 HANDLER_NOT_IMPLEMENTED` / `MockBackendError`.

Method (deterministic, live `:8080`, mock down):

```
node harness/replay.mjs --target http://localhost:8080 \
  --route "GET /admin/orgs/{orgId}/feature-overrides" \
  --dump-actuals /tmp/admin-overrides-get.json

node harness/replay.mjs --target http://localhost:8080 \
  --route "PATCH /admin/orgs/{orgId}/feature-overrides" \
  --dump-actuals /tmp/admin-overrides-patch.json
```

Dump keys are `scenario + "\x00" + facadeMethod` (same as S6-15.5). Keep the
golden envelope (`harnessVersion`, `clock`, `rngSeed`, `seedHash`,
`facadeMethod`, `namespace`, `scenario`, `principal`, `request`). Replace
`response.status` and `response.body` from the dump. Do not hand-edit extension
members. Do not recapture any other route.

`harness/rebaseline.mjs` is the wrong tool: it boots the mock container.

Then:

```
node harness/replay.mjs --target http://localhost:8080 --namespace admin
```

Done: `mock-501-to-404` is 0. Compared count on the full suite may drop from
3406 if a scenario is now out of a 501-shaped assertion, or stay 3406 with
those 9 now passing. Report the number.

### Wave 9 — integration (`S6-48`)

The only prompt that runs:

```
export MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z
export MF_DETERMINISTIC=1
export MF_DETERMINISTIC_SEED=2654435769
export MF_JWT_SECRET=materioforge-deterministic-harness-secret
node harness/replay.mjs --target http://localhost:8080 --reset-between-passes
```

Success: stdout contains `ALL GREEN: N comparisons match the goldens` with
`failed: 0`, `missingGolden: 0`, N = 3406 or 3406 minus whatever the two
recaptured admin routes changed. `:5050` still refused.

If this is red, do not flip anything, do not recapture, do not delete bridges.
Bank the remaining `(kind, namespace, route)` list from the new report and
`agent-step continue`.

### Wave 10 — cleanup (`S6-49`)

Only after S6-48 ALL GREEN.

Delete mock HTTP clients and the option they read:

- `MockBimStateBridge`, `MockTakeoffStateBridge`, `MockEstimatingStateBridge`,
  `MockProjectsStateBridge`, `MockTenderingStateBridge`, `MockCartStateBridge`,
  `MockCatalogueStateBridge`, `MockCatalogueAuxStateBridge`,
  `MockPricingStateBridge`, `MockWebhookStateBridge`, `MockSidecarClient`
- `SearchService.ForwardAsync` mock HTTP, `AgentRunExecutor.GetMockAsync`
- `PlatformOptions.MockBaseUrl`, `appsettings.json` `Platform:MockBaseUrl`,
  `Platform__MockBaseUrl` in `harness/restart-host-api.sh`
- HttpClient registrations in `ModuleRegistration.cs` files

```
rg MockBaseUrl src/backend harness/restart-host-api.sh
dotnet build src/backend/MaterioForge.slnx
node harness/replay.mjs --target http://localhost:8080 --namespace cart
# plus one namespace that used to be pure proxy, e.g. bim
```

Do not run the full suite again unless a compile-time removal could have
changed a handler. Prefer `--namespace` of a formerly-bridged module.

`rg MockBaseUrl src/backend` empty is a close criterion of this prompt, not of
earlier ones.

### Wave 11 — S8-01 remainder (`S8-01b`)

Local green is the prerequisite. AWS CLI is absent on this host. Deploy via
repo CI/OIDC (`infra/60-compute` / `.github/workflows/deploy.yml`) or a host
with AWS tooling.

- Confirm `infra/30-compute.yaml` still has one container (already banked).
- Deploy that revision.
- Replay the catalog suite against the deployed base URL (same four env vars).
- Prove rollback to the previous task definition still works.

Do not deploy a red local tree. Do not resurrect the mock sidecar.

## What stays on S8-01 vs new items

| Item | Where |
|---|---|
| YARP removal, unmatched 404, compose without mock, `--target mock` exit 2, one-container task def, deploy workflow mock digest | already in the working tree. S8-01 parked. Operator may mark S8-01 DONE with that evidence; do not resume it for native ports. |
| Native ports of 343 proxied + 30 unmapped routes | S6-16…S6-46 |
| Admin 501 recapture | S6-47 |
| Full local `--reset-between-passes` | S6-48 |
| Delete mock clients / `MockBaseUrl` | S6-49 |
| Deploy, deployed replay, rollback | S8-01b |
| Delete `prototype/backend/` | S8-02 (unchanged, after S8-01b) |

## CI

`.github/workflows/goldens.yml` already runs
`node harness/replay.mjs --target http://localhost:8080 --only-implemented`.
The brief's "historically `--target mock`" is stale. Do not "fix" CI by
pointing it at a resurrected mock. `--only-implemented` will stay red until
the proxied handlers are native — that is expected, not a licence to skip
namespace gates.

## Risks

| Risk | Why it happens | Rule |
|---|---|---|
| Dual-write vs pure proxy mix-up | BIM/Takeoff `ApplyAsync` looks like cart | If `*Service` calls the bridge, it is Pattern A. Dropping ApplyAsync is not a port. |
| `port.mjs --flip` on a red report | verify reads `results.failed` and `failures[0:10]` | Flip only when that run's report is 0 failed. Do not empty `failures` by hand. |
| Full suite as a progress check | 3406 comparisons, cold reset, overwrites the sharded tree | Namespace/route only until S6-48. |
| Golden recapture scope creep | dump-actuals is easy | Only the two admin feature-override routes, in S6-47. Search goldens were already blessed in S6-15.5 — do not touch them. |
| Deleting bridges before native ports | "14 call sites" looks small | Bridges die in S6-49. |
| Resuming S8-01 | UNREPORTED, last instruction was "port 14 call sites" | New stations. S8-01b is deploy only. |
| Reverting S8-01 / tidying S7 | dirty tree | Out of scope. |
| Bringing `:5050` up to fake the gate | 500s vanish | Diagnostic A/B only. Close on mock-down. |
| Implementing 501 for admin overrides | would fight S8-01 404 | Recapture. |
| `--only-implemented` as a module exit | includes still-proxied neighbours | Use `--namespace`. |

## Loading the prompts into the console

Prompt files: `docs/replay-green/prompts/S6-16.md` … `S8-01b.md`.
Each file starts with `# ID — Title` (import heading).

Program `backend-transition` already exists (id 1). Suites: S6 id 7, S8 id 9.
`POST /api/suites/7/prompts` does **not** set `external_key`. After paste,
set `external_key` and `prompt_dependency` rows (see `LOAD.md`).

Do not re-import the whole program pack.

## Success

```
ALL GREEN: N comparisons match the goldens
```

`:5050` refused. Prototype still on disk. Catalog routes that this program
owns still `x-implementation=dotnet` because they already were — the lie was
runtime, not the flag. `rg MockBaseUrl src/backend` empty only after S6-49.
S8-01b then deploys that tree.

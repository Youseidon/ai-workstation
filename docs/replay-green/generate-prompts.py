#!/usr/bin/env python3
"""Emit paste-ready pipeline prompts. Run from this directory."""
from pathlib import Path

OUT = Path(__file__).resolve().parent / "prompts"

STANDING = """\
## Standing rules (this prompt)

- Mock stays **down**. `:5050` refused. Do not start the sidecar to fake a green gate.
- Do not delete `prototype/backend/` (S8-02). Do not revert S8-01 strangler removals. Do not tidy leftover S7 diffs.
- R2 no tests/goldens except where this prompt names a recapture. R3 no docs/comments. R4 no git.
- JSON Schema is source of truth (R1). Money is `decimal` (R5). Derived request fields stay out (R6).
- Do not run `contracts/scripts/build-endpoint-catalog.mjs` wholesale (R7).
- Do not run full `replay.mjs --reset-between-passes` (that is S6-48).
- Do not `port.mjs --flip` unless the report **this run just wrote** has `results.failed === 0`.
- Do not empty `harness/replay-report.json` `failures` by hand.
- Never start anything on `:5050`. A/B against the mock is forbidden. Wrapping (`MapProxy` / `ProxyAsync` / `ApplyAsync` / `ForwardAsync`) is a failed close — the server probes `:5050` and replays with it down.
- Errors through the S3-05 problem-details writer with every golden extension member. Routes from `MaterioForge.Contracts.Routes`. No capability attributes. `.AllowAnonymous()` only when anonymous-by-design.
- Playbook: `harness/module-playbook.json`. Worked example: `src/backend/src/modules/MaterioForge.Access/Endpoints/PoliciesEndpoints.cs`.
- Spec: `node harness/port.mjs dossier --route "<method> <path>"` plus `prototype/backend/services/<ns>*.js`. Port mock oddities; do not silently fix them.
- When the budget warning fires: bank verified routes via `agent-step remark --kind PROGRESS`, then `continue` or `decompose` along the listed groups. Do not start the next prompt's namespace.
"""

PRECOND = """\
## Preconditions

```
curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:8080/health    # 200
curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:5050/health   # 000
export MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z
export MF_DETERMINISTIC=1
export MF_DETERMINISTIC_SEED=2654435769
export MF_JWT_SECRET=materioforge-deterministic-harness-secret
```

Warm stack: `npm run dev:infra` if infra is down; `npm run dev:api` after a build the running process does not have. Never `docker compose up --build api` to check work.
"""

REPORT = """\
## Report (bank through agent-step)

After each verified slice:

```
agent-step remark --kind PROGRESS --text "<routes greened; namespace replay compared/passed/failed>"
```

Before finishing, exactly one of:

```
agent-step done --verification "<commands; compared/passed/failed; MapProxy gone from owned files; catalog still dotnet>"
agent-step continue --remaining "<unfinished routes and the next command>" --verified "<what already replays green>"
agent-step blocked --reason "<external blocker>" --action "<exact human action>"
```

Work that is not finished is `continue`, not `blocked`.
"""


REPLAY_ENV = (
    "MF_DEMO_CLOCK=2026-01-15T00:00:00.000Z MF_DETERMINISTIC=1 "
    "MF_DETERMINISTIC_SEED=2654435769 MF_JWT_SECRET=materioforge-deterministic-harness-secret"
)


def routes_block(routes):
    return "\n".join(f"- `{r}`" for r in routes)


def verify_lines(block):
    """Prefix replay lines so the done-gate process has the harness env; never include --flip."""
    out = []
    for line in block.splitlines():
        raw = line.strip()
        if raw == "" or raw.startswith("#"):
            continue
        if raw.startswith("node harness/port.mjs"):
            continue
        if raw.startswith("node harness/replay.mjs"):
            timeout = "600s" if "reset-between-passes" in raw else "300s"
            out.append(f"{REPLAY_ENV} {raw}  # timeout={timeout}")
        else:
            out.append(raw)
    return "\n".join(out)


def write(key, title, body):
    path = OUT / f"{key}.md"
    path.write_text(f"# {key} — {title}\n\n{body.strip()}\n", encoding="utf-8")
    print(path.name, "bytes", path.stat().st_size)


def port_prompt(
    key,
    title,
    depends,
    pattern,
    namespaces,
    routes,
    files,
    verify,
    done,
    extra="",
    out_of_scope="",
    allow_decompose=False,
    existing_dirs="",
):
    dec = ""
    if allow_decompose:
        dec = (
            "\nThis item may `agent-step decompose` into the route groups listed below if the "
            "budget warning fires. Children must stay inside these namespaces.\n"
        )
    dirs = (
        f"\nPrefer existing directories before new domain: {existing_dirs}\n"
        if existing_dirs
        else ""
    )
    write(
        key,
        title,
        f"""\
Depends-on: {depends}

Native-port remainder after S8-01 removed YARP. Historical S6 items are DONE in the catalog because they `MapProxy`'d. Runtime is still `:5050`.

{STANDING}
{PRECOND}

## Pattern

**{pattern}.** Deleting the bridge without a native handler leaves these routes returning `500 InternalError`.

## In scope

Namespaces: {", ".join(f"`{n}`" for n in namespaces)}.

Routes (S8-01 snapshot — these are the mismatches this prompt must drive to zero):

{routes_block(routes)}
{dirs}
## Out of scope

{out_of_scope or "Any namespace not listed. Bridge class deletion (S6-49). Full-suite replay (S6-48). Golden edits. Deploy."}

## Files

{chr(10).join(f"- `{f}`" for f in files)}

.NET module from `src/backend/module-map.json`. Do not add cross-module entity references.

{extra}

## Implement

Thin endpoint: bind, delegate, return. Repositories/services only; no `DbContext` in handlers. Replace `MapProxy` / `ProxyAsync` / `bridge.SendAsync` for **these routes**. Leave neighbouring MapProxy routes for their prompts.

{dec}
## Verify

The server runs this block on `done` and refuses the close if any line fails.

```bash
node harness/assert-mock-down.mjs
dotnet build src/backend/MaterioForge.slnx
{verify_lines(verify)}
```

Done when: {done}

{REPORT}
""",
    )


# ---------------------------------------------------------------------------
# S6-16 dual-write
# ---------------------------------------------------------------------------
write(
    "S6-16",
    "Drop true dual-write mock side-effects (cart, catalogue POST /products, coupons, qa)",
    f"""\
Depends-on: none (S8-01 strangler already in the working tree; do not resume S8-01)

{STANDING}
{PRECOND}

## Pattern

**B — true dual-write.** Native `*Service` already returns the golden. `ApplyAsync` still HTTP to `:5050` and ExceptionMiddleware turns `Connection refused` into `500 InternalError`.

This is **not** BIM/Takeoff/Estimating `ApplyAsync` after `ProxyAsync` — those services *are* the bridge. Do not treat this prompt as "remove 14 call sites".

## In scope

Drop the mock side-effect only. Do not rewrite the native service unless namespace replay is still red after the drop.

| Namespace | Routes | File |
|---|---|---|
| cart | `DELETE /cart`, `DELETE /cart/items/{{id}}`, `POST /cart/items`, `POST /cart/merge` | `CartEndpoints.cs` (GET cart is already native-only — do not break it) |
| catalogue | `POST /products` | `CatalogueEndpoints.cs` |
| coupons | `POST /coupons/create`, `POST /coupons/collect`, `DELETE /coupons/delete` | `CouponsEndpoints.cs` |
| qa | `POST /qa/submit-question` | `QaEndpoints.cs` |

Snapshot: cart 14/4, catalogue 4/1, coupons 11/3, qa 4/1 = **33 comparisons / 9 routes**, all `500-internal`.

## Out of scope

- Checkout / payments / orders dispute (mock-first, `S6-43`)
- Search `ForwardAsync` (`S6-42`)
- Webhooks `MirrorCreateAsync` (`S6-46`)
- Deleting `MockCartStateBridge` / `MockCatalogueStateBridge` / `MockCatalogueAuxStateBridge` types (`S6-49` — checkout still constructs the cart bridge)
- Pricing explorer, promotions, rate library

## Files

- `src/backend/src/modules/MaterioForge.Ordering/Endpoints/CartEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Catalogue/Endpoints/CatalogueEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Catalogue/Endpoints/CouponsEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Catalogue/Endpoints/QaEndpoints.cs`

## Implement

Remove the `bridge.ApplyAsync(...)` call (and the unused parameter) from the in-scope handlers. Keep returning the native `*Service` result.

## Verification

```
dotnet build src/backend/MaterioForge.slnx
node harness/replay.mjs --target http://localhost:8080 --namespace cart
node harness/replay.mjs --target http://localhost:8080 --namespace coupons
node harness/replay.mjs --target http://localhost:8080 --namespace qa
node harness/replay.mjs --target http://localhost:8080 --route "POST /products"
```

Done when each of those prints ALL GREEN (`failed: 0`) and `ApplyAsync` is gone from the four files for these routes.

{REPORT}
""",
)

# ---------------------------------------------------------------------------
# Wave 1 projects
# ---------------------------------------------------------------------------
PROJECT_READS = [
    "GET /projects",
    "GET /projects/get-dashboard-rollup",
    "GET /projects/get-project-cards",
    "GET /projects/{id}",
    "GET /projects/{id}/activity",
    "GET /projects/{id}/client-change-impact",
    "GET /projects/{id}/client-settings",
    "GET /projects/{id}/intelligence",
    "GET /projects/{id}/intelligence/client",
]
PROJECT_WRITES = [
    "DELETE /projects/{id}",
    "PATCH /projects/{id}",
    "PATCH /projects/{id}/client",
    "PATCH /projects/{id}/client-settings",
    "POST /projects",
    "POST /projects/{id}/archive",
    "POST /projects/{id}/client/update-draft-documents",
    "POST /projects/{id}/intelligence/forecasts/{id}/acknowledge",
    "POST /projects/{id}/intelligence/forecasts/{id}/snooze",
    "POST /projects/{id}/promote-to-construction",
]
PWF = [
    "DELETE /project-workflows/delete-template-item",
    "DELETE /project-workflows/delete-transition",
    "GET /project-workflows/get-template",
    "GET /project-workflows/list-stages",
    "GET /project-workflows/list-templates",
    "GET /project-workflows/list-transitions",
    "GET /project-workflows/list-widgets",
    "PATCH /project-workflows/set-default-template",
    "PATCH /project-workflows/update-project-workflow-item-status",
    "PATCH /project-workflows/update-stage",
    "PATCH /project-workflows/update-template",
    "PATCH /project-workflows/update-template-item",
    "PATCH /project-workflows/update-transition",
    "POST /project-workflows/assign-project-workflow",
    "POST /project-workflows/clone-template",
    "POST /project-workflows/create-org-template",
    "POST /project-workflows/create-stage",
    "POST /project-workflows/create-template",
    "POST /project-workflows/create-template-item",
    "POST /project-workflows/create-transition",
    "POST /project-workflows/evaluate-project-transition",
    "POST /project-workflows/fork-project-workflow",
    "POST /project-workflows/reorder-stages",
    "POST /project-workflows/reorder-template-items",
    "POST /project-workflows/resolve-project-workflow",
    "POST /project-workflows/transition-project",
]
WP = [
    "DELETE /work-packages/archive-work-package-template",
    "GET /projects/{id}/financial-summary",
    "GET /projects/{id}/work-packages",
    "GET /projects/{id}/work-packages/{workPackageId}",
    "GET /projects/{id}/work-packages/{workPackageId}/checklist",
    "GET /projects/{id}/work-packages/{workPackageId}/financial-summary",
    "GET /projects/{projectId}/work-packages/{workPackageId}/contractors",
    "GET /work-package-templates",
    "GET /work-packages/get-work-package-template",
    "GET /work-packages/list-work-package-templates",
    "PATCH /projects/{id}/work-packages/{workPackageId}",
    "PATCH /projects/{id}/work-packages/{workPackageId}/checklist/{itemId}",
    "PATCH /work-packages/set-default-work-package-template",
    "PATCH /work-packages/update-work-package-template",
    "POST /projects/{id}/work-packages",
    "POST /work-packages/clone-work-package-template",
    "POST /work-packages/create-org-work-package-template",
    "POST /work-packages/create-platform-work-package-template",
    "PUT /projects/{id}/work-packages/reorder",
]

HAZARD_PROJECTS = """\
## Module-specific hazards (from S6-02)

- A lead is a project at `pre_construction` — not a separate entity.
- `stage_id` is the only stored stage value.
- Phases are required-tagged and materialised on transition.
- Stage-at-issue on quotes/trade packages is a snapshot.
- Transitions are transactional (stage + phases + outbox) and report blockers in mock order.
- `MapDeleteProject` already reconciles comfort-pack FK blockers against Postgres — keep that behaviour natively.
"""

port_prompt(
    "S6-17",
    "Native-port projects reads",
    "none (spine; may run after or beside S6-16)",
    "A — pure proxy (`ProjectsEndpointHelpers.MapProxy` → `MockProjectsStateBridge`)",
    ["projects"],
    PROJECT_READS,
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectsEndpointHelpers.cs",
        "src/backend/src/modules/MaterioForge.Projects/Domain/ProjectDirectory.cs",
        "src/backend/src/modules/MaterioForge.Projects/Domain/MockProjectsStateBridge.cs",
        "prototype/backend/services (grep projects)",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /projects"\nnode harness/port.mjs verify --route "GET /projects" --flip\n# …every in-scope route, then:\n# namespace projects stays red until S6-18 — do not claim the namespace done',
    "all 9 read routes green on every scenario; MapProxy gone from those Map* lines; `--namespace projects` is still allowed to fail on the 10 write routes",
    extra=HAZARD_PROJECTS,
    out_of_scope="Project writes (S6-18). `GET /projects/{id}/cost-model` is finance unmapped (S6-44).",
    existing_dirs="`ProjectDirectory` / `IProjectDirectory` (already published; endpoints do not use it)",
)

port_prompt(
    "S6-18",
    "Native-port projects writes",
    "S6-17",
    "A — pure proxy (DELETE uses `MapDeleteProject`, still the bridge)",
    ["projects"],
    PROJECT_WRITES,
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectsEndpointHelpers.cs",
        "src/backend/src/modules/MaterioForge.Projects/Domain/ProjectDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace projects',
    "`--namespace projects` ALL GREEN (81 snapshot comparisons → 0 failed). `GET /projects/{id}/cost-model` must still 404 — that is S6-44.",
    extra=HAZARD_PROJECTS + "\nKeep comfort-pack FK reconciliation on DELETE /projects/{id}.\n",
    existing_dirs="`ProjectDirectory`; `IClientPortalCommercialDirectory` for comfort-pack blockers",
)

port_prompt(
    "S6-19",
    "Native-port projectWorkflows",
    "S6-18",
    "A — pure proxy. `MapTransition` already calls `ProjectWorkflowTransitionService.PersistTransitionAsync` then the bridge — finish the native path and drop the bridge call",
    ["projectWorkflows"],
    PWF,
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectWorkflowsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Projects/Domain/ProjectWorkflowTransitionService.cs",
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ProjectsEndpointHelpers.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace projectWorkflows',
    "`--namespace projectWorkflows` ALL GREEN (39 snapshot comparisons / 26 routes → 0 failed)",
    extra="GET group first (7 routes), then writes (19). Allowed to decompose along that split.\n",
    allow_decompose=True,
)

port_prompt(
    "S6-20",
    "Native-port workPackages",
    "S6-18",
    "A — pure proxy",
    ["workPackages"],
    WP,
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/WorkPackagesEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Projects/Domain/ProjectDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace workPackages',
    "`--namespace workPackages` ALL GREEN (76 snapshot comparisons / 19 routes → 0 failed)",
    existing_dirs="`ProjectDirectory` (WorkPackageEntityType already in that type)",
)

port_prompt(
    "S6-21",
    "Native-port clientDecisions and map savedWork",
    "S6-18",
    "A — clientDecisions are MapProxy. savedWork has no MapEndpoints (other-to-404 after YARP removal)",
    ["clientDecisions", "savedWork"],
    [
        "GET /client-decisions",
        "GET /public/client-decisions/{token}",
        "PATCH /client-decisions/{id}",
        "POST /client-decisions",
        "POST /public/client-decisions/{token}/respond",
        "DELETE /win-work/saved?item_type=&item_id=",
        "GET /win-work/saved",
        "POST /win-work/saved",
    ],
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/ClientDecisionsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Tendering/Endpoints (add SavedWorkEndpoints or equivalent)",
        "src/backend/module-map.json — savedWork is Tendering",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace clientDecisions\nnode harness/replay.mjs --target http://localhost:8080 --namespace savedWork',
    "both namespace gates ALL GREEN (clientDecisions 21/5 `500-internal`; savedWork 10/3 `other-to-404`)",
    extra="savedWork routes are `/win-work/saved`. They were never mapped; YARP forwarded them. Add `MapEndpoints`; do not expect a bridge.\n",
)

port_prompt(
    "S6-22",
    "Native-port workers, workerPortal, and map builderOrg settings",
    "S6-18",
    "A — workers/workerPortal are MapProxy. builderOrg settings have no MapEndpoints (other-to-404)",
    ["workers", "workerPortal", "builderOrg"],
    [
        "POST /builder-orgs/{orgId}/workers/{workerId}/link-trade-profile",
        "GET /worker-portal/get-my-credentials",
        "POST /worker-portal/add-my-credential",
        "GET /builder-org/get-settings",
        "PATCH /builder/org/settings",
    ],
    [
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/WorkersEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Projects/Endpoints/WorkerPortalEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Identity (builderOrg — no Endpoints file today)",
        "src/backend/module-map.json — builderOrg is Identity",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace workers\nnode harness/replay.mjs --target http://localhost:8080 --namespace workerPortal\nnode harness/replay.mjs --target http://localhost:8080 --namespace builderOrg',
    "three namespace gates ALL GREEN (5+7+7 snapshot comparisons)",
    extra="Identity already has `IBuilderOrgMembershipDirectory` / org settings tables. Map the two settings routes; do not invent a second org id space.\n",
)

# ---------------------------------------------------------------------------
# Wave 2 work
# ---------------------------------------------------------------------------
WORK_READS = [
    "GET /work/activity",
    "GET /work/dispatch",
    "GET /work/get-board",
    "GET /work/get-calendar",
    "GET /work/get-kanban-template",
    "GET /work/get-report",
    "GET /work/get-summary",
    "GET /work/get-task",
    "GET /work/list-boards",
    "GET /work/list-kanban-templates",
    "GET /work/list-reports",
    "GET /work/my-day",
    "GET /work/trade-types",
]
WORK_WRITES = [
    "DELETE /work/delete-kanban-template",
    "PATCH /work/update-board",
    "PATCH /work/update-kanban-template",
    "PATCH /work/update-report",
    "PATCH /work/update-task",
    "POST /work/add-attachment",
    "POST /work/add-comment",
    "POST /work/add-report-attachment",
    "POST /work/apply-kanban-template",
    "POST /work/create-kanban-template",
    "POST /work/create-report",
    "POST /work/create-task",
    "POST /work/shifts",
    "POST /work/tasks/{taskId}/completion",
    "POST /work/tasks/{taskId}/completion/review",
]

port_prompt(
    "S6-23",
    "Native-port work reads",
    "S6-20",
    "A — `WorkEndpoints.cs` is MapProxy",
    ["work"],
    WORK_READS,
    ["src/backend/src/modules/MaterioForge.Projects/Endpoints/WorkEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /work/list-boards"\n# namespace work stays red until S6-24',
    "all 13 GET routes green; writes still 500 is OK",
)

port_prompt(
    "S6-24",
    "Native-port work writes",
    "S6-23",
    "A — `WorkEndpoints.cs` is MapProxy",
    ["work"],
    WORK_WRITES,
    ["src/backend/src/modules/MaterioForge.Projects/Endpoints/WorkEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --namespace work',
    "`--namespace work` ALL GREEN (100 snapshot comparisons / 28 routes → 0 failed)",
)

# ---------------------------------------------------------------------------
# Wave 3 estimating
# ---------------------------------------------------------------------------
EST_CORE = [
    "GET /estimates",
    "GET /estimates/{id}",
    "GET /estimator/get-estimate-lines",
    "GET /estimator/get-guest-preview",
    "GET /estimator/get-project-type-options",
    "POST /estimates",
    "POST /estimates/{id}/lines",
    "POST /estimator/auto-apply-exact",
    "POST /estimator/bulk-match",
    "POST /estimator/calculate",
    "POST /estimator/create-guest",
    "POST /estimator/export",
    "POST /estimator/reprice",
    "POST /estimator/save",
]
EST_AI_RUNS = [
    "DELETE /estimator/ai-runs/remove-source",
    "GET /estimator/ai-runs/get",
    "GET /estimator/ai-runs/get-group-candidates",
    "GET /estimator/ai-runs/list",
    "PATCH /estimator/ai-runs/rename-group",
    "PATCH /estimator/ai-runs/set-rate-match",
    "POST /estimator/ai-runs/add-sources",
    "POST /estimator/ai-runs/analyze",
    "POST /estimator/ai-runs/apply",
    "POST /estimator/ai-runs/confirm-stage",
    "POST /estimator/ai-runs/create-run",
    "POST /estimator/ai-runs/merge-groups",
    "POST /estimator/ai-runs/move-member",
    "POST /estimator/ai-runs/split-group",
]
EST_AI = [
    "GET /estimator/ai/list-estimate-jobs",
    "GET /estimator/ai/list-photo-templates",
    "POST /estimator/ai/confirm-photo-estimate",
    "POST /estimator/ai/enrich-estimate",
    "POST /estimator/ai/file-estimate",
    "POST /estimator/ai/guest-quick-preview",
    "POST /estimator/ai/photo-estimate",
    "POST /estimator/ai/quick-estimate",
]
EST_ASM = [
    "DELETE /estimator/assemblies/archive",
    "GET /estimator/assemblies/get",
    "PATCH /estimator/assemblies/update",
    "POST /estimator/assemblies/duplicate",
    "POST /estimator/assemblies/insert-into-estimate",
    "POST /estimator/assemblies/price-assembly",
    "DELETE /estimator/sections/delete",
    "GET /estimator/sections/list",
    "GET /estimator/sections/list-templates",
    "PATCH /estimator/sections/update",
    "POST /estimator/benchmarks/evaluate",
    "POST /estimator/sections/apply-template",
    "POST /estimator/sections/create",
    "POST /estimator/sections/move",
]
EW_READS = [
    "GET /estimation/projects/{projectId}/allowance-evidence",
    "GET /estimation/projects/{projectId}/allowance-reconciliations",
    "GET /estimation/projects/{projectId}/bid-snapshots",
    "GET /estimation/projects/{projectId}/contingency-drawdowns",
    "GET /estimation/projects/{projectId}/cost-assembly",
    "GET /estimation/projects/{projectId}/drawings",
    "GET /estimation/projects/{projectId}/prelims-basis",
    "GET /estimation/projects/{projectId}/priced-prelims-schedules",
    "GET /estimation/projects/{projectId}/risks",
    "GET /estimation/projects/{projectId}/tender-figure",
    "GET /estimation/projects/{projectId}/variation-baseline-bindings",
    "GET /estimation/projects/{projectId}/variations/{variationId}/baseline-binding-options",
    "GET /estimation/projects/{projectId}/workflow",
]
EW_WRITES = [
    "DELETE /estimation-workflow/delete-drawing",
    "DELETE /estimation/risks/{id}",
    "PATCH /estimation/drawings/{id}",
    "PATCH /estimation/projects/{projectId}/contingency-policy",
    "PATCH /estimation/projects/{projectId}/cost-assembly",
    "PATCH /estimation/projects/{projectId}/ps-pc-excess-rule",
    "PATCH /estimation/risks/{id}",
    "POST /estimation-workflow/create-drawing",
    "POST /estimation-workflow/repoint-drawings-for-revision",
    "POST /estimation-workflow/seed-drawings-for-plan-document",
    "POST /estimation/projects/{projectId}/allowance-evidence",
    "POST /estimation/projects/{projectId}/allowance-evidence/{allowanceEvidenceId}/reconcile",
    "POST /estimation/projects/{projectId}/bid-snapshots",
    "POST /estimation/projects/{projectId}/contingency-drawdowns",
    "POST /estimation/projects/{projectId}/priced-prelims-schedules",
    "POST /estimation/projects/{projectId}/risks",
    "POST /estimation/projects/{projectId}/variations/{variationId}/baseline-binding",
    "PUT /estimation/projects/{projectId}/contract-terms",
]
EST_REST = [
    "PATCH /estimate-lines/update-line",
    "POST /estimate-lines/apply-match",
    "POST /estimate-lines/match-line",
    "POST /estimate-lines/move-line",
    "POST /estimate-lines/reject-match",
    "GET /cost-data/localities",
    "GET /projects/{project_id}/cost-data-settings",
    "POST /estimates/{estimate_id}/cost-data-batch-price",
    "POST /estimates/{estimate_id}/cost-data-suggestions/accept",
    "POST /estimates/{estimate_id}/lines/{line_id}/cost-data-suggestion",
    "PUT /projects/{project_id}/cost-data-settings",
    "GET /estimation-decisions",
    "POST /estimation-decisions/{id}/resolve",
    "GET /estimator-portal/get-dashboard",
    "GET /estimator-portal/get-runs",
]

EST_FILES_CORE = [
    "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorEndpoints.cs",
    "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatingEndpointHelpers.cs",
    "src/backend/src/modules/MaterioForge.Estimating/Domain/EstimateDirectory.cs",
    "src/backend/src/modules/MaterioForge.Estimating/Domain/MockEstimatingStateBridge.cs",
]

port_prompt(
    "S6-25",
    "Native-port estimator core (estimates CRUD, calculate, save, match)",
    "S6-18",
    "A — `EstimatingEndpointHelpers.MapProxy`",
    ["estimator"],
    EST_CORE,
    EST_FILES_CORE,
    'node harness/port.mjs verify --route "GET /estimates" --flip\n# `--namespace estimator` stays red until S6-28',
    "all 14 core routes green on every scenario",
    existing_dirs="`EstimateDirectory`, `EstimateLineDirectory`",
    extra="`--namespace estimator` is 50 failing routes. This prompt owns 14. Do not start ai-runs.\n",
)

port_prompt(
    "S6-26",
    "Native-port estimator ai-runs",
    "S6-25",
    "A — MapProxy",
    ["estimator"],
    EST_AI_RUNS,
    [
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorAiRunsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatingEndpointHelpers.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /estimator/ai-runs/list"\n# remaining estimator routes still red is OK',
    "all 14 ai-runs routes green",
    allow_decompose=True,
)

port_prompt(
    "S6-27",
    "Native-port estimator AI photo/quick/file",
    "S6-25",
    "A — MapProxy",
    ["estimator"],
    EST_AI,
    ["src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorAiEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --route "POST /estimator/ai/quick-estimate"',
    "all 8 AI routes green",
)

port_prompt(
    "S6-28",
    "Native-port estimator assemblies, sections, benchmarks",
    "S6-25",
    "A — MapProxy",
    ["estimator"],
    EST_ASM,
    [
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorAssembliesEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorSectionsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorBenchmarksEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Domain/AssemblyPackLibrary.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace estimator',
    "`--namespace estimator` ALL GREEN (186 snapshot comparisons / 50 routes → 0 failed). Only run the namespace gate if S6-25…S6-27 are already green; otherwise `--route` only and `continue`.",
    existing_dirs="`AssemblyPackLibrary`, `EstimateDirectory`",
)

port_prompt(
    "S6-29",
    "Native-port estimationWorkflow reads",
    "S6-25",
    "A — MapProxy (`EstimationWorkflowEndpoints.cs`)",
    ["estimationWorkflow"],
    EW_READS,
    [
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimationWorkflowEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Domain/ProjectContractTermsDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /estimation/projects/{projectId}/workflow"',
    "all 13 GET routes green; writes still 500 is OK",
)

port_prompt(
    "S6-30",
    "Native-port estimationWorkflow writes",
    "S6-29",
    "A — MapProxy",
    ["estimationWorkflow"],
    EW_WRITES,
    [
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimationWorkflowEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Domain/ProjectContractTermsDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace estimationWorkflow',
    "`--namespace estimationWorkflow` ALL GREEN (136 snapshot comparisons / 31 routes → 0 failed)",
    allow_decompose=True,
    existing_dirs="`ProjectContractTermsDirectory`",
)

port_prompt(
    "S6-31",
    "Native-port estimateLines, costData, estimationDecisions, estimatorPortal",
    "S6-25",
    "A — MapProxy",
    ["estimateLines", "costData", "estimationDecisions", "estimatorPortal"],
    EST_REST,
    [
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimateLinesEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/CostDataEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimationDecisionsEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Endpoints/EstimatorPortalEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Estimating/Domain/EstimateLineDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace estimateLines\nnode harness/replay.mjs --target http://localhost:8080 --namespace costData\nnode harness/replay.mjs --target http://localhost:8080 --namespace estimationDecisions\nnode harness/replay.mjs --target http://localhost:8080 --namespace estimatorPortal',
    "four namespace gates ALL GREEN (20+27+8+6 snapshot comparisons)",
    existing_dirs="`EstimateLineDirectory`",
)

# ---------------------------------------------------------------------------
# Wave 4 takeoff
# ---------------------------------------------------------------------------
TO_READS = [
    "GET /plan-documents",
    "GET /plan-documents/{id}",
    "GET /plan-documents/{id}/entities",
    "GET /presence",
    "GET /presence/run-conflicts",
    "GET /takeoff-runs",
    "GET /takeoff/ai-personas",
    "GET /takeoff/converters",
    "GET /takeoff/get-preferences",
    "GET /takeoff/get-project-classification-settings",
    "GET /takeoff/get-revision-delta",
    "GET /takeoff/get-takeoff-lines",
    "GET /takeoff/get-worksheet",
    "GET /takeoff/list-classification-codes",
    "GET /takeoff/list-classification-systems",
    "GET /takeoff/list-worksheet-reference-targets",
    "GET /takeoff/list-worksheets",
]
TO_RUNS = [
    "DELETE /takeoff-lines/{id}",
    "PATCH /takeoff-lines/{id}",
    "POST /plan-documents/{id}/confirm-scale",
    "POST /plan-documents/{id}/detect-scale",
    "POST /plan-documents/{id}/propagate-scale",
    "POST /plan-documents/{id}/takeoff-runs",
    "POST /takeoff-lines/{id}/review",
    "POST /takeoff-runs/{id}/ai-proposal",
    "POST /takeoff-runs/{id}/approve",
    "POST /takeoff-runs/{id}/count-assist",
    "POST /takeoff-runs/{id}/lines/from-entities",
    "POST /takeoff-runs/{id}/reject",
    "POST /takeoff-runs/{id}/request-revision",
    "POST /takeoff-runs/{id}/submit-for-review",
    "POST /takeoff/add-takeoff-line",
]
TO_MATCH = [
    "POST /takeoff/apply-match",
    "POST /takeoff/auto-apply-exact",
    "POST /takeoff/bulk-match",
    "POST /takeoff/match-line",
    "POST /takeoff/reject-match",
    "POST /takeoff/replicate-lines",
    "POST /takeoff/confirm-sheet-index",
    "POST /takeoff/run-sheet-index",
    "POST /takeoff/confirm-slip-sheet",
    "POST /takeoff/propose-slip-sheet",
    "POST /takeoff/execute-slip-sheet-carry-forward",
]
TO_WS = [
    "PATCH /takeoff/update-preferences",
    "PATCH /takeoff/update-worksheet",
    "POST /presence/end",
    "POST /presence/heartbeat",
    "POST /takeoff/create-worksheet",
    "POST /takeoff/export-run-document",
    "POST /takeoff/export-to-client-quote",
    "POST /takeoff/export-to-estimate",
    "POST /takeoff/export-to-sub-quote",
    "POST /takeoff/export-worksheet-xlsx",
    "POST /takeoff/request-rfq",
]
TO_Q = [
    "GET /takeoff/quantity/get-cad-elements",
    "GET /takeoff/quantity/get-cad-sessions",
    "GET /takeoff/quantity/get-converters",
    "GET /takeoff/quantity/get-measurement-summary",
    "GET /takeoff/quantity/get-measurements",
    "GET /takeoff/quantity/get-plan-documents",
    "POST /takeoff/quantity/add-elements-to-estimate",
    "POST /takeoff/quantity/aggregate-cad-elements",
    "POST /takeoff/quantity/analyze-document",
    "POST /takeoff/quantity/create-estimate-from-cad-group",
    "POST /takeoff/quantity/create-measurement",
    "POST /takeoff/quantity/download-document",
    "POST /takeoff/quantity/export-measurements",
    "POST /takeoff/quantity/extract-tables",
    "POST /takeoff/quantity/link-to-estimate",
    "POST /takeoff/quantity/push-to-estimate",
    "POST /takeoff/quantity/upload-plan-document",
    "DELETE /takeoff/quantity/delete-plan-document",
]
TO_DWG = [
    "GET /takeoff/dwg/get-thumbnail",
    "GET /takeoff/dwg/list-drawings",
    "POST /takeoff/dwg/compare",
    "POST /takeoff/dwg/create-task-stub",
    "POST /takeoff/dwg/create-variation-draft",
    "POST /takeoff/dwg/export-quantify-to-excel",
    "POST /takeoff/dwg/link-annotation-to-estimate",
    "POST /takeoff/dwg/quantify-by-layer",
    "PATCH /takeoff/dwg/update-layers",
    "PATCH /takeoff/dwg/update-scale",
    "POST /takeoff/imports/commit",
    "POST /takeoff/imports/detect",
    "POST /takeoff/imports/preview",
]

TO_NOTE = """\
`TakeoffService` is a one-liner around `MockTakeoffStateBridge`. Writes that call `service.*` then `bridge.ApplyAsync` are still Pattern A. Replace the service.

`GET /takeoff/converters` also appears under the bim failure namespace. **This wave owns it.** BIM prompts skip it.
"""

port_prompt(
    "S6-32",
    "Native-port takeoff reads",
    "S6-25",
    "A — `TakeoffService` / `MockTakeoffStateBridge`",
    ["takeoff"],
    TO_READS,
    [
        "src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Takeoff/Domain/TakeoffService.cs",
        "src/backend/src/modules/MaterioForge.Takeoff/Domain/TakeoffLineDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /takeoff/get-takeoff-lines"',
    "all 17 GET routes green",
    extra=TO_NOTE,
    existing_dirs="`TakeoffLineDirectory`",
)

port_prompt(
    "S6-33",
    "Native-port takeoff run, line, and scale writes",
    "S6-32",
    "A — TakeoffService + ApplyAsync both hit the mock",
    ["takeoff"],
    TO_RUNS,
    [
        "src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Takeoff/Domain/TakeoffLineDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "POST /takeoff/add-takeoff-line"',
    "all 15 routes green",
    extra=TO_NOTE,
    existing_dirs="`TakeoffLineDirectory`",
)

port_prompt(
    "S6-34",
    "Native-port takeoff match, slip-sheet, sheet-index",
    "S6-32",
    "A",
    ["takeoff"],
    TO_MATCH,
    ["src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --route "POST /takeoff/match-line"',
    "all 11 routes green",
    extra=TO_NOTE,
)

port_prompt(
    "S6-35",
    "Native-port takeoff worksheet, export, presence, rfq",
    "S6-32",
    "A",
    ["takeoff"],
    TO_WS,
    ["src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --namespace takeoff\n# namespace is red until S6-37 unless those routes already pass',
    "all 11 routes green. Do not claim `--namespace takeoff` until S6-37.",
    extra=TO_NOTE,
)

port_prompt(
    "S6-36",
    "Native-port takeoff quantity (including body-only delete-plan-document)",
    "S6-32",
    "A — `TakeoffQuantityEndpoints` ApplyAsync; body-only last among these routes",
    ["takeoff"],
    TO_Q,
    ["src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffQuantityEndpoints.cs"],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /takeoff/quantity/get-measurements"',
    "all 18 routes green including body-only `DELETE /takeoff/quantity/delete-plan-document`",
    extra="Body-only is last, not a separate pile. Status already matches; port mock body oddities.\n",
)

port_prompt(
    "S6-37",
    "Native-port takeoff DWG + import + leftover 404/body-only",
    "S6-32",
    "A — DWG/import ApplyAsync. `PATCH /takeoff/dwg/update-layers` is other-to-404 (mapped as POST in TakeoffDwgEndpoints — check the catalog verb). `PATCH /takeoff/dwg/update-scale` is body-only",
    ["takeoff", "takeoffImport"],
    TO_DWG,
    [
        "src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffDwgEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Takeoff/Endpoints/TakeoffImportEndpoints.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace takeoff\nnode harness/replay.mjs --target http://localhost:8080 --namespace takeoffImport',
    "both namespace gates ALL GREEN (takeoff 317 snapshot comparisons including body-only/404; takeoffImport 12). If `PATCH /takeoff/dwg/update-layers` is catalogued as PATCH but the file maps POST, map the catalog verb — do not recapture.",
    extra=TO_NOTE,
)

# ---------------------------------------------------------------------------
# Wave 5 BIM
# ---------------------------------------------------------------------------
BIM_READS = [
    "GET /bim/clash-groups",
    "GET /bim/clash-results",
    "GET /bim/clash-tests",
    "GET /bim/coordination-issues",
    "GET /bim/element-groups?model_id=",
    "GET /bim/federations?project_id=",
    "GET /bim/links?model_id=|estimate_id=|estimate_line_id=",
    "GET /bim/models/{id}/elements?level=&category=&q=&ids=",
    "GET /bim/models?project_id=&status=",
    "GET /bim/quantity-maps",
]
BIM_WRITES = [
    "DELETE /bim/element-groups/{id}",
    "PATCH /bim/clash-groups/{id}",
    "PATCH /bim/clash-results/{id}",
    "POST /bim/bcf/import",
    "POST /bim/clash-groups/{id}/export-bcf",
    "POST /bim/clash-tests",
    "POST /bim/clash-tests/{id}/export-bcf",
    "POST /bim/clash-tests/{id}/group",
    "POST /bim/clash-tests/{id}/run",
    "POST /bim/element-groups",
    "POST /bim/federations",
    "POST /bim/models",
    "POST /bim/models/ingest-extraction",
    "POST /bim/models/upload",
    "POST /bim/models/{id}/diff/{other_id}",
    "POST /bim/push-to-estimate",
    "POST /bim/quantity-maps/apply",
]

port_prompt(
    "S6-38",
    "Native-port BIM reads",
    "S6-32",
    "A — `BimService` is a one-liner around `MockBimStateBridge`. GET handlers call `service.ProxyAsync`",
    ["bim"],
    BIM_READS,
    [
        "src/backend/src/modules/MaterioForge.Bim/Endpoints/BimEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Bim/Domain/BimService.cs",
        "src/backend/src/modules/MaterioForge.Bim/Domain/MockBimStateBridge.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --route "GET /bim/clash-tests"',
    "all 10 BIM GET routes green. Skip `GET /takeoff/converters` (S6-32).",
    extra="Do not drop ApplyAsync and call it a port. Replace BimService with real reads against Postgres/Dynamo/S3 as the mock does.\n",
)

port_prompt(
    "S6-39",
    "Native-port BIM writes",
    "S6-38",
    "A — ProxyAsync + ApplyAsync both hit the mock",
    ["bim"],
    BIM_WRITES,
    [
        "src/backend/src/modules/MaterioForge.Bim/Endpoints/BimEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Bim/Domain/BimService.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace bim',
    "`--namespace bim` ALL GREEN (109 snapshot comparisons). `GET /takeoff/converters` must already be green from S6-32; if it is the only remaining bim-namespace failure, stop and point at S6-32 rather than reimplementing it.",
    allow_decompose=True,
)

# ---------------------------------------------------------------------------
# Wave 6 tender + quotes
# ---------------------------------------------------------------------------
TENDER = [
    "GET /sub-quotes",
    "GET /tender/get-address-book",
    "GET /tender/get-invitations",
    "GET /trade-packages",
    "GET /trade-packages/{id}",
    "GET /trade-validity-defaults",
    "PATCH /sub-quotes/{id}",
    "PATCH /trade-packages/{id}",
    "POST /sub-quotes/{id}/reconfirm",
    "POST /sub-quotes/{id}/scope-adjustments",
    "POST /sub-quotes/{id}/select",
    "POST /sub-quotes/{id}/withdraw",
    "POST /tender-invitations/{id}/decline",
    "POST /tender-invitations/{id}/view",
    "POST /trade-packages",
    "POST /trade-packages/{id}/invitations/batch",
    "POST /trade-packages/{id}/publish",
    "POST /trade-packages/{id}/quotes",
]
QUOTES = [
    "GET /quotes/get-quotes",
    "POST /estimates/{id}/quotes",
    "GET /quotes/get-quote",
    "GET /quotes/get-public-quote",
    "PATCH /quotes/update-quote",
    "POST /quotes/create-version",
    "POST /quotes/mark-quote-viewed",
    "POST /quotes/{id}/send",
    "POST /quotes/{id}/share",
    "POST /public/quotes/{token}/respond",
    "POST /public/quotes/{token}/share",
]

port_prompt(
    "S6-40",
    "Native-port tender",
    "S6-25",
    "A — `TenderEndpointHelpers.MapProxy` / `MockTenderingStateBridge`",
    ["tender"],
    TENDER,
    [
        "src/backend/src/modules/MaterioForge.Tendering/Endpoints/TenderEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Tendering/Domain/MockTenderingStateBridge.cs",
        "src/backend/src/modules/MaterioForge.Tendering/Domain/LabourCommitDirectory.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace tender',
    "`--namespace tender` ALL GREEN (78 snapshot comparisons / 18 routes)",
    extra="Stage-at-issue on trade packages is a snapshot (S6-02 hazard). Port it.\n",
)

port_prompt(
    "S6-41",
    "Native-port quotes (replace proxy + map the 9 YARP-only routes)",
    "S6-40",
    "A — two routes are `QuotesEndpoints` → bridge + `QuotesCaptureParity`. Nine routes have no MapEndpoints (`other-to-404`)",
    ["quotes"],
    QUOTES,
    [
        "src/backend/src/modules/MaterioForge.Tendering/Endpoints/QuotesEndpoints.cs",
        "src/backend/src/modules/MaterioForge.Tendering/Domain/QuotesCaptureParity.cs",
        "src/backend/src/modules/MaterioForge.Tendering/Domain/MockTenderingStateBridge.cs",
    ],
    'node harness/replay.mjs --target http://localhost:8080 --namespace quotes',
    "`--namespace quotes` ALL GREEN (45 snapshot comparisons: 7 `500-internal` + 38 `other-to-404`)",
    extra="Keep `QuotesCaptureParity` against native results if goldens still require the overlay; prove it, do not delete it speculatively. Public token routes are anonymous-by-design.\n",
)

# ---------------------------------------------------------------------------
# Wave 7 leftovers
# ---------------------------------------------------------------------------
write(
    "S6-42",
    "Native-port search record-parties and records",
    f"""\
Depends-on: S6-16

{STANDING}
{PRECOND}

## Pattern

**Not dual-write.** `SearchService.RecordPartiesAsync` / `RecordsAsync` `ForwardAsync` to `:5050`. `GlobalSearch` is already native (empty). Comment on `MockSidecarClient` does not apply here — this is `SearchService` HTTP.

## In scope

- `POST /search/record-parties`
- `POST /search/records`

Snapshot: 8 comparisons / 2 routes, `500-internal`.

S6-15.5 already blessed `POST /search/records` success+validation goldens from .NET-with-mock-up. **Do not recapture.** Native fan-out must match those goldens (and the remaining unauth/forbidden/etc.).

## Out of scope

Pricing search, catalogue listing, deleting `SearchService` as a type.

## Files

- `src/backend/src/modules/MaterioForge.Catalogue/Domain/SearchService.cs`
- `src/backend/src/modules/MaterioForge.Catalogue/Domain/SearchCaptureParity.cs`
- `src/backend/src/modules/MaterioForge.Catalogue/Endpoints/SearchEndpoints.cs`

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace search
```

Done: namespace ALL GREEN (8 → 0 failed).

{REPORT}
""",
)

write(
    "S6-43",
    "Native-port checkout session id, payments refund, orders dispute",
    f"""\
Depends-on: S6-16

{STANDING}
{PRECOND}

Stripe: `npm run preflight:stripe` then `npm run dev:stripe` (loads `.env` / `.env.stripe.local`). Do not paste secrets. Host access required on the agent console.

## Pattern

**Not dual-write.**

- `StripeCheckoutService.InitiateAsync` requires a mock `checkout_session_id` before Stripe. Mint a native deterministic session id (clock/seed already pinned). Then confirm/refund against that id.
- `DisputeService` is mock-first (`bridge.SendAsync` then persist). Invert: native create, drop the bridge call.
- `GET /orders` is body-only (status matches). Fix last among this prompt's routes.

## In scope

- `POST /checkout/initiate`, `POST /checkout/confirm` (6 cmp)
- `POST /payments/refund` (4 cmp)
- `POST /orders/{{id}}/dispute` (5 cmp)
- `GET /orders` body-only (3 cmp)

## Out of scope

Cart (S6-16). Webhooks Stripe listener. Deleting `MockCartStateBridge` (S6-49).

## Files

- `src/backend/src/modules/MaterioForge.Ordering/Domain/StripeCheckoutService.cs`
- `src/backend/src/modules/MaterioForge.Ordering/Domain/DisputeService.cs`
- `src/backend/src/modules/MaterioForge.Ordering/Endpoints/CheckoutEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Ordering/Endpoints/OrderEndpoints.cs`

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace checkout
node harness/replay.mjs --target http://localhost:8080 --namespace payments
node harness/replay.mjs --target http://localhost:8080 --namespace orders
```

Done: three namespace gates ALL GREEN.

{REPORT}
""",
)

write(
    "S6-44",
    "Native-port finance rollup, map invoices schedules and milestones, map cost-model",
    f"""\
Depends-on: S6-18

{STANDING}
{PRECOND}

## Pattern

- `POST /finance/org-cost-rollup` — `FinanceService` → `MockSidecarClient` (Pattern A fan-out, not dual-write).
- `GET /projects/{{id}}/cost-model` — **unmapped** (`other-to-404` and `body-only` in the snapshot). Finance namespace. Add `MapEndpoints`.
- invoices progress-payment-schedules — unmapped (5 other-to-404) **and** body-only (9) for the same three routes once something responds. Map them, then match bodies.
- milestones — 4 unmapped routes (16 other-to-404) plus 2 body-only (release/schedule).

Body-only last among each namespace's routes.

## In scope

Finance:

- `POST /finance/org-cost-rollup`
- `GET /projects/{{id}}/cost-model`

Invoices:

- `GET /projects/{{id}}/progress-payment-schedules`
- `POST /projects/{{id}}/progress-payment-schedules`
- `PATCH /progress-payment-schedules/{{id}}`

Milestones:

- `GET /milestone-payments`
- `POST /milestone-payments/{{id}}/approve`
- `POST /milestone-payments/{{id}}/release`
- `POST /milestone-payments/{{id}}/schedule`

## Out of scope

Builder dashboard analytics (`S6-46`). Payouts, retention, invoice CRUD already native.

## Files

- `src/backend/src/modules/MaterioForge.Billing/Domain/FinanceService.cs`
- `src/backend/src/modules/MaterioForge.Billing/Domain/MockSidecarClient.cs`
- `src/backend/src/modules/MaterioForge.Billing/Endpoints/FinanceEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Billing/Endpoints/InvoicesEndpoints.cs`
- Billing milestones endpoints (add if missing — `module-map.json` puts milestones on Billing)

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace finance
node harness/replay.mjs --target http://localhost:8080 --namespace invoices
node harness/replay.mjs --target http://localhost:8080 --namespace milestones
```

Done: three namespace gates ALL GREEN (finance 8, invoices 14, milestones 18 snapshot comparisons).

{REPORT}
""",
)

write(
    "S6-45",
    "Map remaining pipelines and voice; fix agents/pipelines/voice body-only",
    f"""\
Depends-on: none (already mostly native; independent of MapProxy waves)

{STANDING}
{PRECOND}

## Pattern

S6-12 already native-ported most of this. Failures are:

- **other-to-404** — never mapped (YARP used to forward): pipelines 3 routes / 10 cmp; voice 4 routes / 11 cmp (confirm/discard also body-only).
- **body-only** — status matches, body differs: pipelines 24/6, voice 6/2, agents 4/2 (`GET /agents/scoreboard` confidence 0.5714 vs 0.15 is the known example).

Do **not** recapture these goldens. Port mock oddities / map the missing routes.

`PipelinesEndpoints.cs` today maps only list + create. Other pipeline routes that already exist must be found before adding duplicates.

`AgentRunExecutor.GetMockAsync` still HTTP to `:5050` — if scoreboard/list-runs 500 or drift because of that, replace with native reads. Do not delete the helper until S6-49 if some other path still needs it; stop calling it from the in-scope routes.

## In scope

Pipelines unmapped:

- `GET /pipelines/list-runs`
- `GET /pipelines/node-types`
- `POST /pipelines/validate-graph`

Pipelines body-only (last):

- `DELETE /pipelines/{{id}}`
- `GET /pipelines/get-run`
- `GET /pipelines/{{id}}`
- `PATCH /pipelines/{{id}}`
- `POST /pipelines/run`
- `POST /pipelines/wait-for-run`

Voice unmapped + body-only:

- `GET /voice/notes?project_id=`
- `POST /voice/notes`
- `POST /voice/notes/{{id}}/confirm`
- `POST /voice/notes/{{id}}/discard`

Agents body-only:

- `GET /agents/list-runs`
- `GET /agents/scoreboard`

There is no `VoiceEndpoints.cs` today (Messaging module). Add it.

## Out of scope

Webhooks (`S6-46`). Admin 501 recapture (`S6-47`).

## Files

- `src/backend/src/modules/MaterioForge.Platform/Endpoints/PipelinesEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Platform/Endpoints/AgentsEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Platform/Domain/AgentRunExecutor.cs`
- `src/backend/src/modules/MaterioForge.Messaging/Endpoints/` (add voice)
- `src/backend/module-map.json` — voice is Messaging; pipelines/agents are Platform

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace pipelines
node harness/replay.mjs --target http://localhost:8080 --namespace voice
node harness/replay.mjs --target http://localhost:8080 --namespace agents
```

Done: three namespace gates ALL GREEN (pipelines 34, voice 17, agents 4 snapshot comparisons).

{REPORT}
""",
)

write(
    "S6-46",
    "Drop webhook mock mirror; native analytics rollup; commercial credit body-only",
    f"""\
Depends-on: S6-16

{STANDING}
{PRECOND}

## Pattern

- webhooks `POST /webhooks/subscriptions`: native `WebhookSubscriptionService.CreateAsync` already runs, but `MockWebhookStateBridge.MirrorCreateAsync` runs first and 500s. Drop the mirror (true dual-write / mock-first hybrid). Snapshot 3 cmp / 1 route.
- analytics `GET /builder/dashboard`: `BuilderAnalyticsRollup` → `MockSidecarClient`. Pattern A fan-out. Snapshot 3/1.
- commercial `GET /commercial/get-credit-register`, `GET /commercial/get-my-credit-status`: body-only (2). Status matches. Last.

## In scope

Those four routes only.

## Out of scope

Webhook deliveries (already S6-12.2). Finance org-cost-rollup (`S6-44`). Deleting `MockSidecarClient` / `MockWebhookStateBridge` types (`S6-49`).

## Files

- `src/backend/src/modules/MaterioForge.Platform/Endpoints/WebhooksEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Platform/Domain/MockWebhookStateBridge.cs`
- `src/backend/src/modules/MaterioForge.Billing/Domain/BuilderAnalyticsRollup.cs`
- `src/backend/src/modules/MaterioForge.Billing/Domain/MockSidecarClient.cs`
- `src/backend/src/modules/MaterioForge.Platform/Endpoints/AnalyticsEndpoints.cs`
- `src/backend/src/modules/MaterioForge.Commercial/Endpoints/CreditEndpoints.cs`

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace webhooks
node harness/replay.mjs --target http://localhost:8080 --namespace analytics
node harness/replay.mjs --target http://localhost:8080 --route "GET /commercial/get-credit-register"
node harness/replay.mjs --target http://localhost:8080 --route "GET /commercial/get-my-credit-status"
```

Done: webhooks + analytics namespace ALL GREEN; two commercial routes green. Do not require `--namespace commercial` if other commercial routes (already native) still pass — if the namespace replay is green, say so; if it fails on an out-of-scope route, stop and report rather than expanding.

{REPORT}
""",
)

# ---------------------------------------------------------------------------
# S6-47 recapture
# ---------------------------------------------------------------------------
write(
    "S6-47",
    "Recapture admin feature-override goldens from live :8080 404",
    f"""\
Depends-on: none (S8-01 unmatched-route 404 is already the live contract)

{STANDING}
{PRECOND}

## In scope

**Only** these two routes, all scenarios:

- `GET /admin/orgs/{{orgId}}/feature-overrides`
- `PATCH /admin/orgs/{{orgId}}/feature-overrides`

Snapshot: 9 comparisons, kind `mock-501-to-404`. Golden expects `501 HANDLER_NOT_IMPLEMENTED` / `MockBackendError`. Live API correctly returns 404 ProblemDetails (`Not found` / `NotFound` / `correlation_id`).

Do **not** implement a fake 501. That fights S8-01.

## Out of scope

Every other golden. Search goldens were blessed in S6-15.5 — do not touch them. Do not recapture because a port is red.

## Files

- `harness/goldens/admin/GET_admin-orgs-by-feature-overrides/{{success,unauthenticated,forbidden,not_found,validation}}.json`
- `harness/goldens/admin/PATCH_admin-orgs-by-feature-overrides/` (same scenario set; validation may be absent on one verb)

`harness/rebaseline.mjs` is the **wrong** tool: it boots the mock container.

## Method

Live `:8080`, mock down, same four env vars:

```
node harness/replay.mjs --target http://localhost:8080 \\
  --route "GET /admin/orgs/{{orgId}}/feature-overrides" \\
  --dump-actuals /tmp/admin-overrides-get.json

node harness/replay.mjs --target http://localhost:8080 \\
  --route "PATCH /admin/orgs/{{orgId}}/feature-overrides" \\
  --dump-actuals /tmp/admin-overrides-patch.json
```

Dump keys are `scenario + "\\x00" + facadeMethod` (same as S6-15.5). Keep the golden envelope (`harnessVersion`, `clock`, `rngSeed`, `seedHash`, `facadeMethod`, `namespace`, `scenario`, `principal`, `request`). Replace only `response.status` and `response.body` from the dump. Do not hand-edit extension members. Byte-stable JSON (existing golden formatting: 2-space, trailing newline).

Do not add a new capture script to the repo unless dump-actuals cannot name the facade method — if so, a 20-line node one-liner in the report is enough; do not commit it.

## Verification

```
node harness/replay.mjs --target http://localhost:8080 --namespace admin
```

Done: `--namespace admin` ALL GREEN; `mock-501-to-404` would be 0 on a full report. Do not run the full suite.

{REPORT}
""",
)

# ---------------------------------------------------------------------------
# S6-48 integration
# ---------------------------------------------------------------------------
write(
    "S6-48",
    "Full mock-offline golden replay must print ALL GREEN",
    f"""\
Depends-on: S6-16 … S6-47 all DONE

{STANDING.replace(
    "- Do not run full `replay.mjs --reset-between-passes` (that is S6-48).",
    "- This prompt **is** the full `replay.mjs --reset-between-passes` run. Do not run it twice to make sure. Do not recapture goldens if it is red.",
)}

This is the **only** prompt that runs the full suite. If a namespace gate is still red, this item is not ready — `continue` naming the red namespace, do not start the suite.

{PRECOND}

Confirm mock down **and** health:

```
curl -s -o /dev/null -w '%{{http_code}}\\n' http://localhost:8080/health
curl -s -o /dev/null -w '%{{http_code}}\\n' http://127.0.0.1:5050/health
```

Then **once**:

```
node harness/replay.mjs --target http://localhost:8080 --reset-between-passes
```

Success is stdout:

```
ALL GREEN: N comparisons match the goldens
```

with `failed: 0`, `missingGolden: 0`, `skipped: 0`. N is 3406, or 3406 minus whatever S6-47 changed. Report N.

This run **overwrites** `harness/replay-report.json` with a full blob. Do not delete the sharded S8-01 tree; it is a snapshot.

If red: do not flip, do not recapture, do not delete bridges. Query the new report with `jq` (do not cat the 5 MB file). Bank remaining `(kind, namespace, route)` and `agent-step continue`.

Do not deploy. Do not delete `MockBaseUrl`.

## Verification extra

```
dotnet build src/backend/MaterioForge.slnx
node harness/burndown.mjs
```

Burndown staying 882/882 is expected (the lie was runtime). Build 0 warnings 0 errors.

{REPORT}
""",
)

# ---------------------------------------------------------------------------
# S6-49 cleanup
# ---------------------------------------------------------------------------
write(
    "S6-49",
    "Delete mock HTTP clients after ALL GREEN",
    f"""\
Depends-on: S6-48

{STANDING}
{PRECOND}

S6-48 printed ALL GREEN. Only now delete the clients.

## In scope

Remove unused mock HTTP:

- `MockBimStateBridge`, `MockTakeoffStateBridge`, `MockEstimatingStateBridge`
- `MockProjectsStateBridge`, `MockTenderingStateBridge`
- `MockCartStateBridge`, `MockCatalogueStateBridge`, `MockCatalogueAuxStateBridge`, `MockPricingStateBridge`
- `MockWebhookStateBridge`, `MockSidecarClient`
- `SearchService` mock `ForwardAsync` (should already be gone)
- `AgentRunExecutor.GetMockAsync`
- `PlatformOptions.MockBaseUrl`, `src/backend/src/MaterioForge.Api/appsettings.json` `Platform:MockBaseUrl`
- `Platform__MockBaseUrl` in `harness/restart-host-api.sh`
- `AddHttpClient(nameof(Mock*))` / `AddScoped<Mock*>` in module `ModuleRegistration.cs`

`rg MockBaseUrl src/backend harness/restart-host-api.sh` must be empty at the end.

## Out of scope

`prototype/backend/` (S8-02). `IDownstreamTokenMinter` / `MockBridgeTokenMinter` — keep if still used for something other than mock HTTP; delete the mock-only mint path if nothing calls it. Full-suite replay — do not rerun `--reset-between-passes` unless a handler changed behaviour; prefer:

```
dotnet build src/backend/MaterioForge.slnx
node harness/replay.mjs --target http://localhost:8080 --namespace bim
node harness/replay.mjs --target http://localhost:8080 --namespace cart
node harness/replay.mjs --target http://localhost:8080 --namespace search
```

If any of those regress, restore the client and `continue` — do not push a compile-only cleanup.

## Verification

```
rg MockBaseUrl src/backend harness/restart-host-api.sh
rg 'class Mock(Bim|Takeoff|Estimating|Projects|Tendering|Cart|Catalogue|Pricing|Webhook|Sidecar)' src/backend
dotnet build src/backend/MaterioForge.slnx
```

Done: both rgs empty (or only comments that you must not add — there should be no comments). Build green. Sample namespace replays green.

{REPORT}
""",
)

# ---------------------------------------------------------------------------
# S8-01b
# ---------------------------------------------------------------------------
write(
    "S8-01b",
    "One-container deploy, deployed replay, rollback",
    f"""\
Depends-on: S6-48 (local ALL GREEN). S6-49 may be DONE or still TODO; do not deploy a tree that still 500s.

{STANDING}

S8-01 (prompt id 63) stays parked. Do not resume it. Its strangler deletions are already in the working tree. This prompt is only the remainder S8-01 never ran: deploy, deployed replay, rollback.

AWS CLI is absent on the development host. Use repo CI/OIDC (`.github/workflows/deploy.yml`) or a host with AWS tooling. Do not install a one-off AWS CLI as a substitute for the pipeline's OIDC role.

## Already banked (do not redo)

- `infra/30-compute.yaml` task definition is 1 container (api). Mock ECR / log / IAM / env removed.
- Deploy workflow no longer builds or passes a mock digest.
- Local unmatched route is 404 ProblemDetails.
- Local `--target mock` exits 2.

## In scope

1. Deploy the current (locally green) revision to dev.
2. Confirm the running task has **one** container.
3. Replay the catalog suite against the deployed base URL with the same four env vars.
4. Prove rollback to the previous task definition still works.

## Out of scope

Native ports. Deleting `prototype/backend/` (S8-02). Recapturing goldens. Bringing a mock sidecar back.

## Verification

```
# local still green — do not deploy if this is red
node harness/replay.mjs --target http://localhost:8080 --namespace bim
curl -i http://localhost:8080/no/such/route   # 404 ProblemDetails, not 502

# then, on CI/OIDC or an AWS-capable host:
# deploy.yml / CloudFormation change set for 30-compute
# task definition container count == 1
# node harness/replay.mjs --target https://<deployed> --reset-between-passes
# rollback to previous task definition succeeds
```

If AWS credentials are not available, `agent-step blocked` with the exact role/host the operator must provide. Do not deploy a red revision.

{REPORT}
""",
)

print("wrote", len(list(OUT.glob("*.md"))), "prompts")

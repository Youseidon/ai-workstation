# Ordered pipeline prompts — native remainder

Paste each file in `prompts/` as a new work item. Do not resume S8-01 (id 63, UNREPORTED).
Plan: `PLAN.md`. Load: `LOAD.md`.

S6 suite id **7**, S8 suite id **9**. Keys `S6-16`…`S6-49` do not collide with DONE `S6-01`…`S6-15`.

## DAG (ready when depends-on are DONE)

Independent roots (can start in parallel): **S6-16**, **S6-17**, **S6-45**, **S6-47**.

| Order | id | title | depends-on | gate (not the full suite) | snapshot to zero |
|---:|---|---|---|---|---|
| 1 | S6-16 | Dual-write: cart, POST /products, coupons, qa | — | `--namespace cart\|coupons\|qa` + `--route "POST /products"` | 33 cmp / 9 routes `500-internal` |
| 2 | S6-17 | projects reads | — | `--route` each GET | 9 of 19 project routes |
| 3 | S6-18 | projects writes | S6-17 | `--namespace projects` | projects 81 `500-internal` |
| 4 | S6-19 | projectWorkflows | S6-18 | `--namespace projectWorkflows` | 39/26 |
| 5 | S6-20 | workPackages | S6-18 | `--namespace workPackages` | 76/19 |
| 6 | S6-21 | clientDecisions + map savedWork | S6-18 | `--namespace clientDecisions` + `savedWork` | 21/5 + 10/3 |
| 7 | S6-22 | workers, workerPortal, map builderOrg | S6-18 | three `--namespace` | 5+7+7 |
| 8 | S6-23 | work reads | S6-20 | `--route` GETs | 13 of 28 |
| 9 | S6-24 | work writes | S6-23 | `--namespace work` | 100/28 |
| 10 | S6-25 | estimator core | S6-18 | `--route` × 14 | 14 of 50 estimator |
| 11 | S6-26 | estimator ai-runs | S6-25 | `--route` × 14 | 14 of 50 |
| 12 | S6-27 | estimator AI photo/quick | S6-25 | `--route` × 8 | 8 of 50 |
| 13 | S6-28 | assemblies/sections/benchmarks | S6-25 | `--namespace estimator` (only if 25–27 green) | estimator 186/50 |
| 14 | S6-29 | estimationWorkflow reads | S6-25 | `--route` GETs | 13 of 31 |
| 15 | S6-30 | estimationWorkflow writes | S6-29 | `--namespace estimationWorkflow` | 136/31 |
| 16 | S6-31 | estimateLines, costData, decisions, portal | S6-25 | four `--namespace` | 20+27+8+6 |
| 17 | S6-32 | takeoff reads | S6-25 | `--route` GETs | 17 of 79 |
| 18 | S6-33 | takeoff run/line/scale | S6-32 | `--route` | 15 |
| 19 | S6-34 | takeoff match/slip/sheet | S6-32 | `--route` | 11 |
| 20 | S6-35 | takeoff worksheet/export/presence | S6-32 | `--route` | 11 |
| 21 | S6-36 | takeoff quantity | S6-32 | `--route` | 17 + 1 body-only |
| 22 | S6-37 | takeoff DWG + import | S6-32 | `--namespace takeoff` + `takeoffImport` | 317+12 |
| 23 | S6-38 | BIM reads | S6-32 | `--route` GETs | 10 of 28 |
| 24 | S6-39 | BIM writes | S6-38 | `--namespace bim` | 109/28 |
| 25 | S6-40 | tender | S6-25 | `--namespace tender` | 78/18 |
| 26 | S6-41 | quotes (proxy + 9 unmapped) | S6-40 | `--namespace quotes` | 45 (7+38) |
| 27 | S6-42 | search | S6-16 | `--namespace search` | 8/2 |
| 28 | S6-43 | checkout, payments, orders | S6-16 | three `--namespace` | 6+4+8 |
| 29 | S6-44 | finance, invoices schedules, milestones | S6-18 | three `--namespace` | 8+14+18 |
| 30 | S6-45 | pipelines, voice, agents | — | three `--namespace` | 34+17+4 |
| 31 | S6-46 | webhooks, analytics, commercial credit | S6-16 | `--namespace webhooks\|analytics` + two commercial routes | 3+3+2 |
| 32 | S6-47 | recapture two admin 501 goldens | — | `--namespace admin` | 9 `mock-501-to-404` |
| 33 | S6-48 | full `--reset-between-passes` | S6-16…S6-47 | the command at the top of the brief | 1461 → 0 |
| 34 | S6-49 | delete mock clients / MockBaseUrl | S6-48 | `rg MockBaseUrl src/backend` empty + sample `--namespace` | — |
| 35 | S8-01b | deploy, deployed replay, rollback | S6-48 | one-container task + deployed ALL GREEN + rollback | — |

S8-02 (delete `prototype/backend/`) is unchanged and stays after S8-01b.

## Suggested serial pipeline (if the console runs one at a time)

S6-16 → S6-17 → S6-18 → S6-19 → S6-20 → S6-21 → S6-22 → S6-23 → S6-24 → S6-25 → S6-26 → S6-27 → S6-28 → S6-29 → S6-30 → S6-31 → S6-32 → S6-33 → S6-34 → S6-35 → S6-36 → S6-37 → S6-38 → S6-39 → S6-40 → S6-41 → S6-42 → S6-43 → S6-44 → S6-45 → S6-46 → S6-47 → S6-48 → S6-49 → S8-01b

S6-45 and S6-47 can be inserted anywhere before S6-48.

## What each prompt must bank

`agent-step remark --kind PROGRESS` after every verified slice.
Finish with exactly one of `done` / `continue` / `blocked`.
Verification text: the command, compared/passed/failed, and whether MapProxy is gone from owned files.

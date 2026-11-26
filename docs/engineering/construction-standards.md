# Construction standards

| | |
|---|---|
| Status | Baseline specification |
| Audience | Developer |
| Depends on | [Solution architecture](../architecture/solution-architecture.md), [data design](../data/data-design.md), [service contracts](../interfaces/service-contracts.md) |

This is how the repository is required to be built so that the architecture stays true. The day-to-day working agreement for agents editing the tree is [AGENTS.md](../../AGENTS.md). Where this document and that agreement both speak, they say the same thing. A new engineering rule is added here and summarised there.

## 1. Packages

npm workspaces. TypeScript strict, including `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. Node.js 20.10 or newer. ECMAScript modules.

| Package | Name | May import |
|---|---|---|
| `shared/` | `@hydra/shared` | nothing from `server/` or `web/` |
| `server/` | `@hydra/server` | `@hydra/shared` |
| `web/` | the Next.js application | `@hydra/shared`, never the server source, never SQLite |

Local server and shared imports use the `.ts` extension. Web imports use the `@/` alias. Type-only imports use `import type`. An indexed access that might be missing is handled. It is not asserted away.

The public surface of `@hydra/shared` is the explicit export list in `shared/src/index.ts`. A symbol another package needs is exported there. Internal shared modules import each other by path.

## 2. Where a change goes

| Kind of change | Home |
|---|---|
| A wire shape, a stored record shape, a WebSocket message | `shared/src/contracts/` |
| A catalogue, a status rule, a draft validator, usage arithmetic | `shared/src/models/` |
| A policy decision: pipeline transition, station capability, provider failure class | `shared/src/policies/` |
| HTTP or WebSocket transport | `server/src/api/` |
| Boot configuration, settings field table | `server/src/config/` |
| A pure domain rule with no I/O | `server/src/domain/` |
| Process spawn, containment, locks, paths | `server/src/infrastructure/` |
| A provider's stream and its translation | `server/src/providers/adapters/` and `streams/` |
| SQL and migrations | `server/src/repositories/` |
| Orchestration of a use case | `server/src/services/`, in the feature that owns it |
| A screen | `web/features/<feature>/`, with that feature's components, hooks, and helpers together |
| Application chrome | `web/components/` and `web/contexts/` |
| A browser call to the server | `web/api/` |

A helper lives next to the feature that uses it. `utils/` is for a helper with no domain owner. A second copy of a protocol type in `web/` or `server/` is a defect.

Tests mirror the source: `shared/test/`, `server/test/`, `web/test/`. A flow that crosses services is `server/test/integration/`. An architectural constraint that can be checked by reading the source is `server/test/architecture/`.

The web application is Next.js 16. Before writing a Next.js API, the author reads the matching guide under the installed `node_modules/next/dist/docs/` and heeds deprecation notices. `agentRules` stays false so the framework does not write its own instruction file into `web/`.

## 3. How to add a provider

1. Add the id to `PROVIDER_IDS`. One id, stable, lowercase.
2. Add one adapter that implements the agent-adapter interface and yields only the normalised event types.
3. Register it in the provider registry, with its binary name, transport (`sdk` or `spawn`), and whether it reports tokens.
4. Add its settings fields to the field table: enablement, binary, model, reasoning, permission or sandbox mode, and any provider-specific flag. Group them under the provider's name.
5. Add its chip colour in the one place colours are defined.
6. Extend discovery, install, and health only as far as that provider's own mechanism requires.
7. If it spawns a child, the child environment uses the shared scrub list.
8. Tests cover a stream fixture and a refusal path. They do not call the real provider.

No new event type. No provider-specific branch in the web transcript renderer. If the renderer needs a fact, the adapter puts it in the normalised payload.

## 4. How to add a setting

Add a field to the server field table: key, type, group, label, default, and options where the type is an enum. Dangerous values are marked dangerous. The Agents screen renders the field. Persisting a value writes the account's settings file for a non-owner and the installation settings file for the owner. The browser receives a boolean for secret fields.

A setting that must be true before process start, such as the bind address, is a boot variable in the environment, documented in `.env.example`, and is not pretended to be a runtime field.

Defaults in the field table and defaults in `.env.example` agree. Pipeline policy defaults also agree with the default policy object in the shared policy module.

## 5. How to change the schema

1. Read the [data design](../data/data-design.md) section the table belongs to, and update it in the same change.
2. Append the next version inside the migrate transaction in the workspace repository module. Do not edit an older version.
3. Keep the change additive. Record the version only after the statements succeed.
4. If foreign keys must be off for a rebuild, restore them in a `finally` before the version row is inserted.
5. Try the migration on a copy. The sandbox is the specified place. Never point a trial at the live database.
6. Add a repository test that opens a database at version N−1, migrates, and checks the new constraint.

A JSON column still needs a shared validator. A predicate still needs a real column. `dod_result.run_id` stays without a foreign key.

## 6. How to change behaviour

1. Update the specification that owns the rule: business requirement, execution model, or security document.
2. Put the decision in the shared policy or model module when both sides need it, or in a server domain module when only the server needs it.
3. Make the browser render the server's result.
4. Add or update a `node:test` test at the module that owns the rule.
5. If an operator would notice, update the operator manual in the same change.

Comments explain a constraint, an incident, or a failure mode. They do not restate the line above them. They do not say "the spec says" without the spec having been updated.

## 7. Live-system constraints

These are construction constraints, not etiquette.

| Forbidden while developing | Why | Do this instead |
|---|---|---|
| `npm run serve` or `npm run free-ports` against a machine that is doing real work | Both free ports 3000 and 4000 and kill the live console | `npm run dev:sandbox` |
| `npm run dev` on the default database | The watch mode restarts on save and kills live agents, and the command refuses the live database for that reason | Sandbox, or `HYDRA_DB` pointed at a disposable file |
| Opening the live database for write, including a migration trial | Migrations apply on open | Copy, or open read-only |
| Stashing, resetting, or checking out the operator's uncommitted work in order to run a test | Git belongs to the operator | A temporary directory or a fixture repository |
| Printing `.env`, settings JSON, or a token into a test log or a commit | Secrets are plaintext on disk | Assert on "is set" or on a redacted fixture |

Server tests run serially against a temporary database the test script creates. A test that needs a fixture path sets `HYDRA_DB` itself and does not read `$HOME/.local/state/hydra`.

The sandbox copies state to its own directory, uses ports 4100 and 3100, does not auto-resume pipelines, and does not poll Telegram. Workspace paths inside the copy still point at real directories. A test or a manual run started there can edit a real project. Do not start one against an operator's repository to "see if it works".

## 8. Checks before a change is called done

Run, for every package the change touched:

```bash
npm run typecheck
npm test --workspace shared
npm test --workspace server
npm test --workspace web
```

A change to `shared/` touches all three test suites. The root `npm test` stops at the first failing package, so a server failure hides the web result. Run the workspaces separately when that happens, and report failures that were already present as pre-existing.

`npm run lint --workspace web` is required when web source changed.

A change to operator-visible UI is exercised in a browser: the journey that changed, the neighbouring page that shares the state, and the empty and error states of that journey. A screenshot of the first render is not that exercise. When no browser is available, the closest substitute is stated, including what was not verified.

## 9. Brand, instructions, and generated files

Brand assets, including the web icons and `web/components/brand/geometry.ts`, are outputs of `node brand/build.mjs`. Edit the generator and the brand guide. Do not hand-edit an output.

Hydra writes a workspace's stored `CLAUDE.md` and `AGENTS.md` into that workspace before a run. If a workspace is ever pointed at this repository, those stored texts overwrite these files. A workspace bound to this repository keeps its instruction fields empty or identical to the files in the tree.

## 10. Environment variables

Product variables are prefixed `HYDRA_`. Browser storage keys are prefixed `hydra.`.

Boot variables that are not settings, and must stay documented in `.env.example`, include the bind host and port, the allowed origins, the status interval, the secure-cookie flag, and `HYDRA_DB` when an operator relocates state. Provider keys in `.env` are installation-owner defaults. A non-owner account does not inherit them.

Any variable added to point at state, or to authenticate a runtime, is added to the child-environment scrub list in every spawn path named in the security specification, in the same change.

## 11. Error handling

A provider failure, a child crash, or a malformed stream becomes an `error` event and a terminal run state. It does not drop the WebSocket. A precondition failure before a child starts is a `run_rejected` or a pipeline wait reason from the closed vocabulary. It does not create a running row.

Callbacks return a structured refusal with a code. They do not return a stack trace to the agent as the message the operator will read. The operator's sentence comes from the reason catalogue.

Secrets do not appear in those messages.

## 12. Concurrency

The account database is the lock store for pipeline uniqueness, via partial unique indexes, and the application lock store for the workspace writer. Code that starts a run inserts the row first and treats a constraint failure as "already running", not as an unexpected exception to be retried blindly.

Git locking is installation-wide and lives above a single account database, because two account files cannot see each other's rows. A design that enforces the Git lock by a unique index inside one account database is wrong.

Long work does not hold a SQLite transaction across a provider call. The transaction covers the state change. The child runs outside it.

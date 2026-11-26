# Service contracts

| | |
|---|---|
| Status | Baseline specification |
| Audience | Developer, solution architect |
| Depends on | [Solution architecture](../architecture/solution-architecture.md), [execution model](../architecture/execution-model.md) |

The browser, the gateway, the account runtime, and the agent callback are separate programs with separate credentials. This document is the contract between them. Shapes that cross the boundary are TypeScript types in `@hydra/shared`. This document says what those types are required to mean. When a field is added, the shared type and this document change together.

## 1. Common rules

| Rule | Requirement |
|---|---|
| C-01 | Every application route and the WebSocket require an account session, except the auth routes, the health route, and the run-scoped agent callback. |
| C-02 | The gateway authenticates the session and forwards the request to that account's runtime with the gateway credential. The runtime rejects a request without it. |
| C-03 | JSON errors use one body shape: a message a person can read, plus a stable code where the client branches. HTTP status follows the failure: 401 unauthenticated, 403 unauthorised, 404 missing, 409 conflict with a lock or a uniqueness rule, 422 validation. |
| C-04 | Responses never include a provider key, a password, a session token, a bot token, a gateway credential, a run credential, or a database path. Secret settings return an "is set" boolean. |
| C-05 | Identifiers in URLs are the server's ids. Provider session ids are not a public key. |
| C-06 | Writes the operator can undo by intent (apply a draft, complete a work item, stop a pipeline) are explicit requests. A GET does not mutate. |

Health is unauthenticated and returns only liveness. It does not return version details that describe the operator's filesystem.

## 2. HTTP resources

Routes live under `/api`. The families below are the contract. A new route joins a family or justifies a new one in this document.

### 2.1 Session, on the gateway

| Method and path | Behaviour |
|---|---|
| `POST /api/auth/register` | Create an empty account and a session. Rate limited. |
| `POST /api/auth/login` | Create a session. Rate limited. Same failure response for unknown user and bad password. |
| `POST /api/auth/logout` | Revoke the presented session. |
| `GET /api/auth/session` | Return the current account's public identity, or 401. |
| `POST /api/auth/password` | Change password, revoke other sessions. |
| `POST /api/auth/recovery/request` | Send a Telegram recovery code when a link exists. Rate limited. Response does not reveal whether the username exists beyond what the recovery design already allows the sign-in screen to show. |
| `POST /api/auth/recovery/reset` | Consume a valid code and set the password. |
| `GET /api/auth/demo` | Whether demos are offered. |
| `POST /api/auth/demo` | Create a demo account and a session, or refuse when demos are disabled. |
| `GET/POST/PATCH/DELETE /api/auth/telegram…` | Bot registration for the owner, link, access level, unlink, and the audit list. Demo accounts receive 403 on any Telegram mutation. |

The gateway does not serve `/api/agent/*`. A callback that arrives on the public listener is rejected. Callbacks go to the runtime's run-scoped endpoint.

### 2.2 Account runtime

| Family | What it is for |
|---|---|
| `/api/settings` | Read the field table and the account's non-secret values. Patch overrides. Reset removes an override. |
| `/api/providers` | Readiness, models, and the reason a provider is unavailable. Install and update only for the installation owner, and only when the provider has no active run. |
| `/api/providers/usage` | Reported allowance windows. Unknown stays unknown. |
| `/api/workspaces` | List, create, update, and delete workspaces. Directory browsing for the create flow reads the host only through this API, and only inside the operator's request. |
| `/api/workspaces/:id/threads` | Thread list, rename, pin, archive, and history paging. |
| Work-library routes under workspaces, programs, suites, and prompts | CRUD for the hierarchy, dependencies, revisions, skip, and operator complete. |
| `/api/program-drafts` | Read and edit a pending draft. Apply and discard are their own requests. |
| `/api/instruction-proposals` | Read, apply, discard. |
| Prompt-pack import | Inspect returns a preview and writes nothing. Apply consumes that preview in one transaction. |
| `/api/pipelines` | Definition, stages, assignments, flowchart, play, pause, stop, and run history. |
| `/api/definition-of-done` and `/api/statuses` and `/api/triggers` | The done criteria and the catalogue. Locked status flags are rejected if patched. |
| `/api/suites/:id/verification` and `/api/verifications/:id` | Start and read verification. |
| `/api/prompts/:id/execution` | Read the delivery contract, submit a shadow or supervised desire, and approve a new allocation with a reason. |
| `/api/runs/:id/interrupt` | Stop that agent run. |
| `/api/runs/:id/btw` and `/api/runs/:id/messages` | Queue an aside and read delivery state. |
| `/api/runs/:id/changes` and `/api/changes` | Change capsules. |
| `/api/sessions` | Run history. This is not the auth session resource. |
| `/api/operations` | The board snapshot: what is running, what is waiting. |
| `/api/report` | Usage report for a workspace, window, and optional provider. CSV is the same selection. |
| `/api/remote/overview` | The summary Telegram and any other remote surface is allowed to see. It obeys the Telegram payload rule even when the caller is the console. |

Deleting a workspace, program, or suite follows the cascades in the data design. The response is not success if the cascade would break a non-terminal pipeline run; the runtime refuses with a reason that names the running work.

## 3. WebSocket

One socket per console, authenticated as the account, at `/ws`.

### 3.1 Client to server

| `kind` | Meaning |
|---|---|
| `run` | Start an agent run. Names the provider, the workspace, and either free text or a work-item id. `mode` distinguishes a writable turn from a clarification. `role` is the run role. `freshContext` refuses native resume. Optional `threadId`, `resumeSessionId`, `model`, and `clientRequestId`. |
| `interrupt` | Stop the named run. Same effect as the interrupt route. |
| `input_response` | Answers for a pending agent question, keyed by request id. |
| `verify_suite` | Start a suite verification, optionally scoped to one work item. |
| `refresh_providers` | Re-run discovery and push a `providers` message. |
| `ping` | Liveness. The server answers `pong`. |

A `run` that fails a precondition is `run_rejected` with the `clientRequestId`, a message, and optional detail. No `run_started` follows it.

### 3.2 Server to client

| `kind` | Meaning |
|---|---|
| `hello` | On connect. The provider list and a snapshot of each active run, including retained events and `truncated` when the snapshot is shorter than the transcript. |
| `providers` | The provider list changed. |
| `settings_updated` | Settings were saved. Includes the refreshed provider list. |
| `run_started` | A run was accepted. Id, provider, model, workspace summary, source, role. |
| `event` | One normalised event for a run. |
| `run_ended` | Terminal. State is `done`, `interrupted`, or `error`. |
| `run_rejected` | The `run` or `verify_suite` did not start. |
| `operations_changed` | The board changed. The client refetches. The socket does not carry a second copy of the board. |
| `pong` | Reply to `ping`. |

**Decision C-07.** `operations_changed` is a nudge, not a payload. Run transcripts are the exception: they stream as events because the operator is watching that run. Boards, reports, and library trees are fetched over HTTP so the socket does not become a second API.

### 3.3 Run source

`run_started.source` is a tagged object. The tag is one of `custom`, `saved`, `clarification`, `verification`, `consult`, `wrapup`, `audit`, `author`, `instructions`. The client renders from the tag. It does not infer the source by parsing the prompt text.

## 4. Normalised events

An adapter yields only these types. Each event has `id`, `runId`, `provider`, `model`, and `timestamp`.

| Type | Payload required to carry |
|---|---|
| `assistant_text` | `blockId`, `delta`, `text`, and `kind` of `message` or `thinking`. |
| `tool_use` | `toolUseId`, tool `name`, a short `summary`, and the `input`. |
| `tool_result` | `toolUseId`, `name`, `isError`, `summary`, `output`, and `exitCode` when there is one. |
| `status` | Run `state`, server `elapsedMs`, `usage` or null, and a short `detail`. Optional native session id. |
| `result` | Terminal `state`, `elapsedMs`, `usage` or null, optional final `text`, `exitCode`, `stopReason`, optional peak memory. |
| `error` | `message`, `fatal`, and optional `detail`. Detail is the tail the operator needs, not the child's full stderr log. |
| `db_access` | The callback verb, method, outcome `accepted`, `rejected`, or `replayed`, HTTP status, duration, request id, a short summary, changed paths or fields, and an error code when rejected. |

`usage` is the shared token-usage object or null. Zero-filled usage is sent only when the provider reported zeros. Adapters that cannot measure send null.

Run `state` on the wire is `starting`, `running`, `done`, `interrupted`, or `error`. Pipeline states are not overloaded onto this field. They travel in the pipeline resources.

The server may also emit `db_access` itself when it records a callback. That emission is still a normalised event. It is not a provider type.

## 5. Agent callback

The executable the agent is told to run is `agent-step`. It speaks HTTP to the runtime for its own run, presenting the run credential. The verb set is closed.

| Verb | Effect | Refusal the agent must be able to act on |
|---|---|---|
| `context` | Return the brief, station policy, and done criteria. | Unknown run. |
| `state` | Return the work item status, dependencies, and children. | Unknown run. |
| `execution` | Return the delivery contract status the agent is allowed to see. | No contract. |
| `check` | Return inbox and whether a checkpoint is currently required. | Unknown run. |
| `inbox` | Return queued operator asides and mark delivery according to the delivery rules. | Unknown run. |
| `reply` | Record the agent's reply to an aside or a question. | Unknown request id. |
| `remark` | Append a remark. | Empty content. |
| `checkpoint` | Commit this run's work with `--message`. | `checkpoint_message_invalid`. Git failures use the start-refusal sentences. |
| `done` | Accept a finish, if the gate and the checkpoint rule pass. | `git_commit_required`. Unmet blocking criteria. |
| `continue` | Record an explicit continue handoff. | `git_commit_required` when the tree is dirty. |
| `blocked` | Record blocked. | `git_commit_required` when the tree is dirty. |
| `ask` | Create a human question and park. | Malformed question. |
| `decompose` | Create child work items from a file. | `decompose_title_conflict`, `decompose_depth_exceeded`. |
| `plan` | Submit an execution plan for validation and store. | Validation error from the plan rules. Revision conflict. |
| `repair-verify` | Re-execute verification the station is allowed to repair. | Station policy forbids verification. |
| `propose-program`, `propose-suite`, `revise` | Write the pending draft only. | Draft limits exceeded. Wrong role. |

Replays with the same request id return the stored response and emit `db_access` with outcome `replayed`. They do not apply the side effect twice.

`git_commit_required` tells the agent to checkpoint and post again. The runtime does not checkpoint implicitly inside `done`.

Roles restrict verbs. A `consult` run cannot `checkpoint`, `decompose`, or `done` a work item. An `author` run can propose and cannot apply. The apply request exists only on the operator's HTTP API.

## 6. Settings document

The settings resource returns the field table plus the effective value of each field for this account. A patch is a partial object of field keys. Unknown keys are rejected. Values are validated against the field type on the server. The client does not validate alone.

Secret fields accept a string write and thereafter read back as set or unset. An empty write clears the secret where the field allows clearing. The value is not logged.

Reset restores the built-in default for one field or for a named group, as the route specifies, and does not reset a different account.

## 7. Usage report

The report request names the workspace, the window (`7d`, `30d`, or `all`), and an optional provider id. Days are UTC. The response includes recorded usage, the rate table's estimate, which sessions were unpriced, and which sessions had unknown usage. The CSV representation contains the same rows. A text filter the browser applies to a chart is not a parameter the CSV honours unless it was part of the request.

Estimates carry the pricing note from the shared cost model. The note says they are comparisons.

## 8. Compatibility

The six provider ids, the run roles, the pipeline states, the work-item statuses, the event type names, and the callback verbs are a compatibility surface. Renaming one is a specification change, a migration where it is stored, and a client change in one release. The browser and the server are shipped together, so the product does not keep a second legacy protocol alive for an old browser. It does keep stored rows readable. A migration that rewrites a stored status or a stored role maps the old value forward and records the mapping in the data design.

## 9. What this contract refuses to grow

- A provider-specific event type.
- A browser call to a provider's cloud.
- A WebSocket message that carries a secret or a full database row the screen does not render.
- An agent verb that accepts a SQL string, a shell string to be run as Hydra, or a path to the identity registry.
- An unauthenticated read of `/api/report`, `/api/changes`, or `/api/workspaces`, including "just the names".

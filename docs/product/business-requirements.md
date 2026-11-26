# Business requirements

| | |
|---|---|
| Status | Baseline specification |
| Audience | Business analyst, product owner, solution architect |
| Depends on | [Vision and scope](vision-and-scope.md), [domain model](../domain/domain-model.md) |

Requirements use **shall**. Acceptance is the test a reviewer can run without reading the source. Rules that bind every capability are in [Business rules](#7-business-rules). Non-functional requirements are in [section 8](#8-non-functional-requirements).

## 1. Identity and account

**BR-01 Account registration.** The console shall let a person create a local account with a username and a password. No email address is required. Usernames are 3–64 characters and match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$`. Passwords are 12–1024 characters. A newly registered account shall be empty of workspaces, runs, threads, and provider overrides, including when it is the first registration on a machine that already holds an installation database.

**BR-02 Session.** A successful sign-in shall create a session lasting seven days. Signing out shall revoke that session and close its connections. Changing or resetting a password shall revoke the account's other sessions. A running console shall drop those connections within 30 seconds.

**BR-03 Installation owner.** The installation shall have at most one owner. The owner keeps the original application database and the installation settings file. Ownership survives restarts. Registration shall not transfer or claim that database.

**BR-04 Password recovery.** An operator who still has a shell on the host shall be able to set a new password with a local command that prompts twice, does not echo, and does not require the console to be stopped. An account with Telegram connected shall be able to request a one-time recovery code in that private chat. The code expires after 10 minutes, works once, allows five wrong guesses, and shall not be resent more often than once a minute.

**BR-05 Demo account.** When demos are enabled, the sign-in screen shall offer a throwaway account pre-filled with a sample project, conversations, pipelines, and change history. A demo account has no password. Signing out abandons it. It cannot connect Telegram. After the configured lifetime (default 24 hours) the console shall delete the account, its private state, and the sample folder, and shall delete the folder only while the demo ownership marker is still present. `HYDRA_DEMO=0` shall hide the offer and refuse creation.

Acceptance for BR-01–BR-05:

- A second registration sees no workspace that belongs to the first account or to the installation owner.
- A revoked session cannot open an application API or a WebSocket.
- The local reset command changes the password and does not print it.
- After the demo lifetime, the sample directory remains if the marker file has been removed.

## 2. Workspace and instructions

**BR-10 Workspace.** An operator shall create a workspace by naming it and binding an existing directory on the host. The path shall be absolute in spirit: the operator can see the destination. The console shall refuse to keep its own database inside a workspace directory. Until the first workspace exists, the console shall show workspace setup and shall not offer prompts as if a project were selected.

**BR-11 Standing instructions.** A workspace shall store a description and the text of `CLAUDE.md` and `AGENTS.md`. Before a run in that workspace, the console shall write the stored instruction files into the workspace root. Each change to those fields shall be revisioned with an actor and a reason.

**BR-12 Instruction proposals.** An agent may propose a replacement for `CLAUDE.md` or `AGENTS.md`. The proposal stays pending until the operator applies or discards it. A pending proposal shall not silently overwrite the files that the next run will write.

Acceptance:

- Binding a missing directory is rejected with a reason the operator can act on.
- Two workspaces in one account cannot share a directory or a name, ignoring case on the name.
- Applying an instruction proposal is visible in the revision history. Discarding it leaves the stored text unchanged.

## 3. Conversation

**BR-20 Two modes.** From a workspace the operator shall send an **Ask**, which is a read-only consultation, or a **Run**, which may change files. The mode is chosen before send and is part of the run record.

**BR-21 Live view.** While a run is in progress, assistant text, tool calls, and tool results shall appear as they arrive, with elapsed time and whatever usage the provider reported. Closing the browser shall disconnect the view and shall leave the run running. Reconnecting shall show the run, including events that arrived while the view was gone, subject to transcript retention.

**BR-22 Threads.** Custom conversations shall be threads the operator can name, pin, and archive. Thread metadata is account state on the server. Draft text and reading position stay in the browser and are scoped to the account. A compatible follow-up shall resume the provider's native session. Switching provider or mode shall continue from bounded recorded context instead of claiming a native resume that the provider cannot honour.

**BR-23 Aside messages.** The operator shall be able to send a note to a running agent (`/btw`). Providers that can take a live delivery receive it mid-turn. Others receive it at the next sanctioned check-in. Where the product offers it, the operator may interrupt and deliver the note by resuming the session.

**BR-24 Questions from the agent.** When an agent asks a structured question, the console shall collect the operator's answer and return it to that run. Unanswered questions are a waiting state, not a failed run.

Acceptance:

- An Ask does not require a clean Git tree. A saved work-item Run does.
- Stop is an explicit control. Disconnect is not Stop.
- Usage the provider did not report is shown as unknown, including for providers that do not reliably report tokens. The console shall not invent a zero.

## 4. Work library

**BR-30 Hierarchy.** The operator shall organise work as workspace, then program, then suite, then work item. Names are unique within their parent, case-insensitively. Order is explicit. A work item may have child work items. A work item may depend on other work items, never on itself.

**BR-31 External keys.** Programs, suites, and work items may carry a stable external key, unique within the parent, so an import can round-trip without depending on database ids.

**BR-32 Status a person can trust.** Every work item has a status. The meaning of each status, including which statuses satisfy a dependency and which need a person, is the status catalogue in the domain model. The console shall record a status event for every change, with the previous status, the new status, the actor, and a reason.

**BR-33 Remarks and clarifications.** A work item shall accept remarks, and shall record clarification questions and answers as exchanges rather than as overwritten prompt text.

**BR-34 Author a program.** The operator shall be able to ask an agent to draft a program from a brief. The agent reads the project and proposes suites, work items, dependencies, and verification. The proposal remains a draft until the operator reviews it, edits it, and chooses to create the program. The operator may also ask for a pipeline in the same apply. A stopped author run may leave a partial draft that a later run continues. Revise requests further changes against the draft. Apply is the only act that inserts the program into the library.

**BR-35 Import a pack.** The operator shall be able to preview a prompt pack — manifest, suites, prompts, dependencies, and gates — and then apply that preview as one action. Imported Markdown becomes stored content. It is not a live link back to the source files.

**BR-36 Revisions.** Editing a work item's title or content shall append a revision. The operator can see what the text was.

Acceptance:

- Apply of a draft that fails validation does not create a partial program.
- Discarding a draft leaves the library unchanged.
- A dependency cycle is rejected.
- Deleting a program deletes its suites and work items. Runs that must remain understandable keep their history according to the data-design cascade rules.

## 5. Pipeline

**BR-40 Pipeline is a setup, not a copy of the library.** A pipeline belongs to a workspace, selects suites as ordered stages, and stores agent assignments for that setup. Another pipeline may use the same suite with different agents. Assignments resolve in the order work item, then suite, then the pipeline's house default.

**BR-41 Play.** Play shall start a run that walks ready stations in order. The board shall show working, waiting, and finished stations, the conversation, the evidence, and nested sub-steps. Hide-completed changes the view and does not delete work.

**BR-42 Outcomes.** When a station ends, the scheduler shall follow the station rule and the pipeline policy specified in the [execution model](../architecture/execution-model.md). In summary: done and gated work advances; an explicit continue repeats the station on the same tree; an unfinished ending spends the continuation allowance, then a review, then parks; a blocked or human-review wait parks when the rule says wait; a provider failure may fall across to an eligible fallback only when automatic reassignment is on.

**BR-43 Automatic reassignment is off by default.** When the operator enables it, the scheduler shall skip providers whose reported allowance is exhausted or which are cooling, and shall record the handoff. Unknown usage shall not by itself block a provider. If no eligible provider remains, the pipeline waits. The saved primary assignment is not overwritten by a temporary handoff.

**BR-44 Controls.** Pause shall let the current agent finish its step and start nothing new, unless the operator chooses the immediate pause mode. Stop shall end the pipeline run and stop its agent; finished stations stay finished. Force-stop of the agent shall pause on that station so Resume continues it without spending a continuation. A standalone agent shall be stoppable without a pipeline.

**BR-45 Restart.** After a server restart, a pipeline interrupted by that restart within the previous 24 hours shall be resumed by re-queueing its current station on the same working tree. The station shall not be marked done or failed merely because the process disappeared. A pipeline the operator stopped stays stopped. A development sandbox shall not auto-resume copied pipelines.

**BR-46 Human attention.** The console shall collect, in one place, stations and questions that need the operator. A prose request inside an agent message, or the word "wait" alone, shall not park the pipeline. Parking is a rule value or an execution control.

Acceptance:

- Two pipelines in one workspace can assign different providers to the same suite.
- Resume of a parked ordinary station records the operator's decision and grants a fresh unfinished allowance.
- Play on a dirty tree for a saved work item is refused before an agent starts, with a reason that tells the operator to resolve their own changes.
- Waiving a human review does not record that review as passed. Command checks that are required still apply.

## 6. Done, verification, and review

**BR-50 Definition of done.** A work item, suite, program, or workspace may carry a definition of done. Criteria are prose, a shell command, or "children are closed". Command criteria come from a `## Verify` block in the work item, or from structured criteria. Each criterion has an enforcement of block, warn, or off. The default enforcement is block.

**BR-51 Evidence.** The server shall run command criteria itself, with a timeout and an output cap, and shall store the result as runner evidence. An agent's claim and a reviewer's claim are different sources. A declared finish that leaves a blocking criterion unmet shall not move the work item to Done.

**BR-52 Suite verification.** The operator, or a pipeline, shall be able to run a verification over a suite or a single work item and keep the verdict, the per-item checks, and the transcript of that verification.

**BR-53 Completion audit.** A station may be followed by a read-only audit. The verdict is complete, incomplete, or unverifiable. Applying a complete verdict is an explicit recorded act.

**BR-54 Change capsule.** A writable work-item run shall record a base commit. The agent checkpoints with a subject line before a terminal handoff of done, continue, blocked, or decompose. Uncommitted tracked or untracked changes shall prevent that handoff. Budget stops and manual stops receive a short finalisation turn so partial work can be checkpointed. The Changes view shall show base, head, commits, file totals, and patches, and Activity shall link to the same capsule. The operator's pre-existing changes shall not be swept into the agent's commit.

**BR-55 Station capabilities.** A station may declare that it implements or authors scenarios and hands the checks to a named verifier. With the Cursor provider, a protected station additionally requires native sandboxing and command hooks. If that enforcement cannot be verified, the run shall be refused. The same obligation does not claim that an arbitrary program in the repository is safe.

Acceptance:

- A `## Verify` command that exits non-zero leaves the work item short of Done when enforcement is block.
- A checkpoint subject longer than 72 characters, or an empty subject, is rejected.
- A change capsule whose Git history was rewritten is reported as needing the operator, not silently rebased.

## 7. Reporting, fleet, and away-from-desk

**BR-60 Usage report.** For the selected workspace the operator shall see usage over 7 days, 30 days, or all time, optionally filtered by provider. Days are UTC. Sessions group by start date. API estimates apply the configured model-family rates to recorded tokens and are labelled as comparisons. The report shall explain which sessions were not priced. CSV export covers the selected sessions, not the current on-screen text search.

**BR-61 Fleet.** The Agents screen shall show each provider as enabled or not, installed or not, ready or not, and the effective model. An unavailable provider shall show a reason. Detection shall refresh when settings are saved, and open consoles shall receive that update. Only the installation owner may install or update a shared executable through Hydra. A provider with active runs shall not be replaced. Installing does not enable the provider and does not change model policy.

**BR-62 Model ceiling.** The account shall have a model-access ceiling: Free, Efficient, Professional, Frontier, or All models. Higher tiers include lower tiers. The server shall enforce the ceiling on new runs, fallbacks, authors, and reviewers. Unknown or custom model ids require All models. Manual selection and automatic selection are modes. Automatic selection disables manual pickers and does not forget the manual choices, which return when the operator switches back. A global reasoning effort of low, medium, or high may be inherited or overridden per provider, then translated into that provider's own setting.

**BR-63 Budgets and containment.** The operator shall be able to cap spend estimate, wall clock, tool calls, tool output, repeated identical calls, and a single open tool call, and to set memory, swap, and process ceilings where the host can enforce them. Where the host cannot enforce a memory ceiling, the console shall say so. Process-group cancellation remains available.

**BR-64 Telegram.** Telegram is optional. The installation owner registers one bot token. Each account connects with a single-use link that expires after 10 minutes. One Telegram user connects to at most one Hydra account. Connections start as notifications only. Full control is a separate choice and enables confirmed actions: stop, pipeline controls, and answers. The bot speaks only to the linked user in a private chat. Messages carry summaries, states, errors, and questions. They shall not carry transcripts, diffs, or file contents. Action buttons expire after 15 minutes. Only the live console polls. A development sandbox shall leave the copied bot stopped. Replacing or removing the bot disconnects every account chat.

Acceptance:

- A CSV export and the charts agree on the selected window and provider filter.
- A model above the ceiling cannot be started by a direct request, a fallback, or an author run.
- A Telegram message for a failed run is not sent for a run the operator interrupted on purpose.
- Lowering Telegram access disables controls that were already sent.

## 8. Supervised allowance

**BR-70 Finite allowance.** For a single larger requirement the operator may record done criteria and limits: attempts, active time, tokens, and a delivery deadline. The flow starts in shadow mode, which records the decisions it would take. The operator enables the supervisor for a later Play. Unknown token usage consumes the worker's full reservation. Accepted work, recovery history, and recorded usage survive a reviewed new allocation. A new allocation is an operator act with a reason. Resume shall not silently renew an exhausted allowance.

Acceptance:

- In shadow mode the supervisor does not dispatch live work.
- A replan does not reopen a unit the supervisor has already accepted.
- An exhausted allowance parks with the work preserved and a stated reason.

## 9. Business rules

These rules cut across requirements. A feature that needs to break one of them is a change to this section first.

| Id | Rule |
|---|---|
| BRULE-01 | One writable run per workspace, and at most three read-only consultations beside it. |
| BRULE-02 | Accounts share a Git repository lock. Two accounts shall not write the same checkout at the same time. |
| BRULE-03 | Saved work-item runs require a clean Git working tree, a repository, and at least one commit. Consultations may run on a dirty tree. |
| BRULE-04 | The default unfinished allowance is four continuations, then one read-only review, then park at continuations exhausted. |
| BRULE-05 | Automatic provider reassignment is off unless the operator turns it on for that pipeline. |
| BRULE-06 | The browser learns whether a secret is set. It never receives the secret's value. |
| BRULE-07 | Provider executables and CLI logins are host-level. New accounts do not inherit the owner's saved provider keys or `.env` provider settings. |
| BRULE-08 | Agent children shall not receive `HYDRA_DB`, `HYDRA_DATA_DIR`, `HYDRA_DATABASE_PATH`, or `HYDRA_WORKER_SECRET`. |
| BRULE-09 | Schema changes are new additive migration versions. An applied version is immutable. |
| BRULE-10 | The console shall not create, drop, or rewrite the operator's Git history except through an agent checkpoint of that run's own work. |
| BRULE-11 | Cost estimates are comparisons. The report shall not present them as the provider's invoice. |
| BRULE-12 | A pipeline the operator stopped is not resumed by a process restart. |

## 10. Non-functional requirements

| Id | Requirement |
|---|---|
| NFR-01 | The console is a local Node.js process and a local web process. There is no separate database server. State is SQLite. |
| NFR-02 | Application APIs and WebSockets require an authenticated account. Authentication and recovery routes are rate limited. |
| NFR-03 | Session cookies are HttpOnly and SameSite=Strict. Session tokens are stored only as hashes. Passwords are stored only as salted scrypt hashes. |
| NFR-04 | State files and settings files are created with mode `0600`. That mode is a control against other OS users. It is not a control against an agent running as the same OS user. |
| NFR-05 | Events are forwarded as the provider yields them. The server shall not buffer a whole run before the browser may see it. |
| NFR-06 | The server emits a status heartbeat on a configured interval so elapsed time is a server clock. |
| NFR-07 | Transcript retention defaults to 4,000 events per run and 30 days, always keeping the last 200 events of a run. Retention deletes events. It does not delete the run, its remarks, its status history, or its commands. |
| NFR-08 | The live console binds the loopback host by default, with an explicit allowed-origin list for the browser. |
| NFR-09 | A single live console owns ports 3000 and 4000. A second serve shall not be the way to restart a busy console. Development uses a sandbox on other ports and on a copy of state. |
| NFR-10 | Private account runtimes reject application traffic that does not carry the gateway credential. Agent callbacks use a separate run-scoped credential. |
| NFR-11 | Supported runtime is Node.js 20.10 or newer. The Copilot installer requires Node.js 22 or newer. Git is required for any workspace whose work items will run. |
| NFR-12 | Settings changes apply to the next run and do not require a process restart. |

## 11. Trace to journeys

| Requirements | Journey |
|---|---|
| BR-01, BR-10, BR-20, BR-21, BR-61 | [JR-01 First task](journeys.md#jr-01-first-task), [JR-02 Connect a provider](journeys.md#jr-02-connect-a-provider) |
| BR-30–BR-36, BR-40–BR-46 | [JR-03 Author a program](journeys.md#jr-03-author-a-program), [JR-04 Import a pack](journeys.md#jr-04-import-a-pack), [JR-09 Parked pipeline](journeys.md#jr-09-a-parked-pipeline) |
| BR-50–BR-55 | [JR-06 Review the change](journeys.md#jr-06-review-the-change) |
| BR-02, BR-04, BR-64 | [JR-05 Away from the desk](journeys.md#jr-05-away-from-the-desk), [JR-08 Forgotten password](journeys.md#jr-08-forgotten-password) |
| BR-01, BR-03, BRULE-07 | [JR-07 Second account](journeys.md#jr-07-second-account) |
| BR-70 | [JR-10 Supervised allowance](journeys.md#jr-10-supervised-allowance) |
| BR-20, BRULE-01 | [JR-11 Ask while a writer runs](journeys.md#jr-11-ask-while-a-writer-runs) |
| BR-05 | [JR-12 Demo](journeys.md#jr-12-demo-and-tour) |

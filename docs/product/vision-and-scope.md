# Vision and scope

| | |
|---|---|
| Status | Baseline specification |
| Audience | Product owner, business analyst, solution architect |
| Depends on | — |

## 1. Problem

A person who uses local coding agents already has the agents. What they do not have is one place that holds the work.

Each agent has its own terminal, its own session, its own way of saying it is finished, and no shared memory of the plan. The operator switches tabs to see whether anything is still running, cannot line the agents up to take turns, and cannot point at a commit and say which instruction produced it. On a machine used by more than one login, those transcripts and settings fall into one pile.

Hydra exists to be that place. It does not replace the agents, and it does not sell model access.

## 2. Product statement

Hydra is a self-hosted web console for six local coding agents: Claude Code, Codex CLI, Cursor CLI, Grok CLI, GitHub Copilot, and Kilo Code.

The operator points it at a project directory on the same machine, picks an agent, and gives it work. The browser shows the work as it happens. The operator may also store a library of programs, suites, and work items, assign agents, and let a pipeline run until it finishes or until it needs a person.

One working provider is a complete product. Six providers are the full fleet, not a requirement to start.

**Decision V-1.** The browser is a dashboard. The agents run on the host, in real directories, with the operator's existing provider logins or API keys. Hydra shall not proxy model traffic through a hosted Hydra service, and shall not embed a model of its own.

## 3. Who it is for

| Person | What they need from Hydra |
|---|---|
| Operator | One console for conversations, pipelines, diffs, and the bill-shaped numbers. |
| Second operator on the same machine | A separate login whose workspaces, runs, chat, and settings are not the first operator's. |
| Author of a plan | A way to ask an agent for a program, then edit the proposal before anything enters the library. |
| Person who has stepped away | A private Telegram chat that says when a pipeline is waiting, without shipping the transcript off the machine. |

Hydra is specified for trusted users of one machine. See [security and tenancy](../architecture/security-and-tenancy.md) for the isolation that statement does and does not include.

## 4. Principles

These are product rules. Architecture decisions in later documents exist to keep them.

1. **The operator owns Git.** Hydra shall not stash, reset, or commit the operator's pre-existing changes. Agent work is committed only through the sanctioned checkpoint.
2. **The server owns run truth.** Run identity, the elapsed clock, token usage, and terminal state are server facts. The browser renders them.
3. **Show the work as it happens.** Text, tool calls, and results stream to the open console. Closing the browser does not stop the run.
4. **A failure is a visible event.** A crashed child, a malformed stream, or a provider error is recorded and shown. It is not a dropped connection with an empty thread.
5. **Finished means the gate passed.** An agent declaring done does not close a work item while a required check is unmet.
6. **Accounts separate records.** A new account starts empty. It does not inherit another account's library, runs, or saved keys.
7. **Providers stay interchangeable at the console.** Adding or replacing an agent does not create a second product.
8. **Settings are data.** The Agents screen is a rendering of the server's field table. A new knob is a new field, not a new form invented in the browser.
9. **The library changes by review.** An authored program or an imported prompt pack is a proposal until the operator applies it.
10. **One writer at a time in a checkout.** A workspace has a single writable run. Read-only consultations may run beside it, up to a fixed small limit.

## 5. In scope

- Local accounts, sessions, password change, and local or Telegram password recovery.
- A workspace bound to an existing host directory, with standing instructions the console writes before a run.
- Named conversations: ask (read-only) and run (may edit), with pin, archive, and resume.
- A work library: workspace, program, suite, work item, dependencies, gates, and revisions.
- Pipelines: saved assignments, play, pause, stop, resume, fallback, and restart after a process restart.
- Definition of done, suite verification, and completion audit.
- Per-run change review: base, head, commits, and diffs.
- Usage reporting and cost estimates that say what they do not know.
- Provider discovery, install where supported, enablement, model policy, and budgets.
- Optional Telegram notification, and a separately enabled control mode.
- A throwaway demo account and a first-run tour.
- An optional supervised allowance for one larger requirement, with a shadow mode before it may act.

## 6. Out of scope

The following are product boundaries. They are not gaps to be closed by an enthusiastic implementation.

| Boundary | What that means for a request |
|---|---|
| Not a hosted multi-tenant service | No organisation hierarchy, no billing of operators, no Hydra-operated model gateway. |
| Not a model provider | Hydra shall not supply subscriptions, credits, or a fallback model when every configured provider is exhausted. |
| Not a project factory | Creating a workspace binds an existing directory. Hydra does not clone or scaffold the operator's repository. The demo's sample project is the exception, and it is marked so it can be removed. |
| Not an operating-system boundary | Separate accounts do not imply separate OS users, separate provider logins, or separate filesystems. |
| Not a general CI system | Verification commands are evidence for a work item or suite. Hydra is not a build farm, a merge queue, or a pull-request host. |
| Not an IDE | The console inspects diffs. Editing the product source is the agent's or the operator's job, in the workspace. |
| Not an invoice | Cost figures are estimates from recorded tokens and a rate table. Unknown usage stays unknown. A reported zero stays zero. |
| Not a guarantee that repository code is safe to execute | Permissions, sandboxes, hooks, and station capabilities are controls. They do not make an arbitrary program in the workspace safe. |

## 7. Success measures

The product is meeting its purpose when an operator can do all of the following on one machine, with one provider connected:

1. Create an account, bind a workspace, ask a question, and watch the answer stream, without opening that provider's own terminal.
2. Run a changing task and afterwards open the commits that belong to that run, while their own uncommitted work is still theirs.
3. Store a program, assign agents, press Play, leave, and return to a pipeline that has either advanced, paused for a stated reason, or is still running.
4. See a usage report in which sessions the provider did not measure are visibly unmeasured.
5. Register a second account and find it empty of the first account's workspaces, threads, and keys.

Secondary measures, once the core is in place:

- A question asked while the operator is away is answerable from the linked Telegram chat when full control is on, and is notified when it is off.
- A supervised requirement can be watched in shadow mode before the supervisor is allowed to spend its allowance.

## 8. Capability dependency order

The product is specified in this order. A later capability assumes the earlier ones. An implementation plan may parallelise inside a slice. It shall not ship a later slice that breaks an earlier promise, in particular Git ownership, account emptiness, and "finished means the gate passed".

| Order | Capability | Depends on |
|---|---|---|
| 1 | Account, session, one workspace, one streaming conversation, one provider | — |
| 2 | Ask beside a writer; workspace writer lock; Git left untouched | 1 |
| 3 | Work library: program, suite, work item, dependency | 1 |
| 4 | Saved-task run, checkpoint, change capsule | 2, 3 |
| 5 | Pipeline assignment, play, pause, stop, resume, restart | 4 |
| 6 | Definition of done and verification evidence | 4, 5 |
| 7 | Usage report | 1 |
| 8 | Second account, private database, private settings | 1 |
| 9 | Provider install, model ceiling, budgets, containment | 1 |
| 10 | Program authoring and prompt-pack import, both draft-then-apply | 3 |
| 11 | Telegram notify, then Telegram control | 5, 8 |
| 12 | Supervised execution allowance, shadow before live | 5, 6 |
| 13 | Demo account and guided tour | 1–6 as a readable sample, not as a shortcut past them |

## 9. Names the product uses

Use the language in the [domain model](../domain/domain-model.md). In particular, a stored task is a **work item** (persisted as a prompt), a **pipeline** is an execution setup over suites, and a **station** is a work item inside a running pipeline. Do not introduce a parallel vocabulary in the interface or in a new specification.

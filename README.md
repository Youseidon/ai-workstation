# Hydra

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/hydra-lockup-dark.svg">
  <img src="brand/logo/hydra-lockup-daylight.svg" alt="Hydra — Many heads. One console." width="360">
</picture>

**Six coding agents. One browser. Considerably fewer terminal tabs.**

Hydra is a self-hosted control room for **Claude Code, Codex CLI, Cursor CLI,
Grok CLI, GitHub Copilot, and Kilo Code**. Point it at a project, pick an agent,
and give it something useful to do. Watch the work arrive live, inspect the
changes, or line up a whole pipeline and let the agents take turns.

It runs on your machine, uses your provider logins or API keys, and works in
real directories. The browser is the dashboard; the local agents do the work.
Yes, they can edit actual files. Choose their workspace accordingly.

![A six-headed mechanical Hydra tending code, checks and plans at one shared desk](docs/assets/hydra-workshop.png)

*Six heads, one desk. Someone still has to make the coffee. Illustration generated
for this README; the actual console has fewer dragons.*

[Get running](#get-running) · [Your first task](#your-first-task) ·
[Build a pipeline](#build-a-pipeline) · [Configuration](#configuration) ·
[Troubleshooting](#when-something-gets-weird) · [Development](#development)

## What you can do with it

- **Have a coding conversation.** Ask a question, run a task, change providers,
  and keep named, pinned or archived threads for later.
- **Watch the work happen.** Text streams in as it arrives, with expandable tool
  calls, results, elapsed time and whatever usage the provider actually reports.
- **Build a reusable work library.** Organise projects into programs, suites and
  saved prompts, complete with dependencies and verification criteria.
- **Turn a plan into a pipeline.** Assign agents to suites or individual steps,
  follow progress, continue unfinished work, and deal with questions in one place.
- **Ask an agent to write the plan.** Review and edit its proposed program before
  adding anything to your library.
- **Review what changed.** Browse per-run commits and unified or side-by-side
  diffs, with links back to the work that produced them.
- **Keep an eye on the bill-shaped things.** Check provider allowances, recorded
  tokens, API cost estimates and CSV exports. Estimates are useful comparisons,
  not invoices.
- **Step away from the desk.** Optional Telegram notifications tell you when work
  needs attention; separately enabled controls let you act from your phone.

You only need **one** working provider. Collecting all six is optional.

## Get running

### Bring these

- **Node.js 20.10 or newer**, with npm. Some provider CLIs need more;
  Hydra’s Copilot installer requires Node.js 22 or newer.
- **Git**, and an existing project directory for the agents to work in.
- **A provider account or API key** for at least one supported agent. Hydra
  does not supply model access or replace the provider’s subscription.

The UI is a Next.js app, the backend is Node.js, and the data lives in SQLite.
There is no separate database service to install.

### Install and start

Clone or download this repository, open a terminal in its root, then run:

```bash
npm install
cp .env.example .env
npm run serve
```

Already have a `.env`? Keep it; the copy command above is for a fresh install.

Open **[http://localhost:3000](http://localhost:3000)** and create a local account
on the sign-in screen, or sign in to your existing one. Usernames are 3–64
characters; passwords need at least 12. No email address is required.

The backend defaults to `http://127.0.0.1:4000`, with application endpoints under
`/api` and the live WebSocket at `/ws`.

**Use `serve` for real work.** It builds the app and runs without file watching.
It also frees ports **3000 and 4000**, stopping anything already listening there.
Do not run it again over a busy live console. For work on Hydra itself, use the
[development sandbox](#development).

### Connect an agent

Open **Agents → Configuration**. Each provider shows whether it is enabled,
installed and ready, along with its effective model.

1. If its executable is missing, use **Install** where available. Only the
   installation owner can install or update shared executables through Hydra.
   Other users can ask that owner or install the CLI on the host themselves.
2. Follow the connection instructions. CLI login commands must run on the
   **machine hosting Hydra**; being signed in to a vendor website is not enough.
3. Save a supported API key in the provider settings, or finish the provider’s
   CLI login. Then refresh detection and enable the provider you want to use.

| Agent | How Hydra runs it | Connect on the Hydra machine |
|---|---|---|
| Claude Code | The bundled Claude Agent SDK | An existing `claude` login, or `ANTHROPIC_API_KEY` |
| Codex CLI | `codex app-server` over stdio | `codex login --device-auth`, or `OPENAI_API_KEY` |
| Cursor CLI | The `cursor-agent` executable | `cursor-agent login` |
| Grok CLI | The `grok` executable | `grok login --device-auth`, or `XAI_API_KEY` |
| GitHub Copilot | The `copilot` executable | `copilot login`, a supported GitHub token, or a Copilot-enabled `gh` login |
| Kilo Code | A local `kilo serve` process | `kilo auth login` |

API-key names above also identify the corresponding environment variables.
For a newly registered Hydra account, save keys in that account’s **Agents**
settings: new accounts use built-in defaults and their own overrides rather
than inheriting the installation owner’s `.env` provider settings or saved keys.
Local CLI logins and executables are still shared at the OS-user level.

Hydra checks `PATH` first and also finds CLIs installed through its setup flow.
An explicit custom **Binary** setting takes precedence over fallback discovery.
Unavailable providers show a reason instead of leaving you to guess.

<details>
<summary>Where installers put things, and what updates do</summary>

The setup flow shows its fixed provider source before installation. npm-based
CLIs go under `$XDG_DATA_HOME/hydra-cli/<provider>` (normally
`~/.local/share/hydra-cli/<provider>`), separate from this checkout’s dependencies.
Claude’s SDK is managed as a project dependency. Cursor and Grok use their
configured official platform installers, which may update your shell’s PATH.

Install and Update affect the host machine. A provider with active runs cannot
be replaced. Installing it does not automatically enable it or change your model
policy. Closing the setup dialog does not cancel an installation in progress.

</details>

## Your first task

Start small. “Explain this project” is a better first date than “rewrite our
entire billing system before lunch.”

1. Open **Workspaces** and create a workspace pointing at an **existing directory
   on the Hydra machine**. An absolute path makes the destination obvious.
2. Select that workspace in the sidebar and open **Chat**.
3. Choose an available provider and model in the composer.
4. Select **Ask** for a read-only consultation, or **Run** to make changes.
5. Send your prompt, watch the stream, and inspect the outcome.

Until you create your first workspace, Hydra shows workspace setup on every page.
Prompts and other app controls become available once a workspace is saved.

For an **Ask**, try:

```text
Give me a guided tour of this repository. Where does the app start,
what are its main moving parts, and how do I run its checks?
```

For a **Run**, try something with a clear finish line:

```text
Improve the empty state on the projects page. Explain what a new user
should do next, keep the existing visual style, and run the relevant checks.
```

One workspace allows **one writable run and up to three read-only consults** at
a time. Open another conversation for research while the writer is busy.
Accounts also share a Git repository lock, so two accounts cannot write to the
same checkout simultaneously.

Saved work-item runs require a clean Git working tree. Commit or otherwise
resolve your own changes before starting one; read-only consults can still run
against a dirty repository. Hydra never stashes or resets your work for you.

### A few useful tricks

- Type **`@`** in the composer to find a provider or model. Arrow keys navigate;
  Enter or Tab selects. The selection token is removed before the prompt is sent.
- Use **`/btw`** to add a note to a running agent. Providers with live delivery
  receive it mid-turn; others read it at their next `agent-step` check-in. Where
  offered, **Interrupt & deliver now** resumes the session with your note.
- Name and pin threads you want to keep handy; archive the ones you are done with.
  Thread metadata is saved on the server. Drafts and reading positions stay in
  that browser, scoped to your account.
- Compatible follow-ups resume the provider’s native session. Switching provider
  or mode uses bounded recorded conversation context instead.
- Closing the browser disconnects the view; the server keeps the run. Reconnect
  to inspect it. Use the **Stop** control when you actually want work to stop.

## Find your way around

The sidebar keeps the current workspace, section navigation and that section’s
records together. Details open in a shared drawer, so inspecting one step does
not mean abandoning the whole board.

| Page | What lives there |
|---|---|
| **Chat** | Conversations, custom tasks and read-only questions |
| **Pipeline** | Pipeline directory, execution board, assignments and waiting work |
| **Activity** | Run history and the sessions behind it |
| **Changes** | Per-run change capsules, commits and file diffs |
| **Report** | Usage, API estimates, provider breakdowns and CSV export |
| **Agents** | Live fleet, provider setup, model policy and shared settings |
| **Workspaces** | Project directories, instructions, programs, suites and prompts |
| **Account** | Password changes, Telegram connection and recent Telegram activity |

The **Stop** button in the top rail is available across the app. Other stop and
pause buttons open the same control centre. No hunt-the-emergency-button game.

## Build a pipeline

A good pipeline is a plan with sensible handoffs. Here is Hydra’s vocabulary:

```text
Workspace                     an existing project directory
└── Program                   an outcome you want to deliver
    ├── Suite                 a related batch of work
    │   ├── Prompt / work item  one task, with its own checks
    │   └── Prompt / work item
    └── Suite

Pipeline                      a saved execution setup selecting suites,
                              ordering work and assigning agents
Station / step                a work item in that execution flow
```

For example: a **“Make onboarding less confusing”** program could have suites
for the first-run screen, sample data and verification. Each suite contains
small, concrete work items. You could assign one agent to implementation and
another to the review suite.

### Make the plan

Create programs, suites and prompts in **Workspaces**, or ask an agent to draft
a program from your brief. The author reads the project and proposes suites,
work items, dependencies and verification blocks.

The proposal stays in a draft until you review it. Rename things, rewrite weak
instructions, reorder work and fix dependencies, then choose **Create program**.
You can also tick **and a pipeline to run it**. A stopped author run can leave a
partial draft that a later run continues; **Revise** lets you request changes.

The library is protected by that draft-and-apply step. The author itself has
write permissions and holds the workspace writer lock; its instruction to leave
the project unchanged is a brief, not a read-only sandbox.

Already have a prompt pack on disk? The workspace import API supports an
**inspect → apply** flow. It previews the manifest, suites, prompts, dependencies
and gates before applying them together. Imported Markdown becomes stored
content; it is not a live link to the source files.

### Give “done” something to stand on

Saved prompts can include a **`## Verify`** block. Shell commands in that block
become definition-of-done criteria. For example, in this repository:

````markdown
Improve the shared validator and cover the edge case that caused the failure.

## Verify
```bash
npm test --workspace shared
npm run typecheck
```
````

Pick checks that prove the requested behaviour. “The agent sounded confident”
is not one of them. The server records verification evidence and completion
checks; a declared finish still has to satisfy the applicable gate.

Work items may also have structured station capabilities, including deferred
verification. Those stations implement or author scenarios and hand the checks
to a designated verifier. With Cursor, protected stations additionally use
native sandboxing and command hooks; a run is refused if enforcement cannot be
verified. These controls do not make arbitrary repository programs safe.

### Assign agents and press Play

Create a pipeline, give it a name, and select its suites. In **Studio → Suite
agents**, choose the provider and model for each suite. Prompts and new sub-steps
inherit that choice; **Prompt overrides** handles exceptions. Assignments belong
to that pipeline, so another pipeline can use the same suite differently.

Review the house rules and budgets, save, then **Play**. The board shows ordered
steps, working and waiting states, conversations, evidence and nested sub-steps.
**Needs you** opens the work waiting for your attention. **Hide completed** clears
visual space without removing completed work.

### What happens when a step finishes?

For ordinary pipeline steps, the scheduler follows this general pattern:

| Outcome | What happens next |
|---|---|
| **Done**, with required checks satisfied | Advance to the next ready step |
| **Continue**, with an explicit handoff | Run the same station again on the same working tree; productive continuation does not spend the unfinished allowance |
| Budget stop, crash, missing report or failed verification | Continue within the unfinished allowance, then review and park if still unresolved |
| Provider cannot run or hits a limit | Try a fallback if enabled and eligible; otherwise wait for the operator |
| **Blocked** or a human-review request | Pipeline policy may waive and continue; passing command checks still matter, and waived human review is not recorded as passed |

The default unfinished allowance is **four continuations**, followed by one
read-only review before parking at `continuations_exhausted`. Resuming a parked
ordinary station records your decision and grants a fresh unfinished allowance.
Step rules expose `onDone` (`continue`, `stop`, `skip_rest`) and `onUnfinished`
(`continue`, `skip`, `wait`). A prose request to stop for human review, or the
`wait` value alone, does **not** guarantee that the pipeline parks. Use the
execution controls when you need it to stop.

**Automatically reassign agents** is off by default. When enabled, Hydra checks
reported allowance windows, skips exhausted or cooling providers and uses the
prompt → suite → house fallback order. The primary assignment stays saved and
the handoff appears in history. Unknown usage does not block a run; if no
eligible provider is available, the pipeline waits.

### Optional: a finite allowance for a bigger requirement

The **Autonomous execution** panel can capture a requirement and its done
criteria with limits for attempts, active time, tokens and a delivery deadline.
Start in **shadow mode** to record proposed decisions, then enable the supervisor
for the next safe Play.

The supervised flow tracks work units, accepted work, recovery decisions and
deferred verification separately. Its execution contract governs the allowance;
it is not simply an unlimited series of ordinary continuations. Unknown token
usage consumes the worker’s full reservation. If more allowance is needed,
**Review new allocation** lets you approve cumulative limits with a reason while
preserving recorded usage, accepted work and recovery history.

### Pause, stop, restart

| Control | Effect |
|---|---|
| **Pause** | Let the current agent finish its step, then start nothing new |
| **Force stop agent** | Stop the current agent and pause on that step; Resume continues it without spending an unfinished-continuation allowance |
| **Stop pipeline** | End the pipeline run and stop its agent; finished steps stay finished |
| **Stop agent** | Stop a standalone live agent |

On a server restart, `serve` normally resumes pipelines interrupted by a
restart within the previous **24 hours**, re-queuing their current station on
the same working tree. It does not mark that station done or failed just because
the process disappeared. A pipeline you explicitly stopped stays stopped.

`pipeline.onRestart` controls ordinary restart behaviour; supervised work also
retains its recorded execution intent. The development sandbox never
automatically resumes copied pipelines.

### Review the actual work

Writable work-item runs record a base commit. Agents checkpoint their work with
`agent-step checkpoint` before posting a terminal handoff such as done, continue,
blocked or decompose. Uncommitted tracked or untracked changes prevent that post.
Budget and manual stops get a short finalisation turn to checkpoint partial work.

Open **Changes** for the resulting change capsule: base and head commits, commit
list, file totals, and patches. Activity and work-item sessions link to the same
review. The operator’s pre-existing changes remain the operator’s responsibility;
Hydra does not sweep them into an agent commit.

## Configuration

You can leave most knobs alone initially. Connect a provider, choose sensible
permissions, and work out your preferred model before tuning the entire engine.

### What goes where

| Place | Use it for |
|---|---|
| Root **`.env`** | Boot-time network configuration and installation-owner defaults; start from [`.env.example`](.env.example) |
| **Agents → Configuration** | Provider credentials, defaults, permissions, models, budgets, containment, pipeline policy and retention |
| **Workspace settings** | Project path, standing instructions and stored `CLAUDE.md` / `AGENTS.md` content |
| **Account** | Password and Telegram settings |

Click your name above **Account settings** at the bottom of the sidebar to open
your account page.

Saved settings override defaults and apply to the **next run** without a
restart. Provider detection refreshes on save and open tabs receive the update.
The owner’s overrides live in `.hydra/settings.json`; other accounts have their
own settings files and built-in defaults. Reset removes an override. Unsaved
Agents-page drafts survive closing an editor while that page remains open.

Keys are write-only in the UI: the browser sees whether one is set, never its
saved value. Settings files use mode `0600`, but saved keys are **plaintext on
disk**. Prefer the provider’s own login if you do not want keys in that file.

### Models without a scavenger hunt

Choose a model in the composer, through an `@` mention, or in the pipeline’s
assignments. Provider defaults are the fallback for unpinned choices.

The account-wide **Model access** ceiling is **Free**, **Efficient**,
**Professional**, **Frontier**, or **All models**. Higher tiers include lower
tiers, and the server enforces the ceiling across new runs, fallbacks, authors
and reviewers. Unknown/custom model IDs require **All models**.

**Manual** keeps your model choices. **Auto Select** chooses within the access
tier and disables manual pickers; saved manual choices return when you switch
back. Global **Low / Medium / High** reasoning effort can be inherited or
overridden per provider, then translated into that provider’s native setting.

Model lists refresh from providers where supported, with the bundled catalog as
an offline fallback. Copilot keeps its stable `auto` route; explicit IDs can be
entered through the custom-model field when policy allows them.

### Permissions: choose the size of the keys you hand over

Each provider has its own permission system. Hydra shows the effective mode;
the same-looking task can have different machine access with a different agent.

| Provider | Shipped default | Practical meaning |
|---|---|---|
| Claude | `acceptEdits` | File edits are pre-approved; commands follow Claude’s rules |
| Codex | `workspace-write` | Workspace writes with restricted network access |
| Cursor | `CURSOR_FORCE=true` | Skip approval prompts unless denied; protected stations add sandbox and hook restrictions |
| Grok | `acceptEdits` + `workspace` sandbox | Pre-approved edits within its configured sandbox |
| Copilot | `allow-all-tools` | Headless tool approval; default file access is scoped, but shell commands run with your OS user’s access |
| Kilo | `KILOCODE_AUTO_APPROVE=true` | Approve permissions not explicitly denied by Kilo’s config; consults use its read-only plan agent |

**Host access (Docker)**, controlled by `AGENT_HOST_ACCESS`, defaults to `false`.
Enabling it selects broad provider access modes for Docker and other host
services. The OS user still needs permission to use those services. Cursor’s
protected station restrictions remain in place.

Headless agents cannot display an interactive approval dialog in your terminal.
Choose modes that suit unattended execution; a provider waiting on an invisible
permission prompt makes for a very quiet dashboard.

### Budgets and resource limits

The shipped defaults give each run **90 minutes**, **1,000 tool calls** and a
**$100 API-estimate spend ceiling**. There are also controls for tool output,
no-progress loops and an open tool call that never returns (15 minutes by
default). Spend enforcement depends on reported usage and available pricing;
it is not a provider billing cap.

On Linux with a working **user systemd manager**, each run gets a transient
service/cgroup covering its descendant processes. Defaults are **3 GiB memory
pressure**, **4 GiB hard memory**, **512 MiB swap** and **512 tasks**. Tune these
on Agents or through the `RUN_MEMORY_*` and `RUN_TASKS_MAX` variables.

Without user systemd, POSIX falls back to process-group cancellation; Windows
can signal the provider process only. Those fallbacks do **not** enforce aggregate
memory, swap or task limits. On WSL, `systemctl --user show-environment` must work
for cgroup containment.

### Workspace instructions

Standing instructions give every task the same project context. Non-empty
stored `CLAUDE.md` and `AGENTS.md` fields are written to the workspace root
before a run; empty fields leave existing files alone. Agent changes to these
instructions become proposals you can review.

If your repository already maintains instruction files, keep the stored fields
empty or identical to those files. Otherwise a stored version can overwrite
your repository’s version at the next run.

### Network settings

These values are boot-time settings; restart after changing them:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Backend bind address |
| `PORT` | `4000` | Backend port |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Exact browser origins allowed to access the app |
| `NEXT_PUBLIC_AGENT_SERVER_URL` | `http://127.0.0.1:4000` | Backend address used by the browser; rebuild for a changed frontend value |
| `HYDRA_SECURE_COOKIES` | `0` | Set to `1` when serving through HTTPS |

For local use, stick with one loopback hostname; the browser client aligns
`localhost` and `127.0.0.1` aliases. Remote use needs an address the browser can
reach, the correct allowed origin, HTTPS and Secure cookies. Keep loopback as
the default for a machine you are using locally.

## Accounts, data and backups

Every account has its own workspaces, programs, runs, chat metadata and settings,
served by a separate backend runtime. Newly registered accounts always start
empty, even when they are the first registration in an empty identity registry.
Registration does not claim the installation’s original database.

An existing installation owner keeps the original data and settings; ownership
is recorded in the identity registry and survives restarts. Browser drafts and
preferences are account-scoped. Sessions last seven days, and signing out revokes
the session and closes its connections.

By default, state lives **outside the repository**:

```text
~/.local/state/hydra/
├── hydra.sqlite                         original installation database
├── hydra.sqlite.identities.sqlite       accounts, sessions and Telegram setup
└── hydra.sqlite.users/
    └── <account-id>/
        ├── hydra.sqlite                 that account’s app data
        └── settings.json                that account’s overrides

<checkout>/.hydra/settings.json           installation owner’s overrides
```

`XDG_STATE_HOME` changes the default state root; `HYDRA_DB` selects a database
path explicitly. The identity registry and account directories sit alongside
that selected path. `SETTINGS_FILE` can override the owner’s settings path.
Hydra refuses a database path inside a configured workspace: an agent’s writable
project directory is a bad place to keep the console’s source of truth.

**Back up the registry, all account databases and saved settings together.** Use
SQLite’s backup facility, or copy them while Hydra is stopped. Restoring the
original database without its identity registry loses the ownership mapping.
Deleting that registry is not a password-reset strategy.

Transcript retention defaults to **4,000 events per run**, **30 days**, while
keeping the **last 200 events** of each run. Cleanup starts after boot and runs
periodically. It removes old transcript events, not the run records, remarks,
status history or commands. Deleting events frees SQLite pages internally;
shrinking the file can require an offline `VACUUM` after stopping Hydra.

### Try the demo, take the tour

**Try the demo** on the sign-in screen makes a throwaway account and fills it
while you watch: a real Git project called *Kettle* (a tiny tea timer with
passing tests) in `~/hydra-demo/<demo-account>/kettle`, four conversations,
two pipelines with a stopped run and a station waiting on you, a week of
activity, four committed change sets, and agent settings with a $5 / 15-minute
run budget and two providers switched off. The history is replayed, not
simulated: the diffs on **Changes** are real commits, and agents you have
installed can work in the folder for real. Demo runs use the agents' existing
logins on this machine, so they cost the same as anyone else's.

A demo account has no password, so signing out abandons it: nobody can sign
back in. It cannot connect Telegram. After `HYDRA_DEMO_HOURS` (default 24) Hydra
deletes the account, its private state and its sample folder; the folder is
only removed while it still carries the `.hydra-demo-owner` marker Hydra wrote.

| Variable | Default | Effect |
|---|---|---|
| `HYDRA_DEMO` | on | `0` hides **Try the demo** and refuses to create demo accounts |
| `HYDRA_DEMO_HOURS` | `24` | Lifetime of a demo account |
| `HYDRA_DEMO_ROOT` | `~/hydra-demo` | Where sample projects are written; never inside Hydra's state |

The **guided tour** starts automatically after the demo, is offered once to
every new account, and is always available from **Take the tour** at the
bottom of the sidebar. It has six chapters — one per head of the mark — and
most stops ask you to do the real thing (open a thread, switch to Ask, open a
diff) before moving on. **Esc** pauses it; the sidebar button resumes it or
jumps to a chapter. Progress is stored per account in the browser.

### Forgotten password? Still your machine.

Change a known password from **Account**. If you cannot sign in, run this on the
Hydra machine:

```bash
npm run reset-password -- <username>
```

It asks for the new password twice without echoing it, keeping it out of shell
history. It opens only the account registry and can run while Hydra is up. Set
`HYDRA_DB` first if you use a non-default database. Password changes and resets
revoke the account’s other sessions; a running console closes affected live
connections within 30 seconds.

Accounts with Telegram connected can also use **Forgot password?** on the
sign-in screen. The eight-digit code goes to the linked private chat, expires
after 10 minutes, works once, and permits five wrong guesses.

## Telegram: let the dragon tap you on the shoulder

Optional, but handy when the pipeline needs you just as you have found a snack.
Hydra uses outbound HTTPS long polling, so it does not need a public URL,
webhook or incoming port.

1. The **installation owner** creates a dedicated bot with `@BotFather`
   (`/newbot`) and saves the token on **Account**. Use a bot just for Hydra:
   only one reader should consume its messages.
2. Each account chooses **Connect Telegram**, opens its single-use link and
   presses **Start**. The link expires after 10 minutes; one Telegram user can
   connect to at most one Hydra account.
3. Connections start with **notifications only**. Enable **Full control**
   separately if you want action buttons and question replies.

| Command | What you get |
|---|---|
| `/status` | Running agents, elapsed time and active pipelines |
| `/pipelines`, `/next` | Pipeline states, completed stations and current/next work |
| `/gates` | Questions waiting for you |
| `/cancel` | Cancel an answer in progress |
| `/help` | Available commands |

Notifications cover questions, pipelines waiting for attention, pipeline
completion/stop/interruption, and failed runs. Intentionally interrupted agent
runs are not reported as failures. `/gates` also lists questions that were
already waiting when Hydra started.

With Full control, buttons can stop agents, control pipelines and answer
questions. Actions ask for confirmation, run through your account’s runtime,
and appear in **Recent Telegram activity**. Buttons expire after 15 minutes;
lowering access disables previously sent controls.

The bot responds only to the linked user in their private chat. It ignores
groups and unlinked users. Messages contain summaries, states, errors and agent
questions, never transcripts, diffs or file contents. Bot chats are not
end-to-end encrypted, so keep sensitive material out of those summaries.

The token stays in the local account registry; it is not shown again in the
browser. Replacing or removing the bot disconnects all account chats. Only the
live `serve` console polls Telegram; the development sandbox leaves its copied
bot stopped.

## Reports that admit what they do not know

**Report** shows usage in the selected workspace for **7 days**, **30 days** or
**all time**, with an optional provider filter. Days use UTC and sessions are
grouped by start date. Charts, shares and breakdowns use the same selection.

API estimates apply configured model-family rates to recorded tokens. They are
a comparison proxy, not your subscription charges or a historical invoice.
**Behind the numbers** explains pricing coverage and unpriced sessions. Unknown
usage stays unknown; a reported zero stays zero. Cursor does not reliably report
tokens, so Hydra omits that stat rather than inventing one.

**Export CSV** downloads the selected sessions, recorded usage, estimates and
applied rates. Searching inside the breakdown does not narrow that export.

## When something gets weird

| Symptom | Start here |
|---|---|
| A provider is greyed out | Read its availability reason in Agents. Check the host’s executable, login, enabled state and model access tier, then refresh detection. |
| “I logged in, but it still says unavailable” | Confirm you logged into the CLI on the Hydra machine. For credential stores Hydra cannot inspect, review that provider’s **Assume authenticated** option. |
| My new account ignored `.env` keys | New accounts have personal defaults. Save keys and provider settings in that account’s Agents page. |
| No workspace, or the directory is missing | Create a workspace in Workspaces and use an existing host path. Hydra does not create a project checkout for you. |
| A saved task refuses to start because Git is dirty | Resolve your existing changes yourself. Use Ask if you only need research. |
| Docker fails although it works in my terminal | Check **Host access (Docker)** and the OS user’s Docker permissions. Codex’s default sandbox cannot use the Docker socket. |
| A pipeline keeps dying while I edit Hydra | Use `npm run serve` for live work and `npm run dev:sandbox` for development. Watch-mode restarts stop active agents. |
| A step is waiting or parked | Inspect its conversation, evidence, provider availability and allowances in Needs you or the step drawer. Supervised budget exceptions need a reviewed new allocation. |
| The browser cannot connect | Check the backend, browser-visible server URL, exact allowed origin and cookie settings. Rebuild after changing a public frontend URL. |
| A CLI stopped understanding its arguments | Check that installed CLI’s `--help` and update support. Headless flags and stream formats change between releases. |
| Memory limits seem absent | Check the user systemd manager. Process-group fallback cancels processes but does not impose a memory ceiling. |
| Cannot sign in | Use the local reset-password command or your connected Telegram recovery flow. Keep the identity registry. |

Advanced CLI arguments are provider-specific. Codex expects App Server
configuration flags such as `-c`, `--enable` and `--disable`; Kilo expects server
flags such as `--pure`, `--print-logs` and `--log-level`. Old run-only flags fail
explicitly. Cursor needs `stream-json` for partial output; its `json` option is
whole-response compatibility mode.

## Security and sensible expectations

Hydra requires login for application APIs and WebSockets. Passwords use salted
scrypt hashes; session tokens are stored hashed and sent in HttpOnly,
SameSite=Strict cookies. Authentication and recovery routes are rate limited.
Private account runtimes require a gateway credential; agent callbacks use
separate run-scoped credentials.

**This is a local development tool for trusted users of the same machine.**
Accounts separate application records and settings. Agents still run as the
server’s OS user, with the file and command access their provider permits.
Local CLI logins, installed tools, machine-level subscriptions and filesystem
access remain shared. Use separate OS users or containers when people must not
access each other’s files or provider credentials.

Keep `.env`, saved settings, backups and the Telegram token private. File mode
`0600` protects against other OS users, not an unrestricted agent running as the
same user. Resource limits, hooks and prompts are useful controls; choose OS
isolation to match the level of trust you actually need.

## Development

Hydra can be running someone’s real work from this very checkout. Please do not
kick the chair out from under the agents.

```bash
npm run dev:sandbox
```

That copies the database, account registry, account data and saved settings to
`/tmp/hydra-sandbox/`, then runs a watch backend on **4100** and a frontend on
**3100**. Sign in with the same credentials. To reuse that snapshot:

```bash
npm run dev:sandbox -- --keep
```

The state copy is isolated; **the project directories are not**. Workspace rows
still point at real folders. Manually launching an agent from the sandbox can
still change a real repository. Copied pipelines never auto-resume, and the
copied Telegram bot stays stopped.

Plain `npm run dev` refuses the default live database. Prefer the sandbox;
`HYDRA_DB` can point development at a disposable database if you need a different
setup. Do not run `serve` or `free-ports` over a live instance to “see if it helps.”

| Command | Purpose |
|---|---|
| `npm run serve` | Build, free live ports, run without watching |
| `npm run dev:sandbox` | Develop against copied state on separate ports |
| `npm run build` | Check shared/server and build the frontend |
| `npm run typecheck` | Typecheck shared, server and web |
| `npm test --workspace shared` | Shared contracts and domain behaviour |
| `npm test --workspace server` | Backend tests, serially against a disposable database |
| `npm test --workspace web` | Frontend logic tests |
| `npm run lint --workspace web` | Frontend lint |
| `npm run reset-password -- <username>` | Local account recovery |

The root `npm test` chains workspaces with `&&`; a server failure prevents web
tests from running. Run them separately when you need all results. Check
[AGENTS.md](AGENTS.md) before changing code, especially around state, child
processes, credentials and live-system safety.

## Architecture

TypeScript throughout, using npm workspaces: **`@hydra/shared`**, **`@hydra/server`**
and **`@hydra/web`**. The frontend is Next.js 16 / React; the backend uses SQLite
and streams normalised provider events over WebSockets.

```text
shared/src/
  index.ts                   explicit public API for @hydra/shared
  contracts/                 wire shapes and persisted-record contracts
  models/                    catalogs, statuses, usage and execution models
  policies/                  pipeline, station and provider-failure decisions
  utils/                     shared formatting and parsing
server/src/
  index.ts                   gateway / private account-runtime entrypoint
  api/                       HTTP, WebSockets and access logging
  config/                    boot configuration and settings field table
  contracts/                 service, adapter and process interfaces
  models/                    run and context state
  domain/                    pure rules and transformations
  infrastructure/            processes, containment, locks and OS integration
  providers/
    adapters/                one normalising adapter per provider
    streams/                 native stream decoding
    registry.ts              provider registration and discovery
  repositories/              SQLite stores, additive migrations and retention
  services/                  agents, runs, pipelines, programs, verification,
                             workspaces, execution and Telegram
  utils/                     general helpers without a domain owner
server/bin/                  agent-step and Cursor policy executables
web/
  app/                       Next.js routes and global styles
  features/<feature>/        feature components/, hooks/ and lib/
  components/                shared layout, theme and UI
  contexts/                  WebSocket, workspace, account and fleet state
  api/                       server URL and typed HTTP clients
  models/                    browser state shapes
  hooks/                     application-wide hooks
  lib/                       shared browser utilities
brand/                       brand sources and asset generator
scripts/                     sandbox, port management and account recovery
docs/assets/                 README illustration and generation prompt
```

**Placement guide.** Shared protocol shapes belong in `contracts/`; domain
values and validation stay with their owning `models/` or `policies/` module.
Internal shared imports are direct. Export the public API explicitly from
`shared/src/index.ts`; consumers use `@hydra/shared`.

On the server, `api/` handles transport, `services/` coordinates work,
`repositories/` persists it, and `infrastructure/` handles the OS. Keep
provider-specific formats behind `providers/adapters/` and `providers/streams/`.
Put helpers with their feature before reaching for `utils/`.

In the frontend, keep feature components, hooks and helpers together;
application-wide pieces belong in the corresponding shared directories. `app/`
keeps Next.js routing conventions and `@/` resolves from `web/`. Before changing
Next.js code, read the relevant installed guide in `node_modules/next/dist/docs/`.

Tests mirror source responsibilities under each workspace’s `test/`. Cross-module
backend flows go in `server/test/integration/`; architecture rules go in
`server/test/architecture/`.

**The seams that matter:** adapters implement `AgentAdapter` and yield only
`assistant_text`, `tool_use`, `tool_result`, `status`, `result` and `error`.
Provider formats stop there. The server owns run IDs, elapsed time, token usage
and terminal state; the browser renders them. Events stream as adapters yield
them, and provider failures become events rather than silently lost output.

Settings are table-driven from `server/src/config/settings.ts`. Agents use
`agent-step` for scoped progress, checkpoints, completion, continuation and
blockers, with audited callbacks. Schema changes are new additive migrations;
never rewrite an applied migration. The browser talks only to the server.

For branding, change [brand/build.mjs](brand/build.mjs) and run
`node brand/build.mjs`; logos, app icons and geometry are generated together.
See the [brand guide](brand/README.md). The decorative README illustration was
created with the built-in image generator; its [prompt](docs/assets/hydra-workshop.prompt.txt)
is included so the tiny workshop can have a future.

---

*Many heads. One console. You pick the next useful thing.*

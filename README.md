# Multi-Agent Live Console

A self-hosted web console that gives five local CLI coding agents — **Claude Code**,
**Codex CLI**, **Cursor CLI**, **Grok CLI**, and **GitHub Copilot** — one shared browser UI. Type a prompt, pick a
provider, and watch that agent work in real time: streamed assistant text,
collapsible tool calls and results, a server-side elapsed clock, and live token
counts, all rendered as a scrolling terminal-style log.

```
┌─ agent console ──────────────────────────────────────────────────────────┐
│  ● Claude Code  ● Codex CLI  ○ Cursor CLI  ● Grok CLI  ● Copilot  clear │
├──────────────────────────────────────────────────────────────────────────┤
│ 11:44:02  CODEX   ❯ create hello.txt containing "it works"               │
│ 11:44:06  CODEX   I'll write the file and verify it.                     │
│ 11:44:09  CODEX  │ ✓ apply_patch  workspace/hello.txt              ▸     │
│ 11:44:13  CODEX  │ ✓ shell        wc -l hello.txt                  ▸     │
│ 11:44:15  CODEX   ■ done · 13s · 41.2k tokens ───────────────────────────│
├──────────────────────────────────────────────────────────────────────────┤
│ ● connected │ Running (codex)… 13s · ↓41.2k tokens   sandbox: workspace-…│
├──────────────────────────────────────────────────────────────────────────┤
│ ❯ ask the agent to do something…                              [ Send ⏎ ] │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
npm install
cp .env.example .env
npm run serve             # builds, then runs the backend and frontend without watch
```

Open <http://localhost:3000>. The backend listens on <http://127.0.0.1:4000>
(`/api/providers`, `/api/health`, and the WebSocket at `/ws`).

## Running a live pipeline

**`npm run serve` is the only way to run a pipeline that is doing real work.**

`npm run dev` runs the server under `tsx watch`. Saving a file restarts it,
which kills every agent in flight and applies any new migration to the database
immediately — 22 of the first 34 pipeline runs on this console died exactly that
way, mid-edit, and none of them resumed on their own. `serve` builds once and
watches nothing, so editing code cannot touch a running suite.

```bash
npm run serve             # live: server on :4000, web on :3000, no file watching
npm run dev:sandbox       # development: a copy of the database on :4100 / :3100
```

`dev:sandbox` copies `~/.local/state/agent-console/console.sqlite` (and its WAL)
to `/tmp/agent-console-sandbox/`, then starts the watch server against the copy
on its own ports. Pass `--keep` to reuse the existing copy instead of taking a
fresh one (`npm run dev:sandbox -- --keep`). The live database is never opened.

Plain `npm run dev` refuses to start when it would open the live database at its
default path. Point `AGENT_CONSOLE_DB` somewhere disposable, use `dev:sandbox`,
or set `AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1` if you mean it. If a `serve` process
already holds the lock, the message says so and points at `dev:sandbox`.

### Pipeline behaviour

When a station's run ends, the scheduler has exactly three answers:

| The run ended… | Decision | What the rail does |
|---|---|---|
| Agent posted **DONE** (and any definition-of-done gate passes) | **advance** | move on to the next ready station |
| Agent posted **BLOCKED** with a concrete human action | **park** `human_question` | the only human stop — answer it, then Resume |
| Agent posted **`continue`** with remaining work | **continuation** (productive) | re-run the **same** station on the same working tree with the agent's brief — **does not** spend the unfinished allowance and does not park |
| Anything else (budget, crash, unreported, verification failed, …) | **continuation** (unfinished) | re-run the same station up to `pipeline.maxContinuations` (default 4); then one read-only review; then park `continuations_exhausted` |

There is no automatic handoff, remediation, or retry/recover chain. Resume on a
parked station writes a USER ledger row and grants a fresh unfinished-continuation
allowance. Station rules expose `onDone` (`continue` / `stop` / `skip_rest`) and
`onUnfinished` (`continue` / `skip` / `wait`).

A pipeline that *is* interrupted — the machine rebooted, the console was
restarted or killed — comes back by itself: about ten seconds after boot, every
run marked `INTERRUPTED` by a restart in the last 24 hours is resumed on the
station it was holding, on the same working tree. Nothing is marked done or
failed; the station is simply re-queued, and the ledger records `restart_resume`
as the cause. A run **you** stopped with the Stop control stays stopped. This is
the `pipeline.onRestart` setting; set it to `newRun` or `resumeSameRun` to go
back to waiting for a button.

Only a `serve` process resumes anything. A sandbox copies the database, not the
world — its workspace rows still name your real project directories — so a
development server that resumed the live console's pipeline would launch a real
agent into a real repository. It logs what it is leaving alone instead.

Run the two halves separately if you prefer: `npm run dev:server` /
`npm run dev:web`, or `npm run serve:server` / `npm run serve:web`.
`npm run build` typechecks the server and builds the frontend.

### Requirements

- Node.js ≥ 20.10 (developed on 24.x)
- At least one provider installed and authenticated — see below. The console
  runs fine with only one; unavailable providers are shown greyed out with the
  reason.

---

## Providers

| Provider | Driven by | Needs | Reports tokens |
|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk`, in-process | `ANTHROPIC_API_KEY`, **or** an existing `claude` login | yes |
| Codex CLI | `codex exec --json` (spawned) | `codex` on `PATH` + `OPENAI_API_KEY` or `codex login` | yes |
| Cursor CLI | `cursor-agent -p --output-format …` (spawned) | `cursor-agent` on `PATH` + `cursor-agent login` | not reliably — the stat is hidden rather than faked |
| Grok CLI | `grok -p --output-format streaming-json` (spawned) | `grok` on `PATH` + `XAI_API_KEY` or `grok login` | yes |
| GitHub Copilot | `copilot -p --output-format json` (spawned) | `copilot` on `PATH` + `copilot login`, `COPILOT_GITHUB_TOKEN`, or a Copilot-enabled `gh` login | yes |

### How detection works

`GET /api/providers` (also pushed over the socket on connect, and re-run before
every run) reports `{ available, reason, version, binary, permissionMode, model }`
per provider. Nothing is hardcoded to an install path.

- **Claude** — no binary is needed, the SDK runs in-process. Available if
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set, or if
  `~/.claude/.credentials.json` exists (i.e. you have logged in with the CLI).
  Version reported is the Agent SDK version.
- **Codex** — the `CODEX_BIN` command (default `codex`) is looked up on `$PATH`;
  version comes from `codex --version`. Auth is satisfied by `OPENAI_API_KEY` or
  by `auth.json` under `$CODEX_HOME` (default `~/.codex`).
- **Cursor** — same `$PATH` lookup for `CURSOR_BIN` (default `cursor-agent`).
  Auth is satisfied by `CURSOR_API_KEY` or by a login under `~/.config/cursor/auth.json`
  / `~/.cursor` / `~/.config/cursor-agent` / `~/.local/share/cursor-agent`. Plan usage
  (billing-cycle included allowance) is fetched from Cursor's dashboard API using the
  login token — not an API key. If the login heuristic is wrong for your install, set
  `CURSOR_ASSUME_AUTHENTICATED=true`.
- **Grok** — same `$PATH` lookup for `GROK_BIN` (default `grok`). Auth is
  satisfied by `XAI_API_KEY` or by `auth.json` under `$GROK_HOME` (default
  `~/.grok`). If that heuristic is wrong for your install, set
  `GROK_ASSUME_AUTHENTICATED=true`.
- **Copilot** — same `$PATH` lookup for `COPILOT_BIN` (default `copilot`). Auth
  is resolved in the CLI's own order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, a plaintext credential file under `$COPILOT_HOME` (default
  `~/.copilot`), then `gh auth token`. A `copilot login` normally stores its
  token in the **OS credential store**, which this server cannot read — if you
  logged in that way and nothing else applies, set
  `COPILOT_ASSUME_AUTHENTICATED=true`. Plan usage (the monthly premium-request
  or chat allowance and its reset date) comes from GitHub's own
  `copilot_internal/user` endpoint using that token.

Unavailable providers cannot be selected; hovering the button shows why
(`codex not found on PATH`, `ANTHROPIC_API_KEY not set…`). The ↻ button re-runs
detection without a page reload.

### Switching models

Each provider in the header is a **split pill**: the left half selects the
provider, the right half shows the model it will run with and opens that
provider's model list. Two other ways to get there:

- Type **`@`** in the prompt box. A bare `@` lists the providers with their
  current models; typing filters across every provider × model pair, so
  `@haiku`, `@5.6`, or `@claude:opus` each land in one go. `↑↓` moves, `⏎`/`tab`
  picks, `esc` dismisses. The `@token` is stripped and never reaches the agent.
- The **custom model id** field at the bottom of the dropdown, for anything
  newer than the bundled catalog.

The catalog lives in `shared/src/index.ts` (`MODEL_CATALOG`) — the codex slugs
come from that CLI's own model cache and the grok ones from `grok models`.
Copilot is the exception: its model list is per-account, and `--model` rejects
any id the plan's picker does not expose (a free plan exposes none, only
`auto`), so only `default` and `auto` are listed and everything else goes
through the custom-model field.

**Precedence** for a run is: model picked in the header → the provider's `Model`
setting → the provider's own default (nothing is passed). Picking a model in the
header never rewrites the setting; it is remembered per provider in
`localStorage` and applies to the next run. The model a run resolved to is
stamped on every event it produces, so the log gutter shows `claude · opus 5`
next to the timestamp and a transcript that mixes providers stays readable.

### ⚠️ CLI flags drift

Codex's, Cursor's, Grok's, and Copilot's headless/JSON flags change between releases. The
flags here were verified against **codex-cli 0.153.0**, **cursor-agent 2026.09.02**,
**grok 1.0.13**, and **GitHub Copilot CLI 1.0.82**; the Cursor mapper was written
against the documented `stream-json` shape and is deliberately tolerant of
unknown event types.

The **session-resume** flags each adapter uses for a wrap-up turn drift the same way, and
`codex exec resume` in particular takes a *different* option set from `codex exec` (no `-C`,
no `-s`, no `--color`) — check `codex exec resume --help` too. **Check `codex --help`, `codex exec --help`,
`cursor-agent --help`, `grok --help`, and `copilot --help` for your installed versions** before
assuming a mis-behaving run is a bug in this app. The spawn adapters accept `CODEX_EXTRA_ARGS` /
`CURSOR_EXTRA_ARGS` / `GROK_EXTRA_ARGS` / `COPILOT_EXTRA_ARGS` so you can adjust without editing
code, and `CURSOR_OUTPUT_FORMAT` switches between `stream-json` and `json`.

---

## Provider settings

Everything in `.env` that is safe to change while the server is running is also
editable from the **Agents** page — per-provider default model, permission/sandbox
mode, binary name, extra CLI arguments, API keys, host access, run budgets,
pipeline policy, and transcript retention. (Day-to-day model switching happens in
the header, not here; the `Model` field only supplies the fallback.) Changes are
saved to `.agent-console/settings.json` (mode `0600`, gitignored) and survive
restarts.

- **Layering** — `.env` supplies the default for every field; saved overrides sit
  on top. A field edited back to its `.env` value drops the override entirely.
- **No restart** — adapters read settings through getters at run time, so a
  change applies to the next run. Provider detection re-runs on save, so
  switching `CODEX_BIN` or adding an API key updates the switcher immediately.
- **Every open tab stays in sync** — saving broadcasts `settings_updated` over
  the WebSocket with the re-detected providers.
- **Secrets stay server-side** — `password` fields are write-only. The browser
  is told whether a key is set, never its value.
- **Dangerous values are called out** — selecting `bypassPermissions`,
  `danger-full-access`, Cursor's `--force`, Grok sandbox `off`, Copilot
  `allow-all-paths` / `yolo`, or turning on
  **Host access (Docker)** is flagged inline and asks for confirmation before saving.

The Agents page is generated from the field table in `server/src/settings.ts`.
Adding a new tunable is one entry there — label, group, type, `.env` variable,
options, description — and it appears in the UI with no frontend change.

`REST: GET /api/settings` · `PUT /api/settings` (partial patch) ·
`POST /api/settings/reset` (`{"keys": [...]}` or `{}` for everything).

## Workspaces and saved prompts

The separate **Workspaces** page at <http://localhost:3000/workspaces> manages
the execution library. A workspace points to an existing work directory and
contains programs, programs contain suites, and suites contain reusable
prompts. The console lets you select a workspace and either type a custom
prompt or choose one of those saved prompts.

Data is stored in `$XDG_STATE_HOME/agent-console/console.sqlite` (falling back
to `~/.local/state/agent-console/`), **deliberately outside the repository**. A
workspace usually points at this repo, and that directory is an agent's cwd with
write access — a database sitting inside it could be changed without going
through the API, leaving a status with no recorded cause. An existing
`.agent-console/console.sqlite` is copied to the new location on first start and
left in place; `AGENT_CONSOLE_DB` overrides both. The server refuses to start if
the resolved path is inside any workspace's directory. The browser only uses the
REST API; it never reads or writes SQLite directly. There is no default
workspace: create one on the Workspaces page, pointing it at an existing
directory, before you can add programs, suites, or run an agent. Each run
uses that workspace's directory as `cwd`.

Transcript events (`agent_run_event`) are capped by the **Retention** settings
(`RETENTION_EVENTS_PER_RUN`, `RETENTION_EVENT_AGE_DAYS`,
`RETENTION_KEEP_FINAL_EVENTS`): a sweep runs a minute after boot and then every
six hours, deleting oldest events first while always keeping the last N of each
run. Runs, remarks, status events and commands are not touched. Deletes free
pages inside the file; reclaiming them on disk needs an offline `VACUUM` when
`auto_vacuum` is not incremental (the default):

```bash
# Stop every console process first — VACUUM needs the file to itself.
sqlite3 ~/.local/state/agent-console/console.sqlite 'VACUUM;'
```

Workspace CRUD lives under `/api/workspaces`; nested program, suite and prompt
CRUD lives under `/api/programs`, `/api/suites`, and `/api/prompts`. Deleting a
parent cascades to its owned children.

Prompt packs can be copied into a workspace with a two-step server-side import:
`POST /api/workspaces/:id/imports/inspect` previews the manifest, suites,
prompts, statuses, dependencies, and gates; the matching `/apply` endpoint
inserts the previewed structure in one transaction. Both accept `rootPath` and
`programKey`. The files are import input only: prompt Markdown is copied into
SQLite, shared standing instructions are copied into the workspace description,
and no source path, file hash, or continuing filesystem link is stored.

When a saved prompt runs, its body is not pasted into the composer or transcript.
The server creates a persisted run and a random bearer token, writes a per-run
`agent-step` launcher with that credential baked in (mode `0700`, removed when
the run ends), and tells the agent to use it:

```bash
agent-step remark     --kind PROGRESS --text "What changed or was verified"
agent-step done       --verification "The commands you ran and what you observed"
agent-step continue   --remaining "What is left, as instructions for the next run on this tree"
agent-step blocked    --reason "Observed evidence" --action "What only a human can do"
```

The credential is per-run rather than per-process because the Claude adapter
runs its SDK in-process, so environment variables would be shared by every
concurrent run. The raw HTTP contract stays documented and working as a
fallback. Every call an agent makes — accepted, refused or replayed — appears in
the transcript as a flagged `⛁` line with the tables it touched, so a run that
never reported is visibly different from one that reported and was refused.

The underlying endpoint is still `GET /api/agent/runs/:runId/context`. That
read-only endpoint composes workspace instructions, program and suite context,
prompt content, dependency results, and gate information directly from SQLite.
It returns Markdown by default and JSON for `Accept: application/json`, expires
after the run, and cannot be changed to inspect a different prompt. The same
run credential can append progress through `POST .../remarks` and perform the
strict `IN_PROGRESS` → `DONE`/`BLOCKED` transition through `POST .../status`.
Every mutation is idempotent, audited, transactionally applied, and scoped to
the selected prompt. Custom prompts continue to be sent directly.

Host, port, and `ALLOWED_ORIGINS` are deliberately **not** editable from the UI —
they are boot-time only and live in `config.ts`.

---

## Permission models (read this before pointing it at real code)

The agents have different permission systems, and the console does
not paper over that — it shows each provider's effective mode in the status bar
and in the switcher tooltip. Defaults are set in `.env.example` and can be
changed at any time from the Agents page:

| Provider | Env var | Default | What it means |
|---|---|---|---|
| **All** | `AGENT_HOST_ACCESS` | `false` | One switch for Docker and other host services. When on, the per-provider rows below are overridden: Codex `danger-full-access`, Claude/Grok `bypassPermissions`, Grok sandbox `off`, Cursor `--force`, Copilot `yolo`. Required for `docker compose` — Codex's `workspace-write` sandbox cannot connect to `/var/run/docker.sock`. |
| Claude | `CLAUDE_PERMISSION_MODE` | `acceptEdits` | File edits auto-approved; commands still gated by Claude Code's own rules. `plan` for read-only, `bypassPermissions` for no checks at all. |
| Codex | `CODEX_SANDBOX_MODE` | `workspace-write` | Writes confined to the selected workspace directory, network restricted. `read-only` is stricter, `danger-full-access` removes the sandbox. |
| Cursor | `CURSOR_FORCE` | `true` | Cursor has no sandbox: `--force` means it will not stop to ask. Set `false` to keep approvals on (headless runs may then stall). |
| Grok | `GROK_PERMISSION_MODE` + `GROK_SANDBOX_MODE` | `acceptEdits` + `workspace` | File edits auto-approved; OS sandbox confines writes to the selected workspace directory. `bypassPermissions` skips prompts; sandbox `off` removes the sandbox. |
| Copilot | `COPILOT_PERMISSION_MODE` | `allow-all-tools` | A headless `copilot -p` run cannot show an approval prompt, so tool approval is always pre-granted (`--allow-all-tools`); this picks how far outside the workspace that reaches. File access stays inside the working directory (plus the system temp dir) by default. `plan` is read-only planning with the built-in write tools denied; `allow-all-paths` and `yolo` drop that containment. Copilot's own OS-level command sandbox is experimental and is not used — shell commands run with your user's access. |

`CLAUDE_PERMISSION_MODE=default` and `GROK_PERMISSION_MODE=default` are a poor
fit for a headless console: prompts have nowhere to go, so tool calls get denied
or the run stalls. Use `acceptEdits`, `plan`, or `dontAsk`.

**Docker / compose.** Codex's default `workspace-write` sandbox cannot connect to
`/var/run/docker.sock` even when your user is in the `docker` group — that is a
sandbox deny, not a missing CLI. Turn on **Host access (Docker)** on the Agents
page (or set `AGENT_HOST_ACCESS=true` and restart the server). The OS user that
runs this console still has to be in the `docker` group, or Docker itself will
refuse the socket.

Each run uses the selected workspace's directory as `cwd`. Relative paths on a
workspace resolve against the repo root. **Point a workspace at the project you
want worked on, and remember the agents can read and write there.**

---

## Architecture

```
shared/src/index.ts      normalized event schema + WS protocol (one source of truth)
server/src/
  index.ts               transport: HTTP detection/settings endpoints + WebSocket server
  config.ts              boot-time only: host, port, allowed origins, repo root
  settings.ts            live settings: field table, .env layering, persistence
  runner.ts              run lifecycle: run id, elapsed clock, status heartbeat, usage
  adapters/
    types.ts             AgentAdapter interface
    registry.ts          provider table  ← the only file a new provider touches
    claude.ts            Agent SDK  → normalized events
    codex.ts             codex JSONL → normalized events
    cursor.ts            cursor JSON → normalized events
    grok.ts              grok streaming-json → normalized events
    copilot.ts           copilot JSON envelopes → normalized events
    spawnAdapter.ts      shared spawn/JSONL/stderr/interrupt machinery
web/
  lib/useAgentConsole.ts WebSocket client, reconnect, state reduction
  lib/useSettings.ts     settings REST client
  lib/log.ts             event stream → transcript projection
  components/            switcher, log panel, log entry, status bar, prompt input,
                         Agents page (rendered from the server's field table)
```

**Provider adapter pattern.** Every adapter implements:

```ts
interface AgentAdapter {
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent>;
  interrupt(runId: string): Promise<void>;
}
```

and yields only these event types, defined once in `shared/`:

```
assistant_text | tool_use | tool_result | status | result | error
```

Provider-specific shapes (`SDKMessage`, codex `item.completed`, cursor
`stream-json`, grok `streaming-json`, copilot `assistant.*`/`tool.*` envelopes)
never leave the adapter. Adding another
provider is one new file in `server/src/adapters/` plus one line in
`registry.ts` (and `"id"` on `PROVIDER_IDS` plus a chip colour) — the transport
layer and the rest of the frontend stay untouched.

**What the server owns, not the browser.** The run id, the elapsed clock (pushed
as a `status` heartbeat every `STATUS_INTERVAL_MS`, so the displayed time is the
real time rather than a drifting client timer), cumulative token usage, and the
terminal state of the run.

**Streaming.** Events are written to the socket the instant the adapter yields
them; nothing is buffered until the run completes. Claude Code and Grok stream
true text deltas; Codex and Cursor emit whole blocks, which the log projection
handles via `delta: false` block replacement keyed on `blockId`.

**Interrupt.** The browser sends `{ kind: "interrupt", runId }`. The runner calls
the adapter's `interrupt()` — `Query.interrupt()` for Claude, `SIGINT` then
`SIGKILL` for spawned CLIs — and hard-aborts after a 2s grace period if the
provider does not stop, so a hung interrupt can never leave a run un-cancellable.
Disconnecting the browser interrupts the run too.

**Errors.** A child process that dies unexpectedly, a malformed stream, or a
provider-reported failure becomes an `error` event, not a dropped socket. Child
`stderr` goes to the server log only (set `DEBUG=1` to see it), never to the
browser, unless the process exits non-zero — then the captured tail is attached
to the fatal error event.

---

## Configuration

Configuration comes from two layers:

1. **`.env` at the repo root**, read by both processes (the frontend picks it up
   through `web/next.config.ts`). See `.env.example` for the annotated list.
2. **`.agent-console/settings.json`**, written by the Agents page, layered on
   top of `.env`. Delete the file to go back to pure `.env` behaviour.

API keys are read server-side only and are never sent to the browser — the client
only ever sees `available`, `reason`, `version`, `permissionMode`, and `model`,
plus a boolean for whether each key is set.

Note that keys saved through the Agents page are stored in
`.agent-console/settings.json` in plain text (file mode `0600`). If you would
rather not have them on disk in that form, leave those fields empty and use
`.env` or your provider's own login (`claude`, `codex login`, `grok login`,
`copilot login`).

---

## Security

**This is a local development tool. Do not expose it beyond localhost or a
trusted network without adding authentication.**

It has no auth system by design, and anyone who can reach the port can run
arbitrary code and file operations in any configured workspace through five
different agents with five different permission models — including modes that
disable sandboxing entirely. The settings endpoints are unauthenticated too:
reaching the port is enough to disable a sandbox or read whether an API key is
configured. The server binds `127.0.0.1` by default and rejects WebSocket
upgrades from origins outside `ALLOWED_ORIGINS`, but neither of those is an
authentication mechanism.

---

## Known limits

- One run at a time per WebSocket connection (per browser tab).
- No session persistence: each run is an independent turn, and no context is
  carried across providers. Nothing is stored in a database; the log lives in
  the page and clears on reload.
- Cursor's headless output does not reliably include token usage, so the token
  stat is omitted for Cursor runs rather than showing a made-up number.

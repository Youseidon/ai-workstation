# Multi-Agent Live Console

A self-hosted web console that gives four local CLI coding agents — **Claude Code**,
**Codex CLI**, **Cursor CLI**, and **Grok CLI** — one shared browser UI. Type a prompt, pick a
provider, and watch that agent work in real time: streamed assistant text,
collapsible tool calls and results, a server-side elapsed clock, and live token
counts, all rendered as a scrolling terminal-style log.

```
┌─ agent console ──────────────────────────────────────────────────────────┐
│  ● Claude Code   ● Codex CLI   ○ Cursor CLI   ● Grok CLI       clear log │
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

Telegram task control: personal control from your own phone (L1, off by default) is implemented and verified against real Telegram by the end-to-end harness; the phone look check is still pending.
Teammate takeover and per-task topics are planned, not available.
See the [Telegram task control and teammate takeover design](docs/telegram-task-control/README.md).

```bash
npm install
cp .env.example .env
npm run dev               # starts the WebSocket backend and the Next.js frontend
```

Open <http://localhost:3000>. The backend listens on <http://127.0.0.1:4000>
(`/api/providers`, `/api/health`, and the WebSocket at `/ws`).

Run them separately if you prefer: `npm run dev:server` and `npm run dev:web`.

`npm run build` typechecks the server and builds the frontend; `npm run start`
runs both without watch mode.

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

**Precedence** for a run is: model picked in the header → the provider's `Model`
setting → the provider's own default (nothing is passed). Picking a model in the
header never rewrites the setting; it is remembered per provider in
`localStorage` and applies to the next run. The model a run resolved to is
stamped on every event it produces, so the log gutter shows `claude · opus 5`
next to the timestamp and a transcript that mixes providers stays readable.

### ⚠️ CLI flags drift

Codex's, Cursor's, and Grok's headless/JSON flags change between releases. The flags here
were verified against **codex-cli 0.150.1** and **grok 1.0.5**; the Cursor mapper was written
against the documented `stream-json` shape and is deliberately tolerant of
unknown event types. **Check `codex --help`, `codex exec --help`,
`cursor-agent --help`, and `grok --help` for your installed versions** before assuming a
mis-behaving run is a bug in this app. The spawn adapters accept `CODEX_EXTRA_ARGS` /
`CURSOR_EXTRA_ARGS` / `GROK_EXTRA_ARGS` so you can adjust without editing code, and
`CURSOR_OUTPUT_FORMAT` switches between `stream-json` and `json`.

---

## Provider settings

Everything in `.env` that is safe to change while the server is running is also
editable from the **Agents** page — per-provider default model, permission/sandbox
mode, binary name, extra CLI arguments, API keys, and host access. (Day-to-day
model switching happens in the header, not here; the `Model` field only supplies
the fallback.) Changes are saved to `.agent-console/settings.json` (mode `0600`,
gitignored) and survive restarts.

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
  `danger-full-access`, Cursor's `--force`, Grok sandbox `off`, or turning on
  **Host access** is flagged inline and asks for confirmation before saving.

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

Data is stored in `.agent-console/console.sqlite`. The browser only uses the
REST API; it never reads or writes SQLite directly. There is no default
workspace: create one on the Workspaces page, pointing it at an existing
directory, before you can add programs, suites, or run an agent. Each run
uses that workspace's directory as `cwd`.

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
The server creates a persisted run and random bearer token, then gives the
provider a short bootstrap instruction pointing to
`GET /api/agent/runs/:runId/context`. That
read-only endpoint composes workspace instructions, program and suite context,
prompt content, dependency results, and gate information directly from SQLite.
It returns Markdown by default and JSON for `Accept: application/json`, expires
after the run, and cannot be changed to inspect a different prompt. The same
run credential can append progress through `POST .../remarks` and perform the
strict `IN_PROGRESS` → `DONE`/`BLOCKED` transition through `POST .../status`.
Every mutation is idempotent, audited, transactionally applied, and scoped to
the selected prompt. Custom prompts continue to be sent directly.

Saved-prompt execute runs use the console's local agent API when the provider can
reach it, which lets the agent fetch context and post live remarks/status. If a
provider is sandboxed away from host networking, the console inlines the
authoritative context and asks for a final machine-readable `agent-status` block;
the server records DONE/BLOCKED after the process exits. Use **Host access** or
`AGENT_API_BASE_URL` only when agents need live Progress API calls or other host
services.

Host, port, `AGENT_API_BASE_URL`, and `ALLOWED_ORIGINS` are deliberately **not**
editable from the UI — they are boot-time only and live in `config.ts`.

---

## Permission models (read this before pointing it at real code)

The agents have different permission systems, and the console does
not paper over that — it shows each provider's effective mode in the status bar
and in the switcher tooltip. Defaults are set in `.env.example` and can be
changed at any time from the Agents page:

| Provider | Env var | Default | What it means |
|---|---|---|---|
| **All** | `AGENT_HOST_ACCESS` | `false` | One switch for Docker, local backend APIs, and other host services. When on, the per-provider rows below are overridden: Codex `danger-full-access`, Claude/Grok `bypassPermissions`, Grok sandbox `off`, Cursor `--force`. Needed for live Progress API calls from sandboxed CLIs and for `docker compose` — Codex's `workspace-write` sandbox cannot connect to host services such as `/var/run/docker.sock`, but saved-prompt execution can fall back to inline context and final status reporting. |
| Claude | `CLAUDE_PERMISSION_MODE` | `acceptEdits` | File edits auto-approved; commands still gated by Claude Code's own rules. `plan` for read-only, `bypassPermissions` for no checks at all. |
| Codex | `CODEX_SANDBOX_MODE` | `workspace-write` | Writes confined to the selected workspace directory, network restricted. `read-only` is stricter, `danger-full-access` removes the sandbox. |
| Cursor | `CURSOR_FORCE` | `true` | Cursor has no sandbox: `--force` means it will not stop to ask. Set `false` to keep approvals on (headless runs may then stall). |
| Grok | `GROK_PERMISSION_MODE` + `GROK_SANDBOX_MODE` | `acceptEdits` + `workspace` | File edits auto-approved; OS sandbox confines writes to the selected workspace directory. `bypassPermissions` skips prompts; sandbox `off` removes the sandbox. |

`CLAUDE_PERMISSION_MODE=default` and `GROK_PERMISSION_MODE=default` are a poor
fit for a headless console: prompts have nowhere to go, so tool calls get denied
or the run stalls. Use `acceptEdits`, `plan`, or `dontAsk`.

**Host services.** Codex's default `workspace-write` sandbox cannot connect to
the console's own local API or `/var/run/docker.sock` even when those services
are running — that is a sandbox deny, not a missing process. Turn on **Host
access** on the Agents page (or set `AGENT_HOST_ACCESS=true` and restart the
server). The OS user that runs this console still has to have permission for
the target service, or the service itself will refuse the request.

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
`stream-json`, grok `streaming-json`) never leave the adapter. Adding another
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
`.env` or your provider's own login (`claude`, `codex login`, `grok login`).

---

## Security

**This is a local development tool. Do not expose it beyond localhost or a
trusted network without adding authentication.**

It has no auth system by design, and anyone who can reach the port can run
arbitrary code and file operations in any configured workspace through four
different agents with four different permission models — including modes that
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

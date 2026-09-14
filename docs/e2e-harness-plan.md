# End-to-end slice test harness plan

Status (2026-09-15): H0 to H6 built.
T0, T1 and burn-in run on this machine; every T3 row is blocked until the operator's one-time live setup ([`e2e-live-setup.md`](e2e-live-setup.md)).
H7 and H8 in progress, H9 not started.
Related: [Engineering standards](engineering-standards.md), [Telegram engineering plan](telegram-task-control/engineering-plan.md), [human verification checklist](telegram-task-control/human-verification.md).

## 1. Goal

Automate as much verification as possible, including UI and interface behaviour, without losing accuracy.
A human is asked only for checks that a machine cannot judge or cannot perform safely.

Concretely, the harness must:

- Run the real server, the real web app and the real database code, end to end, as a user reaches them.
- Replace only what sits outside the process boundary (Telegram, provider CLIs, the clock) with faithful, scriptable fakes.
- Run the same phone scenarios against both a fake Telegram and real Telegram, so live evidence is automated too.
- Assert on every surface a user or operator sees: the phone transcript, the browser UI and the durable state behind them.
- Prove the fakes stay faithful to the real services, so a green run means something.
- Run alongside the operator's own running app without interfering with it.
- Never touch the operator's real `.agent-console` database, settings, bot or workspaces.

## 2. What exists today

| Piece | State | Use in the harness |
| --- | --- | --- |
| Server tests | `node --import tsx --test --test-concurrency=1`, 19 test files, some against fetch-stubbed Telegram. | Stay as tier T0. |
| Database isolation | `AGENT_CONSOLE_REPO_ROOT` relocates `.agent-console` (settings and SQLite), and the server then reads `.env` from that root, not the repository's. | Every harness environment gets its own temporary root with its own `.env`. |
| Telegram seam | `HttpTelegramBotApi` accepts `baseUrl`, but nothing wires it to configuration. | Needs a harness-only configuration seam (slice H3). |
| Provider seam | Spawned adapters (Grok, Cursor, Codex) take their binary from settings (`GROK_BIN` etc.). Claude runs in-process through the Agent SDK. | A scripted fake CLI can run through the real spawn and stream-parsing path (slice H2). |
| Web configuration | `web/next.config.ts` loads the repository `../.env` (which holds the real bot token) and bakes `NEXT_PUBLIC_AGENT_SERVER_URL` at build time. `next dev` and `next build` both write `web/.next`. | Needs a harness build directory and explicit harness environment (slice H1). |
| Browser scripts | `scripts/verify-human-input.cjs`, `verify-m4-browser.mjs`, `verify-phase6.mjs` take a Playwright module path and a CDP URL. No Playwright package is installed; no Linux Chromium; Windows Chrome exists. | Replaced by a Playwright Test suite (slices H0, H7). |
| Time seams | Pairing and action TTLs default to 10 minutes; `runtime.ts` accepts an injected `now` and `pairingTtlMs`, but the server does not expose them. | Needs harness-only TTL overrides (slice H4). |
| Known hazard | An earlier test run without an isolated root left `alias-*` and `ws-*` workspaces in the real database. | The harness refuses to start against the real root (slice H1). |

## 3. Accuracy principles

1. **Fake only at process boundaries.** Server, web, SQLite, runner, pipeline scheduler, task control, the Telegram HTTP client and the provider spawn and parse code all run for real.
   The fakes are an HTTP server that speaks the Bot API, a CLI binary that speaks a provider's stream format, and configuration for timeouts.
2. **Assert on three layers per scenario.** What the phone shows (Telegram transcript), what the browser shows (Playwright), and what is durable (API and database: receipts, run count, prompt status).
   Many invariants are "exactly one": exactly one run, one receipt, one message. Those are asserted from durable state, not from the UI.
3. **Write phone scenarios once, run them on both Telegram backends.** A scenario that passes on the fake but fails on real Telegram exposes a wrong fake; that is the primary fidelity check.
   Recorded real responses back it up in T0 contract suites.
4. **Every scenario includes its failure path.** A happy-path-only scenario is incomplete (matches engineering standards).
5. **No sleeps.** Waits are on observable conditions (an API state, a transcript message, a DOM state) with explicit timeouts.
6. **New scenarios must prove they are stable before they count.** A burn-in command runs a new or changed scenario 20 times; any failure blocks merging it.
   Flaky scenarios are fixed, not retried or silently quarantined.
7. **Failures leave evidence.** Each failed scenario saves a Playwright trace, screenshots, server and web logs, the Telegram transcript, the fake provider log and a database copy.
8. **Secrets never enter artifacts.** Every run ends with an automated token sweep over logs, artifacts, API responses and the database copy; a match fails the run.

## 4. Architecture

```text
Playwright Test runner (e2e/ workspace)
 ├─ Environment orchestrator (per suite)
 │    temp AGENT_CONSOLE_REPO_ROOT with its own .env · fixture git workspaces
 │    ports 4100/3100 · web build in web/.next-e2e · explicit web environment
 │    starts: server (tsx, no watch) + web (next start) + Telegram backend + fake provider path
 │    guard: refuses the real root, refuses the operator's bot, refuses non-loopback fake URLs
 ├─ Drivers
 │    browser   Playwright page objects: Tasks, Agents, Telegram panel, Pipeline, Sessions
 │    phone     PhoneDriver interface
 │                FakePhone          control API of the fake Telegram server
 │                TelegramUserPhone  GramJS user client on real Telegram, test bot
 │    state     typed client over the server REST API (+ read-only DB inspection)
 │    process   restart server, stop server, wait offline, restore
 │    network   Telegram route proxy: cut / restore the server's route to Telegram
 ├─ Scenario layer
 │    one scenario per verification row, named by row ID (e.g. H-L1-06)
 │    each declares which backends it supports (fake, real, or both)
 └─ Reporter
      pass/fail per row ID and backend · artifacts on failure · token sweep · flake burn-in

Server ──> Telegram route proxy (loopback) ──> fake Telegram server   (backend: fake)
                                          └──> api.telegram.org       (backend: real)

Fake provider CLI (scripted binary)
  speaks one real provider's stream format; behaviour chosen per run by a scenario file:
  block-on-decision · done · fail · hang-until-stopped · crash-after-spawn · consume-answer
  calls the real agent Progress API (context, remarks, status) like a real agent does
```

### 4.1 Environment orchestrator

- Creates a temporary root with its own `.env`, fixture git workspaces and scenario settings (providers, task control, transport), starts the processes and waits for readiness.
- Uses ports 4100 (server) and 3100 (web), and sets `ALLOWED_ORIGINS` and `NEXT_PUBLIC_AGENT_SERVER_URL` to match.
- Builds the web app with `next build` into `web/.next-e2e` (a `distDir` read from a harness environment variable) and serves it with `next start`.
  The operator's `next dev` keeps `web/.next`, so a harness build never breaks the running dev app.
  The build is cached and rebuilt only when web code changes.
  A production build also avoids per-page compilation on first visit, a common cause of flaky timeouts.
- Starts the web process with an explicit environment and skips loading the repository `.env` in harness mode, so the real bot token never enters a harness process.
- Starts the server with `tsx` without watch, so the operator's source edits do not restart a harness run mid-scenario.
- Sets `AGENT_CONSOLE_HARNESS=1`.
  The server enables harness seams only in this mode, and in this mode refuses to start if:
  - the resolved root is the repository's real `.agent-console`;
  - a fake or proxy URL is not loopback;
  - the configured bot is the operator's own bot rather than the registered test bot (compared by bot id from `getMe`, never by token).
    The operator's bot id and the test bot id (ids only, never tokens) are stored in the harness's configuration file outside the repository, so the guard never reads the repository `.env`.
- Offers `restartServer()`, `stopServer()` and `startServer()` so offline and restart scenarios use the real process lifecycle.
- After every run, checks that the real `.agent-console` database was not modified.

### 4.2 Telegram backends

**Fake Telegram server (backend: fake).**

- A standalone loopback HTTP server implementing the Bot API methods the app uses (getMe, getUpdates long poll, sendMessage, answerCallbackQuery, editMessageText, setMyCommands, createForumTopic, editForumTopic, closeForumTopic), with Telegram's response envelope, error codes (400, 403, 409, 429 with `retry_after`) and update shapes.
- `FakePhone` drives it through a control API: user messages, replies, button taps, the transcript including edits, several users and chats, topics.
- It can do what real Telegram cannot on demand: 429s, 5xx responses, hangs, duplicate update delivery.
- The existing fetch-level stubs in `telegramBotApi.test.ts` and `telegramLiveRuntime.test.ts` can move onto this fake over time, so there is one Telegram model.

**Real Telegram (backend: real).**

- A **dedicated test bot**, separate from the operator's own bot.
  Two processes cannot poll one bot (Telegram answers 409 and they steal each other's updates), so a shared bot would break the operator's running app; a test bot also keeps test traffic out of the operator's real chat.
- `TelegramUserPhone` is a GramJS (Node `telegram` package) user client signed in as the operator, in a private chat with the test bot.
  It sends messages and replies, taps inline buttons and reads messages and edits, through Telegram's servers, exactly as the phone app does.
- The test bot token, `api_id`, `api_hash` and client session live outside the repository (for example `~/.config/ai-workstation/e2e-live.env`), are never logged, and are included in the token sweep.
  The client session gives full access to the operator's Telegram account while it exists; it can be revoked from Telegram's active sessions.
- Volume is a few dozen messages per run, far below Telegram's flood limits.

**Telegram route proxy.**

- A loopback forwarding proxy sits between the harness server and its Telegram backend, set through the harness-only base URL seam.
- `network.cutTelegram()` refuses or hangs the server's connections while the test client stays connected; `network.restoreTelegram()` restores them.
  This turns "workstation loses its network" into a precise, automatable live test.

### 4.3 Fake provider CLI

- A small Node script placed on a harness bin path and selected through the provider's binary setting.
- Default target: the Grok stream format, because `GrokAdapter` is a plain `SpawnAdapter` with a stream mapper.
  Slice H2 starts with a one-hour check of which adapter is cheapest to emulate faithfully; Codex uses `app-server` JSON-RPC and Claude uses the in-process SDK, both heavier.
- Scenario files decide behaviour: which remarks to post, which final status, whether to wait for a stop signal, whether to exit non-zero or die mid-run, and what to assert about the context it received (for example, "the saved answer is present").
- It supports both saved-task execution paths, and scenarios must cover both:
  - **Live path:** the prompt tells the agent to fetch context and post remarks and status through the HTTP Progress API with a bearer token; the fake does exactly that. Selected when the provider can reach the local API (Host access on, or the provider's sandbox off).
  - **Inline path:** when `savedPromptExecuteReachabilityProblem` reports a problem (for example a sandboxed Grok or Codex), the context is embedded in the prompt and status is reported through the offline completion protocol at the end of the run; the fake parses the embedded context and emits that final report.
  The harness selects the path per scenario through settings (Host access, sandbox mode) in the temporary root.
- Claude's typed tool path (Telegram plan step 7a) is in-process and cannot be emulated by a CLI binary; it is covered by T0 tests of the tool handlers and by the real Claude scenario in T3.
- Combined with real Telegram, it makes live phone scenarios cost no provider quota while the agent side stays deterministic.
- Fidelity: a contract suite replays recorded real provider transcripts through the real mapper and compares the resulting normalized events with the fake's.
  Claude and Codex adapters keep parser-level replay tests in T0; one real-provider scenario covers them end to end.

### 4.4 Browser layer

- `@playwright/test` in a new `e2e/` npm workspace, with page objects per view.
- Browser: Playwright-managed Chromium inside WSL (needs system libraries installed once with `sudo`), so runs are reproducible.
  Fallback: Windows Chrome over CDP, as the existing scripts do.
- Functional checks drive real flows: pairing, enabling task control, answering a question locally, recovering a START_UNKNOWN task, pipeline play and hold.
- UI quality checks on every visited view, at 1440x1000 and 390x844:
  - no console errors or failed requests;
  - no horizontal overflow and no overlapping interactive elements (computed from bounding boxes);
  - accessibility scan with axe-core;
  - screenshot comparison against approved baselines, with dynamic regions (times, counters) masked.
- Screenshot diffs are reviewed by the agent first; only baselines for new or deliberately redesigned screens go to the human (section 7).

### 4.5 Time control

- Harness mode reads overrides for the action TTL, the pairing TTL, the quota freshness window and the Telegram poll timeout.
- On the fake backend, "offline for more than 10 minutes" runs in seconds with a short TTL, while the real expiry code path runs unchanged.
- On the real backend, the expiry scenario uses the real 10-minute default, so the production value is covered.

## 5. Test tiers

| Tier | What | When | Runtime target | Human? |
| --- | --- | --- | --- | --- |
| T0 | Existing unit and integration tests, plus fake contract suites. | Every change. | Under 2 minutes. | No |
| T1 | E2E slice scenarios on the fake Telegram backend with the fake agent: three-layer assertions, failure paths, fault injection. | Every slice and before every commit that touches behaviour. | Under 10 minutes. | No |
| T2 | UI quality pass: overflow, overlap, accessibility, console, screenshot diffs at two widths. | Any web change; runs with T1 by default. | Under 5 minutes. | Baseline approval for new screens only |
| T3 | Live tier: the same phone scenarios on real Telegram (test bot, operator's user client, route proxy) with the fake agent, plus one real-provider scenario each for Claude and Codex on their cheapest models (section 10). | Milestone close-out, and whenever Telegram integration code changes. | Under 25 minutes, including one real 10-minute expiry. | One-time setup only |
| T4 | Human checks (section 7). | Milestone close-out. | About 10 minutes. | Yes |

## 6. Resources and running alongside the app

### 6.1 Footprint

Measured on the operator's machine, 2026-09-14: WSL with 8 cores and 7.8 GB RAM (about 4.6 GB available with VS Code and the dev app running), 935 GB free disk.
The running dev app uses about 480 MB (Next dev server 325 MB, API server 153 MB).

| Harness part | Memory (estimated from the running app) | Notes |
| --- | --- | --- |
| API server | ~150 MB | No file watching. |
| Web app (`next start`) | ~200 MB | Cached production build; the build itself takes 1-2 minutes of CPU when web code changed. |
| Headless Chromium | 300-500 MB | One browser context at a time. |
| Playwright runner, fake Telegram, proxy, fake agent | ~150 MB together | Mostly idle. |
| GramJS user client (T3) | ~80 MB | |
| Real provider CLI (T3, one scenario) | +200-400 MB | Only during that run. |
| **One serial run** | **~0.8-1.2 GB** | Leaves about 3 GB free next to the dev app. |

- CPU is low: scenarios mostly wait on events. Spikes come from the web build and from screenshot and accessibility checks.
- Disk: about 150-300 MB for Playwright's Chromium; a few MB of artifacts per failed scenario, cleaned each run.
- Parallelism: each extra worker adds about 500 MB and needs its own port pair and web build. Two workers is the ceiling on this machine; start serial.

### 6.2 Coexistence with the operator's app

| Resource | Operator's app | Harness |
| --- | --- | --- |
| Database and settings | Repository `.agent-console` | Temporary root; real database checked unchanged after each run |
| Environment file | Repository `.env` | Temporary root `.env`; web process gets an explicit environment |
| Ports | 4000 / 3000 | 4100 / 3100 |
| Web build output | `web/.next` (dev) | `web/.next-e2e` |
| Source reload | `tsx watch`, `next dev` | No watch |
| Workspaces | Real ones | Temporary git repositories |
| Telegram | Operator's bot and chat | Fake server (T1), dedicated test bot and its private chat (T3) |
| Provider CLIs | Real | Fake binary; real only in T3's real-provider scenario |

Shared, by nature:

- Provider quota: T3's real-provider scenarios use the operator's subscriptions.
- Provider CLI state: real Claude and Codex runs in T3 use the operator's own `~/.claude` and `~/.codex` (login, session history, settings), because isolating them would require separate logins. Test sessions therefore appear in the operator's provider history.
- CPU and memory: heavy real agent runs in the operator's app slow the harness. Event-based waits with generous limits absorb this; burn-in exposes limits that are too tight.

## 7. What stays human

Only these, each for a stated reason:

| Check | Why a machine cannot own it | Frequency |
| --- | --- | --- |
| One-time setup: create the test bot, sign in the GramJS client with a login code, install WSL browser libraries (`sudo`). | Needs the operator's identity or root. | Once |
| Phone look check: open the latest T3 messages on the physical phone and confirm they read well (length, line breaks, collapsed detail, buttons). | Rendering on the real Telegram mobile app and "is this readable" are human judgements. | Per milestone that changes phone messages |
| Agent behaviour spot check: read the real-provider T3 run and confirm the agent used the answer sensibly. | LLM output quality is not reliably machine-judged. | Per milestone that changes prompts or context |
| Baseline approval for new or redesigned screens. | Deciding that a new design is correct, rather than unchanged, is a product call. | When screens are added or redesigned |
| Enabling a capability for real use (for example Remote actions on the operator's own bot). | Authorization decision, not a test (D15, D16). | Per capability |
| Unknown-user check on real Telegram, only if wanted. | Needs a second Telegram account. T1 covers the logic. | Optional |

Everything else in the current checklists becomes T1, T2 or T3.

## 8. Coverage of the current L1 checklist

| Row | T1 (fake Telegram) | T3 (real Telegram) |
| --- | --- | --- |
| H-L1-06 Save, resume later | Reply, tap Save; no run started; tap Resume; exactly one run, DONE via fake agent `consume-answer`. | Same scenario. Also the real-provider scenario. |
| H-L1-07 Offline, short gap | `stopServer()`, phone taps, `startServer()`; update processed once. | Same scenario. |
| H-L1-08 Offline, long gap | Short TTL; "This action expired", reissued card, unchanged state. | Real 10-minute default. |
| H-L1-09 Answer on both surfaces | Phone answer card open; Playwright answers in Tasks; phone tap rejected; only the local answer stands. | Same scenario. |
| H-L1-10 Double tap | Two taps back to back; one run, one receipt, "Already applied.", no extra message. | Same scenario. |
| H-L1-11 Network drop | Fake outage, 5xx and 429 variants; panel shows retrying with a sanitized error, then connected; queued messages delivered once. | `network.cutTelegram()` for about a minute, then restore; same assertions. |
| H-L1-12 Restart while waiting | `restartServer()` with a pending card; no duplicate; reply to the old card still works. | Same scenario. |
| H-L1-13 Pipeline step | Fixture pipeline blocks via fake agent; phone answers and resumes; pipeline reaches next step. | Same scenario. |
| H-L1-14 Unknown user | Second fake user: messages, wrong `/start` code, button tap; no reply, nothing recorded, tap rejected. | Only with a second account (optional). |
| H-L1-15 Controls off, unpair | Playwright turns Remote actions off, then unpairs; taps rejected; no further messages. | Same scenario. |
| H-L1-16 Resume cannot start | Provider disabled; "Answer saved, but resume did not start"; answer kept. | Same scenario. |
| H-L1-17 Token sweep | Automatic after every run. | Automatic after every run, including the test bot token and client session. |

Evidence policy (approved 2026-09-14, section 10).
Step 7 of the Telegram plan says fixtures cannot satisfy live verification, and this plan keeps that rule.
T1 results are recorded as automated evidence.
The "Live" column is satisfied by T3 (real Telegram, a real bot, the operator's own account, automated client) plus the T4 phone look check.

## 9. Build slices

Each slice is committed separately with its own tests and ends with a working, runnable state.

**H0: foundations.**
Add the `e2e/` workspace with `@playwright/test` and `@axe-core/playwright`, install Chromium and its libraries (the human `sudo` step), and add `npm run e2e`, `e2e:visual`, `e2e:live` and `e2e:burn-in`.
Done when an empty Playwright test runs.

**H1: environment orchestrator and guard.**
Temporary root and `.env`, fixture git workspaces, ports 4100/3100, `web/.next-e2e` build with explicit web environment, process lifecycle helpers, readiness checks, artifact collection, token sweep, real-database-unchanged check, and the `AGENT_CONSOLE_HARNESS` guard in the server.
Done when a smoke scenario boots the app on an empty root and loads the home page with no console errors while the operator's dev app keeps running and serving; tests prove the guard refuses the real root and that `web/.next` is untouched.

**H2: fake provider CLI.**
Adapter fidelity check (which format to emulate), scenario file format, the fake binary, its contract suite against a recorded transcript.
Done when a saved task runs through the real spawn path and reaches DONE, BLOCKED and FAILED from three scenario files, on both the live Progress API path and the inline path (section 4.3), and the fake answers the adapter's detection call like the real binary.

**H3: fake Telegram server and FakePhone.**
Harness-only Telegram base URL seam (loopback only), the fake server, `PhoneDriver` interface and `FakePhone`, fault injection (outage, 5xx, 429, duplicate delivery), contract suite.
Done when the app pairs with the fake phone through the real Agents page and a blocked task's question card appears in the transcript.

**H4: time seams.**
Harness-mode overrides for action TTL, pairing TTL, quota freshness and poll timeout.
Done when an action expires in seconds under the harness and the defaults are unchanged outside it.

**H5: L1 scenarios on the fake backend.**
First, a test-design pass (section 12) derives the L1 scenario table from RTC-17 to RTC-20, the relevant B-rows, T-rows and H-L1 rows; the operator skims it.
Then the scenario layer with `covers` metadata and backend declaration per scenario, the coverage matrix reporter (section 12.3), and merged V8 code coverage from unit tests and the harness server process (section 12.4); implement the T1 column of section 8 plus any scenarios the test-design pass added; each passes burn-in.
Done when `npm run e2e` reports every row with pass or fail, the L1 matrix has no uncovered requirement IDs, the code coverage report lists uncovered branches in changed critical files, and artifacts exist for a forced failure.

**H6: real Telegram backend.**
`TelegramUserPhone` (GramJS), the Telegram route proxy and `network.cutTelegram()`, the test-bot guard, operator setup instructions for the test bot and client sign-in, secret storage outside the repository, the Claude and Codex real-provider scenarios (section 10), and re-recording of contract fixtures.
Done when `npm run e2e:live` runs the T3 column of section 8 against the test bot while the operator's app keeps polling its own bot undisturbed, and the phone look check is recorded.

**H7: UI coverage and quality pass.**
Page objects for Tasks, Agents and Telegram panel, Pipeline, Sessions; functional flows for pairing, local answer, START_UNKNOWN recovery and pipeline play and hold; overflow, overlap, axe and screenshot checks at two widths.
Retire the `scripts/verify-*` browser scripts once their checks are covered.
Done when T2 runs green on current screens with approved baselines.

**H8: workflow integration.**
Engineering standards and the Telegram plan require T0 plus T1 (and T2 for web changes) per slice, and T3 plus T4 at milestone close-out; each milestone's human checklist gains "Harness scenario" and backend columns; `implementation.md` evidence entries cite row IDs and run results.
Done when the L1 close-out (Telegram plan step 7) is completed through the harness, and L3 slices are planned harness-first with a test-design pass each.

**H9: mutation testing on critical modules.**
Run mutation testing (StrykerJS, using its command runner if the Node test runner has no native plugin) over `taskControl.ts`, `humanInput.ts`, start-intent code in `workspaces.ts` and `integrations/telegram/runtime.ts`, against T0 plus the relevant T1 scenarios.
Record surviving mutants; each is killed by a new or stronger test, or explained.
A generic command runner re-runs the whole test command for every mutant, which could take hours; scope each module's run to that module's own test files and scenarios, and measure the runtime in the first run before widening scope.
Runs at milestone close-out, not per commit.
Done when a baseline mutation report exists for those modules and every surviving mutant is handled.

Order relative to other work: commit the L1 work first, then H0 to H6, then close L1 step 7 with the harness, then H7 and H8, then L3.
H7 can run in parallel with L3 if needed.
H9 runs before the L3 close-out.

## 10. Operator decisions

Decided 2026-09-14:

1. **Scope: harness first.** Commit the L1 work, build H0 to H6, close L1 step 7 through the harness, then H7 and H8, then L3 test-first.
   Accepted cost: L1 close-out waits for H0 to H6.
2. **Evidence policy: approved.** T3 (automated real-Telegram client on the operator's account, test bot) plus the T4 phone look check satisfies "live" verification rows.
   T1 alone never does.
3. **Test bot: yes.** The operator creates a dedicated test bot with BotFather before H6; the operator's own bot is never used by the harness.
4. **Real-provider scenarios: both Claude and Codex**, one scenario each, cheapest available model, milestone close-out only.
   - Claude requires the Host-access-off defect to be fixed first, with typed in-process SDK tools (decided 2026-09-14, see Telegram plan step 7a). Until it is, the Claude scenario is reported as blocked by that defect, not skipped silently.
   - Codex runs with Host access on (decided 2026-09-14, after the risk below was stated), set only in the harness's temporary root settings, never in the operator's own settings.
     Risk accepted: Host access puts Codex in `danger-full-access`, which is **not** confined to the temporary workspace; for that run Codex can read and write anything the operator's user account can.
     The only containment is that the fixture task is small and harmless, the run happens only at milestone close-out, and its full event log is kept as an artifact for review.
     Codex's sandboxed inline path is covered by the fake agent in T1, not by a real Codex run.
5. **Browser: Playwright-managed Chromium in WSL** (agent default, not objected to). The operator runs the one-time `sudo` library install in H0.

Provider availability checked 2026-09-14 on the operator's machine: Claude and Codex available; Cursor and Grok not installed.
Models checked 2026-09-15 by dry runs of the T3 real-provider scenarios on the fake Telegram: Claude uses `claude-haiku-4-5`; Codex uses `gpt-5.5`, because the ChatGPT account refuses `gpt-5.4-mini` and the installed Codex CLI (0.128.0) is too old for `gpt-5.6-luna`.
The Codex CLI marks each directory it runs in as trusted in `~/.codex/config.toml`; the harness removes the entries under its own temporary root when a real-provider environment is disposed.
The fake provider CLI does not need Grok installed, but it must answer the adapter's detection call (version check) the way the real binary does.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Fakes drift from real Telegram or provider behaviour, giving false greens. | Same scenarios run on both Telegram backends; contract suites on recorded real data; T3 re-records; mismatch fails the build. |
| Harness seams (base URL, TTLs, build directory) weaken production. | Active only under `AGENT_CONSOLE_HARNESS=1`, loopback-only, with guard tests; production defaults untouched. |
| Tests pollute the real database again. | Guard refuses the real root; orchestrator always sets a temporary root; a check fails the run if the real database changed. |
| Harness interferes with the operator's running app. | Separate root, `.env`, ports, build directory and bot; guard refuses the operator's bot; H1 and H6 definitions of done require the app to keep running undisturbed. |
| Real Telegram timing makes T3 flaky. | Event-based waits with generous limits; T3 is not a per-commit gate; burn-in applies to T3 scenarios too. |
| Screenshot tests become noisy. | Masked dynamic regions, fixed fonts and viewport, fixed fixture data, agent review of diffs before any human involvement. |
| T3 user-client session is a powerful credential. | Stored outside the repository, never logged, included in the token sweep, revocable from Telegram's active sessions. |
| Suite becomes slow and gets skipped. | Runtime targets per tier; serial first, a second worker only when T1 exceeds its target. |

## 12. Test case design and coverage ownership

Decided 2026-09-14.
The harness only runs what it is given; the quality of verification depends on who designs the cases and how completeness is enforced.
Test cases are derived from the specification, before the code exists, by someone other than the implementer.

### 12.1 Roles

| Role | Owns | Does not own |
| --- | --- | --- |
| Operator (jd) | Risk priorities; accepting, trimming or extending the scenario table of product-facing slices (the Claude defect fix, L1 scenarios, L3 slices and later product work). Reviews a table, not test code (about 5 minutes per slice). Harness-internal slices (H0 to H4, H7 to H9) still get a scenario table, checked by the review pass instead (decided 2026-09-14). | Writing or reading test code. |
| Test-design pass: a separate agent session, before implementation | Derives the scenario table for the slice from its requirement IDs (RTC), decision points (B-rows), acceptance scenarios (T-rows), user-flow sections and verification rows (H-rows): happy path, every failure path, races, restarts, duplicates, authorization and secret exposure. Works from documents and existing public interfaces only, never from the new implementation. | Implementation choices. |
| Implementing agent | Writes the scenarios so they fail before the code exists, builds until they pass, adds code-level tests for branches the specification does not mention, keeps all scenarios passing burn-in. | Deciding a spec-derived scenario is unnecessary; removing one needs the operator's agreement. |
| Review pass: `/code-review` or a reviewer agent, after implementation | Challenges gaps: IDs without scenarios, failure paths asserted only in the UI, assertions that cannot fail, unexplained uncovered branches, surviving mutants. | Rewriting the implementation. |
| Harness | Runs scenarios, generates the coverage matrix and code coverage, enforces the gates below. | Judging whether the scenario set is sufficient. |

### 12.2 Scenario table

The test-design pass writes one table per slice, stored with the slice's plan (for L3, in the Telegram engineering plan or a linked file):

| Column | Meaning |
| --- | --- |
| Scenario ID | Stable ID, for example `S-L3-B-04`. |
| Covers | Requirement, decision, acceptance and verification IDs, for example `RTC-24, B30, H-L3-03`. |
| Kind | Happy path, failure path, race, restart, duplicate, authorization, secret, UI quality. |
| Given / when / then | Setup, action, and the observable result on each relevant layer (phone, browser, durable state). |
| Tier and backend | T0, T1, T2 or T3; fake, real or both. |
| Priority | Must or should, set by risk; the operator can change it. |

### 12.3 Requirement coverage: the gate

- Every scenario declares `covers` metadata with the IDs from its table row.
- The reporter generates a coverage matrix: each requirement, decision and verification ID in the slice's scope, the scenarios covering it, and their latest result per tier and backend.
  The matrix is generated output and is never edited by hand.
- A slice cannot close while any in-scope ID has no passing scenario, or no passing failure-path scenario where the ID has a failure mode.
- Must-priority scenarios block closing; should-priority scenarios that are missing are listed in the change summary.

### 12.4 Code coverage: a gap finder, not a target

- Collect V8 coverage from the T0 test runner and, via `NODE_V8_COVERAGE`, from the harness server process during T1; merge them into one report with source maps.
- No percentage gate, because percentage targets invite tests written to hit lines rather than to check behaviour.
- For files changed in the slice that belong to critical modules (task control, answer handling, start intents, the Telegram runtime and adapter, migrations), each uncovered branch is either covered by a new test or explained in the change summary.

### 12.5 Assertion quality: mutation testing

- Slice H9 introduces mutation testing on critical modules at milestone close-out.
- A surviving mutant (for example, a removed revision check that no test notices) is killed with a new or stronger test or explained.

### 12.6 Slice workflow

1. Test-design pass writes the scenario table from the specification.
2. Operator skims it and adjusts priorities.
3. Implementing agent writes the scenarios; they fail.
4. Implementing agent builds the slice until they pass, then adds branch-level tests for uncovered code in critical files.
5. Harness produces the matrix and code coverage report; burn-in passes for new scenarios.
6. Review pass challenges gaps; findings are fixed or explicitly accepted.
7. Change summary cites the matrix result, uncovered-branch explanations and, at milestone close-out, the mutation report.

Cost accepted: a separate test-design session per slice and mutation-testing time at milestone close-out.

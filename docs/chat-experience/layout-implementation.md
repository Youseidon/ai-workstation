# Chat layout implementation

Implemented 19 November 2026, following the reviewed layout redesign plan.

## Delivered experience

- Chat has its own shell: one 272 px thread sidebar, an 880 px centered conversation and an aligned compact composer. An optional 1040 px width lives in Conversation options. Other pages retain their existing shell.
- Chat no longer renders the global header, top agent dock, horizontal tabs, transcript toolbar, exchange headers or enclosing answer cards. Assistant answers use open text; user messages use subtle, borderless bubbles. Chat text is sized independently of the application's smaller console typography.
- The sidebar provides workspace selection, New chat, title search, pinned/recent/archived conversations, rename, pin and archive. App destinations are in the shared section switcher at the top of the sidebar (see `docs/app-layout-unification-plan.md`). Working, waiting, failed and unread states remain discoverable. Active agents have a Stop action, and decisions remain actionable beside the composer.
- A mobile drawer replaces the sidebar below 1024 px. It closes with Escape, contains keyboard focus and returns focus to its trigger. Row menus escape the list's clipping boundary and remain inside the native dialog when used in the drawer.
- The composer keeps the provider/model, Ask / Run, context, work-item attachments, input options and Send / Stop together. Run remains the existing default. Context and notes to the active run open on demand. Examples fill a draft instead of immediately launching a writable run.
- Drafts survive thread switches, workspace switches and reloads, including an unsent new conversation. Failed sends, quoted follow-ups, queues, Stop-and-send, IME input and deliberate input expansion retain their existing behavior. Cancelling a queue or rejecting a changed queue scope restores its text alongside any new draft.
- Assistant activity and original events remain inspectable, and the execution log is available through Conversation options. Long conversations gain an on-demand prompt outline.
- Reading positions use stable message/block anchors rather than only a scroll offset. Streaming, input resizing and older-history loading preserve a detached reader's position. Jump to latest is separate from the New reply indicator; restoring or prepending history does not manufacture unread replies.

## Persistence and loading

Schema migration 42 adds a workspace-scoped `chat_thread` metadata table and indexes, backfills existing Chat threads from their runs, and installs triggers to associate future turns. Rename/pin/archive/read metadata persists on the server. Renamed titles also appear in restored session summaries and Activity.

Run rows and normalized events remain the authoritative conversation record. This migration adds metadata without rebuilding or dropping existing tables. It runs through the application's existing migration mechanism on backend startup.

The workspace API now provides:

- `GET /api/workspaces/:workspace/threads`: title search, archive filter and cursor pagination; 50 summary rows per page.
- `PATCH /api/workspaces/:workspace/threads/:thread`: validated title, pin, archive and bounded, monotonic read acknowledgements.
- `GET /api/workspaces/:workspace/threads/:thread/history`: 12 runs per page, fetched when the selected conversation needs them.

The sidebar never fetches transcripts to power title search or list history. Thread and history cursors are scoped to the workspace/conversation. Prepending history preserves chronological turn order and cannot replace a newer native provider session with an older one. Opening a new draft no longer adopts unrelated Pipeline runs; explicit Open in Chat links retain that behavior.

## Verification

- Shared, server and web type checks pass.
- Shared and web suites pass. The complete server regression run passed all 400 tests; focused library and workspace-API checks also pass after the final metadata changes and added HTTP coverage.
- Lint passes for the changed Chat, shell, composer, model/menu and browser-fixture files. `git diff --check` passes.
- `npm run verify:contrast` passes for Midnight, Deep and Daylight, with minimum checked ratios of 4.56:1, 4.52:1 and 4.53:1 respectively.
- The production webpack build passes. The environment requires allowing Next.js's TypeScript subprocesses outside its process sandbox.
- `scripts/verify-chat-browser.mjs` passes for all six provider rendering fixtures: streamed answers, pending sends, Markdown/code, failures and recovery, drafts, modes, queues, quotes, input sizing and detached scrolling.
- `scripts/verify-chat-page-browser.mjs` passes against the assembled page and shell: lazy history, independent drafts and reloads, rename/pin/archive/search, workspace continuity, history anchors, outline, model-menu behavior, row-menu placement, mobile focus, enlarged text, 320 px reflow and all themes.
- The assembled fixture exercises 200 rendered turns and a 1,000-thread library. Only the first summary page loads initially; loading the next page retains existing rows. Measured reload-to-content time was approximately 0.7–1.0 seconds and the synchronous scroll handler approximately 0.7–1.0 ms in local headless Chromium. These are fixture measurements, not provider or production latency guarantees.

Browser checks use local API/router/console fixtures and temporary profiles. They do not launch live agents. The server suite uses temporary databases and fixture workspaces. Chromium and process-spawning server tests require permissions beyond this environment's default process sandbox.

## Deliberate scope

Search covers conversation titles in the current workspace. Transcript retention and the existing per-run event cap still apply; the new history paging loads earlier runs, not events that retention already removed. Drafts and reading anchors remain browser-local; thread metadata persists on the server.

Visited conversations stay mounted during the page lifetime to preserve queued messages and in-progress composer state. Merely appearing in the history sidebar does not mount or restore a conversation. Browser fixtures exercise the real page/components with mocked services; they do not replace a live-provider integration check or physical-device keyboard testing.

Branching and saved decisions remain later work, as proposed in the reviewed plan. The companion HTML sketch remains fictional design reference material.

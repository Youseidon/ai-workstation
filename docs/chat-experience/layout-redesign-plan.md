# Chat as the heart of the app

> **Superseded.** The Chat-only shell described here became the shared application shell. `TopBar`, `AgentDock`, the old `Sidebar`, `chrome.tsx` and `ThreadSidebar` no longer exist, and the Workspace tools menu became the section switcher. See `docs/app-layout-unification-plan.md` for the current layout.

Status: accepted and implemented, 19 November 2026. The sections below retain the reviewed design. See [implementation and verification](layout-implementation.md) for the delivered behavior and checks.

## Recommended direction

Give Chat a dedicated conversation layout: one useful sidebar on the left, a generous centered conversation, and a compact composer at the bottom of that same column. Remove the page header, transcript toolbar and decorative message containers. Make reading, writing and returning to conversations the primary interactions.

“No footer” means no page footer, statistics strip or help bar under the conversation. The message input remains available at the bottom; its model and mode controls belong inside it. The left sidebar can hold workspace navigation and connection status without adding anything across the conversation canvas.

This proposal supersedes the visual layout in the earlier `chat-experience-plan.md`. That plan's transcript, continuity and reliability work remains the foundation. This is a new layout and interaction pass, not a proposal to rebuild those capabilities.

## What exists today

These findings are from the current working tree, including its existing uncommitted changes. This is a source audit, not an inspection of the running full application. Earlier verification results in `implementation.md` have not been rerun for this proposal.

| Current surface | Effect on the experience | Target |
| --- | --- | --- |
| `AppShell` always renders `TopBar`; `AgentDock` appears below it while agents run. | The conversation loses height and changes position when activity starts. | A Chat-specific shell with status in thread rows and the current turn. |
| `app/page.tsx` renders open conversations as horizontal tabs. The existing left sidebar is app navigation. | Long titles compete for horizontal space; old conversations are primarily reached through Activity. | One combined sidebar that gives threads most of its space. |
| `ConversationPanel` has a permanent Conversation / Execution log / collapse / width toolbar. | Reading is preceded by controls that are rarely needed. | Secondary actions in a thread menu and an optional long-thread outline. |
| `ConversationExchange` adds a sticky numbered header, outer card, user card, answer card, accent border and repeated prompt reference. | A conversation looks like a stack of reports. Many edges and labels repeat information already conveyed by order. | Open assistant text, a subtle user bubble and natural spacing between turns. |
| The canvas supports 1120 px and 768 px widths. | A useful width foundation exists, but borders, insets and metadata consume much of it. | Start at an 880 px conversation width and assess it with real prose, code and tables. |
| `Composer` has a mode row, context disclosure, inset input, action row and provider/path footer. | Routine typing occupies several separate visual bands. | One input surface with one compact control row. |
| Markdown, streaming, quotes, queued sends, draft recovery, recorded context and per-thread reading positions already exist. | The redesign can reuse substantial behavior. | Preserve these features and improve how they are reached. |
| `/api/sessions` returns run summaries, including thread IDs, but has no thread-management operations. The page's open-tab list lives in local storage. | Moving tabs to the left alone would still produce a list of open tabs, rather than a complete conversation library. | A durable, workspace-scoped thread index with lazy transcript loading. |

## The screen to aim for

### One left sidebar

Use a single sidebar, initially 272 px wide, instead of adding a second permanent panel next to the app's existing navigation.

- At the top: the existing workspace switcher, New chat, and Search chats.
- In the main area: pinned conversations, then recent conversations grouped by Today, Yesterday and Earlier. Each row is a plain title with a quiet selected background. Show a short state label only when useful: Working, Needs answer, Failed, or unread activity.
- Put rename, pin and archive in a row menu available to keyboard and touch as well as pointer users. Archiving changes library visibility; it does not delete transcripts or stop an agent. Threads awaiting input remain easy to find even if archived.
- Keep app destinations reachable through a compact Workspace tools menu at the bottom: Pipeline, Activity, Changes, Report, Agents and Workspaces. Theme and connection controls live here too. Keep visible text labels in the menu rather than relying on unfamiliar icons.
- Collapsing the sidebar frees the entire column and leaves a small accessible navigation toggle. Remember the preference.
- Use the selected workspace as the default thread scope. Switching workspaces restores its last active conversation. Search initially covers titles in that workspace; full transcript and cross-workspace search are later enhancements.

New chat immediately opens a draft in the current workspace. Workspace selection is not a required extra step for every conversation. Draft-only chats can remain local until the first accepted send; failed sends retain their draft and provisional ID.

### A quiet central reading area

- Center the conversation in the remaining content area, rather than against the full viewport. Use an initial 880 px maximum, 24–40 px desktop gutters and 16 px mobile gutters. Keep a wider 1040 px option in the thread menu for code-heavy work.
- Start with 16–17 px sans-serif text and approximately 1.65 line height, using the existing font and theme system. Tune with actual answers instead of increasing every label and control.
- Render assistant prose directly on the page background. Remove the exchange border, answer background, colored left edge, exchange number, sticky exchange header, “Agent / Response” heading and repeated “In reply to” excerpt.
- Keep user text in a lightly tinted, borderless bubble toward the right of the same column. Long messages use more of the width and keep an explicit Show more affordance when collapsed.
- Identify the responding provider once near the start of an answer, and when identity changes. Exact models, timestamps, tokens and run IDs belong in details. The composer identifies the provider/model for the next message.
- Use spacing to separate turns. Reserve container styling for code, necessary tables, attached content and decisions.
- Put Copy, Quote and More in one quiet action row after an answer. Essential actions remain available without hover. Keep View changes when a recorded change set exists.
- Empty chat has a short invitation and an immediately usable input. Example prompts may fill a draft; they should not launch a writable run on click. After the first message, the invitation disappears.
- Keep a semantic page heading for assistive technology even though no visible page header is rendered. Document title and sidebar selection identify the active conversation.

### One obvious place to type

Use one rounded input surface with no nested border or permanent path/statistics footer. It should feel like writing a message, with the important execution choice still visible.

- Text area first, then one compact row: provider/model picker, Ask / Run mode, context/attachment action, and Send or Stop. A selected work item or quote adds a removable chip only when present.
- Preserve explicit mode wording: Ask is read-only; Run can change the workspace. Keep the current default in the first layout release. Changing the default is a separate product choice, particularly because Cursor cannot Ask.
- Keep the full workspace path, context package, fresh-context option and advanced model controls in a popover or drawer. Workspace identity remains visible in the sidebar and in its mobile equivalent.
- Retain IME-safe Enter, Shift+Enter for a newline, accepted-send reconciliation, recoverable drafts, drafting during a run, queued sends and Stop-and-send.
- Show queue controls when they are relevant, rather than permanently adding a row. Keep the distinction between writing a draft, adding a note to the active run, and stopping then sending another turn.
- Put the existing “btw” interaction behind a clear “Send note to current run” action while running. Show its delivery state inline when used; preserve provider capability differences.
- Let input grow to a reasonable cap, with deliberate expansion for long writing. Start with an ordinary idle composer height around 110–140 px on desktop and verify that the transcript retains most of the screen.
- Pending questions, approvals and launch failures stay visible above the input when action is required. They never disappear into the activity disclosure.

### Scrolling that respects the reader

The conversation has one primary vertical scroll region. The thread list scrolls independently; command output and oversized code/tables can have their own bounded scroll regions. Avoid stacking scrollable cards inside ordinary messages.

- Follow streaming output while the user is at the latest content. Scrolling upward detaches follow mode; incoming tokens must not pull the reader back down.
- Show “Jump to latest” whenever detached. Add “New reply” only when content actually arrives after detaching; the current component labels any detached position as a new reply.
- Restore position by a stable turn/block anchor and offset, with a fallback when content is unavailable. Raw `scrollTop` alone is fragile after font changes, wrapping, history loading and expanded evidence.
- Preserve the visible anchor when loading older history or opening evidence above it. New history loads near the top without forcing a jump to the beginning or bottom.
- Align the composer with the conversation and reserve its space outside the scroller so it cannot cover the last lines. Resizing the input or opening the mobile keyboard must preserve the reading position.
- A submitted message gets immediate local feedback and brings its pending turn into view. Restored history and background updates must not be mistaken for fresh submissions.

## Innovations worth including

The first release should make familiar chat behavior excellent. Add distinctive features where they remove actual effort.

| Interaction | User benefit | Delivery |
| --- | --- | --- |
| Resume where I was | Returns to the last reading anchor, with a truthful unread marker and jump action. | First release; strengthen the existing behavior. |
| Work behind the answer | One line such as “Read 4 files · Ran 2 commands” expands to real recorded activity. Live state uses the latest reported action. Failures remain prominent. | First release; simplify existing evidence presentation. |
| Quote to continue | Quote a selected passage into the input while preserving the draft. | First release; polish the existing action. |
| Jump through a long conversation | An on-demand outline of user prompts lets users navigate without collapsing the transcript into cards. | After the core layout; only appears for long threads. |
| Continue with another model | Change the next provider while preserving recorded context and historical attribution; make missing/trimmed context inspectable. | Preserve existing handoff now; improve its presentation next. |
| Branch from this message | Opens an alternative conversation from a chosen turn while retaining the original. Clearly describes the inherited context. | Later; needs a real branch/context contract. Branching does not revert workspace files. |
| Save a decision | Explicitly save a chosen statement as inspectable future context. | Later; needs editing, removal and scope controls. |

Avoid automatic summaries, extra dashboard cards and a permanent right inspector in the initial layout. They would consume the attention and space this redesign is intended to recover.

## Technical plan and boundaries

### 1. Conversation shell and sidebar — highest visual impact

Introduce an explicit conversation shell variant for the Chat route. Let it replace the normal sidebar content and omit `TopBar` and the visual `AgentDock` on this route. Keep run subscriptions and decision handling mounted at their existing provider level. Rehome active-run indicators, Stop and input-required actions before removing the dock from Chat.

Likely touchpoints: `shell/AppShell.tsx`, `shell/Sidebar.tsx`, `shell/chrome.tsx`, `app/page.tsx`, and new `chat/ThreadSidebar.tsx` / thread state helpers. Other routes keep their current shell. Share navigation destinations so the new tools menu cannot drift from the normal sidebar.

Replace the horizontal tabs with sidebar rows while retaining stable thread/tab IDs, deep links, workspace ownership and current per-thread drafts. Preserve mounted thread instances in this first slice to limit behavior changes; later bound inactive instances and move durable drafts/view state into a dedicated store.

Completion gate: Chat has no horizontal header or tab strip; every existing destination and active decision remains reachable; switching threads does not interrupt a run or lose a draft.

### 2. Open transcript and compact composer — highest reading impact

Simplify `ConversationExchange.tsx`, `ConversationPanel.tsx`, `Composer.tsx` and the chat rules in `globals.css`. Reuse `AssistantContent`, conversation projection, tool evidence and submission logic. Move log/width/detail actions into secondary controls. Replace whole-exchange collapsing with natural reading and optional prompt-level expansion.

These components also serve Activity and browser fixtures. Give shared components explicit presentation options where necessary; review Activity's restored transcripts instead of assuming Chat-only CSS is sufficient.

Completion gate: answers have no enclosing card or repeated prompt label, the input has one primary surface, code remains copyable, and warnings/questions remain visible in all themes.

### 3. Durable conversation library — required for the complete sidebar

Group existing sessions by workspace and thread ID, not run ID or provider session ID. Keep saved work-item and legacy sessions without a Chat thread in Activity, with their existing explicit Open in Chat flow. Preserve existing route parameters and run ownership, including Pipeline deep links.

Add a small durable thread metadata record for title override, pin/archive state and updated time, with a paginated workspace-scoped summary API. Backfill from existing runs conservatively. Store unread/last-read semantics explicitly; browser view position and drafts can remain per-browser. Define unread as new assistant content or a decision since the last acknowledged read, rather than every streaming token.

Fetch summaries for the list and transcript content for the selected thread. Load older runs/events incrementally. The existing session endpoint deliberately returns summaries without transcripts: preserve that separation. Do not fetch every transcript to power search, or restore every historical conversation merely because it appears in the sidebar. Title search and rename/archive updates must be scoped to the owning workspace.

Completion gate: a conversation closed in the old tab UI still appears in history; reload restores the selected thread; rename/pin/archive persist; large histories do not require loading every transcript.

### 4. Reading stability, mobile and release verification

Below an initial 1024 px breakpoint, turn the sidebar into an accessible overlay drawer. Use a small floating navigation control rather than a replacement header bar. On opening, expose workspace/thread identity in the drawer. Close on Escape, return focus to the trigger and contain focus while modal. Use a drawer width that fits 320 px screens.

Add anchor restoration and truthful unread tracking, verify streamed rendering under sustained updates, and test mobile keyboard behavior. Only add virtualization if measurement justifies it; text selection, browser find and anchor navigation must remain usable.

Completion gate: comfortable use with touch, keyboard, zoom, long answers and concurrent background runs. Do not declare the complete redesign finished until durable history and mobile reading behavior pass.

## Acceptance criteria

- Desktop at 1440 × 900: a single thread sidebar; centered, open answers; no Chat header, top agent strip, horizontal tabs, transcript toolbar or page footer. The idle composer stays compact.
- Conversation widths from 320 px through desktop, plus 200% text and 400% zoom: ordinary prose requires no horizontal page scrolling. Code/tables overflow only inside their own regions. This follows [W3C's reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
- A modal mobile drawer follows [W3C's dialog keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): focus enters the drawer, stays inside, closes with Escape and returns to the trigger.
- Midnight, Deep and Daylight retain readable text, clear focus and distinguishable user messages. Honor reduced-motion settings.
- Reading older messages remains stable during streaming, history prepend, input resize and evidence expansion. A reopened thread returns to its anchor.
- Pending, working, stopped, failed, disconnected and input-required states remain truthful. Active work in another thread is discoverable without adding a top bar.
- All supported providers retain correct historical identity and mode/capability handling. Drafts, queues, accepted-send recovery and provider handoff keep working.
- New chat, search, rename, pin, archive, workspace switching and existing Pipeline/Activity deep links work with old and newly created threads.
- Update `verify-chat-browser.mjs` and browser fixtures: several existing assertions deliberately require bordered answer cards and collapse controls, which conflict with this design. Keep their behavioral coverage while changing those visual expectations. Add coverage for the real shell/thread list, because the current harness primarily exercises isolated conversation/composer components.
- Validate with a long representative thread and a large summary list; record scroll responsiveness and loading behavior. Use results to decide if pagination or rendering budgets need further work.

## Decisions proposed for review

1. One combined 272 px sidebar, prioritizing conversations; other app destinations remain in Workspace tools.
2. An initial 880 px reading column, open assistant text and lightly tinted user bubbles.
3. No visible Chat page header or footer; the aligned message input remains available at the bottom.
4. One compact composer with explicit Ask / Run and the next provider/model visible; preserve the current default for this release.
5. Implement the four slices above, beginning with shell and reading improvements. Keep branching and saved decisions separate from the core redesign.

The companion layout sketch uses fictional messages and activity. It is a design aid, not a connected chat or a claim about completed work.

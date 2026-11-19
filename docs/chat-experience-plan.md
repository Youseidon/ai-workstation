# A smoother one-on-one AI chat

Status: proposal for review. Implementation starts after your sign-off.

## Recommended direction

Make Chat a comfortable conversation surface: distinct user messages, beautifully rendered answers, one clear place to see the active agent, and expandable evidence of the work behind each answer.

The conversation should answer three questions immediately: **What did I ask? What is the answer? Is anything waiting for me?** Commands, timestamps, usage and execution details should remain easy to inspect without occupying every line.

Deliver the core experience across all six providers. Keep one app-owned visual language; let each model retain its own words and personality.

## What the code review found

These findings come from source inspection, not a live visual audit.

| Finding | Implication |
| --- | --- |
| `web/components/LogEntry.tsx` renders assistant text with `whitespace-pre-wrap` and `{item.text}`. | Valid Markdown is displayed literally. The first fix belongs in the renderer, not in instructions telling every model to format differently. |
| Its `Gutter` reserves 232 px for time, avatar and provider/model on almost every entry, including user prompts. | Repeated metadata consumes reading space and can make user input look agent-authored. |
| Tools already support expansion, but each tool remains a separate transcript entry with its own gutter. | Reuse the existing evidence; group its presentation around the conversation turn. |
| `web/lib/log.ts` already merges deltas by block/run and pairs tool calls/results. | Add a conversation projection on the existing normalized events rather than replace the transport. Tool matching needs run-scoped identity review. |
| `shared/src/index.ts` distinguishes message/thinking text and carries optional final text in `result`. `LogItem` currently discards final result text. | Preserve available answer information. Audit final-only and duplicate-final cases with provider fixtures before choosing display rules. |
| `react-markdown` and `remark-gfm` are already installed. Saved work items already have Markdown styles. | Reuse the existing parsing stack; give chat its own typography and code components. |
| `LogPanel.tsx` already detaches auto-scroll when someone scrolls upward. | Preserve this behavior and improve its handling of expanding content and new-message counts. |
| Custom Run messages have durable thread IDs and per-provider session continuation; Activity can reopen them. Ask launches an independent consult without a thread/resume payload. | Conversation memory is partly implemented. Conversational Ask and switching providers require deliberate backend work. |
| `Composer.tsx` clears typed text after invoking send callbacks; those callbacks return no acknowledgement. | Keep a recoverable draft until the server accepts the turn. |
| Chat and Activity share `LogPanel`. Three themes and a contrast verification script already exist. | Introduce the reading view deliberately and validate history as well as live chat in Midnight, Deep and Daylight. |

## 1. Establish one response format

Introduce an `AssistantContent` component used for both streaming and restored chat messages.

- Render paragraphs, headings, bold/italic text, ordered and unordered lists, nested lists, links, quotes, tables and task lists consistently.
- Use a readable sans-serif face for conversation, approximately 16 px with 1.6 line height and a 68–76 character reading width. Reserve monospace for code and command output.
- Cap heading sizes so a provider's `# Heading` cannot dominate the whole screen.
- Render code in a distinct block with language label, accurate Copy, syntax highlighting and optional wrapping. Long blocks can collapse; tables and code scroll inside their own containers on narrow screens.
- Keep literal symbols inside code, paths, shell syntax, equations and quoted examples intact. Do not remove `#`, `*`, `-` or `)` with a blanket replacement.
- Standard Markdown parsing will not fix genuinely malformed `*)` bullets. Add a narrowly scoped compatibility rule only for demonstrated, repeated provider patterns in prose. Keep original text available through Copy original / Show source; ambiguous content remains literal.
- Remove transport decoration such as ANSI control sequences at a tested adapter boundary, retaining source evidence. Never rewrite command arguments to make them look cleaner.
- Treat model output as untrusted content: no executable HTML; restrict links to supported destinations; route workspace file links through existing app navigation where available. Remote image loading should be deliberate.
- Stream without repeatedly rebuilding settled blocks. Accommodate both append-delta providers and whole-block replacement providers. An unfinished code fence must not break the surrounding layout.

Formatting should not require another model call. This keeps the original meaning, avoids extra latency, and adds no model usage for presentation.

## 2. Organize the screen around conversation turns

**User messages:** a softly tinted card aligned toward the right within the reading column, marked “You.” Short prompts size naturally; long prompts can use most of the column. Use dedicated foreground/background tokens for all three themes. Color is reinforced by label, spacing and alignment.

**Assistant messages:** left-aligned, open reading space with generous paragraph spacing. Avoid enclosing every paragraph in a bubble. One run may contain several chronological messages, activity groups and questions; they belong to one assistant turn.

**Agent identity:** one compact provider/model picker near the composer, clearly representing the *next* reply. Show the actual responding provider/model at the first assistant turn and when it changes, including fallbacks. Historical identity always comes from stored events. Every turn has an accessible details control for its exact model and run information.

**Time and statistics:** remove the repeated left gutter. Use day separators where useful and a compact turn footer for elapsed time. Exact timestamps, token counts and detailed usage live in turn details. A live session status can remain visible once.

**Two views:** Conversation is the default. A secondary “Execution log” action exposes the existing chronological transcript for detailed inspection, preserving the selected turn and scroll position on return. This is one underlying record with two presentations.

## 3. Put activity behind the answer, with meaningful visibility

Use an expandable activity summary within each turn:

> Read 4 files · Ran 2 commands · Updated 1 file

While work is underway, it reports the latest observed action, such as “Reading the authentication tests.” Counts and descriptions come from tool events; unknown tools keep their real names. No invented percentage-complete bar.

- Successful consecutive tool actions group into compact activity sections. Preserve their position relative to assistant commentary and questions.
- Expand a section to see the actual command/input, output, exit status and event time. Keep output readable at normal contrast, rather than using faint text as the main hierarchy cue.
- Failures surface a visible summary even when activity is collapsed. Resolved failures may settle into history; unresolved failures remain obvious.
- Questions, approvals and other blocking decisions remain in the conversation with their actions. They never disappear into a closed drawer.
- Provider-supplied progress/reasoning output can appear in a labeled expandable section. Display only information actually supplied; do not imply access to hidden reasoning.
- Keep assistant commentary visible unless explicit metadata identifies it as a different channel. Do not guess that the last paragraph is the only answer or hide paragraphs because they mention shell commands.
- A turn ending without answer text gets a truthful completion, stop or failure message with activity available. It must not leave an unexplained blank space.

The distinctive interaction is **answer → evidence**: a compact “View changes” or “View command result” link beside an answer opens the relevant recorded evidence. Initially use explicit run/tool/change-set relationships; do not infer proof from the assistant's confidence or a command's exit code alone.

## 4. Make the conversation feel immediate and continuous

### Input and streaming

- Echo the user's submitted message immediately with a small “Sending” state. Reconcile it with the server response using a stable request identifier.
- Retain the draft until acceptance; restore it on launch failure. Reconnect must reconcile pending/accepted turns without silently submitting a second writable run.
- Keep focus in the composer after send, support multiline input, and make Enter behavior safe during IME composition.
- Replace the central launch overlay with status inside the pending turn: Sending → Starting → Working. Users can continue reading and drafting.
- Allow drafting while the agent works. Sending during a run offers explicit “Send after this reply” or “Stop and send”; queued writable turns must pass current workspace, provider and permission checks at execution time.
- Preserve partial answers after Stop, show a stopped state, and provide a clear way to continue. Retry of an action-capable turn is explicit and does not imply undoing previous commands.
- Follow incoming text only when the reader is at the bottom. Otherwise show “New reply” with a jump control and preserve the reading anchor when content expands.

### Actual conversational memory

- Preserve existing custom Run continuation and durable history.
- Add durable thread association for conversational Ask, separately from saved-work-item consult behavior. Conversation sessions must be scoped by workspace, thread, provider and permission mode so an Ask cannot inherit writable capabilities.
- Reuse native provider sessions where supported and compatible. Otherwise supply a bounded, recorded context package containing relevant user/assistant exchanges and explicit attachments.
- Treat changing providers as a context handoff. “Continue with conversation context” is the recommended choice; “Start fresh” is available. Returning to an earlier provider must include intervening turns, not silently resume stale context.
- Expose a small “Context” control listing what the next message will include. Make missing or trimmed history visible. Respect transcript retention and handle expired provider sessions explicitly.
- Keep Ask and Run as deliberate modes with clear descriptions: “Research and discuss” versus “Can change this workspace.” After conversational Ask works, default new one-on-one chats to Ask; retain existing behavior for saved work and existing threads. Unsupported provider/mode combinations explain themselves without silently falling back to a writable mode.

This is a real conversation feature, not just a visual redesign, and deserves its own implementation slice.

## 5. Add a few useful innovations

| Feature | Concrete interaction | Priority |
| --- | --- | --- |
| Answer-linked evidence | Open a recorded command or Changes view directly from the relevant turn. | First release |
| Quote to follow up | Select text or use a message action, then insert a removable quote into the composer without losing the draft. | First release |
| Understandable context | Inspect which exchanges, workspace and attachments will inform the next reply. | First release, with continuity |
| Reading position memory | Reopening a thread returns to where the user was reading; unread replies have a jump target. | First release |
| Conversation outline | For long threads, open a compact list of user prompts and navigate to a turn. It is absent from short chats. | Follow-up release |
| Branch from here | Edit a prior prompt or ask another model in a new branch; preserve the original conversation. Branching never implies reverting workspace files. | Follow-up release |
| Pin a decision | Save an explicit user-approved fact or decision as inspectable context for future turns. | Follow-up release |

Avoid filling the first release with unsolicited suggestions, automatic summaries or permanent sidebars. Each addition should reduce work for the user.

## Implementation sequence

Each slice is independently reviewable. Sign-off on this proposal authorizes the agreed sequence; routine slices do not need repeated permission requests.

| Slice | Deliverable and likely files | Completion gate |
| --- | --- | --- |
| A. Transcript contract and fixtures | Inspect all six adapters; add conversation projection in `web/lib/conversation.ts`; extend shared event metadata only where justified. Preserve final text and run-scoped tool identities. | Equivalent live and replayed turns, no duplicate final answer, no cross-run tool matching, lossless access to original events. |
| B. Readable conversation | `ConversationPanel`, `ConversationTurn`, `UserMessage`, `AssistantContent`, `CodeBlock`, `TurnDetails`; integrate with `ChatWorkspace`; theme tokens/styles in `globals.css`. | Markdown renders correctly, user cards stand out in all themes, repeated gutter disappears, historical provider identity remains correct. |
| C. Activity and evidence | `TurnActivity`, integration with `DecisionDeck` and Changes; explicit answer/progress handling where supported. | Commands are expandable and readable; failures/questions remain visible; evidence links identify actual recorded work. |
| D. Composer and continuity | `Composer.tsx`, `agentConsole.tsx`, thread persistence, `runService.ts`, adapter capability handling and shared message types. | Pending sends recover; Ask follow-ups retain context; switching providers/modes is truthful; no duplicate write on reconnect. |
| E. Smoothness and rollout | Quote follow-up, scroll anchoring, reading-position restoration, keyboard/touch behavior, rendering budgets and regression checks. | Acceptance matrix below passes; restore and Activity paths work; old transcripts retain a useful fallback. |

Start with A–C for the largest immediate improvement in appearance. Complete D–E before calling the new one-on-one experience finished. Sequence later innovations separately so they do not delay these basics.

Use existing `NormalizedEvent`/`LogItem` data as the foundation. The projection should expose stable turn IDs, ordered blocks, provenance, status and activity references. Keep original events authoritative. Add optional fields compatibly and give older transcripts a conservative fallback when channels or final-answer markers are absent.

Keep the existing log available during rollout. Move live Chat first, then align reopened conversation history. Develop against the repository's sandbox database and isolated ports; avoid restarting a running production console to preview UI work.

## Acceptance criteria

1. The same Markdown sample has the same visual structure across Claude, Codex, Cursor, Grok, Copilot and Kilo; provider-specific content remains intact.
2. Headings and list markers render correctly; literal shell/code symbols survive Copy exactly. Malformed syntax does not corrupt the rest of a response.
3. A normal answer has no per-line timestamp/provider gutter. User and assistant messages are distinguishable without relying on color alone.
4. Completed activity is compact by default, all command evidence is reachable, and unresolved failures/questions remain visible.
5. Switching model/provider preserves historical attribution; unknown model identity is displayed honestly. Tokens are shown only when reported.
6. Append streams, replacement streams, final-only answers, repeated final payloads, tool-only turns, orphaned tool results and interrupted replies all have deterministic displays.
7. Read-only follow-ups remember the conversation. Switching away from and back to a provider includes intervening context or explicitly explains a fresh start.
8. A failed launch retains the prompt; reconnect neither duplicates the visible turn nor automatically re-executes a writable request.
9. Reading upward, opening activity and receiving streamed text do not steal scroll position or keyboard focus.
10. Midnight, Deep and Daylight retain readable text and controls. Check the new surface/foreground combinations against the project's existing 4.5:1 text-contrast target, including composed tints and muted text.
11. At 360 px width and enlarged text, controls wrap, code/tables contain their own overflow, and there is no page-wide horizontal scrolling. Verify screen-reader labels, focus order and reduced motion.
12. On an agreed reference browser, local message feedback targets under 100 ms. A representative large transcript remains responsive while streaming; establish a measured baseline before setting further performance budgets.

Use behavior-focused unit tests for projection, stream reconciliation and normalization; adapter fixtures for provider differences; browser checks for Markdown, scrolling, input recovery and accessible controls. Extend the contrast script to cover the new colors. Run the relevant test suites, typecheck, lint and build after implementation. Source-text regex checks alone do not verify conversation memory or rendering.

## Decisions proposed for sign-off

- Adopt tinted user cards and open assistant typography as the default layout.
- Show provider/model once for the next reply, with historical attribution on first use/change and details available per turn.
- Collapse successful activity while keeping actionable failures and questions visible.
- Include genuine conversational Ask and provider handoff in the first release, after the visual foundation.
- Keep branching, pinned decisions and the long-thread outline for the follow-up release.

The accompanying interactive sketch illustrates the proposed presentation with fictional conversation content. It is a design review aid, not a running provider session.

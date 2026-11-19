# Chat implementation and verification

The approved A–E sequence is implemented. The review plan and fictional sketch remain separate from production conversation content.

- A: `conversation.ts` projects stable run turns and ordered blocks. Result text is retained, repeated finals are deduplicated, and tool results match run, tool ID and name. Folded delta event identities are retained to make duplicate delivery idempotent. Original normalized events remain in the existing transcript store.
- B: Chat and reopened Activity use the same conversation panel and Markdown components. GFM, safe links, bounded headings, code language labels, highlighting, exact copying, wrapping and contained table/code overflow are supported. User cards have contrast-checked theme colors. Recorded attribution appears at first use and changes, including changes within a turn. Details retain source and usage. No output-rewriting model call or broad punctuation normalization was added.
- C: Consecutive tool activity groups stay in chronological position; expanding reveals actual input/output and exit status. Failures and pending decisions remain visible. Command evidence links open recorded activity. Changes links appear only for matching recorded change sets. The original execution log stays mounted when switching views.
- D: Pending sends use request IDs echoed by server acceptance and live snapshots. Composer instances stay mounted; accepted drafts clear only if the user has not already typed another draft. Unconfirmed submissions are retained separately in session storage. Reconnect never resubmits a run. Explicit queue and Stop-and-send controls revalidate workspace, directory, provider, model, saved context, connection and permissions before sending. The backend also applies its existing launch guards.
- D continuity: Custom conversational Ask has a durable thread association, distinct from saved-work-item consults. Its adapter still receives forced consult permissions. Native continuation requires the immediately preceding turn to match workspace/thread, provider, resolved model, role and recorded permission scope. Otherwise, the next request receives bounded recorded exchanges, including intervening providers. Each context package is recorded in status metadata and inspectable in the conversation. A next-message Context control previews retained exchanges and offers Start fresh. No expired session is automatically retried as a writable request.
- E: Quote follow-up retains the current draft, IME composition does not submit, drafting remains enabled during execution, reading positions are stored per thread, and detached readers get a jump control. Settled Markdown blocks are memoized. Activity restores the same presentation.

## Verification

- Typecheck: shared, server and web pass.
- Full test suite: 98 shared, 352 server and 79 web tests pass (529 total). Includes normalized fixtures for all six providers, stream replacement/deltas, repeated and final-only results, scoped tool matching, interruptions, duplicate delivery, queue-scope validation, exact request acceptance, durable Ask persistence, cross-workspace rejection, native-session scope and provider handoff.
- Production build: `npm run build --workspace web -- --webpack` passes, alongside shared/server build checks. Default Turbopack build was attempted; this environment rejects the worker's local port binding with `Operation not permitted`.
- Contrast: `npm run verify:contrast` passes with the new user-card surface included. Minimum checked theme ratios are Midnight 4.56:1, Deep 4.52:1 and Daylight 4.53:1.
- Lint: the unchanged HEAD baseline and implemented tree both report 22 errors and 3 warnings in existing surfaces. The new chat components, helpers and browser fixture introduce no lint diagnostics.
- Browser regression harness passes against the actual conversation and composer components: Markdown structure and safe content; literal shell-code copying; all themes at 360 px; enlarged text; evidence expansion; IME; retained focus; failed-launch recovery; acceptance; drafting during acceptance; draft recovery after reload; quotes; both views; detached scrolling. The harness isolates components with a console stub and does not launch providers.
- Measured local pending feedback in Chromium: 16–22 ms in the small browser fixture. A 1,000-turn projection measured approximately 0.3–0.5 ms on this machine. These are component/projection baselines, not an end-to-end provider latency guarantee.

Run the browser harness with Playwright available to Node, or set `CHAT_PLAYWRIGHT_MODULE` to an installed Playwright module path. `CHAT_BROWSER_EXECUTABLE` optionally selects an installed Chromium executable:

```sh
node scripts/verify-chat-browser.mjs
```

It writes isolated bundles and screenshots to a reported temporary directory. It does not restart the production console or write to its database.

## Deliberate limits

Context handoff loads at most 13 recent turns, includes at most 12 exchanges within 24,000 characters, and reads at most the latest 200 retained events per run. Oversized or unavailable exchanges are explicitly omitted. Tool output and attachments are not promoted into conversational instructions; workspace/saved-item context continues through the existing context API. Compatible native sessions can contain additional provider-retained history; their actual IDs are exposed in details.

Cursor still cannot Ask because its adapter has no read-only sandbox. The UI explains this and keeps Run explicit. Other expired or rejected native sessions surface their recorded failure; retries remain explicit. Live CLI sessions across all six providers were not launched for this verification. Branching, pinned decisions and a long-thread outline remain the approved follow-up work.

# One application layout

Status: implemented 19 November 2026 (slices 1–4). Verification limits are listed at the end of this status section.

Slice 1 delivered: `lib/navigation.tsx` (the one section registry), `lib/chatController.tsx` (Chat's thread library and open conversations, lifted above routes), `AppShell` + `AppSidebar` + `SectionSwitcher` (one sidebar, one collapse key, one mobile drawer, one `main`), `RunAttention` (sidebar summary, trigger badge and attention drawer that replaced `AgentDock`), and `PageCanvas`/`ContentTitle` (replacing `PageFrame` and `PageChrome`). `TopBar`, the old `Sidebar`, `chrome.tsx`, `ThreadSidebar` and `AgentDock` are deleted; the decorative body backdrop is removed.

Slice 2 delivered: `components/shell/SidebarCollection.tsx`. The shell exposes one collection slot under the section switcher, and a route renders its collection into it from its own tree (a portal), so the collection and its content keep one state owner and one data subscription. Shared `SidebarRow`, `SidebarGroup`, `SidebarBack`, `SidebarEmpty` and `FilterControl` primitives. Activity history and its provider/state/role filters, the workspace library with New workspace, Changes sets and a review's changed files, the Pipeline list, the Pipeline view's suites and the editor's program/suite picker, and the Suite context all render there. Their own 380 px, 256 px, 320 px and 260 px rails and Activity's mobile list/detail bar are removed. Selection is addressable: `/activity?run=`, `/changes/<run>?file=`, `/pipeline/<id>`. The Workspaces page follows the one global workspace, and `WorkspaceUrlSync` now applies `?workspace=` only when the URL changes (it used to revert switcher clicks). `scripts/verify-shell-browser.mjs` checks these routes against a production build with the API mocked.

Slice 3 delivered:
- **One type scale.** The root is 16 px and Chat's compensation is removed (`--app-font-size` is `1rem`). All 450 fixed-pixel text sizes now map onto `text-xs`/`text-sm`/`text-base`, so no essential text is below 12 px. Terminal output is 13 px.
- **Opaque surfaces.** `.glass` is now an opaque surface, `.glow` a plain ring, `.holo` and the Pipeline desk grid are gone, and translucent `bg-surface-N/NN` and `backdrop-blur` are removed.
- **`DetailDrawer`.** One shared drawer, placed by the shell: a docked, non-modal column at 1280 px and wider that leaves focus with the content, and a modal sheet below that. It has one header with tabs and a single Close. It replaces the Pipeline and Suite inspector panels and the inner close buttons in `StationPanel` and `PipelineInspector`.
- **One title/action group per page.** Pipeline uses the name (an input while editing) with the workspace, suite and step counts and the unsaved flag above it. Suite, Changes review and Workspaces also use the record's name. Report has its summary and Refresh. Agents' counts and Refresh usage / Re-detect moved beside the provider list. Stat cards on Report and the Pipeline overview are now plain summary values. Report and Agents have sidebar links.
- **`UnsavedChangesGuard`.** Leaving the Pipeline editor through an in-app link, or reloading the page, asks to save and leave, discard, or keep editing.

Slice 4 delivered:
- **Static ownership checks** (`web/test/shell/ownership.test.ts`): the legacy shell stays deleted and unimported; only `AppShell` renders `main`; there is no Chat-versus-other-pages branch; there are no `aside` rails or fixed overlays outside the shell and UI primitives; there is one navigation registry and one collapse key; and the type scale is 16 px with no fixed-pixel text, blur or translucent surfaces.
- **Remaining gaps closed.**
  - Unsaved Pipeline edits are kept per pipeline in session storage and offered back (Restore or Discard). This covers leaving by browser back/forward, a workspace switch or a closed tab; Discard in the leave dialog clears them.
  - The detail drawer steps aside while the attention drawer is open, with its content kept mounted.
  - `AskChip` opens the consult's own conversation.
  - Legacy redirects keep every query parameter (`web/lib/legacyRedirect.ts`, with tests).
- **One state primitive.** `PageState` is used for loading, invalid-ID, missing-record and error states; `app/not-found.tsx` and `app/error.tsx` render inside the shell.
- **Cleanup.** Obsolete CSS is gone (`.holo`, `.hairline`, `.shell-rail-active`, `.chat-live-dot`, wash/grid tokens), along with the decorative shadow on decision cards.
- **Docs.** The README and the Chat docs describe the shared sidebar.
- **Browser checks**, all against a production build with the API (and, for live runs, the WebSocket) mocked:
  - `scripts/verify-shell-browser.mjs`: collections; URL-owned selection; filters; workspace agreement; back navigation; the drawer docked and modal; the guard and recovery; the live attention drawer (answer, Stop, owner link, one drawer at a time, mobile badge); Chat kept mounted across sections; 320 px in three themes.
  - `scripts/capture-shell-screenshots.mjs`: 150 captures (25 routes and states × 3 themes × desktop/phone) asserting one `main`, one sidebar, a title and no overflow, plus a contact sheet.
  - `scripts/verify-shell-performance.mjs`: 2,000 Activity sessions, 300 pipelines, and a 400-file / 10,000-line diff, each visible in under 4 s with CLS under 0.1 and a scroll under 50 ms; and Chat, Activity and Changes stop polling once you leave them.
  - `scripts/verify-chat-page-browser.mjs`: the 200-turn / 1,000-thread Chat baseline.

Verification limits:
- Every browser check uses fixtures, not a live agent server.
- Mobile keyboard resizing, which tracks `visualViewport`, and physical-device behaviour were not tested on hardware.
- The unsaved-changes dialog covers in-app links and reloads. Browser back/forward is not interceptable in the app router, so those paths rely on the recoverable draft instead.
- Activity renders its full list without virtualization: about 10,000 DOM nodes at 2,000 sessions, within the limits above.

## Direction

Promote the new Chat layout into the application's single shared shell. Every route uses the same sidebar, canvas, typography, spacing, navigation, mobile drawer and attention controls. Remove the old shell and the Chat-only shell exception.

The outcome should feel like moving between sections of one product. Chat establishes the visual language: open content, generous space, quiet surfaces, restrained borders and details available on demand.

## What the source audit found

This is an audit of the current working tree, not a new live visual review. The previous Chat verification results do not establish that the other pages satisfy this proposal.

| Finding | Current ownership | Cleanup required |
| --- | --- | --- |
| `AppShell` checks whether the pathname is `/`, and conditionally removes the old sidebar, header and agent dock. | Chat and other routes have different shell paths. | One unconditional shell for all routes. |
| `ThreadSidebar` owns its own sidebar, mobile dialog, collapse state, workspace switcher, navigation and connection/theme controls. | Chat page owns global interface elements. | Move shell ownership above the route; keep thread rows as feature content. |
| `Sidebar` separately owns workspace navigation and another collapse preference. | Two implementations of the same global behavior. | One sidebar component and one persisted collapse preference. |
| `PageChrome` publishes actions into `TopBar`; several pages also render local headings and controls. | Actions and identity are spread across shell and page. | One content-level title/action pattern; remove the old publishing mechanism. |
| `AgentDock` adds a horizontal strip when work starts and can show a pending decision outside Chat. | Run activity changes the available page height. | Persistent sidebar awareness plus a shared attention drawer, with all pending decisions reachable. |
| Activity adds a 380 px run list, Workspaces adds a workspace list, Changes review adds a file list, and Pipeline editing adds a program/suite rail. | Pages add their own navigation alongside the app sidebar. | Put these collections into the single shared sidebar. |
| Pipeline and Suite details own separate right-panel/overlay implementations. | Detail presentation and mobile behavior vary. | One shared, on-demand detail drawer. |
| `PageFrame` is defined but has no current consumers. Pages manage their own widths, padding and scroll containers. | No enforced content contract. | Replace it with one canvas primitive used by every route. |
| Global text starts at 13.5 px; Chat compensates with its own font-scale variable. | Typography depends on which page is mounted. | One application type scale; remove the Chat-specific compensation. |
| Some existing surfaces use glass, glow, decorative background effects and nested bordered panels. | Visual emphasis varies between features. | Adopt Chat's opaque surfaces and restrained hierarchy throughout. |

## The shared screen

```text
AppShell — mounted once above routes
├── AppSidebar
│   ├── Workspace switcher
│   ├── Section switcher: Chat / Pipeline / Activity / Changes / Report / Agents / Workspaces
│   ├── Contextual action and search, when relevant
│   ├── Current section's collection or section links
│   └── Running work, pending decisions, connection and theme
├── Main canvas — one main landmark
│   └── Current route's content
└── Shared overlay layer — detail drawer, dialogs, menus and toasts
```

The section switcher has a visible current-section label and exposes all seven destinations in the same place on every page. It replaces both the old navigation rail and Chat's Workspace tools menu. Selecting a conversation or file changes the current collection's selection; it does not create another sidebar.

### Fixed shell rules

- One 272 px sidebar on desktop, one collapse behavior and one mobile navigation drawer below 1024 px.
- One workspace switcher and one global navigation registry. Show the current section and selected record accessibly, including in deep-linked views.
- No global top header, agent strip or page footer. Floating navigation and overflow controls use the same placement and reserved space as Chat.
- One neutral page background, shared theme tokens and consistent opaque popovers/dialogs. Remove decorative grids, washes, glow and glass where they compete with content.
- One application typography scale: 16 px body/input text, approximately 17 px reading text on desktop, 12–14 px secondary labels, bounded headings and monospace for code/output. Promote the root scale deliberately and audit legacy fixed-pixel labels and control heights.
- One spacing scale, focus treatment, radius system and button hierarchy. Use borders for inputs, real tabular structure, code and necessary boundaries; use spacing for ordinary content groups.
- One shared canvas with consistent desktop/mobile gutters. Reading content keeps Chat's 880 px measure. Dense tables and diagrams can use the available canvas width within the same shell. Content width is controlled by shared content primitives; routes cannot install another viewport or shell.
- One primary vertical scroll owner for the active content. The sidebar scrolls independently; bounded code, tables and a detail drawer may scroll for their own content. Avoid a scrolling page wrapped around another full-height scrolling page.
- One `main` landmark owned by the shell. Route components and nested viewers render sections/articles. Visible content titles describe the selected record or page; they sit in the document flow without recreating a header bar.

## How each page adopts it

| Section and routes | Shared sidebar content | Main canvas and actions | Remove or consolidate |
| --- | --- | --- | --- |
| Chat `/` | Existing thread search, pinned/recent/archived rows, New chat and thread actions. | Preserve the current conversation, composer, evidence, width preference and outline. | Page-owned `ThreadSidebar` frame, local mobile drawer and Chat-only shell branch. |
| Pipeline `/pipeline` | Pipelines in the selected workspace, with relevant state and New pipeline. | An open overview with a compact summary, Needs you, pipeline rows and throughput where useful. | Global top bar, competing summary cards and repeated navigation. |
| Pipeline detail/new `/pipeline/[id]`, `/pipeline/new`; suite `/pipeline/suite/[id]` | Selected pipeline/suite context; editor program/suite selection joins this same sidebar. Hierarchy expands within the collection. | One title/action group, editable content and the flow/list view. Keep Play/Pause/Stop, Save, dirty state and questions clear. Open selected station or policy in the shared drawer. | Internal editor rail, duplicate back links/title bands and separate right-panel implementations. Consolidate the run controls into one contextual control group. |
| Activity `/activity` | The current run/conversation list. Provider, state and role filters move into a compact filter control in this sidebar. | Selected history uses the Chat conversation presentation, with metadata and source details on demand. Preserve Continue in Chat, Stop, relevant changes links and pending decisions. | The internal 380 px list, mobile Activity/Detail bar and nested scrolling wrappers. |
| Changes `/changes`, `/changes/[runId]` | Changes index lists recorded run change sets. Inside a review, the same collection area shows changed files, with an explicit return to the change sets. | Diff is the main content. Keep unified/split comparison and file-level context. Commit history becomes an expandable content section. | Additional file sidebar, large review header and fixed commit footer. Split diff columns remain paired comparison content within the shared canvas. |
| Report `/report` | Lightweight links to the report's existing sections; no artificial record collection or redundant search. | Consistent title, scope and Refresh control; quiet summary values, charts and readable tables. | Independent padding/width rules, repeated title bands and decorative metric containers. Keep units, estimates and missing-usage explanations. |
| Agents `/agents` | Provider entries and relevant settings-section links. Clearly label the section's app-wide scope. | Provider availability, usage, model access, configuration and validation use the same section/row/form patterns. Put Refresh usage and Re-detect beside the relevant content. | Stats and actions injected into the global header, inconsistent panel chrome and tiny essential labels. Preserve capability and permission explanations. |
| Workspaces `/workspaces` | All workspaces and New workspace; one selected workspace shared with the root workspace context. | Workspace overview, programs, instructions and proposals in open sections. Keep settings and authoring actions attached to their records. | The additional workspace-list aside and competing selection/list ownership. Preserve creation, proposals and destructive-action safeguards. |

All existing sections are covered. Redirects `/fleet`, `/sessions`, `/tasks`, `/operations` and `/input` keep forwarding to their current destinations and preserve their query parameters. `/pipeline/open` remains a resolver inside the common shell. Loading, invalid-ID, empty, missing-workspace and error states use the same canvas and typography. The not-found experience also stays within the shell.

### Scope and navigation

Chat, Pipeline, Activity, Changes and Report retain their selected-workspace scope. Agents settings remain app-wide, and Workspaces remains the workspace library. The layout cleanup must not silently change these meanings.

Preserve selection, filters, supported query parameters and browser navigation. A direct link must select the corresponding sidebar record or show a truthful missing-record state. Workspace switching must settle both sidebar and content on the same workspace, and preserve each section's last useful location where appropriate.

## Shared attention and detail behavior

Removing the old dock requires moving its responsibilities first.

- Put one compact running-work and pending-decisions summary in the sidebar's utility area. Expose its count on the collapsed/mobile navigation trigger so attention cannot disappear with the sidebar.
- Open the shared attention drawer to inspect every outstanding decision, jump to the owning Chat/Pipeline/Activity record, or stop a specific run. Show the owning workspace/provider and reconnect state accurately.
- Keep an in-context decision visible in the current conversation or selected work item. It is the same request record as the attention drawer; answering it from either place settles both presentations.
- Use one shared detail drawer for station details, policy, metadata and appropriate configuration. Give it a consistent title, close behavior, content regions and action placement. On narrower screens it uses the available viewport and contains focus. Only one shared detail/attention drawer is open at a time.
- Retain confirmation dialogs for destructive operations. Dialog actions belong to the selected record; they do not add an app footer.
- Move reusable pieces such as `AskChip`, currently exported from `AgentDock`, to an appropriate shared run-status component before deleting the obsolete dock UI.

## Ownership and implementation structure

`AppShell` owns sidebar framing, viewport sizing, navigation toggles, the main landmark and shared overlay placement. A static navigation registry owns destination labels, matching and scope. Feature collections provide the content rendered inside the sidebar; they do not receive permission to replace shell geometry.

Suggested shared components are `AppSidebar`, `SidebarCollection`, `PageCanvas`, `ContentTitle`, `FilterControl`, `DetailDrawer`, `RunAttention` and a small set of section/row/table primitives. Final names can follow the repository's conventions; there must be one implementation of each shared responsibility.

Keep the existing `AgentConsoleProvider` and `WorkspaceProvider` above routing. Extract Chat's thread/library controller from `app/page.tsx` so both its sidebar collection and conversation consume the same state. Place queued-message ownership and acceptance/recovery handling where route changes cannot discard them. Drafts and reading anchors retain their current persistence behavior.

Feature controllers provide stable data/actions to their collection and canvas. Reuse existing endpoints and caches; do not mount every page's data subscriptions just to populate the shell. Changing sections should load that section's collection, not eagerly restore every conversation, report or work item.

Do not revive `PageChrome` through a new effect-driven registration layer that republishes arbitrary JSX on every render. Render page actions beside the content they act on and keep the navigation registry declarative. Preserve server-renderable route content and the existing Suspense boundaries where required.

## Delivery sequence

Each slice is reviewable in one implementation branch. The completed release contains one layout path; temporary migration wrappers are removed before completion.

| Slice | Work | Completion gate |
| --- | --- | --- |
| 1. Shared foundation | Extract the navigation registry, promote Chat's frame/drawer/viewport behavior to `AppShell`, establish shared tokens/canvas and lift Chat state ownership. Move every route onto the shared shell. | Chat preserves its current appearance and behavior; all routes use the same shell, sidebar and main landmark; route navigation retains running work and drafts. |
| 2. Collection consolidation | Move Activity history, workspace selection, Pipeline/editor collections and Changes/files into sidebar collections. Wire real deep links, selections, filters and loading states. | Each route has one persistent navigation sidebar; sidebar selection and main content agree; workspace and browser navigation are correct. |
| 3. Content and controls | Migrate Report, Agents, Workspaces, Pipeline and Changes to shared content primitives. Consolidate title/actions, tables, forms, summaries and empty/error states. Introduce the shared detail and attention drawer and rehome all dock responsibilities. | Actions remain discoverable; critical decisions, Stop, permission explanations, unsaved edits and destructive safeguards keep working; pages follow the same typography and visual hierarchy. |
| 4. Remove the old system and verify | Delete `TopBar`, the obsolete `Sidebar` frame, old chrome publishing code and the dock UI after extracting reused pieces. Replace/remove unused `PageFrame`; clean obsolete CSS, duplicated collapse keys and page-owned overlays. Update tests and documentation. | No legacy shell consumers or route-specific layout branches remain; route-wide browser acceptance and required checks pass. |

The highest-risk migration is Pipeline editing: its rail, transport controls, unsaved state, station drawer and policies must move together. Review that slice as a working editing/running flow, not only as a screenshot.

## Definition of done

- Every primary route and deep-linked detail renders the same persistent `AppShell`; there is no Chat-versus-other-pages branch, alternate shell mode or long-term compatibility renderer.
- One desktop navigation sidebar, one collapse preference, one mobile navigation implementation, one main landmark and one shared overlay system exist.
- Obsolete shell components/imports, chrome contexts, duplicated layout CSS and unused compatibility wrappers are deleted. Static ownership checks enforce these boundaries, complemented by interaction tests.
- Route screenshots cover Chat, Pipeline overview/editor/detail/suite, Activity, Changes index/diff, Report, Agents and Workspaces, plus loading, error and empty states, across all three themes. Review focus, contrast, spacing and type at desktop and narrow widths.
- At 320 px and with enlarged text/zoom, prose and ordinary controls fit the viewport. Wide comparisons/diagrams overflow only within their explicit content region. Mobile keyboard resizing, drawer focus, Escape and menu placement work consistently.
- Live updates do not move page content by inserting a global strip. Queued messages, running agents, pending approvals, draft recovery and reading anchors survive section navigation.
- Workspace changes, selected items, route/query parameters, legacy redirects and browser back/forward remain correct. Navigating away from an unsaved editor follows an explicit save/discard flow rather than silently dropping changes.
- Primary actions retain their behavior: pipeline execution and editing, question answering, Stop, changes review, provider/settings updates, workspace/instruction/program operations and proposal handling.
- Use the existing 200-turn/1,000-thread Chat fixture as a regression baseline, and add representative large Activity, Pipeline and diff fixtures. Compare layout shifts, render work, scroll responsiveness and subscription counts during navigation.
- Type checks, relevant tests, changed-file lint, contrast checks and the production build pass. Browser checks exercise actual shared shell components and stateful route transitions; document fixture and physical-device verification limits accurately.

## Proposed choices for review

1. The new Chat visual language becomes the application default, with a single shell above every route.
2. The same left sidebar combines a stable section switcher with the current section's collection. Existing secondary left rails are removed.
3. Page titles/actions live within the shared content canvas; the old global header, dock strip and page footer disappear.
4. One on-demand detail/attention drawer replaces page-specific inspector layouts while preserving all actionable decisions.
5. Complete the migration and delete the old layout system in the same release. This is a frontend ownership and presentation cleanup; existing business rules and data scope remain authoritative.

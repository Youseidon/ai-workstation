# 06 — The agent's context: smaller, and containing what the item actually needs

Read `00-read-first.md` first. Independent of 03–05 (coordinate on `agentContext.ts` if they are in
flight). Prompt 09 relies on this landing first.

## Objective

A sub-step's run starts from a context that fits in ~24 KB, contains its parent's brief and the
suite's playbook, and does not repeat the repository rules the CLI already loaded from `AGENTS.md`.
The full history stays one `agent-step` call away.

## Why

`contextMarkdown` (`server/src/agentContext.ts`) concatenates: workspace description (materio-forge:
4.9 KB, and largely the same text as the 5.6 KB `AGENTS.md`/`CLAUDE.md` the CLI has *already* read
from disk), program and suite overview, the item's content, the newest 8 remarks on the item
(`CONTEXT_REMARK_LIMIT`) whatever their kind — so a station continued four times carries four prior
runs' `AGENT_RESPONSE` texts of up to 20 KB each and little else — all clarifications, then ~3 KB
of protocol and Progress API text. Meanwhile a sub-step created
by `decompose` receives **nothing** from its parent: not the parent's content, not the resume brief
(that went to the parent), not the sibling list. S6's sub-steps say "follow the S6-00 playbook" and
"see the parent for the replay commands" — text they never receive. The agent spends its first
minutes rediscovering what the console already knows and its budget dies while reading.

## Scope

### 1. Measure first

Add `scripts/context-size.ts` (run with `node --import tsx`): given `--db <path>` and `--prompt
<id>`, print the byte size of each `## ` section of the execute context as the agent would receive
it (call `workspaces.agentContext` + `contextMarkdown` + `progressApiMarkdown` + `budgetMarkdown`
against a **copy** of the database). Run it for S6-09.1 (`prompt.id = 133` on the live copy) before
and after; put both tables in your report.

### 2. What goes in, in order, with caps

Rewrite `contextMarkdown` for `purpose === "execute"` as an ordered list of sections, each with a
byte cap and a truncation notice that names the command to get the rest:

| Section | Content | Cap |
|---|---|---|
| Title | `# Work item <key> — <title>` and the one-line "database is authoritative" sentence | — |
| Workspace | name, working directory, and: "Repository rules are in `AGENTS.md`/`CLAUDE.md` at the root; your CLI has loaded them. They are not repeated here." | — |
| Standing instructions | `workspace.description` **only** if it is not substantially contained in the projected `AGENTS.md`/`CLAUDE.md` (compare normalised text; if ≥ 80 % of its lines appear there, omit and rely on the pointer above) | 2 KB |
| Program | key, name, overview | 1 KB |
| Suite | key, name, overview — this is where the playbook lives (prompt 09 moves it here) | 4 KB |
| Parent (sub-steps only) | parent key/title, the parent's **content**, the parent's latest `RESUME_BRIEF`/decompose `resumeBrief` text if one exists, and the sibling list `key — title — status` | 6 KB content + 2 KB brief |
| Dependencies / gate | as today (title + status + result) | 1 KB |
| Work item | the item's content, uncapped | — |
| Verification | the item's resolved DoD `COMMAND` criteria, listed as the commands the server will run on `done` (from prompt 04; skip the section if that prompt has not landed) | 1 KB |
| Where the last run stopped | the latest `CONTINUATION` remark (agent's own, or the system's), the latest `BLOCKER` + its `HUMAN_RESPONSE` if newer than the last status change, the last **3** `PROGRESS`/`VERIFICATION` remarks. **No `AGENT_RESPONSE` remarks** | 6 KB |
| Clarifications | only those `ANSWERED` since the item's last `DONE`/`TODO` transition | 2 KB |
| Protocol | see §3 | ~1.2 KB |
| Recording your progress | see §3 | ~1 KB |
| Run budget | as today | — |

Truncation notice text: `…(truncated; run \`agent-step context --full\` for everything)`.

`agent-step context` keeps returning what the agent got at start; add `--full` → `GET …/context?full=1`
which returns the uncapped version (all remarks, all clarifications, no dedupe). The door route
already exists; add the query flag.

### 3. Protocol text

Replace the "Completion and blocker protocol" and the `decomposeParagraph` with this (adjust the
decompose sentence per depth as today), and keep it under 1.2 KB:

> ## How this run ends
> Post exactly one of `done`, `continue`, `blocked`, or `decompose` through `agent-step` (below).
> `done` is checked by the server: the Verification commands above run in the workspace and `done`
> is refused with their output if any fails. `continue` records what remains and re-queues this
> item on this working tree — use it when the work will not fit this run; it costs nothing.
> `blocked` is only for a concrete action that a human must take (a credential, a decision that was
> not delegated to you, an external system); remaining work is never a blocker. `decompose` splits
> the remaining work into 2–12 self-contained sub-steps when they are mostly independent
> (`<depth note>`).
> Bank progress with `remark --kind PROGRESS` after each verified piece; if this run is stopped by
> its budget you get a short wrap-up turn on the same session to record what remains. Do not look
> for or edit a tracker file; the database is the tracker.

"Recording your progress" (`progressApiMarkdown`): the shim path once, the five commands one line
each with their required flags, the two-line rule about `requestId`, nothing else. Delete the
"reviewer is sent… costs an extra run" text and the curl fallback block *unless* `usesCurl` is true
for that provider (then show curl **instead of**, not in addition to, the shim).

### 4. Data plumbing

- `workspaces.agentContext` returns `parent: { externalKey, title, content, resumeBrief, siblings }
  | null`. The decompose `resumeBrief` is stored on the parent as the `result` of its
  `agent_decompose` ledger row and as a `PROGRESS` remark (see `decomposePrompt`, ~line 1348); read
  the latest `agent_decompose` row's `result`.
- Remark selection for "Where the last run stopped" is a query, not a filter over all remarks:
  `promptHistory` already exists — add `recentRemarks(promptId, { kinds, limit })` and use it.
- The consult/clarify purposes keep their current shape; only `execute` changes. Handoff/audit
  markdown builders that call `contextMarkdown` must still get what they need (audit needs the item
  content and the remarks — give it `full`).

### 5. `AGENTS.md`/`CLAUDE.md` projection

`workspaceInstructions.ts` writes `claude_md`/`agents_md` to disk. Confirm the projection includes
the `agent-step` note and is what the dedupe in §2 compares against. Do not change what is written.

## Out of scope

The content of materio-forge's workspace description, suite overview or items (prompt 09). The
decompose mechanics (prompt 07).

## Acceptance criteria

1. `scripts/context-size.ts` on the live copy for prompt 133: total execute context ≤ 24 KB with
   the sections above, and the report shows the before/after table (before is ~40 KB+).
2. A depth-1 sub-step's context contains its parent's content and its siblings' statuses; a station's
   does not have a Parent section.
3. No `AGENT_RESPONSE` remark appears in the execute context; `agent-step context --full` returns
   them.
4. A workspace whose description is a copy of its `AGENTS.md` gets the one-line pointer, not the
   text; a workspace whose description is distinct gets it (capped).
5. Every capped section, when truncated, ends with the notice naming `--full`.
6. Snapshot-free tests in `agentContext.test.ts`: section order, each cap, dedupe rule, parent
   section presence, protocol size bound (`< 1300` bytes), progress section size bound.
7. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

The before/after size tables for prompts 133 (S6-09.1), 5 (S6-00) and one depth-0 station in
another suite, plus one real run (Codex) of a sub-step on a disposable copy of the workspace to
show the agent uses the parent section rather than re-deriving it (quote its first message).

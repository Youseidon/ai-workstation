# 07 — Decompose: repeatable, informative when refused, and never a reason to block

Read `00-read-first.md` first. Independent of 03–05; touches `agentContext.ts` alongside 06
(land 06 first or coordinate).

## Objective

`decompose` is a tool for splitting *parallel* work, not an escape hatch from a budget. A parent may
split again after its first batch of children finishes; a refused decompose tells the agent exactly
what to change; and no console text anywhere tells an agent to report `BLOCKED` because work will
not fit.

## Why

3 of the 10 `BLOCKED` posts in the live history were not human questions: one was "decompose refused:
a sibling with that name already exists" (a resumed parent tried to split its remaining endpoints
and every generated key `S6-08.<n>` or title already existed), two were "the execution window cannot
complete this" — words copied from the console's own protocol text, which said "Finish it or report
BLOCKED". Each parked the rail until the owner came back and pressed Resume with nothing to answer.

## Scope

### 1. Re-decompose appends

In `agentDecomposeTransaction` (`server/src/workspaces.ts`, ~line 1320):

- `externalKey` for new children continues the numbering: `${parentKey}.${existingChildren + index + 1}`;
  `child_order` likewise. Existing children — done, skipped, or open — are untouched.
- Title collisions within the suite are reported **before** any insert, as `422
  decompose_title_conflict` with the body `{ conflicts: [{ index, title, existing: "<key> — <title> (<status>)" }] }`
  and a message: "Rename these sub-steps and post again; existing sub-steps are kept." Do not
  auto-suffix: the agent should know what already exists (it may be about to duplicate finished
  work).
- The remaining `UNIQUE constraint failed` → 409 path stays as the tripwire for anything else.
- `agent-step decompose` prints the conflicts list readably.

### 2. Refusal texts

Replace every agent-facing string that pairs "cannot" with "report BLOCKED":

- `decompose_depth_exceeded` → "…sub-steps cannot be split further. Finish it, or post `continue`
  with what remains; it will be resumed on this working tree."
- The `canDecompose === false` paragraph in `contextMarkdown` (if 06 has not already replaced it)
  → same wording.
- `grep -rn "report BLOCKED\|execution window" server shared web` must return nothing agent-facing
  when you are done (tests and ledger sentences that describe *past* history may keep their words).

### 3. What the parent sees when it resumes

When a decompose parent resumes for integration (all children closed), its execute context gets a
`## Sub-steps` section (add to the ordered sections from prompt 06, after the Work item): one line
per child, `key — title — status`, followed by the child's `result` text (its `done` verification
summary) capped at 600 bytes each. This is the parent's integration checklist; today it has to
re-derive it from the tree. Cap the section at 8 KB with the standard truncation notice.

For a **sub-step** run, the sibling list in the Parent section (prompt 06) already exists; make sure
it reflects children added by a second decompose.

### 4. Decompose guidance

The decompose sentence in the protocol text (prompt 06 §3) should say when to decompose and when
not to, in two sentences: split when the remaining work is 2–12 mostly independent slices that can
each be verified on their own (endpoints, files, modules); do **not** split because the work is large
or the run is long — `continue` handles that at no cost. Keep the depth note.

### 5. Skipped children

`promptOptions`' `openChildren` treats a `SKIPPED` child as closed so the parent can resume — keep
that. Make sure the parent's `## Sub-steps` list marks skipped children clearly (`SKIPPED — <reason
from the ledger>`) so the integration run does not assume their work exists.

## Out of scope

Changing `DECOMPOSE_MAX_DEPTH` or the 2–12 bounds; anything about budgets or continuations.

## Acceptance criteria

1. A parent with children `.1`–`.7` (mixed DONE/SKIPPED) that decomposes again with two new titles
   gets `.8` and `.9`; the existing seven are unchanged; the parent goes `TODO` with `agent_decompose`
   as before.
2. The same decompose with one title that already exists in the suite is refused with
   `decompose_title_conflict` naming the index, the title and the existing item; nothing is inserted;
   the parent stays `IN_PROGRESS`.
3. No agent-facing text contains "report BLOCKED" or "execution window".
4. A resumed parent's context contains the `## Sub-steps` section with each child's status and
   result; a station without children has no such section.
5. Tests: `decompose.test.ts` (or the existing decompose tests) for (1) and (2);
   `agentContext.test.ts` for (4).
6. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

On a disposable database: an item with a fake execute run that decomposes into 3, closes the children
via the API, resumes the parent, and decomposes again into 2 with one duplicated title (refused), then
2 unique titles (accepted as `.4`, `.5`). Paste the 422 body and the final child list.

# 04 — DONE means the server verified it

Read `00-read-first.md` first. Requires prompt 03. Uses the definition-of-done tables from migration
23 (`definition_of_done`, `dod_criterion`, `dod_result`) and `server/src/definitionOfDone.ts` /
`dodCommands.ts` as they are.

## Objective

An agent's `done` closes a work item only when the item's own verification commands, run by the
server in the workspace directory, exit 0. A failing verification is fed back to the agent while it
is still running; if the run ends anyway, the failure becomes a continuation brief — never a park.

## Why

The only place an independent check has value is a claimed **DONE**: a wrong DONE silently loses
work and poisons every dependant. Today the independent check (a read-only model) is spent on
*unfinished* runs, where it says INCOMPLETE 23 times out of 24 and adds nothing. Meanwhile
materio-forge has an executable specification — golden replay (`node harness/replay.mjs …`) and a
build that must stay at 0 warnings — so "is it done" is a shell command with an exit code, not an
opinion. The DoD machinery to run such commands already exists; nothing writes criteria into it
(both tables are empty on the live database) and its failure mode is a `NEEDS_REVIEW` park.

## Scope

### 1. Criteria come from the work item's own text

A work item may end with a section:

````markdown
## Verify

```sh
dotnet build src/backend/MaterioForge.slnx -warnaserror
node harness/replay.mjs --target http://localhost:8080 --namespace clients
```
````

- `server/src/promptImport.ts` (import) and the prompt create/update route in
  `server/src/workspaceApi.ts` and `decompose` in the agent door: after any write of
  `prompt.content`, find the **last** `## ` heading whose text starts with `Verify` (the owner's
  items use `## Verify (only these routes)`), take the first fenced `sh`/`bash` block between it and
  the next `## ` heading (prose in between is ignored; no fenced block → no criteria); each
  non-empty, non-comment line becomes one `COMMAND` criterion on the **prompt** scope's definition
  of done (`required = true`, `expectExitCode = 0`, `cwd = null`, `timeoutMs =
  DOD_COMMAND_TIMEOUT_DEFAULT_MS` unless a trailing `# timeout=600s` comment says otherwise — strip
  the comment from `text`; the line may carry leading `VAR=value` environment assignments, which
  the runner passes through the shell unchanged). Replace the prompt-scope criteria wholesale on each
  parse (keyed by the criterion `text`, so unchanged commands keep their id and their `dod_result`
  history). Put the parser in `shared/src/verifyBlock.ts` with its own test; it is pure.
- Length/timeout caps are the existing `DOD_COMMAND_*` constants. A command longer than
  `DOD_COMMAND_MAX_LENGTH` is rejected with a 422 naming the line.
- The item editor (`web/components/…` where prompt content is edited) shows the parsed criteria
  read-only under the editor: "These run on `done`". The existing `DefinitionOfDonePanel.tsx` keeps
  working for suite/program/workspace-level criteria written by hand.

### 2. `done` runs the criteria, and tells the agent when they fail

In the agent door (`server/src/index.ts`, `/status` with `status: "DONE"`):

1. Resolve the item's definition of done (nearest scope, as today) and run its `COMMAND` criteria
   with `runDefinitionOfDoneCommands(promptId, runId)` **before** `writeStatus`. Run them
   sequentially, in the workspace directory, with the run's environment (the item's `Verify` block
   assumes the same shell the agent used). Stream nothing to the agent; capture output as today.
2. If every required criterion passed → `writeStatus DONE` (the gate inside `writeStatus` reads the
   fresh results and agrees) → respond 200 → `handle.complete()`.
3. If any required criterion failed → **do not write any status**. Respond `409 verification_failed`
   with a body the agent can act on: per failed criterion the command, exit code and the
   captured output (bounded by `DOD_COMMAND_OUTPUT_MAX_BYTES`), plus one sentence: "Fix this and
   post `done` again. If it cannot be fixed in this run, post `continue` with what remains." Record
   the attempt as a `VERIFICATION` remark (SYSTEM) so it is in the item's history. The run keeps
   going — the agent has the compiler's words and is still in context; this is the cheapest possible
   remediation.
4. `agent-step done` already exits non-zero and prints the message on a refused post; make sure the
   409 body's failures print readably (one block per command).
5. Enforcement: `dodEnforcement = block` (default) is the behaviour above. `warn` writes DONE and
   records the failures as today. `off` skips the run. Keep the scope-level override.

### 3. When the run ends without a verified DONE

If the run ends and the item is still `IN_PROGRESS` after one or more refused `done` posts, the
station is `UNREPORTED` as today, and the continuation brief (prompt 03) is built from: the last
refused verification's failing commands and output tail, then the last `PROGRESS` remarks. Add this
to the continuation's cause text so the next run starts from the failure, not from the top.

### 4. The operator's own "Mark complete" and the post-N reviewer

- Operator `completePrompt` stays an override that records what it closed over (unchanged).
- The post-N reviewer (`settleAudit`, prompt 03) already calls `runDefinitionOfDoneCommands` before
  `completePrompt`; leave that.
- `dod_unmet` no longer produces a `NEEDS_REVIEW` park from the agent path (it cannot — a refused
  `done` writes nothing). Remove the `waiting-human-dod` transition row and the `dodUnmet` wait
  reason **unless** the operator-override or reviewer path can still reach it; if they can, keep
  the row and say so.

### 5. Suite-level defaults for materio-forge (data, not code)

Nothing here writes criteria for the owner's project — prompt 09 does that through the API. But make
sure a suite-scope definition of done with `COMMAND` criteria is inherited by every sub-step created
by `decompose` (check `definitionOfDone.resolve` with a depth-2 item).

## Out of scope

Removing `PROSE` criteria or the reviewer — they stay, default off/after-N. Changing the goldens or
anything in `~/projects/materio-forge`.

## Acceptance criteria

1. Saving an item whose text ends with a `## Verify` block creates exactly those `COMMAND` criteria
   at prompt scope; editing the block updates them; removing it removes them; unchanged lines keep
   their criterion id.
2. An agent `done` against an item whose verify command exits 1 gets `409 verification_failed` with
   the real output, the item stays `IN_PROGRESS`, a SYSTEM `VERIFICATION` remark is recorded, and a
   second `done` after the command is fixed writes `DONE` with `dod_result` rows `PASSED`, source
   `RUNNER`.
3. A run that ends after a refused `done` produces a continuation whose `CONTINUATION` remark
   contains the failing command's output tail.
4. With no criteria anywhere, `done` behaves exactly as before (vacuous pass).
5. `decompose`'d children inherit suite-level criteria.
6. Tests: `verifyBlock.test.ts` (shared), `agentDoor.test.ts` (2), `definitionOfDone.test.ts` (1, 5),
   a scheduler test for (3).
7. `npm run typecheck && npm test && npm run build` clean.

## Verification to run and report

Disposable database, scratch workspace directory containing a script that exits 1 until a marker file
exists. Item text with `## Verify` running that script. Run with Codex; watch the first `done` refused
with the script's output in the transcript, the agent create the marker, and the second `done`
close the item. Paste the 409 body and the `dod_result` rows.

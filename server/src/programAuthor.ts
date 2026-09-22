/**
 * What an author run is told.
 *
 * An author run is the one run in this console that produces work items instead
 * of doing them, so the brief has a different job from an execute context: it
 * has to teach the shape of a program (suites of work items, each one session's
 * worth, each with its own verification) and then get out of the way. The rest
 * of the guarantee is not in this text — it is that the only thing this run can
 * write is a draft nobody reads until an operator applies it.
 *
 * Kept beside nothing else so it can be read on its own, and so the JSON shapes
 * here and the validators in `shared/src/programDraft.ts` can be diffed by eye.
 */

import type { ProgramDraftBody, ProgramDraftRecord } from "@agent-console/shared";
import {
  DRAFT_MAX_PROMPTS_PER_SUITE,
  DRAFT_MAX_SUITES,
  REVISION_MAX_CHANGES,
  countPrompts,
  diffProgramRevision,
} from "@agent-console/shared";
import { draftKeysById, programBriefMarkdown, type ProgramBrief } from "./programBrief.ts";

/**
 * The draft as it stands, for `agent-step context` during an author run.
 *
 * An author run's "context" is not a work item — it is the proposal it is
 * composing. Re-reading it is how a run that posted three suites and then lost
 * track finds out which one is still missing, without guessing from its own
 * transcript.
 */
export function programDraftStateMarkdown(draft: ProgramDraftRecord): string {
  const remaining = draft.body.suites.filter((suite) => suite.prompts.length === 0).map((suite) => suite.key);
  return [
    `# Program draft ${draft.id} (${draft.state})`,
    "",
    "## What was asked for",
    "",
    draft.goal === "" ? "(nothing recorded)" : draft.goal,
    draft.body.suites.length === 0
      ? "\nNothing has been proposed yet. Post `propose-program` first."
      : existingDraftMarkdown(draft.body),
    draft.body.suites.length === 0
      ? ""
      : remaining.length === 0
        ? "Every suite has work items."
        : `Still to post: ${remaining.join(", ")}.`,
    "",
  ].join("\n");
}

export interface ProgramAuthorPromptArgs {
  workspace: { name: string; workDirectory: string; description: string };
  draft: ProgramDraftRecord;
  /** The launcher, when the provider can exec one. Null falls back to curl. */
  shimPath: string | null;
  runId: string;
  token: string;
  port: number;
  /** An operator's note on a revise run: what to change about the draft below. */
  feedback: string | null;
}

/** What the draft already holds, so a revise run edits rather than restarts. */
function existingDraftMarkdown(body: ProgramDraftBody): string {
  if (body.suites.length === 0) return "";
  const suites = body.suites.map((suite) => {
    const items = suite.prompts.length === 0
      ? "  - (no work items yet)"
      : suite.prompts.map((prompt) => `  - ${prompt.key} — ${prompt.title}`).join("\n");
    return `- **${suite.key} · ${suite.name}**${suite.overview === "" ? "" : ` — ${suite.overview}`}\n${items}`;
  }).join("\n");
  return [
    "",
    "## What this draft already says",
    "",
    `Program: **${body.name}**`,
    body.overview === "" ? "" : `\n${body.overview}`,
    "",
    suites,
    "",
    `${countPrompts(body)} work item(s) so far. Re-posting a suite replaces that suite's work items; re-posting the program replaces everything.`,
    "",
  ].join("\n");
}

export function programAuthorPrompt(args: ProgramAuthorPromptArgs): string {
  const step = args.shimPath === null ? null : JSON.stringify(args.shimPath);
  const base = `http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}`;
  const auth = `-H 'Authorization: Bearer ${args.token}' -H 'Content-Type: application/json'`;
  const proposeProgram = step === null
    ? `curl -fsS -X POST ${auth} ${base}/propose-program -d @program.json   # add "requestId":"unique-id" to the body`
    : `${step} propose-program --file program.json`;
  const proposeSuite = step === null
    ? `curl -fsS -X POST ${auth} ${base}/propose-suite -d @suite.json       # add "requestId":"unique-id" to the body`
    : `${step} propose-suite --file suite.json`;

  return [
    `# Draft a program for the workspace "${args.workspace.name}"`,
    "",
    "You are not implementing anything in this run. You are writing the plan that later runs will execute, one work item at a time, and you are writing it into this console's database — not into files in this repository.",
    "",
    "**Read the working tree, do not change it.** No edits, no new files, no commits, no installs, no migrations. Run whatever read-only commands you need to understand the code (`ls`, `rg`, `git log`, `cat`, test *listing*), then write the plan.",
    "",
    "## What you are asked for",
    "",
    args.draft.goal,
    "",
    ...(args.feedback === null ? [] : [
      "## What the operator wants changed",
      "",
      args.feedback,
      "",
    ]),
    ...(args.workspace.description.trim() === "" ? [] : [
      "## Standing instructions for this workspace",
      "",
      args.workspace.description.trim(),
      "",
    ]),
    existingDraftMarkdown(args.draft.body),
    "## The shape of a program",
    "",
    "A **program** is a body of work. It holds **suites** — phases that run in order — and each suite holds **work items**. A work item is what one agent session is given: it gets the repository, this text, and nothing else, and it has to finish, verify itself, and report.",
    "",
    "So each work item must be:",
    "",
    "- **One session's worth.** If it needs three days it is a suite, not an item. If it is one line it belongs inside a bigger item.",
    "- **Self-contained.** Name the files, the functions, the commands. The agent that runs it will not have read this conversation and cannot ask you anything.",
    "- **Verifiable by a command.** End the item with a `## Verify` block — a fenced `sh` block whose lines are shell commands. The console runs those commands itself before it will accept the item as done, so they are the item's definition of done, not a suggestion:",
    "",
    "  ````markdown",
    "  ## Verify",
    "",
    "  ```sh",
    "  npm run typecheck",
    "  npm test --workspace server",
    "  ```",
    "  ````",
    "",
    "  Commands must pass from the workspace root with exit code 0. If a step genuinely cannot be checked by a command, say in prose what evidence proves it and leave the Verify block out rather than writing a command that always passes.",
    "",
    `- **Ordered by \`dependsOn\`** when something has to land first. Use the keys the console assigns (\`S1-01\`, \`S1-02\`, \`S2-01\`, …): suite \`S1\` is the first suite you propose, and its work items are numbered in the order you post them. An item's dependencies may point at earlier items in any suite.`,
    "",
    `Keep it to at most ${DRAFT_MAX_SUITES} suites and ${DRAFT_MAX_PROMPTS_PER_SUITE} work items per suite. Fewer, larger, verifiable items beat a long list of chores.`,
    "",
    "## How to post it",
    "",
    "Two steps. First the program and its suites:",
    "",
    "```bash",
    proposeProgram,
    "```",
    "",
    "```json",
    JSON.stringify({
      name: "Backend transition",
      overview: "One paragraph: what this program achieves and when it is finished.",
      notes: "What you read to arrive at this shape — files, tests, the parts you were unsure about.",
      suites: [
        { name: "Foundations", overview: "What this phase is for." },
        { name: "Endpoints", overview: "What this phase is for." },
      ],
    }, null, 2),
    "```",
    "",
    "Then one post per suite, in order:",
    "",
    "```bash",
    proposeSuite,
    "```",
    "",
    "```json",
    JSON.stringify({
      suite: "S1",
      prompts: [
        {
          title: "Add the request-id middleware",
          content: "Full instructions for the agent that will do this, in Markdown, ending with a ## Verify block.",
          dependsOn: [],
        },
        {
          title: "Route every handler through it",
          content: "…",
          dependsOn: ["S1-01"],
          gate: { name: "Middleware in place", description: "Nothing downstream starts until this holds." },
        },
      ],
    }, null, 2),
    "```",
    "",
    "`dependsOn` and `gate` are optional. A **gate** marks an item everything after it depends on; use it sparingly.",
    "",
    "Posting a suite again replaces that suite's work items, so you can revise one without touching the others. The reply tells you which suites still have none.",
    "",
    "## When you are done",
    "",
    "Post every suite, then write a short summary of what you proposed and why — the suites, the order, and anything you were unsure about. Then stop.",
    "",
    "Nothing you post here starts any work. The draft sits in the console until the operator reads it, edits it, and applies it; only then does it become a program. Say plainly in your summary if part of it is a guess.",
  ].join("\n");
}


/* -------------------------------------------------------------------------- */
/* Revising a program that already exists                                     */
/* -------------------------------------------------------------------------- */

/**
 * A revision run's `context`: the program as the draft now has it, in the
 * draft's keys, with what it has changed so far. The brief carries live facts
 * (status, runs, pipelines) from the library; the item text and order come from
 * the draft, because that is what the run is editing.
 */
export function programRevisionStateMarkdown(draft: ProgramDraftRecord, brief: ProgramBrief, options: { item?: string | null } = {}): string {
  const keys = draftKeysById(draft.body);
  const draftItems = new Map(draft.body.suites.flatMap((suite) => suite.prompts.map((prompt) => [prompt.key, prompt] as const)));
  const statusByKey = new Map(brief.suites.flatMap((suite) => suite.items).map((item) => [keys.get(item.id) ?? "", item] as const));
  // The library brief, re-pointed at the draft: same suites and items as the
  // draft holds now, so an added item is visible and a removed one is not.
  const view: ProgramBrief = {
    ...brief,
    program: { ...brief.program, name: draft.body.name, overview: draft.body.overview },
    suites: draft.body.suites.map((suite) => ({
      id: suite.sourceId ?? 0,
      key: suite.key,
      name: suite.name,
      overview: suite.overview,
      items: suite.prompts.map((prompt) => {
        const live = statusByKey.get(prompt.key);
        return {
          id: prompt.sourceId ?? 0,
          key: prompt.key,
          title: prompt.title,
          status: live?.status ?? "TODO",
          content: prompt.content,
          parentKey: live?.parentKey ?? null,
          dependsOn: prompt.dependsOn.map((key) => ({
            key, title: draftItems.get(key)?.title ?? "(not in this draft)", status: statusByKey.get(key)?.status ?? "TODO", programName: null,
          })),
          gate: prompt.gate === null ? null : { code: live?.gate?.code ?? "new", name: prompt.gate.name, description: prompt.gate.description },
          criteria: live === undefined ? [] : live.criteria,
          runs: live?.runs ?? 0,
        };
      }),
    })),
  };
  if (options.item !== undefined && options.item !== null && options.item.trim() !== "") {
    return programBriefMarkdown(view, { item: options.item });
  }
  const changes = draft.baseline === null ? [] : diffProgramRevision(draft.baseline, draft.body);
  return [
    `# Revision draft ${draft.id} (${draft.state}) of program ${brief.program.key ?? brief.program.name}`,
    "",
    "## What was asked for",
    "",
    draft.goal,
    "",
    "## Changed so far",
    "",
    changes.length === 0
      ? "Nothing yet."
      : changes.map((change) => `- ${change.kind} ${change.scope}${change.key === "" ? "" : ` ${change.key}`} — ${change.label}${change.details.length === 0 ? "" : `: ${change.details.join("; ")}`}`).join("\n"),
    "",
    programBriefMarkdown(view),
  ].join("\n");
}

export interface ProgramRevisionPromptArgs extends Omit<ProgramAuthorPromptArgs, "draft"> {
  draft: ProgramDraftRecord;
  brief: ProgramBrief;
}

export function programRevisionPrompt(args: ProgramRevisionPromptArgs): string {
  const step = args.shimPath === null ? null : JSON.stringify(args.shimPath);
  const base = `http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}`;
  const auth = `-H 'Authorization: Bearer ${args.token}' -H 'Content-Type: application/json'`;
  const revise = step === null
    ? `curl -fsS -X POST ${auth} ${base}/revise-program -d @changes.json   # add "requestId":"unique-id" to the body`
    : `${step} revise --file changes.json`;
  const context = step === null
    ? `curl -fsS -H 'Authorization: Bearer ${args.token}' ${base}/context            # add ?item=KEY for one item in full`
    : `${step} context            # add --item KEY for one item in full`;
  const example = {
    changes: [
      { op: "replace-text", find: "npm test", replace: "npm test && npm run lint", in: "content" },
      { op: "update-item", item: "S2-03", title: "New title", content: "Full new instructions, ending with a ## Verify block." },
      { op: "add-item", suite: "S2", title: "Roll back safely", content: "…", dependsOn: ["S2-03"], after: "S2-03" },
    ],
  };

  return [
    `# Change the program "${args.draft.body.name}" in the workspace "${args.workspace.name}"`,
    "",
    "The operator wants changes made to a program that already exists in this console. You are not implementing anything in this run: you are editing the program's work items — their instructions, titles, order, dependencies and gates — and you are editing a **draft copy** of it held in this console's database, not files in this repository.",
    "",
    "**Read the working tree, do not change it.** Run whatever read-only commands you need to make the changes correct (`ls`, `rg`, `git log`, `cat`), then post the changes.",
    "",
    "## What the operator asked for",
    "",
    args.draft.goal,
    "",
    ...(args.feedback === null ? [] : ["## What the operator wants changed about this draft now", "", args.feedback, ""]),
    ...(args.workspace.description.trim() === "" ? [] : ["## Standing instructions for this workspace", "", args.workspace.description.trim(), ""]),
    "## Read the program first",
    "",
    "```bash",
    context,
    "```",
    "",
    "It lists every suite and work item with its key, status, dependencies, definition of done and the pipelines that run it, and what this draft has changed so far. Use the keys it shows. For a large program it shows summaries; read an item in full with `--item KEY` before rewriting it, and if the output looks cut off, save it to a file and read that in parts.",
    "",
    "## Post changes",
    "",
    "```bash",
    revise,
    "```",
    "",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "",
    "Operations (every field not named `op` is optional unless marked required):",
    "",
    "- `update-program` — `name`, `overview`",
    "- `add-suite` — `name` (required), `overview`, `after` (suite key; `null` for first; omit for last)",
    "- `update-suite` — `suite` (required, key or name), `name`, `overview`",
    "- `move-suite` — `suite` (required), `after` (required; `null` for first)",
    "- `remove-suite` — `suite` (required). Removes its work items too.",
    "- `add-item` — `suite`, `title`, `content` (all required), `dependsOn` (keys), `gate` ({name, description}), `after` (item key in that suite; `null` for first)",
    "- `update-item` — `item` (required key), `title`, `content` (the **whole** new text), `dependsOn` (replaces the list), `gate` (object, or `null` to remove)",
    "- `move-item` — `item` (required), `suite` (to move to another suite), `after` (item key; `null` for first; omit for last)",
    "- `remove-item` — `item` (required). Dependencies on it are dropped.",
    "- `replace-text` — `find`, `replace` (required; literal text, every occurrence), `in` (`content` | `title` | `both`), `items` (keys; omit for every item). Refused if nothing matches.",
    "",
    `A post is all or nothing: if one change is refused, none are kept, and the reply names the refused change by its index. At most ${REVISION_MAX_CHANGES} changes per post; later changes in a post see earlier ones, so you can add an item and then depend on its new key (the reply tells you the keys).`,
    "",
    "## Rules for good changes",
    "",
    "- Change only what the request needs. An item you do not mention is left exactly as it is; do not rewrite items to restyle them.",
    "- Prefer `replace-text` for the same edit across many items, and `update-item` with the whole new `content` for a real rewrite.",
    "- Keep every item **one session's worth**, **self-contained**, and **verifiable**: a `## Verify` block with a fenced `sh` block of commands that must pass from the workspace root. The console runs those commands before it accepts the item as done.",
    "- Work items that are already `DONE` will not run again because their text changed. If the request needs one redone, say so in your summary rather than silently editing it.",
    "- Removing an item deletes its history when applied. Only remove what the request clearly asks to remove.",
    "",
    "## When you are done",
    "",
    "Re-read the context to check the result, then write a short summary: what you changed, why, and anything you were unsure about or that the operator must decide (for example, done items that would need re-running). Then stop.",
    "",
    "Nothing you post changes the program yet. The operator reviews every change against the program as it is, edits the draft if needed, and applies it.",
  ].join("\n");
}

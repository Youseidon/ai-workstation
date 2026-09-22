/**
 * A whole program, as an agent reads it.
 *
 * A work item's context is one item and its neighbours. A question about a
 * program — "what happens to S3 if S2-04 fails", "which of these will the
 * pipeline actually run" — needs the rest: every suite and item in order, what
 * each one waits for, what it has to pass to close, and which pipelines run it
 * with which rules. The data is gathered by `workspaces.programBrief`; this
 * file only decides how it reads, so the ask run and the revision run are told
 * the same facts in the same words.
 */

import type { OnDoneAction, OnUnfinishedAction, ProgramDraftBody, StepStatus } from "@agent-console/shared";

export interface ProgramBriefItem {
  id: number;
  key: string | null;
  title: string;
  status: StepStatus;
  content: string;
  parentKey: string | null;
  dependsOn: Array<{ key: string | null; title: string; status: StepStatus; programName: string | null }>;
  gate: { code: string; name: string; description: string } | null;
  criteria: Array<{ kind: string; text: string; required: boolean }>;
  runs: number;
}

export interface ProgramBrief {
  workspace: { id: number; name: string; workDirectory: string; description: string };
  program: { id: number; key: string | null; name: string; overview: string };
  suites: Array<{ id: number; key: string | null; name: string; overview: string; items: ProgramBriefItem[] }>;
  pipelines: Array<{
    id: number;
    name: string;
    active: string | null;
    stages: Array<{
      suiteId: number;
      label: string;
      /** Only this program's suites carry steps; other stages are named for order. */
      steps: Array<{ key: string | null; title: string; provider: string | null; model: string | null; onDone: OnDoneAction; onUnfinished: OnUnfinishedAction }> | null;
    }>;
  }>;
  maxContinuations: number;
}

/**
 * How much work-item text one brief carries before it shows summaries and
 * points at `--item` instead. Kept under what agent shells show of one
 * command's output (Claude Code cuts at 30 000 characters): a brief that is
 * silently truncated reads as a program that ends halfway.
 */
export const BRIEF_CONTENT_BUDGET = 20_000;

const RUN_SEMANTICS = [
  "## How this console runs a program",
  "",
  "- A **pipeline** plays its stages (suites) in the order listed, and within a stage its stations (work items) in step order. Items not on a pipeline's flowchart are not run by that pipeline.",
  "- A work item starts only when every item it **depends on** is `DONE`. A skipped dependency does not count as done.",
  "- An agent closes an item by posting `DONE`. If the item has **command criteria** (from its `## Verify` block), the console runs them first and refuses `DONE` unless they pass.",
  "- `BLOCKED` is a question for a human: the pipeline parks and waits. It is never retried automatically.",
  "- **On done** — `continue`: next station; `stop`: the pipeline stops after this item; `skip_rest`: the remaining stations of this stage are skipped.",
  "- **When unfinished** (the run ended without `DONE`/`BLOCKED`) — `continue`: the same item is resumed by a new run; `skip`: marked `SKIPPED` and the pipeline moves on; `wait`: the pipeline parks for a human.",
  "- A **gate** marks an item that later work depends on as a checkpoint.",
  "",
].join("\n");

function itemLabel(item: { key: string | null; title: string }): string {
  return item.key === null ? item.title : `${item.key} — ${item.title}`;
}

function pipelinesMarkdown(brief: ProgramBrief): string {
  if (brief.pipelines.length === 0) {
    return "## Pipelines\n\nNo pipeline runs this program's suites. Nothing runs it until one is created.\n";
  }
  return [
    "## Pipelines that run this program",
    "",
    ...brief.pipelines.map((pipeline) => [
      `### ${pipeline.name}${pipeline.active === null ? "" : ` (currently ${pipeline.active.toLowerCase()})`}`,
      "",
      ...pipeline.stages.map((stage, index) => {
        if (stage.steps === null) return `${index + 1}. ${stage.label} (another program)`;
        if (stage.steps.length === 0) return `${index + 1}. ${stage.label} — no stations; nothing in this suite runs`;
        const steps = stage.steps.map((step, at) =>
          `   ${at + 1}. ${itemLabel(step)} · ${step.provider ?? "default agent"}${step.model === null ? "" : ` / ${step.model}`} · on done: ${step.onDone} · unfinished: ${step.onUnfinished}`);
        return [`${index + 1}. ${stage.label}`, ...steps].join("\n");
      }),
      "",
    ].join("\n")),
  ].join("\n");
}

export interface ProgramBriefOptions {
  /** Only this item, in full. Keys match case-insensitively. */
  item?: string | null;
  /** Keys to show in place of the library's own, for a revision draft. */
  keyFor?: (item: ProgramBriefItem) => string | null;
}

/** The program, its items and its pipelines, as Markdown. */
export function programBriefMarkdown(brief: ProgramBrief, options: ProgramBriefOptions = {}): string {
  const keyOf = (item: ProgramBriefItem) => options.keyFor?.(item) ?? item.key;
  const wanted = options.item?.trim().toUpperCase() ?? "";
  const all = brief.suites.flatMap((suite) => suite.items);
  if (wanted !== "") {
    const item = all.find((entry) => (keyOf(entry) ?? "").toUpperCase() === wanted);
    if (item === undefined) return `No work item "${options.item}" in ${brief.program.name}. Known: ${all.map((entry) => keyOf(entry)).filter((key) => key !== null).join(", ")}\n`;
    return itemMarkdown({ ...item, key: keyOf(item) }, true);
  }
  const totalContent = all.reduce((total, item) => total + item.content.length, 0);
  const full = totalContent <= BRIEF_CONTENT_BUDGET;
  const counts = new Map<string, number>();
  for (const item of all) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);

  return [
    `# Program ${brief.program.key === null ? "" : `${brief.program.key} — `}${brief.program.name}`,
    "",
    "This is the console's own record of the program — authoritative, and not a file in the repository.",
    "",
    `Workspace: ${brief.workspace.name} (${brief.workspace.workDirectory})`,
    "",
    brief.program.overview.trim() === "" ? "" : `${brief.program.overview.trim()}\n`,
    `${all.length} work item(s) in ${brief.suites.length} suite(s): ${[...counts].map(([status, count]) => `${count} ${status}`).join(", ") || "none"}.`,
    "",
    brief.workspace.description.trim() === "" ? "" : `## Standing instructions for this workspace\n\n${brief.workspace.description.trim()}\n`,
    RUN_SEMANTICS,
    `A run that ends unfinished is resumed at most ${brief.maxContinuations} time(s) without progress before the pipeline parks for a human.`,
    "",
    pipelinesMarkdown(brief),
    "## Suites and work items",
    "",
    full ? "" : `The full text of every item is ${Math.round(totalContent / 1000)} KB, so only summaries are shown here. Read one item in full with \`context --item KEY\` (or \`?item=KEY\` on the context URL).\n`,
    ...brief.suites.map((suite) => [
      `### Suite ${suite.key === null ? "" : `${suite.key} — `}${suite.name}`,
      "",
      suite.overview.trim() === "" ? "" : `${suite.overview.trim()}\n`,
      suite.items.length === 0 ? "(no work items)\n" : suite.items.map((item) => itemMarkdown({ ...item, key: keyOf(item) }, full)).join("\n"),
    ].join("\n")),
  ].join("\n");
}

function itemMarkdown(item: ProgramBriefItem, full: boolean): string {
  const facts = [
    `status ${item.status}`,
    item.runs === 0 ? "never run" : `${item.runs} run(s)`,
    item.parentKey === null ? null : `sub-step of ${item.parentKey}`,
    item.gate === null ? null : `gate ${item.gate.code}: ${item.gate.name}`,
  ].filter((fact) => fact !== null).join(" · ");
  const depends = item.dependsOn.length === 0
    ? "Depends on: nothing"
    : `Depends on: ${item.dependsOn.map((dep) => `${itemLabel(dep)} [${dep.status}]${dep.programName === null ? "" : ` (in ${dep.programName})`}`).join("; ")}`;
  const kinds = new Map<string, number>();
  for (const criterion of item.criteria) kinds.set(criterion.kind, (kinds.get(criterion.kind) ?? 0) + 1);
  const criteria = item.criteria.length === 0
    ? "Definition of done: none recorded — an agent's DONE is accepted as posted."
    : full
      ? `Definition of done:\n${item.criteria.map((criterion) => `  - ${criterion.kind}${criterion.required ? "" : " (optional)"}: ${criterion.text}`).join("\n")}`
      : `Definition of done: ${[...kinds].map(([kind, count]) => `${count} ${kind}`).join(", ")} (read the item for the exact checks)`;
  const content = item.content.trim();
  return [
    `#### ${itemLabel(item)}`,
    "",
    facts,
    "",
    depends,
    "",
    criteria,
    "",
    full ? `<details><summary>Instructions</summary>\n\n${content}\n\n</details>` : `Instructions: ${content.length} characters — read with \`--item ${item.key ?? "KEY"}\`.`,
    "",
  ].join("\n");
}

/** The ask run's context: the brief, the question, and what it may not do. */
export function programConsultMarkdown(brief: ProgramBrief, question: string, liveBanner: string): string {
  return [
    liveBanner,
    "# Question about a program",
    "",
    "Answer the operator's question about the program below. This run is read-only research: do not implement, edit, or run mutating commands, and do not post remarks or status.",
    "",
    "When the question is about what *will* happen — which items run, in what order, what a failure leads to, whether a change would break something — reason from the dependencies, criteria and pipeline rules written here and from the repository itself, and say which of those facts your answer rests on. Say plainly when something depends on how an agent behaves at run time rather than on a rule.",
    "",
    "## Question",
    "",
    question,
    "",
    programBriefMarkdown(brief),
  ].join("\n");
}

/** Maps library item ids to the keys a revision draft uses for them. */
export function draftKeysById(body: ProgramDraftBody): Map<number, string> {
  const keys = new Map<number, string>();
  for (const suite of body.suites) for (const prompt of suite.prompts) {
    if (typeof prompt.sourceId === "number") keys.set(prompt.sourceId, prompt.key);
  }
  return keys;
}

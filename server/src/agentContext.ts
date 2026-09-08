import type { AgentPromptContext } from "./workspaces.ts";
import type { BudgetSnapshot } from "./runner.ts";

export type ContextPurpose = "execute" | "clarify" | "consult";

export interface LiveWriter {
  provider: string;
  model: string | null;
}

function section(title: string, content: string): string {
  return content.trim() === "" ? "" : `## ${title}\n\n${content.trim()}\n\n`;
}

const CONSULT_STANDING = "Answer a research question about this working tree. Do not implement, edit, or run mutating commands. Tools that write or execute are unavailable. The tree may be changing under you if a writer is active.";

const CONSULT_PROTOCOL = `## Consult protocol

You cannot post remarks or status. This run is read-only research. Do not call the Progress API. Answer the human's question from the repository and this context.`;

export function liveTreeBanner(writer: LiveWriter | null | undefined): string {
  if (writer === null || writer === undefined) return "";
  const model = writer.model === null || writer.model === "" ? "" : ` · ${writer.model}`;
  return `## Live tree\n\nA writer (${writer.provider}${model}) is in this workspace. You are reading a live tree. Files may be mid-edit. Do not treat a partial file as final.\n\n`;
}

export interface ContextExtras {
  liveWriter?: LiveWriter | null;
  question?: string;
  /** Decompose depth; a leaf is never told it may decompose. */
  depth?: number;
  maxDepth?: number;
  /**
   * Uncapped execute context: every remark and clarification, no section byte
   * caps, standing instructions always included. Served by
   * `agent-step context --full`.
   */
  full?: boolean;
}

export const CONTEXT_TRUNCATION_NOTICE = "…(truncated; run `agent-step context --full` for everything)";

/** Cap a section body to `maxBytes`, appending the standard truncation notice. */
export function cappedSection(text: string, maxBytes: number): string {
  const body = text.trim();
  if (body === "") return body;
  if (Buffer.byteLength(body) <= maxBytes) return body;
  const notice = `\n${CONTEXT_TRUNCATION_NOTICE}`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice));
  if (budget === 0) return CONTEXT_TRUNCATION_NOTICE;
  let cut = body;
  while (Buffer.byteLength(cut) > budget) {
    const next = Math.max(0, Math.floor(cut.length * (budget / Buffer.byteLength(cut))));
    cut = cut.slice(0, Math.max(0, next - 1));
    if (cut.length === 0) return CONTEXT_TRUNCATION_NOTICE;
  }
  return `${cut.trimEnd()}${notice}`;
}

/**
 * True when ≥ 80 % of the description's non-empty lines already appear in the
 * projected AGENTS.md / CLAUDE.md the CLI has loaded from disk.
 */
export function descriptionContainedInInstructions(description: string, agentsMd: string, claudeMd: string): boolean {
  const lines = description.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return true;
  const haystack = `${agentsMd}\n${claudeMd}`.toLowerCase().replace(/\s+/g, " ");
  let hits = 0;
  for (const line of lines) {
    const needle = line.toLowerCase().replace(/\s+/g, " ");
    if (needle !== "" && haystack.includes(needle)) hits += 1;
  }
  return hits / lines.length >= 0.8;
}

function executeProtocol(canDecompose: boolean): string {
  // Two sentences on when to / when not to split; depth refusal points at
  // continue instead of BLOCKED — remaining work is never a human question.
  const decompose = canDecompose
    ? `\`decompose\` splits remaining work into 2–12 mostly independent slices that can each be verified on their own (endpoints, files, modules). Do not split because the work is large or the run is long — \`continue\` re-queues this station until the work is done.`
    : `\`decompose\` is refused at this depth — sub-steps cannot be split further. Finish it, or post \`continue\` with what remains; it will be resumed on this working tree.`;
  return `## How this run ends

Post exactly one of \`done\`, \`continue\`, \`blocked\`, or \`decompose\` through \`agent-step\` (below).
\`done\` is checked by the server: the Verification commands above run in the workspace and \`done\`
is refused with their output if any fails. \`continue\` records what remains and re-queues this
item on this working tree — keep posting it until \`done\` passes, or until a real human question
needs \`blocked\`. The rail does not stop for \`continue\`.
\`blocked\` is only for a concrete action that a human must take (a credential, a decision that was
not delegated to you, an external system); remaining work is never a blocker. ${decompose}
Bank progress with \`remark --kind PROGRESS\` after each verified piece; if this run is stopped by
its budget you get a short wrap-up turn on the same session to record what remains. Do not look
for or edit a tracker file; the database is the tracker.
`;
}

function formatRemark(item: { actorType: string; kind: string; createdAt: string; content: string }): string {
  return `### ${item.actorType} · ${item.kind} · ${item.createdAt}\n\n${item.content.trim()}`;
}

/**
 * Execute context: ordered, capped sections. Consult/clarify keep the older
 * shape so their callers do not have to change with the diet.
 */
export function contextMarkdown(context: AgentPromptContext, purpose: ContextPurpose = "execute", extras?: ContextExtras): string {
  if (purpose !== "execute") return legacyContextMarkdown(context, purpose, extras);

  const full = extras?.full === true;
  const key = context.prompt.externalKey ?? String(context.prompt.id);
  const canDecompose = (extras?.depth ?? 0) < (extras?.maxDepth ?? 2);
  const cap = (text: string, max: number) => (full ? text.trim() : cappedSection(text, max));

  const workspaceBlock = [
    `Name: ${context.workspace.name}`,
    "",
    `Working directory: ${context.workspace.workDirectory}`,
    "",
    "Repository rules are in `AGENTS.md`/`CLAUDE.md` at the root; your CLI has loaded them. They are not repeated here.",
  ].join("\n");

  const omitStanding = !full && descriptionContainedInInstructions(
    context.workspace.description,
    context.workspace.agentsMd,
    context.workspace.claudeMd,
  );
  const standing = omitStanding || context.workspace.description.trim() === ""
    ? ""
    : section("Standing instructions", cap(context.workspace.description, 2 * 1024));

  const programBody = [
    `${context.program.externalKey ? `${context.program.externalKey} — ` : ""}${context.program.name}`,
    "",
    context.program.overview.trim(),
  ].join("\n");
  const suiteBody = [
    `${context.suite.externalKey ? `${context.suite.externalKey} — ` : ""}${context.suite.name}`,
    "",
    context.suite.overview.trim(),
  ].join("\n");

  let parentSection = "";
  if (context.parent !== null) {
    const siblingLines = context.parent.siblings.length === 0
      ? "None."
      : context.parent.siblings.map((s) => `- ${s.externalKey ?? "(no key)"} — ${s.title} — ${s.status}`).join("\n");
    const brief = context.parent.resumeBrief.trim() === ""
      ? ""
      : `\n\n### Resume brief\n\n${cap(context.parent.resumeBrief, 2 * 1024)}`;
    parentSection = section(
      "Parent",
      `${context.parent.externalKey ? `${context.parent.externalKey} — ` : ""}${context.parent.title}\n\n`
        + `${cap(context.parent.content, 6 * 1024)}${brief}\n\n### Siblings\n\n${siblingLines}`,
    );
  }

  const dependencies = context.dependencies.length === 0
    ? "None."
    : context.dependencies.map((item) =>
      `- ${item.externalKey ?? item.title} — ${item.status}${item.result.trim() === "" ? "" : `\n  Result: ${item.result.trim()}`}`
    ).join("\n");
  const gate = context.gate === null
    ? ""
    : section("Program gate", cap(`${context.gate.code} — ${context.gate.name}\n\n${context.gate.description}`, 1024));
  const depSection = section("Dependencies / gate", cap(dependencies, 1024)) + gate;

  // Integration checklist for a resumed parent. Absent when there are no
  // children — a station that never decomposed must not see an empty section.
  let subStepsSection = "";
  if (context.children.length > 0) {
    const lines = context.children.map((child) => {
      const label = `${child.externalKey ?? "(no key)"} — ${child.title}`;
      if (child.status === "SKIPPED") {
        const reason = child.result.trim() === "" ? "" : ` — ${child.result.trim()}`;
        return `- ${label} — SKIPPED${reason}`;
      }
      const resultBody = child.result.trim() === "" ? "" : `\n  ${cap(child.result, 600)}`;
      return `- ${label} — ${child.status}${resultBody}`;
    }).join("\n");
    subStepsSection = section("Sub-steps", cap(lines, 8 * 1024));
  }

  const verification = context.verificationCommands.length === 0
    ? ""
    : section("Verification", cap(
      context.verificationCommands.map((command) => `- \`${command}\``).join("\n"),
      1024,
    ));

  const stoppedSource = full ? context.history.remarks : context.stoppedRemarks;
  const stopped = stoppedSource.length === 0
    ? "None."
    : stoppedSource.map(formatRemark).join("\n\n");
  const clarificationsSource = full
    ? context.clarifications
    : context.clarifications.filter((item) => item.state === "DONE" && item.answer !== null);
  // agentContext already filters to "answered since last DONE/TODO" for the
  // default path; full keeps every exchange. Re-check state here so a stale
  // fixture cannot smuggle an unanswered row into the capped section.
  const clarifications = clarificationsSource.length === 0
    ? "None."
    : clarificationsSource.map((item) =>
      `### Human question\n\n${item.question}\n\n### Agent answer\n\n${item.answer ?? `(${item.state.toLowerCase()})`}`
    ).join("\n\n");

  return `# Work item ${key} — ${context.prompt.title}\n\n`
    + `This database response is the authoritative work-item context. Do not search for a Markdown prompt file and do not update one.\n\n`
    + `## Workspace\n\n${workspaceBlock}\n\n`
    + standing
    + `## Program\n\n${cap(programBody, 1024)}\n\n`
    + `## Suite\n\n${cap(suiteBody, 4 * 1024)}\n\n`
    + parentSection
    + depSection
    + `## Work item\n\n${context.prompt.content.trim()}\n\n`
    + subStepsSection
    + verification
    + section("Where the last run stopped", cap(stopped, 6 * 1024))
    + section("Clarifications", cap(clarifications, 2 * 1024))
    + executeProtocol(canDecompose);
}

/** Consult / clarify keep the pre-diet layout. */
function legacyContextMarkdown(context: AgentPromptContext, purpose: ContextPurpose, extras?: ContextExtras): string {
  const key = context.prompt.externalKey ?? String(context.prompt.id);
  const dependencies = context.dependencies.length === 0
    ? "None."
    : context.dependencies.map((item) =>
      `- ${item.externalKey ?? item.title} — ${item.status}${item.result.trim() === "" ? "" : `\n  Result: ${item.result.trim()}`}`
    ).join("\n");
  const gate = context.gate === null
    ? ""
    : section("Program gate", `${context.gate.code} — ${context.gate.name}\n\n${context.gate.description}`);
  const history = context.history.remarks.length === 0
    ? "None."
    : context.history.remarks.map(formatRemark).join("\n\n");
  const clarifications = context.clarifications.length === 0
    ? "None."
    : context.clarifications.map((item) =>
      `### Human question\n\n${item.question}\n\n### Agent answer\n\n${item.answer ?? `(${item.state.toLowerCase()})`}`
    ).join("\n\n");
  const protocol = purpose === "clarify"
    ? `## Clarification protocol\n\nDo not implement or modify anything. Answer only the human's clarifying question using this work-item context. If the answer is uncertain, state exactly what is unknown.`
    : CONSULT_PROTOCOL;
  const prefix = purpose === "consult" ? `${liveTreeBanner(extras?.liveWriter)}${CONSULT_STANDING}\n\n` : "";
  const question = purpose === "consult" && extras?.question?.trim()
    ? section("Question", extras.question)
    : "";
  return prefix + `# Work item ${key} — ${context.prompt.title}\n\n`
    + `This database response is the authoritative work-item context. Do not search for a Markdown prompt file and do not update one.\n\n`
    + `## Workspace\n\nName: ${context.workspace.name}\n\nWorking directory: ${context.workspace.workDirectory}\n\n`
    + section("Standing instructions", context.workspace.description)
    + `## Program\n\n${context.program.externalKey ? `${context.program.externalKey} — ` : ""}${context.program.name}\n\n${context.program.overview.trim()}\n\n`
    + `## Suite\n\n${context.suite.externalKey ? `${context.suite.externalKey} — ` : ""}${context.suite.name}\n\n${context.suite.overview.trim()}\n\n`
    + `## Status\n\n${context.prompt.status}\n\n`
    + `## Dependencies\n\n${dependencies}\n\n` + gate
    + `## Work item\n\n${context.prompt.content.trim()}\n\n`
    + `## Prior run context and human responses\n\n${history}\n\n`
    + `## Prior clarification questions and answers\n\n${clarifications}\n\n`
    + question
    + protocol;
}

export function consultWorkspaceMarkdown(args: {
  workspace: { name: string; workDirectory: string; description: string };
  question: string;
  liveWriter?: LiveWriter | null;
}): string {
  return liveTreeBanner(args.liveWriter)
    + `# Research consult\n\n${CONSULT_STANDING}\n\n`
    + `## Workspace\n\nName: ${args.workspace.name}\n\nWorking directory: ${args.workspace.workDirectory}\n\n`
    + section("Standing instructions", args.workspace.description)
    + section("Question", args.question)
    + CONSULT_PROTOCOL + "\n";
}

export interface ProgressApiArgs {
  /**
   * Absolute path to this run's `agent-step` launcher, or null when it could
   * not be written — in which case the raw HTTP contract is emitted instead.
   */
  shimPath?: string | null;
  runId: string;
  token: string;
  port: number;
  /** False at maximum decompose depth: the operation would be refused. */
  canDecompose: boolean;
  /**
   * When true, emit the curl contract *instead of* the shim (providers that
   * cannot exec the launcher). Defaults to `shimPath == null`.
   */
  usesCurl?: boolean;
}

/**
 * The orchestration contract an execute run works through. Kept beside the
 * context it is appended to, so the two stay in step, and depth-aware so a leaf
 * sub-step is never handed an operation the server will reject.
 */
export function progressApiMarkdown(args: ProgressApiArgs): string {
  const usesCurl = args.usesCurl ?? args.shimPath == null;
  if (usesCurl) return curlProgressApiMarkdown(args);

  const cmd = JSON.stringify(args.shimPath);
  const decompose = args.canDecompose
    ? `${cmd} decompose --file children.json\n`
    : "";
  return `## Recording your progress

${cmd}

${cmd} remark --kind PROGRESS --text "What changed or was verified"
${cmd} done --verification "Commands run and observable results"
${cmd} continue --remaining "What still has to happen"
${cmd} blocked --reason "Observed evidence" --action "Exact human action"
${decompose}Every requestId must be unique for this run.
The launcher supplies one; do not reuse a requestId across calls.
`;
}

function curlProgressApiMarkdown(args: ProgressApiArgs): string {
  const base = `http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}`;
  const auth = `-H 'Authorization: Bearer ${args.token}' -H 'Content-Type: application/json'`;
  const decompose = args.canDecompose
    ? `curl -fsS -X POST ${auth} ${base}/decompose -d '{"requestId":"unique-decompose-id","resumeBrief":"…","children":[{"title":"…","content":"…"}]}'\n`
    : "";
  return `## Recording your progress

Post through the Progress API (no launcher available for this provider):

curl -fsS -X POST ${auth} ${base}/remarks -d '{"requestId":"unique-remark-id","kind":"PROGRESS","content":"…"}'
curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"…"}'
curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"CONTINUE","reason":"…"}'
curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"…","verificationSummary":"…"}'
${decompose}Every requestId must be unique for this run.
Do not reuse a requestId across calls.
`;
}

/**
 * The run's remaining allowance, appended to the context and to every Progress
 * API response. The agent cannot see the runner's counters, so this is the only
 * way it learns to bank its work before it is stopped.
 */
export function budgetMarkdown(budget: BudgetSnapshot | null): string {
  if (budget === null) return "";
  const rows: string[] = [];
  const line = (label: string, used: number, limit: number | null, format: (value: number) => string) => {
    if (limit === null) return;
    rows.push(`- ${label}: ${format(used)} of ${format(limit)} (${Math.round((used / limit) * 100)}%)`);
  };
  line("Tool calls", budget.toolCalls.used, budget.toolCalls.limit, (value) => value.toLocaleString());
  line("Wall clock", budget.wallClockMs.used, budget.wallClockMs.limit, (value) => `${Math.round(value / 60_000)} min`);
  line("Input tokens (cache reads discounted)", budget.inputTokens.used, budget.inputTokens.limit, (value) => value.toLocaleString());
  line("Tool output", budget.toolOutputBytes.used, budget.toolOutputBytes.limit, (value) => `${Math.round(value / 1024)} KB`);
  if (rows.length === 0) return "";
  return `\n## Run budget\n\n${rows.join("\n")}\n${budget.warning === null ? "" : `\n**${budget.warning}**\n`}`;
}

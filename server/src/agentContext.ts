import type { AgentPromptContext } from "./workspaces.ts";
import type { BudgetSnapshot } from "./runner.ts";

export type ContextPurpose = "execute" | "clarify" | "consult";

export interface LiveWriter {
  provider: string;
  model: string | null;
}

function section(title:string,content:string):string { return content.trim()===""?"":`## ${title}\n\n${content.trim()}\n\n`; }

const CONSULT_STANDING = "Answer a research question about this working tree. Do not implement, edit, or run mutating commands. Tools that write or execute are unavailable. The tree may be changing under you if a writer is active.";

const CONSULT_PROTOCOL = `## Consult protocol

You cannot post remarks or status. This run is read-only research. Do not call the Progress API. Answer the human's question from the repository and this context.`;

export function liveTreeBanner(writer: LiveWriter | null | undefined): string {
  if (writer === null || writer === undefined) return "";
  const model = writer.model === null || writer.model === "" ? "" : ` · ${writer.model}`;
  return `## Live tree\n\nA writer (${writer.provider}${model}) is in this workspace. You are reading a live tree. Files may be mid-edit. Do not treat a partial file as final.\n\n`;
}

export interface ContextExtras { liveWriter?:LiveWriter|null; question?:string; /** Decompose depth; a leaf is never told it may decompose. */ depth?:number; maxDepth?:number }

export function contextMarkdown(context:AgentPromptContext,purpose:ContextPurpose="execute",extras?:ContextExtras):string {
  const key=context.prompt.externalKey??String(context.prompt.id);
  const dependencies=context.dependencies.length===0?"None.":context.dependencies.map(item=>`- ${item.externalKey??item.title} — ${item.status}${item.result.trim()===""?"":`\n  Result: ${item.result.trim()}`}`).join("\n");
  const gate=context.gate===null?"":section("Program gate",`${context.gate.code} — ${context.gate.name}\n\n${context.gate.description}`);
  const history=context.history.remarks.length===0?"None.":context.history.remarks.map(item=>`### ${item.actorType} · ${item.kind} · ${item.createdAt}\n\n${item.content.trim()}`).join("\n\n");
  const clarifications=context.clarifications.length===0?"None.":context.clarifications.map(item=>`### Human question\n\n${item.question}\n\n### Agent answer\n\n${item.answer??`(${item.state.toLowerCase()})`}`).join("\n\n");
  const canDecompose=(extras?.depth??0)<(extras?.maxDepth??2);
  const decomposeParagraph=canDecompose
    ?`Before prolonged implementation, assess whether the remaining work can realistically be completed and verified in this execution window. If it contains multiple mostly independent slices (for example many endpoints, files, modules, or migration batches) and cannot, use the Progress API's decompose operation early. Create the smallest 2-12 independently completable and verifiable sub-steps that cover the remaining work. Preserve completed investigation or implementation in the resume brief, make every child instruction self-contained, and reserve the resumed parent run for integration and final verification. Do not decompose a straightforward task merely because it is difficult, and do not keep grinding until the execution window is exhausted.\n\n`
    :`This work item is already a sub-step at the maximum depth, so it cannot be decomposed further — the decompose operation will be refused. It is a slice, sized to be finished in one run. Finish it, or report BLOCKED with the specific external dependency in the way.\n\n`;
  const protocol=purpose==="execute"?`## Completion and blocker protocol\n\nExecute and verify this work item honestly. Prompt status and results are maintained in the workspace database; do not look for or edit a tracker file.\n\n${decomposeParagraph}BLOCKED is reserved for a concrete external dependency that prevents further meaningful work and requires a specific action from the human. Incomplete implementation, a large remaining scope, uncertainty that can be resolved from the repository, and decisions already delegated to you are not blockers. Continue working or decompose in those cases. Before declaring BLOCKED, exhaust safe in-scope alternatives and re-check the repository and runtime state.\n\nTreat documented project launchers and preflight commands as the authoritative way to obtain local capabilities. Before reporting a missing credential, CLI login, network path, Docker service, or webhook listener, run the relevant preflight and inspect prior verification evidence. Do not ask the human to paste a secret into chat. Distinguish an unavailable capability from a capability that was already certified for an unchanged dependency; rerun external verification only when the work item requires it or the relevant implementation changed.\n\nWhen resuming after a HUMAN_RESPONSE, treat that response as authoritative new context. Do not repeat an earlier blocker unless you have verified that the supplied action did not resolve it. If it did not, report the new evidence and a different or more precise human action.\n\nA BLOCKED status must include both the evidence-based reason and a verificationSummary containing the exact action only the human can take. A vague request such as "finish the remaining work", "provide guidance", or "make a decision" is invalid.`:purpose==="clarify"?`## Clarification protocol\n\nDo not implement or modify anything. Answer only the human's clarifying question using this work-item context. If the answer is uncertain, state exactly what is unknown.`:CONSULT_PROTOCOL;
  const prefix=purpose==="consult"?`${liveTreeBanner(extras?.liveWriter)}${CONSULT_STANDING}\n\n`:"";
  const question=purpose==="consult"&&extras?.question?.trim()?section("Question",extras.question):"";
  return prefix+`# Work item ${key} — ${context.prompt.title}\n\n`+
    `This database response is the authoritative work-item context. Do not search for a Markdown prompt file and do not update one.\n\n`+
    `## Workspace\n\nName: ${context.workspace.name}\n\nWorking directory: ${context.workspace.workDirectory}\n\n`+
    section("Standing instructions",context.workspace.description)+
    `## Program\n\n${context.program.externalKey?`${context.program.externalKey} — `:""}${context.program.name}\n\n${context.program.overview.trim()}\n\n`+
    `## Suite\n\n${context.suite.externalKey?`${context.suite.externalKey} — `:""}${context.suite.name}\n\n${context.suite.overview.trim()}\n\n`+
    `## Status\n\n${context.prompt.status}\n\n`+
    `## Dependencies\n\n${dependencies}\n\n`+gate+
    `## Work item\n\n${context.prompt.content.trim()}\n\n`+
    `## Prior run context and human responses\n\n${history}\n\n`+
    `## Prior clarification questions and answers\n\n${clarifications}\n\n`+
    question+
    protocol;
}

export function consultWorkspaceMarkdown(args:{workspace:{name:string;workDirectory:string;description:string};question:string;liveWriter?:LiveWriter|null}):string {
  return liveTreeBanner(args.liveWriter)+
    `# Research consult\n\n${CONSULT_STANDING}\n\n`+
    `## Workspace\n\nName: ${args.workspace.name}\n\nWorking directory: ${args.workspace.workDirectory}\n\n`+
    section("Standing instructions",args.workspace.description)+
    section("Question",args.question)+
    CONSULT_PROTOCOL+"\n";
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
}

/**
 * The orchestration contract an execute run works through. Kept beside the
 * context it is appended to, so the two stay in step, and depth-aware so a leaf
 * sub-step is never handed an operation the server will reject.
 */
export function progressApiMarkdown(args: ProgressApiArgs): string {
  const base = `http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}`;
  const auth = `-H 'Authorization: Bearer ${args.token}' -H 'Content-Type: application/json'`;

  // When the launcher could not be written the raw HTTP contract is all there
  // is, so it stays in the document either way. It is demoted to a fallback
  // rather than removed: a model that cannot run the command must still have a
  // way to report, and silently having none is the failure this all guards
  // against.
  const step = args.shimPath ?? null;
  const cmd = step === null ? null : JSON.stringify(step);

  const decomposeCommand = cmd === null
    ? `\`\`\`bash\ncurl -fsS -X POST ${auth} ${base}/decompose -d '{"requestId":"unique-decompose-id","resumeBrief":"What you already established and verified","children":[{"title":"Short unique title","content":"Full, self-contained instructions for this slice"}]}'\n\`\`\``
    : `\`\`\`bash\n# children.json: [{"title":"…","content":"…"}, …]\n${cmd} decompose --file children.json\n\`\`\``;

  const decompose = args.canDecompose
    ? `If the remaining scope will not realistically fit in this execution window (large, mostly-independent chunks of work — e.g. a long list of endpoints, files, or modules), decompose instead of grinding until you run out of room or report a false BLOCKED. Split the remaining work into 2-12 sub-steps, each independently completable and independently verifiable, and hand off:\n\n${decomposeCommand}\n\nEach child's \`content\` is the only context that sub-step run will see, so make it self-contained. Each sub-step runs to its own DONE or BLOCKED, in the order listed, as a real tracked work item. Once every sub-step is DONE, a fresh run resumes this same work item with their outcomes in its history to do final integration and post this item's own DONE or BLOCKED. Decomposing is not itself DONE or BLOCKED.\n\n`
    : `This work item is a sub-step at the maximum depth and cannot be decomposed; that request will be refused. Finish it or report BLOCKED.\n\n`;

  if (cmd === null) {
    return `## Recording your progress

This run is already marked IN_PROGRESS. These endpoints are the only way to change orchestration records. **The database is outside this working directory and you cannot reach it any other way** — there is no tracker file to edit, and nothing you write in the repository changes this work item's status.

Post a remark with:

\`\`\`bash
curl -fsS -X POST ${auth} ${base}/remarks -d '{"requestId":"unique-remark-id","kind":"PROGRESS","content":"What changed or was discovered"}'
\`\`\`

Allowed remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.

**Every response carries a \`budget\` object** with this run's remaining tool calls, wall clock, input tokens and tool-output bytes. Post a PROGRESS remark after each verified slice: it is how you check the budget, and it is what makes your work resumable if the run is stopped. A run that banks nothing and is then stopped has produced nothing.

Before finishing, post exactly one terminal status:

\`\`\`bash
curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"Commands run and observable results"}'
\`\`\`

BLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker.

\`\`\`bash
curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"Observed evidence showing why execution cannot continue","verificationSummary":"Exact action only the human can take"}'
\`\`\`

${decompose}Every requestId must be unique for this run.

`;
  }

  return `## Recording your progress

This run is already marked IN_PROGRESS. One command records everything; it already holds this run's credentials, so there is no URL, header or id for you to assemble:

\`\`\`bash
${cmd} remark --kind PROGRESS --text "What changed or was verified"
${cmd} done    --verification "The commands you ran and what you observed"
${cmd} blocked --reason "Observed evidence" --action "The exact action only the human can take"
${cmd} context   # re-read this work item
${cmd} state     # everything recorded against it so far
\`\`\`

**The database is outside this working directory and you cannot reach it any other way.** There is no tracker file to edit, and nothing you write in the repository changes this work item's status. Run \`${cmd} help\` for the full usage.

Allowed remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.

**Each command prints this run's remaining budget** — tool calls, wall clock, input tokens and tool-output bytes. Post a PROGRESS remark after each verified slice: it is how you see the budget, and it is what makes your work resumable if the run is stopped. A run that banks nothing and is then stopped has produced nothing.

**Before finishing you must run exactly one of \`done\` or \`blocked\`.** A run that ends without one is recorded as *unreported* — not as success and not as failure — and a reviewer is sent to work out whether the work was actually finished. That costs an extra agent run, so report your own outcome.

The command exits non-zero and says why if it is refused. Read the message and act on it; do not assume a status was recorded.

BLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker — do it.

${decompose}`;
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

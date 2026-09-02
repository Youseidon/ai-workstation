import type { AgentPromptContext } from "./workspaces.ts";

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

export function contextMarkdown(context:AgentPromptContext,purpose:ContextPurpose="execute",extras?:{liveWriter?:LiveWriter|null;question?:string}):string {
  const key=context.prompt.externalKey??String(context.prompt.id);
  const dependencies=context.dependencies.length===0?"None.":context.dependencies.map(item=>`- ${item.externalKey??item.title} — ${item.status}${item.result.trim()===""?"":`\n  Result: ${item.result.trim()}`}`).join("\n");
  const gate=context.gate===null?"":section("Program gate",`${context.gate.code} — ${context.gate.name}\n\n${context.gate.description}`);
  const history=context.history.remarks.length===0?"None.":context.history.remarks.map(item=>`### ${item.actorType} · ${item.kind} · ${item.createdAt}\n\n${item.content.trim()}`).join("\n\n");
  const clarifications=context.clarifications.length===0?"None.":context.clarifications.map(item=>`### Human question\n\n${item.question}\n\n### Agent answer\n\n${item.answer??`(${item.state.toLowerCase()})`}`).join("\n\n");
  const protocol=purpose==="execute"?`## Completion and blocker protocol\n\nExecute and verify this work item honestly. Prompt status and results are maintained in the workspace database; do not look for or edit a tracker file.\n\nBefore prolonged implementation, assess whether the remaining work can realistically be completed and verified in this execution window. If it contains multiple mostly independent slices (for example many endpoints, files, modules, or migration batches) and cannot, use the Progress API's decompose operation early. Create the smallest 2-12 independently completable and verifiable sub-steps that cover the remaining work. Preserve completed investigation or implementation in the resume brief, make every child instruction self-contained, and reserve the resumed parent run for integration and final verification. Do not decompose a straightforward task merely because it is difficult, and do not keep grinding until the execution window is exhausted.\n\nBLOCKED is reserved for a concrete external dependency that prevents further meaningful work and requires a specific action from the human. Incomplete implementation, a large remaining scope, uncertainty that can be resolved from the repository, and decisions already delegated to you are not blockers. Continue working or decompose in those cases. Before declaring BLOCKED, exhaust safe in-scope alternatives and re-check the repository and runtime state.\n\nTreat documented project launchers and preflight commands as the authoritative way to obtain local capabilities. Before reporting a missing credential, CLI login, network path, Docker service, or webhook listener, run the relevant preflight and inspect prior verification evidence. Do not ask the human to paste a secret into chat. Distinguish an unavailable capability from a capability that was already certified for an unchanged dependency; rerun external verification only when the work item requires it or the relevant implementation changed.\n\nWhen resuming after a HUMAN_RESPONSE, treat that response as authoritative new context. Do not repeat an earlier blocker unless you have verified that the supplied action did not resolve it. If it did not, report the new evidence and a different or more precise human action.\n\nA BLOCKED status must include both the evidence-based reason and a verificationSummary containing the exact action only the human can take. A vague request such as "finish the remaining work", "provide guidance", or "make a decision" is invalid.`:purpose==="clarify"?`## Clarification protocol\n\nDo not implement or modify anything. Answer only the human's clarifying question using this work-item context. If the answer is uncertain, state exactly what is unknown.`:CONSULT_PROTOCOL;
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

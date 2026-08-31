import type { AgentPromptContext } from "./workspaces.ts";

function section(title:string,content:string):string { return content.trim()===""?"":`## ${title}\n\n${content.trim()}\n\n`; }

export function contextMarkdown(context:AgentPromptContext,purpose:"execute"|"clarify"="execute"):string {
  const key=context.prompt.externalKey??String(context.prompt.id);
  const dependencies=context.dependencies.length===0?"None.":context.dependencies.map(item=>`- ${item.externalKey??item.title} — ${item.status}${item.result.trim()===""?"":`\n  Result: ${item.result.trim()}`}`).join("\n");
  const gate=context.gate===null?"":section("Program gate",`${context.gate.code} — ${context.gate.name}\n\n${context.gate.description}`);
  const history=context.history.remarks.length===0?"None.":context.history.remarks.map(item=>`### ${item.actorType} · ${item.kind} · ${item.createdAt}\n\n${item.content.trim()}`).join("\n\n");
  const clarifications=context.clarifications.length===0?"None.":context.clarifications.map(item=>`### Human question\n\n${item.question}\n\n### Agent answer\n\n${item.answer??`(${item.state.toLowerCase()})`}`).join("\n\n");
  return `# Work item ${key} — ${context.prompt.title}\n\n`+
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
    (purpose==="execute"?`## Completion and blocker protocol\n\nExecute and verify this work item honestly. Prompt status and results are maintained in the workspace database; do not look for or edit a tracker file.\n\nBLOCKED is reserved for a concrete external dependency that prevents further meaningful work and requires a specific action from the human. Incomplete implementation, a large remaining scope, uncertainty that can be resolved from the repository, and decisions already delegated to you are not blockers. Continue working in those cases. Before declaring BLOCKED, exhaust safe in-scope alternatives and re-check the repository and runtime state.\n\nTreat documented project launchers and preflight commands as the authoritative way to obtain local capabilities. Before reporting a missing credential, CLI login, network path, Docker service, or webhook listener, run the relevant preflight and inspect prior verification evidence. Do not ask the human to paste a secret into chat. Distinguish an unavailable capability from a capability that was already certified for an unchanged dependency; rerun external verification only when the work item requires it or the relevant implementation changed.\n\nWhen resuming after a HUMAN_RESPONSE, treat that response as authoritative new context. Do not repeat an earlier blocker unless you have verified that the supplied action did not resolve it. If it did not, report the new evidence and a different or more precise human action.\n\nA BLOCKED status must include both the evidence-based reason and a verificationSummary containing the exact action only the human can take. A vague request such as "finish the remaining work", "provide guidance", or "make a decision" is invalid.`:`## Clarification protocol\n\nDo not implement or modify anything. Answer only the human's clarifying question using this work-item context. If the answer is uncertain, state exactly what is unknown.`);
}

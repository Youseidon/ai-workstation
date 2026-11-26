import type { RunRole } from "./providers.ts";
import type { NormalizedEvent } from "./events.ts";
import type { PromptStatus } from "./workspaces.ts";
import type { RunChangeSummary } from "./changes.ts";

export interface PromptRunSummary {
  id: string;
  provider: string;
  model: string | null;
  role: RunRole;
  state: string;
  startedAt: string;
  endedAt: string | null;
  processActive: boolean;
}
export interface AgentRunActivity { id:string; provider:string; model:string|null; role:RunRole; state:string; startedAt:string; endedAt:string|null; events:NormalizedEvent[] }

export interface AgentSession extends AgentRunActivity {
  threadId:string|null;
  threadTitle:string|null;
  providerSessionId:string|null;
  workspaceId:number;
  workspaceName:string;
  workDirectory:string;
  promptId:number|null;
  promptKey:string|null;
  promptTitle:string;
  promptStatus:PromptStatus|null;
  programName:string;
  suiteName:string;
  displayText:string|null;
  changes:RunChangeSummary|null;
}

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
  /** Provider-neutral Chat thread. Null for work-item, consult, author, and legacy runs. */
  threadId:string|null;
  /** Concise, stable name for a custom Chat thread. */
  threadTitle:string|null;
  /** Provider-owned conversation id, used to resume this provider after reopening Chat. */
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
  /** Chat-box / consult instruction. Null for saved work items and older rows. */
  displayText:string|null;
  /** Git-backed changes attributed to this run. Null for legacy/read-only runs. */
  changes:RunChangeSummary|null;
}

import type { TokenUsage, PromptRecord, PromptRemark, PromptStatusEvent, ClarificationExchange } from "@hydra/shared";


/** What a finished run spent, as recorded by the runner. */
export interface RunCostMetrics { processStarted?:boolean|null; usage: TokenUsage | null; toolCalls: number; toolOutputBytes: number; stopReason: string | null; peakMemoryBytes?: number | null; sessionId?: string | null }

export interface AgentPromptParentContext {
  externalKey:string|null;
  title:string;
  content:string;
  /** Latest CONTINUATION remark, or the resumeBrief filed with the parent's decompose. */
  resumeBrief:string;
  siblings:Array<{externalKey:string|null;title:string;status:PromptRecord["status"]}>;
}

/** One direct child of a decompose parent, for the integration checklist. */
export interface AgentPromptChildSummary {
  externalKey:string|null;
  title:string;
  status:PromptRecord["status"];
  /** DONE verification summary, or the skip reason from the ledger for SKIPPED. */
  result:string;
}

export interface AgentPromptContext {
  workspace:{id:number;name:string;workDirectory:string;description:string;agentsMd:string;claudeMd:string};
  program:{id:number;externalKey:string|null;name:string;overview:string};
  suite:{id:number;externalKey:string|null;name:string;overview:string};
  prompt:PromptRecord;
  /** Non-null only for a decompose sub-step. */
  parent:AgentPromptParentContext|null;
  /** Direct sub-steps; empty when this item was never decomposed. */
  children:AgentPromptChildSummary[];
  /** Resolved DoD COMMAND lines the server will run when the agent posts `done`. */
  verificationCommands:string[];
  /**
   * Curated remarks for the execute "Where the last run stopped" section —
   * CONTINUATION, latest BLOCKER (+ HUMAN_RESPONSE when still pending), and the
   * last few PROGRESS/VERIFICATION notes. Never includes AGENT_RESPONSE.
   */
  stoppedRemarks:PromptRemark[];
  /**
   * Operator briefings for this work item only (OPERATOR_BRIEFING), written
   * since it last reached DONE, oldest first. Rendered at the very top of the
   * execute prompt; never carried to another work item.
   */
  briefings:PromptRemark[];
  dependencies:Array<{externalKey:string|null;title:string;status:PromptRecord["status"];result:string}>;
  gate:{code:string;name:string;description:string}|null;
  history:{remarks:PromptRemark[];events:PromptStatusEvent[]};
  clarifications:ClarificationExchange[];
}

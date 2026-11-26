import type { TokenUsage, PromptRecord, PromptRemark, PromptStatusEvent, ClarificationExchange } from "@hydra/shared";


export interface RunCostMetrics { processStarted?:boolean|null; usage: TokenUsage | null; toolCalls: number; toolOutputBytes: number; stopReason: string | null; peakMemoryBytes?: number | null; sessionId?: string | null }

export interface AgentPromptParentContext {
  externalKey:string|null;
  title:string;
  content:string;
  resumeBrief:string;
  siblings:Array<{externalKey:string|null;title:string;status:PromptRecord["status"]}>;
}

export interface AgentPromptChildSummary {
  externalKey:string|null;
  title:string;
  status:PromptRecord["status"];
  result:string;
}

export interface AgentPromptContext {
  workspace:{id:number;name:string;workDirectory:string;description:string;agentsMd:string;claudeMd:string};
  program:{id:number;externalKey:string|null;name:string;overview:string};
  suite:{id:number;externalKey:string|null;name:string;overview:string};
  prompt:PromptRecord;
  parent:AgentPromptParentContext|null;
  children:AgentPromptChildSummary[];
  verificationCommands:string[];
  stoppedRemarks:PromptRemark[];
  briefings:PromptRemark[];
  dependencies:Array<{externalKey:string|null;title:string;status:PromptRecord["status"];result:string}>;
  gate:{code:string;name:string;description:string}|null;
  history:{remarks:PromptRemark[];events:PromptStatusEvent[]};
  clarifications:ClarificationExchange[];
}

import type { NormalizedEvent } from "./events.ts";
import type { OperationsPrompt } from "./operations.ts";
import type { ClarificationExchange, PromptRemark, PromptStatusEvent } from "./workspaces.ts";
import type { AgentSession } from "./runs.ts";
import type { CompletionAuditRecord } from "./completionAudit.ts";

export type SuiteVerificationVerdict = "PASS" | "WARNING" | "FAIL";
export type SuiteVerificationCheck = "VERIFIED" | "WARNING" | "FAILED" | "UNVERIFIED";
export type SuiteVerificationKind = "AGENT" | "AUDIT";
export type SuiteVerificationState = "RUNNING" | "DONE" | "INTERRUPTED" | "ERROR" | "RECORDED";

export interface SuiteVerificationItem {
  promptId: number | null;
  promptKey: string | null;
  title: string;
  check: SuiteVerificationCheck;
  evidence: string;
  commands: string;
}

export interface SuiteVerificationSummary {
  total: number;
  verified: number;
  warnings: number;
  failed: number;
  unverified: number;
}

export interface SuiteVerificationStats {
  workItems: number;
  sourceCharacters: number;
  dossierCharacters: number;
  uniqueCommands: number;
}

export interface SuiteVerificationRecord {
  id: number;
  suite: { id: number; key: string | null; name: string; programName: string; workspaceName: string; workspaceId: number };
  kind: SuiteVerificationKind;
  runId: string | null;
  provider: string | null;
  model: string | null;
  state: SuiteVerificationState;
  verdict: SuiteVerificationVerdict | null;
  summary: SuiteVerificationSummary;
  reportMarkdown: string;
  stats: SuiteVerificationStats | null;
  scopePromptId: number | null;
  startedAt: string;
  endedAt: string | null;
  items: SuiteVerificationItem[];
}

export interface SuiteVerificationDetail extends SuiteVerificationRecord {
  events: NormalizedEvent[];
}

export interface SuiteVerificationBadge {
  id: number;
  kind: SuiteVerificationKind;
  state: SuiteVerificationState;
  verdict: SuiteVerificationVerdict | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SuiteVerificationContext {
  suiteId: number;
  prompt: string;
  stats: SuiteVerificationStats;
  scopePromptId: number | null;
  scopePromptKey: string | null;
}
export interface PromptActivity {
  item: OperationsPrompt;
  remarks: PromptRemark[];
  events: PromptStatusEvent[];
  clarifications: ClarificationExchange[];
  sessions: AgentSession[];
  audits: CompletionAuditRecord[];
  producedWork: boolean;
}

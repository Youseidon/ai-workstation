import type { RunRole } from "./providers.ts";
import type { TokenUsage } from "../models/tokenUsage.ts";
import type { CostEstimate, UsageTotals } from "../models/cost.ts";

export interface SessionUsageRow {
  id: string;
  workspaceId: number;
  workspaceName: string;
  promptId: number | null;
  promptKey: string | null;
  promptTitle: string;
  suiteId: number | null;
  suiteName: string;
  programId: number | null;
  programName: string;
  provider: string;
  model: string | null;
  role: RunRole;
  state: string;
  startedAt: string;
  endedAt: string | null;
  usage: TokenUsage | null;
  cost: CostEstimate;
}

export interface TaskUsageRow {
  promptId: number;
  promptKey: string | null;
  promptTitle: string;
  suiteId: number;
  suiteName: string;
  programId: number;
  programName: string;
  workspaceId: number;
  workspaceName: string;
  totals: UsageTotals;
  sessionIds: string[];
}

export interface SuiteUsageRow {
  suiteId: number;
  suiteName: string;
  programId: number;
  programName: string;
  workspaceId: number;
  workspaceName: string;
  totals: UsageTotals;
  tasks: TaskUsageRow[];
}

export interface UsageReport {
  generatedAt: string;
  pricingNote: string;
  totals: UsageTotals;
  byProvider: Array<{ provider: string; totals: UsageTotals }>;
  suites: SuiteUsageRow[];
  unassigned: { totals: UsageTotals; sessionIds: string[] };
  sessions: SessionUsageRow[];
}

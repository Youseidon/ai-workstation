import type { ContractCriterion, ExecutionPolicy, ExecutionDesiredState, ExecutionStatus } from "@hydra/shared";
import type { ProcessIdentity } from "../contracts/execution.ts";

export interface ExecutionContract {
  id: string; promptId: number; originalPrompt: string; promptHash: string;
  authority: Record<string, unknown>; criteria: ContractCriterion[]; policy: ExecutionPolicy;
  budgetScope: string; engine: "shadow" | "supervised"; desired: ExecutionDesiredState;
  phase: ExecutionStatus["phase"]; revision: number; generation: number; version:number;
}
export interface ExecutionEffect {
  id: string; contractId: string; promptId: number; runId: string; generation: number;
  revision: number; state: string; payload: Record<string, unknown>; dueAt: number;
  process: ProcessIdentity | null; createdAt: number;
}
export interface ReserveExecutionArgs {
  contractId:string;promptId:number;requestId:string;expectedGeneration:number;revision:number;resource:string;
  payload:Record<string,unknown>;actor?:string;recovery?:boolean;dueAt?:number;
}

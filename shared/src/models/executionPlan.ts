export type ExecutionPhase = "implementation" | "verification" | "delivered";
export type ExecutionDesiredState = "RUNNING" | "PAUSED" | "STOPPED";
export interface ExecutionPolicy {
  maxAttempts: number;
  maxActiveMs: number;
  maxTokens: number;
  deadline: number;
  workerMs: number;
  workerTokens: number;
  unitAttempts: number;
  recoveryAttempts: number;
  maxReplans: number;
  maxProviderChanges: number;
}
export interface ContractCriterion {
  kind?: "COMMAND" | "PROSE" | "CHILDREN_CLOSED";
  id: string;
  text: string;
  sourceStart: number;
  sourceEnd: number;
  phase: "implementation" | "verification";
  verifierPromptId: number;
  dodCriterionId: number;
  sourceCriterionId?:string;
}
export interface ExecutionUnit {
  coverage?: "contribution" | "complete";
  promptId: number;
  criterionIds: string[];
  targets: string[];
  dependencies: number[];
  phase: "implementation" | "verification";
  recipeIds: number[];
  rationale: string;
}
export interface ExecutionPlan {
  additionalCriteria?: Array<{id:string;text:string;sourceStart:number;sourceEnd:number;verifierPromptId:number;sourceCriterionId:string}>;
  revision: number;
  units: ExecutionUnit[];
  rationale: string;
}
export interface ExecutionStatus {
  totalUnits:number;
  lastRecovery:string|null;
  exception:{code:string;reason:string}|null;
  nextWakeAt:number|null;
  contractId: string;
  engine: "shadow" | "supervised";
  desired: ExecutionDesiredState;
  phase: ExecutionPhase;
  revision: number;
  generation: number;
  acceptedUnits: number[];
  attempts: number;
  activeMs: number;
  tokens: number;
  reservedMs: number;
  reservedTokens: number;
  policy: ExecutionPolicy;
  lastDecision: string | null;
  pendingObligations: string[];
}

export function validateExecutionPolicy(policy: ExecutionPolicy, now = Date.now()): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid execution policy: ${key}`);
  }
  for (const key of ["maxAttempts", "maxActiveMs", "maxTokens", "workerMs", "workerTokens", "unitAttempts"] as const) {
    if (policy[key] < 1) throw new Error(`Execution policy needs finite positive ${key}`);
  }
  if (policy.deadline <= now) throw new Error("Delivery deadline has expired");
  if (policy.workerMs > policy.maxActiveMs || policy.workerTokens > policy.maxTokens) throw new Error("Worker reservation exceeds root envelope");
  if(policy.recoveryAttempts>0 && (policy.workerMs>policy.maxActiveMs*0.8 || policy.workerTokens>policy.maxTokens*0.8)) throw new Error("Envelope must include a worker and its recovery reserve");
  if (policy.recoveryAttempts >= policy.maxAttempts) throw new Error("Recovery reserve leaves no worker capacity");
}

export function validateExecutionPlan(
  criteria: readonly ContractCriterion[], plan: ExecutionPlan,
  previous?: ExecutionPlan, accepted: readonly number[] = [], maxUnits = 157, preserveTargets=true,
): void {
  if (!Number.isSafeInteger(plan.revision) || plan.revision !== (previous?.revision ?? 0) + 1) throw new Error("Plan revision conflict");
  if (plan.units.length === 0 || plan.units.length > maxUnits) throw new Error("Plan exceeds hierarchy limits");
  const known = new Map(criteria.map(c => [c.id, c]));
  if (known.size !== criteria.length || criteria.length === 0) throw new Error("Empty or duplicate criterion manifest");
  const ids = new Set(plan.units.map(u => u.promptId));
  if (ids.size !== plan.units.length) throw new Error("Duplicate work unit");
  const covered = new Set<string>();
  for (const unit of plan.units) {
    if (!Number.isSafeInteger(unit.promptId) || unit.promptId < 1 || !unit.rationale.trim() || unit.criterionIds.length === 0 || unit.targets.length === 0) throw new Error("Unbounded work unit");
    if (new Set(unit.criterionIds).size !== unit.criterionIds.length || new Set(unit.dependencies).size !== unit.dependencies.length) throw new Error("Duplicate assignment");
    for (const id of unit.criterionIds) {
      const criterion = known.get(id);
      if (!criterion) throw new Error(`Unknown criterion ${id}`);
      if (criterion.phase !== unit.phase) throw new Error(`Incorrect verification phase for ${id}`);
      covered.add(id);
    }
    if (unit.dependencies.some(dep => !ids.has(dep) || dep === unit.promptId)) throw new Error("Unknown or self dependency");
  }
  if (covered.size !== known.size) throw new Error("Plan drops original requirements");
  for(const id of known.keys()) if(!plan.units.some(unit=>unit.coverage!=="contribution" && unit.criterionIds.includes(id))) throw new Error("Criterion has no final integration owner");
  const visiting = new Set<number>(), visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new Error("Plan dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of plan.units.find(u => u.promptId === id)!.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  if(previous && preserveTargets) {
    const targets=new Set(plan.units.flatMap(unit=>unit.targets));
    for(const unit of previous.units.filter(unit=>!accepted.includes(unit.promptId))) {
      if(unit.targets.some(target=>!targets.has(target))) throw new Error("Replan drops a remaining target");
    }
  }
  for (const id of accepted) {
    const before = previous?.units.find(u => u.promptId === id);
    const after = plan.units.find(u => u.promptId === id);
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Replan reopens accepted scope");
  }
  for (const unit of plan.units.filter(u => u.phase === "implementation")) {
    if (unit.dependencies.some(id => plan.units.find(u => u.promptId === id)!.phase === "verification")) throw new Error("Implementation depends on deferred verification");
  }
}

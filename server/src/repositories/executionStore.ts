import type { ExecutionContract, ExecutionEffect, ReserveExecutionArgs } from "../models/execution.ts";
import type { ProcessIdentity } from "../contracts/execution.ts";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { validateExecutionPlan, validateExecutionPolicy, type ContractCriterion, type ExecutionDesiredState, type ExecutionPlan, type ExecutionPolicy, type ExecutionStatus } from "@hydra/shared";

export const executionSchema = `
CREATE TABLE delivery_contract (
  id TEXT PRIMARY KEY, prompt_id INTEGER NOT NULL UNIQUE REFERENCES prompt(id) ON DELETE CASCADE,
  original_prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL, authority_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL, policy_json TEXT NOT NULL, budget_scope TEXT NOT NULL,
  engine TEXT NOT NULL CHECK(engine IN ('shadow','supervised')),
  desired TEXT NOT NULL DEFAULT 'PAUSED' CHECK(desired IN ('RUNNING','PAUSED','STOPPED')),
  phase TEXT NOT NULL DEFAULT 'implementation', revision INTEGER NOT NULL DEFAULT 0,
  engine_version INTEGER NOT NULL DEFAULT 2, contract_version INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE delivery_contract_version (
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  original_prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL, criteria_json TEXT NOT NULL,
  authority_json TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(contract_id,version)
);
CREATE TABLE execution_plan (
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(contract_id,revision)
);
CREATE TABLE work_unit_meta (
  prompt_id INTEGER PRIMARY KEY REFERENCES prompt(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, unit_json TEXT NOT NULL, accepted_at INTEGER,
  recovery_stage INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE shared_verification (
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  unit_json TEXT NOT NULL, accepted_at INTEGER,
  PRIMARY KEY(contract_id,prompt_id)
);
CREATE TABLE execution_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  attempt_id TEXT, actor TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE dispatch_outbox (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','CLAIMED','RUNNING','SETTLED','QUARANTINED','CANCELLED')),
  payload_json TEXT NOT NULL, due_at INTEGER NOT NULL, process_json TEXT, result_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX dispatch_due ON dispatch_outbox(state,due_at);
CREATE TABLE execution_lease (
  resource TEXT PRIMARY KEY, effect_id TEXT, fencing_token INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, process_json TEXT
);
CREATE TABLE budget_ledger (
  effect_id TEXT PRIMARY KEY REFERENCES dispatch_outbox(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  budget_scope TEXT NOT NULL, prompt_id INTEGER NOT NULL, actor TEXT NOT NULL,
  reserved_ms INTEGER NOT NULL, reserved_tokens INTEGER NOT NULL,
  actual_ms INTEGER, actual_tokens INTEGER, unknown_usage INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX budget_scope_usage ON budget_ledger(budget_scope);
CREATE TABLE recovery_case (
  contract_id TEXT NOT NULL REFERENCES delivery_contract(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  signature TEXT NOT NULL, remedy TEXT NOT NULL, evidence TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(contract_id,prompt_id,signature,remedy)
);
CREATE TABLE execution_wakeup (
  contract_id TEXT PRIMARY KEY REFERENCES delivery_contract(id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL, prompt_id INTEGER NOT NULL, due_at INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE command_task (
  id TEXT PRIMARY KEY, contract_id TEXT REFERENCES delivery_contract(id) ON DELETE CASCADE,
  prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  run_id TEXT, criterion_id INTEGER NOT NULL REFERENCES dod_criterion(id) ON DELETE CASCADE,
  request_key TEXT UNIQUE, request_hash TEXT,
  recipe_hash TEXT NOT NULL, input_hash TEXT NOT NULL, environment_hash TEXT NOT NULL,
  state TEXT NOT NULL, process_json TEXT, started_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
  ended_at INTEGER, result_json TEXT, observations_json TEXT NOT NULL DEFAULT '[]', evidence_id INTEGER REFERENCES dod_result(id) ON DELETE SET NULL
);
ALTER TABLE dod_criterion ADD COLUMN supervisor_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dod_result ADD COLUMN input_hash TEXT;
ALTER TABLE dod_result ADD COLUMN recipe_hash TEXT;
ALTER TABLE dod_result ADD COLUMN environment_hash TEXT;
ALTER TABLE dod_result ADD COLUMN stable_inputs INTEGER NOT NULL DEFAULT 0;
`;
export function executionHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value,(_key,item)=>item && typeof item==="object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item)).digest("hex");
}
export class ExecutionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const fail = (code: string, message: string): never => { throw new ExecutionError(code, message); };

/** All mutation methods are short synchronous transactions, with no OS effects. */
export function createExecutionStore(db: Database.Database, clock = Date.now) {
  const event = (contractId: string, kind: string, payload: unknown, attemptId: string | null = null, actor = "SUPERVISOR") => {
    db.prepare("INSERT INTO execution_event(event_id,contract_id,attempt_id,actor,kind,payload_json,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), contractId, attemptId, actor, kind, JSON.stringify(payload), executionHash(payload), clock());
  };
  const contract = (id: string): ExecutionContract => {
    const row = db.prepare("SELECT * FROM delivery_contract WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return fail("contract_missing", "Execution contract not found");
    return { id, promptId: row.prompt_id as number, originalPrompt: row.original_prompt as string, promptHash: row.prompt_hash as string,
      authority: JSON.parse(row.authority_json as string), criteria: JSON.parse(row.criteria_json as string), policy: JSON.parse(row.policy_json as string),
      budgetScope: row.budget_scope as string, engine: row.engine as ExecutionContract["engine"], desired: row.desired as ExecutionDesiredState,
      version:row.contract_version as number,phase: row.phase as ExecutionContract["phase"], revision: row.revision as number, generation: row.generation as number };
  };
  const plan = (id: string): ExecutionPlan => {
    const c = contract(id);
    const row = db.prepare("SELECT plan_json FROM execution_plan WHERE contract_id=? AND revision=?").get(id, c.revision) as { plan_json: string } | undefined;
    if (!row) return fail("plan_missing", "A validated plan is required before dispatch");
    return JSON.parse(row.plan_json);
  };
  const effect = (id: string): ExecutionEffect => {
    const row = db.prepare("SELECT * FROM dispatch_outbox WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return fail("effect_missing", "Dispatch effect not found");
    return { id, contractId: row.contract_id as string, promptId: row.prompt_id as number, runId: row.run_id as string,
      generation: row.generation as number, revision: row.revision as number, state: row.state as string,
      payload: JSON.parse(row.payload_json as string), dueAt: row.due_at as number,
      process: row.process_json ? JSON.parse(row.process_json as string) : null, createdAt: row.created_at as number };
  };
  const accepted = (id: string): number[] => (db.prepare("SELECT prompt_id FROM work_unit_meta WHERE contract_id=? AND accepted_at IS NOT NULL UNION SELECT prompt_id FROM shared_verification WHERE contract_id=? AND accepted_at IS NOT NULL").all(id,id) as {prompt_id:number}[]).map(r => r.prompt_id);
  const totals = (scope: string) => db.prepare(`SELECT COUNT(*) attempts,
    COALESCE(SUM(COALESCE(actual_ms,reserved_ms)),0) activeMs,
    COALESCE(SUM(COALESCE(actual_tokens,reserved_tokens)),0) tokens,
    COALESCE(SUM(CASE WHEN actual_ms IS NULL THEN reserved_ms ELSE 0 END),0) reservedMs,
    COALESCE(SUM(CASE WHEN actual_tokens IS NULL THEN reserved_tokens ELSE 0 END),0) reservedTokens
    FROM budget_ledger WHERE budget_scope=?`).get(scope) as {attempts:number;activeMs:number;tokens:number;reservedMs:number;reservedTokens:number};
  const store = {
    contract, plan, effect, accepted, totals,
    writerOwner(resource:string):string|null {
      const row=db.prepare("SELECT effect_id FROM execution_lease WHERE resource=?").get(resource) as {effect_id:string|null}|undefined;
      if(!row?.effect_id) return null;
      const owner=db.prepare("SELECT run_id FROM dispatch_outbox WHERE id=?").get(row.effect_id) as {run_id:string}|undefined;
      return owner?.run_id ?? row.effect_id;
    },
    pendingAcceptance():number[] {
      return (db.prepare("SELECT u.prompt_id FROM work_unit_meta u JOIN prompt p ON p.id=u.prompt_id JOIN delivery_contract c ON c.id=u.contract_id WHERE u.accepted_at IS NULL AND p.status='DONE' AND c.engine='supervised' UNION SELECT v.prompt_id FROM shared_verification v JOIN prompt p ON p.id=v.prompt_id JOIN delivery_contract c ON c.id=v.contract_id WHERE v.accepted_at IS NULL AND p.status='DONE' AND c.engine='supervised'").all() as {prompt_id:number}[]).map(r=>r.prompt_id);
    },
    sharedConsumers(promptId:number):Array<{contract:ExecutionContract;unit:ExecutionPlan["units"][number]}> {
      return (db.prepare("SELECT v.contract_id,v.unit_json FROM shared_verification v JOIN delivery_contract c ON c.id=v.contract_id WHERE v.prompt_id=? AND c.engine='supervised'").all(promptId) as {contract_id:string;unit_json:string}[]).map(row=>({contract:contract(row.contract_id),unit:JSON.parse(row.unit_json)}));
    },
    byRun(runId:string):ExecutionEffect|null {
      const row=db.prepare("SELECT id FROM dispatch_outbox WHERE run_id=?").get(runId) as {id:string}|undefined;
      return row ? effect(row.id) : null;
    },
    unitUsage(id:string,promptId:number):{workers:number;recovery:number} {
      const c=contract(id);
      const workers=(db.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE contract_id=? AND prompt_id=? AND actor='worker'").get(id,promptId) as {n:number}).n;
      const recovery=(db.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE budget_scope=? AND actor='recovery'").get(c.budgetScope) as {n:number}).n;
      return {workers,recovery};
    },
    extendManifest(id:string,additions:ContractCriterion[]):void {
      const c=contract(id),criteria=[...c.criteria];
      for(const addition of additions) {
        const existing=criteria.find(cr=>cr.id===addition.id);
        if(existing) {if(executionHash(existing)!==executionHash(addition))fail("criterion_conflict","Derived criteria cannot rewrite an existing obligation");continue;}
        if(addition.phase!=="verification" || !addition.sourceCriterionId || !c.criteria.some(cr=>cr.id===addition.sourceCriterionId) || addition.sourceStart<0 || addition.sourceEnd>c.originalPrompt.length || addition.sourceStart>=addition.sourceEnd) fail("invalid_derivation","Additional checks must derive from an original obligation and source span");
        criteria.push(addition);
      }
      db.prepare("UPDATE delivery_contract SET criteria_json=? WHERE id=?").run(JSON.stringify(criteria),id);
      event(id,"criteria_derived",{before:c.criteria,after:criteria,originalPromptHash:c.promptHash});
    },
    proposePlan(id:string,proposal:ExecutionPlan):void {
      const c=contract(id);
      if(store.replanUsage(id)>=c.policy.maxReplans) fail("replan_limit","Approved replan allowance exhausted");
      validateExecutionPlan(c.criteria,proposal,plan(id),accepted(id));
      event(id,"plan_proposed",proposal);
    },
    forPrompt(promptId: number): ExecutionContract | null {
      const row = db.prepare("SELECT contract_id FROM work_unit_meta WHERE prompt_id=? UNION SELECT id contract_id FROM delivery_contract WHERE prompt_id=? LIMIT 1").get(promptId,promptId) as {contract_id:string}|undefined;
      return row ? contract(row.contract_id) : null;
    },
    adopt(args: { id?: string; promptId: number; originalPrompt: string; authority: Record<string, unknown>; criteria: ContractCriterion[]; policy: ExecutionPolicy; engine: ExecutionContract["engine"]; budgetScope?: string }): ExecutionContract {
      return db.transaction(() => {
        validateExecutionPolicy(args.policy,clock());
        if (args.criteria.length === 0 || new Set(args.criteria.map(c => c.id)).size !== args.criteria.length) fail("invalid_manifest", "A nonempty unique criterion manifest is required");
        for (const criterion of args.criteria) {
          if (!criterion.id || !criterion.text.trim() || !Number.isSafeInteger(criterion.sourceStart) || !Number.isSafeInteger(criterion.sourceEnd) || criterion.sourceStart < 0 || criterion.sourceEnd <= criterion.sourceStart || criterion.sourceEnd > args.originalPrompt.length) fail("invalid_manifest", "Criterion needs a source span in the original prompt");
        }
        const id = args.id ?? randomUUID();
        const budgetScope = args.budgetScope ?? id;
        const existingScope = db.prepare("SELECT policy_json FROM delivery_contract WHERE budget_scope=? LIMIT 1").get(budgetScope) as {policy_json:string}|undefined;
        if (existingScope && executionHash(JSON.parse(existingScope.policy_json)) !== executionHash(args.policy)) fail("budget_policy_conflict", "Shared pipeline budget requires the same policy snapshot");
        db.prepare("INSERT INTO delivery_contract(id,prompt_id,original_prompt,prompt_hash,authority_json,criteria_json,policy_json,budget_scope,engine,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(id,args.promptId,args.originalPrompt,executionHash(args.originalPrompt),JSON.stringify(args.authority),JSON.stringify(args.criteria),JSON.stringify(args.policy),budgetScope,args.engine,clock());
        db.prepare("INSERT INTO delivery_contract_version(contract_id,version,original_prompt,prompt_hash,criteria_json,authority_json,reason,created_at) VALUES(?,1,?,?,?,?,?,?)").run(id,args.originalPrompt,executionHash(args.originalPrompt),JSON.stringify(args.criteria),JSON.stringify(args.authority),"Initial operator intake",clock());
        event(id,"contract_adopted", { promptHash: executionHash(args.originalPrompt), policy: args.policy, engine: args.engine },null,"OPERATOR");
        return contract(id);
      })();
    },
    amendRequirement(id:string,args:{originalPrompt:string;criteria:ContractCriterion[];plan:ExecutionPlan;reason:string}):number[] {
      return db.transaction(()=>{
        const c=contract(id);
        if(!args.reason.trim()) fail("amendment_reason_required","An operator requirement amendment needs a reason");
        if(store.pending().some(e=>e.contractId===id)) fail("execution_active","Drain and reconcile effects before amending requirements");
        // Operator changes invalidate all units conservatively; budget and
        // attempt history remain attached to the same contract identity.
        const reopened=plan(id).units.map(u=>u.promptId);
        if(args.criteria.length===0 || new Set(args.criteria.map(cr=>cr.id)).size!==args.criteria.length) fail("invalid_manifest","Requirement amendment needs a nonempty unique manifest");
        for(const cr of args.criteria) if(!cr.text.trim() || cr.sourceStart<0 || cr.sourceEnd>args.originalPrompt.length || cr.sourceStart>=cr.sourceEnd) fail("invalid_manifest","Amended criteria need source spans");
        db.prepare("INSERT INTO delivery_contract_version(contract_id,version,original_prompt,prompt_hash,criteria_json,authority_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id,c.version+1,args.originalPrompt,executionHash(args.originalPrompt),JSON.stringify(args.criteria),JSON.stringify(c.authority),args.reason,clock());
        db.prepare("UPDATE delivery_contract SET contract_version=contract_version+1,original_prompt=?,prompt_hash=?,criteria_json=?,phase='implementation',desired='PAUSED' WHERE id=?").run(args.originalPrompt,executionHash(args.originalPrompt),JSON.stringify(args.criteria),id);
        db.prepare("UPDATE work_unit_meta SET accepted_at=NULL WHERE contract_id=?").run(id);
        db.prepare("UPDATE shared_verification SET accepted_at=NULL WHERE contract_id=?").run(id);
        store.activatePlan(id,args.plan,true);
        event(id,"requirement_amended",{version:c.version+1,reason:args.reason,beforeHash:c.promptHash,afterHash:executionHash(args.originalPrompt),beforeCriteria:c.criteria,afterCriteria:args.criteria,reopened},null,"OPERATOR");
        return reopened;
      })();
    },
    replanUsage(id:string):number {
      return Math.max(0,(db.prepare("SELECT COUNT(*) n FROM execution_event WHERE contract_id=? AND kind='plan_activated' AND actor='SUPERVISOR'").get(id) as {n:number}).n-1);
    },
    activatePlan(id: string, proposal: ExecutionPlan,operatorAmendment=false): ExecutionPlan {
      return db.transaction(() => {
        const c = contract(id), previous = c.revision > 0 ? plan(id) : undefined;
        if (c.phase === "delivered") fail("already_delivered", "Delivered requirements cannot be replanned");
        if (!operatorAmendment && store.replanUsage(id) >= c.policy.maxReplans && c.revision>0) fail("replan_limit", "Approved replan allowance exhausted");
        if (db.prepare("SELECT 1 FROM dispatch_outbox WHERE contract_id=? AND state IN ('PENDING','CLAIMED','RUNNING','QUARANTINED')").get(id)) fail("execution_active", "Drain and reconcile current effects before replanning");
        validateExecutionPlan(c.criteria,proposal,previous,accepted(id),157,!operatorAmendment);
        db.prepare("INSERT INTO execution_plan(contract_id,revision,plan_json,created_at) VALUES(?,?,?,?)").run(id,proposal.revision,JSON.stringify(proposal),clock());
        // Accepted rows survive; only unaccepted ownership can move.
        db.prepare("DELETE FROM work_unit_meta WHERE contract_id=? AND accepted_at IS NULL").run(id);
        db.prepare("DELETE FROM shared_verification WHERE contract_id=? AND accepted_at IS NULL").run(id);
        for (const unit of proposal.units) {
          const other = store.forPrompt(unit.promptId);
          if(other && other.id!==id) {
            const owned=plan(other.id).units.find(entry=>entry.promptId===unit.promptId);
            if(accepted(other.id).includes(unit.promptId))fail("verification_owner_closed","A completed verifier cannot be reopened by a new plan; assign a new verification owner");
            if(unit.phase!=="verification" || owned?.phase!=="verification" || other.budgetScope!==c.budgetScope || other.engine!=="supervised") fail("unit_owned","Only an enabled verification owner in the same approved budget scope may be shared");
            db.prepare("INSERT INTO shared_verification(contract_id,prompt_id,unit_json) VALUES(?,?,?) ON CONFLICT(contract_id,prompt_id) DO UPDATE SET unit_json=excluded.unit_json").run(id,unit.promptId,JSON.stringify(unit));
            continue;
          }
          db.prepare("INSERT INTO work_unit_meta(prompt_id,contract_id,revision,unit_json) VALUES(?,?,?,?) ON CONFLICT(prompt_id) DO UPDATE SET revision=excluded.revision,unit_json=excluded.unit_json")
            .run(unit.promptId,id,proposal.revision,JSON.stringify(unit));
        }
        db.prepare("UPDATE delivery_contract SET revision=?,generation=generation+1 WHERE id=?").run(proposal.revision,id);
        event(id,"plan_activated", { before:previous ?? null, after:proposal },null,operatorAmendment?"OPERATOR":"SUPERVISOR");
        return proposal;
      })();
    },
    setDesired(id: string, desired: ExecutionDesiredState): void {
      db.transaction(() => {
        if (!["RUNNING","PAUSED","STOPPED"].includes(desired)) fail("invalid_state", "Unknown desired state");
        contract(id);
        db.prepare("UPDATE delivery_contract SET desired=? WHERE id=?").run(desired,id);
        if (desired === "STOPPED") {
          const pending = db.prepare("SELECT id FROM dispatch_outbox WHERE contract_id=? AND state='PENDING'").all(id) as {id:string}[];
          for (const row of pending) store.cancelPending(row.id);
        }
        event(id,"desired_state",{desired},null,"OPERATOR");
      })();
    },
    enable(id: string): void {
      db.transaction(() => {
        contract(id);
        if (db.prepare("SELECT 1 FROM dispatch_outbox WHERE contract_id=? AND state IN ('CLAIMED','RUNNING','QUARANTINED')").get(id)) fail("execution_active", "Cannot change engines mid-command");
        db.prepare("UPDATE delivery_contract SET engine='supervised',generation=generation+1 WHERE id=?").run(id);
        event(id,"engine_enabled",{},null,"OPERATOR");
      })();
    },
    reserveWithRemedy(args:ReserveExecutionArgs,remedy?:{signature:string;action:string;evidence:string}):ExecutionEffect {
      return db.transaction(()=>{
        const prior=db.prepare("SELECT id FROM dispatch_outbox WHERE request_key=?").get(`${args.contractId}:${args.requestId}`) as {id:string}|undefined;
        const result=store.reserve(args);
        if(!prior && remedy && !store.remedy(args.contractId,args.promptId,remedy.signature,remedy.action,remedy.evidence)) fail("recovery_exhausted","An unchanged unsuccessful remedy cannot be repeated");
        return result;
      })();
    },
    reserve(args:ReserveExecutionArgs): ExecutionEffect {
      return db.transaction(() => {
        const requestKey = `${args.contractId}:${args.requestId}`, hash = executionHash(args);
        const prior = db.prepare("SELECT id,request_hash FROM dispatch_outbox WHERE request_key=?").get(requestKey) as {id:string;request_hash:string}|undefined;
        if (prior) { if (prior.request_hash !== hash) fail("idempotency_conflict", "Request ID reused for a different dispatch"); return effect(prior.id); }
        const c = contract(args.contractId), usage = totals(c.budgetScope);
        if (c.engine === "shadow") { event(c.id,"shadow_decision",args); return fail("shadow_only", "Shadow mode never dispatches work"); }
        if (c.desired !== "RUNNING" || c.phase === "delivered") fail("execution_held", "Requirement is not running");
        if (c.generation !== args.expectedGeneration || c.revision !== args.revision) fail("stale_generation", "Refresh execution generation and plan revision");
        const unit = plan(c.id).units.find(u => u.promptId === args.promptId);
        if (!unit) fail("unknown_unit", "Unit is absent from the active plan");
        const canonical=store.forPrompt(args.promptId);
        if(canonical && canonical.id!==c.id) fail("shared_verifier_owned","The canonical verification owner dispatches this work once");
        for(const consumer of store.sharedConsumers(args.promptId)) {
          if(consumer.unit.dependencies.some(dependency=>!accepted(consumer.contract.id).includes(dependency))) fail("dependencies_incomplete","A shared verification prerequisite remains open");
        }
        const closed = accepted(c.id);
        if (closed.includes(args.promptId)) fail("unit_accepted", "Accepted work cannot be scheduled again");
        if (unit!.dependencies.some(dep => !closed.includes(dep))) fail("dependencies_incomplete", "Unit dependencies remain open");
        if (unit!.phase === "verification" && plan(c.id).units.some(u => u.phase === "implementation" && !closed.includes(u.promptId))) fail("phase_not_ready", "Implementation is still pending");
        if (clock() + c.policy.workerMs > c.policy.deadline || usage.attempts >= c.policy.maxAttempts || usage.activeMs + c.policy.workerMs > c.policy.maxActiveMs || usage.tokens + c.policy.workerTokens > c.policy.maxTokens) fail("budget_exhausted", "Approved root envelope cannot reserve another bounded attempt");
        const ordinaryFraction=c.policy.recoveryAttempts>0?0.8:1;
        if(!args.recovery && (usage.activeMs+c.policy.workerMs>Math.floor(c.policy.maxActiveMs*ordinaryFraction) || usage.tokens+c.policy.workerTokens>Math.floor(c.policy.maxTokens*ordinaryFraction))) fail("recovery_required","Ordinary work must preserve the approved time and token recovery reserve");
        const priorProviders=(db.prepare("SELECT payload_json FROM dispatch_outbox WHERE contract_id=? AND prompt_id=? AND COALESCE(json_extract(payload_json,'$.kind'),'worker') NOT IN ('audit','command') ORDER BY created_at,rowid").all(c.id,args.promptId) as {payload_json:string}[]).map(row=>(JSON.parse(row.payload_json) as {provider?:string}).provider).filter(Boolean);
        const changes=priorProviders.filter((provider,index)=>index>0 && provider!==priorProviders[index-1]).length;
        if(args.payload.kind!=="audit" && args.payload.kind!=="command" && priorProviders.length>0 && args.payload.provider!==priorProviders.at(-1) && changes>=c.policy.maxProviderChanges) fail("provider_change_limit","Approved provider-change allowance exhausted");
        const unitUsage = db.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE contract_id=? AND prompt_id=? AND actor='worker'").get(c.id,args.promptId) as {n:number};
        const recoveryUsed = db.prepare("SELECT COUNT(*) n FROM budget_ledger WHERE budget_scope=? AND actor='recovery'").get(c.budgetScope) as {n:number};
        if (!args.recovery && (((args.actor ?? "worker")==="worker" && unitUsage.n >= c.policy.unitAttempts) || usage.attempts-recoveryUsed.n >= c.policy.maxAttempts - c.policy.recoveryAttempts)) fail("recovery_required", "Local worker allowance exhausted; use reserved recovery");
        if (args.recovery && recoveryUsed.n >= c.policy.recoveryAttempts) fail("budget_exhausted", "Recovery reserve exhausted");
        const lease = db.prepare("SELECT effect_id,fencing_token FROM execution_lease WHERE resource=?").get(args.resource) as {effect_id:string|null;fencing_token:number}|undefined;
        // An expiry is a reason to reconcile, never proof that a writer died.
        if (lease?.effect_id) fail("resource_busy", "Previous writer must be confirmed dead before transferring ownership");
        if (db.prepare("SELECT 1 FROM dispatch_outbox WHERE contract_id=? AND state IN ('PENDING','CLAIMED','RUNNING','QUARANTINED')").get(c.id)) fail("execution_active", "Contract already has an unsettled effect");
        const id = randomUUID(), runId = `run_${randomUUID()}`, generation = c.generation + 1;
        db.prepare("INSERT INTO dispatch_outbox(id,request_key,request_hash,contract_id,prompt_id,run_id,generation,revision,state,payload_json,due_at,created_at) VALUES(?,?,?,?,?,?,?,?,'PENDING',?,?,?)")
          .run(id,requestKey,hash,c.id,args.promptId,runId,generation,c.revision,JSON.stringify({...args.payload,resource:args.resource}),args.dueAt ?? clock(),clock());
        db.prepare("INSERT INTO budget_ledger(effect_id,contract_id,budget_scope,prompt_id,actor,reserved_ms,reserved_tokens,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id,c.id,c.budgetScope,args.promptId,args.recovery ? "recovery" : args.actor ?? "worker",c.policy.workerMs,c.policy.workerTokens,clock());
        db.prepare("INSERT INTO execution_lease(resource,effect_id,fencing_token,expires_at) VALUES(?,?,?,?) ON CONFLICT(resource) DO UPDATE SET effect_id=excluded.effect_id,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,process_json=NULL")
          .run(args.resource,id,(lease?.fencing_token ?? 0)+1,clock()+c.policy.workerMs);
        db.prepare("UPDATE delivery_contract SET generation=? WHERE id=?").run(generation,c.id);
        event(c.id,"dispatch_reserved",{effectId:id,promptId:args.promptId,generation,resource:args.resource,recovery:args.recovery ?? false},runId);
        return effect(id);
      })();
    },
    claim(id: string): ExecutionEffect | null {
      return db.transaction(() => {
        const e = effect(id), c = contract(e.contractId);
        if (e.state !== "PENDING" || e.dueAt > clock() || c.engine !== "supervised" || c.desired !== "RUNNING" || c.generation !== e.generation) return null;
        db.prepare("UPDATE dispatch_outbox SET state='CLAIMED' WHERE id=?").run(id);
        event(c.id,"dispatch_claimed",{effectId:id},e.runId);
        return effect(id);
      })();
    },
    attachProcess(id: string, identity: ProcessIdentity): void {
      db.transaction(() => {
        const e = effect(id);
        if (e.state !== "CLAIMED") fail("stale_effect", "Effect is no longer claimable");
        db.prepare("UPDATE dispatch_outbox SET state='RUNNING',process_json=? WHERE id=?").run(JSON.stringify(identity),id);
        db.prepare("UPDATE execution_lease SET process_json=? WHERE effect_id=?").run(JSON.stringify(identity),id);
        event(e.contractId,"process_registered",identity,e.runId);
      })();
    },
    assertRequest(runId:string,input:Record<string,unknown>):ExecutionEffect|null {
      for(const key of ["expectedGeneration","planRevision"] as const) if(input[key]!==undefined && (!Number.isSafeInteger(input[key]) || Number(input[key])<1)) fail("invalid_generation",`${key} must be a positive integer; refresh execution state`);
      return store.assertAttempt(runId,input.expectedGeneration as number|undefined,input.planRevision as number|undefined);
    },
    assertAttempt(runId: string, generation?: number, revision?: number): ExecutionEffect | null {
      const row = db.prepare("SELECT id FROM dispatch_outbox WHERE run_id=?").get(runId) as {id:string}|undefined;
      if (!row) return null;
      const e = effect(row.id), c = contract(e.contractId);
      const owner=db.prepare("SELECT effect_id FROM execution_lease WHERE resource=?").get(e.payload.resource) as {effect_id:string|null}|undefined;
      if(owner?.effect_id!==e.id) fail("stale_attempt","Repository ownership has been fenced");
      if (!["CLAIMED","RUNNING"].includes(e.state) || c.generation !== e.generation || (generation !== undefined && generation !== e.generation) || (revision !== undefined && revision !== e.revision)) fail("stale_attempt", "Attempt credentials have been fenced");
      return e;
    },
    settle(id: string, args: {generation:number;actualMs:number|null;actualTokens:number|null;result:unknown;writerDead:boolean;holdLease?:boolean}): boolean {
      return db.transaction(() => {
        const e = effect(id), c = contract(e.contractId);
        if (e.state === "SETTLED") return false;
        if (c.generation !== args.generation || e.generation !== args.generation) fail("stale_attempt", "Late result cannot change execution state");
        if (!args.writerDead) { store.quarantine(id,"Writer liveness is uncertain"); return false; }
        if (!["CLAIMED","RUNNING","QUARANTINED"].includes(e.state)) fail("invalid_transition", "Effect was never dispatched");
        const reservation = db.prepare("SELECT reserved_ms,reserved_tokens FROM budget_ledger WHERE effect_id=?").get(id) as {reserved_ms:number;reserved_tokens:number};
        for (const value of [args.actualMs,args.actualTokens]) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail("invalid_usage", "Usage must be finite and nonnegative");
        // Unknown usage consumes its reservation. Observed overages are never clipped.
        db.prepare("UPDATE budget_ledger SET actual_ms=?,actual_tokens=?,unknown_usage=? WHERE effect_id=?")
          .run(args.actualMs ?? reservation.reserved_ms,args.actualTokens ?? reservation.reserved_tokens,Number(args.actualMs === null || args.actualTokens === null),id);
        db.prepare("UPDATE dispatch_outbox SET state='SETTLED',result_json=? WHERE id=?").run(JSON.stringify(args.result),id);
        if(!args.holdLease) db.prepare("UPDATE execution_lease SET effect_id=NULL,process_json=NULL WHERE effect_id=?").run(id);
        event(c.id,"attempt_settled",args,e.runId);
        return true;
      })();
    },
    releaseSettledLease(id:string):void {
      if(effect(id).state!=="SETTLED")fail("writer_not_settled","Writer death must be recorded before releasing ownership");
      db.prepare("UPDATE execution_lease SET effect_id=NULL,process_json=NULL WHERE effect_id=?").run(id);
    },
    cancelPending(id: string): void {
      db.transaction(() => {
        const e = effect(id);
        if (e.state !== "PENDING") fail("invalid_transition", "Only undispatched effects can be cancelled");
        db.prepare("UPDATE dispatch_outbox SET state='CANCELLED' WHERE id=?").run(id);
        db.prepare("UPDATE budget_ledger SET actual_ms=0,actual_tokens=0 WHERE effect_id=?").run(id);
        db.prepare("UPDATE execution_lease SET effect_id=NULL,process_json=NULL WHERE effect_id=?").run(id);
        event(e.contractId,"dispatch_cancelled",{},e.runId);
      })();
    },
    quarantine(id: string, reason: string): void {
      db.transaction(() => {
        const e = effect(id);
        if (["SETTLED","CANCELLED","QUARANTINED"].includes(e.state)) return;
        db.prepare("UPDATE dispatch_outbox SET state='QUARANTINED' WHERE id=?").run(id);
        event(e.contractId,"writer_quarantined",{reason},e.runId);
      })();
    },
    acceptUnit(id: string, promptId: number, evidenceIds: number[], current:{inputHash:string;environmentHash:string;recipes:Record<string,string>}): void {
      db.transaction(() => {
        const c = contract(id), unit = plan(id).units.find(u => u.promptId === promptId);
        if (!unit || evidenceIds.length === 0) fail("evidence_missing", "Unit requires complete fresh criterion evidence");
        if (accepted(id).includes(promptId)) return;
        if(unit!.dependencies.some(dependency=>!accepted(id).includes(dependency))) fail("dependencies_incomplete","Cannot accept a unit whose dependencies remain open");
        for (const criterionId of unit!.criterionIds) {
          const criterion = c.criteria.find(cr => cr.id === criterionId)!;
          const kind=(db.prepare("SELECT kind FROM dod_criterion WHERE id=?").get(criterion.dodCriterionId) as {kind:string}|undefined)?.kind;
          const rows = evidenceIds.map(evidenceId => db.prepare("SELECT * FROM dod_result WHERE id=?").get(evidenceId) as Record<string,unknown>|undefined);
          if (!rows.some(r => r && r.criterion_id === criterion.dodCriterionId && r.prompt_id === promptId && r.result === "PASSED" && r.source === (kind==="PROSE"?"REVIEWER":"RUNNER") && r.stable_inputs === 1 && r.input_hash === current.inputHash && r.recipe_hash === current.recipes[String(criterion.dodCriterionId)] && r.environment_hash === current.environmentHash)) fail("evidence_missing", `No fresh trusted evidence for ${criterionId}`);
        }
        db.prepare("UPDATE work_unit_meta SET accepted_at=? WHERE contract_id=? AND prompt_id=?").run(clock(),id,promptId);
        db.prepare("UPDATE shared_verification SET accepted_at=? WHERE contract_id=? AND prompt_id=?").run(clock(),id,promptId);
        const closed = accepted(id), units = plan(id).units;
        const phase = units.every(u => closed.includes(u.promptId)) ? "delivered" : units.filter(u => u.phase === "implementation").every(u => closed.includes(u.promptId)) ? "verification" : "implementation";
        db.prepare("UPDATE delivery_contract SET phase=? WHERE id=?").run(phase,id);
        event(id,"unit_accepted",{promptId,evidenceIds,phase});
      })();
    },
    remedy(id:string,promptId:number,signature:string,remedy:string,evidence:string): boolean {
      return db.transaction(() => {
        const result = db.prepare("INSERT OR IGNORE INTO recovery_case(contract_id,prompt_id,signature,remedy,evidence,created_at) VALUES(?,?,?,?,?,?)").run(id,promptId,signature,remedy,evidence,clock());
        if (result.changes) event(id,"recovery_selected",{promptId,signature,remedy,evidence});
        return result.changes > 0;
      })();
    },
    remedies(id:string,promptId:number): Array<{signature:string;remedy:string;evidence:string}> {
      return db.prepare("SELECT signature,remedy,evidence FROM recovery_case WHERE contract_id=? AND prompt_id=? ORDER BY created_at").all(id,promptId) as Array<{signature:string;remedy:string;evidence:string}>;
    },
    amendBudget(id:string,policy:ExecutionPolicy,reason:string):void {
      db.transaction(()=>{
        if(!reason.trim()) fail("allocation_reason_required","An additional allocation needs an operator reason");
        validateExecutionPolicy(policy,clock());
        const c=contract(id),usage=totals(c.budgetScope);
        if(policy.maxAttempts<usage.attempts || policy.maxActiveMs<usage.activeMs || policy.maxTokens<usage.tokens) fail("allocation_below_usage","A budget amendment cannot erase recorded or reserved usage");
        const roots=db.prepare("SELECT id FROM delivery_contract WHERE budget_scope=?").all(c.budgetScope) as {id:string}[];
        for(const root of roots) {
          db.prepare("UPDATE delivery_contract SET policy_json=? WHERE id=?").run(JSON.stringify(policy),root.id);
          event(root.id,"budget_amended",{before:c.policy,after:policy,reason,retainedUsage:usage},null,"OPERATOR");
        }
      })();
    },
    scheduleWake(id:string,pipelineId:string,promptId:number,dueAt:number,reason:string):void {
      const c=contract(id);
      if(c.desired!=="RUNNING" || dueAt>=c.policy.deadline) return;
      db.prepare("INSERT INTO execution_wakeup(contract_id,pipeline_id,prompt_id,due_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(contract_id) DO UPDATE SET pipeline_id=excluded.pipeline_id,prompt_id=excluded.prompt_id,due_at=excluded.due_at,reason=excluded.reason").run(id,pipelineId,promptId,dueAt,reason);
    },
    dueWakes():Array<{contractId:string;pipelineId:string;promptId:number;reason:string}> {
      return db.prepare("SELECT contract_id contractId,pipeline_id pipelineId,prompt_id promptId,reason FROM execution_wakeup WHERE due_at<=?").all(clock()) as Array<{contractId:string;pipelineId:string;promptId:number;reason:string}>;
    },
    clearWake(id:string):void { db.prepare("DELETE FROM execution_wakeup WHERE contract_id=?").run(id); },
    decision(id:string,kind:string,payload:unknown): void { event(id,kind,payload); },
    pending(): ExecutionEffect[] {
      return (db.prepare("SELECT id FROM dispatch_outbox WHERE state IN ('PENDING','CLAIMED','RUNNING','QUARANTINED') OR (state='SETTLED' AND EXISTS(SELECT 1 FROM execution_lease l WHERE l.effect_id=dispatch_outbox.id)) ORDER BY created_at").all() as {id:string}[]).map(row => effect(row.id));
    },
    events(id:string): Array<{sequence:number;kind:string;payload:unknown;createdAt:number}> {
      return (db.prepare("SELECT sequence,kind,payload_json,created_at FROM execution_event WHERE contract_id=? ORDER BY sequence").all(id) as {sequence:number;kind:string;payload_json:string;created_at:number}[]).map(r => ({sequence:r.sequence,kind:r.kind,payload:JSON.parse(r.payload_json),createdAt:r.created_at}));
    },
    report(id:string) {
      const c=contract(id),closed=accepted(id),currentPlan=plan(id);
      const history=store.events(id),amended=history.filter(event=>event.kind==="requirement_amended").at(-1)?.sequence ?? 0;
      const receipts=history.filter(e=>e.kind==="unit_accepted" && e.sequence>amended).map(e=>e.payload as {promptId:number;evidenceIds:number[]});
      return {contractId:id,contractVersion:c.version,originalPromptHash:c.promptHash,status:store.status(id),coverage:c.criteria.map(criterion=>({criterion,units:currentPlan.units.filter(u=>u.criterionIds.includes(criterion.id)).map(unit=>({promptId:unit.promptId,accepted:closed.includes(unit.promptId),evidence:receipts.filter(r=>r.promptId===unit.promptId).flatMap(r=>r.evidenceIds).map(evidenceId=>db.prepare("SELECT id,source,result,input_hash,recipe_hash,environment_hash,created_at FROM dod_result WHERE id=?").get(evidenceId)).filter(Boolean)}))})),recovery:db.prepare("SELECT prompt_id,signature,remedy,evidence FROM recovery_case WHERE contract_id=?").all(id),accountingNote:"Unknown usage consumes reservations. Currency ceilings are estimated; reported token and active-time allowances are cumulative."};
    },
    status(id:string): ExecutionStatus {
      const c = contract(id), closed = accepted(id), events = store.events(id);
      const dispatched=events.filter(e=>e.kind==="dispatch_reserved").at(-1)?.sequence ?? 0;
      const exceptionEvent=events.filter(e=>["execution_exception","external_action_required","writer_quarantined"].includes(e.kind) && e.sequence>dispatched).at(-1);
      const exceptionPayload=exceptionEvent?.payload as {code?:string;reason?:string}|undefined;
      const recovery=store.remedies(id,plan(id).units.find(u=>!closed.includes(u.promptId))?.promptId ?? c.promptId).at(-1)?.remedy ?? null;
      const wake=db.prepare("SELECT due_at FROM execution_wakeup WHERE contract_id=?").get(id) as {due_at:number}|undefined;
      return {totalUnits:plan(id).units.length,lastRecovery:recovery,exception:c.phase!=="delivered" && exceptionEvent?{code:exceptionPayload?.code ?? exceptionEvent.kind,reason:exceptionPayload?.reason ?? "Execution requires reconciliation"}:null,nextWakeAt:wake?.due_at ?? null,contractId:id,engine:c.engine,desired:c.desired,phase:c.phase,revision:c.revision,generation:c.generation,acceptedUnits:closed,...totals(c.budgetScope),policy:c.policy,lastDecision:events.at(-1)?.kind ?? null,
        pendingObligations: c.criteria.filter(cr => cr.phase === "verification" && !closed.includes(cr.verifierPromptId)).map(cr => cr.id)};
    },
  };
  return store;
}
export type ExecutionStore = ReturnType<typeof createExecutionStore>;

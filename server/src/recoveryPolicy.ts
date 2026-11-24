import { executionHash } from "./executionStore.ts";
export type RecoveryAction = "continue" | "fresh_context" | "diagnose" | "replan" | "change_provider" | "external_input" | "exhausted";
export interface RecoveryDecision { action:RecoveryAction; signature:string; reason:string }
/** A normalized signature preserves failure history across sessions/providers. */
export function failureSignature(facts:string):string {
  return executionHash(facts.toLowerCase().replace(/run_[a-z0-9_-]+/g,"<run>").replace(/\b\d{4}-\d\d-\d\d[^\s]*/g,"<time>").replace(/\b\d+ms\b/g,"<duration>").replace(/\s+/g," ").trim());
}
export function recoveryDecision(args:{facts:string;attempts:number;unitAttempts:number;tried:readonly string[];remainingRecovery:number;providerChanges:number;maxProviderChanges:number;canReplan:boolean}):RecoveryDecision {
  const signature=failureSignature(args.facts);
  if(/(?:missing|invalid|expired|revoked) (?:api[- ]?key|credential)|authentication required|login required|unauthorized|undelegated decision/i.test(args.facts)) return {action:"external_input",signature,reason:"Credentials or an undelegated decision require an external event"};
  if(/(?:session|thread).*(?:not found|invalid|expired|corrupt)/i.test(args.facts) && !args.tried.includes("fresh_context")) return {action:"fresh_context",signature,reason:"Native state is unavailable; use one bounded fresh handoff"};
  if(/budget_(?:total|input)_tokens\b/i.test(args.facts) && args.attempts<args.unitAttempts && !args.tried.includes("fresh_context")) return {action:"fresh_context",signature,reason:"The worker hit its token allowance; use one bounded fresh handoff instead of resuming the oversized session"};
  if(args.attempts<args.unitAttempts) return {action:"continue",signature,reason:"Work remains within the local worker allowance"};
  if(args.remainingRecovery<=0) return {action:"exhausted",signature,reason:"Approved recovery reserve exhausted"};
  if(!args.tried.includes("diagnose")) return {action:"diagnose",signature,reason:"Local attempts exhausted; diagnose the recorded failure and change approach"};
  if(args.canReplan && !args.tried.includes("replan")) return {action:"replan",signature,reason:"Split only remaining obligations, preserving accepted units and root budget"};
  if(args.providerChanges<args.maxProviderChanges && !args.tried.includes("change_provider")) return {action:"change_provider",signature,reason:"Use an already permitted provider with a fresh handoff"};
  return {action:"exhausted",signature,reason:"No untried authorized recovery remains"};
}

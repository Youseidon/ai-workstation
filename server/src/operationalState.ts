import type { PromptOperationalState, PromptOption } from "@agent-console/shared";

export const OPERATIONAL_STATES:PromptOperationalState[]=["WORKING","AWAITING_RESPONSE","RECOVERY_NEEDED","FAILED","READY","WAITING_DEPENDENCY","COMPLETE","SKIPPED"];

export function operationalState(prompt:PromptOption, hasHumanQuestion = false):PromptOperationalState {
  if(prompt.currentRun?.processActive)return "WORKING";
  if((hasHumanQuestion || prompt.humanResponseHeld) && prompt.status!=="DONE" && prompt.status!=="SKIPPED")return "AWAITING_RESPONSE";
  if(prompt.recoverable)return "RECOVERY_NEEDED";
  if(prompt.status==="BLOCKED")return "AWAITING_RESPONSE";
  if(prompt.status==="DONE")return "COMPLETE";
  if(prompt.status==="SKIPPED")return "SKIPPED";
  if(prompt.blockedBy.length>0)return "WAITING_DEPENDENCY";
  if(prompt.status==="TODO")return "READY";
  return "FAILED";
}

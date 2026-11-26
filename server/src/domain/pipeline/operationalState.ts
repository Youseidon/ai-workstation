import { STEP_DISPLAY_STATUSES } from "@hydra/shared";
import type { PromptOperationalState, PromptOption } from "@hydra/shared";

export const OPERATIONAL_STATES:PromptOperationalState[]=[...STEP_DISPLAY_STATUSES];

export function operationalState(prompt:PromptOption):PromptOperationalState {
  if(prompt.currentRun?.processActive)return "WORKING";
  if(prompt.recoverable&&prompt.status==="IN_PROGRESS")return "RECOVERY_NEEDED";
  if(prompt.status==="BLOCKED")return "BLOCKED";
  if(prompt.status==="DONE")return "DONE";
  if(prompt.status==="SKIPPED")return "SKIPPED";
  if(prompt.blockedBy.length>0)return "WAITING_DEPENDENCY";
  if(prompt.status==="TODO")return prompt.ready?"READY":"WAITING_DEPENDENCY";
  return prompt.status;
}

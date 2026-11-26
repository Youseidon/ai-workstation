export const PIPELINE_POLICY_GROUP = "Pipeline policy";

export const RUN_BUDGETS_GROUP = "Run budgets";

export const GROUP_TITLE: Record<string, string> = { General: "Runtime" };

export const GROUP_BLURB: Record<string, string> = {
  "Model access": "The credit-use ceiling for every new run.",
  General: "Shared by every provider.",
  "Run budgets": "What one run may use before it is stopped.",
  "Pipeline policy": "House rules for Pause, Stop, restarts and unfinished stations.",
  Retention: "How long transcript events are kept. Runs, remarks and status history always stay.",
};

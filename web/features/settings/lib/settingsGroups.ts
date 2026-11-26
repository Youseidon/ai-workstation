/**
 * Presentation for the settings groups the server ships in `SettingsSnapshot`.
 *
 * Lives here rather than in the Agents page so that anything wanting to link at
 * a group — the pipeline rules panel, for one — does not have to import that
 * whole view just to build an anchor.
 */

/** The group governing pipeline transport behaviour. */
export const PIPELINE_POLICY_GROUP = "Pipeline policy";

/** Ceilings a single agent run cannot exceed. */
export const RUN_BUDGETS_GROUP = "Run budgets";

/** Display name where the group's own name is not the clearest heading. */
export const GROUP_TITLE: Record<string, string> = { General: "Runtime" };

/**
 * One line of context per group. A group without an entry still renders — a
 * missing blurb is cosmetic, whereas a missing section hides a live setting.
 */
export const GROUP_BLURB: Record<string, string> = {
  "Model access": "The credit-use ceiling for every new run.",
  General: "Shared by every provider.",
  "Run budgets": "What one run may use before it is stopped.",
  "Pipeline policy": "House rules for Pause, Stop, restarts and unfinished stations.",
  Retention: "How long transcript events are kept. Runs, remarks and status history always stay.",
};

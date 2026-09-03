/**
 * Presentation for the settings groups the server ships in `SettingsSnapshot`.
 *
 * Lives here rather than in the Agents page so that anything wanting to link at
 * a group — the pipeline rules panel, for one — does not have to import that
 * whole view just to build an anchor.
 */

/** The group governing pipeline transport behaviour. */
export const PIPELINE_POLICY_GROUP = "Pipeline policy";

/** Display name where the group's own name is not the clearest heading. */
export const GROUP_TITLE: Record<string, string> = { General: "Runtime" };

/**
 * One line of context per group. A group without an entry still renders — a
 * missing blurb is cosmetic, whereas a missing section hides a live setting.
 */
export const GROUP_BLURB: Record<string, string> = {
  General: "Shared with every provider. Host access is required for docker compose and other host sockets.",
  "Run budgets":
    "Ceilings a single run cannot exceed. A decomposed sub-step gets a slice of its parent's allowance rather than a fresh one.",
  "Pipeline policy":
    "House rules for the pipeline: what Pause and Stop do to a running agent, when resuming offers a handoff, and the rule a station starts with before you configure it.",
};

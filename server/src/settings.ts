import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_PIPELINE_POLICY,
  isOnBlockedAction,
  isOnDoneAction,
  type PipelinePolicy,
  type HandoffRequirement,
  type PauseMode,
} from "@agent-console/shared";
import type {
  ProviderId,
  SettingField,
  SettingOption,
  SettingType,
  SettingValue,
  SettingsPatch,
  SettingsSnapshot,
} from "@agent-console/shared";
import type { PermissionOverride } from "./adapters/types.ts";
import { config } from "./config.ts";
import { createLogger } from "./lib/logger.ts";

const log = createLogger("settings");

/*
 * Every tunable lives in one table. `.env` supplies the default for each field;
 * overrides saved from the Agents page are persisted to a JSON file and layered
 * on top. Adapters read through the `settings` accessor at run time, so a change
 * applies to the next run without restarting the server — and the Agents page
 * is generated from this table, so adding a knob is a one-entry change.
 */

interface FieldDef {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  description: string;
  envVar: string;
  fallback: SettingValue;
  placeholder?: string;
  options?: SettingOption[];
  requiresRestart?: boolean;
  /** Marks values that loosen a sandbox or permission check. */
  isDangerous?: (value: SettingValue) => boolean;
}

function option(value: string, label: string, hint: string | null, danger = false): SettingOption {
  return { value, label, hint, danger };
}

export const GROUPS = ["General", "Run budgets", "Pipeline policy", "Claude Code", "Codex CLI", "Cursor CLI", "Grok CLI", "GitHub Copilot"] as const;

const FIELDS: FieldDef[] = [
  {
    key: "budget.maxToolResultBytes",
    label: "Max tool result size (bytes)",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_MAX_TOOL_RESULT_BYTES",
    fallback: 8192,
    description:
      "Longest single tool output kept in full. Longer results keep their head and tail and lose the middle. Every turn resends the whole transcript, so one unbounded command is paid for many times over. 0 disables truncation.",
  },
  {
    key: "budget.maxToolCalls",
    label: "Max tool calls per run",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_MAX_TOOL_CALLS",
    fallback: 250,
    description:
      "Stops a run that keeps working past the point of usefulness. Sub-steps get a smaller share automatically. 0 disables.",
  },
  {
    key: "budget.maxWallClockMinutes",
    label: "Max wall clock per run (minutes)",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_MAX_WALL_CLOCK_MINUTES",
    fallback: 45,
    description: "Hard time limit for one run. Sub-steps get a smaller share automatically. 0 disables.",
  },
  {
    key: "budget.maxInputTokens",
    label: "Max input tokens per run",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_MAX_INPUT_TOKENS",
    fallback: 8000000,
    description:
      "Cumulative input tokens, cached included. This is the number that turns into money: an agentic loop resends its whole transcript every turn. 0 disables.",
  },
  {
    key: "budget.maxToolOutputBytes",
    label: "Max total tool output per run (bytes)",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_MAX_TOOL_OUTPUT_BYTES",
    fallback: 1048576,
    description: "Cumulative size of every tool result in one run. 0 disables.",
  },
  {
    key: "budget.noProgressToolCalls",
    label: "No-progress tool calls",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_NO_PROGRESS_TOOL_CALLS",
    fallback: 25,
    description:
      "Stops a run repeating the same tool call with the same input this many times in a row — the signature of a thrash loop. 0 disables.",
  },
  {
    key: "budget.subStepFraction",
    label: "Sub-step budget share (%)",
    group: "Run budgets",
    type: "number",
    envVar: "BUDGET_SUB_STEP_FRACTION",
    fallback: 50,
    description:
      "Share of each budget a decomposed sub-step receives. A sub-step is a slice of its parent, so it should not be allowed to spend a whole station's allowance.",
  },
  {
    key: "pipeline.pauseMode",
    label: "What Pause does",
    group: "Pipeline policy",
    type: "select",
    envVar: "PIPELINE_PAUSE_MODE",
    fallback: "graceful",
    description:
      "Graceful lets the station's agent finish and applies its result, then holds before the next one. "
      + "Immediate interrupts the agent straight away but keeps the run resumable, unlike Stop.",
    options: [
      option("graceful", "Let the current station finish", "The agent completes; its DONE or BLOCKED still applies"),
      option("immediate", "Interrupt the agent now", "Stops the agent, but the run stays resumable"),
    ],
  },
  {
    key: "pipeline.stopInterruptsAgent",
    label: "Stop interrupts the running agent",
    group: "Pipeline policy",
    type: "boolean",
    envVar: "PIPELINE_STOP_INTERRUPTS_AGENT",
    fallback: true,
    description:
      "On, Stop kills the agent working right now and its station stays unfinished. Off, Stop only ends "
      + "auto-advance and lets that agent finish what it started.",
  },
  {
    key: "pipeline.onRestart",
    label: "After a server restart",
    group: "Pipeline policy",
    type: "select",
    envVar: "PIPELINE_ON_RESTART",
    fallback: "newRun",
    description:
      "A run holding a station when the server restarts is marked interrupted. This decides what the "
      + "pipeline offers when you come back. Neither option relaunches anything on its own — nothing "
      + "starts until you press the button.",
    options: [
      option("newRun", "Offer a fresh run", "Starts again from the first unfinished station"),
      option("resumeSameRun", "Offer to continue the same run", "Picks the interrupted run back up where it stopped"),
    ],
  },
  {
    key: "pipeline.handoffRequirement",
    label: "When to require a handoff",
    group: "Pipeline policy",
    type: "select",
    envVar: "PIPELINE_HANDOFF_REQUIREMENT",
    fallback: "whenWorkProduced",
    description:
      "A handoff runs a read-only agent that summarises what the previous run finished and what it left, "
      + "so the next agent does not redo the work. This decides when resuming offers to prepare one.",
    options: [
      option("whenWorkProduced", "When the previous run produced work", "Checks for tool calls; skips the offer for a station that only failed to start"),
      option("always", "Before every resume", "Offers a handoff whenever the station is unfinished"),
      option("never", "Never offer one", "Resume restarts the station directly, and prior work may be redone", true),
    ],
    isDangerous: (value) => value === "never",
  },
  {
    key: "pipeline.autoHandoffOnBlocked",
    label: "Summon a handoff when a station blocks",
    group: "Pipeline policy",
    type: "boolean",
    envVar: "PIPELINE_AUTO_HANDOFF_ON_BLOCKED",
    fallback: false,
    description:
      "On, a station whose rule is 'wait' first has a read-only agent write a continuation brief, and the "
      + "run carries on by itself if that agent says the work can continue. Off, the run simply parks and "
      + "waits for you. This is the one setting here that can start an agent without you pressing anything.",
    isDangerous: (value) => value === true,
  },
  {
    key: "pipeline.maxHandoffGenerations",
    label: "Max handoff generations per station",
    group: "Pipeline policy",
    type: "number",
    envVar: "PIPELINE_MAX_HANDOFF_GENERATIONS",
    fallback: 3,
    description:
      "How many times one station may be handed off before the pipeline refuses another. Guards against a "
      + "station that hands off to itself forever without progressing.",
  },
  {
    key: "pipeline.defaultOnBlocked",
    label: "Default rule when a station blocks",
    group: "Pipeline policy",
    type: "select",
    envVar: "PIPELINE_DEFAULT_ON_BLOCKED",
    fallback: "wait",
    description:
      "The 'on blocked' rule a station starts with, before anyone configures it on the flowchart. "
      + "Existing stations keep whatever they were given.",
    options: [
      option("wait", "Wait for a human", "The run parks and asks you"),
      option("retry", "Retry the station", "Restarts it up to its retry limit, then parks"),
      option("recover", "Hand to the recovery agent", "One attempt with the station's recover agent"),
      option("skip", "Skip and carry on", "Marks the station SKIPPED; dependants stay blocked", true),
    ],
    isDangerous: (value) => value === "skip",
  },
  {
    key: "pipeline.defaultOnDone",
    label: "Default rule when a station finishes",
    group: "Pipeline policy",
    type: "select",
    envVar: "PIPELINE_DEFAULT_ON_DONE",
    fallback: "continue",
    description:
      "The 'on done' rule a station starts with, before anyone configures it on the flowchart.",
    options: [
      option("continue", "Continue to the next station", "The usual rail behaviour"),
      option("stop", "Stop the run", "Finishing this station ends the run"),
      option("skip_rest", "Skip the rest of the stage", "Marks every later station SKIPPED", true),
    ],
    isDangerous: (value) => value === "skip_rest",
  },

  {
    key: "statusIntervalMs",
    label: "Status heartbeat (ms)",
    group: "General",
    type: "number",
    envVar: "STATUS_INTERVAL_MS",
    fallback: 1000,
    description:
      "How often the server pushes elapsed time and token usage during a run. Lower is smoother, higher is quieter.",
  },
  {
    key: "hostAccess",
    label: "Host access (Docker)",
    group: "General",
    type: "boolean",
    envVar: "AGENT_HOST_ACCESS",
    fallback: false,
    description:
      "Lets every provider reach Docker and other host services. Codex drops its sandbox, Claude and Grok skip permission prompts, Grok's OS sandbox is turned off, and Copilot runs yolo. Needed for docker compose, local stacks, and /var/run/docker.sock. The per-provider sandbox settings below are ignored while this is on.",
    isDangerous: (value) => value === true,
  },

  {
    key: "claude.enabled",
    label: "Enabled",
    group: "Claude Code",
    type: "boolean",
    envVar: "CLAUDE_ENABLED",
    fallback: true,
    description: "When off, Claude Code is hidden from the agent picker and cannot start runs.",
  },
  {
    key: "claude.apiKey",
    label: "ANTHROPIC_API_KEY",
    group: "Claude Code",
    type: "password",
    envVar: "ANTHROPIC_API_KEY",
    fallback: "",
    placeholder: "sk-ant-…",
    description:
      "Optional. Leave empty to reuse an existing `claude` CLI login. Stored server-side only and never sent to the browser.",
  },
  {
    key: "claude.model",
    label: "Model",
    group: "Claude Code",
    type: "string",
    envVar: "CLAUDE_MODEL",
    fallback: "",
    placeholder: "leave empty for the SDK default",
    description:
      "Default model when no model is picked in the header. The header dropdown overrides this per run without changing it.",
  },
  {
    key: "claude.permissionMode",
    label: "Permission mode",
    group: "Claude Code",
    type: "select",
    envVar: "CLAUDE_PERMISSION_MODE",
    fallback: "acceptEdits",
    description:
      "How Claude Code handles tool permissions during a headless run. Overridden to bypassPermissions while Host access is on.",
    options: [
      option("acceptEdits", "acceptEdits", "Auto-accept file edits (recommended)"),
      option("plan", "plan", "Read-only planning; no tools execute"),
      option("dontAsk", "dontAsk", "Never prompt; deny anything not pre-approved"),
      option("default", "default", "Prompts have nowhere to go headless — tool calls get denied"),
      option("bypassPermissions", "bypassPermissions", "No permission checks at all", true),
    ],
    isDangerous: (value) => value === "bypassPermissions",
  },
  {
    key: "claude.settingSources",
    label: "Setting sources",
    group: "Claude Code",
    type: "string",
    envVar: "CLAUDE_SETTING_SOURCES",
    fallback: "user,project,local",
    placeholder: "user,project,local",
    description:
      "Which Claude Code settings files to honour (CLAUDE.md, settings.json). Comma separated; empty loads none.",
  },
  {
    key: "claude.maxTurns",
    label: "Max turns",
    group: "Claude Code",
    type: "number",
    envVar: "CLAUDE_MAX_TURNS",
    fallback: 0,
    description: "Stop the run after this many assistant turns. 0 means no limit.",
  },

  {
    key: "codex.enabled",
    label: "Enabled",
    group: "Codex CLI",
    type: "boolean",
    envVar: "CODEX_ENABLED",
    fallback: true,
    description: "When off, Codex CLI is hidden from the agent picker and cannot start runs.",
  },
  {
    key: "codex.apiKey",
    label: "OPENAI_API_KEY",
    group: "Codex CLI",
    type: "password",
    envVar: "OPENAI_API_KEY",
    fallback: "",
    placeholder: "sk-…",
    description:
      "Optional. Leave empty to reuse an existing `codex login`. Stored server-side only and never sent to the browser.",
  },
  {
    key: "codex.binary",
    label: "Binary",
    group: "Codex CLI",
    type: "string",
    envVar: "CODEX_BIN",
    fallback: "codex",
    placeholder: "codex",
    description: "Command looked up on $PATH. An absolute path also works.",
  },
  {
    key: "codex.model",
    label: "Model",
    group: "Codex CLI",
    type: "string",
    envVar: "CODEX_MODEL",
    fallback: "",
    placeholder: "leave empty for the codex default",
    description:
      "Default model when no model is picked in the header, passed as `-m` to `codex exec`. The header dropdown overrides this per run.",
  },
  {
    key: "codex.sandboxMode",
    label: "Sandbox mode",
    group: "Codex CLI",
    type: "select",
    envVar: "CODEX_SANDBOX_MODE",
    fallback: "workspace-write",
    description:
      "Codex's own sandbox policy for model-generated commands. Overridden to danger-full-access while Host access is on (workspace-write cannot talk to /var/run/docker.sock).",
    options: [
      option("read-only", "read-only", "May read, but not write or reach the network"),
      option("workspace-write", "workspace-write", "Writes confined to the working directory"),
      option("danger-full-access", "danger-full-access", "No sandbox at all", true),
    ],
    isDangerous: (value) => value === "danger-full-access",
  },
  {
    key: "codex.skipGitRepoCheck",
    label: "Allow running outside a git repo",
    group: "Codex CLI",
    type: "boolean",
    envVar: "CODEX_SKIP_GIT_REPO_CHECK",
    fallback: true,
    description: "Codex refuses to run outside a git repository unless this is on.",
  },
  {
    key: "codex.extraArgs",
    label: "Extra arguments",
    group: "Codex CLI",
    type: "string",
    envVar: "CODEX_EXTRA_ARGS",
    fallback: "",
    placeholder: `-c model_reasoning_effort="high"`,
    description: "Appended verbatim to `codex exec`. Quoted tokens are respected.",
  },

  {
    key: "cursor.enabled",
    label: "Enabled",
    group: "Cursor CLI",
    type: "boolean",
    envVar: "CURSOR_ENABLED",
    fallback: true,
    description: "When off, Cursor CLI is hidden from the agent picker and cannot start runs.",
  },
  {
    key: "cursor.binary",
    label: "Binary",
    group: "Cursor CLI",
    type: "string",
    envVar: "CURSOR_BIN",
    fallback: "cursor-agent",
    placeholder: "cursor-agent",
    description: "Command looked up on $PATH. An absolute path also works.",
  },
  {
    key: "cursor.model",
    label: "Model",
    group: "Cursor CLI",
    type: "string",
    envVar: "CURSOR_MODEL",
    fallback: "",
    placeholder: "leave empty for the cursor default",
    description:
      "Default model when no model is picked in the header, passed as `-m` to cursor-agent. The header dropdown overrides this per run.",
  },
  {
    key: "cursor.outputFormat",
    label: "Output format",
    group: "Cursor CLI",
    type: "select",
    envVar: "CURSOR_OUTPUT_FORMAT",
    fallback: "stream-json",
    description: "Headless output mode. stream-json gives live events; json gives one final object.",
    options: [
      option("stream-json", "stream-json", "Live event stream (recommended)"),
      option("json", "json", "One object at the end of the run"),
    ],
  },
  {
    key: "cursor.force",
    label: "Force (skip approvals)",
    group: "Cursor CLI",
    type: "boolean",
    envVar: "CURSOR_FORCE",
    fallback: true,
    description:
      "Cursor has no sandbox. With this on it edits files in the working directory without asking; with it off, headless runs may stall waiting for approval. Forced on while Host access is on.",
    isDangerous: (value) => value === true,
  },
  {
    key: "cursor.assumeAuthenticated",
    label: "Assume authenticated",
    group: "Cursor CLI",
    type: "boolean",
    envVar: "CURSOR_ASSUME_AUTHENTICATED",
    fallback: false,
    description: "Skip the login check if detection misfires but you know you are logged in.",
  },
  {
    key: "cursor.extraArgs",
    label: "Extra arguments",
    group: "Cursor CLI",
    type: "string",
    envVar: "CURSOR_EXTRA_ARGS",
    fallback: "",
    description: "Appended verbatim to the cursor-agent invocation. Quoted tokens are respected.",
  },

  {
    key: "grok.enabled",
    label: "Enabled",
    group: "Grok CLI",
    type: "boolean",
    envVar: "GROK_ENABLED",
    fallback: true,
    description: "When off, Grok CLI is hidden from the agent picker and cannot start runs.",
  },
  {
    key: "grok.apiKey",
    label: "XAI_API_KEY",
    group: "Grok CLI",
    type: "password",
    envVar: "XAI_API_KEY",
    fallback: "",
    placeholder: "xai-…",
    description:
      "Optional. Leave empty to reuse an existing `grok login`. Stored server-side only and never sent to the browser.",
  },
  {
    key: "grok.binary",
    label: "Binary",
    group: "Grok CLI",
    type: "string",
    envVar: "GROK_BIN",
    fallback: "grok",
    placeholder: "grok",
    description: "Command looked up on $PATH. An absolute path also works.",
  },
  {
    key: "grok.model",
    label: "Model",
    group: "Grok CLI",
    type: "string",
    envVar: "GROK_MODEL",
    fallback: "",
    placeholder: "leave empty for the grok default",
    description:
      "Default model when no model is picked in the header, passed as `-m` to `grok -p`. The header dropdown overrides this per run.",
  },
  {
    key: "grok.permissionMode",
    label: "Permission mode",
    group: "Grok CLI",
    type: "select",
    envVar: "GROK_PERMISSION_MODE",
    fallback: "acceptEdits",
    description:
      "How Grok handles tool permissions during a headless run. Overridden to bypassPermissions while Host access is on.",
    options: [
      option("acceptEdits", "acceptEdits", "Auto-accept file edits (recommended)"),
      option("auto", "auto", "Safety-checked auto; blocked calls fail in headless"),
      option("plan", "plan", "Read-only planning; no tools execute"),
      option("dontAsk", "dontAsk", "Never prompt; deny anything not pre-approved"),
      option("default", "default", "Asks for approval — prompts have nowhere to go headless"),
      option("bypassPermissions", "bypassPermissions", "No permission checks at all", true),
    ],
    isDangerous: (value) => value === "bypassPermissions",
  },
  {
    key: "grok.sandboxMode",
    label: "Sandbox mode",
    group: "Grok CLI",
    type: "select",
    envVar: "GROK_SANDBOX_MODE",
    fallback: "workspace",
    description:
      "Grok's OS-level sandbox for filesystem and network access. Overridden to off while Host access is on.",
    options: [
      option("workspace", "workspace", "Writes confined to the working directory"),
      option("read-only", "read-only", "May read, but not write project files"),
      option("strict", "strict", "Read CWD + system paths; writes confined to CWD"),
      option("off", "off", "No sandbox at all", true),
    ],
    isDangerous: (value) => value === "off",
  },
  {
    key: "grok.maxTurns",
    label: "Max turns",
    group: "Grok CLI",
    type: "number",
    envVar: "GROK_MAX_TURNS",
    fallback: 0,
    description: "Stop the run after this many agentic turns. 0 means no limit.",
  },
  {
    key: "grok.assumeAuthenticated",
    label: "Assume authenticated",
    group: "Grok CLI",
    type: "boolean",
    envVar: "GROK_ASSUME_AUTHENTICATED",
    fallback: false,
    description: "Skip the login check if detection misfires but you know you are logged in.",
  },
  {
    key: "grok.extraArgs",
    label: "Extra arguments",
    group: "Grok CLI",
    type: "string",
    envVar: "GROK_EXTRA_ARGS",
    fallback: "",
    description: "Appended verbatim to the grok invocation. Quoted tokens are respected.",
  },

  {
    key: "copilot.enabled",
    label: "Enabled",
    group: "GitHub Copilot",
    type: "boolean",
    envVar: "COPILOT_ENABLED",
    fallback: true,
    description: "When off, GitHub Copilot is hidden from the agent picker and cannot start runs.",
  },
  {
    key: "copilot.githubToken",
    label: "COPILOT_GITHUB_TOKEN",
    group: "GitHub Copilot",
    type: "password",
    envVar: "COPILOT_GITHUB_TOKEN",
    fallback: "",
    placeholder: "gho_… or github_pat_…",
    description:
      "Optional. Leave empty to reuse an existing `copilot login`, GH_TOKEN, or `gh auth login`. Classic ghp_ tokens are not accepted by Copilot. Stored server-side only and never sent to the browser.",
  },
  {
    key: "copilot.binary",
    label: "Binary",
    group: "GitHub Copilot",
    type: "string",
    envVar: "COPILOT_BIN",
    fallback: "copilot",
    placeholder: "copilot",
    description: "Command looked up on $PATH. An absolute path also works.",
  },
  {
    key: "copilot.model",
    label: "Model",
    group: "GitHub Copilot",
    type: "string",
    envVar: "COPILOT_MODEL",
    fallback: "",
    placeholder: "leave empty for the copilot default",
    description:
      "Default model when no model is picked in the header, passed as `--model`. Copilot only accepts ids your plan's model picker exposes — `auto` always works. The header dropdown overrides this per run.",
  },
  {
    key: "copilot.permissionMode",
    label: "Permission mode",
    group: "GitHub Copilot",
    type: "select",
    envVar: "COPILOT_PERMISSION_MODE",
    fallback: "allow-all-tools",
    description:
      "How much a headless Copilot run may touch. Tool approval is always pre-granted — a non-interactive run has nowhere to prompt — so this chooses how far outside the workspace that reaches. Overridden to yolo while Host access is on.",
    options: [
      option("allow-all-tools", "allow-all-tools", "Tools run automatically; file access stays inside the workspace (recommended)"),
      option("plan", "plan", "Read-only planning; the built-in file-write tools are denied"),
      option("allow-all-paths", "allow-all-paths", "Also drops path verification — the agent can read and write anywhere", true),
      option("yolo", "yolo", "All tools, all paths, all URLs", true),
    ],
    isDangerous: (value) => value === "yolo" || value === "allow-all-paths",
  },
  {
    key: "copilot.reasoningEffort",
    label: "Reasoning effort",
    group: "GitHub Copilot",
    type: "select",
    envVar: "COPILOT_REASONING_EFFORT",
    fallback: "",
    description: "Passed as `--effort`. Leave on default to let the model decide.",
    options: [
      option("", "default", "Whatever the model picks"),
      option("none", "none", null),
      option("minimal", "minimal", null),
      option("low", "low", null),
      option("medium", "medium", null),
      option("high", "high", null),
      option("xhigh", "xhigh", null),
      option("max", "max", "Slowest and priciest"),
    ],
  },
  {
    key: "copilot.maxAiCredits",
    label: "Max AI credits",
    group: "GitHub Copilot",
    type: "number",
    envVar: "COPILOT_MAX_AI_CREDITS",
    fallback: 0,
    description: "Stop the run once it has spent this many AI credits. 0 means no cap.",
  },
  {
    key: "copilot.builtinMcpServers",
    label: "Built-in GitHub MCP",
    group: "GitHub Copilot",
    type: "boolean",
    envVar: "COPILOT_BUILTIN_MCP",
    fallback: true,
    description:
      "Copilot's bundled github-mcp-server, which lets a run read issues and pull requests. Turning it off (`--disable-builtin-mcps`) starts runs faster and keeps the prompt smaller.",
  },
  {
    key: "copilot.remoteExport",
    label: "Export sessions to GitHub",
    group: "GitHub Copilot",
    type: "boolean",
    envVar: "COPILOT_REMOTE_EXPORT",
    fallback: false,
    description:
      "Copilot can publish a session to GitHub web and mobile and accept remote control from there. Off by default: runs started here are driven by this server, and the transcript stays local.",
  },
  {
    key: "copilot.assumeAuthenticated",
    label: "Assume authenticated",
    group: "GitHub Copilot",
    type: "boolean",
    envVar: "COPILOT_ASSUME_AUTHENTICATED",
    fallback: false,
    description:
      "Skip the login check. Needed when `copilot login` stored its token in the OS credential store, which this server cannot read.",
  },
  {
    key: "copilot.extraArgs",
    label: "Extra arguments",
    group: "GitHub Copilot",
    type: "string",
    envVar: "COPILOT_EXTRA_ARGS",
    fallback: "",
    description: "Appended verbatim to the copilot invocation. Quoted tokens are respected.",
  },
];

const FIELDS_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/* -------------------------------------------------------------------------- */
/* Value layering: built-in fallback → .env → saved override                   */
/* -------------------------------------------------------------------------- */

function coerce(type: SettingType, raw: string, fallback: SettingValue): SettingValue {
  switch (type) {
    case "boolean":
      return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
    case "number": {
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    default:
      return raw.trim();
  }
}

function envDefault(field: FieldDef): SettingValue {
  const raw = process.env[field.envVar];
  if (raw === undefined || raw.trim() === "") return field.fallback;
  return coerce(field.type, raw, field.fallback);
}

const defaults = new Map<string, SettingValue>(
  FIELDS.map((field) => [field.key, envDefault(field)]),
);

let overrides = new Map<string, SettingValue>();

const STORAGE_PATH = resolve(
  config.repoRoot,
  process.env.SETTINGS_FILE ?? ".agent-console/settings.json",
);

function load(): void {
  if (!existsSync(STORAGE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(STORAGE_PATH, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      const field = FIELDS_BY_KEY.get(key);
      if (field === undefined) continue;
      const normalized = normalize(field, value);
      if (normalized !== null) overrides.set(key, normalized);
    }
    log.info(`loaded ${overrides.size} saved override(s) from ${STORAGE_PATH}`);
  } catch (error) {
    log.warn(`could not read ${STORAGE_PATH}; using .env values only`, error);
  }
}

function persist(): void {
  const body = JSON.stringify(Object.fromEntries(overrides), null, 2);
  mkdirSync(dirname(STORAGE_PATH), { recursive: true, mode: 0o700 });
  // 0600: this file can hold API keys.
  writeFileSync(STORAGE_PATH, `${body}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Accepts a raw value from the client and coerces it to the field's type. */
function normalize(field: FieldDef, value: unknown): SettingValue | null {
  switch (field.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return coerce("boolean", value, false);
      return null;
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
      if (typeof value === "string") return coerce("number", value, field.fallback);
      return null;
    }
    default:
      return typeof value === "string" ? value.trim() : null;
  }
}

function validate(field: FieldDef, value: SettingValue): string | null {
  if (field.options !== undefined) {
    const allowed = field.options.map((entry) => entry.value);
    if (typeof value !== "string" || !allowed.includes(value)) {
      return `${field.label} must be one of: ${allowed.join(", ")}`;
    }
  }
  if (field.type === "number" && typeof value === "number" && value < 0) {
    return `${field.label} cannot be negative`;
  }
  if (field.key === "statusIntervalMs" && typeof value === "number" && value !== 0 && value < 200) {
    return "Status heartbeat must be at least 200ms";
  }
  return null;
}

function raw(key: string): SettingValue {
  const override = overrides.get(key);
  if (override !== undefined) return override;
  return defaults.get(key) ?? "";
}

function text(key: string): string {
  const value = raw(key);
  return typeof value === "string" ? value : String(value);
}

function optionalText(key: string): string | null {
  const value = text(key).trim();
  return value === "" ? null : value;
}

function flag(key: string): boolean {
  return raw(key) === true;
}

function count(key: string): number {
  const value = raw(key);
  return typeof value === "number" ? value : 0;
}

function commaList(key: string): string[] {
  return text(key)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Splits a shell-ish extra-args string into argv. Supports single and double
 * quotes; deliberately not a full shell parser.
 */
function argvList(key: string): string[] {
  const value = text(key);
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((token) => token.replace(/^["']|["']$/g, ""));
}

/* -------------------------------------------------------------------------- */
/* Public accessor — what the rest of the server reads                         */
/* -------------------------------------------------------------------------- */

export const settings = {
  get statusIntervalMs(): number {
    return count("statusIntervalMs") || 1000;
  },
  /**
   * Run budgets, already scaled for the work item's depth. A decomposed
   * sub-step is a slice of its parent's work, so it gets a slice of the
   * allowance rather than a fresh full one — otherwise decomposing a station
   * into eight children multiplies the ceiling by eight.
   */
  budgetFor(depth: number): {
    maxToolCalls: number | null;
    maxWallClockMs: number | null;
    maxInputTokens: number | null;
    maxToolOutputBytes: number | null;
    noProgressToolCalls: number | null;
    maxToolResultBytes: number;
  } {
    const share = depth > 0 ? Math.min(100, Math.max(1, count("budget.subStepFraction") || 50)) / 100 : 1;
    const scaled = (key: string, fallback: number): number | null => {
      const base = count(key) || fallback;
      if (base <= 0) return null;
      return Math.max(1, Math.round(base * share));
    };
    return {
      maxToolCalls: scaled("budget.maxToolCalls", 250),
      maxWallClockMs: (() => {
        const minutes = scaled("budget.maxWallClockMinutes", 45);
        return minutes === null ? null : minutes * 60_000;
      })(),
      maxInputTokens: scaled("budget.maxInputTokens", 8_000_000),
      maxToolOutputBytes: scaled("budget.maxToolOutputBytes", 1_048_576),
      // Not scaled: a thrash loop is a thrash loop at any depth.
      noProgressToolCalls: (count("budget.noProgressToolCalls") || 25) > 0 ? count("budget.noProgressToolCalls") || 25 : null,
      maxToolResultBytes: Math.max(0, count("budget.maxToolResultBytes") || 8192),
    };
  },
  /**
   * House rules for the pipeline transport, resolved once so the scheduler, the
   * handoff coordinator and the browser all read the same values. Anything
   * unrecognised in the store falls back to the built-in default rather than
   * reaching the rule table as a bad value.
   */
  get pipelinePolicy(): PipelinePolicy {
    const pauseMode = text("pipeline.pauseMode");
    const requirement = text("pipeline.handoffRequirement");
    const onBlocked = text("pipeline.defaultOnBlocked");
    const onDone = text("pipeline.defaultOnDone");
    const generations = count("pipeline.maxHandoffGenerations");
    return {
      pauseMode: pauseMode === "immediate" ? "immediate" : ("graceful" satisfies PauseMode),
      stopInterruptsAgent: flag("pipeline.stopInterruptsAgent"),
      onRestart: text("pipeline.onRestart") === "resumeSameRun" ? "resumeSameRun" : "newRun",
      handoffRequirement:
        requirement === "always" || requirement === "never"
          ? (requirement satisfies HandoffRequirement)
          : "whenWorkProduced",
      autoHandoffOnBlocked: flag("pipeline.autoHandoffOnBlocked"),
      maxHandoffGenerations:
        generations > 0 ? generations : DEFAULT_PIPELINE_POLICY.maxHandoffGenerations,
      defaultOnBlocked: isOnBlockedAction(onBlocked) ? onBlocked : DEFAULT_PIPELINE_POLICY.defaultOnBlocked,
      defaultOnDone: isOnDoneAction(onDone) ? onDone : DEFAULT_PIPELINE_POLICY.defaultOnDone,
    };
  },

  /**
   * One switch that lifts every provider's sandbox/permission gate so Docker
   * and other host services work. Per-provider knobs still exist; this
   * overlays them at run time.
   */
  get hostAccess(): boolean {
    return flag("hostAccess");
  },

  claude: {
    get enabled(): boolean {
      return flag("claude.enabled");
    },
    get apiKey(): string | null {
      return optionalText("claude.apiKey");
    },
    get model(): string | null {
      return optionalText("claude.model");
    },
    get permissionMode(): string {
      return text("claude.permissionMode");
    },
    get settingSources(): string[] {
      return commaList("claude.settingSources");
    },
    get maxTurns(): number | null {
      return count("claude.maxTurns") || null;
    },
  },

  codex: {
    get enabled(): boolean {
      return flag("codex.enabled");
    },
    get apiKey(): string | null {
      return optionalText("codex.apiKey");
    },
    get binary(): string {
      return text("codex.binary") || "codex";
    },
    get model(): string | null {
      return optionalText("codex.model");
    },
    get sandboxMode(): string {
      return text("codex.sandboxMode");
    },
    get skipGitRepoCheck(): boolean {
      return flag("codex.skipGitRepoCheck");
    },
    get extraArgs(): string[] {
      return argvList("codex.extraArgs");
    },
  },

  cursor: {
    get enabled(): boolean {
      return flag("cursor.enabled");
    },
    get binary(): string {
      return text("cursor.binary") || "cursor-agent";
    },
    get model(): string | null {
      return optionalText("cursor.model");
    },
    get outputFormat(): string {
      return text("cursor.outputFormat");
    },
    get force(): boolean {
      return flag("cursor.force");
    },
    get assumeAuthenticated(): boolean {
      return flag("cursor.assumeAuthenticated");
    },
    get extraArgs(): string[] {
      return argvList("cursor.extraArgs");
    },
  },

  grok: {
    get enabled(): boolean {
      return flag("grok.enabled");
    },
    get apiKey(): string | null {
      return optionalText("grok.apiKey");
    },
    get binary(): string {
      return text("grok.binary") || "grok";
    },
    get model(): string | null {
      return optionalText("grok.model");
    },
    get permissionMode(): string {
      return text("grok.permissionMode");
    },
    get sandboxMode(): string {
      return text("grok.sandboxMode");
    },
    get maxTurns(): number | null {
      return count("grok.maxTurns") || null;
    },
    get assumeAuthenticated(): boolean {
      return flag("grok.assumeAuthenticated");
    },
    get extraArgs(): string[] {
      return argvList("grok.extraArgs");
    },
  },

  copilot: {
    get enabled(): boolean {
      return flag("copilot.enabled");
    },
    get githubToken(): string | null {
      return optionalText("copilot.githubToken");
    },
    get binary(): string {
      return text("copilot.binary") || "copilot";
    },
    get model(): string | null {
      return optionalText("copilot.model");
    },
    get permissionMode(): string {
      return text("copilot.permissionMode");
    },
    get reasoningEffort(): string | null {
      return optionalText("copilot.reasoningEffort");
    },
    get maxAiCredits(): number | null {
      return count("copilot.maxAiCredits") || null;
    },
    get builtinMcpServers(): boolean {
      return flag("copilot.builtinMcpServers");
    },
    get remoteExport(): boolean {
      return flag("copilot.remoteExport");
    },
    get assumeAuthenticated(): boolean {
      return flag("copilot.assumeAuthenticated");
    },
    get extraArgs(): string[] {
      return argvList("copilot.extraArgs");
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Snapshot / update / reset                                                   */
/* -------------------------------------------------------------------------- */

function describeField(field: FieldDef): SettingField {
  const current = raw(field.key);
  const defaultValue = defaults.get(field.key) ?? field.fallback;
  const sensitive = field.type === "password";
  return {
    key: field.key,
    label: field.label,
    group: field.group,
    type: field.type,
    description: field.description,
    envVar: field.envVar,
    placeholder: field.placeholder ?? null,
    options: field.options ?? null,
    // Secrets never leave the server: the client learns only whether one is set.
    defaultValue: sensitive ? "" : defaultValue,
    value: sensitive ? "" : current,
    overridden: overrides.has(field.key) && current !== defaultValue,
    isSet: sensitive ? String(current) !== "" : false,
    danger: field.isDangerous?.(current) ?? false,
    dangerWhenTrue: field.type === "boolean" && (field.isDangerous?.(true) ?? false),
    requiresRestart: field.requiresRestart ?? false,
  };
}

/** Groups that actually have at least one field. Used by the UI-coverage test. */
export function groupsWithFields(): string[] {
  return [...GROUPS].filter((group) => FIELDS.some((field) => field.group === group));
}

export function snapshot(): SettingsSnapshot {
  return {
    fields: FIELDS.map(describeField),
    groups: [...GROUPS],
    storagePath: STORAGE_PATH,
  };
}

export interface UpdateResult {
  ok: boolean;
  errors: string[];
  changed: string[];
  snapshot: SettingsSnapshot;
}

export function updateSettings(patch: SettingsPatch): UpdateResult {
  const errors: string[] = [];
  const staged = new Map<string, SettingValue>();

  for (const [key, value] of Object.entries(patch)) {
    const field = FIELDS_BY_KEY.get(key);
    if (field === undefined) {
      errors.push(`Unknown setting "${key}"`);
      continue;
    }
    const normalized = normalize(field, value);
    if (normalized === null) {
      errors.push(`${field.label} has an invalid value`);
      continue;
    }
    const problem = validate(field, normalized);
    if (problem !== null) {
      errors.push(problem);
      continue;
    }
    staged.set(key, normalized);
  }

  if (errors.length > 0) return { ok: false, errors, changed: [], snapshot: snapshot() };

  const changed: string[] = [];
  for (const [key, value] of staged) {
    if (raw(key) === value) continue;
    const defaultValue = defaults.get(key);
    // Setting a field back to its .env value drops the override entirely.
    if (defaultValue !== undefined && defaultValue === value) overrides.delete(key);
    else overrides.set(key, value);
    changed.push(key);
  }

  if (changed.length > 0) {
    try {
      persist();
      log.info(`saved ${changed.length} setting(s): ${changed.join(", ")}`);
    } catch (error) {
      return {
        ok: false,
        errors: [`Could not write ${STORAGE_PATH}: ${error instanceof Error ? error.message : String(error)}`],
        changed: [],
        snapshot: snapshot(),
      };
    }
  }

  return { ok: true, errors: [], changed, snapshot: snapshot() };
}

/** Drops saved overrides, returning the given keys (or everything) to .env values. */
export function resetSettings(keys?: string[]): UpdateResult {
  const changed: string[] = [];
  if (keys === undefined || keys.length === 0) {
    changed.push(...overrides.keys());
    overrides = new Map();
  } else {
    for (const key of keys) {
      if (overrides.delete(key)) changed.push(key);
    }
  }
  if (changed.length > 0) {
    try {
      persist();
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
        changed: [],
        snapshot: snapshot(),
      };
    }
  }
  return { ok: true, errors: [], changed, snapshot: snapshot() };
}

/* -------------------------------------------------------------------------- */
/* Host-access overlay                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Unix sockets Docker-style clients talk to. `DOCKER_HOST=unix://…` wins;
 * otherwise the default engine socket. TCP Docker hosts need no socket grant.
 */
export function hostUnixSockets(): string[] {
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost === undefined || dockerHost === "") return ["/var/run/docker.sock"];
  if (dockerHost.startsWith("unix://")) {
    const path = dockerHost.slice("unix://".length);
    return path === "" ? [] : [path];
  }
  return [];
}

/** Effective Claude permission mode after the host-access overlay. */
export function effectiveClaudePermissionMode(): string {
  return settings.hostAccess ? "bypassPermissions" : settings.claude.permissionMode;
}

/** Effective Codex sandbox mode after the host-access overlay. */
export function effectiveCodexSandboxMode(): string {
  return settings.hostAccess ? "danger-full-access" : settings.codex.sandboxMode;
}

/** Effective Grok permission mode after the host-access overlay. */
export function effectiveGrokPermissionMode(): string {
  return settings.hostAccess ? "bypassPermissions" : settings.grok.permissionMode;
}

/** Effective Grok sandbox profile after the host-access overlay. */
export function effectiveGrokSandboxMode(): string {
  return settings.hostAccess ? "off" : settings.grok.sandboxMode;
}

/** Effective Copilot permission mode after the host-access overlay. */
export function effectiveCopilotPermissionMode(): string {
  return settings.hostAccess ? "yolo" : settings.copilot.permissionMode;
}

/** Effective Cursor --force after the host-access overlay. */
export function effectiveCursorForce(): boolean {
  return settings.hostAccess ? true : settings.cursor.force;
}

function hostAccessSuffix(value: string): string {
  return settings.hostAccess ? `${value} · host access` : value;
}

/** Status-bar / tooltip string; includes the overlay so the UI is honest. */
export function describeEffectiveAccess(base: string): string {
  return hostAccessSuffix(base);
}

/** Permission/sandbox the process should start with for this run. */
export function permissionForRun(
  provider: ProviderId,
  override: PermissionOverride,
): { mode: string; hostAccessApplied: boolean } {
  if (override !== "inherit") {
    switch (provider) {
      case "claude":
        return { mode: "plan", hostAccessApplied: false };
      case "codex":
        return { mode: "read-only", hostAccessApplied: false };
      case "grok":
        return { mode: "plan · sandbox: workspace", hostAccessApplied: false };
      case "cursor":
        return { mode: "read-only-not-supported", hostAccessApplied: false };
      case "copilot":
        return { mode: "plan", hostAccessApplied: false };
    }
  }
  switch (provider) {
    case "claude":
      return { mode: effectiveClaudePermissionMode(), hostAccessApplied: settings.hostAccess };
    case "codex":
      return { mode: effectiveCodexSandboxMode(), hostAccessApplied: settings.hostAccess };
    case "grok":
      return {
        mode: `${effectiveGrokPermissionMode()} · sandbox: ${effectiveGrokSandboxMode()}`,
        hostAccessApplied: settings.hostAccess,
      };
    case "cursor":
      return {
        mode: effectiveCursorForce() ? "force (non-interactive)" : "interactive approval",
        hostAccessApplied: settings.hostAccess,
      };
    case "copilot":
      return { mode: effectiveCopilotPermissionMode(), hostAccessApplied: settings.hostAccess };
  }
}

load();

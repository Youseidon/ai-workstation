import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
 * overrides saved from the settings page are persisted to a JSON file and layered
 * on top. Adapters read through the `settings` accessor at run time, so a change
 * applies to the next run without restarting the server — and the settings page
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

export const GROUPS = ["General", "Claude Code", "Codex CLI", "Cursor CLI", "Grok CLI"] as const;

const FIELDS: FieldDef[] = [
  {
    key: "workdir",
    label: "Default workspace directory (legacy)",
    group: "General",
    type: "path",
    envVar: "AGENT_WORKDIR",
    fallback: "./workspace",
    placeholder: "/absolute/path or ./relative-to-repo",
    description:
      "Used to seed the Default workspace on a new database. Runs now use the directory selected on the Workspaces page.",
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
      "Lets every provider reach Docker and other host services. Codex drops its sandbox, Claude and Grok skip permission prompts, and Grok's OS sandbox is turned off. Needed for docker compose, local stacks, and /var/run/docker.sock. The per-provider sandbox settings below are ignored while this is on.",
    isDangerous: (value) => value === true,
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
  get workdir(): string {
    const value = text("workdir") || "./workspace";
    return isAbsolute(value) ? value : resolve(config.repoRoot, value);
  },
  get workdirExists(): boolean {
    return existsSync(this.workdir);
  },
  get statusIntervalMs(): number {
    return count("statusIntervalMs") || 1000;
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

export function snapshot(): SettingsSnapshot {
  return {
    fields: FIELDS.map(describeField),
    groups: [...GROUPS],
    storagePath: STORAGE_PATH,
    workdir: settings.workdir,
    workdirExists: settings.workdirExists,
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
  if (override === "consult") {
    switch (provider) {
      case "claude":
        return { mode: "plan", hostAccessApplied: false };
      case "codex":
        return { mode: "read-only", hostAccessApplied: false };
      case "grok":
        return { mode: "plan · sandbox: workspace", hostAccessApplied: false };
      case "cursor":
        return { mode: "consult-not-supported", hostAccessApplied: false };
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
  }
}

load();

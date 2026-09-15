import type { OperationsPrompt, OperationsSnapshot, OperationsSuite, PromptOperationalState, ProviderUsage } from "@agent-console/shared";
import { lineText, type TaskSummary } from "../../telegramSummary.ts";
import { formatCard, TELEGRAM_TEXT_LIMIT, type CardEntity } from "./card.ts";

/*
 * Read-only status views (L3 slice B, RTC-24; user-flows section 9; docs/e2e-scenarios/l3-b.md).
 * Every view is a pure function of an operations snapshot, task summaries and the last
 * cached provider usage, so a view can never start work, spend quota or change state.
 * The same registry feeds /help and Telegram's command menu.
 *
 * Navigation buttons carry `nv_` callback data (at most 64 bytes, protocol section 7)
 * that encodes the view to show, so a tap needs no server-side session and still works
 * after a restart.
 *
 * Operator questions answered with defaults pending review (recorded in implementation.md):
 * filters map one to one onto operational states (blocked = AWAITING_RESPONSE, done =
 * COMPLETE by last activity in 24 hours; WAITING_DEPENDENCY and SKIPPED are not listed);
 * "as of" is workstation local time with the date when not today; views show workspace
 * names, never directories; /task uses the card budget.
 */

export const TASK_FILTERS = ["running", "blocked", "recovery", "failed", "ready", "done"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

const FILTER_STATE: Record<TaskFilter, PromptOperationalState> = {
  running: "WORKING",
  blocked: "AWAITING_RESPONSE",
  recovery: "RECOVERY_NEEDED",
  failed: "FAILED",
  ready: "READY",
  done: "COMPLETE",
};

const FILTER_TITLE: Record<TaskFilter, string> = {
  running: "Running tasks",
  blocked: "Blocked tasks",
  recovery: "Tasks needing recovery",
  failed: "Failed tasks",
  ready: "Ready tasks",
  done: "Tasks done in the last 24 hours",
};

export const COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "status", description: "What the workstation is doing" },
  { command: "tasks", description: "Tasks by state: running, blocked, recovery, failed, ready, done" },
  { command: "running", description: "Running tasks" },
  { command: "blocked", description: "Tasks waiting for you" },
  { command: "pipelines", description: "Active and recent pipelines" },
  { command: "quota", description: "Provider quota windows" },
  { command: "task", description: "One task's summary: /task <key or id>" },
  { command: "help", description: "The command list" },
];

export type ViewRequest =
  | { view: "status" }
  | { view: "tasks"; filter: TaskFilter | null; page: number }
  | { view: "pipelines"; page: number }
  | { view: "quota" }
  | { view: "task"; promptId: number; back: ViewRequest | null }
  | { view: "find"; ref: string; page: number }
  | { view: "help" };

export interface ViewButton {
  text: string;
  data: string;
}

export interface RenderedView {
  kind: "view";
  text: string;
  entities: CardEntity[];
  buttons: ViewButton[][];
}

export interface ViewContext {
  snapshot: OperationsSnapshot;
  summary: (promptId: number) => TaskSummary | null;
  usage: { at: number; usage: ProviderUsage[] } | null;
  now: Date;
  workstation: string;
}

export const PAGE_SIZE = 10;
export const HELP_HINT = "To answer a task, reply to its question message. Ordinary messages are not task instructions.";

/* ------------------------------ parsing ------------------------------ */

export type ParsedCommand = { kind: "view"; request: ViewRequest } | { kind: "unknown" } | { kind: "other_bot" } | { kind: "not_command" };

/**
 * Parses a registered command (case-insensitive, optionally addressed to this bot). Only registered
 * commands are commands: anything else starting with "/" is `unknown`, which a card reply still
 * treats as an answer (operator question 5). A command addressed to another bot is ignored.
 */
export function parseCommand(text: string, botUsername: string | null): ParsedCommand {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return { kind: "not_command" };
  const [, rawName, addressee, rawArgs] = match;
  if (addressee !== undefined && (botUsername === null || addressee.toLowerCase() !== botUsername.toLowerCase())) return { kind: "other_bot" };
  const name = rawName!.toLowerCase();
  const args = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
  switch (name) {
    case "status":
      return { kind: "view", request: { view: "status" } };
    case "tasks": {
      const filter = args[0]?.toLowerCase();
      if (filter === undefined) return { kind: "view", request: { view: "tasks", filter: null, page: 0 } };
      // An unknown or extra argument shows the filter buttons (operator question 6).
      if (args.length > 1 || !(TASK_FILTERS as readonly string[]).includes(filter)) return { kind: "view", request: { view: "tasks", filter: null, page: 0 } };
      return { kind: "view", request: { view: "tasks", filter: filter as TaskFilter, page: 0 } };
    }
    case "running":
    case "blocked":
      return { kind: "view", request: { view: "tasks", filter: name, page: 0 } };
    case "pipelines":
      return { kind: "view", request: { view: "pipelines", page: 0 } };
    case "quota":
      return { kind: "view", request: { view: "quota" } };
    case "task":
      return args.length === 0 ? { kind: "view", request: { view: "help" } } : { kind: "view", request: { view: "find", ref: args[0]!.slice(0, 40), page: 0 } };
    case "help":
      return { kind: "view", request: { view: "help" } };
    default:
      return { kind: "unknown" };
  }
}

/* ----------------------------- navigation data ----------------------------- */

const FILTER_CODE: Record<TaskFilter, string> = { running: "r", blocked: "b", recovery: "v", failed: "f", ready: "y", done: "d" };
const CODE_FILTER = Object.fromEntries(Object.entries(FILTER_CODE).map(([filter, code]) => [code, filter])) as Record<string, TaskFilter>;

function encodeInner(request: ViewRequest): string {
  switch (request.view) {
    case "status": return "s";
    case "quota": return "q";
    case "help": return "h";
    case "pipelines": return `p${request.page}`;
    case "tasks": return `t${request.filter === null ? "a" : FILTER_CODE[request.filter]}${request.page}`;
    case "find": return `f${request.page}.${request.ref}`;
    case "task": return `k${request.promptId}${request.back ? `.${encodeInner(request.back)}` : ""}`;
  }
}

/** `nv_` callback data for a view; at most 64 bytes, dropping the Back target if a key is too long. */
export function encodeNav(request: ViewRequest): string {
  const data = `nv_${encodeInner(request)}`;
  if (Buffer.byteLength(data) <= 64 && decodeNav(data) !== null) return data;
  // Too long, or a typed key that callback data cannot carry: drop the Back target rather than the button.
  return request.view === "task" ? `nv_k${request.promptId}` : "nv_s";
}

function decodeInner(value: string): ViewRequest | null {
  if (value === "s") return { view: "status" };
  if (value === "q") return { view: "quota" };
  if (value === "h") return { view: "help" };
  let match = /^p(\d{1,4})$/.exec(value);
  if (match) return { view: "pipelines", page: Number(match[1]) };
  match = /^t([arbvfyd])(\d{1,4})$/.exec(value);
  if (match) return { view: "tasks", filter: match[1] === "a" ? null : CODE_FILTER[match[1]!]!, page: Number(match[2]) };
  match = /^f(\d{1,4})\.([A-Za-z0-9_.-]{1,40})$/.exec(value);
  if (match) return { view: "find", page: Number(match[1]), ref: match[2]! };
  match = /^k(\d{1,12})(?:\.(.+))?$/.exec(value);
  if (match) {
    const back = match[2] === undefined ? null : decodeInner(match[2]);
    if (match[2] !== undefined && (back === null || back.view === "task")) return null;
    return { view: "task", promptId: Number(match[1]), back };
  }
  return null;
}

/** The view a navigation tap asks for, or null for data that is not a well-formed `nv_` reference. */
export function decodeNav(data: string): ViewRequest | null {
  if (!data.startsWith("nv_") || Buffer.byteLength(data) > 64 || /[ -]/.test(data)) return null;
  return decodeInner(data.slice(3));
}

/* -------------------------------- rendering -------------------------------- */

function asOf(context: ViewContext): string {
  const at = new Date(context.snapshot.generatedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.toDateString() === context.now.toDateString();
  return `as of ${sameDay ? "" : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `}${time}`;
}

const prompts = (snapshot: OperationsSnapshot) => snapshot.suites.flatMap((suite) => suite.prompts.map((item) => ({ suite, item })));

function matches(item: OperationsPrompt, filter: TaskFilter, now: Date): boolean {
  if (item.operationalState !== FILTER_STATE[filter]) return false;
  return filter !== "done" || now.getTime() - Date.parse(item.lastActivityAt) <= 24 * 60 * 60_000;
}

const taskLabel = (item: OperationsPrompt) => lineText(`${item.prompt.externalKey ? `${item.prompt.externalKey} ` : ""}${item.prompt.title}`, 60);
const back = (request: ViewRequest): ViewButton => ({ text: "Back", data: encodeNav(request) });
const refresh = (request: ViewRequest): ViewButton => ({ text: "Refresh", data: encodeNav(request) });

function pipelinePosition(suite: OperationsSuite): { step: number; total: number } | null {
  const run = suite.pipeline?.active ?? suite.pipeline?.latest ?? null;
  if (!run) return null;
  const enabled = suite.prompts.filter((entry) => entry.pipelineRule.enabled).sort((a, b) => a.pipelineRule.stepOrder - b.pipelineRule.stepOrder);
  const index = enabled.findIndex((entry) => entry.prompt.id === run.currentPromptId);
  return index === -1 ? null : { step: index + 1, total: enabled.length };
}

function pipelineLine(suite: OperationsSuite): string {
  const run = suite.pipeline?.active ?? suite.pipeline?.latest!;
  const position = pipelinePosition(suite);
  const state = run.state === "WAITING_HUMAN" ? "waiting for you" : run.state.toLowerCase();
  return `• ${lineText(suite.workspaceName, 40)} / ${lineText(suite.name, 40)}: ${position ? `step ${position.step}/${position.total}, ` : ""}${state}`;
}

function paginate<T>(items: T[], page: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), page: current, pages };
}

const view = (lines: string[], buttons: ViewButton[][], entities: CardEntity[] = []): RenderedView => {
  const text = lines.join("\n");
  return { kind: "view", text: text.length <= TELEGRAM_TEXT_LIMIT ? text : `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`, entities, buttons: buttons.filter((row) => row.length > 0) };
};

function quotaLine(usage: ProviderUsage, at: number, now: Date): string {
  if (!usage.available) return `${usage.provider}: unknown${usage.reason ? ` (${lineText(usage.reason, 60)})` : ""}`;
  const minutes = Math.max(0, Math.round((now.getTime() - (usage.fetchedAt ? Date.parse(usage.fetchedAt) : at)) / 60_000));
  const windows = usage.windows.filter((window) => window.usedPercent !== null).map((window) => `${100 - Math.round(window.usedPercent!)}% left (${window.kind})`);
  return `${usage.provider}: ${windows.length > 0 ? windows.join(", ") : "no figures reported"} · ${minutes} min ago`;
}

export function renderView(request: ViewRequest, context: ViewContext): RenderedView {
  const header = (title: string) => `${title} · ${lineText(context.workstation, 64)} · ${asOf(context)}`;
  switch (request.view) {
    case "help":
      return view([HELP_HINT, "", "Commands:", ...COMMANDS.map((entry) => `/${entry.command} - ${entry.description}`)], []);
    case "status": {
      const all = prompts(context.snapshot).map(({ item }) => item);
      const count = (filter: TaskFilter) => all.filter((item) => matches(item, filter, context.now)).length;
      const lines = [header("Status")];
      if (all.length === 0) {
        lines.push("No tasks on this workstation.");
      } else {
        lines.push(`Running ${count("running")} · Blocked ${count("blocked")} · Needs recovery ${count("recovery")} · Failed ${count("failed")} · Ready ${count("ready")}`);
      }
      const active = context.snapshot.suites.filter((suite) => suite.pipeline?.active);
      lines.push(active.length > 0 ? `Pipelines:\n${active.slice(0, 10).map(pipelineLine).join("\n")}${active.length > 10 ? `\nand ${active.length - 10} more: /pipelines` : ""}` : "No active pipelines.");
      const usage = context.usage?.usage.filter((entry) => entry.available) ?? [];
      lines.push(usage.length > 0 ? `Quota: ${usage.map((entry) => quotaLine(entry, context.usage!.at, context.now)).join("; ")}` : "Quota: unknown until the local app has fetched it.");
      return view(lines, [TASK_FILTERS.filter((filter) => filter !== "done").map((filter) => ({ text: filter, data: encodeNav({ view: "tasks", filter, page: 0 }) })), [{ text: "Pipelines", data: encodeNav({ view: "pipelines", page: 0 }) }, { text: "Quota", data: encodeNav({ view: "quota" }) }, refresh(request)]]);
    }
    case "tasks": {
      if (request.filter === null) {
        return view([header("Tasks"), "Choose which tasks to list."], [TASK_FILTERS.slice(0, 3).map((filter) => ({ text: filter, data: encodeNav({ view: "tasks", filter, page: 0 }) })), TASK_FILTERS.slice(3).map((filter) => ({ text: filter, data: encodeNav({ view: "tasks", filter, page: 0 }) }))]);
      }
      const filter = request.filter;
      const matching = prompts(context.snapshot).filter(({ item }) => matches(item, filter, context.now));
      if (matching.length === 0) return view([header(FILTER_TITLE[filter]), `No ${FILTER_TITLE[filter].toLowerCase()} ${asOf(context)}.`], [[back({ view: "tasks", filter: null, page: 0 }), refresh(request)]]);
      const { items, page, pages } = paginate(matching, request.page);
      const here: ViewRequest = { view: "tasks", filter, page };
      const lines = [header(FILTER_TITLE[filter]) + (pages > 1 ? ` · page ${page + 1}/${pages}` : "")];
      let workspace = "";
      for (const { suite, item } of items) {
        if (suite.workspaceName !== workspace) {
          workspace = suite.workspaceName;
          lines.push("", `${lineText(workspace, 60)}:`);
        }
        lines.push(`• ${taskLabel(item)}`);
      }
      const pager: ViewButton[] = [];
      if (page > 0) pager.push({ text: "Previous", data: encodeNav({ ...here, page: page - 1 }) });
      if (page < pages - 1) pager.push({ text: "Next", data: encodeNav({ ...here, page: page + 1 }) });
      return view(lines, [...items.map(({ item }) => [{ text: taskLabel(item), data: encodeNav({ view: "task", promptId: item.prompt.id, back: here }) }]), pager, [back({ view: "tasks", filter: null, page: 0 }), refresh(here)]]);
    }
    case "pipelines": {
      const suites = context.snapshot.suites.filter((suite) => suite.pipeline?.active || suite.pipeline?.latest);
      if (suites.length === 0) return view([header("Pipelines"), "No pipelines have run on this workstation."], [[refresh(request)]]);
      const ordered = [...suites.filter((suite) => suite.pipeline?.active), ...suites.filter((suite) => !suite.pipeline?.active)];
      const { items, page, pages } = paginate(ordered, request.page);
      const here: ViewRequest = { view: "pipelines", page };
      const pager: ViewButton[] = [];
      if (page > 0) pager.push({ text: "Previous", data: encodeNav({ ...here, page: page - 1 }) });
      if (page < pages - 1) pager.push({ text: "Next", data: encodeNav({ ...here, page: page + 1 }) });
      return view([header("Pipelines") + (pages > 1 ? ` · page ${page + 1}/${pages}` : ""), ...items.map(pipelineLine)], [pager, [refresh(here)]]);
    }
    case "quota": {
      const usage = context.usage?.usage ?? [];
      if (usage.length === 0) return view([header("Quota"), "No quota figures yet. Open the Agents page in the local app to fetch them."], [[refresh(request)]]);
      return view([header("Quota"), ...usage.map((entry) => quotaLine(entry, context.usage!.at, context.now))], [[refresh(request)]]);
    }
    case "find": {
      const ref = request.ref.toLowerCase();
      const candidates = prompts(context.snapshot).filter(({ item }) => String(item.prompt.id) === ref || item.prompt.externalKey?.toLowerCase() === ref);
      if (candidates.length === 0) return view([header("Task"), `No task matches "${lineText(request.ref, 40)}".`], []);
      if (candidates.length === 1) return renderView({ view: "task", promptId: candidates[0]!.item.prompt.id, back: null }, context);
      const here: ViewRequest = { view: "find", ref: request.ref, page: 0 };
      return view([header("Task"), `Several tasks match "${lineText(request.ref, 40)}". Choose one.`], candidates.slice(0, PAGE_SIZE).map(({ suite, item }) => [{ text: lineText(`${suite.workspaceName}: ${item.prompt.title}`, 60), data: encodeNav({ view: "task", promptId: item.prompt.id, back: here }) }]));
    }
    case "task": {
      const found = prompts(context.snapshot).find(({ item }) => item.prompt.id === request.promptId);
      const summary = found ? context.summary(request.promptId) : null;
      const buttons = [[...(request.back ? [back(request.back)] : []), refresh(request)]];
      if (!found || !summary) return view([header("Task"), "This task no longer exists on this workstation."], request.back ? [[back(request.back)]] : []);
      const card = formatCard(summary, { hint: `State: ${found.item.operationalState.toLowerCase().replace(/_/g, " ")} · ${asOf(context)}` });
      return { kind: "view", text: card.text, entities: card.entities, buttons };
    }
  }
}

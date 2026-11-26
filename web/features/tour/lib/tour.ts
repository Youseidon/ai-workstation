import type { ProviderId } from "@hydra/shared";

// The guided tour is data: each step names what to light up, what to say,
// and — for the steps that matter — something the visitor has to actually
// do. Targets are lists of ordinary selectors tried in order, so a markup
// change degrades a step to a centred card instead of breaking the tour.

export type ChapterId = "bearings" | "chat" | "pipeline" | "activity" | "changes" | "agents";

export interface Chapter { id: ChapterId; title: string; tagline: string; head: ProviderId }

// Six chapters, six heads: finishing a chapter wakes one head of the mark.
export const CHAPTERS: readonly Chapter[] = [
  { id: "bearings", title: "Bearings", tagline: "Workspaces and how to get around", head: "claude" },
  { id: "chat", title: "Chat", tagline: "Ask questions, hand over tasks", head: "codex" },
  { id: "pipeline", title: "Pipelines", tagline: "Chain agents into stations", head: "cursor" },
  { id: "activity", title: "Activity", tagline: "Every run, replayable", head: "grok" },
  { id: "changes", title: "Changes", tagline: "Review what agents committed", head: "copilot" },
  { id: "agents", title: "Agents", tagline: "Who's installed, what they may do", head: "kilocode" },
];

export interface RoutePattern { path: string; prefix?: boolean; search?: Record<string, string> }
export interface TourLocation { pathname: string; search: string }

export type TourTask =
  | { kind: "click"; selector: string; label: string }
  | { kind: "route"; route: RoutePattern; label: string }
  | { kind: "input"; selector: string; label: string };

export interface TourContext { demo: boolean; workspaceName: string | null; workDirectory: string | null }

export interface TourStep {
  id: string;
  chapter: ChapterId;
  title: string;
  body: string | ((context: TourContext) => string);
  /** Selectors tried in order; every visible match is lit, so a menu can join its button. */
  target?: readonly string[];
  /** Where the step lives. Away from it, the card offers to take the visitor there. */
  route?: RoutePattern;
  href?: string;
  task?: TourTask;
}

// One comma list, so the open menu is lit together with its button.
export const SWITCHER = [".app-section-current, .app-section-menu:not([hidden])"];
const go = (label: string, path: string): TourTask => ({ kind: "route", route: { path, prefix: path !== "/" }, label });

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome", chapter: "bearings", title: "Meet Hydra",
    body: ctx => ctx.demo
      ? "Many heads, one console. Hydra drives the coding agents installed on this machine — Claude Code, Codex, Cursor and friends — from one place. This demo is a real account with a real project, so **everything you click here actually works**."
      : "Many heads, one console. Hydra drives the coding agents installed on this machine — Claude Code, Codex, Cursor and friends — from one place. This tour shows you around in about four minutes.",
  },
  {
    id: "workspace", chapter: "bearings", title: "Everything starts in a workspace",
    target: ['.app-sidebar-top button[aria-haspopup="listbox"]'],
    body: ctx => ctx.workDirectory
      ? `**Create a workspace first:** prompts and all other app controls stay unavailable until one is saved. A workspace points agents at a project folder on this machine. **${ctx.workspaceName ?? "This one"}** lives at \`${ctx.workDirectory}\`. Switch workspaces here; the dot shows its Git state.`
      : "**Create a workspace first:** prompts and all other app controls stay unavailable until one is saved. Choose **Create workspace** on the setup screen and specify a project directory on this machine. Once saved, the app opens and you can switch workspaces here.",
  },
  {
    id: "switcher", chapter: "bearings", title: "Your compass",
    target: SWITCHER,
    body: "Every page is one click away from this switcher. Arrow keys work too.",
    task: { kind: "click", selector: ".app-section-current", label: "Open the switcher" },
  },

  {
    id: "threads", chapter: "chat", title: "Conversations", route: { path: "/" }, href: "/",
    target: [".app-sidebar-collection"],
    body: ctx => ctx.demo
      ? "Each thread is a conversation with one or more agents. Pinned ones stay on top; **Unread reply** means an agent answered while you were away."
      : "Each thread is a conversation with one or more agents. Pin the ones you keep coming back to.",
    task: { kind: "click", selector: ".app-sidebar-collection .app-sidebar-link", label: "Open a conversation" },
  },
  {
    id: "transcript", chapter: "chat", title: "Watch the work, not just the answer", route: { path: "/" }, href: "/",
    target: [".app-workspace"],
    body: "Agents stream their thinking, the files they read and the commands they run. Click any tool call to unfold its output. The server keeps the run going even if you close the tab.",
  },
  {
    id: "mode", chapter: "chat", title: "Run or Ask?", route: { path: "/" }, href: "/",
    target: ['[aria-label="Message mode"]'],
    body: "**Run** hands an agent a task: it edits files and commits. **Ask** is a read-only consult — perfect for questions. One workspace allows one writer and up to three askers at a time.",
    task: { kind: "click", selector: '[aria-label="Message mode"] button[aria-label="Ask"]', label: "Switch to Ask" },
  },
  {
    id: "compose", chapter: "chat", title: "Ask something — for real", route: { path: "/" }, href: "/",
    target: ['textarea[aria-label="Prompt"]', '[aria-label="Show composer"]', '[aria-label="Provider for next message"]'],
    body: "Type a question about the project. If an agent is installed and signed in on this machine, press **Ask** and watch it answer live. Type **@** to pick a different agent or model.",
    task: { kind: "input", selector: 'textarea[aria-label="Prompt"]', label: "Type a question" },
  },

  {
    id: "to-pipeline", chapter: "pipeline", title: "Pipelines", target: SWITCHER,
    body: "A pipeline lines work items up as **stations** and gives each one an agent. Press Play and they hand off to each other until something needs you.",
    task: go("Open Pipeline from the switcher", "/pipeline"),
  },
  {
    id: "dashboard", chapter: "pipeline", title: "The overview", route: { path: "/pipeline" }, href: "/pipeline",
    target: [".app-route"],
    body: ctx => ctx.demo
      ? "**Ship Kettle v1** ran four stations: Codex fixed a bug, Cursor added presets, then Copilot ran out of requests — so Hydra stopped and waited instead of guessing."
      : "Run activity, throughput and anything waiting on you, across every pipeline in the workspace.",
  },
  {
    id: "needs-you", chapter: "pipeline", title: "When an agent needs a human", route: { path: "/pipeline" }, href: "/pipeline",
    target: ['a[href*="filter=attention"]', ".app-route"],
    body: ctx => ctx.demo
      ? "Two stations wait for you: Copilot's crashed run, and Claude's question about which chime to use. Hydra stops and asks instead of guessing; each item says exactly what it needs."
      : "Stations that are blocked on a question collect here, with the agent's exact question.",
    task: { kind: "route", route: { path: "/pipeline/open", prefix: true }, label: "Open the waiting station" },
  },
  {
    id: "station", chapter: "pipeline", title: "Answer, and the line moves again", route: { path: "/pipeline", prefix: true }, href: "/pipeline",
    target: [".app-route"],
    body: "Read why it stopped, reply in the station's thread, and the next run picks your answer up. Status changes are explained in plain words under **Why this status?**",
  },

  {
    id: "to-activity", chapter: "activity", title: "Activity", target: SWITCHER,
    body: "Every run, consult and station, from every agent, newest first.",
    task: go("Open Activity", "/activity"),
  },
  {
    id: "runs", chapter: "activity", title: "Nothing is a black box", route: { path: "/activity" }, href: "/activity",
    target: [".app-sidebar-slot", ".app-route"],
    body: ctx => ctx.demo
      ? "Pick any run to replay its full log: tokens, tool calls and timing. The failed Copilot run is here too — failures are recorded, not hidden."
      : "Pick any run to replay its full log: tokens, tool calls and timing. Failures are recorded, not hidden.",
    task: { kind: "click", selector: ".app-sidebar-slot .app-sidebar-link", label: "Open a run" },
  },

  {
    id: "to-changes", chapter: "changes", title: "Changes", target: SWITCHER,
    body: "Agents commit their work through Hydra, so every change is tied to the run that made it.",
    task: go("Open Changes", "/changes"),
  },
  {
    id: "capsules", chapter: "changes", title: "Change capsules", route: { path: "/changes" }, href: "/changes",
    target: ['a[href^="/changes/"]', ".app-route"],
    body: "One capsule per run: branch, commit range and line counts. **Direct run** means it came from Chat rather than a pipeline.",
    task: { kind: "route", route: { path: "/changes/", prefix: true }, label: "Open a change capsule" },
  },
  {
    id: "diff", chapter: "changes", title: "A real diff from a real repo", route: { path: "/changes/", prefix: true }, href: "/changes",
    target: ['[aria-label="Comparison"]', '[aria-label="Diff"]'],
    body: ctx => ctx.demo
      ? `These are genuine commits in \`${ctx.workDirectory ?? "the demo folder"}\` — run \`git log\` there and you'll see the agents as authors. Try the other layout.`
      : "These are the run's real commits, straight from Git. Try the other layout.",
    task: { kind: "click", selector: '[aria-label="Comparison"] button', label: "Switch between Unified and Split" },
  },

  {
    id: "to-agents", chapter: "agents", title: "Agents", target: SWITCHER,
    body: "Who's installed, who's signed in, and what each agent may do.",
    task: go("Open Agents", "/agents"),
  },
  {
    id: "configuration", chapter: "agents", title: "Set the rules once", route: { path: "/agents" }, href: "/agents",
    target: [".fleet-page-tabs"],
    body: "**Live fleet** shows what's running across all workspaces. **Configuration** holds models, permissions and budgets for every provider.",
    task: { kind: "route", route: { path: "/agents", search: { view: "configuration" } }, label: "Open Configuration" },
  },
  {
    id: "providers", chapter: "agents", title: "Detected on this machine", route: { path: "/agents", search: { view: "configuration" } }, href: "/agents?view=configuration",
    target: [".app-route"],
    body: ctx => ctx.demo
      ? "Hydra detects the CLIs installed here. In this demo, runs are capped at **$5** and **15 minutes**, and Grok and Kilo Code are switched off — flip them back on if you like."
      : "Hydra detects the CLIs installed here. Turn providers on or off, pick default models and set run budgets.",
  },
  {
    id: "finish", chapter: "agents", title: "That's the whole beast",
    target: ['[data-tour="tour-button"]'],
    body: "Replay the tour or jump to a chapter from here any time.",
  },
];

export function stepBody(step: TourStep, context: TourContext): string {
  return typeof step.body === "function" ? step.body(context) : step.body;
}

export function chapterOf(id: ChapterId): Chapter {
  return CHAPTERS.find(chapter => chapter.id === id) ?? CHAPTERS[0]!;
}

export function firstStepOf(chapter: ChapterId): number {
  return Math.max(0, TOUR_STEPS.findIndex(step => step.chapter === chapter));
}

export function chapterSteps(chapter: ChapterId): number[] {
  return TOUR_STEPS.flatMap((step, index) => step.chapter === chapter ? [index] : []);
}

export function locationMatches(pattern: RoutePattern, location: TourLocation): boolean {
  const { pathname } = location;
  // A prefix ending in "/" ("/changes/") means "somewhere below", never the page itself.
  const pathOk = !pattern.prefix ? pathname === pattern.path
    : pattern.path.endsWith("/") ? pathname.startsWith(pattern.path) && pathname.length > pattern.path.length
    : pathname === pattern.path || pathname.startsWith(`${pattern.path}/`);
  if (!pathOk) return false;
  if (!pattern.search) return true;
  const params = new URLSearchParams(location.search);
  return Object.entries(pattern.search).every(([key, value]) => params.get(key) === value);
}

export interface Rect { top: number; left: number; width: number; height: number }
export type Side = "right" | "bottom" | "left" | "top" | "center";

/** Union of rectangles; null when there are none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const top = Math.min(...rects.map(rect => rect.top));
  const left = Math.min(...rects.map(rect => rect.left));
  const bottom = Math.max(...rects.map(rect => rect.top + rect.height));
  const right = Math.max(...rects.map(rect => rect.left + rect.width));
  return { top, left, width: right - left, height: bottom - top };
}

/**
 * Puts the guide card beside its target: the first side with room, in the
 * order a reader's eye travels, clamped inside the viewport. A target that
 * fills the screen (a whole page) gets the card in its bottom-right corner.
 */
export function placeCard(target: Rect | null, card: { width: number; height: number }, viewport: { width: number; height: number }, gap = 16): { top: number; left: number; side: Side } {
  const margin = 12;
  const clampLeft = (value: number) => Math.min(Math.max(margin, value), viewport.width - card.width - margin);
  const clampTop = (value: number) => Math.min(Math.max(margin, value), viewport.height - card.height - margin);
  if (target === null) return { top: clampTop((viewport.height - card.height) / 2), left: clampLeft((viewport.width - card.width) / 2), side: "center" };
  const room = {
    right: viewport.width - (target.left + target.width) - gap,
    bottom: viewport.height - (target.top + target.height) - gap,
    left: target.left - gap,
    top: target.top - gap,
  };
  if (room.right >= card.width + margin) return { side: "right", left: target.left + target.width + gap, top: clampTop(target.top + target.height / 2 - card.height / 2) };
  if (room.bottom >= card.height + margin) return { side: "bottom", top: target.top + target.height + gap, left: clampLeft(target.left + target.width / 2 - card.width / 2) };
  if (room.left >= card.width + margin) return { side: "left", left: target.left - gap - card.width, top: clampTop(target.top + target.height / 2 - card.height / 2) };
  if (room.top >= card.height + margin) return { side: "top", top: target.top - gap - card.height, left: clampLeft(target.left + target.width / 2 - card.width / 2) };
  return { side: "center", top: viewport.height - card.height - margin * 2, left: viewport.width - card.width - margin * 2 };
}

export interface TourProgress { step: number; active: boolean; completed: boolean; dismissed: boolean; tasksDone: number }
export const TOUR_STORAGE_KEY = "hydra.tour";
export const EMPTY_PROGRESS: TourProgress = { step: 0, active: false, completed: false, dismissed: false, tasksDone: 0 };

export function parseProgress(raw: string | null): TourProgress {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const value = JSON.parse(raw) as Partial<TourProgress>;
    const step = Number.isInteger(value.step) ? Math.min(Math.max(0, value.step!), TOUR_STEPS.length - 1) : 0;
    return { step, active: value.active === true, completed: value.completed === true, dismissed: value.dismissed === true, tasksDone: Number.isInteger(value.tasksDone) ? Math.max(0, value.tasksDone!) : 0 };
  } catch { return EMPTY_PROGRESS; }
}

/** Chapters whose every step lies behind `step`. */
export function chaptersDone(step: number, completed: boolean): ChapterId[] {
  if (completed) return CHAPTERS.map(chapter => chapter.id);
  return CHAPTERS.filter(chapter => { const steps = chapterSteps(chapter.id); return steps.length > 0 && steps.every(index => index < step); }).map(chapter => chapter.id);
}

/** Splits `**bold**` and `` `code` `` out of a step's copy; nothing else is interpreted. */
export function inlineMarks(text: string): Array<{ kind: "text" | "bold" | "code"; text: string }> {
  const parts: Array<{ kind: "text" | "bold" | "code"; text: string }> = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    parts.push(match[1] !== undefined ? { kind: "bold", text: match[1] } : { kind: "code", text: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

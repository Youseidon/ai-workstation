import type { DemoSeedProgress, DemoSeedStep, ProviderId } from "@hydra/shared";

export interface DemoStage {
  step: DemoSeedStep;
  title: string;
  verb: string;
  /** The head of the Hydra mark this stage wakes, if any. */
  head: ProviderId | null;
}

// Ten stages, six heads: a head wakes each time the demo gains something a
// visitor can actually open, so the mark is fully lit exactly when it is ready.
export const DEMO_STAGES: readonly DemoStage[] = [
  { step: "account", title: "Minting a demo identity", verb: "identity", head: null },
  { step: "runtime", title: "Waking a private runtime", verb: "runtime", head: null },
  { step: "folder", title: "Carving out a real folder", verb: "folder", head: "claude" },
  { step: "git", title: "Planting a Git history", verb: "git", head: null },
  { step: "workspace", title: "Registering the workspace", verb: "workspace", head: "codex" },
  { step: "library", title: "Writing the work plan", verb: "library", head: null },
  { step: "pipelines", title: "Laying pipeline track", verb: "pipelines", head: "cursor" },
  { step: "chats", title: "Replaying conversations", verb: "chats", head: "grok" },
  { step: "stations", title: "Running past pipeline stations", verb: "stations", head: "copilot" },
  { step: "settings", title: "Tuning the agents", verb: "settings", head: "kilocode" },
];

export const READY_TITLE = "Your Hydra is awake";

/** What a visitor gets, revealed as the stage that creates it lands. */
export const DEMO_MANIFEST: ReadonlyArray<{ step: DemoSeedStep; label: string; value: number }> = [
  { step: "folder", label: "files on disk", value: 11 },
  { step: "git", label: "commits", value: 5 },
  { step: "library", label: "work items", value: 6 },
  { step: "pipelines", label: "pipelines", value: 2 },
  { step: "chats", label: "conversations", value: 4 },
  { step: "stations", label: "agent runs", value: 9 },
];

/** The sample project's tree, shown filling in while the folder is written. */
export const DEMO_FILES = ["kettle/", "  index.html", "  styles.css", "  server.js", "  package.json", "  README.md", "  src/app.js", "  src/timer.js", "  src/brews.js", "  test/timer.test.js", "  AGENTS.md", "  .gitignore"] as const;

export function stageIndex(step: DemoSeedStep): number {
  return step === "ready" ? DEMO_STAGES.length : DEMO_STAGES.findIndex(stage => stage.step === step);
}

/** Heads lit once every stage up to and including `completed` has finished. */
export function litHeads(completed: ReadonlySet<DemoSeedStep>): ProviderId[] {
  return DEMO_STAGES.filter(stage => stage.head !== null && completed.has(stage.step)).map(stage => stage.head!) ;
}

/**
 * Splits a growing NDJSON buffer into parsed lines and the unfinished rest.
 * A malformed line is dropped rather than ending the launch: the final
 * `ready` line is the one that decides success.
 */
export function readProgressLines(buffer: string): { lines: DemoSeedProgress[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines: DemoSeedProgress[] = [];
  for (const part of parts) {
    if (part.trim() === "") continue;
    try {
      const value = JSON.parse(part) as Partial<DemoSeedProgress>;
      if (typeof value.step === "string" && (value.state === "active" || value.state === "done" || value.state === "error")) {
        lines.push({ step: value.step as DemoSeedStep, state: value.state, detail: typeof value.detail === "string" ? value.detail : "" });
      }
    } catch { /* skip a torn or foreign line */ }
  }
  return { lines, rest };
}

/**
 * The server prepares a demo in about a second. Each stage is held on screen
 * for a moment so a visitor can read what is being made for them; with
 * reduced motion the pacing nearly disappears.
 */
export function revealDelay(line: DemoSeedProgress, reducedMotion: boolean): number {
  if (line.state === "error") return 0;
  if (reducedMotion) return line.state === "done" ? 120 : 0;
  if (line.step === "ready") return 500;
  return line.state === "active" ? 260 : 520;
}

/** "23 h left", "40 min left": how long a demo account still exists. */
export function demoTimeLeft(expiresAt: string | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "expiring now";
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 120 ? `${Math.floor(minutes / 60)} h left` : `${minutes} min left`;
}

/** Session flag that tells the freshly loaded app to open the tour once. */
export const TOUR_AUTOSTART_KEY = "hydra.tour-autostart";

export interface LaunchLogLine { step: DemoSeedStep; text: string; tone: "active" | "done" }
export interface LaunchState {
  current: DemoSeedStep;
  completed: ReadonlySet<DemoSeedStep>;
  log: readonly LaunchLogLine[];
  username: string;
  folder: string;
  error: string | null;
  ready: boolean;
}

export const INITIAL_LAUNCH: LaunchState = { current: "account", completed: new Set(), log: [], username: "", folder: "", error: null, ready: false };

/** Folds one revealed progress line into what the launch screen shows. */
export function launchReducer(state: LaunchState, line: DemoSeedProgress): LaunchState {
  if (line.state === "error") return { ...state, error: line.detail || "The demo could not be prepared." };
  if (line.step === "ready") return { ...state, current: "ready", ready: true, completed: new Set(state.completed).add("ready") };
  const text = line.step === "account" ? `identity  ${line.detail}` : `${line.step.padEnd(9, " ")} ${line.detail}`;
  const tone = line.state === "done" ? "done" : "active";
  const existing = state.log.findIndex(entry => entry.step === line.step);
  return {
    ...state,
    current: line.step,
    username: line.step === "account" ? line.detail : state.username,
    folder: line.step === "folder" ? line.detail : state.folder,
    completed: line.state === "done" ? new Set(state.completed).add(line.step) : state.completed,
    log: existing >= 0 ? state.log.map((entry, index) => index === existing ? { step: line.step, text, tone } : entry) : [...state.log, { step: line.step, text, tone }],
  };
}

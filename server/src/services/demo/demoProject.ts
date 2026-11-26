// The sample project a demo account works in: "Kettle", a tiny tea timer.
// It is real code with real tests, so a visitor can open the folder, run
// `npm test`, and point a real agent at it. Each change below becomes a real
// commit whose diff the Changes page renders exactly like an agent's work.

export type ProjectFiles = Record<string, string>;

export const PROJECT_NAME = "kettle";

const AGENTS_MD = `# Kettle — working agreement

Kettle is a dependency-free tea timer: plain ES modules in \`src/\`, a static
page in \`index.html\`, and \`node:test\` suites in \`test/\`.

- Keep it dependency-free. No bundler, no framework.
- Logic lives in \`src/\` as pure functions; \`src/app.js\` only wires the DOM.
- Run \`npm test\` before you finish and report the result honestly.
- Times are whole seconds everywhere the user can see them.
`;

export const WORKSPACE_INSTRUCTIONS = AGENTS_MD;

export const INITIAL_FILES: ProjectFiles = {
  ".gitignore": `node_modules/
.DS_Store

# Written by the Hydra from the workspace record
/CLAUDE.md
/AGENTS.md
`,
  "package.json": `{
  "name": "kettle",
  "version": "0.3.0",
  "private": true,
  "description": "A tiny, dependency-free tea timer.",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "engines": { "node": ">=20" }
}
`,
  "README.md": `# Kettle ☕

A tiny tea timer. Pick a brew, press start, and Kettle tells you when your tea
is ready — no dependencies, no build step.

\`\`\`bash
npm start   # http://localhost:5173
npm test    # node:test suites
\`\`\`

This folder was created by the Hydra demo. It is a real Git repository:
everything on Hydra's **Changes** page is a real commit here.
`,
  "server.js": `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const root = new URL(".", import.meta.url).pathname;

createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^\\/+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(5173, () => console.log("Kettle is steeping on http://localhost:5173"));
`,
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kettle</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="kettle">
    <h1>Kettle</h1>
    <div class="brews" id="brews" role="radiogroup" aria-label="Tea"></div>
    <output class="clock" id="clock" aria-live="polite">0:00</output>
    <div class="controls">
      <button id="start" type="button">Start</button>
      <button id="reset" type="button">Reset</button>
    </div>
  </main>
  <script type="module" src="src/app.js"></script>
</body>
</html>
`,
  "styles.css": `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: #fdf8f0;
  color: #2b2118;
}

.kettle { text-align: center; }
.brews { display: flex; gap: 0.5rem; justify-content: center; }
.brews button[aria-checked="true"] { background: #2b2118; color: #fdf8f0; }
.clock { display: block; font-size: 5rem; font-variant-numeric: tabular-nums; margin: 1.5rem 0; }
button { font: inherit; padding: 0.5rem 1rem; border-radius: 999px; border: 1px solid currentColor; background: none; cursor: pointer; }
`,
  "src/brews.js": `export const BREWS = [
  { id: "green", name: "Green", seconds: 120, temperatureC: 80 },
  { id: "black", name: "Black", seconds: 240, temperatureC: 95 },
  { id: "white", name: "White", seconds: 180, temperatureC: 85 },
  { id: "herbal", name: "Herbal", seconds: 300, temperatureC: 100 },
];

export function brewById(id) {
  return BREWS.find((brew) => brew.id === id) ?? BREWS[0];
}
`,
  "src/timer.js": `export function formatRemaining(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return \`\${minutes}:\${String(rest).padStart(2, "0")}\`;
}

export function createTimer(totalSeconds, { now = () => Date.now() } = {}) {
  let startedAt = null;
  return {
    start() { startedAt = now(); },
    reset() { startedAt = null; },
    remaining() {
      if (startedAt === null) return totalSeconds;
      return Math.max(0, totalSeconds - (now() - startedAt) / 1000);
    },
    isDone() { return this.remaining() === 0; },
  };
}
`,
  "src/app.js": `import { BREWS, brewById } from "./brews.js";
import { createTimer, formatRemaining } from "./timer.js";

const clock = document.getElementById("clock");
const brews = document.getElementById("brews");
let brew = BREWS[0];
let timer = createTimer(brew.seconds);
let tick = null;

function render() {
  clock.textContent = formatRemaining(timer.remaining());
  if (timer.isDone()) { clearInterval(tick); clock.textContent = "Ready ☕"; }
}

for (const item of BREWS) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = item.name;
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(item === brew));
  button.onclick = () => {
    brew = brewById(item.id);
    timer = createTimer(brew.seconds);
    for (const other of brews.children) other.setAttribute("aria-checked", String(other === button));
    render();
  };
  brews.append(button);
}

document.getElementById("start").onclick = () => { timer.start(); clearInterval(tick); tick = setInterval(render, 250); };
document.getElementById("reset").onclick = () => { clearInterval(tick); timer.reset(); render(); };
render();
`,
  "test/timer.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { createTimer, formatRemaining } from "../src/timer.js";

test("formats whole minutes", () => {
  assert.equal(formatRemaining(120), "2:00");
});

test("counts down with the clock", () => {
  let clock = 0;
  const timer = createTimer(60, { now: () => clock });
  timer.start();
  clock = 15_000;
  assert.equal(timer.remaining(), 45);
});

test("never goes below zero", () => {
  let clock = 0;
  const timer = createTimer(5, { now: () => clock });
  timer.start();
  clock = 60_000;
  assert.equal(timer.remaining(), 0);
  assert.equal(timer.isDone(), true);
});
`,
};

/** A change an agent "made": the files it rewrote and the commit it left. */
export interface ProjectChange { subject: string; files: ProjectFiles }

const TIMER_WITH_PAUSE = `export function formatRemaining(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return \`\${minutes}:\${String(rest).padStart(2, "0")}\`;
}

export function createTimer(totalSeconds, { now = () => Date.now() } = {}) {
  let startedAt = null;
  let banked = 0;
  return {
    start() { if (startedAt === null) startedAt = now(); },
    pause() {
      if (startedAt === null) return;
      banked += (now() - startedAt) / 1000;
      startedAt = null;
    },
    reset() { startedAt = null; banked = 0; },
    isRunning() { return startedAt !== null; },
    remaining() {
      const running = startedAt === null ? 0 : (now() - startedAt) / 1000;
      return Math.max(0, totalSeconds - banked - running);
    },
    isDone() { return this.remaining() === 0; },
  };
}
`;

export const PAUSE_CHANGE: ProjectChange = {
  subject: "Add pause and resume to the timer",
  files: {
    "src/timer.js": TIMER_WITH_PAUSE,
    "src/app.js": INITIAL_FILES["src/app.js"]!.replace(
      `document.getElementById("start").onclick = () => { timer.start(); clearInterval(tick); tick = setInterval(render, 250); };`,
      `const startButton = document.getElementById("start");
startButton.onclick = () => {
  if (timer.isRunning()) {
    timer.pause();
    clearInterval(tick);
    startButton.textContent = "Resume";
    return;
  }
  timer.start();
  clearInterval(tick);
  tick = setInterval(render, 250);
  startButton.textContent = "Pause";
};`,
    ).replace(
      `document.getElementById("reset").onclick = () => { clearInterval(tick); timer.reset(); render(); };`,
      `document.getElementById("reset").onclick = () => { clearInterval(tick); timer.reset(); startButton.textContent = "Start"; render(); };`,
    ),
    "test/timer.test.js": `${INITIAL_FILES["test/timer.test.js"]!}
test("pausing banks the elapsed time", () => {
  let clock = 0;
  const timer = createTimer(60, { now: () => clock });
  timer.start();
  clock = 10_000;
  timer.pause();
  clock = 40_000;
  assert.equal(timer.remaining(), 50);
  timer.start();
  clock = 45_000;
  assert.equal(timer.remaining(), 45);
});
`,
  },
};

export const ROUNDING_CHANGE: ProjectChange = {
  subject: "Fix 1:60 when the remaining time has a fraction",
  files: {
    "src/timer.js": TIMER_WITH_PAUSE.replace(
      `export function formatRemaining(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);`,
      `// Round the total once, up, before splitting it: rounding only the seconds
// turned 119.6 into "1:60", and rounding down would show 0:00 while the tea
// still has most of a second to go.
export function formatRemaining(seconds) {
  const whole = Math.ceil(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;`,
    ),
    "test/timer.test.js": `${PAUSE_CHANGE.files["test/timer.test.js"]!}
test("never shows sixty seconds", () => {
  assert.equal(formatRemaining(119.6), "2:00");
  assert.equal(formatRemaining(59.2), "1:00");
  assert.equal(formatRemaining(0.4), "0:01");
});
`,
  },
};

export const PRESETS_CHANGE: ProjectChange = {
  subject: "Add oolong and rooibos presets",
  files: {
    "src/brews.js": INITIAL_FILES["src/brews.js"]!.replace(
      `  { id: "herbal", name: "Herbal", seconds: 300, temperatureC: 100 },`,
      `  { id: "oolong", name: "Oolong", seconds: 210, temperatureC: 90 },
  { id: "rooibos", name: "Rooibos", seconds: 360, temperatureC: 100 },
  { id: "herbal", name: "Herbal", seconds: 300, temperatureC: 100 },`,
    ),
    "test/brews.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { BREWS, brewById } from "../src/brews.js";

test("every brew has a unique id and a sane steep time", () => {
  assert.equal(new Set(BREWS.map((brew) => brew.id)).size, BREWS.length);
  for (const brew of BREWS) assert.ok(brew.seconds >= 60 && brew.seconds <= 600, brew.id);
});

test("unknown ids fall back to the first brew", () => {
  assert.equal(brewById("espresso").id, BREWS[0].id);
});
`,
  },
};

export const DARK_MODE_CHANGE: ProjectChange = {
  subject: "Follow the system colour scheme",
  files: {
    "styles.css": INITIAL_FILES["styles.css"]!.replace(
      `body {
  margin: 0;`,
      `:root {
  color-scheme: light dark;
  --paper: #fdf8f0;
  --ink: #2b2118;
}

@media (prefers-color-scheme: dark) {
  :root { --paper: #1b1612; --ink: #f3e9dc; }
}

body {
  margin: 0;`,
    ).replace("  background: #fdf8f0;\n  color: #2b2118;", "  background: var(--paper);\n  color: var(--ink);")
      .replace(`.brews button[aria-checked="true"] { background: #2b2118; color: #fdf8f0; }`, `.brews button[aria-checked="true"] { background: var(--ink); color: var(--paper); }`),
  },
};

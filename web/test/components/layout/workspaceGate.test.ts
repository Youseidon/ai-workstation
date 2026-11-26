import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceStatus } from "../../../contexts/workspaceContext";

type State = { status: WorkspaceStatus; workspace: { id: number } | null; error?: string };
type Fixture = {
  WorkspaceGate: ComponentType<{ children: ReactNode }>;
  ToastProvider: ComponentType<{ children: ReactNode }>;
};

// Substitute only the workspace hook; render the real gate and UI with React.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const bundle = buildSync({
  stdin: {
    contents: `
      export { WorkspaceGate } from "./components/layout/WorkspaceGate";
      export { ToastProvider } from "./components/ui/Toast";
    `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  tsconfig: `${root}/tsconfig.json`,
  external: ["react", "react/*", "react-dom", "react-dom/*", "@/contexts/workspaceContext"],
  write: false,
});
const code = bundle.outputFiles[0]?.text;
assert.ok(code);
const require = createRequire(import.meta.url);
let state: State;
const fixtureModule = { exports: {} as Fixture };
new Function("require", "module", "exports", code)((id: string) =>
  id === "@/contexts/workspaceContext"
    ? { useWorkspace: () => ({ ...state, refresh: async () => {} }) }
    : require(id), fixtureModule, fixtureModule.exports);
const { WorkspaceGate, ToastProvider } = fixtureModule.exports;

function render(next: State) {
  state = next;
  let mounted = false;
  function App() {
    mounted = true;
    return createElement("textarea", { placeholder: "Write a prompt" });
  }
  const html = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(WorkspaceGate, null, createElement(App))));
  return { html, mounted };
}

test("startup and workspace errors never mount app controls, even with stale workspace data", () => {
  for (const workspace of [null, { id: 1 }]) {
    const loading = render({ status: "loading", workspace });
    assert.equal(loading.mounted, false);
    assert.match(loading.html, /Loading your workspaces/);
    const failed = render({ status: "error", workspace, error: "Server unavailable" });
    assert.equal(failed.mounted, false);
    assert.match(failed.html, /Server unavailable/);
    assert.match(failed.html, /Try again/);
    assert.doesNotMatch(failed.html, /Create workspace|textarea/);
  }
});

test("empty accounts can create a workspace but cannot use the app until one is selected", () => {
  for (const status of ["empty", "ready"] as const) {
    const blocked = render({ status, workspace: null });
    assert.equal(blocked.mounted, false);
    assert.match(blocked.html, /Specify your workspace first/);
    assert.match(blocked.html, /Create workspace/);
    assert.doesNotMatch(blocked.html, /textarea/);
  }
  const ready = render({ status: "ready", workspace: { id: 1 } });
  assert.equal(ready.mounted, true);
  assert.match(ready.html, /Write a prompt/);
  assert.doesNotMatch(ready.html, /Create workspace/);
  assert.equal(render({ status: "empty", workspace: null }).mounted, false);
});

test("the root layout gates the shell and every route together", () => {
  const layout = readFileSync(`${root}/app/layout.tsx`, "utf8");
  assert.match(layout, /<WorkspaceGate>\s*<AppShell>\{children\}<\/AppShell>\s*<\/WorkspaceGate>/);
});

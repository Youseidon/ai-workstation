import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = new URL("../../..", import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}
const sources = [...files("app"), ...files("components"), ...files("lib"), ...files("features"), ...files("contexts"), ...files("hooks"), ...files("api")].filter((path) => !path.endsWith(".css"));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const offenders = (pattern: RegExp, allowed: (path: string) => boolean = () => false) =>
  sources.filter((path) => !allowed(path) && pattern.test(read(path))).map((path) => relative(root, join(root, path)));

test("the legacy shell is gone and nothing imports it", () => {
  for (const path of ["components/layout/TopBar.tsx", "components/layout/Sidebar.tsx", "components/layout/chrome.tsx", "components/layout/PageFrame.tsx", "components/AgentDock.tsx", "features/chat/components/ThreadSidebar.tsx"]) {
    assert.equal(existsSync(join(root, path)), false, `${path} should stay deleted`);
  }
  assert.deepEqual(offenders(/from "@\/components\/(layout\/(TopBar|Sidebar|chrome|PageFrame)|AgentDock|chat\/ThreadSidebar)"/), []);
  assert.deepEqual(offenders(/\bPageChrome\b|\bAPP_LINKS\b/), []);
});

test("the shell and signed-out login screen own their main landmarks", () => {
  assert.deepEqual(offenders(/<main[\s>]/, (path) => path === "components/layout/AppShell.tsx" || path === "contexts/identity.tsx"), []);
});

test("the shell has one layout path for every route", () => {
  const shell = read("components/layout/AppShell.tsx");
  assert.doesNotMatch(shell, /pathname\s*===\s*"\/"/, "no Chat-versus-other-pages branch");
  assert.match(shell, /<AppSidebar /);
  assert.equal((shell.match(/<main /g) ?? []).length, 1);
});

test("routes do not install their own sidebars, rails or page overlays", () => {
  assert.deepEqual(offenders(/<aside[\s>]/, (path) => path.startsWith("components/layout/")), []);
  assert.deepEqual(offenders(/\bfixed (inset|right-|left-|top-|bottom-)/, (path) => path.startsWith("components/layout/") || path.startsWith("components/ui/")), []);
});

test("one navigation registry and one sidebar collapse preference", () => {
  assert.deepEqual(offenders(/href: "\/(pipeline|activity|changes|report|agents|workspaces)",\n\s+label:/, (path) => path === "lib/navigation.tsx"), []);
  assert.deepEqual(offenders(/sidebar-collapsed/, (path) => path === "components/layout/AppSidebar.tsx"), []);
});

test("one application type scale and opaque surfaces", () => {
  const css = read("app/globals.css");
  assert.match(css, /font-size: 16px;/, "the root scale is 16px");
  assert.doesNotMatch(css, /--chat-font-size:\s*calc\(/, "Chat does not compensate for a different root scale");
  assert.doesNotMatch(css, /backdrop-filter|body::before/, "no blur or decorative backdrop");
  assert.deepEqual(offenders(/text-\[[0-9.]+px\]/), [], "fixed-pixel text sizes bypass the scale");
  assert.deepEqual(offenders(/backdrop-blur|\bbg-surface-[0-9]\/[0-9]+/), [], "surfaces stay opaque");
});

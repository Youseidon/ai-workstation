import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SuiteProgressMark } from "../../../features/pipeline/components/SuiteProgressMark.tsx";
import type { SuiteProgress } from "../../../features/pipeline/lib/progress.ts";

const settled: SuiteProgress = { known: true, done: 2, total: 2, skipped: 1, attention: 0, complete: true };
function render(progress: SuiteProgress, running = false) {
  return renderToStaticMarkup(createElement(SuiteProgressMark, { progress, running, index: 0 }));
}

test("completion is a read-only outcome, separate from membership and selection controls", () => {
  const complete = render(settled);
  assert.match(complete, /role="img"/);
  assert.match(complete, /aria-label="Complete"/);
  assert.match(complete, /1 skipped/);
  assert.doesNotMatch(complete, /<button|<input|aria-pressed|aria-checked|aria-current/);
  const reset = render({ ...settled, done: 1, complete: false });
  assert.doesNotMatch(reset, /aria-label="Complete"|✓/);
  const unknown = render({ ...settled, known: false, complete: false });
  assert.match(unknown, /aria-label="Progress unavailable"/);
  assert.doesNotMatch(unknown, /✓/);
});

test("running and attention indicators remain distinct from a settled outcome", () => {
  assert.match(render(settled, true), /aria-label="Running"/);
  assert.doesNotMatch(render(settled, true), /✓/);
  const attention = render({ ...settled, attention: 1, complete: false });
  assert.match(attention, /aria-label="1 need attention"/);
  assert.doesNotMatch(attention, /✓/);
  assert.match(render({ ...settled, attention: 1, complete: false }, true), /aria-label="Running · 1 need attention"/);
});

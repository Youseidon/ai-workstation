import assert from "node:assert/strict";
import test from "node:test";
import { CHAPTERS, TOUR_STEPS, chapterSteps, chaptersDone, firstStepOf, inlineMarks, locationMatches, parseProgress, placeCard, stepBody, unionRect } from "../../../features/tour/lib/tour";

test("every chapter has steps, a distinct head, and the tour walks them in order", () => {
  assert.equal(new Set(CHAPTERS.map(chapter => chapter.head)).size, CHAPTERS.length);
  let previous = -1;
  for (const chapter of CHAPTERS) {
    const steps = chapterSteps(chapter.id);
    assert.ok(steps.length > 0, chapter.id);
    assert.ok(steps[0]! > previous, `${chapter.id} comes after the chapter before it`);
    assert.deepEqual(steps, Array.from({ length: steps.length }, (_, index) => steps[0]! + index), `${chapter.id} is contiguous`);
    previous = steps.at(-1)!;
  }
  assert.equal(new Set(TOUR_STEPS.map(step => step.id)).size, TOUR_STEPS.length);
});

test("steps that live on a page say how to get there", () => {
  for (const step of TOUR_STEPS) if (step.route) assert.ok(step.href, `${step.id} needs an href`);
});

test("copy adapts to demo accounts and never shows a missing path", () => {
  const workspace = TOUR_STEPS.find(step => step.id === "workspace")!;
  assert.match(stepBody(workspace, { demo: true, workspaceName: "Kettle", workDirectory: "/home/u/hydra-demo/x/kettle" }), /\/home\/u\/hydra-demo\/x\/kettle/);
  assert.doesNotMatch(stepBody(workspace, { demo: false, workspaceName: null, workDirectory: null }), /null|undefined/);
});

test("routes match exactly, by prefix, below a folder, and by query", () => {
  assert.ok(locationMatches({ path: "/" }, { pathname: "/", search: "?workspace=1" }));
  assert.ok(!locationMatches({ path: "/" }, { pathname: "/pipeline", search: "" }));
  assert.ok(locationMatches({ path: "/pipeline", prefix: true }, { pathname: "/pipeline/open", search: "" }));
  assert.ok(!locationMatches({ path: "/pipeline", prefix: true }, { pathname: "/pipelines", search: "" }));
  assert.ok(locationMatches({ path: "/changes/", prefix: true }, { pathname: "/changes/run_1", search: "" }));
  assert.ok(!locationMatches({ path: "/changes/", prefix: true }, { pathname: "/changes", search: "" }));
  assert.ok(locationMatches({ path: "/agents", search: { view: "configuration" } }, { pathname: "/agents", search: "?view=configuration&x=1" }));
  assert.ok(!locationMatches({ path: "/agents", search: { view: "configuration" } }, { pathname: "/agents", search: "" }));
});

test("the card sits beside its target, and centres when there is none", () => {
  const viewport = { width: 1400, height: 900 };
  const card = { width: 360, height: 240 };
  assert.equal(placeCard({ top: 100, left: 20, width: 260, height: 40 }, card, viewport).side, "right");
  assert.equal(placeCard({ top: 100, left: 1100, width: 280, height: 40 }, card, viewport).side, "bottom");
  assert.equal(placeCard({ top: 700, left: 1100, width: 280, height: 180 }, card, viewport).side, "left");
  const centred = placeCard(null, card, viewport);
  assert.deepEqual(centred, { side: "center", top: 330, left: 520 });
  const clamped = placeCard({ top: 880, left: 20, width: 200, height: 10 }, card, viewport);
  assert.ok(clamped.top + card.height <= viewport.height);
});

test("rect unions cover every part", () => {
  assert.deepEqual(unionRect([{ top: 10, left: 10, width: 10, height: 10 }, { top: 40, left: 0, width: 5, height: 5 }]), { top: 10, left: 0, width: 20, height: 35 });
  assert.equal(unionRect([]), null);
});

test("stored progress is validated and chapters count as done once passed", () => {
  assert.deepEqual(parseProgress("{bad"), { step: 0, active: false, completed: false, dismissed: false, tasksDone: 0 });
  assert.equal(parseProgress(JSON.stringify({ step: 9999 })).step, TOUR_STEPS.length - 1);
  assert.deepEqual(chaptersDone(firstStepOf("pipeline"), false), ["bearings", "chat"]);
  assert.equal(chaptersDone(0, true).length, CHAPTERS.length);
});

test("only bold and code are interpreted in tour copy", () => {
  assert.deepEqual(inlineMarks("Press **Ask** in `src/<b>`"), [
    { kind: "text", text: "Press " }, { kind: "bold", text: "Ask" }, { kind: "text", text: " in " }, { kind: "code", text: "src/<b>" },
  ]);
});

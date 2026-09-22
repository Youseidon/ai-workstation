import assert from "node:assert/strict";
import test from "node:test";
import { applyRevisionChanges, diffProgramRevision } from "../src/programRevision";
import { canApplyProgramDraft, normalizeProgramDraftBody, type ProgramDraftBody } from "../src/programDraft";

const VERIFY = "Do it.\n\n## Verify\n\n```sh\nnpm test\n```\n";

/** Normalized, as the server builds it: a baseline is always what a save would store. */
function baseline(): ProgramDraftBody {
  const normalized = normalizeProgramDraftBody(rawBaseline(), { revision: true });
  assert.ok(normalized.ok);
  return normalized.ok ? normalized.value : rawBaseline();
}

function rawBaseline(): ProgramDraftBody {
  return {
    name: "Backend transition",
    overview: "Move the API.",
    notes: "",
    suites: [
      {
        key: "S1", name: "Foundations", overview: "", filled: true, sourceId: 10,
        prompts: [
          { key: "BT-01", title: "Middleware", content: VERIFY, dependsOn: [], gate: null, sourceId: 100 },
          { key: "BT-02", title: "Route handlers", content: VERIFY, dependsOn: ["BT-01"], gate: null, sourceId: 101 },
        ],
      },
      {
        key: "S2", name: "Endpoints", overview: "", filled: true, sourceId: 11,
        prompts: [{ key: "BT-03", title: "Users endpoint", content: VERIFY, dependsOn: ["BT-02"], gate: null, sourceId: 102 }],
      },
    ],
  };
}

function revise(body: ProgramDraftBody, changes: unknown[]) {
  const result = applyRevisionChanges(body, { changes });
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}

test("an untouched revision has no changes", () => {
  assert.deepEqual(diffProgramRevision(baseline(), baseline()), []);
});

test("replace-text edits every matching item and nothing else", () => {
  const body = baseline();
  body.suites[1]!.prompts[0]!.content = "No verify here.";
  const { body: next, applied } = revise(body, [{ op: "replace-text", find: "npm test", replace: "npm test && npm run lint" }]);
  assert.match(applied[0]!, /2 occurrence\(s\) in BT-01, BT-02/);
  assert.equal(next.suites[1]!.prompts[0]!.content, "No verify here.");
  const diff = diffProgramRevision(body, next);
  assert.deepEqual(diff.map((change) => `${change.kind}:${change.key}`), ["changed:BT-01", "changed:BT-02"]);
});

test("a replace that matches nothing is refused, so the agent hears about it", () => {
  const result = applyRevisionChanges(baseline(), { changes: [{ op: "replace-text", find: "pnpm", replace: "npm" }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors["changes[0]"]!, /not found/);
});

test("changes are all or nothing, and the refusal names its index", () => {
  const body = baseline();
  const result = applyRevisionChanges(body, {
    changes: [
      { op: "update-item", item: "BT-01", title: "Request-id middleware" },
      { op: "update-item", item: "BT-99", title: "Nope" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok("changes[1]" in result.errors);
  assert.equal(body.suites[0]!.prompts[0]!.title, "Middleware");
});

test("an added item gets a fresh key that later changes can depend on", () => {
  const { body } = revise(baseline(), [
    { op: "add-item", suite: "S2", title: "Orders endpoint", content: VERIFY, after: "BT-03" },
    { op: "update-item", item: "S2-02", dependsOn: ["BT-03"] },
  ]);
  const added = body.suites[1]!.prompts[1]!;
  assert.equal(added.key, "S2-02");
  assert.equal(added.sourceId, null);
  assert.deepEqual(added.dependsOn, ["BT-03"]);
  const diff = diffProgramRevision(baseline(), body);
  assert.deepEqual(diff.map((change) => `${change.kind}:${change.key}`), ["added:S2-02"]);
});

test("removing an item drops the dependencies that pointed at it", () => {
  const { body } = revise(baseline(), [{ op: "remove-item", item: "BT-02" }]);
  assert.deepEqual(body.suites[1]!.prompts[0]!.dependsOn, []);
  const kinds = diffProgramRevision(baseline(), body).map((change) => `${change.kind}:${change.key}`);
  assert.deepEqual(kinds.sort(), ["changed:BT-03", "removed:BT-02"]);
});

test("a move keeps identity, so it reads as a move and not a removal", () => {
  const { body } = revise(baseline(), [{ op: "move-item", item: "BT-02", suite: "Endpoints", after: null }]);
  assert.deepEqual(body.suites[1]!.prompts.map((prompt) => prompt.key), ["BT-02", "BT-03"]);
  const diff = diffProgramRevision(baseline(), body);
  assert.deepEqual(diff.map((change) => `${change.kind}:${change.key}`), ["moved:BT-02"]);
});

test("a title clash inside a suite is refused", () => {
  const result = applyRevisionChanges(baseline(), { changes: [{ op: "update-item", item: "BT-02", title: "middleware" }] });
  assert.equal(result.ok, false);
});

test("a suite can be added, filled, and moved first", () => {
  const { body } = revise(baseline(), [
    { op: "add-suite", name: "Preparation", overview: "Before anything." },
    { op: "add-item", suite: "Preparation", title: "Inventory", content: VERIFY },
    { op: "move-suite", suite: "Preparation", after: null },
  ]);
  assert.deepEqual(body.suites.map((suite) => suite.name), ["Preparation", "Foundations", "Endpoints"]);
  assert.ok(canApplyProgramDraft(body));
  const diff = diffProgramRevision(baseline(), body);
  assert.deepEqual(diff.map((change) => `${change.scope}:${change.kind}`), ["suite:added", "item:added"]);
});

test("a revision body keeps its keys and identities through an operator save", () => {
  const body = baseline();
  body.suites[0]!.prompts.splice(0, 1);
  const saved = normalizeProgramDraftBody(body, { revision: true });
  assert.ok(saved.ok);
  if (!saved.ok) return;
  assert.deepEqual(saved.value.suites[0]!.prompts.map((prompt) => [prompt.key, prompt.sourceId]), [["BT-02", 101]]);
  const clash = normalizeProgramDraftBody({
    ...body,
    suites: [{ ...body.suites[0]!, prompts: [body.suites[0]!.prompts[0]!, { ...body.suites[0]!.prompts[0]!, title: "Other" }] }],
  }, { revision: true });
  assert.ok(clash.ok);
  if (clash.ok) assert.equal(new Set(clash.value.suites[0]!.prompts.map((prompt) => prompt.key)).size, 2);
});

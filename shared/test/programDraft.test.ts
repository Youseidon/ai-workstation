/**
 * The pure half of agent-authored programs: what a proposal must look like
 * before anything is stored, and what the operator is shown about it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_MAX_SUITES,
  bodyFromProgramProposal,
  canApplyProgramDraft,
  emptyProgramDraftBody,
  normalizeProgramDraftBody,
  normalizeProgramProposal,
  normalizeSuiteProposal,
  programDraftIssues,
  programDraftPreview,
  programKeyFrom,
  resolvedDependencies,
  withSuiteProposal,
} from "../src/index";
import type { ProgramDraftBody } from "../src/index";

function openDraft(): ProgramDraftBody {
  const proposal = normalizeProgramProposal({
    name: "Backend transition",
    overview: "Move the API off the legacy host.",
    suites: [{ name: "Foundations" }, { name: "Endpoints" }],
  });
  assert.equal(proposal.ok, true);
  return bodyFromProgramProposal(proposal.ok ? proposal.value : (() => { throw new Error("unreachable"); })());
}

test("a program proposal assigns suite keys in the order they were posted", () => {
  const body = openDraft();
  assert.deepEqual(body.suites.map((suite) => suite.key), ["S1", "S2"]);
  assert.deepEqual(body.suites.map((suite) => suite.filled), [false, false]);
});

test("a program with no name, no suites, or too many suites is refused", () => {
  assert.equal(normalizeProgramProposal({ suites: [{ name: "A" }] }).ok, false);
  assert.equal(normalizeProgramProposal({ name: "P", suites: [] }).ok, false);
  assert.equal(
    normalizeProgramProposal({ name: "P", suites: Array.from({ length: DRAFT_MAX_SUITES + 1 }, (_, i) => ({ name: `S${i}` })) }).ok,
    false,
  );
});

test("two suites cannot share a name", () => {
  const result = normalizeProgramProposal({ name: "P", suites: [{ name: "Same" }, { name: "same" }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok("suites[1].name" in result.errors);
});

test("a suite proposal is addressed by key or by name, and numbers its work items", () => {
  const body = openDraft();
  const byKey = normalizeSuiteProposal({ suite: "S2", prompts: [{ title: "One", content: "do it" }] }, body);
  assert.equal(byKey.ok, true);
  if (byKey.ok) assert.equal(byKey.value.suiteKey, "S2");
  const byName = normalizeSuiteProposal({ suite: "foundations", prompts: [{ title: "One", content: "do it" }] }, body);
  assert.equal(byName.ok, true);
  if (byName.ok) assert.equal(byName.value.suiteKey, "S1");

  const filled = byName.ok ? withSuiteProposal(body, byName.value) : body;
  assert.deepEqual(filled.suites[0]!.prompts.map((prompt) => prompt.key), ["S1-01"]);
  assert.equal(filled.suites[0]!.filled, true);
  assert.equal(filled.suites[1]!.filled, false);
});

test("a suite that is not in the draft is refused by name, with the known keys", () => {
  const result = normalizeSuiteProposal({ suite: "S9", prompts: [{ title: "One", content: "x" }] }, openDraft());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.suite!, /S1 \(Foundations\)/);
});

test("re-posting a suite replaces its work items rather than appending", () => {
  let body = openDraft();
  const first = normalizeSuiteProposal({ suite: "S1", prompts: [{ title: "One", content: "a" }, { title: "Two", content: "b" }] }, body);
  assert.equal(first.ok, true);
  if (first.ok) body = withSuiteProposal(body, first.value);
  const second = normalizeSuiteProposal({ suite: "S1", prompts: [{ title: "Only", content: "c" }] }, body);
  assert.equal(second.ok, true);
  if (second.ok) body = withSuiteProposal(body, second.value);
  assert.deepEqual(body.suites[0]!.prompts.map((prompt) => prompt.title), ["Only"]);
  assert.deepEqual(body.suites[0]!.prompts.map((prompt) => prompt.key), ["S1-01"]);
});

test("two work items in one suite cannot share a title, and a work item needs instructions", () => {
  const body = openDraft();
  const duplicate = normalizeSuiteProposal({ suite: "S1", prompts: [{ title: "Same", content: "a" }, { title: "same", content: "b" }] }, body);
  assert.equal(duplicate.ok, false);
  const empty = normalizeSuiteProposal({ suite: "S1", prompts: [{ title: "T", content: "  " }] }, body);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok("prompts[0].content" in empty.errors);
});

test("a dependency on a work item that is not in the draft is reported, not silently dropped", () => {
  let body = openDraft();
  for (const suite of ["S1", "S2"]) {
    const proposal = normalizeSuiteProposal({
      suite,
      prompts: [{ title: `${suite} work`, content: "do it", dependsOn: suite === "S2" ? ["S1-01", "S7-04"] : [] }],
    }, body);
    assert.equal(proposal.ok, true);
    if (proposal.ok) body = withSuiteProposal(body, proposal.value);
  }
  assert.deepEqual(resolvedDependencies(body), [{ promptKey: "S2-01", dependsOnKey: "S1-01" }]);
  assert.ok(programDraftIssues(body).some((issue) => issue.includes("S7-04")));
  // It is only a warning: the draft is still applicable, minus that edge.
  assert.equal(canApplyProgramDraft(body), true);
});

test("a suite with no work items blocks an apply and says so", () => {
  let body = openDraft();
  const proposal = normalizeSuiteProposal({ suite: "S1", prompts: [{ title: "One", content: "x" }] }, body);
  if (proposal.ok) body = withSuiteProposal(body, proposal.value);
  assert.equal(canApplyProgramDraft(body), false);
  assert.ok(programDraftIssues(body).some((issue) => issue.startsWith("S2 (Endpoints) has no work items")));
});

test("the preview counts what an apply will actually create", () => {
  let body = openDraft();
  const withVerify = "Do the thing.\n\n## Verify\n\n```sh\nnpm test\n```\n";
  for (const suite of ["S1", "S2"]) {
    const proposal = normalizeSuiteProposal({
      suite,
      prompts: [
        { title: `${suite} a`, content: withVerify },
        { title: `${suite} b`, content: "prose only", dependsOn: [`${suite}-01`], gate: { name: "Gate", description: "why" } },
      ],
    }, body);
    if (proposal.ok) body = withSuiteProposal(body, proposal.value);
  }
  const preview = programDraftPreview(body);
  assert.equal(preview.suites, 2);
  assert.equal(preview.filledSuites, 2);
  assert.equal(preview.prompts, 4);
  assert.equal(preview.dependencies, 2);
  assert.equal(preview.gates, 2);
  assert.equal(preview.verifiable, 2);
  assert.deepEqual(preview.issues, []);
});

test("an operator's edit renumbers keys, so a deletion cannot leave a gap", () => {
  const result = normalizeProgramDraftBody({
    name: "Edited",
    suites: [{ name: "Only", prompts: [{ title: "Second", content: "b" }, { title: "Third", content: "c" }] }],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.suites[0]!.prompts.map((prompt) => prompt.key), ["S1-01", "S1-02"]);
    assert.deepEqual(result.value.suites[0]!.prompts.map((prompt) => prompt.title), ["Second", "Third"]);
  }
});

test("an empty draft is not applicable and says nothing misleading", () => {
  const body = emptyProgramDraftBody();
  assert.equal(canApplyProgramDraft(body), false);
  assert.deepEqual(programDraftPreview(body).prompts, 0);
});

test("a program key is derived from the name and never collides", () => {
  assert.equal(programKeyFrom("Backend transition", []), "BT");
  assert.equal(programKeyFrom("Migration", []), "MIGRATION");
  assert.equal(programKeyFrom("Backend transition", ["BT"]), "BT2");
  assert.equal(programKeyFrom("Backend transition", ["BT", "BT2"]), "BT3");
  assert.equal(programKeyFrom("!!!", []), "PROGRAM");
});

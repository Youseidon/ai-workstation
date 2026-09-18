import assert from "node:assert/strict";
import test from "node:test";
import { agentRequestModeBlock, allowedAgentRequestModes, diffLineCounts, diffLines, normalizeAgentRequest } from "../src/agentRequest";

test("each target offers only the modes that mean something for it", () => {
  assert.deepEqual(allowedAgentRequestModes({ kind: "workspace" }), ["ask"]);
  assert.deepEqual(allowedAgentRequestModes({ kind: "instructions", field: "claudeMd" }), ["ask", "change", "edit"]);
  assert.deepEqual(allowedAgentRequestModes({ kind: "program", programId: 1 }), ["ask", "change", "edit"]);
  assert.deepEqual(allowedAgentRequestModes({ kind: "new-program" }), ["draft", "edit"]);
  assert.match(agentRequestModeBlock({ kind: "new-program" }, "ask") ?? "", /Draft/);
});

test("a request is parsed, trimmed, and refused field by field", () => {
  const ok = normalizeAgentRequest({ target: { kind: "program", programId: 3, suiteId: 4 }, mode: "change", text: "  add lint  ", provider: "codex" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.text, "add lint");
    assert.deepEqual(ok.value.target, { kind: "program", programId: 3, suiteId: 4, promptId: null });
  }

  const bad = normalizeAgentRequest({ target: { kind: "instructions", field: "README" }, mode: "ask", text: "" });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.target);
    assert.ok(bad.errors.text);
    assert.ok(bad.errors.provider, "every mode but edit needs an agent");
  }

  const edit = normalizeAgentRequest({ target: { kind: "new-program" }, mode: "edit", text: "plan" });
  assert.ok(edit.ok, "edit needs no agent");
});

test("the line diff marks only what changed", () => {
  const lines = diffLines("# Rules\n- one\n- two\n- three\n", "# Rules\n- one\n- 2\n- three\n- four\n");
  assert.deepEqual(lines, [
    { kind: "same", text: "# Rules" },
    { kind: "same", text: "- one" },
    { kind: "removed", text: "- two" },
    { kind: "added", text: "- 2" },
    { kind: "same", text: "- three" },
    { kind: "added", text: "- four" },
  ]);
  assert.deepEqual(diffLineCounts(lines), { added: 2, removed: 1 });
  assert.deepEqual(diffLines("", "a"), [{ kind: "added", text: "a" }]);
  assert.deepEqual(diffLines("same", "same"), [{ kind: "same", text: "same" }]);
});

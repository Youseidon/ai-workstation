import assert from "node:assert/strict";
import test from "node:test";
import { legacyTarget } from "../../lib/legacyRedirect";

test("legacy redirects keep every query parameter", () => {
  assert.equal(legacyTarget("/activity", { run: "abc", workspace: "2" }), "/activity?run=abc&workspace=2");
  assert.equal(legacyTarget("/agents", {}), "/agents");
  assert.equal(legacyTarget("/pipeline/open", { tag: ["a", "b"] }), "/pipeline/open?tag=a&tag=b");
});

test("implied defaults never override what the link carried", () => {
  assert.equal(legacyTarget("/pipeline/open", { prompt: "7" }, { filter: "attention" }), "/pipeline/open?filter=attention&prompt=7");
  assert.equal(legacyTarget("/pipeline/open", { filter: "working" }, { filter: "attention" }), "/pipeline/open?filter=working");
});

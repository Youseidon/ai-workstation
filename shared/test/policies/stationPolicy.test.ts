import assert from "node:assert/strict";
import test from "node:test";
import { resolveStationPolicy, validateStationPolicy } from "../../src/policies/stationPolicy.ts";

test("legacy explicit verification prohibition resolves to a structured handoff", () => {
  assert.deepEqual(resolveStationPolicy("No verification execution in this station. Completion evidence goes to S6-11."), {
    version: 1, editFiles: true, build: true, generateContracts: true, verification: "deferred", verifier: "S6-11",
  });
  assert.equal(resolveStationPolicy("Implement the verification widget").verification, "allowed");
});

test("explicit station capabilities are validated and override legacy prose", () => {
  const policy = { ...resolveStationPolicy(""), build: false, verification: "deferred" as const, verifier: "Verify" };
  assert.deepEqual(resolveStationPolicy("", policy), policy);
  for (const invalid of [{ ...policy, build: "false" }, { ...policy, version: 2 }, { ...policy, unknown: true }, { ...policy, verification: "maybe" }])
    assert.throws(() => validateStationPolicy(invalid));
});

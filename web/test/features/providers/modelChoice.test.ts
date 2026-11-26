import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderInfo } from "@hydra/shared";
import { modelChoice } from "../../../features/providers/lib/modelChoice.ts";

const provider = {
  id: "codex",
  model: "gpt-5.1-codex-mini",
  configuredModel: "gpt-5.4-pro",
  modelSelectionMode: "manual",
  modelAccessTier: "efficient",
  reasoningEffort: "medium",
  models: [{ id: "gpt-5.1-codex-mini" }],
} as ProviderInfo;

test("out-of-tier pins stay configured while the effective server default runs", () => {
  const result = modelChoice(provider, "gpt-5.4-pro");
  assert.deepEqual(result, {
    saved: true,
    active: false,
    configured: "gpt-5.4-pro",
    effective: provider.model,
  });
  assert.equal(
    modelChoice({ ...provider, modelAccessTier: "all" }, result.configured)
      .effective,
    "gpt-5.4-pro",
  );
});
test("Auto Select locks and preserves eligible, custom and null browser pins", () => {
  for (const pin of ["gpt-5.1-codex-mini", "custom", null]) {
    const result = modelChoice(
      { ...provider, modelSelectionMode: "auto", modelAccessTier: "all" },
      pin,
    );
    assert.equal(result.configured, pin);
    assert.equal(result.saved, true);
    assert.equal(result.active, false);
    assert.equal(result.effective, provider.model);
  }
});
test("an absent pin and explicit null follow the server default without losing the saved null choice", () => {
  assert.equal(modelChoice(provider, undefined).saved, false);
  assert.equal(
    modelChoice({ ...provider, modelAccessTier: "all" }, null).effective,
    provider.model,
  );
  assert.equal(modelChoice(provider, null).effective, provider.model);
  assert.equal(modelChoice(provider, "gpt-5.1-codex-mini").active, true);
});
test("Cursor variants follow effective effort and restore a preserved pin when effort changes", () => {
  const cursor = {
    ...provider,
    id: "cursor",
    modelAccessTier: "all",
    model: "gpt-5.3-codex-high",
    reasoningEffort: "high",
    models: [{ id: "gpt-5.3-codex-high" }],
  } as ProviderInfo;
  const low = "gpt-5.3-codex-low";
  assert.equal(modelChoice(cursor, low).active, false);
  assert.equal(
    modelChoice(
      {
        ...cursor,
        reasoningEffort: "low",
        models: [{ id: low, label: "Low", hint: "" }],
      },
      low,
    ).active,
    true,
  );
});

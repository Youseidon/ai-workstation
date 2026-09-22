import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG,
  MODEL_POOLS,
  MODEL_POOL_LABEL,
  PROVIDER_IDS,
  isCustomModel,
  modelLabel,
  modelPool,
} from "../src/index";

test("every catalog entry is displayable", () => {
  for (const provider of PROVIDER_IDS) {
    for (const option of MODEL_CATALOG[provider]) {
      assert.notEqual(option.label, "", `${provider}/${option.id} has no label`);
      assert.notEqual(option.hint, "", `${provider}/${option.id} has no hint`);
    }
  }
});

test("ids are unique per provider, so the picker cannot render a duplicate key", () => {
  for (const provider of PROVIDER_IDS) {
    const ids = MODEL_CATALOG[provider].map((option) => option.id);
    assert.equal(new Set(ids).size, ids.length, `${provider} has a duplicate model id`);
  }
});

test("exactly one entry per provider is the unset default", () => {
  for (const provider of PROVIDER_IDS) {
    const defaults = MODEL_CATALOG[provider].filter((option) => option.id === null);
    assert.equal(defaults.length, 1, `${provider} should have exactly one null-id entry`);
  }
});

// The generated cursor block is the only place a pool is meaningful; a
// regeneration that drops the field would silently flatten the picker.
test("every generated cursor model declares a pool", () => {
  const generated = MODEL_CATALOG.cursor.filter((option) => option.id !== null);
  assert.ok(generated.length > 20, "cursor catalog looks unpopulated — run npm run sync:cursor-models");
  for (const option of generated) {
    assert.ok(
      option.pool !== undefined && MODEL_POOLS.includes(option.pool),
      `cursor/${option.id} has no valid pool`,
    );
  }
});

test("cursor serves models from both pools", () => {
  for (const pool of MODEL_POOLS) {
    const group = MODEL_CATALOG.cursor.filter((option) => option.pool === pool);
    assert.ok(group.length > 0, `cursor has no ${pool} models`);
    assert.notEqual(MODEL_POOL_LABEL[pool], undefined);
  }
});

// Cursor brands its own pool by id prefix; that is the only signal the CLI
// gives, so the classification has to keep tracking it.
test("the cursor pool holds only Cursor-branded ids", () => {
  for (const option of MODEL_CATALOG.cursor) {
    if (option.pool !== "cursor" || option.id === null) continue;
    assert.ok(
      option.id === "auto" || option.id.startsWith("cursor-") || option.id.startsWith("composer-"),
      `${option.id} is in the cursor pool but is not Cursor-branded`,
    );
  }
});

test("providers without pools stay ungrouped", () => {
  for (const provider of PROVIDER_IDS) {
    if (provider === "cursor") continue;
    for (const option of MODEL_CATALOG[provider]) {
      assert.equal(option.pool, undefined, `${provider}/${option.id} should not declare a pool`);
    }
  }
});

test("a catalog id resolves to its label and pool; anything else is custom", () => {
  assert.equal(modelLabel("cursor", "cursor-grok-4.6-medium"), "grok 4.6 medium");
  assert.equal(modelPool("cursor", "cursor-grok-4.6-medium"), "cursor");
  assert.equal(modelPool("cursor", "claude-opus-5-high"), "vendor");
  assert.equal(modelPool("claude", "claude-opus-5"), null);

  // The id that broke the pipeline: retired by Cursor, so it must not read as
  // a catalog entry any more.
  assert.equal(isCustomModel("cursor", "cursor-grok-4.5-medium"), true);
  assert.equal(modelPool("cursor", "cursor-grok-4.5-medium"), null);
  assert.equal(modelLabel("cursor", "cursor-grok-4.5-medium"), "cursor-grok-4.5-medium");
});

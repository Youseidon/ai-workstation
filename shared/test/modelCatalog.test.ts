import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_CATALOG,
  automaticModel,
  bakedModelEffort,
  classifyModel,
  eligibleModels,
  modelAllowedInTier,
  modelMatchesEffort,
  MODEL_POOLS,
  MODEL_POOL_LABEL,
  PROVIDER_IDS,
  isCustomModel,
  modelLabel,
  modelPool,
  recommendedModel,
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

  // An id Cursor no longer lists must not read as a catalog entry.
  assert.equal(isCustomModel("cursor", "cursor-grok-4.4-medium"), true);
  assert.equal(modelPool("cursor", "cursor-grok-4.4-medium"), null);
  assert.equal(modelLabel("cursor", "cursor-grok-4.4-medium"), "cursor-grok-4.4-medium");
});

test("model access tiers are cumulative spending ceilings", () => {
  assert.equal(classifyModel("claude", "claude-haiku-4-5"), "efficient");
  assert.equal(classifyModel("claude", "claude-sonnet-5"), "professional");
  assert.equal(classifyModel("claude", "claude-opus-5"), "frontier");
  assert.equal(classifyModel("kilocode", "openrouter/example:free"), "free");
  assert.equal(classifyModel("kilocode", "kilo-auto/free"), "free");
  assert.equal(classifyModel("kilocode", "kilo-auto/efficient"), "efficient");
  assert.equal(classifyModel("kilocode", "kilo-auto/frontier"), "frontier");
  assert.equal(classifyModel("codex", "future-unknown-model"), null);

  assert.equal(modelAllowedInTier("claude", "claude-haiku-4-5", "efficient"), true);
  assert.equal(modelAllowedInTier("claude", "claude-haiku-4-5", "professional"), true);
  assert.equal(modelAllowedInTier("claude", "claude-opus-5", "professional"), false);
  assert.equal(modelAllowedInTier("claude", "future-unknown-model", "frontier"), false);
  assert.equal(modelAllowedInTier("claude", "future-unknown-model", "all"), true);
});

test("automatic selection uses Kilo routers and concrete models elsewhere", () => {
  assert.equal(automaticModel("kilocode", MODEL_CATALOG.kilocode, "free"), "kilo-auto/free");
  assert.equal(automaticModel("kilocode", MODEL_CATALOG.kilocode, "efficient"), "kilo-auto/efficient");
  assert.equal(automaticModel("kilocode", MODEL_CATALOG.kilocode, "frontier"), "kilo-auto/frontier");
  assert.equal(automaticModel("kilocode", MODEL_CATALOG.kilocode, "all"), "kilo-auto/frontier");
  assert.equal(automaticModel("cursor", MODEL_CATALOG.cursor, "all"), "auto");
  assert.equal(automaticModel("cursor", MODEL_CATALOG.cursor, "professional"), "auto");
  assert.equal(automaticModel("cursor", MODEL_CATALOG.cursor, "frontier"), "auto");
  assert.notEqual(automaticModel("cursor", MODEL_CATALOG.cursor, "efficient"), "auto");
  assert.match(automaticModel("claude", MODEL_CATALOG.claude, "efficient") ?? "", /haiku/i);
  assert.match(automaticModel("claude", MODEL_CATALOG.claude, "all") ?? "", /opus|fable/i);
});

test("Cursor model ids expose a baked effort token", () => {
  assert.equal(bakedModelEffort("claude-sonnet-5-medium-fast"), "medium");
  assert.equal(bakedModelEffort("claude-opus-5-thinking-medium"), "medium");
  assert.equal(bakedModelEffort("claude-4.6-sonnet-medium-thinking"), "medium");
  assert.equal(bakedModelEffort("cursor-grok-4.6-high"), "high");
  assert.equal(bakedModelEffort("cursor-grok-4.6-xhigh-fast"), "xhigh");
  assert.equal(bakedModelEffort("gpt-5.5-extra-high"), "xhigh");
  assert.equal(bakedModelEffort("gpt-5.6-sol-none"), "none");
  assert.equal(bakedModelEffort("composer-2.5"), null);
  assert.equal(bakedModelEffort("composer-2.5-fast"), null);
  assert.equal(bakedModelEffort("auto"), null);
});

test("Cursor's picker keeps only models at the selected reasoning effort", () => {
  assert.equal(modelMatchesEffort("claude", "claude-opus-5-high", "medium"), true);
  assert.equal(modelMatchesEffort("cursor", "composer-2.5", "medium"), true);
  assert.equal(modelMatchesEffort("cursor", "cursor-grok-4.6-medium-fast", "medium"), true);
  assert.equal(modelMatchesEffort("cursor", "cursor-grok-4.6-high", "medium"), false);
  assert.equal(modelMatchesEffort("cursor", "cursor-grok-4.6-low", "medium"), false);
  assert.equal(modelMatchesEffort("cursor", "cursor-grok-4.6-xhigh", "high"), true);
  assert.equal(modelMatchesEffort("cursor", "gpt-5.6-sol-none", "low"), true);

  const medium = eligibleModels("cursor", MODEL_CATALOG.cursor, "all", "medium");
  assert.ok(medium.length < MODEL_CATALOG.cursor.length, "effort filter must drop other variants");
  assert.ok(medium.some((model) => model.id === "composer-2.5"));
  assert.ok(medium.some((model) => model.id === "cursor-grok-4.6-medium"));
  assert.equal(medium.some((model) => model.id === "cursor-grok-4.6-high"), false);
  assert.equal(medium.some((model) => model.id === "cursor-grok-4.6-low"), false);
  assert.equal(medium.some((model) => model.id === "claude-opus-5-high"), false);
  for (const model of medium) {
    const baked = bakedModelEffort(model.id);
    assert.ok(baked === null || baked === "medium", `${model.id} leaked into the medium list`);
  }
});

test("restricted catalogs remove provider defaults and unknown custom ids", () => {
  const catalog = [
    { id: null, label: "default", hint: "provider route" },
    { id: "vendor/model:free", label: "free", hint: "free" },
    { id: "claude-haiku", label: "haiku", hint: "cheap" },
    { id: "claude-sonnet", label: "sonnet", hint: "balanced" },
    { id: "mystery", label: "mystery", hint: "unknown" },
  ];
  assert.deepEqual(
    eligibleModels("claude", catalog, "efficient").map((model) => model.id),
    ["vendor/model:free", "claude-haiku"],
  );
  assert.equal(recommendedModel("claude", catalog, "free"), "vendor/model:free");
  assert.equal(recommendedModel("claude", catalog, "professional"), "claude-sonnet");
  assert.equal(recommendedModel("claude", catalog, "frontier"), "claude-sonnet");
});

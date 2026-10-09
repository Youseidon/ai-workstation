import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderInfo } from "@agent-console/shared";
import { resolveProviderModel } from "../src/adapters/registry.ts";
import {
  parseClaudeModels,
  parseCodexModels,
  parseCursorModels,
  parseGrokModels,
  parseKiloModels,
} from "../src/adapters/modelDiscovery.ts";

test("provider model outputs normalize to model options", () => {
  assert.deepEqual(parseCursorModels([
    "auto - Auto (default)",
    "composer-2 - Composer 2",
    "claude-sonnet-5 - Claude Sonnet 5",
  ].join("\n")), [
    { id: "auto", label: "auto", hint: "Auto (default)", pool: "cursor" },
    { id: "composer-2", label: "composer 2", hint: "Composer 2", pool: "cursor" },
    { id: "claude-sonnet-5", label: "sonnet 5", hint: "Claude Sonnet 5", pool: "vendor" },
  ]);

  assert.deepEqual(parseGrokModels("Available models:\n  * grok-4.6 (default)\n  - grok-4.5"), [
    { id: "grok-4.6", label: "4.6", hint: "provider default" },
    { id: "grok-4.5", label: "4.5", hint: "grok-4.5" },
  ]);
});

test("Codex accepts the live app-server and cache response shapes", () => {
  assert.deepEqual(parseCodexModels({
    data: [
      { model: "gpt-next", displayName: "GPT Next", description: "Newest", hidden: false },
      { model: "internal", displayName: "Internal", description: "Hidden", hidden: true },
    ],
  }), [{ id: "gpt-next", label: "GPT Next", hint: "Newest" }]);

  assert.deepEqual(parseCodexModels({
    models: [{ slug: "gpt-cache", display_name: "GPT Cache", description: "Cached", visibility: "list" }],
  }), [{ id: "gpt-cache", label: "GPT Cache", hint: "Cached" }]);
});

test("Claude reads the account-scoped catalog cache", () => {
  assert.deepEqual(parseClaudeModels({
    catalog: { config: { models: [
      { id: "claude-opus-next", name: "Opus Next", description: "Most capable", section: "main" },
    ] } },
  }), [{ id: "claude-opus-next", label: "opus next", hint: "Most capable" }]);
});

test("Kilo's model list lines are already valid -m values", () => {
  assert.deepEqual(parseKiloModels([
    "kilo-auto/free",
    "kilo-auto/efficient",
    "kilo-auto/frontier",
    "kilo/~anthropic/claude-opus-latest",
    "kilo/anthropic/claude-opus-5",
    "kilo/z-ai/glm-5.3-flash",
    "banner noise",
    "",
  ].join("\n")), [
    { id: "kilo-auto/free", label: "Auto Free", hint: "Kilo automatic routing" },
    { id: "kilo-auto/efficient", label: "Auto Efficient", hint: "Kilo automatic routing" },
    { id: "kilo-auto/frontier", label: "Auto Frontier", hint: "Kilo automatic routing" },
    { id: "kilo/~anthropic/claude-opus-latest", label: "claude opus latest", hint: "Kilo Gateway pool" },
    { id: "kilo/anthropic/claude-opus-5", label: "claude opus 5", hint: "anthropic/claude-opus-5" },
    { id: "kilo/z-ai/glm-5.3-flash", label: "glm 5.3 flash", hint: "z-ai/glm-5.3-flash" },
  ]);
});

test("Auto Select ignores caller model overrides on the server", () => {
  const cursor: ProviderInfo = {
    id: "cursor",
    label: "Cursor CLI",
    available: true,
    reason: null,
    version: null,
    transport: "spawn",
    binary: "cursor-agent",
    reportsTokens: true,
    permissionMode: "auto",
    model: "auto",
    configuredModel: "claude-opus-5-medium",
    modelAccessTier: "all",
    reasoningEffort: "medium",
    modelSelectionMode: "auto",
    tierDefaultModel: "claude-opus-5-medium",
    totalModels: 2,
    models: [
      { id: "auto", label: "auto", hint: "Auto (default)", pool: "cursor" },
      { id: "claude-opus-5-medium", label: "opus 5 medium", hint: "Claude Opus 5 1M Medium", pool: "vendor" },
    ],
    cooling: null,
  };
  assert.equal(resolveProviderModel(cursor, "claude-opus-5-medium"), "auto");
  assert.equal(resolveProviderModel(cursor, null), "auto");

  const info: ProviderInfo = {
    id: "kilocode",
    label: "Kilo Code",
    available: true,
    reason: null,
    version: null,
    transport: "spawn",
    binary: "kilo",
    reportsTokens: true,
    permissionMode: "auto",
    model: "kilo-auto/efficient",
    configuredModel: "kilo/anthropic/claude-opus-5",
    modelAccessTier: "efficient",
    reasoningEffort: "medium",
    modelSelectionMode: "auto",
    tierDefaultModel: "kilo/~anthropic/claude-haiku-latest",
    totalModels: 3,
    models: [{ id: "kilo-auto/efficient", label: "Auto Efficient", hint: "Kilo automatic routing" }],
    cooling: null,
  };

  assert.equal(resolveProviderModel(info, "kilo/anthropic/claude-opus-5"), "kilo-auto/efficient");
  assert.equal(resolveProviderModel(info, null), "kilo-auto/efficient");
});

test("Cursor effort filtering rejects other-effort catalog ids", () => {
  const info: ProviderInfo = {
    id: "cursor",
    label: "Cursor CLI",
    available: true,
    reason: null,
    version: null,
    transport: "spawn",
    binary: "cursor-agent",
    reportsTokens: true,
    permissionMode: "auto",
    model: "composer-2.5",
    configuredModel: "composer-2.5",
    modelAccessTier: "all",
    reasoningEffort: "medium",
    modelSelectionMode: "manual",
    tierDefaultModel: "composer-2.5",
    totalModels: 4,
    models: [
      { id: "composer-2.5", label: "composer 2.5", hint: "Composer 2.5", pool: "cursor" },
      { id: "cursor-grok-4.6-medium", label: "grok 4.6 medium", hint: "Cursor Grok 4.6 Medium", pool: "cursor" },
    ],
    cooling: null,
  };

  assert.equal(resolveProviderModel(info, "cursor-grok-4.6-medium"), "cursor-grok-4.6-medium");
  assert.equal(resolveProviderModel(info, "cursor-grok-4.6-high"), "composer-2.5");
  assert.equal(resolveProviderModel(info, "my-custom-model"), "my-custom-model");
});

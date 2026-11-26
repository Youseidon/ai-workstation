/**
 * Operator briefings: per-work-item context rendered first in the execute
 * prompt, cleared by DONE, never visible to another work item.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@hydra/shared";
import { contextMarkdown } from "../../src/services/agents/agentContext.ts";
import { WorkspaceError, workspaces } from "../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function seed() {
  const workspace = workspaces.create({ name: unique("ws"), workDirectory: mkdtempSync(join(tmpdir(), "briefing-")) });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog") }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite") }) as SuiteRecord;
  const first = workspaces.createChild("prompt", suite.id, { title: "Build backend", content: "Build the backend." }) as PromptRecord;
  const second = workspaces.createChild("prompt", suite.id, { title: "Wire frontend", content: "Wire the frontend." }) as PromptRecord;
  return { workspace, first, second };
}

test("a briefing is the first section of its own work item's execute context", () => {
  const { workspace, first } = seed();
  workspaces.addPromptBriefing(first.id, { content: "I already ran dotnet build manually; it passes. Do not build again." });
  const markdown = contextMarkdown(workspaces.agentContext(workspace.id, first.id), "execute");
  const briefing = markdown.indexOf("## From the operator — read first");
  assert.ok(briefing > 0, "briefing section present");
  assert.ok(briefing < markdown.indexOf("## Workspace"), "briefing comes before every other section");
  assert.match(markdown, /Do not build again\./);
});

test("a briefing never reaches another work item", () => {
  const { workspace, first, second } = seed();
  workspaces.addPromptBriefing(first.id, { content: "Skip the build." });
  const markdown = contextMarkdown(workspaces.agentContext(workspace.id, second.id), "execute");
  assert.doesNotMatch(markdown, /From the operator/);
  assert.deepEqual(workspaces.promptBriefings(second.id), []);
});

test("briefings are cleared by DONE and refused on a finished item", () => {
  const { workspace, first } = seed();
  workspaces.addPromptBriefing(first.id, { content: "Old note." });
  workspaces.completePrompt(first.id, "USER", { verificationSummary: "checked by hand" });
  assert.throws(() => workspaces.addPromptBriefing(first.id, { content: "Too late." }), (error: unknown) => error instanceof WorkspaceError && error.code === "already_terminal");

  // Notes written before the DONE are no longer in force; if the item is ever
  // reopened, its next run starts without them.
  assert.deepEqual(workspaces.promptBriefings(first.id), []);
  assert.doesNotMatch(contextMarkdown(workspaces.agentContext(workspace.id, first.id), "execute"), /Old note\./);
});

test("a briefing can be retracted, and only a briefing", () => {
  const { first } = seed();
  const note = workspaces.addPromptBriefing(first.id, { content: "Retract me." });
  workspaces.deletePromptBriefing(first.id, note.id);
  assert.deepEqual(workspaces.promptBriefings(first.id), []);
  assert.throws(() => workspaces.deletePromptBriefing(first.id, note.id), (error: unknown) => error instanceof WorkspaceError && error.status === 404);
});

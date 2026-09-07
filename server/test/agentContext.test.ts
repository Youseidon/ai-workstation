/**
 * Execute-context diet: section order, caps, AGENTS.md dedupe, parent block,
 * protocol/progress size bounds. Snapshot-free — each test names the claim.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import {
  CONTEXT_TRUNCATION_NOTICE,
  cappedSection,
  contextMarkdown,
  descriptionContainedInInstructions,
  progressApiMarkdown,
} from "../src/agentContext.ts";
import { newId } from "../src/lib/ids.ts";
import { runContexts } from "../src/runContext.ts";
import { workspaces } from "../src/workspaces.ts";
import type { AgentPromptContext } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function baseContext(overrides: Partial<AgentPromptContext> = {}): AgentPromptContext {
  return {
    workspace: {
      id: 1, name: "Example", workDirectory: "/tmp/ws",
      description: "Standing rules unique to the console.",
      agentsMd: "# Agents\n\nRepo rules live here.",
      claudeMd: "# Claude\n\nRepo rules live here.",
    },
    program: { id: 1, externalKey: "mig", name: "Migration", overview: "Replace the legacy service." },
    suite: { id: 1, externalKey: "S6", name: "Modules", overview: "Follow the module playbook." },
    prompt: {
      id: 2, suiteId: 1, title: "Checkout", content: "Implement checkout.",
      sortOrder: 0, createdAt: "", updatedAt: "", externalKey: "S6-02",
      status: "IN_PROGRESS", completedAt: null, result: "", isGate: false,
      parentPromptId: null, childOrder: 0,
    },
    parent: null,
    children: [],
    verificationCommands: ["npm test"],
    stoppedRemarks: [],
    dependencies: [{ externalKey: "S6-01", title: "Cart", status: "DONE", result: "green" }],
    gate: null,
    history: { remarks: [], events: [] },
    clarifications: [],
    ...overrides,
  };
}

function sectionTitles(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]!);
}

test("execute section order matches the diet table", () => {
  const markdown = contextMarkdown(baseContext({
    parent: {
      externalKey: "S6-09", title: "Module", content: "Parent body",
      resumeBrief: "Already ported auth", siblings: [
        { externalKey: "S6-09.1", title: "Clients", status: "TODO" },
      ],
    },
    stoppedRemarks: [{
      id: 1, promptId: 2, runId: "r1", kind: "CONTINUATION",
      content: "Finish the POST handler", actorType: "AGENT", createdAt: "2026-01-01T00:00:00.000Z",
    }],
    clarifications: [{
      id: 1, promptId: 2, question: "Which adapter?", answer: "Stripe",
      provider: "claude", model: null, state: "DONE",
      createdAt: "2026-01-01T00:00:00.000Z", answeredAt: "2026-01-01T00:01:00.000Z",
    }],
  }), "execute", { depth: 1, maxDepth: 2 });

  const titles = sectionTitles(markdown);
  assert.deepEqual(titles, [
    "Workspace",
    "Standing instructions",
    "Program",
    "Suite",
    "Parent",
    "Dependencies / gate",
    "Work item",
    "Verification",
    "Where the last run stopped",
    "Clarifications",
    "How this run ends",
  ]);
  assert.match(markdown, /Parent body/);
  assert.match(markdown, /S6-09\.1 — Clients — TODO/);
  assert.match(markdown, /Already ported auth/);
  assert.match(markdown, /Finish the POST handler/);
  assert.doesNotMatch(markdown, /AGENT_RESPONSE/);
});

test("a station has no Parent section; a sub-step does", () => {
  const station = contextMarkdown(baseContext(), "execute");
  assert.doesNotMatch(station, /^## Parent$/m);

  const child = contextMarkdown(baseContext({
    parent: {
      externalKey: "S6-09", title: "Module", content: "Parent content here",
      resumeBrief: "", siblings: [],
    },
  }), "execute", { depth: 1, maxDepth: 2 });
  assert.match(child, /^## Parent$/m);
  assert.match(child, /Parent content here/);
});

test("capped sections end with the --full notice when truncated", () => {
  const huge = "x".repeat(3000);
  const cut = cappedSection(huge, 1024);
  assert.ok(Buffer.byteLength(cut) <= 1024);
  assert.ok(cut.endsWith(CONTEXT_TRUNCATION_NOTICE));
  assert.match(cut, /agent-step context --full/);

  const markdown = contextMarkdown(baseContext({
    program: { id: 1, externalKey: "mig", name: "Migration", overview: "y".repeat(2000) },
  }), "execute");
  assert.match(markdown, /agent-step context --full/);
});

test("description dedupe: copy of AGENTS.md is omitted; distinct text is kept", () => {
  const shared = [
    "Line one of the rules.",
    "Line two of the rules.",
    "Line three of the rules.",
    "Line four of the rules.",
    "Line five of the rules.",
  ].join("\n");
  assert.equal(descriptionContainedInInstructions(shared, shared, ""), true);
  assert.equal(descriptionContainedInInstructions("Totally different standing text.", shared, ""), false);

  const omitted = contextMarkdown(baseContext({
    workspace: {
      id: 1, name: "Example", workDirectory: "/tmp",
      description: shared, agentsMd: shared, claudeMd: shared,
    },
  }), "execute");
  assert.doesNotMatch(omitted, /^## Standing instructions$/m);
  assert.match(omitted, /Repository rules are in `AGENTS\.md`\/`CLAUDE\.md`/);

  const kept = contextMarkdown(baseContext({
    workspace: {
      id: 1, name: "Example", workDirectory: "/tmp",
      description: "Orchestration-only standing instructions.",
      agentsMd: shared, claudeMd: shared,
    },
  }), "execute");
  assert.match(kept, /^## Standing instructions$/m);
  assert.match(kept, /Orchestration-only standing instructions/);
});

test("protocol and progress sections stay under their byte bounds", () => {
  const markdown = contextMarkdown(baseContext(), "execute", { depth: 0, maxDepth: 2 });
  const protocol = markdown.slice(markdown.indexOf("## How this run ends"));
  assert.ok(Buffer.byteLength(protocol) < 1300, `protocol was ${Buffer.byteLength(protocol)} bytes`);
  assert.match(protocol, /mostly independent slices/);
  assert.match(protocol, /Do not split because the work is large/);
  assert.doesNotMatch(protocol, /report BLOCKED/);
  assert.doesNotMatch(protocol, /execution window/);

  const leaf = contextMarkdown(baseContext(), "execute", { depth: 2, maxDepth: 2 });
  assert.match(leaf, /post `continue` with what remains/);
  assert.doesNotMatch(leaf, /report BLOCKED/);

  const progress = progressApiMarkdown({
    runId: "r1", token: "tok", port: 4000, canDecompose: true, shimPath: "/tmp/x/agent-step",
  });
  assert.ok(Buffer.byteLength(progress) < 1024, `progress was ${Buffer.byteLength(progress)} bytes`);
  assert.doesNotMatch(progress, /curl/);
  assert.doesNotMatch(progress, /reviewer is sent/i);
  assert.match(progress, /requestId must be unique/);
});

test("a resumed parent gets ## Sub-steps; a station without children does not", () => {
  const withChildren = contextMarkdown(baseContext({
    children: [
      { externalKey: "S6-08.1", title: "Auth", status: "DONE", result: "npm test green" },
      { externalKey: "S6-08.2", title: "Clients", status: "SKIPPED", result: "covered by Auth" },
    ],
  }), "execute");
  assert.match(withChildren, /^## Sub-steps$/m);
  assert.match(withChildren, /S6-08\.1 — Auth — DONE/);
  assert.match(withChildren, /npm test green/);
  assert.match(withChildren, /S6-08\.2 — Clients — SKIPPED — covered by Auth/);

  const titles = sectionTitles(withChildren);
  const workItem = titles.indexOf("Work item");
  const subSteps = titles.indexOf("Sub-steps");
  assert.ok(workItem >= 0 && subSteps === workItem + 1, "Sub-steps follows Work item");

  const bare = contextMarkdown(baseContext({ children: [] }), "execute");
  assert.doesNotMatch(bare, /^## Sub-steps$/m);
});

test("progress curl path is used instead of the shim when usesCurl is set", () => {
  const markdown = progressApiMarkdown({
    runId: "r1", token: "secret", port: 4000, canDecompose: false,
    shimPath: "/tmp/x/agent-step", usesCurl: true,
  });
  assert.match(markdown, /curl/);
  assert.doesNotMatch(markdown, /\/tmp\/x\/agent-step/);
});

test("full execute context keeps AGENT_RESPONSE remarks and skips caps", () => {
  const longOverview = "z".repeat(5000);
  const markdown = contextMarkdown(baseContext({
    suite: { id: 1, externalKey: "S6", name: "Modules", overview: longOverview },
    history: {
      remarks: [{
        id: 9, promptId: 2, runId: "r1", kind: "AGENT_RESPONSE",
        content: "Prior agent narration", actorType: "AGENT", createdAt: "2026-01-01T00:00:00.000Z",
      }],
      events: [],
    },
    stoppedRemarks: [],
  }), "execute", { full: true });
  assert.match(markdown, /AGENT_RESPONSE/);
  assert.match(markdown, /Prior agent narration/);
  assert.doesNotMatch(markdown, /agent-step context --full/);
  assert.ok(markdown.includes(longOverview));
});

test("agentContext supplies parent, stopped remarks, and no AGENT_RESPONSE by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "Distinct standing text.", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "Program overview" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "Suite playbook" }) as SuiteRecord;
  const parent = workspaces.createChild("prompt", suite.id, {
    title: "Parent station", content: "Parent body with enough detail.",
  }) as PromptRecord;

  // Drive a real decompose so parent/siblings/resumeBrief are the production shape.
  const runId = newId("run");
  const credential = runContexts.create(runId, workspace.id, parent.id);
  workspaces.beginAgentRun({
    runId, workspaceId: workspace.id, promptId: parent.id,
    provider: "codex", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt,
  });
  workspaces.markAgentRunRunning(runId);
  const decomposed = workspaces.decomposePrompt(runId, {
    requestId: "decomp-1",
    resumeBrief: "Auth is done; port the clients next.",
    children: [
      { title: "Child A", content: "Do A" },
      { title: "Child B", content: "Do B" },
    ],
  }) as { children: Array<{ id: number }> };

  try {
    const childId = decomposed.children[0]!.id;
    const ctx = workspaces.agentContext(workspace.id, childId);
    assert.ok(ctx.parent !== null);
    assert.match(ctx.parent!.content, /Parent body/);
    assert.match(ctx.parent!.resumeBrief, /Auth is done/);
    assert.equal(ctx.parent!.siblings.length, 2);
    assert.ok(ctx.stoppedRemarks.every((remark) => remark.kind !== "AGENT_RESPONSE"));

    const markdown = contextMarkdown(ctx, "execute", { depth: 1, maxDepth: 2 });
    assert.match(markdown, /^## Parent$/m);
    assert.match(markdown, /Auth is done/);
    assert.doesNotMatch(markdown, /AGENT_RESPONSE/);

    const station = workspaces.agentContext(workspace.id, parent.id);
    assert.equal(station.parent, null);
    assert.equal(station.children.length, 2);
    assert.doesNotMatch(contextMarkdown(station, "execute"), /^## Parent$/m);
    assert.match(contextMarkdown(station, "execute"), /^## Sub-steps$/m);

    const recent = workspaces.recentRemarks(childId, { kinds: ["PROGRESS"], limit: 5 });
    assert.ok(Array.isArray(recent));
  } finally {
    runContexts.revoke(runId);
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

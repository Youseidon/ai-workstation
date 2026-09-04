/**
 * When a reviewer is sent, who it is, and what its verdict is allowed to do.
 *
 * All of this used to be one global three-way switch — off / report /
 * autocomplete — plus a hardcoded "first available agent that is not the one on
 * trial". So an operator could not say "check a run that went quiet but leave a
 * crash for me", could not choose the reviewer, and on a single-provider setup
 * got no review at all, silently.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_REVIEWER_CONFIG, REVIEW_TRIGGERS, reviewTriggerFor } from "@agent-console/shared";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { workspaces, WorkspaceError } from "./workspaces.ts";

let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "work" }) as PromptRecord;
  return {
    workspace, suite, prompt,
    cleanup() {
      for (const trigger of REVIEW_TRIGGERS) {
        workspaces.clearReviewerConfig("global", null, trigger);
        workspaces.clearReviewerConfig("suite", suite.id, trigger);
        workspaces.clearReviewerConfig("prompt", prompt.id, trigger);
      }
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("each situation is answered separately", () => {
  // The point of the matrix. A run that went quiet and a run whose process died
  // are different events and can now be treated differently.
  const ctx = fixture();
  try {
    workspaces.setReviewerConfig({ scope: "global", scopeId: null, trigger: "failed", patch: { enabled: false } });
    assert.equal(workspaces.reviewerConfig("failed").enabled, false);
    assert.equal(workspaces.reviewerConfig("unreported").enabled, true, "switching one situation off changed another");
  } finally {
    ctx.cleanup();
  }
});

test("the narrowest scope with something to say wins, field by field", () => {
  const ctx = fixture();
  try {
    workspaces.setReviewerConfig({ scope: "global", scopeId: null, trigger: "unreported", patch: { provider: "codex", maxAttempts: 3 } });
    workspaces.setReviewerConfig({ scope: "suite", scopeId: ctx.suite.id, trigger: "unreported", patch: { provider: "claude" } });

    const resolved = workspaces.reviewerConfig("unreported", ctx.prompt.id);
    assert.equal(resolved.provider, "claude", "the suite should have overridden the provider");
    // Fields resolve independently: naming a provider on the suite must not
    // silently drop the attempt cap set globally.
    assert.equal(resolved.maxAttempts, 3);
    assert.equal(workspaces.reviewerConfig("unreported").provider, "codex", "the global answer changed");
  } finally {
    ctx.cleanup();
  }
});

test("clearing a scope falls back rather than resetting to shipped", () => {
  const ctx = fixture();
  try {
    workspaces.setReviewerConfig({ scope: "global", scopeId: null, trigger: "unreported", patch: { provider: "codex" } });
    workspaces.setReviewerConfig({ scope: "prompt", scopeId: ctx.prompt.id, trigger: "unreported", patch: { provider: "grok" } });
    assert.equal(workspaces.reviewerConfig("unreported", ctx.prompt.id).provider, "grok");
    workspaces.clearReviewerConfig("prompt", ctx.prompt.id, "unreported");
    assert.equal(workspaces.reviewerConfig("unreported", ctx.prompt.id).provider, "codex");
  } finally {
    ctx.cleanup();
  }
});

test("an untouched install behaves exactly as it shipped", () => {
  for (const trigger of REVIEW_TRIGGERS) {
    assert.deepEqual(workspaces.reviewerConfig(trigger), DEFAULT_REVIEWER_CONFIG[trigger]);
  }
});

test("a question the agent asked never summons a reviewer", () => {
  // BLOCKED is a human being asked something. Sending a machine to read the
  // tree and decide would be overruling a request for a human decision.
  assert.equal(reviewTriggerFor("BLOCKED"), null);
  assert.equal(reviewTriggerFor("DONE"), null);
  assert.equal(reviewTriggerFor("SKIPPED"), null);
  assert.equal(reviewTriggerFor("UNREPORTED"), "unreported");
  assert.equal(reviewTriggerFor("FAILED"), "failed");
});

test("garbage is refused rather than stored", () => {
  const ctx = fixture();
  try {
    for (const patch of [
      { enabled: "yes" }, { maxAttempts: 0 }, { maxAttempts: 99 },
      { onComplete: "detonate" }, { provider: "not-an-agent" },
    ]) {
      assert.throws(
        () => workspaces.setReviewerConfig({ scope: "global", scopeId: null, trigger: "unreported", patch }),
        (error: unknown) => error instanceof WorkspaceError && error.status === 422,
        JSON.stringify(patch),
      );
    }
    assert.throws(() => workspaces.setReviewerConfig({ scope: "nowhere", scopeId: null, trigger: "unreported", patch: {} }));
    assert.throws(() => workspaces.setReviewerConfig({ scope: "global", scopeId: null, trigger: "invented", patch: {} }));
  } finally {
    ctx.cleanup();
  }
});

test("every situation has a shipped answer", () => {
  // A situation with no default would be one the app silently ignores.
  for (const trigger of REVIEW_TRIGGERS) {
    const config = DEFAULT_REVIEWER_CONFIG[trigger];
    assert.equal(config.trigger, trigger);
    assert.ok(config.maxAttempts >= 1);
    assert.equal(config.mustDifferFromSource, true, "a reviewer defaults to marking its own homework");
  }
});

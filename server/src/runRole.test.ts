import assert from "node:assert/strict";
import test from "node:test";
import { isRunRole } from "@agent-console/shared";
import type { RunHandle } from "./runner.ts";
import { runRoleStartError, emptyBudgetSnapshot } from "./runner.ts";
import { runHub } from "./runHub.ts";
import {
  effectiveClaudePermissionMode,
  effectiveCodexSandboxMode,
  effectiveCopilotPermissionMode,
  effectiveGrokSandboxMode,
  permissionForRun,
  settings,
} from "./settings.ts";
import { claudePermissionConfig } from "./adapters/claude.ts";
import { CursorAdapter, cursorAgentArgs } from "./adapters/cursor.ts";
import { createLogger } from "./lib/logger.ts";

function withHostAccess<T>(enabled: boolean, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(settings, "hostAccess");
  Object.defineProperty(settings, "hostAccess", { configurable: true, enumerable: true, get: () => enabled });
  try {
    return fn();
  } finally {
    if (previous) Object.defineProperty(settings, "hostAccess", previous);
    else delete (settings as { hostAccess?: unknown }).hostAccess;
  }
}

function fakeHandle(runId: string, role: RunHandle["role"] = "execute"): RunHandle {
  return {
    runId,
    provider: "claude",
    model: null,
    role,
    permissionMode: role === "consult" ? "plan" : null,
    budget: emptyBudgetSnapshot,
    interrupt: async () => {},
    done: Promise.resolve("done"),
  };
}

const workspace = { id: 9001, name: "Lock", workDirectory: "/tmp/lock" };

test("unknown run roles are malformed", () => {
  assert.equal(isRunRole("execute"), true);
  assert.equal(isRunRole("consult"), true);
  assert.equal(isRunRole("writer"), false);
  assert.equal(isRunRole(undefined), false);
  assert.equal(isRunRole(null), false);
});

test("consult starts are allowed except for Cursor", () => {
  assert.equal(runRoleStartError("execute", "claude"), null);
  assert.equal(runRoleStartError("execute", "cursor"), null);
  assert.equal(runRoleStartError("consult", "claude"), null);
  assert.equal(runRoleStartError("consult", "codex"), null);
  assert.equal(runRoleStartError("consult", "grok"), null);
  assert.equal(runRoleStartError("consult", "copilot"), null);
});

test("cursor consults are rejected", () => {
  assert.equal(runRoleStartError("consult", "cursor"), "Cursor cannot run as a consult; it has no sandbox.");
});

test("second execute is still busy while an execute run is live", () => {
  const executeId = "run_exec_lock";
  const consultId = "run_consult_lock";
  try {
    runHub.start({
      handle: fakeHandle(executeId, "execute"),
      workspace,
      source: { type: "custom", displayText: "write" },
      role: "execute",
      permissionMode: null,
    });
    assert.equal(runHub.activeForWorkspace(workspace.id)?.runId, executeId);
    assert.equal(runHub.activeExecuteForWorkspace(workspace.id)?.runId, executeId);
    assert.deepEqual(runHub.consultsForWorkspace(workspace.id), []);

    runHub.start({
      handle: fakeHandle(consultId, "consult"),
      workspace,
      source: { type: "custom", displayText: "ask" },
      role: "consult",
      permissionMode: "plan",
    });
    assert.equal(runHub.activeForWorkspace(workspace.id)?.runId, executeId);
    assert.equal(runHub.consultsForWorkspace(workspace.id).map((run) => run.runId).join(), consultId);
    assert.equal(runHub.snapshots().find((run) => run.runId === executeId)?.role, "execute");
    assert.equal(runHub.snapshots().find((run) => run.runId === consultId)?.role, "consult");
  } finally {
    runHub.end(consultId, "done");
    runHub.end(executeId, "done");
  }
});

test("explicit permissionMode null is inherit, not the handle's forced mode", () => {
  const runId = "run_perm_null";
  try {
    runHub.start({
      handle: fakeHandle(runId, "consult"),
      workspace: { id: 9003, name: "Perm", workDirectory: "/tmp/perm" },
      source: { type: "custom", displayText: "x" },
      role: "execute",
      permissionMode: null,
    });
    assert.equal(runHub.get(runId)?.permissionMode, null);
  } finally {
    runHub.end(runId, "done");
  }
});

test("a consult does not occupy the execute lock", () => {
  const consultId = "run_consult_only";
  try {
    runHub.start({
      handle: fakeHandle(consultId, "consult"),
      workspace: { id: 9002, name: "Ask", workDirectory: "/tmp/ask" },
      source: { type: "custom", displayText: "ask" },
      role: "consult",
      permissionMode: "read-only",
    });
    assert.equal(runHub.activeForWorkspace(9002), undefined);
    assert.equal(runHub.activeExecuteForWorkspace(9002), undefined);
    assert.equal(runHub.consultsForWorkspace(9002).length, 1);
  } finally {
    runHub.end(consultId, "done");
  }
});

test("permissionForRun consult is read-only even when Host access would lift the sandbox", () => {
  withHostAccess(true, () => {
    assert.equal(effectiveCodexSandboxMode(), "danger-full-access");
    assert.equal(effectiveClaudePermissionMode(), "bypassPermissions");
    assert.equal(effectiveGrokSandboxMode(), "off");
    const consult = permissionForRun("codex", "consult");
    assert.equal(consult.mode, "read-only");
    assert.equal(consult.hostAccessApplied, false);
    assert.equal(permissionForRun("claude", "consult").mode, "plan");
    assert.equal(permissionForRun("grok", "consult").mode, "plan · sandbox: workspace");
    assert.equal(effectiveCopilotPermissionMode(), "yolo");
    assert.equal(permissionForRun("copilot", "consult").mode, "plan");
    assert.equal(permissionForRun("codex", "inherit").mode, "danger-full-access");
  });
});

test("Claude consult options do not set allowDangerouslySkipPermissions", () => {
  withHostAccess(true, () => {
    const inherit = claudePermissionConfig("inherit");
    assert.equal(inherit.allowDangerouslySkipPermissions, true);
    assert.equal(inherit.disableSandboxForHostAccess, true);
    const consult = claudePermissionConfig("consult");
    assert.equal(consult.permissionMode, "plan");
    assert.equal(consult.allowDangerouslySkipPermissions, false);
    assert.equal(consult.disableSandboxForHostAccess, false);
    assert.deepEqual(consult.disallowedTools, [
      "WebFetch",
      "WebSearch",
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
    ]);
  });
});

test("cursor adapter fails fast on a consult override", async () => {
  const adapter = new CursorAdapter();
  await assert.rejects(
    async () => {
      for await (const _event of adapter.run("x", {
        runId: "run_cursor_consult",
        cwd: "/tmp",
        signal: new AbortController().signal,
        model: null,
        log: createLogger("test"),
        permissionOverride: "consult",
      })) {
        /* drain */
      }
    },
    /no sandbox/,
  );
});

test("cursor adapter uses the supported long model flag", () => {
  const args = cursorAgentArgs({
    prompt: "do the work",
    outputFormat: "stream-json",
    force: false,
    model: "claude-sonnet-5",
    extraArgs: [],
  });
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--model", "claude-sonnet-5", "do the work"]);
  assert.equal(args.includes("-m"), false);
});

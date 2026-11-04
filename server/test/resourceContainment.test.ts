import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSpawnPlan,
  buildSystemdSpawnPlan,
  parseSystemdProperties,
  signalProcessTree,
  systemdUserManagerAvailable,
  type ResourceLimits,
} from "../src/adapters/resourceContainment.ts";

const limits: ResourceLimits = {
  memoryHighBytes: 3 * 1024 ** 3,
  memoryMaxBytes: 4 * 1024 ** 3,
  memorySwapMaxBytes: 512 * 1024 ** 2,
  tasksMax: 512,
};

test("systemd command contains cgroup-wide memory, swap, and task limits", () => {
  const plan = buildSystemdSpawnPlan("/usr/bin/codex", ["exec", "hello"], "run:unsafe/id", limits);
  assert.equal(plan.command, "systemd-run");
  assert.equal(plan.containment, "systemd");
  assert.equal(plan.unitName, "agent-console-run-unsafe-id");
  const command = plan.args.join(" ");
  assert.match(command, /MemoryHigh=3221225472/);
  assert.match(command, /MemoryMax=4294967296/);
  assert.match(command, /MemorySwapMax=536870912/);
  assert.match(command, /TasksMax=512/);
  assert.match(command, /OOMPolicy=kill/);
  assert.match(command, /KillMode=control-group/);
  assert.deepEqual(plan.args.slice(-4), ["--", "/usr/bin/codex", "exec", "hello"]);
});

test("unsupported platforms fall back to a detached POSIX process group", () => {
  const plan = buildSpawnPlan("codex", ["exec"], "run_1", limits, false, "linux");
  assert.deepEqual(plan, {
    command: "codex",
    args: ["exec"],
    unitName: null,
    containment: "process-group",
    detached: true,
  });
  assert.equal(systemdUserManagerAvailable("darwin"), false);
});

test("process-tree termination signals the whole POSIX process group", () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  assert.equal(signalProcessTree(4321, "SIGINT", "linux", (pid, signal) => {
    calls.push([pid, signal as NodeJS.Signals]);
    return true;
  }), true);
  assert.deepEqual(calls, [[-4321, "SIGINT"]]);
});

test("systemd OOM outcome is classified with its limit and peak", () => {
  assert.deepEqual(parseSystemdProperties([
    "Result=oom-kill",
    "MemoryPeak=4194304000",
  ].join("\n"), limits.memoryMaxBytes), {
    result: "oom-kill",
    peakMemoryBytes: 4194304000,
    stopReason: "resource_memory_limit:4294967296",
  });
});


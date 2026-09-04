import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceLock, InstanceLockedError } from "./lib/instanceLock.ts";

function scratch(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "instance-lock-"));
  return { path: join(dir, "console.sqlite.lock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/*
 * The lock exists to stop a second server reconciling a live server's runs, so
 * the case that matters most is the one below: a holder that is still alive is
 * never displaced, however inconvenient that is for the process arriving second.
 */
test("a lock held by a live process is refused", () => {
  const { path, cleanup } = scratch();
  try {
    acquireInstanceLock(path);
    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
    assert.throws(() => acquireInstanceLock(path), (error: unknown) => {
      assert.ok(error instanceof InstanceLockedError);
      assert.equal(error.heldByPid, process.pid);
      return true;
    });
  } finally {
    cleanup();
  }
});

test("a lock left behind by a dead process is taken over", () => {
  const { path, cleanup } = scratch();
  try {
    // PID 2^22 + 1 is above every Linux pid_max, so it can never be running.
    writeFileSync(path, "4194305\n");
    const lock = acquireInstanceLock(path);
    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
    lock.release();
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test("a corrupt lock file is treated as debris rather than an owner", () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, "not a pid");
    acquireInstanceLock(path).release();
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test("release is idempotent and never removes another process's claim", () => {
  const { path, cleanup } = scratch();
  try {
    const lock = acquireInstanceLock(path);
    lock.release();
    // The successor's claim must survive the first holder releasing twice.
    writeFileSync(path, "4194305\n");
    lock.release();
    assert.equal(readFileSync(path, "utf8").trim(), "4194305");
  } finally {
    cleanup();
  }
});

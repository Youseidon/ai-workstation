import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceLock, InstanceLockedError, readHolder } from "../src/lib/instanceLock.ts";

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
    assert.equal(readHolder(path)?.pid, process.pid);
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
    assert.equal(readHolder(path)?.pid, process.pid);
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
    assert.equal(readHolder(path)?.pid, 4194305);
  } finally {
    cleanup();
  }
});

/*
 * The payload gained `mode` so that the two ways a lock is held can be told
 * apart in the message the operator reads: a stale development server is debris
 * to clear, a `serve` process is a live pipeline and the advice is the opposite.
 */
test("the lock records who holds it and under which mode", () => {
  const { path, cleanup } = scratch();
  const before = process.env.AGENT_CONSOLE_MODE;
  process.env.AGENT_CONSOLE_MODE = "serve";
  try {
    const lock = acquireInstanceLock(path);
    const holder = readHolder(path);
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.mode, "serve");
    assert.match(String(holder?.startedAt), /^\d{4}-\d{2}-\d{2}T/);
    // The error carries it too, which is what lets `index.ts` pick a message.
    assert.throws(() => acquireInstanceLock(path), (error: unknown) => {
      assert.ok(error instanceof InstanceLockedError);
      assert.equal(error.holder?.mode, "serve");
      return true;
    });
    lock.release();
  } finally {
    if (before === undefined) delete process.env.AGENT_CONSOLE_MODE;
    else process.env.AGENT_CONSOLE_MODE = before;
    cleanup();
  }
});

/*
 * A lock file written before the payload existed holds a bare pid, and a live
 * server may well be holding it right now. Reading it as debris would displace
 * that server — the exact accident the lock exists to prevent — so the bare
 * form stays readable rather than being treated as a corrupt file.
 */
test("a bare-pid lock file from an older build is still an owner", () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, `${process.pid}\n`);
    const holder = readHolder(path);
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.mode, "dev", "an unlabelled holder is assumed to be a dev server");
    assert.equal(holder?.startedAt, null);
    assert.throws(() => acquireInstanceLock(path), InstanceLockedError);
  } finally {
    cleanup();
  }
});

test("a lock file holding malformed JSON is debris, not an owner", () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, '{"pid":');
    acquireInstanceLock(path).release();
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

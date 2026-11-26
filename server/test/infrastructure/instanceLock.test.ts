import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceLock, InstanceLockedError, readHolder } from "../../src/infrastructure/instanceLock.ts";

function scratch(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "instance-lock-"));
  return { path: join(dir, "console.sqlite.lock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
    writeFileSync(path, "4194305\n");
    lock.release();
    assert.equal(readFileSync(path, "utf8").trim(), "4194305");
    assert.equal(readHolder(path)?.pid, 4194305);
  } finally {
    cleanup();
  }
});

test("the lock records who holds it and under which mode", () => {
  const { path, cleanup } = scratch();
  const before = process.env.HYDRA_MODE;
  process.env.HYDRA_MODE = "serve";
  try {
    const lock = acquireInstanceLock(path);
    const holder = readHolder(path);
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.mode, "serve");
    assert.match(String(holder?.startedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.throws(() => acquireInstanceLock(path), (error: unknown) => {
      assert.ok(error instanceof InstanceLockedError);
      assert.equal(error.holder?.mode, "serve");
      return true;
    });
    lock.release();
  } finally {
    if (before === undefined) delete process.env.HYDRA_MODE;
    else process.env.HYDRA_MODE = before;
    cleanup();
  }
});

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

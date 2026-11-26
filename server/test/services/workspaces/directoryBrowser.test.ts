import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDirectory, listDirectories } from "../../../src/services/workspaces/directoryBrowser.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hydra-browse-"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "not a folder");
  symlinkSync(join(root, "beta"), join(root, "linked"));
  symlinkSync(join(root, "missing"), join(root, "dangling"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("lists only sub-directories, visible first, following symlinks", () => {
  const { root, cleanup } = fixture();
  try {
    const listing = listDirectories(root);
    assert.equal(listing.path, root);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["Alpha", "beta", "linked", ".hidden"]);
    assert.equal(listing.entries.at(-1)?.hidden, true);
    assert.equal(listing.truncated, false);
    assert.ok(listing.parent !== null && root.startsWith(listing.parent));
  } finally { cleanup(); }
});

test("rejects relative, missing and file paths", () => {
  const { root, cleanup } = fixture();
  try {
    assert.throws(() => listDirectories("relative/path"), { status: 422 });
    assert.throws(() => listDirectories(join(root, "nope")), { status: 404 });
    assert.throws(() => listDirectories(join(root, "file.txt")), { status: 404 });
    assert.equal(listDirectories("/").parent, null);
  } finally { cleanup(); }
});

test("creates one folder and refuses traversal or duplicates", () => {
  const { root, cleanup } = fixture();
  try {
    const created = createDirectory({ parent: root, name: " new-project " });
    assert.equal(created.path, join(root, "new-project"));
    assert.throws(() => createDirectory({ parent: root, name: "new-project" }), { status: 409 });
    for (const name of ["", ".", "..", "a/b", "../escape"]) assert.throws(() => createDirectory({ parent: root, name }), { status: 422 });
  } finally { cleanup(); }
});

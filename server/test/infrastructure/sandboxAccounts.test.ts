import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { copySandboxAccounts } = await import(new URL("../../../scripts/lib/sandbox-accounts.mjs", import.meta.url).href);

test("sandbox snapshots retain account ownership and private data without copying live process locks", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-sandbox-accounts-"));
  const live = join(dir, "live", "hydra.sqlite");
  const sandbox = join(dir, "sandbox", "hydra.sqlite");
  mkdirSync(`${live}.users/account`, { recursive: true });
  mkdirSync(`${sandbox}.users/obsolete`, { recursive: true });
  const content: Record<string, string> = {
    ".identities.sqlite": "existing owner registry",
    ".identities.sqlite-wal": "recent account changes",
    ".users/account/hydra.sqlite": "private account data",
    ".users/account/hydra.sqlite-wal": "recent private data",
    ".users/account/settings.json": '{"budget.maxSpendUsd":42}',
  };
  try {
    for (const [suffix, value] of Object.entries(content)) writeFileSync(`${live}${suffix}`, value);
    for (const suffix of [".identities.sqlite-shm", ".users/account/hydra.sqlite-shm", ".users/account/hydra.sqlite.lock"]) writeFileSync(`${live}${suffix}`, "live process metadata");
    writeFileSync(`${sandbox}.identities.sqlite-shm`, "stale metadata");
    copySandboxAccounts(live, sandbox);
    for (const [suffix, value] of Object.entries(content)) {
      assert.equal(readFileSync(`${sandbox}${suffix}`, "utf8"), value);
      assert.equal(readFileSync(`${live}${suffix}`, "utf8"), value);
    }
    for (const suffix of [".identities.sqlite-shm", ".users/account/hydra.sqlite-shm", ".users/account/hydra.sqlite.lock", ".users/obsolete"]) assert.equal(existsSync(`${sandbox}${suffix}`), false);
    assert.equal(statSync(join(dir, "sandbox")).mode & 0o777, 0o700);
    assert.equal(statSync(`${sandbox}.identities.sqlite`).mode & 0o777, 0o600);
    assert.throws(() => copySandboxAccounts(live, live), /separate from live/);
    assert.equal(readFileSync(`${live}.identities.sqlite`, "utf8"), content[".identities.sqlite"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

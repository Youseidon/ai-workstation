import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function copySandboxAccounts(live, sandbox) {
  if (resolve(live) === resolve(sandbox)) throw new Error("Sandbox state must be separate from live state.");
  mkdirSync(dirname(sandbox), { recursive: true, mode: 0o700 });
  chmodSync(dirname(sandbox), 0o700);
  for (const suffix of [".identities.sqlite", ".identities.sqlite-wal", ".identities.sqlite-shm", ".users"]) {
    rmSync(`${sandbox}${suffix}`, { recursive: true, force: true });
  }
  for (const suffix of [".identities.sqlite", ".identities.sqlite-wal"]) {
    if (!existsSync(`${live}${suffix}`)) continue;
    copyFileSync(`${live}${suffix}`, `${sandbox}${suffix}`);
    chmodSync(`${sandbox}${suffix}`, 0o600);
  }
  if (existsSync(`${live}.users`)) {
    cpSync(`${live}.users`, `${sandbox}.users`, {
      recursive: true,
      filter: source => !source.endsWith("-shm") && !source.endsWith(".lock"),
    });
  }
}

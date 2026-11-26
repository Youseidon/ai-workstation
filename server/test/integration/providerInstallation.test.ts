import assert from "node:assert/strict";
import test from "node:test";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "provider installation is authenticated, owner-only and cannot accept arbitrary commands",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-install-gateway-"));
    const database = join(dir, "hydra.sqlite");
    const settings = join(dir, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        "codex.binary": "codex",
        ...Object.fromEntries(
          ["cursor", "grok", "copilot", "kilocode"].map((id) => [
            `${id}.binary`,
            "/missing/test-provider",
          ]),
        ),
      }),
    );
    const env = {
      ...process.env,
      HYDRA_DB: database,
      SETTINGS_FILE: settings,
      HYDRA_MODE: "serve",
      HOST: "127.0.0.1",
      PORT: "0",
      ALLOWED_ORIGINS: "http://localhost:3100",
      PATH: "/missing-fixture-bin",
      HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
    };
    const identitiesPath = fileURLToPath(
      new URL("../../src/repositories/identities.ts", import.meta.url),
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {openIdentityStore} from ${JSON.stringify(identitiesPath)}; import Database from 'better-sqlite3'; const store=openIdentityStore(${JSON.stringify(`${database}.identities.sqlite`)}); const owner=await store.register({username:'owner',password:'fixture owner password'}); await store.register({username:'second',password:'fixture second password'}); store.close(); const db=new Database(${JSON.stringify(`${database}.identities.sqlite`)}); db.prepare('UPDATE identity_user SET owns_legacy_data=1 WHERE id=?').run(owner.user.id); db.close();`,
      ],
      { env, stdio: "pipe" },
    );
    const child = fork(
      fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
      [],
      {
        env,
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      const ready = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(() => {
          throw new Error(`Fixture gateway stopped: ${output}`);
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Fixture gateway timed out")),
            15_000,
          );
          timer.unref();
        }),
      ]);
      const base = `http://127.0.0.1:${(ready[0] as { port: number }).port}`;
      const call = (
        path: string,
        cookie = "",
        method = "GET",
        body?: unknown,
      ) =>
        fetch(`${base}${path}`, {
          method,
          headers: {
            Origin: "http://localhost:3100",
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const login = async (username: string, password: string) => {
        const response = await call("/api/auth/login", "", "POST", {
          username,
          password,
        });
        assert.equal(response.status, 200);
        const cookie = response.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie);
        return cookie;
      };
      assert.equal(
        (await call("/api/providers/codex/install", "", "POST")).status,
        401,
      );
      const second = await login("second", "fixture second password");
      for (const operation of ["install", "update"])
        assert.equal(
          (await call(`/api/providers/codex/${operation}`, second, "POST"))
            .status,
          403,
        );
      const owner = await login("owner", "fixture owner password");
      assert.equal(
        (await call("/api/providers/unknown/install", owner, "POST")).status,
        404,
      );
      assert.equal(
        (await call("/api/providers/codex/install", owner)).status,
        405,
      );
      const setup = await call("/api/providers/codex/setup", owner);
      assert.equal(setup.status, 200);
      const descriptor = (await setup.json()) as {
        installed: boolean;
        canInstall: boolean;
        source: string;
      };
      assert.equal(descriptor.installed, false);
      assert.equal(
        descriptor.canInstall,
        false,
        "npm is intentionally absent in this fixture",
      );
      assert.match(descriptor.source, /@openai\/codex/);
      const install = await call(
        "/api/providers/codex/install",
        owner,
        "POST",
        { command: "this must never run", package: "untrusted" },
      );
      assert.equal(install.status, 500);
      assert.match(JSON.stringify(await install.json()), /npm/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

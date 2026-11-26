import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@hydra/shared";
import {
  createProviderInstaller,
  PROVIDER_INSTALLS,
  type InstallationDependencies,
} from "../../src/providers/providerInstall.ts";
import { validClaudeSdkVersion } from "../../src/providers/claudeSdk.ts";
import {
  maintenanceEnvironment,
  maintenanceInvocation,
  runMaintenanceCommand,
} from "../../src/providers/maintenanceProcess.ts";
import {
  providerBinaryCandidates,
  providerInstallPrefix,
  resolveProviderBinary,
  PROVIDER_COMMANDS,
} from "../../src/providers/providerBinaries.ts";
import {
  ProviderBusyError,
  withProviderMaintenance,
} from "../../src/providers/maintenanceLock.ts";

function fixture(overrides: Partial<InstallationDependencies> = {}) {
  let installed = false;
  const calls: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
  }[] = [];
  const downloads: string[] = [];
  const dependencies: InstallationDependencies = {
    inspect: async () => ({ installed, version: installed ? "1.2.3" : null }),
    configuredBinary: (id) => PROVIDER_COMMANDS[id],
    busy: () => false,
    resolve: async (command) => `/fixture/${command}`,
    async run(command, args, _timeout, env) {
      calls.push({ command, args, env });
      installed = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    async installSdk() {
      installed = true;
      return { updated: true, before: null, after: "1.2.3" };
    },
    async download(url) {
      downloads.push(url);
      return "# mocked official installer\n";
    },
    platform: "linux",
    nodeMajor: 24,
    ...overrides,
  };
  return { ...createProviderInstaller(dependencies), calls, downloads };
}

const scratch = await mkdtemp(join(tmpdir(), "hydra-install-test-"));
const previousData = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = scratch;
test.after(async () => {
  if (previousData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousData;
  await rm(scratch, { recursive: true, force: true });
});

test("all six providers have verified install sources and connection instructions", async () => {
  for (const id of Object.keys(PROVIDER_INSTALLS) as ProviderId[]) {
    const info = await fixture().describe(id);
    assert.equal(info.installed, false);
    assert.equal(info.canInstall, true);
    assert.match(info.documentationUrl, /^https:\/\//);
    assert.match(info.accountUrl, /^https:\/\//);
    assert.ok(info.loginCommand);
    assert.ok(info.authNote);
  }
  assert.equal(
    PROVIDER_INSTALLS.grok.script,
    "https://x.ai/cli/install.sh",
    "never install a third-party Grok wrapper",
  );
});
test("npm installations use fixed public packages in an isolated prefix and retain no app credentials", async () => {
  for (const id of ["codex", "copilot", "kilocode"] as const) {
    const installer = fixture();
    assert.deepEqual(await installer.install(id), {
      provider: id,
      installed: true,
      version: "1.2.3",
    });
    assert.deepEqual(installer.calls[0]?.args, [
      "install",
      "--prefix",
      providerInstallPrefix(id),
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `${PROVIDER_INSTALLS[id].npm}@latest`,
    ]);
    assert.equal(installer.calls[0]?.env?.HYDRA_DB, undefined);
    assert.equal(installer.calls[0]?.env?.HYDRA_WORKER_SECRET, undefined);
    assert.equal(installer.calls[0]?.env?.OPENAI_API_KEY, undefined);
  }
});
test("native installers download only the provider source, use an explicit file and remove it afterwards", async () => {
  for (const id of ["cursor", "grok"] as const) {
    const installer = fixture();
    await installer.install(id);
    assert.deepEqual(installer.downloads, [PROVIDER_INSTALLS[id].script]);
    const script = installer.calls[0]?.args[0];
    assert.ok(script);
    await assert.rejects(stat(script), { code: "ENOENT" });
    assert.equal(installer.calls[0]?.command, "/fixture/bash");
  }
});
test("installed but unauthenticated providers are never installed again", async () => {
  const installer = fixture({
    inspect: async () => ({ installed: true, version: null }),
  });
  assert.deepEqual(await installer.install("codex"), {
    provider: "codex",
    installed: true,
    version: null,
  });
  assert.equal(installer.calls.length, 0);
});
test("missing SDK can be installed without loading a previous SDK", async () => {
  const installer = fixture();
  assert.deepEqual(await installer.install("claude"), {
    provider: "claude",
    installed: true,
    version: "1.2.3",
  });
  assert.equal(installer.calls.length, 0);
});
test("custom binary choices, missing npm and unmet runtime requirements give actionable failures", async () => {
  const custom = fixture({ configuredBinary: () => "/custom/not-installed" });
  assert.equal((await custom.describe("codex")).canInstall, false);
  await assert.rejects(custom.install("codex"), /custom binary/);
  const noNpm = fixture({ resolve: async () => null });
  await assert.rejects(noNpm.install("codex"), /npm/);
  const oldNode = fixture({ nodeMajor: 20 });
  await assert.rejects(oldNode.install("copilot"), /Node.js 22/);
  assert.equal(
    custom.calls.length + noNpm.calls.length + oldNode.calls.length,
    0,
  );
});
test("busy providers, command failures and detection failures do not report a successful install", async () => {
  await assert.rejects(
    fixture({ busy: () => true }).install("codex"),
    ProviderBusyError,
  );
  await assert.rejects(
    fixture({
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "SECRET MUST NOT LEAK",
      }),
    }).install("codex"),
    (error: Error) =>
      /installation failed/.test(error.message) &&
      !error.message.includes("SECRET"),
  );
  await assert.rejects(
    fixture({
      inspect: async () => ({ installed: false, version: null }),
    }).install("codex"),
    /could not detect/,
  );
});
test("concurrent maintenance deduplicates the same action and rejects a different one", async () => {
  let finish: (() => void) | undefined;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = withProviderMaintenance("test-provider", "install", () => work);
  assert.equal(
    withProviderMaintenance("test-provider", "install", () =>
      Promise.resolve(),
    ),
    first,
  );
  await assert.rejects(
    withProviderMaintenance("test-provider", "update", () => Promise.resolve()),
    ProviderBusyError,
  );
  finish?.();
  await first;
  await withProviderMaintenance("test-provider", "update", () =>
    Promise.resolve(),
  );
});
test("managed executables resolve without changing a custom path or process PATH", async () => {
  const candidate = providerBinaryCandidates("codex", "codex")[0];
  assert.ok(candidate);
  await mkdir(join(providerInstallPrefix("codex"), "node_modules", ".bin"), {
    recursive: true,
  });
  await writeFile(candidate, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const before = process.env.PATH;
  process.env.PATH = "/missing-fixture-path";
  try {
    assert.equal(await resolveProviderBinary("codex", "codex"), candidate);
    assert.equal(
      await resolveProviderBinary("codex", "/custom/missing-codex"),
      null,
    );
    assert.deepEqual(providerBinaryCandidates("codex", "custom-codex"), []);
    assert.equal(process.env.PATH, "/missing-fixture-path");
  } finally {
    process.env.PATH = before;
  }
});
test("maintenance environment excludes all Hydra state, settings and API secrets", async () => {
  const source = {
    PATH: "/fixture",
    HOME: "/fixture-home",
    HYDRA_DB: "private-db",
    HYDRA_DATA_DIR: "private-data",
    HYDRA_DATABASE_PATH: "private-path",
    HYDRA_SDK_DIR: "private-sdk",
    HYDRA_WORKER_SECRET: "secret",
    SETTINGS_FILE: "private-settings",
    OPENAI_API_KEY: "key",
    ANTHROPIC_API_KEY: "key",
    XAI_API_KEY: "key",
    CODEX_HOME: "/credential-dir",
  };
  assert.deepEqual(maintenanceEnvironment(source), {
    PATH: "/fixture",
    HOME: "/fixture-home",
  });
  const result = await runMaintenanceCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({db:process.env.HYDRA_DB??null,key:process.env.OPENAI_API_KEY??null}))",
    ],
    5000,
    maintenanceEnvironment(source),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { db: null, key: null });
});

test("SDK install versions cannot traverse or name the installation root", () => {
  for (const valid of ["1.2.3", "0.3.1-beta.2", "1.2.3+build.4"])
    assert.equal(validClaudeSdkVersion(valid), true);
  for (const invalid of [
    "..",
    ".",
    "../latest",
    "latest",
    "1.2.3/../x",
    "1.2.3;rm",
    "",
  ])
    assert.equal(validClaudeSdkVersion(invalid), false);
});

test("Windows npm installs invoke Node directly without interpreting shell metacharacters", () => {
  const args = [
    "install",
    "--prefix",
    "C:\\Users\\A & B\\provider",
    "@openai/codex@latest",
  ];
  const invocation = maintenanceInvocation(
    "C:\\Program Files\\nodejs\\npm.cmd",
    args,
    "win32",
  );
  assert.equal(invocation.command, process.execPath);
  assert.equal(
    invocation.args[0],
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  );
  assert.deepEqual(invocation.args.slice(1), args);
});

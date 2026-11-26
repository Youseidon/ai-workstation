import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderId,
  ProviderInstallResult,
  ProviderSetupInfo,
} from "@hydra/shared";
import { settings } from "../config/settings.ts";
import { resolveBinary } from "../infrastructure/process.ts";
import { runHub } from "../services/runs/runHub.ts";
import { getAdapter } from "./registry.ts";
import { installLatestClaudeSdk } from "./claudeSdk.ts";
import {
  PROVIDER_COMMANDS,
  providerInstallPath,
  providerInstallPrefix,
} from "./providerBinaries.ts";
import {
  maintenanceEnvironment,
  runMaintenanceCommand,
} from "./maintenanceProcess.ts";
import {
  ProviderBusyError,
  withProviderMaintenance,
} from "./maintenanceLock.ts";

interface InstallDefinition {
  npm?: string;
  script?: string;
  windowsScript?: string;
  docs: string;
  account: string;
  login: string;
  credentialKey: string | null;
  note: string;
}

export const PROVIDER_INSTALLS: Record<ProviderId, InstallDefinition> = {
  claude: {
    npm: "@anthropic-ai/claude-agent-sdk",
    docs: "https://platform.claude.com/docs/en/agent-sdk/typescript",
    account: "https://console.anthropic.com/settings/keys",
    login: "claude",
    credentialKey: "claude.apiKey",
    note: "Use an Anthropic API key below, or an existing Claude Code CLI login on this machine. Opening the account website alone does not authenticate the SDK.",
  },
  codex: {
    npm: "@openai/codex",
    docs: "https://developers.openai.com/codex/cli",
    account: "https://platform.openai.com/api-keys",
    login: "codex login --device-auth",
    credentialKey: "codex.apiKey",
    note: "Run the login command on the Hydra machine and finish the device sign-in in your browser, or save an OpenAI API key below.",
  },
  cursor: {
    script: "https://cursor.com/install",
    windowsScript: "https://cursor.com/install?win32=true",
    docs: "https://cursor.com/docs/cli/installation",
    account: "https://cursor.com/dashboard",
    login: "cursor-agent login",
    credentialKey: null,
    note: "Run this command on the Hydra machine. Cursor opens its browser sign-in and stores CLI credentials locally; a website login alone is not enough.",
  },
  grok: {
    script: "https://x.ai/cli/install.sh",
    windowsScript: "https://x.ai/cli/install.ps1",
    docs: "https://docs.x.ai/build/overview",
    account: "https://console.x.ai/",
    login: "grok login --device-auth",
    credentialKey: "grok.apiKey",
    note: "Run the device login on the Hydra machine and approve it in your browser, or save an xAI API key below. Some plans restrict CLI access.",
  },
  copilot: {
    npm: "@github/copilot",
    docs: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    account: "https://github.com/settings/personal-access-tokens/new",
    login: "copilot login",
    credentialKey: "copilot.githubToken",
    note: "Sign in through the CLI on the Hydra machine, or use a fine-grained GitHub token with Copilot Requests permission. If your login only uses an OS credential store, review Assume authenticated in provider settings.",
  },
  kilocode: {
    npm: "@kilocode/cli",
    docs: "https://kilo.ai/docs/cli",
    account: "https://app.kilo.ai/",
    login: "kilo auth login",
    credentialKey: null,
    note: "Run the login command on the Hydra machine and follow its account connection prompts. Credentials are stored by Kilo, not by this browser.",
  },
};

export interface InstallationDependencies {
  inspect(
    id: ProviderId,
  ): Promise<{ installed: boolean; version: string | null }>;
  configuredBinary(id: Exclude<ProviderId, "claude">): string;
  busy(id: ProviderId): boolean;
  resolve: typeof resolveBinary;
  run: typeof runMaintenanceCommand;
  installSdk: typeof installLatestClaudeSdk;
  download(url: string): Promise<string>;
  platform: NodeJS.Platform;
  nodeMajor: number;
}

async function downloadInstaller(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body)
    throw new Error(
      `Official installer download failed (HTTP ${response.status}). Try again or use the linked installation guide.`,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new Error(
          "Official installer was larger than expected. Use the installation guide.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createProviderInstaller(deps: InstallationDependencies) {
  async function describe(id: ProviderId): Promise<ProviderSetupInfo> {
    const definition = PROVIDER_INSTALLS[id];
    const detected = await deps.inspect(id);
    let reason: string | null = null;
    if (
      id !== "claude" &&
      !detected.installed &&
      deps.configuredBinary(id) !== PROVIDER_COMMANDS[id]
    )
      reason =
        "A custom binary is configured. Restore the default Binary in provider settings before installing the standard CLI.";
    else if (id === "copilot" && deps.nodeMajor < 22)
      reason =
        "GitHub Copilot CLI requires Node.js 22 or later on the Hydra machine.";
    else if (definition.npm && (await deps.resolve("npm")) === null)
      reason =
        "Install Node.js and npm on the Hydra machine first, then retry.";
    else if (
      definition.script &&
      (await deps.resolve(
        deps.platform === "win32" ? "powershell" : "bash",
      )) === null
    )
      reason =
        deps.platform === "win32"
          ? "PowerShell is needed for this provider's official installer."
          : "Bash is needed for this provider's official installer.";
    else if (!["linux", "darwin", "win32"].includes(deps.platform))
      reason =
        "Use this provider's installation guide for this operating system.";
    return {
      provider: id,
      installed: detected.installed,
      canInstall: reason === null,
      reason,
      source: definition.npm
        ? `npm · ${definition.npm}`
        : ((deps.platform === "win32"
            ? definition.windowsScript
            : definition.script) ?? definition.docs),
      documentationUrl: definition.docs,
      accountUrl: definition.account,
      loginCommand: definition.login,
      authNote: definition.note,
      credentialKey: definition.credentialKey,
    };
  }

  function install(id: ProviderId): Promise<ProviderInstallResult> {
    return withProviderMaintenance(id, "install", async () => {
      if (id !== "claude" && deps.busy(id))
        throw new ProviderBusyError(
          "This provider is running. Install it after its runs have finished.",
        );
      const before = await deps.inspect(id);
      if (before.installed)
        return { provider: id, installed: true, version: before.version };
      const descriptor = await describe(id);
      if (!descriptor.canInstall)
        throw new Error(descriptor.reason ?? "Installation is not available.");
      if (id === "claude") {
        const result = await deps.installSdk();
        return { provider: id, installed: true, version: result.after };
      }
      const definition = PROVIDER_INSTALLS[id];
      const env: NodeJS.ProcessEnv = {
        ...maintenanceEnvironment(),
        PATH: providerInstallPath(id),
      };
      const prefix = providerInstallPrefix(id);
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      if (definition.npm) {
        const npm = await deps.resolve("npm");
        if (npm === null)
          throw new Error("npm is no longer available. Retry installation.");
        const result = await deps.run(
          npm,
          [
            "install",
            "--prefix",
            prefix,
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            `${definition.npm}@latest`,
          ],
          240_000,
          env,
        );
        if (result.code !== 0)
          throw new Error(
            "Package installation failed or timed out. Check network access and permissions on the Hydra machine, then retry or use the installation guide.",
          );
      } else {
        const shell = await deps.resolve(
          deps.platform === "win32" ? "powershell" : "bash",
        );
        const url =
          deps.platform === "win32"
            ? definition.windowsScript
            : definition.script;
        if (shell === null || !url)
          throw new Error(
            "The official installer is unavailable on this platform.",
          );
        const directory = await mkdtemp(
          join(tmpdir(), "hydra-provider-install-"),
        );
        try {
          const script = join(
            directory,
            deps.platform === "win32" ? "install.ps1" : "install.sh",
          );
          await writeFile(script, await deps.download(url), { mode: 0o600 });
          if (id === "grok") env.GROK_BIN_DIR = join(prefix, "bin");
          const args =
            deps.platform === "win32"
              ? [
                  "-NoProfile",
                  "-NonInteractive",
                  "-ExecutionPolicy",
                  "Bypass",
                  "-File",
                  script,
                ]
              : [script];
          const result = await deps.run(shell, args, 240_000, env);
          if (result.code !== 0)
            throw new Error(
              "The official installer failed or timed out. Check the linked guide and any account requirements, then retry. No login was started by Hydra.",
            );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      const after = await deps.inspect(id);
      if (!after.installed)
        throw new Error(
          "The installer finished, but Hydra could not detect the executable. Check Binary in provider settings and use Re-detect.",
        );
      return { provider: id, installed: true, version: after.version };
    });
  }
  return { describe, install };
}

const installer = createProviderInstaller({
  async inspect(id) {
    const report = await getAdapter(id).checkAvailability();
    return {
      installed:
        report.installed ??
        (id === "claude" ? report.version !== null : report.binary !== null),
      version: report.version,
    };
  },
  configuredBinary: (id) => settings[id].binary,
  busy: (id) => runHub.snapshots().some((run) => run.provider === id),
  resolve: resolveBinary,
  run: runMaintenanceCommand,
  installSdk: installLatestClaudeSdk,
  download: downloadInstaller,
  platform: process.platform,
  nodeMajor: Number(process.versions.node.split(".")[0]),
});
export const describeProviderSetup = installer.describe;
export const installProvider = installer.install;

import type { ProviderId, ProviderUpdateResult } from "@hydra/shared";
import { getAdapter } from "./registry.ts";
import { installLatestClaudeSdk } from "./claudeSdk.ts";
import { runMaintenanceCommand as runCommand } from "./maintenanceProcess.ts";
import {
  ProviderBusyError,
  withProviderMaintenance,
} from "./maintenanceLock.ts";
import { runHub } from "../services/runs/runHub.ts";

export { ProviderBusyError } from "./maintenanceLock.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;

const CLI_UPDATE_ARGS: Record<Exclude<ProviderId, "claude">, string[]> = {
  codex: ["update"],
  cursor: ["update"],
  grok: ["update"],
  copilot: ["update"],
  kilocode: ["upgrade"],
};

export function updateProvider(id: ProviderId): Promise<ProviderUpdateResult> {
  return withProviderMaintenance(id, "update", () =>
    id === "claude" ? updateClaude() : updateCli(id),
  );
}

async function updateClaude(): Promise<ProviderUpdateResult> {
  return { provider: "claude", ...(await installLatestClaudeSdk()) };
}

async function updateCli(
  id: Exclude<ProviderId, "claude">,
): Promise<ProviderUpdateResult> {
  const adapter = getAdapter(id);
  if (runHub.snapshots().some((run) => run.provider === id)) {
    throw new ProviderBusyError(
      `${adapter.label} has a run in progress — update it once the run ends`,
    );
  }
  const { binary } = await adapter.checkAvailability();
  if (binary === null)
    throw new Error(
      `${adapter.label} is not installed, so there is nothing to update`,
    );

  const before = await adapter.getVersion();
  const result = await runCommand(
    binary,
    CLI_UPDATE_ARGS[id],
    UPDATE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout)
      .trim()
      .split(/\r?\n/)
      .slice(-6)
      .join("\n");
    throw new Error(
      `${adapter.label} update failed: ${output || `exit ${result.code ?? "timeout"}`}`,
    );
  }
  const after = await adapter.getVersion();
  return { provider: id, updated: after !== before, before, after };
}

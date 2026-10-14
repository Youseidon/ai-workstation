import type { ProviderId, ProviderUpdateResult } from "@agent-console/shared";
import { getAdapter } from "./adapters/registry.ts";
import { installLatestClaudeSdk } from "./lib/claudeSdk.ts";
import { runCommand } from "./lib/process.ts";
import { runHub } from "./runHub.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;

/** Each CLI's own self-update subcommand. */
const CLI_UPDATE_ARGS: Record<Exclude<ProviderId, "claude">, string[]> = {
  codex: ["update"],
  cursor: ["update"],
  grok: ["update"],
  copilot: ["update"],
  kilocode: ["upgrade"],
};

/** The provider has a live run whose binary an update would replace under it. */
export class ProviderBusyError extends Error {}

const inflight = new Map<ProviderId, Promise<ProviderUpdateResult>>();

/**
 * Updates one provider in place, without a restart: Claude's SDK is loaded per
 * run and the CLIs are resolved from PATH per spawn, so the next run of either
 * uses whatever this installed.
 */
export function updateProvider(id: ProviderId): Promise<ProviderUpdateResult> {
  const running = inflight.get(id);
  if (running !== undefined) return running;
  const update = (id === "claude" ? updateClaude() : updateCli(id)).finally(() => {
    inflight.delete(id);
  });
  inflight.set(id, update);
  return update;
}

async function updateClaude(): Promise<ProviderUpdateResult> {
  // No busy check: the new SDK lands in its own directory, so runs in flight
  // keep the copy they started with.
  return { provider: "claude", ...(await installLatestClaudeSdk()) };
}

async function updateCli(id: Exclude<ProviderId, "claude">): Promise<ProviderUpdateResult> {
  const adapter = getAdapter(id);
  if (runHub.snapshots().some((run) => run.provider === id)) {
    throw new ProviderBusyError(`${adapter.label} has a run in progress — update it once the run ends`);
  }
  const { binary } = await adapter.checkAvailability();
  if (binary === null) throw new Error(`${adapter.label} is not installed, so there is nothing to update`);

  const before = await adapter.getVersion();
  const result = await runCommand(binary, CLI_UPDATE_ARGS[id], UPDATE_TIMEOUT_MS);
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-6).join("\n");
    throw new Error(`${adapter.label} update failed: ${output || `exit ${result.code ?? "timeout"}`}`);
  }
  const after = await adapter.getVersion();
  return { provider: id, updated: after !== before, before, after };
}

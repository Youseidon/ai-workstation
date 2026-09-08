import type { AdapterEvent, ProviderId, ProviderInfo, ProviderUsage } from "@agent-console/shared";
import type { Logger } from "../lib/logger.ts";

/**
 * "consult" forces the provider's read-only sandbox and ignores Host access.
 * Adapters must not read settings.hostAccess when this is "consult".
 */
export type PermissionOverride = "inherit" | "consult" | "handoff";

export interface RunOptions {
  /** Correlates every event of one run, and is the key for `interrupt()`. */
  runId: string;
  /** Working directory the agent operates in. Same for every provider. */
  cwd: string;
  /** Aborted when the client disconnects or the run is cancelled. */
  signal: AbortSignal;
  /**
   * Per-run model override chosen in the UI. `null` means "use the model from
   * settings"; adapters must not read `settings.<id>.model` directly any more.
   */
  model: string | null;
  /** Server-side log; adapter stderr goes here, never to the browser. */
  log: Logger;
  permissionOverride: PermissionOverride;
}

export interface AvailabilityReport {
  available: boolean;
  /** Why the provider cannot be used — shown as the switcher tooltip. */
  reason: string | null;
  version: string | null;
  /** Resolved binary path for spawn-based providers. */
  binary: string | null;
}

export interface AgentAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly transport: "sdk" | "spawn";
  /** False when the provider never reports token counts (do not fake them). */
  readonly reportsTokens: boolean;
  /** The effective permission/approval mode, for display. */
  readonly permissionMode: string;
  /** The model configured in settings — the fallback when a run sends none. */
  readonly model: string | null;

  /** Full detection result, cached by the registry. */
  checkAvailability(): Promise<AvailabilityReport>;
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  /**
   * Account-level usage credits from this provider's own API.
   *
   * Return `available: false` when the provider has no usage endpoint, the
   * login cannot see plan limits (API key instead of a subscription), or the
   * request failed. Never invent a daily or weekly figure the API omitted.
   */
  getAccountUsage(): Promise<ProviderUsage>;

  run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void>;
  interrupt(runId: string): Promise<void>;
}

export async function toProviderInfo(adapter: AgentAdapter): Promise<ProviderInfo> {
  const report = await adapter.checkAvailability();
  return {
    id: adapter.id,
    label: adapter.label,
    available: report.available,
    reason: report.reason,
    savedPromptExecuteAvailable: report.available,
    savedPromptExecuteReason: report.available ? null : report.reason,
    version: report.version,
    transport: adapter.transport,
    binary: report.binary,
    reportsTokens: adapter.reportsTokens,
    permissionMode: adapter.permissionMode,
    model: adapter.model,
  };
}

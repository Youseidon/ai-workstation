import type { ProcessIdentity } from "./execution.ts";
import type { AdapterEvent, ProviderId, ProviderUsage } from "@hydra/shared";
import type { StationPolicy } from "@hydra/shared";
import type { Logger } from "../utils/logger.ts";

export type PermissionOverride = "inherit" | "consult" | "handoff";

export interface RunOptions {
  stationPolicy?: StationPolicy;
  launcherPath?: string | null;
  deadlineMs?:number;
  onSpawn?: (identity: ProcessIdentity) => void;
  runId: string;
  cwd: string;
  signal: AbortSignal;
  model: string | null;
  log: Logger;
  permissionOverride: PermissionOverride;
  resumeSessionId?: string | null;
}

export interface AvailabilityReport {
  installed?: boolean;
  available: boolean;
  reason: string | null;
  version: string | null;
  binary: string | null;
}

export interface AgentAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly transport: "sdk" | "spawn";
  readonly reportsTokens: boolean;
  readonly permissionMode: string;
  readonly model: string | null;

  checkAvailability(): Promise<AvailabilityReport>;
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string | null>;
  getAccountUsage(): Promise<ProviderUsage>;

  run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void>;
  interrupt(runId: string): Promise<void>;
  sendUserMessage?(runId: string, text: string): Promise<boolean>;
}

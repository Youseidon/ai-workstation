"use client";

import Link from "next/link";
import {
  modelLabel,
  type ProviderInfo,
  type ProviderUsage,
} from "@hydra/shared";
import { AgentAvatar } from "@/features/providers/components/AgentAvatar";
import { Switch } from "@/components/ui/Switch";
import { modelChoice } from "@/features/providers/lib/modelChoice";
import { providerAvailability, usageState } from "../lib/configuration";
import type { ProviderDetailTab } from "./ProviderConfigurationDialog";
import styles from "./configuration.module.css";

export function ProviderConfigurationRow({
  info,
  enabled,
  connected,
  busyCount,
  pin,
  pending,
  disabled,
  onToggle,
  onOpen,
  usage,
  usageLoading,
  usageError,
  checkedAt,
  credentialSet,
  reasoningOverride,
}: {
  info: ProviderInfo;
  enabled: boolean | null;
  connected: boolean;
  busyCount: number;
  pin: string | null | undefined;
  pending: number;
  disabled: boolean;
  onToggle(next: boolean): void;
  onOpen(tab: ProviderDetailTab): void;
  usage: ProviderUsage | null;
  usageLoading: boolean;
  usageError: string | null;
  checkedAt: number;
  credentialSet: boolean;
  reasoningOverride: boolean;
}) {
  const choice = modelChoice(info, pin);
  const telemetry = usageState(usage, usageLoading, usageError, checkedAt);
  return (
    <li
      id={`agent-${info.id}`}
      className={styles.providerRow}
      data-enabled={enabled}
    >
      <button
        type="button"
        className={styles.providerIdentity}
        onClick={() => onOpen("settings")}
        aria-label={`Configure ${info.label}`}
        aria-haspopup="dialog"
      >
        <AgentAvatar
          provider={info.id}
          activity={
            connected && busyCount > 0
              ? "thinking"
              : connected && info.available
                ? "idle"
                : "offline"
          }
          size={32}
        />
        <span>
          <strong>{info.label}</strong>
          <span
            className={styles.availability}
            data-warning={connected && enabled === true && !info.available}
          >
            {providerAvailability(info, enabled, connected)}
          </span>
        </span>
      </button>
      <div className={styles.providerModel}>
        <span className={styles.label}>
          {info.modelSelectionMode === "auto"
            ? "Auto Select"
            : choice.active && pin !== null
              ? "Browser pin"
              : "Effective default"}
        </span>
        <strong title={choice.effective ?? "Provider default"}>
          {modelLabel(info.id, choice.effective ?? null, info.models) ??
            "Provider default"}
        </strong>
        <span>
          {choice.saved && !choice.active ? "Saved pin inactive · " : ""}
          {info.reasoningEffort} effort
          {reasoningOverride ? " · override" : " · inherited"}
        </span>
      </div>
      <div className={styles.providerStatus}>
        {busyCount > 0 ? (
          <Link className={styles.running} href="/agents">
            {connected ? "●" : "◌"} {busyCount}{" "}
            {connected ? "active" : "last known"} ↗
          </Link>
        ) : (
          <span>
            {credentialSet
              ? "API key stored"
              : info.available && connected
                ? "Detection passed"
                : "Check setup"}
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen("usage")}
          data-warning={telemetry.tone === "warning"}
        >
          {telemetry.label} ›
        </button>
      </div>
      <div className={styles.providerActions}>
        <label>
          <span>
            {enabled === null ? "Unknown" : enabled ? "Enabled" : "Disabled"}
          </span>
          <Switch
            checked={enabled === true}
            disabled={disabled || enabled === null}
            aria-label={`Enable ${info.label}`}
            onCheckedChange={onToggle}
          />
        </label>
        <button
          type="button"
          onClick={() => onOpen("settings")}
          aria-haspopup="dialog"
          className={styles.configureButton}
        >
          {pending > 0 ? (
            <span className="text-warning">{pending} unsaved</span>
          ) : (
            "Configure"
          )}
          <span aria-hidden>↗</span>
        </button>
      </div>
      {enabled && !info.available && info.reason && (
        <p className={styles.providerReason}>{info.reason}</p>
      )}
    </li>
  );
}

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
import { providerAvailability, providerInstalled } from "../lib/configuration";
import type { ProviderDetailTab } from "./ProviderConfigurationDialog";
import { ProviderUsagePreview } from "./ProviderUsagePreview";
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
  canMaintain,
  maintenanceBusy,
  onMaintain,
  onSetup,
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
  canMaintain: boolean;
  maintenanceBusy: boolean;
  onMaintain(): void;
  onSetup(): void;
}) {
  const installed = providerInstalled(info);
  const choice = modelChoice(info, pin);
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
        aria-label={`Open ${info.label} configuration`}
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
          {pending > 0 && (
            <span id={`drafts-${info.id}`} className={styles.providerDrafts}>
              {pending} unsaved
            </span>
          )}
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
        ) : installed && !info.available ? (
          <button type="button" onClick={onSetup} aria-haspopup="dialog">
            Check setup ›
          </button>
        ) : (
          <span>
            {credentialSet
              ? "API key stored"
              : info.available && connected
                ? "Detection passed"
                : "Check setup"}
          </span>
        )}
        <ProviderUsagePreview
          label={info.label}
          usage={usage}
          loading={usageLoading}
          error={usageError}
          checkedAt={checkedAt}
          onOpen={() => onOpen("usage")}
        />
      </div>
      <div className={styles.providerActions}>
        <button
          type="button"
          className={styles.maintenanceButton}
          aria-label={`${installed ? "Update" : "Install"} ${info.label}`}
          onClick={onMaintain}
          disabled={
            disabled ||
            maintenanceBusy ||
            !canMaintain ||
            (installed && info.transport === "spawn" && busyCount > 0)
          }
          title={
            !canMaintain
              ? "Only the installation owner can install or update shared executables"
              : installed && busyCount > 0 && info.transport === "spawn"
                ? "Wait for this provider’s runs to finish before updating"
                : `${installed ? "Update" : "Install"} ${info.label} on the Hydra machine`
          }
        >
          {maintenanceBusy
            ? "Working…"
            : `${installed ? "Update" : "Install"} ${info.transport === "sdk" ? "SDK" : "CLI"}`}
        </button>
      </div>
      <div className={styles.providerToggle}>
        <Switch
          checked={enabled === true}
          disabled={disabled || enabled === null}
          aria-label={`Enable ${info.label}`}
          onCheckedChange={onToggle}
        />
      </div>
      <button
        type="button"
        onClick={() => onOpen("settings")}
        aria-label={`Configure ${info.label}`}
        title={`Configure ${info.label}${pending > 0 ? ` · ${pending} unsaved` : ""}`}
        aria-describedby={pending > 0 ? `drafts-${info.id}` : undefined}
        aria-haspopup="dialog"
        className={styles.configureButton}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m9 3-.6 2.2-2 .9-2.1-.7-2 3.4 1.5 1.6-.2 2.3L2 14.4l2 3.4 2.2-.5 1.9 1.2.5 2.5h4l.7-2.3 2-1 2.2.6 2-3.4-1.6-1.7.1-2.2 1.8-1.6-2-3.4-2.2.5-1.9-1.2L13 3H9Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <circle
            cx="11"
            cy="12"
            r="3"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      </button>
      {enabled && !info.available && info.reason && (
        <p className={styles.providerReason}>{info.reason}</p>
      )}
    </li>
  );
}

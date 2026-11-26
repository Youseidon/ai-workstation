"use client";

import Link from "next/link";
import {
  formatElapsed,
  formatTokens,
  modelLabel,
  type ProviderInfo,
  type ProviderUsage,
} from "@hydra/shared";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { SettingsGroupPanel } from "@/features/settings/components/SettingsGroupPanel";
import type { SettingsDraftState } from "@/features/settings/lib/drafts";
import { modelChoice } from "@/features/providers/lib/modelChoice";
import type { AgentState } from "@/features/runs/lib/agentState";
import { AskChip, runOwnerHref } from "@/features/runs/components/RunStatus";
import {
  PROVIDER_SETTINGS_GROUP,
  usageState,
  providerInstalled,
} from "../lib/configuration";
import { BrowserModelPicker } from "./BrowserModelPicker";
import { UsageBlock } from "./usage";
import styles from "./configuration.module.css";

export type ProviderDetailTab = "settings" | "usage" | "activity";

export function ProviderConfigurationDialog({
  info,
  providers,
  tab,
  onTab,
  onProvider,
  onClose,
  draftState,
  pin,
  onPick,
  onClear,
  onSaved,
  disabled,
  usage,
  usageLoading,
  usageError,
  checkedAt,
  onRefreshUsage,
  updating,
  canMaintain,
  onInstall,
  onUpdate,
  agent,
  runTabIds,
  onStop,
  notice,
}: {
  info: ProviderInfo;
  providers: ProviderInfo[];
  tab: ProviderDetailTab;
  onTab(tab: ProviderDetailTab): void;
  onProvider(id: ProviderInfo["id"]): void;
  onClose(): void;
  draftState: SettingsDraftState;
  pin: string | null | undefined;
  onPick(value: string | null): void;
  onClear(): void;
  onSaved(): void;
  disabled: boolean;
  usage: ProviderUsage | null;
  usageLoading: boolean;
  usageError: string | null;
  checkedAt: number;
  onRefreshUsage(): void;
  updating: boolean;
  canMaintain: boolean;
  onInstall(): void;
  onUpdate(): void;
  agent: AgentState;
  runTabIds: Record<string, string>;
  onStop(runId: string): void;
  notice: string | null;
}) {
  const choice = modelChoice(info, pin);
  const busy = agent.run !== null || agent.consultCount > 0;
  const telemetry = usageState(usage, usageLoading, usageError, checkedAt);
  const label = (value: string | null | undefined) =>
    value == null
      ? "Provider default"
      : (modelLabel(info.id, value, info.models) ?? value);
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${info.label} configuration`}
      description="Account defaults apply across workspaces. Unsaved edits are retained while this page is open."
      bodyClassName="px-5 py-3"
      headerActions={
        <label className={styles.providerSwitch}>
          <span className="sr-only">Switch provider</span>
          <select
            aria-label="Switch provider"
            value={info.id}
            onChange={(event) => {
              const provider = providers.find(
                (entry) => entry.id === event.target.value,
              );
              if (provider) onProvider(provider.id);
            }}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close · keep drafts
        </Button>
      }
    >
      <nav className={styles.detailTabs} aria-label="Provider details">
        {(["settings", "usage", "activity"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => onTab(value)}
          >
            {value === "settings"
              ? "Model & settings"
              : value === "usage"
                ? "Usage & maintenance"
                : `Active work${busy ? ` · ${Number(agent.run !== null) + agent.consultCount}` : ""}`}
          </button>
        ))}
      </nav>
      {disabled && (
        <p className={styles.warning} role="status">
          Backend disconnected — last known configuration. Reconnect before
          saving or running maintenance.
        </p>
      )}
      {notice !== null && (
        <p className={styles.feedback} role="status">
          {notice}
        </p>
      )}
      {tab === "settings" && (
        <>
          <section
            className={styles.modelSummary}
            aria-label="Configured and effective model"
          >
            <dl>
              <div>
                <dt>Effective in this browser</dt>
                <dd>
                  {label(choice.effective)}
                  <small>
                    {info.modelSelectionMode === "auto"
                      ? "Auto Select owns the choice"
                      : choice.active && pin !== null
                        ? "Browser pin applies"
                        : "Server default after policy"}{" "}
                    · {info.reasoningEffort} effort
                  </small>
                </dd>
              </div>
              <div>
                <dt>Saved provider default</dt>
                <dd>
                  {label(info.configuredModel)}
                  {info.configuredModel !== null &&
                    (info.modelSelectionMode === "auto" ||
                      info.configuredModel !== info.model) && (
                      <small className="text-warning">
                        Preserved · inactive under current policy
                      </small>
                    )}
                </dd>
              </div>
              <div>
                <dt>Browser pin</dt>
                <dd>
                  {choice.saved && pin !== null
                    ? label(pin)
                    : "Following server settings"}
                  {choice.saved && (
                    <small
                      className={
                        choice.active ? "text-fg-muted" : "text-warning"
                      }
                    >
                      {choice.active
                        ? "Saved in this browser"
                        : "Preserved · inactive under current policy or effort"}
                    </small>
                  )}
                </dd>
              </div>
            </dl>
            <details>
              <summary>
                Change browser model{" "}
                <span>Saved immediately · this browser only</span>
              </summary>
              <div className="py-3">
                <BrowserModelPicker
                  provider={info}
                  selected={choice.effective ?? null}
                  pinned={choice.saved}
                  onSelect={onPick}
                  onClear={onClear}
                />
                {choice.saved && info.modelSelectionMode === "auto" && (
                  <p className="mt-2 text-xs text-fg-dim">
                    Your browser pin remains saved. Restore Manual to use an
                    eligible pin.
                  </p>
                )}
              </div>
            </details>
          </section>
          <SettingsGroupPanel
            key={info.id}
            group={PROVIDER_SETTINGS_GROUP[info.id]}
            header={false}
            compact
            draftState={draftState}
            excludeKeys={[`${info.id}.enabled`]}
            disabled={disabled}
            onSaved={onSaved}
          />
        </>
      )}
      {tab === "usage" && (
        <div className={styles.detailBody}>
          <section>
            <div className={styles.sectionHeading}>
              <h3>Plan usage</h3>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                loading={usageLoading}
                onClick={onRefreshUsage}
              >
                Refresh usage
              </Button>
            </div>
            <p
              role="status"
              className={
                telemetry.tone === "warning"
                  ? "text-xs text-warning"
                  : "text-xs text-fg-muted"
              }
            >
              {telemetry.label}
            </p>
            {usageError !== null && (
              <p role="alert" className="mt-2 text-xs text-danger">
                {usageError}
                {usage !== null ? " · Showing the last fetched sample." : ""}
              </p>
            )}
            {usage?.reason && (
              <p className="mt-2 text-xs text-fg-muted">{usage.reason}</p>
            )}
            <UsageBlock
              usage={usage}
              loading={usageLoading && usage === null}
              available
            />
            {usage?.fetchedAt && (
              <p className="mt-2 text-xs text-fg-dim">
                Fetched {new Date(usage.fetchedAt).toLocaleString()} · each
                allowance has its own reset
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-3 text-sm font-medium">
              Installation &amp; permissions
            </h3>
            <dl className={styles.metadata}>
              <div>
                <dt>Version</dt>
                <dd>{info.version ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Binary / transport</dt>
                <dd>{info.binary ?? info.transport}</dd>
              </div>
              <div>
                <dt>Effective permission</dt>
                <dd>{info.permissionMode}</dd>
              </div>
              <div>
                <dt>Command enforcement</dt>
                <dd>{info.commandEnforcement ?? "cooperative"}</dd>
              </div>
              <div>
                <dt>Detection</dt>
                <dd>
                  {info.available
                    ? "Available for new runs"
                    : (info.reason ?? "Unavailable")}
                </dd>
              </div>
            </dl>
            <Button
              size="sm"
              variant="secondary"
              loading={updating}
              onClick={providerInstalled(info) ? onUpdate : onInstall}
              disabled={
                disabled ||
                !canMaintain ||
                updating ||
                (providerInstalled(info) && info.transport === "spawn" && busy)
              }
            >
              {`${providerInstalled(info) ? "Update" : "Install"} ${info.transport === "sdk" ? "SDK" : "CLI"}`}
            </Button>
            {providerInstalled(info) && (
              <Button size="sm" variant="ghost" onClick={onInstall}>
                Connect account
              </Button>
            )}
            <p className="mt-2 text-xs text-fg-dim">
              {busy && info.transport === "spawn"
                ? "CLI updates require this provider to be idle."
                : "New runs use the updated version; no restart needed."}
            </p>
          </section>
        </div>
      )}
      {tab === "activity" && (
        <section className={styles.detailBody}>
          <Link className={styles.textLink} href="/agents">
            Open Live fleet → transcripts, active consults &amp; stop controls
          </Link>
          <Link className={styles.textLink} href="/activity">
            Run history &amp; outcomes →
          </Link>
          {!busy && (
            <p className="text-sm text-fg-muted">
              No active work reported for this provider.
            </p>
          )}
          {agent.run !== null && (
            <div>
              <p className="mb-3 text-sm text-fg-muted">{agent.caption}</p>
              <dl className={styles.metadata}>
                <div>
                  <dt>Workspace</dt>
                  <dd>{agent.run.workspace.name}</dd>
                </div>
                <div>
                  <dt>Elapsed</dt>
                  <dd>{formatElapsed(agent.run.elapsedMs)}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    {agent.run.usage === null
                      ? "Not reported"
                      : formatTokens(agent.run.usage.totalTokens)}
                  </dd>
                </div>
              </dl>
              <div className="flex gap-2">
                <Link
                  className={styles.textLink}
                  href={runOwnerHref(agent.run, runTabIds)}
                >
                  View run &amp; transcript →
                </Link>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={disabled}
                  onClick={() => {
                    if (agent.run) onStop(agent.run.runId);
                  }}
                >
                  Stop
                </Button>
              </div>
            </div>
          )}
          {agent.consultCount > 0 && (
            <div>
              <h3 className="mb-2 text-sm">Active consults</h3>
              <div className="flex flex-wrap gap-2">
                {agent.consults.map((consult) => (
                  <AskChip
                    key={consult.runId}
                    run={consult}
                    stale={disabled}
                    onStop={() => {
                      if (!disabled) onStop(consult.runId);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </Modal>
  );
}

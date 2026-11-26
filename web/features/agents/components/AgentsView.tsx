"use client";

import { useEffect, useState } from "react";
import {
  isModelAccessTier,
  isModelSelectionMode,
  isReasoningEffort,
  MODEL_ACCESS_TIER_INFO,
  type ProviderId,
  type ProviderUpdateResult,
  type SettingValue,
} from "@hydra/shared";
import { apiFetch } from "@/api/http";
import { SERVER_URL } from "@/api/serverUrl";
import {
  SidebarCollection,
  SidebarGroup,
  SidebarRow,
} from "@/components/layout/SidebarCollection";
import { Button } from "@/components/ui/Button";
import { useIdentity } from "@/contexts/identity";
import { useProviderSetup } from "../hooks/useProviderSetup";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { providerInstalled } from "../lib/configuration";
import { useHydra } from "@/hooks/useHydra";
import { useModelSelection } from "@/features/providers/hooks/useModelSelection";
import { useProviderUsage } from "@/features/providers/hooks/useProviderUsage";
import { useSettings } from "@/features/settings/hooks/useSettings";
import { SettingsGroupDialog } from "@/features/settings/components/SettingsGroupDialog";
import {
  GROUP_BLURB,
  GROUP_TITLE,
} from "@/features/settings/lib/settingsGroups";
import {
  dirtySettings,
  type SettingsDraftState,
} from "@/features/settings/lib/drafts";
import { agentState } from "@/features/runs/lib/agentState";
import { useStopCenter } from "@/features/stop/components/StopCenter";
import {
  PROVIDER_SETTINGS_GROUP,
  sharedSettingsGroups,
} from "../lib/configuration";
import { ModelPolicy } from "./ModelPolicy";
import { ProviderConfigurationRow } from "./ProviderConfigurationRow";
import {
  ProviderConfigurationDialog,
  type ProviderDetailTab,
} from "./ProviderConfigurationDialog";
import styles from "./configuration.module.css";

export function AgentsView({ draftState }: { draftState: SettingsDraftState }) {
  const {
    providers,
    runs,
    items,
    lastRun,
    connection,
    runTabIds,
    refreshProviders,
  } = useHydra();
  const { user } = useIdentity();
  const setup = useProviderSetup(refreshProviders);
  const [settingUp, setSettingUp] = useState<ProviderId | null>(null);
  const setupProvider = providers.find((provider) => provider.id === settingUp);
  const openSetup = (id: ProviderId) => {
    setSettingUp(id);
    void setup.load(id);
  };
  const stopCenter = useStopCenter();
  const settings = useSettings(SERVER_URL);
  const credits = useProviderUsage(true);
  const models = useModelSelection(providers);
  const [configuring, setConfiguring] = useState<ProviderId | null>(null);
  const [tab, setTab] = useState<ProviderDetailTab>("settings");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updating, setUpdating] = useState<ProviderId[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const connected = connection === "open";
  const disabled = settings.saving || !connected || settings.snapshot === null;
  const fields = settings.snapshot?.fields ?? [];
  const dirty = dirtySettings(fields, draftState.drafts);
  const groups = sharedSettingsGroups(settings.snapshot?.groups ?? []);
  const selected = providers.find((provider) => provider.id === configuring);
  const tierValue = fields.find(
    (field) => field.key === "models.accessTier",
  )?.value;
  const modeValue = fields.find(
    (field) => field.key === "models.selectionMode",
  )?.value;
  const effortValue = fields.find(
    (field) => field.key === "models.reasoningEffort",
  )?.value;
  const tier = isModelAccessTier(tierValue) ? tierValue : "all";
  const mode = isModelSelectionMode(modeValue) ? modeValue : "manual";
  const effort = isReasoningEffort(effortValue) ? effortValue : "medium";

  useEffect(() => {
    if (dirty.length === 0) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty.length]);

  const afterSave = () => {
    void settings.reload();
    void refreshProviders();
  };
  const saveImmediate = async (
    key: string,
    value: SettingValue,
    message: string,
  ) => {
    if (disabled) return;
    setNotice(null);
    const focused = document.activeElement;
    const choiceGroup = focused?.closest('[role="radiogroup"]');
    const result = await settings.save({ [key]: value });
    if (result.ok) {
      await refreshProviders();
      setNotice(message);
    }
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      const target =
        choiceGroup?.querySelector('[role="radio"][aria-checked="true"]') ??
        focused;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    });
  };
  const detect = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const response = await apiFetch(
        new URL("/api/providers?refresh=1", SERVER_URL),
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(`Provider detection failed (${response.status})`);
      await refreshProviders();
      setNotice("Provider detection refreshed.");
    } catch (cause) {
      setDetectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
    }
  };
  const update = async (id: ProviderId, label: string) => {
    setUpdating((current) => [...current, id]);
    setNotice(`Updating ${label}…`);
    try {
      const response = await apiFetch(
        new URL(`/api/providers/${id}/update`, SERVER_URL),
        { method: "POST" },
      );
      const body = (await response.json()) as ProviderUpdateResult & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? `update failed (${response.status})`);
      await refreshProviders();
      setNotice(
        body.updated
          ? `${label} updated: ${body.before ?? "unknown"} → ${body.after ?? "unknown"}. Applies to new runs.`
          : `${label} is up to date (${body.after ?? "version unknown"}).`,
      );
    } catch (cause) {
      setNotice(
        `${label} update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setUpdating((current) => current.filter((entry) => entry !== id));
    }
  };
  const pendingFor = (group: string) =>
    dirty.filter((key) =>
      fields.some((field) => field.key === key && field.group === group),
    ).length;
  const enabledFor = (id: ProviderId) => {
    const field = fields.find((entry) => entry.key === `${id}.enabled`);
    return field === undefined ? null : field.value === true;
  };
  const attention = providers.filter(
    (provider) => enabledFor(provider.id) === true && !provider.available,
  ).length;

  return (
    <div className={styles.workspace}>
      <SidebarCollection label="Agents settings">
        <SidebarRow
          title="Model access"
          onSelect={() =>
            document
              .getElementById("agents-model-access")
              ?.scrollIntoView({ block: "start" })
          }
        />
        <SidebarGroup title="Providers">
          {providers.map((provider) => (
            <SidebarRow
              key={provider.id}
              title={provider.label}
              href={`/agents?view=configuration#agent-${provider.id}`}
              onSelect={() =>
                document
                  .getElementById(`agent-${provider.id}`)
                  ?.scrollIntoView({ block: "nearest" })
              }
              status={
                pendingFor(PROVIDER_SETTINGS_GROUP[provider.id]) > 0
                  ? `${pendingFor(PROVIDER_SETTINGS_GROUP[provider.id])} unsaved`
                  : !connected
                    ? "Last known"
                    : enabledFor(provider.id) === false
                      ? "Disabled"
                      : provider.available
                        ? "Available"
                        : "Unavailable"
              }
              statusTone={
                pendingFor(PROVIDER_SETTINGS_GROUP[provider.id]) > 0
                  ? "warning"
                  : "muted"
              }
            />
          ))}
        </SidebarGroup>
        <SidebarGroup title="Shared settings">
          {groups.map((group) => (
            <SidebarRow
              key={group}
              title={GROUP_TITLE[group] ?? group}
              onSelect={() => setOpenGroup(group)}
              status={
                pendingFor(group) > 0
                  ? `${pendingFor(group)} unsaved`
                  : undefined
              }
              statusTone="warning"
            />
          ))}
        </SidebarGroup>
      </SidebarCollection>
      <header className={styles.header}>
        <div>
          <h1>Agent configuration</h1>
          <span>Your account · all workspaces</span>
        </div>
        <div>
          {settings.saving ? (
            <span role="status">Saving…</span>
          ) : (
            dirty.length > 0 && (
              <span className={styles.pending}>{dirty.length} unsaved</span>
            )
          )}
          <details className={styles.maintenance}>
            <summary>Maintenance</summary>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={!connected}
                loading={credits.loading}
                onClick={() => void credits.refresh(true)}
              >
                Refresh usage
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!connected}
                loading={detecting}
                onClick={() => void detect()}
              >
                Re-detect
              </Button>
              <small>
                Versions &amp; updates are in each provider’s Usage &amp;
                maintenance tab.
              </small>
            </div>
          </details>
        </div>
      </header>
      <div className={styles.scroll}>
        {!connected && (
          <p role="alert" className={styles.warning}>
            Reconnecting to the backend. Showing last known state; changes are
            disabled until connected.
          </p>
        )}
        {settings.errors.length > 0 && (
          <p role="alert" className={styles.error}>
            {settings.errors.join(" · ")}{" "}
            <button type="button" onClick={() => void settings.reload()}>
              Retry settings
            </button>
          </p>
        )}
        {detectError !== null && (
          <p role="alert" className={styles.error}>
            {detectError}
          </p>
        )}
        {credits.error !== null && (
          <p role="alert" className={styles.warning}>
            Plan usage refresh failed: {credits.error}.{" "}
            {credits.usage !== null
              ? "Showing previous samples."
              : "Usage is unknown."}
          </p>
        )}
        {notice !== null && (
          <p role="status" className={styles.feedback}>
            {notice}
          </p>
        )}
        <ModelPolicy
          tier={tier}
          mode={mode}
          effort={effort}
          disabled={disabled}
          loading={settings.snapshot === null}
          onTier={(value) =>
            void saveImmediate(
              "models.accessTier",
              value,
              `Saved ${MODEL_ACCESS_TIER_INFO[value].label}. New runs use this tier; ineligible choices remain saved.`,
            )
          }
          onMode={(value) =>
            void saveImmediate(
              "models.selectionMode",
              value,
              value === "auto"
                ? "Auto Select saved. Manual choices are preserved and inactive."
                : "Manual saved. Eligible saved choices can apply to new runs.",
            )
          }
          onEffort={(value) =>
            void saveImmediate(
              "models.reasoningEffort",
              value,
              `Saved ${value} global effort. Provider overrides take precedence; Cursor variants follow effective effort.`,
            )
          }
        />
        <div className={styles.mainGrid}>
          <section aria-labelledby="agents-providers-heading">
            <div className={styles.sectionHeading}>
              <h2 id="agents-providers-heading">
                Providers <span>{providers.length}</span>
              </h2>
              <span>
                {settings.snapshot === null
                  ? "Loading settings…"
                  : `${providers.filter((provider) => enabledFor(provider.id)).length} enabled`}
                {attention > 0 ? ` · ${attention} need attention` : ""}
              </span>
            </div>
            {providers.length === 0 ? (
              <p role="status" className={styles.empty}>
                Detecting providers…
                {!connected ? " Waiting for the backend." : ""}
              </p>
            ) : (
              <ul className={styles.providerList}>
                {providers.map((info) => (
                  <ProviderConfigurationRow
                    key={info.id}
                    info={info}
                    onSetup={() => openSetup(info.id)}
                    canMaintain={user.ownsLegacyData}
                    maintenanceBusy={
                      updating.includes(info.id) ||
                      setup.sessions[info.id]?.state === "installing"
                    }
                    onMaintain={() => {
                      if (providerInstalled(info))
                        void update(info.id, info.label);
                      else openSetup(info.id);
                    }}
                    enabled={enabledFor(info.id)}
                    connected={connected && detectError === null}
                    disabled={disabled}
                    busyCount={
                      runs.filter((run) => run.provider === info.id).length
                    }
                    pin={models.configured(info.id)}
                    pending={pendingFor(PROVIDER_SETTINGS_GROUP[info.id])}
                    onToggle={(value) =>
                      void saveImmediate(
                        `${info.id}.enabled`,
                        value,
                        `${info.label} ${value ? "enabled" : "disabled"}. Applies to new runs.`,
                      )
                    }
                    onOpen={(value) => {
                      setNotice(null);
                      setConfiguring(info.id);
                      setTab(value);
                    }}
                    usage={credits.usage?.[info.id] ?? null}
                    usageLoading={credits.loading}
                    usageError={credits.error}
                    checkedAt={credits.checkedAt}
                    credentialSet={fields.some(
                      (field) =>
                        field.group === PROVIDER_SETTINGS_GROUP[info.id] &&
                        field.type === "password" &&
                        field.isSet,
                    )}
                    reasoningOverride={fields.some(
                      (field) =>
                        field.key === `${info.id}.reasoningEffort` &&
                        field.value !== "",
                    )}
                  />
                ))}
              </ul>
            )}
          </section>
          <section
            className={styles.shared}
            aria-labelledby="shared-settings-heading"
          >
            <div className={styles.sectionHeading}>
              <h2 id="shared-settings-heading">Shared settings</h2>
            </div>
            <p>Across every workspace</p>
            <div className={styles.settingsDirectory}>
              {groups.map((group) => (
                <button
                  type="button"
                  key={group}
                  onClick={() => setOpenGroup(group)}
                  aria-haspopup="dialog"
                >
                  <span>
                    <strong>{GROUP_TITLE[group] ?? group}</strong>
                    <small>
                      {GROUP_BLURB[group] ??
                        `${fields.filter((field) => field.group === group).length} account settings`}
                    </small>
                  </span>
                  <span
                    className={
                      pendingFor(group) > 0 ? "text-warning" : "text-fg-dim"
                    }
                  >
                    {pendingFor(group) > 0
                      ? `${pendingFor(group)} unsaved`
                      : "›"}
                  </span>
                </button>
              ))}
            </div>
            {settings.snapshot === null && (
              <p>
                {settings.loading
                  ? "Loading settings directory…"
                  : "Settings unavailable. Retry above."}
              </p>
            )}
            <div className={styles.scopeNote}>
              <strong>When changes take effect</strong>
              <p>
                Model policy and enable switches save immediately. Provider and
                shared fields need Save. Existing runs keep their settings.
              </p>
              <p>
                Reset removes a saved override. Discard only clears unsaved
                edits.
              </p>
            </div>
          </section>
        </div>
      </div>
      {openGroup !== null && (
        <SettingsGroupDialog
          group={openGroup}
          onClose={() => setOpenGroup(null)}
          onSaved={afterSave}
          draftState={draftState}
          disabled={!connected}
        />
      )}
      {selected && (
        <ProviderConfigurationDialog
          info={selected}
          providers={providers}
          tab={tab}
          onTab={setTab}
          onProvider={setConfiguring}
          onClose={() => setConfiguring(null)}
          draftState={draftState}
          pin={models.configured(selected.id)}
          onPick={(value) => models.select(selected.id, value)}
          onClear={() => models.clear(selected.id)}
          onSaved={afterSave}
          disabled={!connected}
          usage={credits.usage?.[selected.id] ?? null}
          usageLoading={credits.loading}
          usageError={credits.error}
          checkedAt={credits.checkedAt}
          onRefreshUsage={() => void credits.refresh(true)}
          updating={updating.includes(selected.id)}
          canMaintain={user.ownsLegacyData}
          onInstall={() => {
            setConfiguring(null);
            openSetup(selected.id);
          }}
          onUpdate={() => void update(selected.id, selected.label)}
          agent={agentState(selected, runs, items, lastRun)}
          runTabIds={runTabIds}
          onStop={(runId) => stopCenter.open({ runId })}
          notice={notice}
        />
      )}
      {setupProvider && (
        <ProviderSetupDialog
          provider={setupProvider}
          session={setup.sessions[setupProvider.id]}
          canInstall={user.ownsLegacyData}
          connected={connected}
          draftState={draftState}
          onInstall={() => void setup.install(setupProvider.id)}
          onRetry={() => void setup.load(setupProvider.id)}
          onCheck={refreshProviders}
          onConfigure={() => {
            setConfiguring(setupProvider.id);
            setTab("settings");
            setSettingUp(null);
          }}
          onClose={() => setSettingUp(null)}
        />
      )}
    </div>
  );
}

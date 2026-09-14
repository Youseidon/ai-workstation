"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatElapsed,
  formatTokens,
  isCustomModel,
  MODEL_CATALOG,
  modelLabel,
  type ProviderId,
  type ProviderInfo,
  type ProviderUsage,
  type QuotaWarning,
  type SettingField,
  type SettingValue,
  type TaskControlCapability,
} from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AskChip } from "@/components/AgentDock";
import { SettingRow } from "@/components/SettingField";
import { PageChrome } from "@/components/shell/chrome";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useDialogs } from "@/components/ui/Dialogs";
import { CountUp } from "@/components/CountUp";
import { cn } from "@/lib/cn";
import { ACTIVITY_LABEL, agentState, type AgentState } from "@/lib/agentState";
import { providerTheme } from "@/lib/providerTheme";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { useProviderUsage } from "@/lib/providerUsage";
import { useSettings } from "@/lib/useSettings";
import { workspaceApi } from "@/lib/workspacesApi";
import { UsageBlock } from "./usage";

const ACTIVITY_TONE: Record<AgentState["activity"], Tone> = {
  offline: "neutral",
  idle: "neutral",
  starting: "info",
  thinking: "info",
  tooling: "accent",
  speaking: "violet",
  done: "success",
  error: "danger",
};

/** Settings panel group name for each provider's field set. */
const SETTINGS_GROUP: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor CLI",
  grok: "Grok CLI",
};

function fleetSummary(writing: number, asking: number): string {
  if (writing === 0 && asking === 0) return "All agents idle.";
  if (writing > 0 && asking > 0) return `${writing} writing · ${asking} asking`;
  if (writing > 0) return `${writing} agent${writing === 1 ? "" : "s"} writing.`;
  return `${asking} agent${asking === 1 ? "" : "s"} asking.`;
}

function enabledKey(id: ProviderId): string {
  return `${id}.enabled`;
}

/**
 * Manage every agent in one place: on/off, model, live work, plan usage, and
 * the provider's own settings.
 */
export function AgentsView() {
  const { providers, runs, items, lastRun, connection, interrupt, refreshProviders } =
    useAgentConsole();
  const credits = useProviderUsage(true);
  const { snapshot, saving, save, reset } = useSettings(SERVER_URL);
  const models = useModelSelection(providers);
  const dialogs = useDialogs();
  const [drafts, setDrafts] = useState<Record<string, SettingValue>>({});
  const [savingEnabled, setSavingEnabled] = useState<ProviderId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<ProviderId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [taskControlCapability, setTaskControlCapability] = useState<TaskControlCapability | null>(null);

  const agents = providers.map((provider) => agentState(provider, runs, items, lastRun));
  const writing = runs.filter((run) => run.role === "execute").length;
  const asking = runs.filter((run) => run.role === "consult").length;
  const totalTokens = runs.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);

  const onToggleEnabled = useCallback(
    async (id: ProviderId, next: boolean) => {
      setSavingEnabled(id);
      setNotice(null);
      const result = await save({ [enabledKey(id)]: next });
      if (result.ok) {
        // AgentPicker hides turned-off providers; re-detect so it sees the change.
        await refreshProviders();
      }
      setSavingEnabled(null);
    },
    [save, refreshProviders],
  );

  const dirtyKeys = useMemo(() => {
    if (snapshot === null) return [];
    return Object.keys(drafts).filter((key) => {
      const field = snapshot.fields.find((entry) => entry.key === key);
      if (field === undefined) return false;
      return drafts[key] !== field.value;
    });
  }, [drafts, snapshot]);

  const generalFields = snapshot?.fields.filter((field) => field.group === "General") ?? [];
  const generalDirty = dirtyKeys.filter((key) => generalFields.some((field) => field.key === key));
  const taskControlFields = snapshot?.fields.filter((field) => field.group === "Task Control") ?? [];
  const taskControlDirty = dirtyKeys.filter((key) => taskControlFields.some((field) => field.key === key));

  useEffect(() => {
    void workspaceApi.taskControlCapability(SERVER_URL).then(setTaskControlCapability).catch(() => setTaskControlCapability(null));
  }, [snapshot]);

  const saveDrafts = useCallback(
    async (keys: string[]) => {
      if (keys.length === 0 || snapshot === null) return;
      const dangerous = keys.filter((key) => {
        const field = snapshot.fields.find((entry) => entry.key === key);
        if (field === undefined) return false;
        const next = drafts[key];
        if (field.type === "boolean") return next === true && field.dangerWhenTrue;
        const option = field.options?.find((entry) => entry.value === String(next));
        return option?.danger === true;
      });
      if (dangerous.length > 0) {
        const labels = dangerous.map(
          (key) => snapshot.fields.find((field) => field.key === key)?.label ?? key,
        );
        const confirmed = await dialogs.confirm({
          title: "This turns off a sandbox or permission check",
          description: `${labels.join(", ")} — the agent will be able to act outside its sandbox.`,
          confirmLabel: "Save anyway",
          tone: "danger",
        });
        if (!confirmed) return;
      }
      const patch = Object.fromEntries(keys.map((key) => [key, drafts[key] as SettingValue]));
      const result = await save(patch);
      if (result.ok) {
        setDrafts((current) => {
          const next = { ...current };
          for (const key of keys) delete next[key];
          return next;
        });
        setNotice(
          result.changed.length === 0
            ? "No changes to save."
            : `Saved ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}.`,
        );
        if (keys.some((key) => key.endsWith(".enabled") || key === "hostAccess")) {
          await refreshProviders();
        }
      }
    },
    [drafts, dialogs, refreshProviders, save, snapshot],
  );

  return (
    <main className="flex h-full flex-col bg-surface-0">
      <PageChrome
        title="Agents"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <dl className="hidden items-center gap-4 sm:flex">
              <Stat label="available" value={agents.filter((agent) => agent.available).length} />
              {asking > 0 ? (
                <>
                  {writing > 0 && <Stat label="writing" value={writing} />}
                  <Stat label="asking" value={asking} />
                </>
              ) : (
                <Stat label="working" value={writing} />
              )}
              <Stat label="tokens" value={totalTokens} format={formatTokens} />
            </dl>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void credits.refresh(true)}
              loading={credits.loading && credits.usage !== null}
              title="Refresh plan usage from each provider"
            >
              Refresh usage
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshProviders()}
              title="Re-run provider detection"
            >
              Re-detect
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <header className="mb-5">
          <p className="text-xs text-fg-dim">
            {connection === "open" ? fleetSummary(writing, asking) : "Reconnecting to the backend…"}
            {credits.error !== null ? ` · ${credits.error}` : ""}
            {notice !== null ? ` · ${notice}` : ""}
          </p>
        </header>

        {generalFields.length > 0 && (
          <section className="mb-4 rounded-panel border border-line bg-surface-1 p-4">
            <h2 className="text-[11px] uppercase tracking-wider text-fg-dim">Runtime</h2>
            <p className="mt-1 text-[11px] text-fg-dim">
              Shared with every provider. Host access enables live local API calls, docker compose, and other host services; saved prompts can fall back to inline status reporting.
            </p>
            {generalFields.map((field) => (
              <SettingRow
                key={field.key}
                field={field}
                draft={drafts[field.key]}
                disabled={saving}
                onChange={(key, value) => {
                  setNotice(null);
                  setDrafts((current) => ({ ...current, [key]: value }));
                }}
                onRevert={(key) => {
                  setNotice(null);
                  void reset([key]);
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                }}
              />
            ))}
            {generalDirty.length > 0 && (
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDrafts((current) => {
                      const next = { ...current };
                      for (const key of generalDirty) delete next[key];
                      return next;
                    });
                  }}
                  disabled={saving}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="success"
                  onClick={() => void saveDrafts(generalDirty)}
                  loading={saving}
                >
                  Save {generalDirty.length}
                </Button>
              </div>
            )}
          </section>
        )}

        {taskControlFields.length > 0 && (
          <section className="mb-4 rounded-panel border border-line bg-surface-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[11px] uppercase tracking-wider text-fg-dim">Task Control</h2>
              {taskControlCapability !== null && (
                <Badge tone={taskControlCapability.setup === "telegram_configured" ? "success" : taskControlCapability.setup === "fake_only" ? "info" : "neutral"}>
                  {taskControlCapability.setup === "telegram_configured" ? "Telegram configured" : taskControlCapability.setup === "fake_only" ? "fake-only" : "disabled"}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[11px] text-fg-dim">
              {taskControlCapability?.reason ?? "Personal task controls stay local and fake-only until live setup is explicitly configured."}
            </p>
            {taskControlFields.map((field) => (
              <SettingRow
                key={field.key}
                field={field}
                draft={drafts[field.key]}
                disabled={saving}
                onChange={(key, value) => {
                  setNotice(null);
                  setDrafts((current) => ({ ...current, [key]: value }));
                }}
                onRevert={(key) => {
                  setNotice(null);
                  void reset([key]);
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                }}
              />
            ))}
            {taskControlDirty.length > 0 && (
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDrafts((current) => {
                      const next = { ...current };
                      for (const key of taskControlDirty) delete next[key];
                      return next;
                    });
                  }}
                  disabled={saving}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="success"
                  onClick={() => void saveDrafts(taskControlDirty)}
                  loading={saving}
                >
                  Save {taskControlDirty.length}
                </Button>
              </div>
            )}
          </section>
        )}

        <ul className="grid gap-3 xl:grid-cols-2">
          {agents.map((agent) => {
            const info = providers.find((provider) => provider.id === agent.provider);
            if (info === undefined) return null;
            const group = SETTINGS_GROUP[agent.provider];
            const groupFields =
              snapshot?.fields.filter(
                (field) => field.group === group && field.key !== enabledKey(agent.provider),
              ) ?? [];
            const groupDirty = dirtyKeys.filter((key) =>
              groupFields.some((field) => field.key === key),
            );
            const enabledField = snapshot?.fields.find(
              (field) => field.key === enabledKey(agent.provider),
            );
            const enabled = enabledField === undefined ? true : enabledField.value === true;

            return (
              <AgentCard
                key={agent.provider}
                agent={agent}
                info={info}
                enabled={enabled}
                enabledBusy={savingEnabled === agent.provider || saving}
                onToggleEnabled={(next) => void onToggleEnabled(agent.provider, next)}
                model={models.resolve(agent.provider)}
                modelPinned={models.isPinned(agent.provider)}
                onPickModel={(value) => models.select(agent.provider, value)}
                onClearModel={() => models.clear(agent.provider)}
                usage={credits.usage?.[agent.provider] ?? null}
                warnings={credits.warnings?.[agent.provider] ?? []}
                usageLoading={credits.loading && credits.usage === null}
                settingsOpen={settingsOpen === agent.provider}
                onToggleSettings={() =>
                  setSettingsOpen((current) => (current === agent.provider ? null : agent.provider))
                }
                fields={groupFields}
                drafts={drafts}
                fieldsDisabled={saving}
                dirtyKeys={groupDirty}
                onDraftChange={(key, value) => {
                  setNotice(null);
                  setDrafts((current) => ({ ...current, [key]: value }));
                }}
                onRevert={(key) => {
                  setNotice(null);
                  void reset([key]);
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  });
                }}
                onSaveSettings={() => void saveDrafts(groupDirty)}
                onDiscardSettings={() => {
                  setDrafts((current) => {
                    const next = { ...current };
                    for (const key of groupDirty) delete next[key];
                    return next;
                  });
                }}
                onStop={() => {
                  if (agent.run !== null) interrupt(agent.run.runId);
                }}
                onStopConsult={(runId) => interrupt(runId)}
              />
            );
          })}
        </ul>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  format,
}: {
  label: string;
  value: number;
  format?: (value: number) => string;
}) {
  return (
    <div className="text-right">
      <dd className="numeric text-sm text-fg">
        <CountUp value={value} format={format} />
      </dd>
      <dt className="text-[10px] uppercase tracking-wider text-fg-dim">{label}</dt>
    </div>
  );
}

function AgentCard({
  agent,
  info,
  enabled,
  enabledBusy,
  onToggleEnabled,
  model,
  modelPinned,
  onPickModel,
  onClearModel,
  usage,
  warnings,
  usageLoading,
  settingsOpen,
  onToggleSettings,
  fields,
  drafts,
  fieldsDisabled,
  dirtyKeys,
  onDraftChange,
  onRevert,
  onSaveSettings,
  onDiscardSettings,
  onStop,
  onStopConsult,
}: {
  agent: AgentState;
  info: ProviderInfo;
  enabled: boolean;
  enabledBusy: boolean;
  onToggleEnabled(next: boolean): void;
  model: string | null;
  modelPinned: boolean;
  onPickModel(model: string | null): void;
  onClearModel(): void;
  usage: ProviderUsage | null;
  warnings: QuotaWarning[];
  usageLoading: boolean;
  settingsOpen: boolean;
  onToggleSettings(): void;
  fields: SettingField[];
  drafts: Record<string, SettingValue>;
  fieldsDisabled: boolean;
  dirtyKeys: string[];
  onDraftChange(key: string, value: SettingValue): void;
  onRevert(key: string): void;
  onSaveSettings(): void;
  onDiscardSettings(): void;
  onStop(): void;
  onStopConsult(runId: string): void;
}) {
  const theme = providerTheme[agent.provider];
  const busy = agent.run !== null || agent.consultCount > 0;
  const label = modelLabel(agent.provider, model);

  return (
    <li
      className={cn(
        "relative flex flex-col overflow-hidden rounded-panel border bg-surface-1 p-4 transition-colors",
        busy ? "border-line-strong" : "border-line",
        (!enabled || agent.activity === "offline") && "opacity-70",
      )}
    >
      {busy && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-x-0 top-0 h-px opacity-70", theme.fill)}
        />
      )}

      <div className="flex items-start gap-3">
        <AgentAvatar
          provider={agent.provider}
          activity={enabled ? agent.activity : "offline"}
          size={44}
          title={`${info.label}: ${ACTIVITY_LABEL[agent.activity]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-[13px] font-semibold", theme.text)}>{info.label}</span>
            <Badge tone={ACTIVITY_TONE[enabled ? agent.activity : "offline"]} dot pulse={busy}>
              {enabled ? ACTIVITY_LABEL[agent.activity] : "Off"}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-fg-dim">{label ?? "provider default"}</div>
        </div>
        <Switch
          checked={enabled}
          disabled={enabledBusy}
          aria-label={`Enable ${info.label}`}
          onCheckedChange={onToggleEnabled}
        />
      </div>

      <p
        className={cn(
          "mt-3 min-h-[2.5rem] text-xs leading-relaxed",
          !enabled || agent.activity === "offline" ? "text-fg-dim" : "text-fg-muted",
        )}
      >
        <span className="line-clamp-2">
          {!enabled ? "Turned off — hidden from the agent picker." : agent.caption}
        </span>
      </p>

      <ModelRow
        provider={info}
        selected={model}
        pinned={modelPinned}
        onSelect={onPickModel}
        onClear={onClearModel}
      />

      {agent.run !== null && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 text-[11px]">
            <div>
              <dt className="text-fg-dim">elapsed</dt>
              <dd className="numeric text-fg">{formatElapsed(agent.run.elapsedMs)}</dd>
            </div>
            <div>
              <dt className="text-fg-dim">tokens</dt>
              <dd className="numeric text-fg">
                {agent.run.usage === null ? "—" : formatTokens(agent.run.usage.totalTokens)}
              </dd>
            </div>
            <div className="col-span-2 min-w-0">
              <dt className="text-fg-dim">workspace</dt>
              <dd className="truncate text-fg" title={agent.run.workspace.workDirectory}>
                {agent.run.workspace.name}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <Link
              href="/"
              className="flex-1 rounded-md px-2 py-1.5 text-center text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Transcript
            </Link>
            <Button size="sm" variant="danger" onClick={onStop}>
              Stop
            </Button>
          </div>
        </>
      )}

      {agent.consultCount > 0 && (
        <div className={cn("flex flex-col gap-1.5", agent.run !== null ? "mt-3" : "mt-2 border-t border-line pt-3")}>
          <div className="text-[10px] uppercase tracking-wider text-fg-dim">
            {agent.consultCount} asking
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.consults.map((consult) => (
              <AskChip key={consult.runId} run={consult} onStop={() => onStopConsult(consult.runId)} />
            ))}
          </div>
        </div>
      )}

      {enabled && agent.run === null && agent.consultCount === 0 && (
        <div className="mt-2 border-t border-line pt-3 text-[11px] text-fg-dim">
          {agent.available ? "Ready to take work." : "Configure it below, then re-detect."}
        </div>
      )}

      <UsageBlock usage={usage} warnings={warnings} loading={usageLoading} available={enabled && agent.available} />

      <div className="mt-3 border-t border-line pt-3">
        <button
          type="button"
          onClick={onToggleSettings}
          className="flex w-full items-center justify-between gap-2 text-left text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          <span className="uppercase tracking-wider text-fg-dim">Settings</span>
          <span aria-hidden className="text-fg-dim">
            {settingsOpen ? "▴" : "▾"}
          </span>
        </button>
        {settingsOpen && (
          <div className="mt-2">
            {fields.length === 0 ? (
              <p className="py-2 text-[11px] text-fg-dim">Settings are still loading…</p>
            ) : (
              fields.map((field) => (
                <SettingRow
                  key={field.key}
                  field={field}
                  draft={drafts[field.key]}
                  disabled={fieldsDisabled}
                  onChange={onDraftChange}
                  onRevert={onRevert}
                />
              ))
            )}
            {dirtyKeys.length > 0 && (
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onDiscardSettings} disabled={fieldsDisabled}>
                  Discard
                </Button>
                <Button size="sm" variant="success" onClick={onSaveSettings} loading={fieldsDisabled}>
                  Save {dirtyKeys.length}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 text-[10px] text-fg-dim">
        <span title="version">{info.version ?? "version unknown"}</span>
        <span title="binary" className="truncate">
          {info.binary ?? info.transport}
        </span>
        <span title="permission mode">{info.permissionMode}</span>
      </footer>
    </li>
  );
}

/**
 * Compact model picker for a single provider card — same catalog and pin
 * semantics as AgentPicker, laid out as an always-visible row.
 */
function ModelRow({
  provider,
  selected,
  pinned,
  onSelect,
  onClear,
}: {
  provider: ProviderInfo;
  selected: string | null;
  pinned: boolean;
  onSelect(model: string | null): void;
  onClear(): void;
}) {
  const [custom, setCustom] = useState(isCustomModel(provider.id, selected) ? (selected ?? "") : "");
  const theme = providerTheme[provider.id];
  const options = MODEL_CATALOG[provider.id];

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-dim">Model</div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const isSelected = option.id === selected;
          return (
            <button
              key={option.id ?? "__default__"}
              type="button"
              title={option.hint}
              onClick={() => onSelect(option.id)}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] transition-colors ring-1 ring-inset",
                isSelected ? theme.chip : "text-fg-muted ring-line hover:bg-surface-2 hover:text-fg",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const value = custom.trim();
            if (value !== "") onSelect(value);
          }}
          placeholder="custom model id…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            const value = custom.trim();
            if (value !== "") onSelect(value);
          }}
          disabled={custom.trim() === ""}
          className="shrink-0 rounded border border-line bg-surface-2 px-2 text-[11px] text-fg-muted disabled:opacity-40"
        >
          use
        </button>
      </div>
      {pinned && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 w-full rounded px-2 py-1 text-left text-[10px] text-fg-dim hover:text-fg-muted"
        >
          ↺ follow settings{provider.model === null ? "" : ` (${provider.model})`}
        </button>
      )}
    </div>
  );
}

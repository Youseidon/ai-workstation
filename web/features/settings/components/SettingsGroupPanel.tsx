"use client";

import { useState } from "react";
import type { SettingField, SettingValue } from "@hydra/shared";
import { SettingRow } from "@/features/settings/components/SettingField";
import { SpendMap } from "@/features/settings/components/SpendMap";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/api/serverUrl";
import { useSettings } from "@/features/settings/hooks/useSettings";
import {
  GROUP_BLURB,
  GROUP_TITLE,
} from "@/features/settings/lib/settingsGroups";
import {
  clearSubmittedDrafts,
  dangerousSetting,
  dirtySettings,
  type SettingsDraftState,
} from "@/features/settings/lib/drafts";

export function SettingsGroupPanel({
  group,
  onSaved,
  compact = false,
  header = true,
  draftState,
  excludeKeys = [],
  disabled = false,
}: {
  group: string;
  onSaved?(): void;
  compact?: boolean;
  header?: boolean;
  draftState?: SettingsDraftState;
  excludeKeys?: string[];
  disabled?: boolean;
}) {
  const settings = useSettings(SERVER_URL);
  const dialogs = useDialogs();
  const [localDrafts, setLocalDrafts] = useState<Record<string, SettingValue>>(
    {},
  );
  const [notice, setNotice] = useState<string | null>(null);
  const { drafts, setDrafts } = draftState ?? {
    drafts: localDrafts,
    setDrafts: setLocalDrafts,
  };
  const fields =
    settings.snapshot?.fields.filter(
      (field) => field.group === group && !excludeKeys.includes(field.key),
    ) ?? [];
  const dirty = dirtySettings(fields, drafts);
  const locked = settings.saving || disabled;

  const clear = (submitted: Record<string, SettingValue>) =>
    setDrafts((current) => clearSubmittedDrafts(current, submitted));
  const confirmDanger = async (
    changes: { field: SettingField; value: SettingValue }[],
  ) => {
    const dangerous = changes.filter(({ field, value }) =>
      dangerousSetting(field, value),
    );
    if (dangerous.length === 0) return true;
    return dialogs.confirm({
      title: "This turns off a sandbox or permission check",
      description: (
        <span className="block space-y-2">
          {dangerous.map(({ field, value }) => (
            <span className="block" key={field.key}>
              <strong>{field.label}</strong>
              <span className="block">
                {field.options?.find((option) => option.value === String(value))
                  ?.hint ?? field.description}
              </span>
            </span>
          ))}
          <span className="block">
            The agent may act outside its workspace or without approval. This
            applies to new runs across your workspaces.
          </span>
        </span>
      ),
      confirmLabel: "Save anyway",
      tone: "danger",
    });
  };
  const saveDirty = async () => {
    if (dirty.length === 0 || locked) return;
    const patch = Object.fromEntries(
      dirty.map((key) => [key, drafts[key] as SettingValue]),
    );
    if (
      !(await confirmDanger(
        fields
          .filter((field) => dirty.includes(field.key))
          .map((field) => ({ field, value: patch[field.key] as SettingValue })),
      ))
    )
      return;
    const result = await settings.save(patch);
    if (!result.ok) return;
    clear(patch);
    setNotice(
      `Saved ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}. ${fields.some((field) => dirty.includes(field.key) && field.requiresRestart) ? "Marked settings require a server restart." : "Applies to new runs."}`,
    );
    onSaved?.();
  };
  const reset = async (key: string) => {
    const field = fields.find((entry) => entry.key === key);
    if (field === undefined || locked) return;
    if (!(await confirmDanger([{ field, value: field.defaultValue }]))) return;
    const submitted = drafts[key] === undefined ? {} : { [key]: drafts[key] };
    const result = await settings.reset([key]);
    if (!result.ok) return;
    clear(submitted);
    setNotice(
      `Reset ${field.label} to its inherited value. ${field.requiresRestart ? "Requires a server restart." : "Applies to new runs."}`,
    );
    onSaved?.();
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {header && (
        <div>
          <h3 className="text-sm font-medium text-fg">
            {GROUP_TITLE[group] ?? group}
          </h3>
          {GROUP_BLURB[group] !== undefined && (
            <p className="mt-1 text-xs text-fg-dim">{GROUP_BLURB[group]}</p>
          )}
        </div>
      )}
      {settings.errors.length > 0 && (
        <div role="alert" className="text-xs text-danger">
          {settings.errors.join(" · ")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void settings.reload()}
          >
            Retry loading settings
          </button>
        </div>
      )}
      {settings.loading ? (
        <div role="status" aria-label="Loading settings">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="mt-2 h-9 w-full" />
        </div>
      ) : fields.length === 0 ? (
        settings.errors.length === 0 && (
          <p className="text-sm text-fg-muted">This group has no settings.</p>
        )
      ) : (
        <>
          <div className="text-xs text-fg-dim">
            Saved for your account · all workspaces · new runs
            {fields.some((field) => field.requiresRestart)
              ? " (restart exceptions marked)"
              : ""}
          </div>
          <div>
            {fields.map((field) => (
              <SettingRow
                key={field.key}
                field={field}
                draft={drafts[field.key]}
                disabled={locked}
                compact={compact}
                footer={
                  field.key === "budget.maxSpendUsd" ? (
                    <SpendMap
                      usd={Number(drafts[field.key] ?? field.value) || 0}
                    />
                  ) : undefined
                }
                onChange={(key, value) => {
                  setNotice(null);
                  setDrafts((current) => ({ ...current, [key]: value }));
                }}
                onRevert={(key) => void reset(key)}
              />
            ))}
          </div>
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-1 py-3">
            <span
              role="status"
              className={`text-xs ${dirty.length > 0 ? "text-warning" : "text-fg-muted"}`}
            >
              {settings.saving
                ? "Saving…"
                : dirty.length > 0
                  ? `${dirty.length} unsaved · retained while this page is open`
                  : (notice ?? "All changes saved")}
            </span>
            {dirty.length > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    clear(
                      Object.fromEntries(
                        dirty.map((key) => [key, drafts[key] as SettingValue]),
                      ),
                    );
                    setNotice(
                      "Unsaved edits discarded. Saved settings unchanged.",
                    );
                  }}
                >
                  Discard edits
                </Button>
                <Button
                  variant="success"
                  size="sm"
                  loading={settings.saving}
                  disabled={locked}
                  onClick={() => void saveDirty()}
                >
                  Save {dirty.length}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

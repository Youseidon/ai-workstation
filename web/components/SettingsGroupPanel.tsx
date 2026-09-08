"use client";

import { useState } from "react";
import type { SettingValue } from "@agent-console/shared";
import { SettingRow } from "@/components/SettingField";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/lib/serverUrl";
import { useSettings } from "@/lib/useSettings";
import { GROUP_BLURB, GROUP_TITLE } from "@/lib/settingsGroups";

/**
 * Inline editor for one settings group. Used by the Agents page dialog and by
 * the pipeline inspector so Policy / Budgets are edited where they matter.
 */
export function SettingsGroupPanel({
  group,
  onSaved,
  compact = false,
}: {
  group: string;
  onSaved?(): void;
  /** Tighter layout for side drawers. */
  compact?: boolean;
}) {
  const settings = useSettings(SERVER_URL);
  const dialogs = useDialogs();
  const [drafts, setDrafts] = useState<Record<string, SettingValue>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const fields = settings.snapshot?.fields.filter((field) => field.group === group) ?? [];
  const dirty = Object.keys(drafts).filter((key) => {
    const field = fields.find((entry) => entry.key === key);
    return field !== undefined && drafts[key] !== field.value;
  });

  const clear = (keys: string[]) => {
    setDrafts((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  };

  const saveDirty = async () => {
    if (dirty.length === 0) return;
    const dangerous = dirty.filter((key) => {
      const field = fields.find((entry) => entry.key === key);
      if (field === undefined) return false;
      const next = drafts[key];
      if (field.type === "boolean") return next === true && field.dangerWhenTrue;
      return field.options?.find((option) => option.value === String(next))?.danger === true;
    });
    if (dangerous.length > 0) {
      const labels = dangerous.map((key) => fields.find((field) => field.key === key)?.label ?? key);
      const confirmed = await dialogs.confirm({
        title: "This loosens a check",
        description: `${labels.join(", ")} — make sure you mean it.`,
        confirmLabel: "Save anyway",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    const patch = Object.fromEntries(dirty.map((key) => [key, drafts[key] as SettingValue]));
    const result = await settings.save(patch);
    if (!result.ok) return;
    clear(dirty);
    setNotice(
      result.changed.length === 0
        ? "No changes to save."
        : `Saved ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}.`,
    );
    onSaved?.();
  };

  const title = GROUP_TITLE[group] ?? group;
  const blurb = GROUP_BLURB[group];

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {!compact && (
        <div>
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {blurb !== undefined && <p className="mt-1 text-[11px] leading-5 text-fg-dim">{blurb}</p>}
        </div>
      )}
      {compact && blurb !== undefined && (
        <p className="text-[11px] leading-5 text-fg-dim">{blurb}</p>
      )}

      {settings.loading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : fields.length === 0 ? (
        <p className="text-sm text-fg-muted">This group has no settings.</p>
      ) : (
        <>
          {fields.map((field) => (
            <SettingRow
              key={field.key}
              field={field}
              draft={drafts[field.key]}
              disabled={settings.saving}
              onChange={(key, value) => {
                setNotice(null);
                setDrafts((current) => ({ ...current, [key]: value }));
              }}
              onRevert={(key) => {
                setNotice(null);
                void settings.reset([key]);
                clear([key]);
              }}
            />
          ))}
          {dirty.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => clear(dirty)} disabled={settings.saving}>
                Discard
              </Button>
              <Button variant="success" size="sm" onClick={() => void saveDirty()} loading={settings.saving}>
                Save {dirty.length}
              </Button>
            </div>
          )}
          {(notice !== null || settings.errors.length > 0) && (
            <p
              className={`text-xs ${settings.errors.length > 0 ? "text-danger" : "text-fg-dim"}`}
              role={settings.errors.length > 0 ? "alert" : undefined}
            >
              {settings.errors.length > 0 ? settings.errors.join(" · ") : notice}
            </p>
          )}
          <p className="text-[11px] leading-4 text-fg-dim">
            Saved to {settings.snapshot?.storagePath ?? "the server"}.
          </p>
        </>
      )}
    </div>
  );
}

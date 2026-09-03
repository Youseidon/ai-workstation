"use client";

import { useState } from "react";
import type { SettingValue } from "@agent-console/shared";
import { SettingRow } from "@/components/SettingField";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useDialogs } from "@/components/ui/Dialogs";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/lib/serverUrl";
import { useSettings } from "@/lib/useSettings";
import { GROUP_BLURB, GROUP_TITLE } from "@/lib/settingsGroups";

/**
 * One settings group as a dialog, so the same form can be reached from wherever
 * the settings actually matter — the Agents page, or the pipeline that the
 * policy governs — instead of only from a section on one page.
 *
 * Mount this conditionally (`{open && <SettingsGroupDialog … />}`): it fetches
 * the settings snapshot on mount, and a page that never opens it should not pay
 * for that request.
 */
export function SettingsGroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group: string;
  onClose(): void;
  /** Fired after a successful save, for callers holding derived server state. */
  onSaved?(): void;
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
    // Loosening a sandbox or permission check is never a silent side effect of
    // pressing Save; the operator is told exactly which switch does it.
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
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={blurb}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={settings.saving}>
            Close
          </Button>
          {dirty.length > 0 && (
            <>
              <Button variant="ghost" onClick={() => clear(dirty)} disabled={settings.saving}>
                Discard
              </Button>
              <Button variant="success" onClick={() => void saveDirty()} loading={settings.saving}>
                Save {dirty.length}
              </Button>
            </>
          )}
        </>
      }
    >
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
          {(notice !== null || settings.errors.length > 0) && (
            <p
              className={`mt-3 text-xs ${settings.errors.length > 0 ? "text-danger" : "text-fg-dim"}`}
              role={settings.errors.length > 0 ? "alert" : undefined}
            >
              {settings.errors.length > 0 ? settings.errors.join(" · ") : notice}
            </p>
          )}
          <p className="mt-3 text-[11px] leading-4 text-fg-dim">
            Saved to {settings.snapshot?.storagePath ?? "the server"}. Each field also reads from its
            environment variable when no override is set.
          </p>
        </>
      )}
    </Modal>
  );
}

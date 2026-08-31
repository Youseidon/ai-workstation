"use client";

import { useEffect, useMemo, useState } from "react";
import type { SettingValue } from "@agent-console/shared";
import { useSettings } from "@/lib/useSettings";
import { SettingRow } from "./SettingField";
import { useDialogs } from "./ui/Dialogs";

interface Props {
  serverUrl: string;
  onClose(): void;
  /** Saving is allowed during a run, but it only affects the next one. */
  runInProgress: boolean;
}

/**
 * Mounted only while open, so opening it always starts from a clean draft state
 * and re-reads the server snapshot — another tab's changes are never clobbered.
 */
export function SettingsPanel({ serverUrl, onClose, runInProgress }: Props) {
  const { snapshot, loading, saving, errors, save, reset } = useSettings(serverUrl);
  const [drafts, setDrafts] = useState<Record<string, SettingValue>>({});
  const [group, setGroup] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeGroup = group ?? snapshot?.groups[0] ?? "General";

  const dirtyKeys = useMemo(() => {
    if (snapshot === null) return [];
    return Object.keys(drafts).filter((key) => {
      const field = snapshot.fields.find((entry) => entry.key === key);
      if (field === undefined) return false;
      return drafts[key] !== field.value;
    });
  }, [drafts, snapshot]);

  const dangerousPending = useMemo(() => {
    if (snapshot === null) return [];
    return dirtyKeys.filter((key) => {
      const field = snapshot.fields.find((entry) => entry.key === key);
      if (field === undefined) return false;
      const next = drafts[key];
      if (field.type === "boolean") return next === true && field.dangerWhenTrue;
      const option = field.options?.find((entry) => entry.value === String(next));
      return option?.danger === true;
    });
  }, [dirtyKeys, drafts, snapshot]);

  const dialogs = useDialogs();
  const fields = snapshot?.fields.filter((field) => field.group === activeGroup) ?? [];

  const onSave = async () => {
    if (dirtyKeys.length === 0) return;
    if (dangerousPending.length > 0) {
      const labels = dangerousPending.map(
        (key) => snapshot?.fields.find((field) => field.key === key)?.label ?? key,
      );
      const confirmed = await dialogs.confirm({
        title: "This turns off a sandbox or permission check",
        description: `${labels.join(", ")} — the agent will be able to act outside its sandbox in ${snapshot?.workdir ?? "the working directory"}.`,
        confirmLabel: "Save anyway",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    const patch = Object.fromEntries(dirtyKeys.map((key) => [key, drafts[key] as SettingValue]));
    const result = await save(patch);
    if (result.ok) {
      setDrafts({});
      setNotice(
        result.changed.length === 0
          ? "No changes to save."
          : `Saved ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}${
              runInProgress ? " — applies to the next run." : "."
            }`,
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--backdrop)] p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-surface-1 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-fg-muted">settings</h2>
          {snapshot !== null && (
            <span className="truncate text-[11px] text-fg-dim" title={snapshot.storagePath}>
              saved to {snapshot.storagePath}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-fg-muted transition-colors hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 border-r border-line p-2">
            {(snapshot?.groups ?? []).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setGroup(name)}
                className={[
                  "mb-1 block w-full rounded px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  name === activeGroup
                    ? "bg-surface-3 text-fg"
                    : "text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                {name}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-4 py-2">
            {loading && snapshot === null && <p className="py-6 text-fg-dim">loading…</p>}
            {snapshot === null && !loading && (
              <p className="py-6 text-danger">
                Could not reach the backend at {serverUrl}. Is the server running?
              </p>
            )}
            {fields.map((field) => (
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
          </div>
        </div>

        <footer className="border-t border-line px-4 py-3">
          {errors.length > 0 && (
            <ul className="mb-2 space-y-0.5 text-[11px] text-danger">
              {errors.map((message) => (
                <li key={message}>✗ {message}</li>
              ))}
            </ul>
          )}
          {notice !== null && <p className="mb-2 text-[11px] text-success">✓ {notice}</p>}
          {snapshot !== null && !snapshot.workdirExists && (
            <p className="mb-2 text-[11px] text-warning">
              ⚠ Working directory does not exist: {snapshot.workdir}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void dialogs
                  .confirm({
                    title: "Discard every saved override?",
                    description: "All settings go back to the values in .env.",
                    confirmLabel: "Reset to .env",
                    tone: "danger",
                  })
                  .then((confirmed) => {
                    if (!confirmed) return;
                    setDrafts({});
                    void reset();
                    setNotice("Reverted to the values in .env.");
                  });
              }}
              disabled={saving}
              className="rounded border border-line px-3 py-1.5 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
            >
              reset all to .env
            </button>

            <span className="ml-auto text-[11px] text-fg-dim">
              {dirtyKeys.length > 0
                ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"}`
                : runInProgress
                  ? "changes apply to the next run"
                  : "changes apply immediately"}
            </span>

            <button
              type="button"
              onClick={() => {
                setDrafts({});
                setNotice(null);
              }}
              disabled={dirtyKeys.length === 0 || saving}
              className="rounded border border-line px-3 py-1.5 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
            >
              discard
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={dirtyKeys.length === 0 || saving}
              className="rounded border border-success/40 bg-success/15 px-4 py-1.5 text-[11px] text-success transition-colors hover:bg-success/25 disabled:opacity-40"
            >
              {saving ? "saving…" : "save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

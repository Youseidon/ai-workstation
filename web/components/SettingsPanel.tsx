"use client";

import { useEffect, useMemo, useState } from "react";
import type { SettingValue } from "@agent-console/shared";
import { useSettings } from "@/lib/useSettings";
import { SettingRow } from "./SettingField";

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

  const fields = snapshot?.fields.filter((field) => field.group === activeGroup) ?? [];

  const onSave = async () => {
    if (dirtyKeys.length === 0) return;
    if (dangerousPending.length > 0) {
      const labels = dangerousPending.map(
        (key) => snapshot?.fields.find((field) => field.key === key)?.label ?? key,
      );
      const confirmed = window.confirm(
        `This turns off a sandbox or permission check:\n\n${labels.join("\n")}\n\nThe agent will be able to act outside its sandbox in ${snapshot?.workdir ?? "the working directory"}. Save anyway?`,
      );
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#242a33] bg-[#0e1115] shadow-2xl">
        <header className="flex items-center gap-3 border-b border-[#1d2229] px-4 py-3">
          <h2 className="text-xs uppercase tracking-[0.2em] text-[#9aa4b1]">settings</h2>
          {snapshot !== null && (
            <span className="truncate text-[11px] text-[#4e5661]" title={snapshot.storagePath}>
              saved to {snapshot.storagePath}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-[#7d8794] transition-colors hover:text-[#e7ecf2]"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 border-r border-[#1d2229] p-2">
            {(snapshot?.groups ?? []).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setGroup(name)}
                className={[
                  "mb-1 block w-full rounded px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  name === activeGroup
                    ? "bg-[#1a2028] text-[#e7ecf2]"
                    : "text-[#7d8794] hover:text-[#d7dde5]",
                ].join(" ")}
              >
                {name}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-4 py-2">
            {loading && snapshot === null && <p className="py-6 text-[#5b636e]">loading…</p>}
            {snapshot === null && !loading && (
              <p className="py-6 text-red-400">
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

        <footer className="border-t border-[#1d2229] px-4 py-3">
          {errors.length > 0 && (
            <ul className="mb-2 space-y-0.5 text-[11px] text-red-400">
              {errors.map((message) => (
                <li key={message}>✗ {message}</li>
              ))}
            </ul>
          )}
          {notice !== null && <p className="mb-2 text-[11px] text-emerald-400">✓ {notice}</p>}
          {snapshot !== null && !snapshot.workdirExists && (
            <p className="mb-2 text-[11px] text-amber-400">
              ⚠ Working directory does not exist: {snapshot.workdir}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Discard every saved override and go back to the .env values?")) {
                  setDrafts({});
                  void reset();
                  setNotice("Reverted to the values in .env.");
                }
              }}
              disabled={saving}
              className="rounded border border-[#242a33] px-3 py-1.5 text-[11px] text-[#7d8794] transition-colors hover:text-[#d7dde5] disabled:opacity-50"
            >
              reset all to .env
            </button>

            <span className="ml-auto text-[11px] text-[#5b636e]">
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
              className="rounded border border-[#242a33] px-3 py-1.5 text-[11px] text-[#9aa4b1] transition-colors hover:text-[#e7ecf2] disabled:opacity-40"
            >
              discard
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={dirtyKeys.length === 0 || saving}
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-4 py-1.5 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
            >
              {saving ? "saving…" : "save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { formatSettingValue, inputTokenAllowance, type ProviderId } from "@agent-console/shared";
import { SettingsGroupDialog } from "@/components/SettingsGroupDialog";
import { compactTokens } from "@/components/settings/SpendMap";
import { SERVER_URL } from "@/lib/serverUrl";
import { RUN_BUDGETS_GROUP } from "@/lib/settingsGroups";
import { useSettings } from "@/lib/useSettings";

/** The limits worth knowing before a run starts, in the order they usually bite. */
const HEADLINE = ["budget.maxSpendUsd", "budget.maxWallClockMinutes", "budget.maxToolCalls"] as const;

/** What follows the figure. Tool calls already name themselves ("1,000 calls"). */
const CAPTION: Record<(typeof HEADLINE)[number], string | null> = {
  "budget.maxSpendUsd": "spend",
  "budget.maxWallClockMinutes": "time",
  "budget.maxToolCalls": null,
};

/**
 * What the next run is allowed, shown where the run is started. A run that
 * reaches one of these is stopped, so the person about to launch a long job
 * should not have to go looking for the number first.
 */
export function BudgetStrip({ provider, providerLabel, model }: { provider: ProviderId; providerLabel: string; model: string | null }) {
  const settings = useSettings(SERVER_URL);
  const [editing, setEditing] = useState(false);
  const fields = settings.snapshot?.fields ?? [];
  const chips = HEADLINE.flatMap((key) => {
    const field = fields.find((entry) => entry.key === key);
    return field === undefined || field.scale === null || typeof field.value !== "number" ? [] : [{ key, field, value: field.value, scale: field.scale }];
  });
  if (chips.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Limits for one run. Click to change them."
        className="group mx-auto mt-3 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full px-3 py-1 text-[11px] text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg-muted"
      >
        <span className="uppercase tracking-wider">Per run</span>
        {chips.map(({ key, value, scale }) => {
          const tokens = key === "budget.maxSpendUsd" ? inputTokenAllowance(value, provider, model) : null;
          return (
            <span key={key} className="inline-flex items-baseline gap-1.5">
              <span className={value === 0 ? "font-mono font-semibold text-warning" : "font-mono font-semibold text-fg-muted group-hover:text-fg"}>
                {formatSettingValue(value, scale)}
              </span>
              {CAPTION[key] !== null && value !== 0 && <span>{CAPTION[key]}</span>}
              {tokens !== null && (
                <span title={`${formatSettingValue(value, scale)} at ${model ?? "the default model"}'s list price`}>
                  ≈ {compactTokens(tokens)} tokens on {providerLabel}
                </span>
              )}
            </span>
          );
        })}
        <span className="text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Edit</span>
      </button>
      {editing && (
        <SettingsGroupDialog
          group={RUN_BUDGETS_GROUP}
          onSaved={() => void settings.reload()}
          onClose={() => {
            setEditing(false);
            void settings.reload();
          }}
        />
      )}
    </>
  );
}

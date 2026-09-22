"use client";

import { useEffect, useState } from "react";
import type { ProviderId } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

export function SuiteFallbackEditor({
  pipelineId,
  suiteId,
  value,
  onChanged,
}: {
  pipelineId: number;
  suiteId: number;
  value: ProviderId[];
  onChanged?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<ProviderId[]>(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);

  async function save(next: ProviderId[]) {
    setLocal(next);
    setBusy(true);
    try {
      await workspaceApi.updatePipelineDefaults(SERVER_URL, pipelineId, suiteId, {
        defaultFallbackProviders: next,
      });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      {PROVIDER_IDS.map((id) => {
        const theme = providerTheme[id];
        const index = local.indexOf(id);
        const active = index >= 0;
        return (
          <button
            key={id}
            type="button"
            disabled={busy}
            title={active ? `Fallback #${index + 1} — click to remove` : "Add as suite fallback"}
            onClick={() => {
              const next = active ? local.filter((entry) => entry !== id) : [...local, id];
              void save(next);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset",
              active ? theme.chip : "text-fg-muted ring-line hover:bg-surface-3",
              busy && "opacity-60",
            )}
          >
            {id}
            {active && <span className="opacity-70">#{index + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

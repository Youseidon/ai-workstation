import type { ProviderId } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";

/**
 * The provider tag on every log row. When the run pinned a model, the chip
 * carries it too — so a transcript that mixes providers and models stays
 * readable without cross-referencing the header.
 */
export function ProviderChip({
  provider,
  model = null,
}: {
  provider: ProviderId;
  model?: string | null;
}) {
  const label = modelLabel(provider, model);
  return (
    <span
      className={`inline-flex min-w-0 items-baseline gap-1 rounded px-1.5 py-px text-[10px] uppercase tracking-wider ring-1 ring-inset ${providerTheme[provider].chip}`}
      title={model === null ? provider : `${provider} · ${model}`}
    >
      <span>{provider}</span>
      {label !== null && (
        <>
          <span className="opacity-40">·</span>
          <span className="truncate normal-case tracking-normal opacity-80">{label}</span>
        </>
      )}
    </span>
  );
}

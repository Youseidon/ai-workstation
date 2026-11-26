import type { ProviderId } from "@hydra/shared";
import { modelLabel } from "@hydra/shared";
import { providerTheme } from "@/features/providers/lib/providerTheme";

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
      className={`inline-flex min-w-0 items-baseline gap-1 rounded px-1.5 py-px text-xs uppercase tracking-wider ring-1 ring-inset ${providerTheme[provider].chip}`}
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

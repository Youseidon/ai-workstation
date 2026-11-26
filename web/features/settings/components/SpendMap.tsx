"use client";

import { inputTokenAllowance, ratesForModel, type ProviderId, type ProviderInfo } from "@hydra/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import { useHydra } from "@/hooks/useHydra";
import { useModelSelection } from "@/features/providers/hooks/useModelSelection";

export function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

export interface SpendShare {
  provider: ProviderId;
  label: string;
  model: string | null;
  tokens: number | null;
  rate: number | null;
}

export function spendShares(usd: number, providers: ProviderInfo[], resolve: (id: ProviderId) => string | null): SpendShare[] {
  return providers
    .filter((provider) => provider.available)
    .map((provider) => {
      const model = resolve(provider.id) ?? provider.model;
      return {
        provider: provider.id,
        label: provider.label,
        model,
        tokens: inputTokenAllowance(usd, provider.id, model),
        rate: ratesForModel(provider.id, model)?.rates.inputPerMTok ?? null,
      };
    });
}

export function SpendMap({ usd }: { usd: number }) {
  const { providers } = useHydra();
  const models = useModelSelection(providers);
  if (usd <= 0) {
    return <p className="mt-2 text-xs text-warning/90">No spend cap. Runs are held only by the time and tool-call limits.</p>;
  }
  const shares = spendShares(usd, providers, models.resolve);
  if (shares.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs uppercase tracking-wider text-fg-dim">buys</span>
      {shares.map((share) => (
        <span
          key={share.provider}
          title={
            share.tokens === null
              ? `${share.label}: no list price to convert with`
              : `${share.label} · ${share.model ?? "default model"} · $${share.rate}/M input tokens`
          }
          className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset", providerTheme[share.provider].chip)}
        >
          <span>{share.label}</span>
          <span className="font-mono font-semibold tabular-nums">{share.tokens === null ? "—" : compactTokens(share.tokens)}</span>
        </span>
      ))}
      <span className="text-xs text-fg-dim">input tokens</span>
    </div>
  );
}

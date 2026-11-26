/**
 * In-memory cooling for providers that just failed for a transient reason.
 *
 * No table: a restart clears it, which is fine — the next start will discover
 * the outage again and re-cool. The header pill reads this through
 * `GET /api/providers`.
 */

import type { ProviderId } from "@hydra/shared";
import { coolingMinutesFor } from "@hydra/shared";

interface CoolingEntry {
  provider: ProviderId;
  until: number;
  because: string;
  id: string;
}

const coolingByProvider = new Map<ProviderId, CoolingEntry>();

export function markCooling(provider: ProviderId, id: string, minutes?: number, because?: string, reportedResetAt?: number): void {
  const mins = minutes ?? coolingMinutesFor(id);
  const until = reportedResetAt ?? Date.now() + Math.max(0, mins) * 60_000;
  // A reported reset supersedes an estimate; ordinary failures must not shorten
  // a known account limit just because they use a shorter cooling period.
  if (reportedResetAt === undefined && (coolingByProvider.get(provider)?.until ?? 0) > until) return;
  coolingByProvider.set(provider, {
    provider,
    until,
    because: because ?? `Cooling after ${id}.`,
    id,
  });
}

export function isCooling(provider: ProviderId, now = Date.now()): boolean {
  const entry = coolingByProvider.get(provider);
  if (entry === undefined) return false;
  if (entry.until <= now) {
    coolingByProvider.delete(provider);
    return false;
  }
  return true;
}

export function cooling(now = Date.now()): Array<{ provider: ProviderId; until: string; because: string; id: string }> {
  const out: Array<{ provider: ProviderId; until: string; because: string; id: string }> = [];
  for (const [provider, entry] of coolingByProvider) {
    if (entry.until <= now) {
      coolingByProvider.delete(provider);
      continue;
    }
    out.push({
      provider,
      until: new Date(entry.until).toISOString(),
      because: entry.because,
      id: entry.id,
    });
  }
  return out;
}

export function coolingFor(provider: ProviderId, now = Date.now()): { until: string; because: string; id: string } | null {
  const entry = coolingByProvider.get(provider);
  if (entry === undefined) return null;
  if (entry.until <= now) {
    coolingByProvider.delete(provider);
    return null;
  }
  return { until: new Date(entry.until).toISOString(), because: entry.because, id: entry.id };
}

/**
 * Forget every cooling entry.
 *
 * Cooling is the rail declining to waste a start on a provider that just
 * failed. An operator pressing Resume on a run parked for want of a provider
 * is the opposite instruction — they have topped up, signed in, or simply want
 * it tried — and a Resume that silently re-parks until a timer nobody can see
 * runs out is a button that does nothing.
 */
export function clearCooling(): void {
  coolingByProvider.clear();
}

/** Test helper. */
export function resetProviderHealth(): void {
  clearCooling();
}

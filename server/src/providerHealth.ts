/**
 * In-memory cooling for providers that just failed for a transient reason.
 *
 * No table: a restart clears it, which is fine — the next start will discover
 * the outage again and re-cool. The header pill reads this through
 * `GET /api/providers`.
 */

import type { ProviderId } from "@agent-console/shared";
import { coolingMinutesFor } from "@agent-console/shared";

interface CoolingEntry {
  provider: ProviderId;
  until: number;
  because: string;
  id: string;
}

const coolingByProvider = new Map<ProviderId, CoolingEntry>();

export function markCooling(provider: ProviderId, id: string, minutes?: number, because?: string): void {
  const mins = minutes ?? coolingMinutesFor(id);
  const until = Date.now() + Math.max(0, mins) * 60_000;
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

/** Test helper — production code never clears the table wholesale. */
export function resetProviderHealth(): void {
  coolingByProvider.clear();
}

export class ProviderBusyError extends Error {}
const inflight = new Map<string, Promise<unknown>>();

export function withProviderMaintenance<T>(
  provider: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${provider}:${operation}`;
  const same = inflight.get(key);
  if (same) return same as Promise<T>;
  if ([...inflight.keys()].some((entry) => entry.startsWith(`${provider}:`)))
    return Promise.reject(
      new ProviderBusyError(
        "Provider maintenance is already in progress. Wait for it to finish.",
      ),
    );
  const pending = work().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

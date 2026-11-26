export type SearchParams = Record<string, string | string[] | undefined>;

export function legacyTarget(path: string, params: SearchParams, defaults: Record<string, string> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(defaults)) query.set(key, value);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) { query.delete(key); for (const item of value) query.append(key, item); }
  }
  const qs = query.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

import type { UserIdentity } from "@hydra/shared";

let identityId: string | null = null;
const privateKey = (key: string) => `hydra.user.${identityId ?? "signed-out"}.${key}`;
const legacyKey = (key: string) => key.startsWith("hydra.") && !key.startsWith("hydra.user.") || /^(chat-|chat:)/.test(key);

export function setBrowserIdentity(user: UserIdentity | null): void {
  identityId = user?.id ?? null;
  if (!user?.ownsLegacyData) return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const marker = privateKey("storage-migrated.v1");
    if (storage.getItem(marker)) continue;
    // Only the original operator inherits pre-login drafts and preferences.
    for (const key of Object.keys(storage)) {
      if (!legacyKey(key) || key === "hydra.theme" || key === "hydra.effects") continue;
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(privateKey(key)) === null) storage.setItem(privateKey(key), value);
      storage.removeItem(key);
    }
    storage.setItem(marker, "1");
  }
}

function scoped(kind: "localStorage" | "sessionStorage") {
  return {
    getItem(key: string): string | null { return typeof window === "undefined" || identityId === null ? null : window[kind].getItem(privateKey(key)); },
    setItem(key: string, value: string): void { if (identityId !== null) window[kind].setItem(privateKey(key), value); },
    removeItem(key: string): void { if (identityId !== null) window[kind].removeItem(privateKey(key)); },
  };
}
export const userLocalStorage = scoped("localStorage");
export const userSessionStorage = scoped("sessionStorage");

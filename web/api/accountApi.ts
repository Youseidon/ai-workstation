import type { DemoAvailability, IdentitySession, TelegramAccess, TelegramAccountView, TelegramAuditEntry, TelegramLinkCode } from "@hydra/shared";
import { apiFetch } from "@/api/http";
import { SERVER_URL } from "@/api/serverUrl";

async function call<T>(path: string, method = "GET", input?: Record<string, unknown>): Promise<T> {
  const response = await apiFetch(new URL(`/api/auth/${path}`, SERVER_URL), {
    method, cache: "no-store",
    ...(input ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  let data: unknown = null;
  try { data = await response.json(); } catch {  }
  if (!response.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message ?? response.statusText);
  }
  return data as T;
}

export const accountApi = {
  changePassword: (currentPassword: string, newPassword: string) => call<IdentitySession>("password", "POST", { currentPassword, newPassword }),
  telegram: () => call<TelegramAccountView>("telegram"),
  telegramAudit: () => call<{ entries: TelegramAuditEntry[] }>("telegram/audit"),
  setBot: (token: string) => call<TelegramAccountView>("telegram/bot", "PUT", { token }),
  removeBot: () => call<TelegramAccountView>("telegram/bot", "DELETE"),
  createLink: () => call<TelegramLinkCode>("telegram/link", "POST", {}),
  setAccess: (access: TelegramAccess) => call<TelegramAccountView>("telegram/link", "PATCH", { access }),
  unlink: () => call<TelegramAccountView>("telegram/link", "DELETE"),
};

async function recovery<T>(path: string, input?: Record<string, string>): Promise<T> {
  const response = await fetch(new URL(`/api/auth/recovery${path}`, SERVER_URL), {
    credentials: "include", cache: "no-store",
    ...(input ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const data = await response.json() as T & { error?: { message: string } };
  if (!response.ok) throw new Error(data.error?.message ?? "Recovery failed.");
  return data;
}

export const recoveryApi = {
  available: () => recovery<{ telegram: boolean }>(""),
  requestCode: (username: string) => recovery<{ ok: true }>("/request", { username }),
  reset: (username: string, code: string, password: string) => recovery<IdentitySession>("/reset", { username, code, password }),
};

export const demoApi = {
  async availability(): Promise<DemoAvailability> {
    const response = await fetch(new URL("/api/auth/demo", SERVER_URL), { credentials: "include", cache: "no-store" });
    if (!response.ok) return { available: false, lifetimeHours: 0 };
    return await response.json() as DemoAvailability;
  },
  /** Creates a demo account; the body is an NDJSON stream of `DemoSeedProgress`. */
  async start(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(new URL("/api/auth/demo", SERVER_URL), {
      method: "POST", credentials: "include", cache: "no-store", signal,
      headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!response.ok || !response.body) {
      let message = "The demo could not be started.";
      try { message = ((await response.json()) as { error?: { message?: string } }).error?.message ?? message; } catch { }
      throw new Error(message);
    }
    return response.body;
  },
  /** Abandons a demo whose preparation failed, so its half-made account is not picked up. */
  async abandon(): Promise<void> {
    await fetch(new URL("/api/auth/logout", SERVER_URL), { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
  },
};

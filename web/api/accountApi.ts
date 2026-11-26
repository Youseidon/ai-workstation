import type { IdentitySession, TelegramAccess, TelegramAccountView, TelegramAuditEntry, TelegramLinkCode } from "@hydra/shared";
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

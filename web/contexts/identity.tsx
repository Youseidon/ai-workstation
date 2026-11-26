"use client";

import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { IdentitySession, UserIdentity } from "@hydra/shared";
import { SERVER_URL } from "@/api/serverUrl";
import { setBrowserIdentity } from "@/lib/identityStorage";
import { HydraMark } from "@/components/brand/HydraMark";

const IdentityContext = createContext<{ user: UserIdentity; logout(): Promise<void> } | null>(null);
export function useIdentity() {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("Identity provider is required");
  return value;
}

async function authRequest(path: string, input?: Record<string, string>): Promise<IdentitySession> {
  const response = await fetch(new URL(`/api/auth/${path}`, SERVER_URL), {
    credentials: "include", cache: "no-store", ...(input ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const data = await response.json() as IdentitySession & { error?: { message: string } };
  if (!response.ok) throw new Error(data.error?.message ?? "Unable to sign in.");
  return data;
}

export function IdentityGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [error, setError] = useState("");
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentIdentity = useRef<string | null | undefined>(undefined);

  function accept(next: IdentitySession) {
    if (currentIdentity.current !== undefined && currentIdentity.current !== (next.user?.id ?? null)) {
      setBrowserIdentity(null);
      window.location.reload();
      return;
    }
    currentIdentity.current = next.user?.id ?? null;
    try { setBrowserIdentity(next.user); } catch { /* Storage is optional; account data remains on the server. */ }
    setSession(next); setError("");
  }

  useEffect(() => {
    let disposed = false;
    const refresh = () => { void authRequest("session").then(next => { if (!disposed) accept(next); }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : "Cannot reach the Hydra server."); }); };
    const expire = () => { setBrowserIdentity(null); setSession(null); refresh(); };
    const channel = new BroadcastChannel("hydra.identity");
    channel.onmessage = () => { setBrowserIdentity(null); window.location.reload(); };
    window.addEventListener("hydra.session-expired", expire);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 30_000);
    refresh();
    return () => { disposed = true; clearInterval(timer); channel.close(); window.removeEventListener("hydra.session-expired", expire); window.removeEventListener("focus", refresh); };
  }, []);

  const notifyTabs = () => { const channel = new BroadcastChannel("hydra.identity"); channel.postMessage("changed"); channel.close(); };
  const logout = async () => {
    await authRequest("logout", {});
    setBrowserIdentity(null); notifyTabs(); window.location.reload();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      await authRequest(register ? "register" : "login", {
        username: String(data.get("username") ?? ""), password: String(data.get("password") ?? ""),
      });
      notifyTabs(); window.location.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to sign in."); }
    finally { setBusy(false); }
  }

  if (session?.user) return <IdentityContext.Provider value={{ user: session.user, logout }}><div key={session.user.id} className="contents">{children}</div></IdentityContext.Provider>;
  const creating = register;
  return <main className="flex min-h-screen items-center justify-center bg-surface-0 p-6">
    <div className="w-full max-w-md rounded-2xl border border-line bg-surface-1 p-8 shadow-xl">
      <HydraMark size={40} />
      <h1 className="mt-5 text-2xl font-semibold">{creating ? "Create an account" : "Sign in to Hydra"}</h1>
      <p className="mt-2 text-sm text-fg-muted">Your workspaces, conversations and agent settings stay with your account.</p>
      {session === null ? <div className="mt-6" role="status">{error || "Connecting to Hydra…"}</div> : <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">Username<input name="username" required autoComplete="username" minLength={3} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}" className="rounded-lg border border-line bg-surface-0 px-3 py-2" /></label>
        <label className="flex flex-col gap-1 text-sm">Password<input name="password" type="password" required minLength={creating ? 12 : undefined} maxLength={1024} autoComplete={creating ? "new-password" : "current-password"} className="rounded-lg border border-line bg-surface-0 px-3 py-2" />{creating && <span className="text-xs text-fg-muted">At least 12 characters.</span>}</label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="rounded-lg bg-fg px-4 py-2 font-medium text-surface-0 disabled:opacity-50">{busy ? "Please wait…" : creating ? "Create account" : "Sign in"}</button>
        <button type="button" disabled={busy} className="text-sm text-fg-muted underline" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already have an account? Sign in" : "Create a separate account"}</button>
      </form>}
    </div>
  </main>;
}

export function AccountControl() {
  const { user, logout } = useIdentity();
  const [error, setError] = useState("");
  return <div className="mt-3 text-xs text-fg-muted"><div className="flex items-center justify-between gap-2"><span className="truncate" title={user.username}>{user.username}</span><button type="button" className="shrink-0 underline" onClick={() => { void logout().catch(() => setError("Could not sign out. Try again.")); }}>Sign out</button></div>{error && <p role="alert">{error}</p>}</div>;
}

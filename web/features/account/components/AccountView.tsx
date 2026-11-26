"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { accountApi } from "@/api/accountApi";
import { Badge, Button, TextInput, useToast } from "@/components/ui";
import { useIdentity } from "@/contexts/identity";
import { TelegramSection } from "./TelegramSection";

function Section({ id, title, description, icon, children }: { id: string; title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-6 rounded-xl border border-line bg-surface-1 p-5 sm:p-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
    <div className="flex items-start gap-3 lg:flex-col lg:gap-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-muted" aria-hidden>{icon}</span>
      <div>
        <h2 id={`${id}-title`} className="text-base font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{description}</p>
      </div>
    </div>
    <div className="min-w-0">{children}</div>
  </section>;
}

function SectionIcon({ children }: { children: ReactNode }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

function PasswordForm() {
  const toast = useToast();
  const { user } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get("newPassword") ?? "");
    if (next !== String(data.get("repeat") ?? "")) { setError("The new passwords do not match."); return; }
    setBusy(true); setError(null);
    try {
      await accountApi.changePassword(String(data.get("currentPassword") ?? ""), next);
      form.reset();
      toast.success("Password changed", "Every other session of this account was signed out.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change the password."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="flex flex-col gap-5">
    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
    <TextInput label="Current password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024} />
    <TextInput label="New password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} hint="At least 12 characters." />
    <TextInput label="Repeat new password" name="repeat" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} error={error} />
    <div className="flex flex-col items-start gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="max-w-64 text-xs leading-relaxed text-fg-dim">Every other browser session will be signed out.</p>
      <Button type="submit" variant="primary" loading={busy}>Change password</Button>
    </div>
  </form>;
}

export function AccountView() {
  const { user } = useIdentity();
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 sm:py-10">
    <header>
      <p className="mb-2 text-xs font-medium uppercase tracking-widest text-fg-dim">Personal settings</p>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Account settings</h1>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">Manage your password, notifications and account recovery.</p>
    </header>
    <div className="flex min-w-0 items-center gap-4 rounded-xl border border-line bg-surface-1 p-5 sm:px-6">
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent ring-1 ring-inset ring-accent/20">{user.username.slice(0, 2).toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-fg-dim">Signed in as</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 break-all font-semibold">{user.username}</p>
          {user.ownsLegacyData && <Badge tone="accent">Installation owner</Badge>}
        </div>
      </div>
    </div>
    <Section id="password" title="Password" description="Keep your account secure with a strong, unique password." icon={<SectionIcon><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></SectionIcon>}>
      <PasswordForm />
    </Section>
    <Section id="telegram" title="Telegram" description="Get alerts, check on agents and pipelines, and recover your password from your phone." icon={<SectionIcon><path d="m21 3-7 18-4-7-7-4 18-7ZM10 14l5-5" /></SectionIcon>}>
      <TelegramSection />
    </Section>
    <Section id="recovery" title="Account recovery" description="A way back in if you forget your password." icon={<SectionIcon><path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2" /></SectionIcon>}>
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-fg-muted">
        <p>With Telegram connected, choose <span className="font-medium text-fg">Forgot password?</span> on the sign-in screen to receive a reset code.</p>
        <details className="rounded-lg border border-line bg-surface-0">
          <summary className="cursor-pointer rounded-lg px-4 py-3 font-medium text-fg hover:bg-surface-2">Recover from the Hydra machine</summary>
          <div className="flex flex-col gap-3 border-t border-line p-4">
            <p>Anyone with shell access to the machine running Hydra can set a new password. Run this in the Hydra directory:</p>
            <code className="block break-all rounded-md border border-line bg-surface-2 px-3 py-2.5 text-xs text-fg">npm run reset-password -- {user.username}</code>
            <p className="text-xs text-fg-dim">You will be asked to enter a new password twice.</p>
          </div>
        </details>
      </div>
    </Section>
  </div>;
}

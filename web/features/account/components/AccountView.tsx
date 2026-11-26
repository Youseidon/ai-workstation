"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { accountApi } from "@/api/accountApi";
import { Badge, Button, TextInput, useToast } from "@/components/ui";
import { useIdentity } from "@/contexts/identity";
import { TelegramSection } from "./TelegramSection";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface-1 p-5">
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
    </div>
    {children}
  </section>;
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
  return <form onSubmit={submit} className="flex max-w-md flex-col gap-3">
    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
    <TextInput label="Current password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024} />
    <TextInput label="New password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} hint="At least 12 characters." />
    <TextInput label="Repeat new password" name="repeat" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} error={error} />
    <div><Button type="submit" variant="primary" loading={busy}>Change password</Button></div>
  </form>;
}

export function AccountView() {
  const { user } = useIdentity();
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5">
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-semibold">{user.username}</h1>
      {user.ownsLegacyData && <Badge tone="accent">Installation owner</Badge>}
    </header>
    <Section title="Password" description="Changing it signs out every other browser using this account.">
      <PasswordForm />
    </Section>
    <Section title="Telegram" description="Get alerts and check on running agents and pipelines from Telegram. It can also send you a code if you forget your password.">
      <TelegramSection />
    </Section>
    <p className="px-1 text-xs leading-relaxed text-fg-dim">
      Locked out with no Telegram? Anyone with a shell on the machine running Hydra can set a new password:{" "}
      <code className="rounded bg-surface-2 px-1">npm run reset-password -- {user.username}</code>
    </p>
  </div>;
}

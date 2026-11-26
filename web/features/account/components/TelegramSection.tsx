"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { TelegramAccountView, TelegramAuditEntry, TelegramLinkCode } from "@hydra/shared";
import { accountApi } from "@/api/accountApi";
import { Badge, Button, TextInput, useDialogs, useToast } from "@/components/ui";
import { ACCESS_OPTIONS, auditLabel, botStatusLabel, minutesLeft } from "../lib/telegram";

function BotSetup({ replacing, onSaved, onCancel }: { replacing: boolean; onSaved(view: TelegramAccountView): void; onCancel?(): void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { onSaved(await accountApi.setBot(token)); setToken(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the bot."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-0 p-4">
    <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
      <li>In Telegram, open <b>@BotFather</b> and send <code>/newbot</code>. Make a bot just for Hydra.</li>
      <li>Copy the token BotFather gives you and paste it here.</li>
    </ol>
    <TextInput label="Bot token" type="password" autoComplete="off" spellCheck={false} required value={token} onChange={event => setToken(event.target.value)} placeholder="123456789:AA…" error={error}
      hint={replacing ? "Saving a new bot disconnects every account's Telegram chat." : "Stored in Hydra's account registry on this machine. The browser never sees it again."} />
    <div className="flex gap-2">
      <Button type="submit" variant="primary" loading={busy} disabled={token.trim() === ""}>Save bot</Button>
      {onCancel && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
    </div>
  </form>;
}

function Connect({ onLinked }: { onLinked(view: TelegramAccountView): void }) {
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (code === null) return;
    const timer = setInterval(() => {
      tick(value => value + 1);
      if (minutesLeft(code.expiresAt) === 0) { setCode(null); return; }
      void accountApi.telegram().then(view => { if (view.link) onLinked(view); }).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [code, onLinked]);
  async function start() {
    setBusy(true); setError(null);
    try { const next = await accountApi.createLink(); setCode(next); window.open(next.url, "_blank", "noopener,noreferrer"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create a link."); }
    finally { setBusy(false); }
  }
  if (code === null) return <div className="flex flex-col gap-2">
    <p className="text-sm text-fg-muted">Connect your own Telegram account to get alerts and check on Hydra from your phone.</p>
    <div><Button variant="primary" loading={busy} onClick={() => { void start(); }}>Connect Telegram</Button></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
  return <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-0 p-4 text-sm" role="status">
    <p>Telegram should have opened. Press <b>Start</b> in the chat with the bot to finish.</p>
    <p className="text-fg-muted">Didn&apos;t open? <a className="underline" href={code.url} target="_blank" rel="noopener noreferrer">Open the link</a> on any device signed in to your Telegram account. It works once and expires in {minutesLeft(code.expiresAt)} min.</p>
    <div><Button size="sm" onClick={() => setCode(null)}>Cancel</Button></div>
  </div>;
}

export function TelegramSection() {
  const toast = useToast();
  const dialogs = useDialogs();
  const [view, setView] = useState<TelegramAccountView | null>(null);
  const [audit, setAudit] = useState<TelegramAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    Promise.all([accountApi.telegram(), accountApi.telegramAudit()])
      .then(([next, log]) => { if (!disposed) { setView(next); setAudit(log.entries); setError(null); } })
      .catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : "Could not load Telegram settings."); });
    return () => { disposed = true; };
  }, []);
  const accept = useCallback((next: TelegramAccountView) => { setView(next); void accountApi.telegramAudit().then(log => setAudit(log.entries)).catch(() => undefined); }, []);

  async function run(work: () => Promise<TelegramAccountView>, done: string) {
    setBusy(true);
    try { accept(await work()); toast.success(done); }
    catch (reason) { toast.error("That did not work", reason instanceof Error ? reason.message : undefined); }
    finally { setBusy(false); }
  }

  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (view === null) return <p className="text-sm text-fg-muted">Loading…</p>;
  const { bot, link, isOwner } = view;

  return <div className="flex flex-col gap-5">
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Bot</h3>
      {bot === null && !isOwner && <p className="text-sm text-fg-muted">Telegram is not set up on this installation. Ask the installation owner to add a bot on their Account page.</p>}
      {bot === null && isOwner && <BotSetup replacing={false} onSaved={next => { accept(next); toast.success("Bot saved"); }} />}
      {bot !== null && <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">@{bot.username}</span>
        <Badge tone={bot.status === "polling" ? "success" : bot.status === "error" ? "danger" : "neutral"}>{botStatusLabel(bot)}</Badge>
        {isOwner && !replacing && <>
          <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>Replace token</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void dialogs.confirm({ title: "Remove the Telegram bot?", description: "Every account's Telegram chat is disconnected and password recovery through Telegram stops.", confirmLabel: "Remove bot", tone: "danger" }).then(ok => { if (ok) void run(accountApi.removeBot, "Bot removed"); }); }}>Remove</Button>
        </>}
      </div>}
      {bot !== null && isOwner && replacing && <BotSetup replacing onCancel={() => setReplacing(false)} onSaved={next => { accept(next); setReplacing(false); toast.success("Bot replaced", "Every account needs to connect Telegram again."); }} />}
    </div>

    {bot !== null && <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Your Telegram</h3>
      {link === null ? <Connect onLinked={next => { accept(next); toast.success("Telegram connected"); }} /> : <>
        <p className="text-sm">Connected{link.telegramUsername ? <> as <b>@{link.telegramUsername}</b></> : null} since {new Date(link.linkedAt).toLocaleString()}.</p>
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="mb-1 text-xs font-medium text-fg-muted">What this chat may do</legend>
          {ACCESS_OPTIONS.map(option => <label key={option.value} className="flex cursor-pointer gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent/60 has-[:checked]:bg-accent/5">
            <input type="radio" name="telegram-access" className="mt-1" checked={link.access === option.value}
              onChange={() => {
                if (option.value !== "control") { void run(() => accountApi.setAccess(option.value), "Notifications only"); return; }
                void dialogs.confirm({ title: "Allow full control from Telegram?", description: "Anyone holding your unlocked phone could then start and stop agents that run code on this machine. Each action still needs a confirmation tap.", confirmLabel: "Allow full control" })
                  .then(ok => { if (ok) void run(() => accountApi.setAccess("control"), "Full control allowed"); });
              }} />
            <span className="flex flex-col gap-0.5"><span className="text-sm font-medium">{option.label}</span><span className="text-xs text-fg-muted">{option.description}</span></span>
          </label>)}
        </fieldset>
        <div><Button variant="danger" size="sm" disabled={busy} onClick={() => { void dialogs.confirm({ title: "Disconnect Telegram?", description: "This chat stops receiving alerts, and you can no longer recover your password through Telegram.", confirmLabel: "Disconnect", tone: "danger" }).then(ok => { if (ok) void run(accountApi.unlink, "Telegram disconnected"); }); }}>Disconnect</Button></div>
      </>}
      <p className="text-xs leading-relaxed text-fg-dim">Telegram bot chats are not end-to-end encrypted. Hydra sends summaries only: step names, states, errors and the questions agents ask. It never sends transcripts, diffs or file contents.</p>
    </div>}

    {audit.length > 0 && <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Recent Telegram activity</h3>
      <ul className="divide-y divide-line rounded-lg border border-line text-sm">
        {audit.slice(0, 15).map((entry, index) => <li key={`${entry.at}-${index}`} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
          <span><span className="font-medium">{auditLabel(entry.action)}</span> <span className="text-fg-muted">{entry.detail}</span></span>
          <time className="text-xs text-fg-dim" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
        </li>)}
      </ul>
    </div>}
  </div>;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { TelegramLiveStatus } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

export type TelegramSetupStep = "bot" | "connecting" | "phone" | "confirm" | "enable" | "ready";

export function telegramSetupStep(status: TelegramLiveStatus | null, controlsEnabled = true, changingBot = false): TelegramSetupStep {
  if (status === null || !status.tokenConfigured || status.state === "auth_failed" || status.state === "missing_token") return "bot";
  // A connected bot never reaches the token step again by itself, so the
  // operator asking for another one is what sends the dialog back there.
  if (changingBot) return "bot";
  if (status.state !== "polling" && status.state !== "backoff") return "connecting";
  if (status.actors.length > 0) return controlsEnabled ? "ready" : "enable";
  if (status.pairing?.observed) return "confirm";
  return "phone";
}

interface Props {
  open: boolean;
  onClose(): void;
  /** Enables the useful personal-control defaults after a token validates. */
  onEnable(): Promise<void>;
  onChanged(): void;
  controlsEnabled: boolean;
}

export function TelegramSetupDialog({ open, onClose, onEnable, onChanged, controlsEnabled }: Props) {
  const [status, setStatus] = useState<TelegramLiveStatus | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingBot, setChangingBot] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await workspaceApi.telegramStatus(SERVER_URL));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telegram status is unavailable.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void workspaceApi.telegramStatus(SERVER_URL).then(setStatus).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Telegram status is unavailable.");
    });
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telegram setup could not continue.");
    } finally {
      setBusy(false);
    }
  }

  async function saveToken(): Promise<void> {
    await act(async () => {
      await workspaceApi.configureTelegram(SERVER_URL, token);
      setToken("");
      setChangingBot(false);
      await onEnable();
    });
  }

  async function enableExisting(): Promise<void> {
    await act(onEnable);
  }

  async function startPairing(): Promise<void> {
    await act(async () => { await workspaceApi.startTelegramPairing(SERVER_URL); });
  }

  async function confirmPairing(): Promise<void> {
    const code = status?.pairing?.code;
    if (code === undefined) return;
    await act(async () => { await workspaceApi.confirmTelegramPairing(SERVER_URL, code); });
  }

  // Closing abandons a half-entered change of bot, so reopening shows the bot in use.
  function close(): void {
    setChangingBot(false);
    setToken("");
    onClose();
  }

  const step = telegramSetupStep(status, controlsEnabled, changingBot);
  const pairing = status?.pairing ?? null;
  const currentBot = status?.bot?.username ? `@${status.bot.username}` : "the current bot";
  const useDifferentBot = (
    <Button className="ml-auto" size="sm" variant="ghost" disabled={busy} onClick={() => { setError(null); setChangingBot(true); }}>Use a different bot</Button>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Set up Telegram"
      description="Connect this workstation to your own Telegram bot. Your teammate should repeat this setup with a different bot on their workstation."
      footer={
        step === "ready" ? (
          <Button size="sm" variant="success" onClick={close}>Done</Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={close} disabled={busy}>Finish later</Button>
        )
      }
    >
      <ol className="grid grid-cols-3 gap-2 text-[11px]" aria-label="Telegram setup progress">
        <Progress label="1. Connect bot" active={step === "bot" || step === "connecting"} complete={step !== "bot" && step !== "connecting"} />
        <Progress label="2. Pair phone" active={step === "phone" || step === "confirm"} complete={step === "enable" || step === "ready"} />
        <Progress label="3. Ready" active={step === "enable" || step === "ready"} complete={false} />
      </ol>

      {step === "bot" && (
        <section className="mt-5">
          {changingBot ? (
            <>
              <h3 className="text-sm font-medium text-fg">Use a different bot</h3>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Paste the token of the bot this workstation should use instead of {currentBot}. A phone paired with {currentBot} is unpaired, and the next step pairs it with the new bot.
              </p>
            </>
          ) : (
            <>
              <h3 className="text-sm font-medium text-fg">Create your personal bot</h3>
              <p className="mt-1 text-xs leading-5 text-fg-muted">
                Open <a className="text-accent underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, send <code>/newbot</code>, and follow its two prompts. Then paste the token it gives you below.
              </p>
            </>
          )}
          <label className="mt-3 block text-[11px] uppercase tracking-wider text-fg-dim" htmlFor="telegram-bot-token">Bot token</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="telegram-bot-token"
              type={showToken ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder="123456789:AA…"
              className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-fg-dim focus:border-line-strong focus:outline-none"
            />
            <Button size="sm" variant="ghost" onClick={() => setShowToken(current => !current)}>{showToken ? "Hide" : "Show"}</Button>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-fg-dim">
            The server validates the token directly with Telegram, stores it only in an owner-readable local credential file, and never returns it to the browser or passes it to agents.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            {changingBot && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setToken(""); setError(null); setChangingBot(false); }}>Keep {currentBot}</Button>
            )}
            <Button size="sm" variant="primary" loading={busy} disabled={token.trim() === ""} onClick={() => void saveToken()}>
              Save bot and continue
            </Button>
          </div>
        </section>
      )}

      {step === "connecting" && (
        <section className="mt-5 rounded-md border border-line bg-surface-0 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info" dot pulse>connecting</Badge>
            {status?.bot?.username && <span className="font-mono text-xs text-fg">@{status.bot.username}</span>}
            {useDifferentBot}
          </div>
          <p className="mt-2 text-xs text-fg-muted">{status?.reason ?? "Checking the local Telegram service…"}</p>
          {status?.tokenConfigured && status.state === "disabled" && (
            <div className="mt-3">
              <Button size="sm" variant="primary" loading={busy} onClick={() => void enableExisting()}>Enable and connect</Button>
            </div>
          )}
        </section>
      )}

      {(step === "phone" || step === "confirm") && (
        <section className="mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status?.state === "backoff" ? "warning" : "success"} dot>{status?.state === "backoff" ? "retrying" : "connected"}</Badge>
            {status?.bot?.username && <span className="font-mono text-xs text-fg">@{status.bot.username}</span>}
            {useDifferentBot}
          </div>
          {pairing === null ? (
            <div className="mt-4 rounded-md border border-line bg-surface-0 p-4">
              <h3 className="text-sm font-medium text-fg">Pair your Telegram account</h3>
              <p className="mt-1 text-xs leading-5 text-fg-muted">This creates a short-lived, one-person link. Pair from a private chat so only your Telegram account can control this workstation.</p>
              <Button className="mt-3" size="sm" variant="primary" disabled={status?.state !== "polling"} loading={busy} onClick={() => void startPairing()}>Create pairing link</Button>
            </div>
          ) : pairing.observed === null ? (
            <div className="mt-4 rounded-md border border-line bg-surface-0 p-4">
              <h3 className="text-sm font-medium text-fg">Open your bot on Telegram</h3>
              <p className="mt-1 text-xs leading-5 text-fg-muted">Use the button on this device, then tap Start in Telegram. If the link does not open, send the command shown below in a private chat with the bot.</p>
              {pairing.deepLink !== null && (
                <a className="mt-3 inline-flex rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black" href={pairing.deepLink} target="_blank" rel="noreferrer">Open @{status?.bot?.username ?? "bot"}</a>
              )}
              <code className="mt-3 block break-all rounded bg-surface-1 px-2.5 py-2 font-mono text-xs text-fg">/start {pairing.code}</code>
              <Button className="mt-2" size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { await workspaceApi.cancelTelegramPairing(SERVER_URL); })}>Cancel link</Button>
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-success/40 bg-surface-0 p-4">
              <h3 className="text-sm font-medium text-fg">Confirm this is you</h3>
              <p className="mt-2 text-sm text-fg">{pairing.observed.label}{pairing.observed.username && <span className="ml-1.5 text-fg-muted">@{pairing.observed.username}</span>}</p>
              <p className="mt-1 text-[11px] text-fg-dim">Telegram user {pairing.observed.transportUserId}</p>
              <p className="mt-2 text-xs leading-5 text-fg-muted">Confirming lets this account receive task questions and use validated phone actions. Team and handover remain off until you enable them separately.</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { await workspaceApi.cancelTelegramPairing(SERVER_URL); })}>Not me</Button>
                <Button size="sm" variant="success" loading={busy} onClick={() => void confirmPairing()}>Confirm pairing</Button>
              </div>
            </div>
          )}
        </section>
      )}

      {step === "ready" && (
        <section className="mt-5 rounded-md border border-success/40 bg-surface-0 p-4">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="success" dot>ready</Badge>{status?.bot?.username && <span className="font-mono text-xs text-fg">@{status.bot.username}</span>}{useDifferentBot}</div>
          <h3 className="mt-3 text-sm font-medium text-fg">Telegram is ready on this workstation</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">Task notifications and validated phone actions are enabled for {status?.actors[0]?.label ?? "your paired account"}. Your teammate should run this setup on their workstation with their own bot.</p>
          <p className="mt-2 text-[11px] text-fg-dim">Use the Telegram status card to inspect delivery health, pair another phone or unpair an account.</p>
        </section>
      )}

      {step === "enable" && (
        <section className="mt-5 rounded-md border border-accent/40 bg-surface-0 p-4">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="success" dot>paired</Badge>{status?.bot?.username && <span className="font-mono text-xs text-fg">@{status.bot.username}</span>}{useDifferentBot}</div>
          <h3 className="mt-3 text-sm font-medium text-fg">Finish personal controls</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">The bot and phone are paired. Enable task notifications and validated phone actions to make the connection useful. Team and handover remain off.</p>
          <Button className="mt-3" size="sm" variant="primary" loading={busy} onClick={() => void enableExisting()}>Enable personal controls</Button>
        </section>
      )}

      {error !== null && <p role="alert" className="mt-4 rounded border border-danger/40 bg-surface-0 px-3 py-2 text-xs text-danger">{error}</p>}
    </Modal>
  );
}

function Progress({ label, active, complete }: { label: string; active: boolean; complete: boolean }) {
  return <li className={`rounded border px-2 py-1.5 text-center ${active ? "border-accent text-fg" : complete ? "border-success/40 text-success" : "border-line text-fg-dim"}`}>{complete ? "✓ " : ""}{label}</li>;
}

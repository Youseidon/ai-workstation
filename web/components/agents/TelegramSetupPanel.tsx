"use client";

import { useCallback, useEffect, useState } from "react";
import { formatElapsed, type TelegramLiveState, type TelegramLiveStatus } from "@agent-console/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

const STATE_LABEL: Record<TelegramLiveState, { label: string; tone: Tone }> = {
  disabled: { label: "off", tone: "neutral" },
  missing_token: { label: "no token", tone: "warning" },
  connecting: { label: "connecting", tone: "info" },
  polling: { label: "connected", tone: "success" },
  backoff: { label: "retrying", tone: "warning" },
  auth_failed: { label: "token rejected", tone: "danger" },
};

function ago(iso: string, now: number): string {
  return `${formatElapsed(now - Date.parse(iso))} ago`;
}

function remaining(iso: string, now: number): string {
  return formatElapsed(Math.max(0, Date.parse(iso) - now));
}

/**
 * Live Bot API status and phone pairing (L1). The token itself is configured
 * in `.env` and never reaches the browser; this panel only sees whether one is
 * set and the bot identity it resolved to.
 */
export function TelegramSetupPanel({ refreshKey }: { refreshKey: unknown }) {
  const [status, setStatus] = useState<TelegramLiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(
    () =>
      workspaceApi
        .telegramStatus(SERVER_URL)
        .then(setStatus)
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        }),
    [],
  );

  useEffect(() => {
    void refresh();
    // Pairing waits on a message from the phone, so poll while this is open.
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, refreshKey]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (status === null) {
    return error === null ? null : <p className="mt-3 text-[11px] text-danger">Telegram status unavailable: {error}</p>;
  }

  const state = STATE_LABEL[status.state];
  const connected = status.state === "polling" || status.state === "backoff";
  const pairing = status.pairing;
  const failedOrQueued = status.outbox.queued + status.outbox.retrying + status.outbox.failed > 0;

  return (
    <div className="mt-3 rounded-md border border-line bg-surface-0 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] text-fg">Live Telegram</h3>
        <Badge tone={state.tone} dot pulse={status.state === "connecting"}>{state.label}</Badge>
        {status.bot?.username && <span className="font-mono text-[11px] text-fg-muted">@{status.bot.username}</span>}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-fg-dim">{status.reason}</p>

      {connected && (
        <p className="mt-2 text-[11px] text-fg-muted">
          {status.lastPollAt === null ? "Long poll open, waiting for the first response" : `Last poll ${ago(status.lastPollAt, now)}`}
          {failedOrQueued && (
            <> · Outbox {status.outbox.queued} queued, {status.outbox.retrying} retrying, {status.outbox.failed} failed</>
          )}
        </p>
      )}
      {status.lastError !== null && (
        <p className="mt-1 break-words text-[11px] text-warning">
          {status.lastError}
          {status.nextRetryAt !== null && <> · next try in {remaining(status.nextRetryAt, now)}</>}
        </p>
      )}

      {status.tokenConfigured && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="text-[11px] uppercase tracking-wider text-fg-dim">Paired chats</div>
          {status.actors.length === 0 ? (
            <p className="mt-1 text-[11px] text-fg-muted">No phone is paired yet. Questions are only sent to paired chats.</p>
          ) : (
            <ul className="mt-1">
              {status.actors.map((actor) => (
                <li key={actor.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                  <span className="min-w-0 text-[12px] text-fg">
                    {actor.label}
                    <span className="ml-2 font-mono text-[10.5px] text-fg-dim">user {actor.transportUserId}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => workspaceApi.removeTelegramActor(SERVER_URL, actor.id))}
                  >
                    Unpair
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {pairing === null ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!connected || busy}
                title={connected ? undefined : "Connect to Telegram first"}
                onClick={() => void act(() => workspaceApi.startTelegramPairing(SERVER_URL))}
              >
                {status.actors.length === 0 ? "Pair a phone" : "Pair another phone"}
              </Button>
            </div>
          ) : pairing.observed === null ? (
            <div className="mt-2 rounded border border-line bg-surface-1 p-2.5 text-[12px] text-fg-muted">
              <p>
                {pairing.deepLink !== null ? (
                  <>
                    On your phone, open{" "}
                    <a className="break-all text-accent underline" href={pairing.deepLink} target="_blank" rel="noreferrer">
                      {pairing.deepLink}
                    </a>{" "}
                    and tap Start, or send the bot:
                  </>
                ) : (
                  "Send the bot this message from a private chat:"
                )}
              </p>
              <code className="mt-1.5 block break-all rounded bg-surface-0 px-2 py-1 font-mono text-[11px] text-fg">/start {pairing.code}</code>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-fg-dim">Waiting for the message · expires in {remaining(pairing.expiresAt, now)}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => workspaceApi.cancelTelegramPairing(SERVER_URL))}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 rounded border border-line bg-surface-1 p-2.5 text-[12px] text-fg-muted">
              <p>Telegram received the code from:</p>
              <p className="mt-1 text-fg">
                {pairing.observed.label}
                {pairing.observed.username !== null && <span className="ml-1.5 text-fg-muted">@{pairing.observed.username}</span>}
                <span className="ml-2 font-mono text-[10.5px] text-fg-dim">user {pairing.observed.transportUserId}</span>
              </p>
              <p className="mt-1 text-[11px] text-fg-dim">Confirm only if this is you. That account will be able to answer and resume tasks.</p>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => workspaceApi.cancelTelegramPairing(SERVER_URL))}>
                  Cancel
                </Button>
                <Button size="sm" variant="success" loading={busy} onClick={() => void act(() => workspaceApi.confirmTelegramPairing(SERVER_URL, pairing.code))}>
                  Confirm pairing
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {error !== null && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

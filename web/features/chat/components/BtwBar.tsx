"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProviderId } from "@hydra/shared";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { SERVER_URL } from "@/api/serverUrl";
import { workspaceApi } from "@/api/workspacesApi";

/**
 * `/btw` to an agent that is already working. Accepts the message with or
 * without a leading `/btw`. The conversation itself (your note, its delivery,
 * the agent's reply) appears in the run's transcript in Chat.
 *
 * Providers with a live input channel (Codex today) get the note mid-turn.
 * Every other provider gets it on its next `agent-step` call, unless the
 * operator asks to interrupt and deliver it now.
 */
export function BtwBar({
  runId,
  provider,
  canInterrupt,
  trailing,
  autoFocus = false,
}: {
  runId: string;
  provider: ProviderId;
  /** Interrupt & deliver restarts a pipeline station; outside a pipeline there is nothing to restart it. */
  canInterrupt: boolean;
  /** Extra controls at the end of the row, e.g. "Open in Chat". */
  trailing?: ReactNode;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [interrupt, setInterrupt] = useState(false);
  const [sending, setSending] = useState(false);
  const [liveDelivery, setLiveDelivery] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    workspaceApi.runMessages(SERVER_URL, runId)
      .then((result) => { if (!cancelled) setLiveDelivery(result.liveDelivery); })
      .catch(() => { if (!cancelled) setLiveDelivery(false); });
    return () => { cancelled = true; };
  }, [runId]);

  const message = text.replace(/^\s*\/btw\b\s*/i, "").trim();
  const showInterrupt = canInterrupt && liveDelivery === false;

  const submit = async () => {
    if (message === "" || sending) return;
    setSending(true);
    try {
      const sent = await workspaceApi.sendBtw(SERVER_URL, runId, { text: message, ...(showInterrupt && interrupt ? { interrupt: true } : {}) });
      setText("");
      setInterrupt(false);
      toast.success(
        "Sent to the agent",
        sent.delivery === "native"
          ? `${provider} received it mid-turn.`
          : sent.delivery === "resume"
            ? "The run was interrupted and continues its session with your note."
            : `${provider} gets it on its next check-in. Tick "Interrupt & deliver now" if it cannot wait.`,
      );
    } catch (error) {
      toast.error("The message was not sent", error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-surface-1 px-3 py-2"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <label className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-accent">/btw</span>
        <input
          type="text"
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Message the running ${provider} agent — e.g. "I already built it, skip that"`}
          aria-label="Message the running agent"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-dim focus:outline-none"
          maxLength={8000}
        />
        <Button type="submit" size="sm" variant="primary" loading={sending} disabled={message === ""}>
          Send
        </Button>
      </label>
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-dim">
        {liveDelivery === true && <span>Delivered live, mid-turn.</span>}
        {liveDelivery === false && (
          <span>
            {provider} reads it on its next <code>agent-step</code> call.
          </span>
        )}
        {showInterrupt && (
          <label className="inline-flex items-center gap-1.5" title="Stops whatever the agent is doing (a stuck build, say) and continues its session with your note">
            <input type="checkbox" checked={interrupt} onChange={(event) => setInterrupt(event.target.checked)} />
            Interrupt &amp; deliver now
          </label>
        )}
        {trailing !== undefined && <span className="ml-auto inline-flex items-center gap-2">{trailing}</span>}
      </div>
    </form>
  );
}

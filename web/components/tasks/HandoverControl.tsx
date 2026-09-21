"use client";

import { useState } from "react";
import type { OperationsPrompt, ProviderId } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi, type HandoverOffer, type HandoverPreview } from "@/lib/workspacesApi";

export type HandoverAvailability = { enabled: true } | { enabled: false; reason: string };

type TeamStatus = Awaited<ReturnType<typeof workspaceApi.teamStatus>>;

/**
 * C1: the handover engine had no button anywhere. This is the requester's half
 * of it, in the shape F03 established: the control is enabled only when it can
 * actually act and says why when it cannot, rather than offering a tap that the
 * capability gate would refuse.
 *
 * Both settings are false by default, so the ordinary state of this control is
 * "not enabled", and that is what it says.
 */
export function handoverAvailability(team: TeamStatus, item: OperationsPrompt): HandoverAvailability {
  if (team === null) {
    return { enabled: false, reason: "Create or join a Team in Agents settings first. A handover offer is posted in the item thread." };
  }
  if (!team.handoverEnabled) {
    return { enabled: false, reason: "Handover is off on this workstation. Turn on team.handoverEnabled in Agents settings; Team stays on and item threads keep working while it is off." };
  }
  if (item.prompt.status === "DONE" || item.prompt.status === "SKIPPED") {
    return { enabled: false, reason: "This work item is finished, so there is nothing to hand over." };
  }
  return { enabled: true };
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rendered from props alone, so both states can be rendered in a test (F03, F06). */
export function HandoverControlView({
  availability,
  preview,
  offer,
  preparing,
  publishing,
  credentialConfirmed,
  onCredentialConfirmed,
  provider,
  onProvider,
  error,
  onPrepare,
  onPublish,
}: {
  availability: HandoverAvailability;
  preview: HandoverPreview | null;
  offer: HandoverOffer | null;
  preparing: boolean;
  publishing: boolean;
  credentialConfirmed: boolean;
  onCredentialConfirmed(value: boolean): void;
  provider: ProviderId;
  onProvider(value: ProviderId): void;
  error: string | null;
  onPrepare(): void;
  onPublish(): void;
}) {
  // jd's ruling of 2026-09-20: the preview warns and never refuses, and a
  // flagged credential shape takes its own confirmation, separate from the
  // ordinary Publish tap, so proceeding is always deliberate.
  const needsCredentialConfirmation = (preview?.flagged.length ?? 0) > 0;
  const publishable = preview !== null && offer === null && (!needsCredentialConfirmation || credentialConfirmed);
  return (
    <div className="mt-3 rounded-panel border border-line bg-surface-2 p-4" aria-label="Hand over to the team">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Hand over to the team</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Capture this work item, push it on its own branch and open it to the team. Whoever accepts runs it
            on their own workstation, under their own login and quota, and hands it back for you to apply.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-fg-muted">
            <span className="sr-only">Agent the receiver is asked for</span>
            <select
              aria-label="Handover agent"
              className="rounded border border-line bg-surface-0 px-2 py-1 text-xs text-fg"
              value={provider}
              disabled={!availability.enabled || offer !== null}
              onChange={event => onProvider(event.target.value as ProviderId)}
            >
              {PROVIDER_IDS.map(one => <option key={one} value={one}>{one}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={!availability.enabled || offer !== null}
            loading={preparing}
            onClick={onPrepare}
          >
            Prepare handover
          </Button>
          <Button size="sm" variant="primary" disabled={!publishable} loading={publishing} onClick={onPublish}>
            Publish offer
          </Button>
        </div>
      </div>

      {!availability.enabled && (
        <p data-testid="handover-reason" className="mt-2 text-xs leading-5 text-fg-dim">
          {availability.reason}
        </p>
      )}

      {preview !== null && offer === null && (
        <div data-testid="handover-preview" className="mt-3 border-t border-line pt-3 text-xs leading-5 text-fg">
          <p className="text-fg-muted">
            {preview.files.length} uncommitted file{preview.files.length === 1 ? "" : "s"} would be published on{" "}
            <code className="break-all">{preview.branch}</code>, {bytes(preview.totalBytes)} in total
            {preview.large ? ", which is large" : ""}.
          </p>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {preview.files.map(file => (
              <li key={file.path} className="flex flex-wrap items-baseline gap-2">
                <code className="break-all">{file.path}</code>
                <span className="text-fg-dim">{file.status.trim()} · {bytes(file.bytes)}</span>
                {file.shapes.length > 0 && (
                  <span className="text-danger">matches {file.shapes.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
          {preview.excluded.length > 0 && (
            <p className="mt-2 text-fg-dim">{preview.excluded.length} ignored file(s) are excluded, not published.</p>
          )}
          {needsCredentialConfirmation && (
            <label data-testid="handover-credential-confirmation" className="mt-3 flex items-start gap-2 rounded border border-danger/40 bg-danger/5 p-2 text-danger">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={credentialConfirmed}
                onChange={event => onCredentialConfirmed(event.target.checked)}
              />
              <span>
                {preview.flagged.length} file(s) match a known credential shape. {preview.risk} {preview.mitigation}
                {" "}Confirm the exposure to publish them anyway.
              </span>
            </label>
          )}
        </div>
      )}

      {offer !== null && (
        <p data-testid="handover-offer" className="mt-2 break-words text-xs leading-5 text-success">
          Offered to the team on {offer.branch} at epoch {offer.epoch}. It names no receiver; whoever accepts
          first wins. It expires {new Date(offer.startDeadline).toLocaleString()}.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 break-words text-xs leading-5 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function HandoverControl({ team, item }: { team: TeamStatus; item: OperationsPrompt }) {
  // The agent the last run used, so the offer asks for what this item was
  // actually being worked with rather than a house default.
  const [provider, setProvider] = useState<ProviderId>(() => {
    const used = item.prompt.currentRun?.provider;
    return PROVIDER_IDS.includes(used as ProviderId) ? used as ProviderId : "claude";
  });
  const [preview, setPreview] = useState<HandoverPreview | null>(null);
  const [offer, setOffer] = useState<HandoverOffer | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [credentialConfirmed, setCredentialConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availability = handoverAvailability(team, item);

  async function prepare(): Promise<void> {
    setPreparing(true); setError(null); setPreview(null); setCredentialConfirmed(false);
    try {
      // The offer is posted in the item thread, so the item is what identifies
      // it. Opening is idempotent for a task that already has one.
      const { itemId } = await workspaceApi.openTeamItem(SERVER_URL, item.prompt.id);
      await workspaceApi.beginHandover(SERVER_URL, itemId);
      setPreview(await workspaceApi.handoverPreview(SERVER_URL, itemId, provider));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare a handover for this work item.");
    } finally {
      setPreparing(false);
    }
  }

  async function publish(): Promise<void> {
    if (preview === null) return;
    setPublishing(true); setError(null);
    try {
      setOffer(await workspaceApi.publishHandover(SERVER_URL, preview.itemId, {
        confirmations: credentialConfirmed ? ["credential_exposure", "publish"] : ["publish"],
        acknowledgedBytes: preview.totalBytes,
      }));
      setPreview(null);
      // The item's shared record moved, so every Team reader re-reads it.
      window.dispatchEvent(new Event("team-roster-changed"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish this handover offer.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <HandoverControlView
      availability={availability}
      preview={preview}
      offer={offer}
      preparing={preparing}
      publishing={publishing}
      credentialConfirmed={credentialConfirmed}
      onCredentialConfirmed={setCredentialConfirmed}
      provider={provider}
      onProvider={setProvider}
      error={error}
      onPrepare={() => void prepare()}
      onPublish={() => void publish()}
    />
  );
}

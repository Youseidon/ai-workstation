"use client";

import { useState } from "react";
import type { OperationsPrompt, ProviderId } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { Button } from "@/components/ui/Button";
import { heldByTeammateReason, type HeldByTeammate } from "@/components/tasks/handoverHold";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi, type HandoverOffer, type HandoverPreview, type HandoverReview } from "@/lib/workspacesApi";

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
  held,
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
  /**
   * M-16. The live handover already on this item, or null.
   *
   * Deliberately **not** folded into `handoverAvailability`: that predicate also
   * gates whether `HandoverReturnView` is mounted at all, and a live handover is
   * exactly when the requester needs "Check for returned work". Refusing it there
   * would take the review panel away for the whole handover.
   */
  held: HeldByTeammate | null;
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
  /*
   * A second handover over a live one is refused server-side, so it is not
   * offered here either - rule F03. The reason shown is the refusal's own, and it
   * replaces the availability reason only when there is none, because "no Team"
   * is the more fundamental answer to "why can I not do this".
   */
  const preparable = availability.enabled && held === null;
  const refusal = !availability.enabled ? availability.reason : held === null ? null : heldByTeammateReason(held);
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
              disabled={!preparable || offer !== null}
              onChange={event => onProvider(event.target.value as ProviderId)}
            >
              {PROVIDER_IDS.map(one => <option key={one} value={one}>{one}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={!preparable || offer !== null}
            loading={preparing}
            onClick={onPrepare}
            title={refusal ?? undefined}
          >
            Prepare handover
          </Button>
          <Button size="sm" variant="primary" disabled={!publishable} loading={publishing} onClick={onPublish}>
            Publish offer
          </Button>
        </div>
      </div>

      {refusal !== null && (
        <p data-testid="handover-reason" className="mt-2 break-words text-xs leading-5 text-fg-dim">
          {refusal}
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

/**
 * M-12: the requester's **second** half, and it had no caller anywhere in `web/`.
 *
 * `handoverReview`, `applyHandover` and `requestHandoverChanges` each appeared
 * exactly twice in the whole web tier - their own definitions, and a URL-shape
 * table in `handoverControl.test.tsx` that asserts the route is right and never
 * that anything calls it. That is what made this read as covered. Present, typed,
 * and wired to nothing: the same shape as C1, C5 and M-13.
 *
 * jd ruled on 2026-09-27 to build it, against the recommendation to declare
 * review-and-apply a deliberate phone action.
 *
 * Rendered from props alone, so every branch can be rendered in a test (F03, F06).
 */
export function HandoverReturnView({
  review,
  notice,
  applied,
  changesEpoch,
  checking,
  applying,
  requesting,
  acceptanceMet,
  onAcceptanceMet,
  requirements,
  onRequirements,
  error,
  onCheck,
  onApply,
  onRequestChanges,
}: {
  review: HandoverReview | null;
  notice: string | null;
  applied: boolean;
  changesEpoch: number | null;
  checking: boolean;
  applying: boolean;
  requesting: boolean;
  acceptanceMet: boolean;
  onAcceptanceMet(value: boolean): void;
  requirements: string;
  onRequirements(value: string): void;
  error: string | null;
  onCheck(): void;
  onApply(): void;
  onRequestChanges(): void;
}) {
  /*
   * Acceptance is stated, never derived. The server refuses to infer it from the
   * result's own label - a DONE statement with no evidence is not acceptance - so
   * this checkbox is the requester's decision and it starts unticked. Applying a
   * partial result can never label the task complete however this reads, which is
   * why the label is shown next to it.
   */
  const applyable = review !== null && review.applyOffered && acceptanceMet && !applied;
  const requestable = review !== null && requirements.trim() !== "" && !applied;
  return (
    <div className="mt-3 rounded-panel border border-line bg-surface-2 p-4" aria-label="Review returned work">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Review returned work</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            When whoever accepted hands the work back, review what they did and either apply it to this
            checkout or send it back with what still needs changing.
          </p>
        </div>
        <Button size="sm" variant="ghost" loading={checking} disabled={applied} onClick={onCheck}>
          Check for returned work
        </Button>
      </div>

      {/* The server's own words when there is nothing to review - it names the
          state the item is actually in - rather than a control that looks broken. */}
      {notice !== null && review === null && (
        <p data-testid="handover-review-notice" className="mt-2 break-words text-xs leading-5 text-fg-dim">
          {notice}
        </p>
      )}

      {review !== null && !applied && (
        <div data-testid="handover-review" className="mt-3 border-t border-line pt-3 text-xs leading-5 text-fg">
          <p className="text-fg-muted">
            Returned as <strong>{review.result.label}</strong> at{" "}
            <code className="break-all">{review.result.resultCommit}</code>.
          </p>
          <p className="mt-2">{review.reason}</p>

          {review.refusedBecause.length > 0 && (
            <ul data-testid="handover-review-refusals" className="mt-2 space-y-1 text-danger">
              {review.refusedBecause.map(one => <li key={one}>Apply is not offered: {one.replaceAll("_", " ")}</li>)}
            </ul>
          )}

          {review.evidenceMissing && (
            <p data-testid="handover-review-evidence" className="mt-2 text-warning">
              This result is labelled full and carries no verification evidence. Read it before accepting it.
            </p>
          )}

          <label data-testid="handover-acceptance" className="mt-3 flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={acceptanceMet} onChange={event => onAcceptanceMet(event.target.checked)} />
            <span>
              This result meets what I asked for.
              {review.result.label === "partial" && " A partial result can never complete the task, whatever this says."}
            </span>
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={!applyable} loading={applying} onClick={onApply}>
              Apply result
            </Button>
          </div>

          <label className="mt-3 block">
            <span className="text-fg-dim">What still needs changing</span>
            <textarea
              aria-label="What still needs changing"
              className="mt-1 w-full resize-y rounded border border-line bg-surface-0 px-2 py-1 text-xs text-fg"
              rows={3}
              value={requirements}
              onChange={event => onRequirements(event.target.value)}
              placeholder="Name what is missing; a fresh offer is published carrying it."
            />
          </label>
          <Button size="sm" variant="secondary" disabled={!requestable} loading={requesting} onClick={onRequestChanges}>
            Request changes
          </Button>
        </div>
      )}

      {applied && (
        <p data-testid="handover-applied" className="mt-2 text-xs leading-5 text-success">
          Applied to this checkout. The handover is closed and the work item carries the result as its evidence.
        </p>
      )}

      {changesEpoch !== null && (
        <p data-testid="handover-changes" className="mt-2 text-xs leading-5 text-info">
          Sent back for changes. A fresh offer is published at epoch {changesEpoch}.
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
  /* M-12, the returned half. Separate state, because the two halves are used at
     different times - often in different sessions - and neither should clear the
     other's result. */
  const [review, setReview] = useState<HandoverReview | null>(null);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [changesEpoch, setChangesEpoch] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [acceptanceMet, setAcceptanceMet] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);

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

  /*
   * The item id, from the one route that is idempotent for a task that already
   * has a thread. The returned half is reached in a later session than the
   * publish half, so it cannot rely on `preview.itemId` being in this component's
   * state - which is exactly why this half needs its own lookup rather than
   * hanging off the one above.
   */
  async function itemIdFor(): Promise<string> {
    return (await workspaceApi.openTeamItem(SERVER_URL, item.prompt.id)).itemId;
  }

  async function check(): Promise<void> {
    setChecking(true); setReviewError(null); setReviewNotice(null); setReview(null);
    setAcceptanceMet(false); setChangesEpoch(null);
    try {
      setReview(await workspaceApi.handoverReview(SERVER_URL, await itemIdFor()));
    } catch (caught) {
      /*
       * The ordinary case is "nothing has been returned yet", which the server
       * answers 409 with the state the item is actually in. That is information,
       * not a failure, so it is shown as a notice rather than as an error - the
       * F03 rule that a control says why it cannot act.
       */
      setReviewNotice(caught instanceof Error ? caught.message : "Could not read a returned result for this work item.");
    } finally {
      setChecking(false);
    }
  }

  async function apply(): Promise<void> {
    if (review === null) return;
    setApplying(true); setReviewError(null);
    try {
      await workspaceApi.applyHandover(SERVER_URL, await itemIdFor(), acceptanceMet);
      setApplied(true); setReview(null);
      // The item's shared record moved, so every Team reader re-reads it.
      window.dispatchEvent(new Event("team-roster-changed"));
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "Could not apply this returned result.");
    } finally {
      setApplying(false);
    }
  }

  async function requestChanges(): Promise<void> {
    if (review === null || requirements.trim() === "") return;
    setRequesting(true); setReviewError(null);
    try {
      const changes = await workspaceApi.requestHandoverChanges(SERVER_URL, await itemIdFor(), requirements.trim());
      setChangesEpoch(changes.epoch); setReview(null); setRequirements("");
      window.dispatchEvent(new Event("team-roster-changed"));
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "Could not send this result back for changes.");
    } finally {
      setRequesting(false);
    }
  }

  return (
    <>
    <HandoverControlView
      availability={availability}
      held={item.heldByTeammate}
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
    {/*
      * Offered where this half could act - and kept while it has something to
      * report, which is not the same condition.
      *
      * Gating on `availability.enabled` alone had a defect the T1 row below
      * caught on its first run: a successful apply finishes the work item, which
      * makes `handoverAvailability` refuse, which unmounted this whole section -
      * including the line confirming the apply. The requester tapped Apply and
      * the panel vanished. So an outcome already produced keeps it mounted.
      */}
    {(availability.enabled || applied || changesEpoch !== null || review !== null) && (
      <HandoverReturnView
        review={review}
        notice={reviewNotice}
        applied={applied}
        changesEpoch={changesEpoch}
        checking={checking}
        applying={applying}
        requesting={requesting}
        acceptanceMet={acceptanceMet}
        onAcceptanceMet={setAcceptanceMet}
        requirements={requirements}
        onRequirements={setRequirements}
        error={reviewError}
        onCheck={() => void check()}
        onApply={() => void apply()}
        onRequestChanges={() => void requestChanges()}
      />
    )}
    </>
  );
}

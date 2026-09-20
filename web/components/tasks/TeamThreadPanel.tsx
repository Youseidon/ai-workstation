"use client";

import { useCallback, useEffect, useState } from "react";
import type { OperationsPrompt } from "@agent-console/shared";
import { LABEL } from "@/components/pipeline/status";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type TeamStatus = Awaited<ReturnType<typeof workspaceApi.teamStatus>>;

export type TeamThreadAvailability = { enabled: true } | { enabled: false; reason: string };

/**
 * B2: the owner's only route to a Team thread on their own item was curl. The
 * control is enabled only once a roster exists and the task is actually waiting
 * on a person, and says why when it is not, because a thread on a task nobody is
 * waiting on posts nothing useful and a finished task is refused outright (B7).
 */
export function teamThreadAvailability(team: TeamStatus, item: OperationsPrompt): TeamThreadAvailability {
  if (team === null) {
    return { enabled: false, reason: "Create or join a Team in Agents settings first. A thread needs a roster to post into." };
  }
  if (item.operationalState !== "AWAITING_RESPONSE") {
    return { enabled: false, reason: `A Team thread opens on a task that is awaiting a response. This one is ${LABEL[item.operationalState].toLowerCase()}.` };
  }
  return { enabled: true };
}

/** The rendered control, separated from the read so both states can be rendered in a test. */
export function TeamThreadControl({
  availability,
  opening,
  openedItemId,
  error,
  onOpen,
}: {
  availability: TeamThreadAvailability;
  opening: boolean;
  openedItemId: string | null;
  error: string | null;
  onOpen(): void;
}) {
  return (
    <div className="rounded-panel border border-line bg-surface-2 p-4" aria-label="Team thread">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Team thread</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Post this work item to the Team group, so your teammate can read it and you can grant them
            commands on it.
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={!availability.enabled || openedItemId !== null}
          loading={opening}
          onClick={onOpen}
        >
          Open Team thread
        </Button>
      </div>
      {!availability.enabled && (
        <p data-testid="team-thread-reason" className="mt-2 text-xs leading-5 text-fg-dim">
          {availability.reason}
        </p>
      )}
      {openedItemId !== null && (
        <p data-testid="team-thread-opened" className="mt-2 break-words text-xs leading-5 text-success">
          Thread opened. Its anchor is pinned in the Team group as {openedItemId}.
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

/** Keyed on the work item by its caller, so selecting another item resets what this one reported. */
export function TeamThreadPanel({ item }: { item: OperationsPrompt }) {
  // "unread" until the roster read settles: an install without Team enabled is
  // refused by the API and shows no Team control at all.
  const [team, setTeam] = useState<TeamStatus | "unread">("unread");
  const [opening, setOpening] = useState(false);
  const [openedItemId, setOpenedItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try { setTeam(await workspaceApi.teamStatus(SERVER_URL)); }
    catch { setTeam("unread"); /* Team off, or unreadable: this control cannot act, so it stays hidden. */ }
  }, []);

  useEffect(() => {
    const initialRead = window.setTimeout(() => void read(), 0);
    window.addEventListener("team-roster-changed", read);
    return () => {
      window.clearTimeout(initialRead);
      window.removeEventListener("team-roster-changed", read);
    };
  }, [read]);

  if (team === "unread") return null;

  async function open(): Promise<void> {
    setOpening(true); setError(null);
    try { setOpenedItemId((await workspaceApi.openTeamItem(SERVER_URL, item.prompt.id)).itemId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open a Team thread for this work item."); }
    finally { setOpening(false); }
  }

  return (
    <TeamThreadControl
      availability={teamThreadAvailability(team, item)}
      opening={opening}
      openedItemId={openedItemId}
      error={error}
      onOpen={() => void open()}
    />
  );
}

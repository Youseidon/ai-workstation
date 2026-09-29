"use client";

import { useCallback, useEffect, useState } from "react";
import { awaitsResponse, type OperationsPrompt, type TeamItemAccessSummary } from "@agent-console/shared";
import { LABEL } from "@/components/pipeline/status";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";
import { HandoverControl } from "@/components/tasks/HandoverControl";

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
  // C3: ask the predicate. A stored BLOCKED with no handoff record is the
  // ordinary Team path, and comparing to AWAITING_RESPONSE by hand disabled this
  // control on exactly the task a person is waiting on - telling the reader that
  // a task the board labels "Needs you" was not awaiting a response.
  if (!awaitsResponse(item.operationalState)) {
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

const ACCESS_CAPABILITIES = ["context", "answer", "resume"] as const;

function TeamItemAccess({ itemId, onClosed }: { itemId: string; onClosed(): void }) {
  const [access, setAccess] = useState<TeamItemAccessSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogs = useDialogs();
  const toast = useToast();

  const read = useCallback(async () => {
    try {
      setAccess(await workspaceApi.teamItemAccess(SERVER_URL, itemId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Team access could not be loaded.");
    }
  }, [itemId]);

  useEffect(() => { void read(); }, [read]);

  async function toggle(personId: string, capability: typeof ACCESS_CAPABILITIES[number], checked: boolean) {
    if (access === null) return;
    const member = access.members.find(one => one.personId === personId);
    if (member === undefined) return;
    const capabilities = checked
      ? Array.from(new Set([...member.capabilities, capability]))
      : member.capabilities.filter(one => one !== capability);
    setBusy(`${personId}:${capability}`);
    try {
      setAccess(await workspaceApi.setTeamItemAccess(SERVER_URL, itemId, personId, capabilities));
      toast.success("Team access updated");
    } catch (caught) {
      toast.error("Access update failed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function close(): Promise<void> {
    const confirmed = await dialogs.confirm({
      title: "Close this Team thread?",
      description: "Active grants end immediately. A live handover must be withdrawn or returned first.",
      confirmLabel: "Close thread",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy("close");
    try {
      const result = await workspaceApi.closeTeamItem(SERVER_URL, itemId);
      if (!result.closed) throw new Error(result.reason);
      toast.success("Team thread closed", result.reason);
      onClosed();
    } catch (caught) {
      toast.error("Thread could not be closed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-line bg-surface-2 p-4" aria-label="Team item access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Team access</h3>
        {access?.editable === true && access.closedAt === null && (
          <Button size="sm" variant="danger" loading={busy === "close"} onClick={() => void close()}>Close thread</Button>
        )}
      </div>
      {error !== null && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      {access?.closedAt !== null && access !== null && <p className="mt-2 text-xs text-fg-dim">Closed {new Date(access.closedAt).toLocaleString()}</p>}
      {access !== null && (
        <div className="mt-3 divide-y divide-line">
          {access.members.map(member => (
            <div key={member.personId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
              <span className="min-w-32 flex-1 text-xs font-medium text-fg-muted">{member.label}{member.owner ? " (owner)" : ""}</span>
              {ACCESS_CAPABILITIES.map(capability => (
                <label key={capability} className="flex items-center gap-1.5 text-xs capitalize text-fg-muted">
                  <input
                    type="checkbox"
                    checked={member.capabilities.includes(capability)}
                    disabled={!access.editable || member.owner || access.closedAt !== null || busy !== null}
                    onChange={event => void toggle(member.personId, capability, event.target.checked)}
                    className="size-3.5 accent-accent"
                  />
                  {capability}
                </label>
              ))}
            </div>
          ))}
        </div>
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
    try {
      const nextTeam = await workspaceApi.teamStatus(SERVER_URL);
      setTeam(nextTeam);
      if (nextTeam !== null) setOpenedItemId((await workspaceApi.teamItemForPrompt(SERVER_URL, item.prompt.id))?.itemId ?? null);
    }
    catch { setTeam("unread"); /* Team off, or unreadable: this control cannot act, so it stays hidden. */ }
  }, [item.prompt.id]);

  useEffect(() => {
    const initialRead = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => void read(), 5_000);
    window.addEventListener("team-roster-changed", read);
    return () => {
      window.clearTimeout(initialRead);
      window.clearInterval(timer);
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
    <>
      <TeamThreadControl
        availability={teamThreadAvailability(team, item)}
        opening={opening}
        openedItemId={openedItemId}
        error={error}
        onOpen={() => void open()}
      />
      {openedItemId !== null && <TeamItemAccess itemId={openedItemId} onClosed={() => setOpenedItemId(null)} />}
      {/* C1: the handover engine's only route to a person. It opens the item
          thread itself when there is not one yet, because an offer is posted in
          that thread, so it does not depend on the control above being used first. */}
      <HandoverControl team={team} item={item} />
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type TeamStatus = Awaited<ReturnType<typeof workspaceApi.teamStatus>>;

/**
 * B1: creation showed the join code once, in this panel's sibling's React state,
 * so a page reload stranded a created team with no way to invite anyone. The
 * control is rendered from props so both its states can be rendered in a test.
 */
export function TeamJoinCodeControl({ joinCode, issuing, error, onIssue }: {
  joinCode: string | null;
  issuing: boolean;
  error: string | null;
  onIssue(): void;
}) {
  return <div className="mt-3 border-t border-line pt-3" aria-label="Team join code">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 flex-1 basis-48 text-fg-muted">A join code is single use and carries no credential. A new one leaves any earlier code working until it is used or expires.</p>
      <Button size="sm" variant="ghost" onClick={onIssue} loading={issuing}>Issue new join code</Button>
    </div>
    {joinCode !== null && <>
      <code data-testid="team-join-code" className="mt-2 block break-all rounded bg-surface-0 p-2 text-[11px]">{joinCode}</code>
      <p className="mt-1 text-fg-dim">Send it to your teammate in a private channel. It expires 24 hours after it is issued.</p>
    </>}
    {error !== null && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
  </div>;
}

export function TeamStatusPanel() {
  const [team, setTeam] = useState<TeamStatus>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [joinCodeError, setJoinCodeError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try { setTeam(await workspaceApi.teamStatus(SERVER_URL)); }
    catch { /* Setup actions surface their own actionable errors. */ }
  }, []);

  useEffect(() => {
    const initialRead = window.setTimeout(() => void read(), 0);
    window.addEventListener("team-roster-changed", read);
    return () => {
      window.clearTimeout(initialRead);
      window.removeEventListener("team-roster-changed", read);
    };
  }, [read]);

  async function refresh(): Promise<void> {
    setRefreshing(true); setError(null);
    try { setTeam(await workspaceApi.refreshTeam(SERVER_URL)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not refresh the team."); }
    finally { setRefreshing(false); }
  }

  async function issueJoinCode(): Promise<void> {
    setIssuing(true); setJoinCodeError(null);
    try {
      setJoinCode((await workspaceApi.reissueTeamJoinCode(SERVER_URL)).joinCode);
      // The roster was republished, so its revision moved for every reader of it.
      window.dispatchEvent(new Event("team-roster-changed"));
    }
    catch (caught) { setJoinCode(null); setJoinCodeError(caught instanceof Error ? caught.message : "Could not issue a join code."); }
    finally { setIssuing(false); }
  }

  if (team === null) return null;
  return <div className="mt-3 border-t border-line pt-3 text-xs text-fg" aria-label="Team status">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Team status</h3><code>{team.teamId}</code></div>
      <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing}>Refresh team</Button>
    </div>
    <ul className="mt-2 space-y-1">{team.members.map(member => <li key={member.personId}>{member.workstationLabel} · @{member.botUsername}</li>)}</ul>
    {team.instruction !== null && <p className="mt-2 text-fg-muted">{team.instruction}</p>}
    {team.inviteLink !== null && <p className="mt-2">One-member invite: <a className="text-accent underline" href={team.inviteLink}>{team.inviteLink}</a></p>}
    {error !== null && <p role="alert" className="mt-2 text-danger">{error}</p>}
    <TeamJoinCodeControl joinCode={joinCode} issuing={issuing} error={joinCodeError} onIssue={() => void issueJoinCode()} />
  </div>;
}

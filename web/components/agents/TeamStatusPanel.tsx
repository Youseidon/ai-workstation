"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type TeamStatus = Awaited<ReturnType<typeof workspaceApi.teamStatus>>;

export function TeamStatusPanel() {
  const [team, setTeam] = useState<TeamStatus>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  </div>;
}

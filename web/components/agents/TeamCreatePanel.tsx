"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

export function TeamCreatePanel() {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [team, setTeam] = useState<{ code: string; expiresAt: string; observed: boolean } | null>(null);
  const [result, setResult] = useState<{ teamId: string; joinCode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    setBusy(true); setError(null);
    try { setTeam(await workspaceApi.startTeamCreate(SERVER_URL, remoteUrl)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start team creation."); }
    finally { setBusy(false); }
  }

  async function confirm(): Promise<void> {
    setBusy(true); setError(null);
    try { setResult(await workspaceApi.confirmTeamCreate(SERVER_URL)); setTeam(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the team."); }
    finally { setBusy(false); }
  }

  return <div className="mt-4 border-t border-line pt-3">
    <h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Team</h3>
    {result !== null ? <div className="mt-2 space-y-1 text-xs text-fg"><p>Team created: <code>{result.teamId}</code></p><code className="block break-all rounded bg-surface-0 p-2 text-[11px]">{result.joinCode}</code></div> : team === null ? <div className="mt-2 flex flex-wrap gap-2"><input className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-xs text-fg" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="Private Git repository URL" aria-label="Private Git repository URL" /><Button size="sm" variant="success" onClick={() => void start()} loading={busy}>Create team</Button></div> : <div className="mt-2 space-y-2 text-xs text-fg"><code className="block break-all rounded bg-surface-0 p-2">/team {team.code}</code><p>{team.observed ? "Group verified. Confirm locally." : "Send this command in the private team group."}</p><Button size="sm" variant="success" disabled={!team.observed} onClick={() => void confirm()} loading={busy}>Confirm team</Button></div>}
    {error !== null && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}

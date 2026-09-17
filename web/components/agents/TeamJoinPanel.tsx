"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

export function TeamJoinPanel() {
  const [code, setCode] = useState("");
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function inspect(): Promise<void> { setBusy(true); setMessage(null); try { await workspaceApi.startTeamJoin(SERVER_URL, code); setReady(true); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not read the join code."); } finally { setBusy(false); } }
  async function confirm(): Promise<void> { setBusy(true); setMessage(null); try { const joined = await workspaceApi.confirmTeamJoin(SERVER_URL); setMessage(joined.instruction); setReady(false); window.dispatchEvent(new Event("team-roster-changed")); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not join the team."); } finally { setBusy(false); } }
  return <div className="mt-3 border-t border-line pt-3" aria-label="Join team"><h3 className="text-[11px] uppercase tracking-wider text-fg-dim">Join team</h3><div className="mt-2 flex flex-wrap gap-2"><input className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-xs text-fg" value={code} onChange={event => setCode(event.target.value)} placeholder="awj1 join code" aria-label="Team join code" /><Button size="sm" variant="ghost" onClick={() => void inspect()} loading={busy}>Check code</Button><Button size="sm" variant="success" disabled={!ready} onClick={() => void confirm()} loading={busy}>Join team</Button></div>{message !== null && <p className="mt-2 text-xs text-fg-muted">{message}</p>}</div>;
}

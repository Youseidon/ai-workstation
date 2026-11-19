"use client";

import { useEffect, useRef } from "react";
import { DecisionDeck } from "@/components/DecisionDeck";
import { AskChip, RunRow, runOwnerHref } from "@/components/RunStatus";
import { useAgentConsole } from "@/lib/useAgentConsole";

/** Counts for the sidebar summary and the collapsed/mobile navigation trigger. */
export function useAttentionCounts() {
  const { runs, inputRequests } = useAgentConsole();
  return { running: runs.length, decisions: Object.keys(inputRequests).length };
}

export function attentionLabel(running: number, decisions: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} ${running === 1 ? "agent" : "agents"} working`);
  if (decisions > 0) parts.push(`${decisions} ${decisions === 1 ? "needs" : "need"} you`);
  return parts.join(" · ");
}

/** The sidebar's running-work summary. Renders nothing while idle. */
export function RunAttentionSummary({ onOpen }: { onOpen(): void }) {
  const { running, decisions } = useAttentionCounts();
  if (running === 0 && decisions === 0) return null;
  return <button type="button" className="app-attention-summary" data-urgent={decisions > 0} onClick={onOpen} aria-haspopup="dialog">
    <span className="app-attention-dot" aria-hidden />
    <span className="min-w-0 truncate">{attentionLabel(running, decisions)}</span>
  </button>;
}

/**
 * Every outstanding decision and running agent, from any section. Answering
 * here settles the same request record a conversation shows in context.
 */
export function RunAttentionDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { runs, items, providers, lastRun, connection, inputRequests, runTabIds, answerInput, interrupt } = useAgentConsole();
  const stale = connection !== "open";
  const requests = Object.values(inputRequests);
  const executes = runs.filter((run) => run.role === "execute");
  const consults = runs.filter((run) => run.role === "consult");

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  return <dialog ref={dialog} className="app-drawer" aria-labelledby="run-attention-title" onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {open && <div className="app-drawer-body">
      <div className="app-drawer-header">
        <h2 id="run-attention-title">Running work</h2>
        <button type="button" className="app-icon-button" aria-label="Close running work" onClick={onClose}>✕</button>
      </div>
      {stale && <p className="app-drawer-note" role="status">Reconnecting — agents keep running on the server.</p>}
      {requests.length > 0 && <section aria-labelledby="run-attention-decisions" className="app-drawer-section">
        <h3 id="run-attention-decisions">Needs you</h3>
        {requests.map((request) => {
          const run = runs.find((entry) => entry.runId === request.runId);
          if (run === undefined) return null;
          return <div key={request.requestId} className="grid gap-2">
            <p className="app-drawer-note">{run.provider} · {run.workspace.name}</p>
            <DecisionDeck request={request} provider={run.provider} onSubmit={(answers) => answerInput(request.runId, request.requestId, answers)} onCancel={() => interrupt(request.runId)} />
          </div>;
        })}
      </section>}
      {executes.length > 0 && <section aria-labelledby="run-attention-running" className="app-drawer-section">
        <h3 id="run-attention-running">Working</h3>
        <div className="divide-y divide-line">
          {executes.map((run) => <RunRow key={run.runId} run={run} items={items} providers={providers} lastRun={lastRun}
            onStop={() => interrupt(run.runId)} stale={stale} waiting={inputRequests[run.runId] !== undefined}
            ownerHref={runOwnerHref(run, runTabIds)} onOpen={onClose} />)}
        </div>
      </section>}
      {consults.length > 0 && <section aria-labelledby="run-attention-asking" className="app-drawer-section">
        <h3 id="run-attention-asking">Asking</h3>
        <div className="flex flex-wrap gap-1.5">
          {consults.map((run) => <AskChip key={run.runId} run={run} onStop={() => interrupt(run.runId)} stale={stale} waiting={inputRequests[run.runId] !== undefined} onOpen={onClose} />)}
        </div>
      </section>}
      {runs.length === 0 && requests.length === 0 && <p className="app-drawer-note">No agents are working.</p>}
    </div>}
  </dialog>;
}

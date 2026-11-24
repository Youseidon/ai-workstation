"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { DecisionDeck } from "@/components/DecisionDeck";
import { FleetRunCard } from "@/components/agents/FleetRunCard";
import { useFleetConsole, useFleetMetadata } from "@/lib/fleetContext";

export function LiveFleetRail() {
  const { runs, providers, connection, inputRequests, pendingLaunches, interrupt, answerInput, stale } = useFleetConsole();
  const { origins, queued } = useFleetMetadata();
  const [expanded, setExpanded] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const id = useId();
  const decision = useRef<HTMLDivElement>(null);
  const needsYou = runs.filter(run => inputRequests[run.runId]).length;
  const activeProviders = new Set(runs.map(run => run.provider));
  const standby = providers.filter(provider => provider.available && !activeProviders.has(provider.id)).length;
  const queueCount = queued.length + pendingLaunches.length;
  const visible = expanded ? runs : [...runs.filter(run => inputRequests[run.runId]), ...runs.filter(run => !inputRequests[run.runId])].slice(0, 3);
  const selected = runs.find(run => run.runId === answering);
  const request = selected ? inputRequests[selected.runId] : undefined;
  useEffect(() => {
    if (request) decision.current?.scrollIntoView({ block: "nearest" });
  }, [answering, request]);
  return <section className="live-fleet" aria-label="Live fleet across all workspaces" data-active={runs.length > 0} data-stale={stale}>
    <header className="live-fleet-header">
      <Link href="/agents" className="live-fleet-title"><span className="fleet-signal" data-active={runs.length > 0 && !stale} aria-hidden /><strong>Live fleet</strong><span>All workspaces</span></Link>
      <div className="live-fleet-summary" role="status">
        {stale ? <span className="text-warning">{connection === "connecting" ? "Connecting…" : "Reconnecting · last known state"}</span> : <>
          <span>{runs.length - needsYou} running</span>
          {needsYou > 0 && <span className="text-warning">{needsYou} needs you</span>}
          {queueCount > 0 && <span>{queueCount} queued</span>}
          <span>{standby} standby</span>
        </>}
      </div>
      <Link href="/agents" className="live-fleet-open">Command center ↗</Link>
    </header>
    {(runs.length > 0 || queueCount > 0) && <div className="live-fleet-content" id={id}>
      <div className="live-fleet-rows">{visible.map(run => <FleetRunCard key={run.runId} run={run} origin={origins[run.runId]} compact selected={answering === run.runId}
        onSelect={inputRequests[run.runId] ? () => setAnswering(current => current === run.runId ? null : run.runId) : undefined} />)}</div>
      {runs.length > 3 && <button type="button" className="fleet-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "Show fewer agents ↑" : `Show all ${runs.length} agents ↓`}</button>}
      {queueCount > 0 && <p className="fleet-queue-note">{queueCount} task{queueCount === 1 ? "" : "s"} queued · <Link href="/agents">View waiting work →</Link></p>}
      {selected && request && <div ref={decision} className="fleet-inline-decision" aria-label="Answer agent request">
        <div className="fleet-decision-heading"><span>{selected.workspace.name} · {providers.find(provider => provider.id === selected.provider)?.label ?? selected.provider}</span><button type="button" onClick={() => setAnswering(null)} aria-label="Close answer form">✕</button></div>
        {stale ? <p role="status">Reconnect to answer this request.</p> : <DecisionDeck key={request.requestId} request={request} provider={selected.provider} onSubmit={answers => answerInput(selected.runId, request.requestId, answers)} onCancel={() => interrupt(selected.runId)} />}
      </div>}
    </div>}
  </section>;
}

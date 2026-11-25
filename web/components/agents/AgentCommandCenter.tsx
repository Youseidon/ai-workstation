"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatTokens, modelLabel } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DecisionDeck } from "@/components/DecisionDeck";
import { runOwnerHref } from "@/components/RunStatus";
import { ContentTitle } from "@/components/shell/PageCanvas";
import { SidebarCollection, SidebarGroup, SidebarRow } from "@/components/shell/SidebarCollection";
import { Button } from "@/components/ui/Button";
import { runOrigin } from "@/lib/fleet";
import { useFleetConsole, useFleetMetadata } from "@/lib/fleetContext";
import { providerTheme } from "@/lib/providerTheme";
import { useWorkspace } from "@/lib/workspaceContext";
import { AgentsView } from "./AgentsView";
import { FleetRunCard } from "./FleetRunCard";

export function AgentCommandCenter() {
  const { providers, runs, inputRequests, pendingLaunches, runTabIds, interrupt, answerInput, refreshProviders, stale } = useFleetConsole();
  const { origins, queued, loading, error, refresh } = useFleetMetadata();
  const { workspaces } = useWorkspace();
  const search = useSearchParams();
  const router = useRouter();
  const configuration = search.get("view") === "configuration";
  const [view, setView] = useState<"graph" | "list">("graph");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const matchingRuns = runs.filter(run =>
    (workspaceFilter === "all" || String(run.workspace.id) === workspaceFilter)
    && (providerFilter === "all" || run.provider === providerFilter)
    && (statusFilter === "all" || (statusFilter === "needs-you" ? Boolean(inputRequests[run.runId]) : statusFilter === "running" && !inputRequests[run.runId])));
  const selected = matchingRuns.find(run => run.runId === (selectedId ?? search.get("run")))
    ?? matchingRuns.find(run => Boolean(inputRequests[run.runId])) ?? matchingRuns[0];
  const selectedOrigin = selected ? origins[selected.runId] ?? runOrigin(selected) : null;
  const selectedRequest = selected ? inputRequests[selected.runId] : undefined;
  const activeProviders = new Set(runs.map(run => run.provider));
  const ready = providers.filter(provider => provider.available && !activeProviders.has(provider.id));
  const unavailable = providers.filter(provider => !provider.available && !activeProviders.has(provider.id));
  const queuedTasks = [
    ...queued,
    ...pendingLaunches.map(launch => ({ id: launch.requestId, title: launch.prompt, context: "Awaiting server acceptance", href: `/?workspace=${launch.workspaceId ?? ""}&thread=${encodeURIComponent(launch.tabId)}`, provider: launch.provider ?? null, model: launch.model ?? null,
      workspaceId: launch.workspaceId ?? -1, workspaceName: workspaces.find(workspace => workspace.id === launch.workspaceId)?.name ?? "Workspace" })),
  ].filter(task => (workspaceFilter === "all" || String(task.workspaceId) === workspaceFilter) && (providerFilter === "all" || task.provider === providerFilter));
  const showQueue = statusFilter === "all" || statusFilter === "queued";
  const showStandby = statusFilter === "all" || statusFilter === "standby";
  const showUnavailable = statusFilter === "all" || statusFilter === "unavailable";
  const showActive = statusFilter === "all" || statusFilter === "running" || statusFilter === "needs-you";
  const changeTab = (next: "fleet" | "configuration") => {
    const params = new URLSearchParams(search.toString());
    if (next === "configuration") params.set("view", next); else params.delete("view");
    router.replace(`/agents${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  // Configuration links keep working after navigating from a standby provider.
  useEffect(() => {
    if (!configuration || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [configuration, providers]);
  const workspaceOptions = new Map(workspaces.map(workspace => [String(workspace.id), workspace.name]));
  for (const run of runs) workspaceOptions.set(String(run.workspace.id), run.workspace.name);

  return <div className="agent-command-center">
    <nav className="fleet-page-tabs" aria-label="Agents views">
      <div className="fleet-page-switch" data-active={configuration ? "configuration" : "fleet"}>
        <span className="fleet-page-switch-thumb" aria-hidden />
        <Link href="/agents" aria-current={!configuration ? "page" : undefined} onClick={event => { event.preventDefault(); changeTab("fleet"); }}>
          <span className="fleet-page-tab-icon" aria-hidden><span className="fleet-signal" data-active={runs.length > 0 && !stale} /></span>
          Live fleet
          <span className="fleet-page-tab-count" aria-hidden>{runs.length} live</span>
        </Link>
        <Link href="/agents?view=configuration" aria-current={configuration ? "page" : undefined} onClick={event => { event.preventDefault(); changeTab("configuration"); }}>
          <span className="fleet-page-tab-icon" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="16" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.8" /><circle cx="10" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.8" /></svg>
          </span>
          Configuration
          {providers.length > 0 && <span className="fleet-page-tab-count" aria-hidden data-warn={unavailable.length > 0}>{providers.length} providers</span>}
        </Link>
      </div>
      <span className="fleet-page-switch-hint" aria-hidden>{configuration ? "← Watch running agents in Live fleet" : "Set up providers, models & limits in Configuration →"}</span>
    </nav>
    {configuration ? <AgentsView /> : <>
      <SidebarCollection label="Agent fleet">
        <SidebarRow title="All agents" selected={providerFilter === "all"} onSelect={() => setProviderFilter("all")} />
        <SidebarGroup title="Providers">{providers.map(provider => <SidebarRow key={provider.id} title={provider.label}
          selected={providerFilter === provider.id} onSelect={() => setProviderFilter(provider.id)}
          status={activeProviders.has(provider.id) ? `${runs.filter(run => run.provider === provider.id).length} active` : provider.available ? "Standby" : "Unavailable"}
          statusTone={activeProviders.has(provider.id) ? "accent" : "muted"} />)}</SidebarGroup>
        <SidebarRow title="Provider configuration ↗" href="/agents?view=configuration" />
      </SidebarCollection>
      <ContentTitle title="Agent constellation" meta="Live command center · all workspaces" actions={<Button size="sm" onClick={() => { refresh(); void refreshProviders(); }}>Refresh fleet</Button>} />
      <div className="fleet-canvas">
        <div className="fleet-overview" role="status">
          <span><strong>{runs.filter(run => !inputRequests[run.runId]).length}</strong> running</span>
          <span className={Object.keys(inputRequests).length ? "text-warning" : ""}><strong>{runs.filter(run => inputRequests[run.runId]).length}</strong> needs you</span>
          <span><strong>{queued.length + pendingLaunches.length}</strong> queued</span>
          <span><strong>{ready.length}</strong> standby</span>
          <span className="fleet-overview-scope">Fleet totals · all workspaces</span>
        </div>
        {stale && <p className="fleet-notice" role="status">Reconnecting — showing the last known state. Agents continue on the server; controls return when connected.</p>}
        {error && <p className="fleet-notice" role="alert">Pipeline metadata could not be refreshed. {error} <button type="button" onClick={refresh}>Retry</button></p>}
        <div className="fleet-toolbar">
          <label>Workspace<select value={workspaceFilter} onChange={event => setWorkspaceFilter(event.target.value)}><option value="all">All workspaces</option>{[...workspaceOptions].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
          <label>Status<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All states</option><option value="running">Running</option><option value="needs-you">Needs you</option><option value="queued">Queued</option><option value="standby">Standby</option><option value="unavailable">Unavailable / Disabled</option></select></label>
          <div className="fleet-view-switch" aria-label="Fleet layout"><button type="button" aria-pressed={view === "graph"} onClick={() => setView("graph")}>◇ Graph</button><button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>☷ List</button></div>
        </div>
        {providerFilter !== "all" && <p className="fleet-filter-note">Showing {providers.find(provider => provider.id === providerFilter)?.label ?? providerFilter} <button type="button" onClick={() => setProviderFilter("all")}>Clear provider filter ×</button></p>}
        {showActive && <section className={`fleet-constellation ${view === "list" ? "fleet-list" : ""}`} aria-label={view === "graph" ? "Tasks connected to live agent runs" : "Live agent runs"}>
          <div className="fleet-section-heading"><h2>{statusFilter === "needs-you" ? "Needs your input" : "Active missions"}</h2><span>{matchingRuns.length} {matchingRuns.length === 1 ? "run" : "runs"} in view</span></div>
          {matchingRuns.length === 0 ? <div className="fleet-empty"><span className="fleet-empty-orbit" aria-hidden>◎</span><h3>{runs.length === 0 ? "The fleet is standing by" : "No runs match these filters"}</h3><p>{runs.length === 0 ? "Start a pipeline, send a custom prompt, or ask for a consult. Every live run appears here." : "Choose another workspace, status, or provider to see more agents."}</p>{runs.length === 0 && <div className="fleet-empty-actions"><Link href="/">Start a conversation ↗</Link><Link href="/pipeline">Open pipelines ↗</Link></div>}</div>
            : matchingRuns.map(run => {
              const origin = origins[run.runId] ?? runOrigin(run);
              return <div className="fleet-mission" key={run.runId} data-running={!inputRequests[run.runId] && !stale} style={{ "--fleet-agent": providerTheme[run.provider].cssVar } as CSSProperties}>
                <div className="fleet-mission-source"><span className="fleet-eyebrow">{origin.kind} · {run.workspace.name}</span><h3>{origin.title || "Untitled task"}</h3><p>{origin.context}</p>{origin.href && <Link href={origin.href}>Open pipeline ↗</Link>}</div>
                <div className="fleet-mission-edge" aria-hidden><span /></div>
                <FleetRunCard run={run} origin={origin} selected={selected?.runId === run.runId} onSelect={() => setSelectedId(run.runId)} />
              </div>;
            })}
        </section>}
        {selected && selectedOrigin && <section className="fleet-inspector" aria-label="Selected agent run">
          <div className="fleet-section-heading"><div><span className="fleet-eyebrow">Selected run · {selected.workspace.name}</span><h2>{providers.find(provider => provider.id === selected.provider)?.label ?? selected.provider} / {selectedOrigin.title}</h2></div><div className="fleet-inspector-actions">
            {selectedOrigin.href && <Link href={selectedOrigin.href} className="fleet-action-link">Open pipeline ↗</Link>}
            <Link className="fleet-action-link" href={runOwnerHref(selected, runTabIds)}>Open session ↗</Link>
            <Button size="sm" variant="danger" disabled={stale} onClick={() => interrupt(selected.runId)}>Stop selected run</Button>
          </div></div>
          <div className="fleet-inspector-meta"><span>Model: {modelLabel(selected.provider, selected.model) ?? "Not reported"}</span><span>Role: {{ consult: "Read-only consult", execute: "Execute", author: "Authoring", handoff: "Handoff" }[selected.role]}</span><span>Started: {new Date(selected.startedAt).toLocaleTimeString()}</span>{selected.usage && <span>{formatTokens(selected.usage.totalTokens)} tokens</span>}</div>
          {selectedRequest && (stale ? <p className="fleet-notice">Reconnect to answer this request.</p> : <DecisionDeck key={selectedRequest.requestId} request={selectedRequest} provider={selected.provider} onSubmit={answers => answerInput(selected.runId, selectedRequest.requestId, answers)} onCancel={() => interrupt(selected.runId)} />)}
        </section>}
        {showQueue && <section className="fleet-bay" aria-label="Queued work"><div className="fleet-section-heading"><h2>Launch queue</h2><span>{loading ? "Loading pipeline queue…" : `${queuedTasks.length} waiting`}</span></div>
          {queuedTasks.length ? <div className="fleet-queue-grid">{queuedTasks.map(task => <Link className="fleet-queued-task" key={task.id} href={task.href}><span className="fleet-eyebrow">Queued · {task.workspaceName}</span><strong>{task.title}</strong><span>{task.context}</span><small>{task.provider ? providers.find(provider => provider.id === task.provider)?.label ?? task.provider : "Agent assigned at launch"} · {task.provider && task.model ? modelLabel(task.provider, task.model) : "Model resolved at launch"}</small></Link>)}</div> : <p className="fleet-bay-note">{error ? "Queue information is unavailable until metadata refreshes." : "No tasks are currently waiting to launch."}</p>}
        </section>}
        {showStandby && <section className="fleet-bay" aria-label="Standby agents"><div className="fleet-section-heading"><h2>Standby bay</h2><span>Available across all workspaces</span></div><div className="fleet-provider-grid">
          {ready.filter(provider => providerFilter === "all" || provider.id === providerFilter).map(provider => <Link className="fleet-provider" key={provider.id} href={`/agents?view=configuration#agent-${provider.id}`}><AgentAvatar provider={provider.id} activity={stale ? "offline" : "idle"} size={44} /><div><strong>{provider.label}</strong><span>{stale ? "Last known: available" : "Standby · ready for a task"}</span><small>Configured: {modelLabel(provider.id, provider.model) ?? "Provider default"}</small></div></Link>)}
        </div>{ready.filter(provider => providerFilter === "all" || provider.id === providerFilter).length === 0 && <p className="fleet-bay-note">{providers.length === 0 ? "Detecting providers…" : "No matching providers are on standby."}</p>}</section>}
        {showUnavailable && unavailable.length > 0 && <section className="fleet-bay" aria-label="Unavailable agents"><div className="fleet-section-heading"><h2>Unavailable / Disabled</h2><span>Open configuration to manage</span></div><div className="fleet-provider-grid">{unavailable.filter(provider => providerFilter === "all" || provider.id === providerFilter).map(provider => <Link className="fleet-provider" key={provider.id} href={`/agents?view=configuration#agent-${provider.id}`}><AgentAvatar provider={provider.id} activity="offline" size={40} /><div><strong>{provider.label}</strong><span>{provider.reason?.startsWith("Turned off") ? "Disabled" : "Unavailable"}</span><small>{provider.reason ?? "Provider is not available"}</small></div></Link>)}</div></section>}
      </div>
    </>}
  </div>;
}

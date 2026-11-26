"use client";

import Link from "next/link";
import { useMemo, type CSSProperties } from "react";
import { modelLabel } from "@hydra/shared";
import { AgentAvatar } from "@/features/providers/components/AgentAvatar";
import { runOwnerHref } from "@/features/runs/components/RunStatus";
import { agentState, ACTIVITY_LABEL } from "@/features/runs/lib/agentState";
import { fleetClock, runOrigin, waitingElapsed, type PipelinePlace, type RunOrigin } from "@/features/agents/lib/fleet";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import { useFleetConsole } from "@/contexts/fleetContext";
import { useStopCenter } from "@/features/stop/components/StopCenter";
import type { RunStatus } from "@/models/runs";

export function FleetRunCard({ run, origin: suppliedOrigin, selected, onSelect, compact = false }: {
  run: RunStatus; origin?: RunOrigin; selected?: boolean; onSelect?(): void; compact?: boolean;
}) {
  const { providers, items, lastRun, inputRequests, runTabIds, stale } = useFleetConsole();
  const stopCenter = useStopCenter();
  const provider = providers.find(provider => provider.id === run.provider);
  const request = inputRequests[run.runId];
  const state = useMemo(() => provider ? agentState(provider, [run], items, lastRun) : null, [provider, run, items, lastRun]);
  const origin = suppliedOrigin ?? runOrigin(run);
  const activity = stale ? "Reconnecting · last known activity" : request ? "Needs your input" : state ? ACTIVITY_LABEL[state.activity] : run.state === "starting" ? "Starting" : "Running";
  const waiting = request ? waitingElapsed(run, request) : null;
  const style = { "--fleet-agent": providerTheme[run.provider].cssVar } as CSSProperties;
  if (compact) return <article className="fleet-run fleet-run-inline" data-selected={selected} data-waiting={Boolean(request)} data-stale={stale} data-run-id={run.runId} style={style}>
    <div className="fleet-inline-identity">
      <AgentAvatar provider={run.provider} activity={stale ? "offline" : request ? "idle" : state?.activity ?? "starting"} size={20} />
      <strong>{provider?.label ?? run.provider}</strong>
      <span className="fleet-inline-model" title={run.model ?? "The provider did not report a model"}>{modelLabel(run.provider, run.model) ?? "Model not reported"}</span>
    </div>
    <span className="fleet-inline-clock" title="Total elapsed time, measured by the server">{fleetClock(run.elapsedMs)}</span>
    <span className="fleet-inline-status" data-waiting={Boolean(request)} data-stale={stale}><span aria-hidden>{request ? "◆" : "●"}</span> {activity}{waiting !== null && <span className="fleet-wait-clock"> · waiting {fleetClock(waiting)}</span>}</span>
    {origin.pipeline
      ? <PipelineCrumbs place={origin.pipeline} workspace={run.workspace.name} className="fleet-inline-task" />
      : <span className="fleet-inline-task" title={`${run.workspace.name} / ${origin.kind} / ${origin.context} / ${origin.title}`}>{run.workspace.name} / {origin.kind} / {origin.title || "Untitled task"}</span>}
    <div className="fleet-inline-actions">
      {origin.href && <Link href={origin.href} aria-label="Open pipeline">Pipeline ↗</Link>}
      <Link href={runOwnerHref(run, runTabIds)} aria-label="Open session">Open ↗</Link>
      {request && onSelect && <button type="button" onClick={onSelect} aria-expanded={selected}>{selected ? "Hide question" : "Answer request"}</button>}
      <button type="button" className="fleet-stop" disabled={stale} onClick={() => stopCenter.open({ runId: run.runId })} aria-label={`Stop ${provider?.label ?? run.provider}: ${origin.title}`}>Stop</button>
    </div>
  </article>;
  const contents = <>
    <div className="fleet-run-identity">
      <AgentAvatar provider={run.provider} activity={stale ? "offline" : request ? "idle" : state?.activity ?? "starting"} size={40} />
      <div className="fleet-run-name"><strong>{provider?.label ?? run.provider}</strong><span className="fleet-run-model" title={run.model ?? "The provider did not report a model"}>{modelLabel(run.provider, run.model) ?? "Model not reported"}</span></div>
      <span className="fleet-clock" title="Total elapsed time, measured by the server"><span>{fleetClock(run.elapsedMs)}</span><small>elapsed</small></span>
    </div>
    <div className="fleet-run-status" data-waiting={Boolean(request)} data-stale={stale}><span aria-hidden>{request ? "◆" : "●"}</span> {activity}{waiting !== null && <span className="fleet-wait-clock"> · waiting {fleetClock(waiting)}</span>}</div>
    <div className="fleet-run-task" title={origin.title}>{origin.title || "Untitled task"}</div>
    {origin.pipeline
      ? <PipelineCrumbs place={origin.pipeline} workspace={run.workspace.name} className="fleet-run-origin" />
      : <div className="fleet-run-origin" title={`${run.workspace.name} / ${origin.kind} / ${origin.context}`}>{run.workspace.name} <span aria-hidden> / </span> {origin.kind} <span aria-hidden> / </span> {origin.context}</div>}
    <p className="fleet-run-caption" title={state?.caption}>{stale ? "Activity will refresh when the connection returns." : request ? request.heading : state?.caption ?? run.detail ?? "Preparing the agent…"}</p>
  </>;
  return <article className="fleet-run" data-selected={selected} data-waiting={Boolean(request)} data-stale={stale} data-run-id={run.runId} style={style}>
    {onSelect ? <button type="button" className="fleet-run-select" aria-pressed={selected} aria-label={`Inspect ${provider?.label ?? run.provider}: ${origin.title}`} onClick={onSelect}>{contents}</button>
      : <Link className="fleet-run-select" href={runOwnerHref(run, runTabIds)} aria-label={`Open ${provider?.label ?? run.provider}: ${origin.title}`}>{contents}</Link>}
  </article>;
}

function PipelineCrumbs({ place, workspace, className }: { place: PipelinePlace; workspace: string; className: string }) {
  const suite = place.suiteKey !== null ? `${place.suiteKey} · ${place.suiteName}` : place.suiteName;
  const step = place.stepKey !== null ? `${place.stepKey} · ${place.stepTitle}` : place.stepTitle;
  const where = [workspace, place.name ?? "Suite run", suite, place.stationKey, step].filter(Boolean).join(" › ");
  return (
    <span className={`${className} fleet-crumbs`} title={where} aria-label={`Pipeline run: ${where}`}>
      <span className="fleet-crumb-pipeline">{place.name ?? `${workspace} · suite run`}</span>
      <span className="fleet-crumb-sep fleet-crumb-pipeline-sep" aria-hidden>›</span>
      <span className="fleet-crumb-chip" data-kind="suite">{place.suiteKey ?? "Suite"}</span>
      <span className="fleet-crumb-name">{place.suiteName}</span>
      <span className="fleet-crumb-sep" aria-hidden>›</span>
      {place.stationKey !== null && <><span className="fleet-crumb-chip" data-kind="station">{place.stationKey}</span><span className="fleet-crumb-sep" aria-hidden>›</span></>}
      <span className="fleet-crumb-chip" data-kind="step">{place.stepKey ?? "Step"}</span>
      <span className="fleet-crumb-name fleet-crumb-step">{place.stepTitle}</span>
    </span>
  );
}

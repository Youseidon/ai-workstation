"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeStopReason } from "@hydra/shared";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useFleetConsole, useFleetMetadata } from "@/contexts/fleetContext";
import { runOrigin } from "@/features/agents/lib/fleet";
import { workspaceApi } from "@/api/workspacesApi";
import { SERVER_URL } from "@/api/serverUrl";
import type { RunStatus } from "@/models/runs";
import { actionSettled, type PipelineTarget, type StopAction } from "../lib/stopTargets";

/**
 * The one place the app stops things. Every Stop and Pause control opens this
 * rather than acting on its own, so the operator always sees the same three
 * choices worded the same way, and a second click lands on a spinner instead
 * of a second request.
 */

interface Focus { runId?: string; pipelineId?: number }
interface Pending { id: number; action: StopAction; runId: string | null; resolvedAt: number | null }

interface StopCenterApi {
  open(focus?: Focus): void;
}

const StopCenterContext = createContext<StopCenterApi>({ open() {} });
const PendingContext = createContext<Record<string, Pending>>({});

export function useStopCenter() { return useContext(StopCenterContext); }

const BUSY_LABEL: Record<StopAction, string> = {
  pause: "Pausing…",
  resume: "Resuming…",
  forceStop: "Stopping agent…",
  stopPipeline: "Stopping pipeline…",
  stopAgent: "Stopping…",
};

/** A stop the server accepted but that never showed up is dropped after this, so a spinner cannot stick. */
const SETTLE_TIMEOUT_MS = 20_000;

export function StopCenterProvider({ children }: { children: ReactNode }) {
  const { targets, refresh } = useFleetMetadata();
  const { runs } = useFleetConsole();
  const toast = useToast();
  const [focus, setFocus] = useState<Focus | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  // State updates are async; refs are what actually stop the second click.
  const inFlight = useRef(new Set<string>());
  const nextId = useRef(0);

  // A spinner stays until the server's own state shows the action took effect:
  // a stop is done when the agent leaves the live run list, not when the HTTP
  // call returns. Derived here rather than deleted in an effect.
  const live = useMemo(() => Object.fromEntries(Object.entries(pending).filter(([key, entry]) => entry.resolvedAt === null
    || !actionSettled(entry.action, { pipeline: targets.pipelines.find((target) => target.key === key), runId: entry.runId }, runs))), [pending, targets, runs]);
  const liveRef = useRef(live);
  useEffect(() => { liveRef.current = live; }, [live]);

  const drop = useCallback((key: string, id: number) => setPending((current) => {
    if (current[key]?.id !== id) return current;
    const next = { ...current };
    delete next[key];
    return next;
  }), []);

  const perform = useCallback(async (key: string, action: StopAction, runId: string | null, call: () => Promise<string | void>) => {
    if (inFlight.current.has(key) || liveRef.current[key] !== undefined) return;
    inFlight.current.add(key);
    const id = (nextId.current += 1);
    setPending((current) => ({ ...current, [key]: { id, action, runId, resolvedAt: null } }));
    try {
      const shortfall = await call();
      if (typeof shortfall === "string") toast.warning("Resumed, but no agent started", shortfall);
      setPending((current) => current[key]?.id === id ? { ...current, [key]: { ...current[key], resolvedAt: Date.now() } } : current);
      // The server accepted it; never let a missed update leave a spinner up.
      setTimeout(() => drop(key, id), SETTLE_TIMEOUT_MS);
    } catch (error) {
      drop(key, id);
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current.delete(key);
    }
    refresh();
  }, [drop, refresh, toast]);

  // The socket announces run endings; pipeline state arrives with the next
  // operations read, so poll gently while something is still settling.
  const settling = Object.values(live).some((entry) => entry.resolvedAt !== null);
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [settling, refresh]);

  const api = useMemo<StopCenterApi>(() => ({ open: (next) => setFocus(next ?? {}) }), []);

  return (
    <StopCenterContext.Provider value={api}>
      <PendingContext.Provider value={live}>
        {children}
        <StopCenterModal focus={focus} onClose={() => setFocus(null)} pending={live} perform={perform} />
      </PendingContext.Provider>
    </StopCenterContext.Provider>
  );
}

type Perform = (key: string, action: StopAction, runId: string | null, call: () => Promise<string | void>) => Promise<void>;

function StopCenterModal({ focus, onClose, pending, perform }: { focus: Focus | null; onClose(): void; pending: Record<string, Pending>; perform: Perform }) {
  const { targets } = useFleetMetadata();
  const { stale } = useFleetConsole();
  const body = useRef<HTMLDivElement>(null);
  const focusKey = focus === null ? null
    : targets.pipelines.find((target) => (focus.runId !== undefined && target.run?.runId === focus.runId) || (focus.pipelineId !== undefined && target.pipelineId === focus.pipelineId))?.key
      ?? focus.runId ?? null;

  useEffect(() => {
    if (focusKey === null) return;
    body.current?.querySelector(`[data-stop-key="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusKey]);

  // Stop from a pipeline page can name a run with nothing live here, such as
  // one interrupted by a restart and waiting to resume on its own.
  const orphan = focus?.pipelineId !== undefined && !targets.pipelines.some((target) => target.pipelineId === focus.pipelineId) ? focus.pipelineId : null;
  const nothing = targets.pipelines.length === 0 && targets.agents.length === 0 && orphan === null;
  return (
    <Modal open={focus !== null} onClose={onClose} title="Stop" description="Choose what should stop. Nothing here deletes work." size="md">
      <div ref={body} className="space-y-3">
        {stale && <p className="text-xs text-warning" role="status">Reconnecting — actions are paused until the server answers.</p>}
        {nothing && <p className="py-6 text-center text-sm text-fg-muted">Nothing is running.</p>}
        {orphan !== null && <section data-stop-key={`pipeline-${orphan}`} className="stop-card">
          <p className="text-sm font-medium">This pipeline</p>
          <p className="text-xs text-fg-muted">No agent is running for it.</p>
          {pending[`pipeline-${orphan}`] && <div className="stop-progress" role="progressbar" aria-label={BUSY_LABEL.stopPipeline} />}
          <ul><Option action="stopPipeline" label="Stop pipeline" variant="danger" hint="Ends the run and any pending restart. Done steps stay." pending={pending[`pipeline-${orphan}`]} disabled={stale}
            onClick={() => void perform(`pipeline-${orphan}`, "stopPipeline", null, async () => { await workspaceApi.stopPipeline(SERVER_URL, orphan, { interruptAgent: true }); })} /></ul>
        </section>}
        {targets.pipelines.map((target) => <PipelineCard key={target.key} target={target} focused={focusKey === target.key} pending={pending[target.key]} perform={perform} disabled={stale} />)}
        {targets.agents.length > 0 && <>
          {targets.pipelines.length > 0 && <h3 className="pt-2 text-xs font-semibold uppercase tracking-[0.12em] text-fg-dim">Other agents</h3>}
          {targets.agents.map((run) => <AgentCard key={run.runId} run={run} focused={focusKey === run.runId} pending={pending[run.runId]} perform={perform} disabled={stale} />)}
        </>}
      </div>
    </Modal>
  );
}

function useAgentLabel() {
  const { providers } = useFleetConsole();
  return (run: RunStatus) => providers.find((provider) => provider.id === run.provider)?.label ?? run.provider;
}

const PHASE_LABEL: Record<PipelineTarget["phase"], string> = {
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  waiting: "Waiting",
};

function PipelineCard({ target, focused, pending, perform, disabled }: { target: PipelineTarget; focused: boolean; pending: Pending | undefined; perform: Perform; disabled: boolean }) {
  const agentLabel = useAgentLabel();
  const run = target.run;
  const runId = run?.runId ?? null;
  const pipelineId = target.pipelineId;
  const act = (action: StopAction, call: () => Promise<string | void>) => void perform(target.key, action, runId, call);
  const options: OptionProps[] = [];

  if (pipelineId !== null && target.state === "PLAYING") options.push({
    action: "pause", label: "Pause", variant: "secondary",
    hint: run ? "Agent finishes this step. Nothing new starts." : "Nothing new starts.",
    onClick: () => act("pause", async () => { await workspaceApi.pausePipeline(SERVER_URL, pipelineId, { mode: "graceful" }); }),
  });
  if (pipelineId !== null && target.state === "PAUSED") options.push({
    action: "resume", label: "Resume", variant: "success",
    hint: run ? "Cancel the pause. Next step starts as usual." : "Continue from the current step.",
    onClick: () => act("resume", async () => {
      const resumed = await workspaceApi.playPipeline(SERVER_URL, pipelineId);
      if (resumed.state === "WAITING_HUMAN") return describeStopReason(resumed.waitReason) ?? "It parked again before any agent started.";
    }),
  });
  if (run !== null) options.push({
    action: "forceStop", label: "Force stop agent", variant: "danger",
    hint: "Kills the agent now. Pipeline pauses on this step.",
    onClick: () => act("forceStop", async () => { await workspaceApi.stopAgent(SERVER_URL, run.runId); }),
  });
  if (pipelineId !== null) options.push({
    action: "stopPipeline", label: "Stop pipeline", variant: "danger",
    hint: run ? "Ends the run and kills the agent. Done steps stay." : "Ends the run. Done steps stay.",
    onClick: () => act("stopPipeline", async () => { await workspaceApi.stopPipeline(SERVER_URL, pipelineId, { interruptAgent: true }); }),
  });

  const where = run ? `${agentLabel(run)} on ${target.stepTitle ?? "the current step"}` : target.phase === "paused" ? "Held — no agent running." : "No agent running right now.";
  return (
    <section data-stop-key={target.key} data-focused={focused} className="stop-card">
      <header className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <Link href={target.href} className="block truncate text-sm font-medium hover:underline">{target.name}</Link>
          <p className="truncate text-xs text-fg-muted">{target.workspaceName} · {where}</p>
        </div>
        <span className="stop-phase" data-phase={target.phase}>{target.phase === "pausing" && <Spinner size={10} />}{PHASE_LABEL[target.phase]}</span>
      </header>
      {pending && <div className="stop-progress" role="progressbar" aria-label={BUSY_LABEL[pending.action]} />}
      {target.phase === "pausing" && !pending && <p className="text-xs text-fg-muted">Waiting for the agent to finish its step…</p>}
      {pipelineId === null && <p className="text-xs text-fg-dim">This suite runs on its own; pause and stop it from its page.</p>}
      <ul className="space-y-1.5">{options.map((option) => <Option key={option.action} {...option} pending={pending} disabled={disabled} />)}</ul>
    </section>
  );
}

function AgentCard({ run, focused, pending, perform, disabled }: { run: RunStatus; focused: boolean; pending: Pending | undefined; perform: Perform; disabled: boolean }) {
  const agentLabel = useAgentLabel();
  const origin = runOrigin(run);
  return (
    <section data-stop-key={run.runId} data-focused={focused} className="stop-card">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{agentLabel(run)} · {origin.title || "Untitled task"}</p>
        <p className="truncate text-xs text-fg-muted">{run.workspace.name} · {origin.kind}</p>
      </div>
      {pending && <div className="stop-progress" role="progressbar" aria-label={BUSY_LABEL[pending.action]} />}
      <ul><Option action="stopAgent" label="Stop agent" variant="danger" hint="Stops it now. Changes so far stay." pending={pending} disabled={disabled}
        onClick={() => void perform(run.runId, "stopAgent", run.runId, async () => { await workspaceApi.stopAgent(SERVER_URL, run.runId); })} /></ul>
    </section>
  );
}

interface OptionProps { action: StopAction; label: string; hint: string; variant: ButtonVariant; onClick(): void }

function Option({ action, label, hint, variant, onClick, pending, disabled }: OptionProps & { pending: Pending | undefined; disabled: boolean }) {
  const mine = pending?.action === action;
  return (
    <li className="flex items-center gap-3">
      <Button size="sm" variant={variant} loading={mine} disabled={disabled || pending !== undefined} onClick={onClick} className="w-40 shrink-0 justify-center">
        {mine ? BUSY_LABEL[action] : label}
      </Button>
      <span className="text-xs text-fg-muted">{hint}</span>
    </li>
  );
}

/** The single stop icon. Lives in the top rail, so it is on every page. */
export function StopCenterButton() {
  const { open } = useStopCenter();
  const pending = useContext(PendingContext);
  const { targets } = useFleetMetadata();
  const count = targets.agents.length + targets.pipelines.length;
  const busy = Object.keys(pending).length > 0;
  return (
    <button type="button" className="stop-center-trigger" data-active={count > 0} onClick={() => open()}
      aria-label={count > 0 ? `Stop or pause (${count} active)` : "Stop or pause"} title="Stop or pause">
      {busy ? <Spinner size={14} /> : <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" /></svg>}
      <span>Stop</span>
      {count > 0 && <span className="stop-center-count">{count}</span>}
    </button>
  );
}

/**
 * A quiet line under the rail saying what is about to happen, so a pause the
 * operator asked for is visibly in progress rather than looking ignored.
 */
export function StopNotices() {
  const pending = useContext(PendingContext);
  const { targets } = useFleetMetadata();
  const { open } = useStopCenter();
  const agentLabel = useAgentLabel();
  const lines: { key: string; busy: boolean; text: string; resume?: number }[] = [];
  for (const target of targets.pipelines) {
    const entry = pending[target.key];
    if (entry && entry.action !== "pause") {
      lines.push({ key: target.key, busy: true, text: `${BUSY_LABEL[entry.action].replace("…", "")} ${entry.action === "forceStop" && target.run ? agentLabel(target.run) : target.name}…` });
    } else if (target.phase === "pausing" || entry?.action === "pause") {
      const then = target.run ? `${agentLabel(target.run)} finishes ${target.stepTitle ?? "its step"}, then nothing new starts.` : "nothing new starts.";
      lines.push({ key: target.key, busy: true, text: `Pausing ${target.name}: ${then}` });
    } else if (target.phase === "paused") {
      lines.push({ key: target.key, busy: false, text: `${target.name} is paused. Nothing runs until you resume.`, ...(target.pipelineId !== null ? { resume: target.pipelineId } : {}) });
    }
  }
  for (const run of targets.agents) {
    const entry = pending[run.runId];
    if (entry) lines.push({ key: run.runId, busy: true, text: `Stopping ${agentLabel(run)}…` });
  }
  if (lines.length === 0) return null;
  return (
    <div className="stop-notices" role="status" aria-live="polite">
      {lines.map((line) => (
        <p key={line.key}>
          {line.busy ? <Spinner size={10} /> : <span aria-hidden>❚❚</span>}
          <span className="truncate">{line.text}</span>
          {line.resume !== undefined && <button type="button" onClick={() => open({ pipelineId: line.resume })}>Resume…</button>}
        </p>
      ))}
    </div>
  );
}

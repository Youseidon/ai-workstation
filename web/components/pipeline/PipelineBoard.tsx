"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type {
  OperationsPrompt,
  OperationsSnapshot,
  PipelineRecord,
  PipelineRunDetail,
  ProgramRecord,
  PromptPipelineRule,
  ProviderId,
  SuitePipelineView,
  WorkspaceTree,
} from "@agent-console/shared";
import { modelLabel, PROVIDER_IDS } from "@agent-console/shared";
import { needsHumanResponse } from "@/lib/humanInput";
import { HumanInputDialog } from "@/components/HumanInputDialog";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextInput } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { agentState, type AgentActivity } from "@/lib/agentState";
import { useModelSelection } from "@/lib/useModelSelection";
import { providerTheme } from "@/lib/providerTheme";
import { workspaceApi } from "@/lib/workspacesApi";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { useWorkspace } from "@/lib/workspaceContext";
import { ModelMenu } from "@/components/ModelMenu";
import { PageChrome } from "@/components/shell/chrome";
import { PipelineArchive } from "./PipelineArchive";
import { PipelineConstellation, type ConstellationStage } from "./PipelineConstellation";
import { SnakeFlow } from "./SnakeFlow";
import {
  LABEL,
  namedPlayKind,
  onBlockedChip,
  onDoneChip,
  overrideChip,
  PIPELINE_LABEL,
  PIPELINE_TONE,
  showPause,
  showStop,
  stationOccupancy,
  TONE,
} from "./status";

export function PipelineBoard() {
  const console_ = useAgentConsole();
  const { selected: inputProvider } = usePreferredProvider(console_.providers);
  const [inputItem, setInputItem] = useState<OperationsPrompt | null>(null);
  const toast = useToast();
  const dialogs = useDialogs();
  const params = useSearchParams();
  const models = useModelSelection(console_.providers);
  const { workspaceId, status: workspaceStatus } = useWorkspace();

  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [runs, setRuns] = useState<PipelineRunDetail[]>([]);
  const [view, setView] = useState<SuitePipelineView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [configId, setConfigId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffProvider, setHandoffProvider] = useState<ProviderId>("claude");
  const [successorProvider, setSuccessorProvider] = useState<ProviderId>("claude");
  const [saveName, setSaveName] = useState("");
  const [expandedPrograms, setExpandedPrograms] = useState<Set<number>>(new Set());

  const [pipelineId, setPipelineId] = useState<number | null>(() => {
    const value = Number(params.get("pipeline"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [suiteId, setSuiteId] = useState<number | null>(() => {
    const value = Number(params.get("suite"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [draftSuiteIds, setDraftSuiteIds] = useState<number[]>([]);
  const [draftName, setDraftName] = useState("Untitled pipeline");
  const appliedPipelineId = useRef<number | null>(null);
  const suiteBootstrapped = useRef(false);

  const expandedForWorkspace = useRef<number | null>(null);
  const lastWorkspaceId = useRef<number | null>(workspaceId);

  const refreshCatalog = useCallback(async () => {
    const target = workspaceId;
    if (target === null) {
      setTree(null);
      setSnapshot(null);
      setPipelines([]);
      return target;
    }
    const [nextTree, operations, named] = await Promise.all([
      workspaceApi.tree(SERVER_URL, target),
      workspaceApi.operations(SERVER_URL, target),
      workspaceApi.listPipelines(SERVER_URL, target),
    ]);
    setTree(nextTree);
    setSnapshot(operations);
    setPipelines(named);
    if (expandedForWorkspace.current !== target) {
      expandedForWorkspace.current = target;
      setExpandedPrograms(new Set(nextTree.programs.map((program) => program.id)));
    }
    if (pipelineId !== null && !named.some((item) => item.id === pipelineId)) {
      setPipelineId(null);
      appliedPipelineId.current = null;
    } else if (pipelineId !== null) {
      const item = named.find((entry) => entry.id === pipelineId);
      if (item !== undefined && appliedPipelineId.current !== pipelineId) {
        setDraftName(item.name);
        setDraftSuiteIds(item.stages.map((stage) => stage.suiteId));
        appliedPipelineId.current = pipelineId;
      }
      try {
        setRuns(await workspaceApi.pipelineRuns(SERVER_URL, pipelineId));
      } catch {
        setRuns([]);
      }
    }
    if (!suiteBootstrapped.current && suiteId !== null && pipelineId === null) {
      const exists = nextTree.programs.some((program) => program.suites.some((suite) => suite.id === suiteId));
      if (exists) {
        suiteBootstrapped.current = true;
        setDraftSuiteIds((ids) => (ids.includes(suiteId) ? ids : [...ids, suiteId]));
      }
    }
    return target;
  }, [workspaceId, pipelineId, suiteId]);

  useEffect(() => {
    // Server catalog: refresh on mount and when the socket says operations changed.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async catalog fetch, same pattern as TasksView
    void refreshCatalog()
      .then(() => setLoadError(null))
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Pipeline desk could not be loaded."));
  }, [refreshCatalog, console_.operationsRevision]);

  const pipeline = pipelines.find((item) => item.id === pipelineId) ?? null;

  const dirty =
    pipeline === null
      ? draftSuiteIds.length > 0 || draftName.trim() !== "Untitled pipeline"
      : draftName.trim() !== pipeline.name ||
        draftSuiteIds.length !== pipeline.stages.length ||
        draftSuiteIds.some((id, index) => pipeline.stages[index]?.suiteId !== id);

  const programs = useMemo(() => tree?.programs ?? [], [tree]);
  const suitesById = useMemo(() => {
    const map = new Map<number, { program: ProgramRecord; suite: ProgramRecord["suites"][number] }>();
    for (const program of programs) {
      for (const suite of program.suites) map.set(suite.id, { program, suite });
    }
    return map;
  }, [programs]);

  const operationsById = useMemo(() => {
    const map = new Map((snapshot?.suites ?? []).map((suite) => [suite.id, suite]));
    return map;
  }, [snapshot]);

  const stages: ConstellationStage[] = draftSuiteIds.flatMap((id) => {
    const home = suitesById.get(id);
    const ops = operationsById.get(id) ?? null;
    if (home === undefined && ops === null) return [];
    const saved = pipeline?.stages.find((stage) => stage.suiteId === id);
    const providers = [
      ...new Set(
        (ops?.prompts ?? [])
          .filter((item) => item.pipelineRule.enabled && item.pipelineRule.provider !== null)
          .map((item) => item.pipelineRule.provider as ProviderId),
      ),
    ];
    return [
      {
        suiteId: id,
        programName: home?.program.name ?? ops?.programName ?? saved?.programName ?? "Program",
        programKey: home?.program.externalKey ?? ops?.programKey ?? saved?.programKey ?? null,
        suiteName: home?.suite.name ?? ops?.name ?? saved?.suiteName ?? "Suite",
        suiteKey: home?.suite.externalKey ?? ops?.key ?? saved?.suiteKey ?? null,
        promptCount: home?.suite.prompts.length ?? ops?.prompts.length ?? saved?.promptCount ?? 0,
        stepCount: saved?.stepCount ?? ops?.prompts.filter((item) => item.pipelineRule.enabled).length ?? 0,
        operations: ops,
        providers,
      },
    ];
  });

  const activeSuiteId = stages.some((stage) => stage.suiteId === suiteId)
    ? suiteId
    : (stages[0]?.suiteId ?? null);

  useEffect(() => {
    if (activeSuiteId === null) return;
    let disposed = false;
    void workspaceApi
      .pipeline(SERVER_URL, activeSuiteId)
      .then((next) => {
        if (!disposed) setView(next);
      })
      .catch(() => {
        if (!disposed) setView(null);
      });
    return () => {
      disposed = true;
    };
  }, [activeSuiteId, console_.operationsRevision]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (workspaceId !== null) next.set("workspace", String(workspaceId));
    if (pipelineId !== null) next.set("pipeline", String(pipelineId));
    if (activeSuiteId !== null) next.set("suite", String(activeSuiteId));
    const query = next.toString();
    window.history.replaceState(null, "", query === "" ? "/pipeline" : `/pipeline?${query}`);
  }, [workspaceId, pipelineId, activeSuiteId]);

  const live = pipeline?.active ?? pipeline?.latest ?? null;
  const occupancy =
    workspaceId === null
      ? null
      : (console_.runs.find((run) => run.workspace.id === workspaceId && run.role === "execute") ?? null);
  const kind = namedPlayKind(live);
  const firstAvailable = console_.providers.find((item) => item.available)?.id ?? "claude";
  const suiteOps = activeSuiteId === null ? null : (operationsById.get(activeSuiteId) ?? null);
  const resumeSuiteOps = live?.currentSuiteId === null || live?.currentSuiteId === undefined ? null : (operationsById.get(live.currentSuiteId) ?? null);
  const resumeSuiteRun = resumeSuiteOps?.pipeline?.active ?? resumeSuiteOps?.pipeline?.latest ?? null;
  const resumeItem = resumeSuiteRun?.currentPromptId == null ? null : (resumeSuiteOps?.prompts.find((item) => item.prompt.id === resumeSuiteRun.currentPromptId) ?? null);
  const steps = view?.steps ?? [];
  const byId = new Map((suiteOps?.prompts ?? []).map((item) => [item.prompt.id, item]));
  const flowSteps = steps.filter((step) => byId.has(step.promptId));

  const crew = useMemo(() => {
    return PROVIDER_IDS.map((id) => {
      const info = console_.providers.find((item) => item.id === id);
      const assigned = stages.some((stage) => stage.providers.includes(id));
      const state = info === undefined ? null : agentState(info, console_.runs, console_.items, console_.lastRun);
      const activity: AgentActivity = !assigned
        ? "offline"
        : (state?.activity ?? (info?.available === true ? "idle" : "offline"));
      return { id, assigned, activity, caption: state?.caption ?? (assigned ? "on this rail" : "not assigned") };
    });
  }, [console_.items, console_.lastRun, console_.providers, console_.runs, stages]);

  const playBlocked = useMemo(() => {
    if (console_.connection !== "open") return "backend disconnected";
    if (pipelineId === null) return "save this pipeline first";
    if (draftSuiteIds.length === 0) return "add at least one suite";
    if (dirty) return "save changes first";
    if (stages.some((stage) => stage.stepCount === 0)) return "every suite needs at least one step";
    if (occupancy !== null && live?.state === "PLAYING" && live.currentSuiteRunId !== occupancy.runId) {
      return "workspace has a writer";
    }
    return null;
  }, [console_.connection, pipelineId, draftSuiteIds.length, dirty, stages, occupancy, live]);

  const act = async (operation: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await operation();
      await refreshCatalog();
      if (pipelineId !== null) {
        const items = await workspaceApi.pipelineRuns(SERVER_URL, pipelineId);
        setRuns(items);
      }
      if (success !== undefined) toast.success(success);
    } catch (error) {
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // Global beacon switched projects — drop local draft/selection for the old one.
  // Skip the first assignment from boot/URL so deep links keep pipeline/suite.
  useEffect(() => {
    if (lastWorkspaceId.current === workspaceId) return;
    const previous = lastWorkspaceId.current;
    lastWorkspaceId.current = workspaceId;
    if (previous === null) return;
    setPipelineId(null);
    setSuiteId(null);
    setDraftSuiteIds([]);
    setDraftName("Untitled pipeline");
    setRuns([]);
    setView(null);
    appliedPipelineId.current = null;
    suiteBootstrapped.current = true;
  }, [workspaceId]);

  const selectPipeline = (id: number | null) => {
    setPipelineId(id);
    if (id === null) {
      setDraftSuiteIds([]);
      setDraftName("Untitled pipeline");
      setRuns([]);
      appliedPipelineId.current = null;
      return;
    }
    const item = pipelines.find((entry) => entry.id === id);
    if (item !== undefined) {
      setDraftName(item.name);
      setDraftSuiteIds(item.stages.map((stage) => stage.suiteId));
      appliedPipelineId.current = id;
    }
  };

  const toggleSuite = (id: number) => {
    setDraftSuiteIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    setSuiteId(id);
  };

  const persist = async (name: string) => {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("Name this pipeline first.");
    if (workspaceId === null) throw new Error("Choose a workspace first.");
    const saved =
      pipelineId === null
        ? await workspaceApi.createPipeline(SERVER_URL, {
            workspaceId,
            name: trimmed,
            suiteIds: draftSuiteIds,
          })
        : await workspaceApi.updatePipeline(SERVER_URL, pipelineId, {
            name: trimmed,
            suiteIds: draftSuiteIds,
          });
    setPipelineId(saved.id);
    setDraftName(saved.name);
    setDraftSuiteIds(saved.stages.map((stage) => stage.suiteId));
    appliedPipelineId.current = saved.id;
    try {
      setRuns(await workspaceApi.pipelineRuns(SERVER_URL, saved.id));
    } catch {
      setRuns([]);
    }
    return saved;
  };

  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <PageChrome
        title="Pipeline"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <CrewStrip crew={crew} />
            {live !== null && (
              <Badge tone={PIPELINE_TONE[live.state]} dot pulse={live.state === "PLAYING"} uppercase>
                {PIPELINE_LABEL[live.state]}
              </Badge>
            )}
            {showPause(live) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || pipelineId === null}
                onClick={() =>
                  void act(async () => {
                    await workspaceApi.pausePipeline(SERVER_URL, pipelineId!);
                  }, "Paused — current step will finish.")
                }
              >
                Pause
              </Button>
            )}
            {showStop(live) && (
              <Button
                size="sm"
                variant="danger"
                disabled={busy || pipelineId === null}
                onClick={() =>
                  void act(async () => {
                    const confirmed = await dialogs.confirm({
                      title: "Stop this pipeline?",
                      description: "Stops auto-advance. The current agent, if running, is interrupted.",
                      confirmLabel: "Stop pipeline",
                      tone: "danger",
                    });
                    if (!confirmed) return;
                    await workspaceApi.stopPipeline(SERVER_URL, pipelineId!);
                  }, "Pipeline stopped")
                }
              >
                Stop
              </Button>
            )}
            {kind !== "hidden" && (
              <Button
                size="sm"
                variant="success"
                disabled={playBlocked !== null || busy}
                title={playBlocked ?? undefined}
                onClick={() => {
                  if (resumeItem !== null && (needsHumanResponse(resumeItem) || (resumeItem.prompt.status === "TODO" && resumeItem.latestHandoff?.recommendation === "WAIT_FOR_HUMAN"))) {
                    setInputItem(resumeItem);
                    return;
                  }
                  if (kind === "resume" && resumeItem !== null) {
                    const available=console_.providers.find((provider)=>provider.available)?.id??firstAvailable;
                    const readOnly=console_.providers.find((provider)=>provider.available&&provider.id!=="cursor")?.id??available;
                    setHandoffProvider(readOnly);setSuccessorProvider(available);setHandoffOpen(true);return;
                  }
                  void act(async () => { await workspaceApi.playPipeline(SERVER_URL, pipelineId!); }, "Pipeline is running");
                }}
              >
                {kind === "resume" ? (needsHumanResponse(resumeItem) ? "Review and respond" : "Resume") : "Play"}
              </Button>
            )}
          </div>
        }
      />

      {loadError !== null && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          {loadError}
        </div>
      )}
      {loadError === null && workspaceStatus === "empty" && (
        <div role="status" className="border-b border-line bg-surface-1 px-4 py-2 text-xs text-fg-muted">
          No workspaces yet.{" "}
          <Link href="/workspaces" className="text-accent hover:underline">
            Create one
          </Link>{" "}
          before building a pipeline.
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_280px]">
        <aside className="min-h-0 overflow-y-auto border-r border-line bg-surface-1 p-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">Pipelines</div>
            <button
              type="button"
              onClick={() => selectPipeline(null)}
              className="text-[11px] text-accent hover:underline"
            >
              + New
            </button>
          </div>
          <div className="mb-4 space-y-1">
            <button
              type="button"
              onClick={() => selectPipeline(null)}
              aria-current={pipelineId === null ? "true" : undefined}
              className={cn(
                "w-full rounded-md px-2.5 py-2 text-left text-[13px]",
                pipelineId === null ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              Draft
              {draftSuiteIds.length > 0 && (
                <span className="ml-2 text-[10px] text-fg-dim">{draftSuiteIds.length} suites</span>
              )}
            </button>
            {pipelines.map((item) => {
              const badge = item.active ?? item.latest;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectPipeline(item.id)}
                  aria-current={item.id === pipelineId ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left",
                    item.id === pipelineId ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <span className="min-w-0 truncate text-[13px]">{item.name}</span>
                  {badge !== null && (
                    <Badge tone={PIPELINE_TONE[badge.state]} pulse={badge.state === "PLAYING"}>
                      {PIPELINE_LABEL[badge.state]}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-fg-dim">Programs</div>
          {tree === null ? (
            <Skeleton className="h-24 w-full" />
          ) : programs.length === 0 ? (
            <p className="text-xs text-fg-dim">This workspace has no programs yet.</p>
          ) : (
            programs.map((program) => {
              const open = expandedPrograms.has(program.id);
              return (
                <div key={program.id} className="mb-2">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedPrograms((current) => {
                        const next = new Set(current);
                        if (next.has(program.id)) next.delete(program.id);
                        else next.add(program.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2"
                    aria-expanded={open}
                  >
                    <span className="text-[10px] text-fg-dim">{open ? "▾" : "▸"}</span>
                    <span className="min-w-0 truncate">
                      {program.externalKey !== null && <span className="text-fg-muted">{program.externalKey} · </span>}
                      {program.name}
                    </span>
                    <span className="ml-auto numeric text-[10px] text-fg-dim">{program.suites.length}</span>
                  </button>
                  {open && (
                    <ul className="ml-4 border-l border-line pl-2">
                      {program.suites.map((suite) => {
                        const on = draftSuiteIds.includes(suite.id);
                        const ops = operationsById.get(suite.id);
                        return (
                          <li key={suite.id}>
                            <button
                              type="button"
                              onClick={() => toggleSuite(suite.id)}
                              aria-pressed={on}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                                on ? "bg-accent/10 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                                suite.id === activeSuiteId && "ring-1 ring-inset ring-accent/30",
                              )}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "grid size-3.5 place-items-center rounded-[3px] text-[9px] ring-1 ring-inset",
                                  on ? "bg-accent/20 text-accent ring-accent/50" : "ring-line text-fg-dim",
                                )}
                              >
                                {on ? "✓" : ""}
                              </span>
                              <span className="min-w-0 truncate">
                                {suite.externalKey !== null && <span className="text-fg-dim">{suite.externalKey} · </span>}
                                {suite.name}
                              </span>
                              {ops?.pipeline?.active != null && (
                                <span className="ml-auto size-1.5 rounded-full bg-info animate-breathe" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </aside>

        <section className="pipeline-desk min-h-0 overflow-auto p-5">
          <div className="mx-auto max-w-6xl space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-accent">Pipeline</div>
                <h2 className="mt-1 text-2xl tracking-tight text-fg">{draftName}</h2>
                <p className="mt-1 text-xs text-fg-dim">
                  {tree?.name ?? "Choose a workspace"} · {stages.length} suite{stages.length === 1 ? "" : "s"}
                  {dirty ? " · unsaved" : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !dirty}
                  onClick={() => {
                    setSaveName(draftName === "Untitled pipeline" ? "" : draftName);
                    setSaveOpen(true);
                  }}
                >
                  Save pipeline
                </Button>
                {pipelineId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || live !== null && showStop(live)}
                    onClick={() =>
                      void act(async () => {
                        const confirmed = await dialogs.confirm({
                          title: `Delete ${draftName}?`,
                          description: "Past runs of this pipeline are removed with it.",
                          confirmLabel: "Delete",
                          tone: "danger",
                          confirmPhrase: draftName,
                        });
                        if (!confirmed) return;
                        await workspaceApi.removePipeline(SERVER_URL, pipelineId);
                        selectPipeline(null);
                      }, "Pipeline deleted")
                    }
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>

            {(live?.state === "WAITING_HUMAN" || needsHumanResponse(resumeItem)) && (
              <Banner tone="warning">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">Blocked — the current station needs a response before the pipeline can continue.</span>
                  {resumeItem !== null && needsHumanResponse(resumeItem) && (
                    <Button size="sm" variant="success" onClick={() => setInputItem(resumeItem)}>Review and respond</Button>
                  )}
                </div>
              </Banner>
            )}
            {live?.state === "PAUSED" && (
              <Banner tone="caution">Paused — the current station will finish, then the rail holds.</Banner>
            )}
            {live?.state === "INTERRUPTED" && pipeline?.active === null && (
              <Banner tone="caution">This pipeline was interrupted. Play to continue from a fresh run.</Banner>
            )}

            <PipelineConstellation
              stages={stages}
              selectedSuiteId={activeSuiteId}
              currentSuiteId={live?.currentSuiteId ?? null}
              pipelineState={live?.state ?? null}
              liveProviders={Object.fromEntries(crew.map((agent) => [agent.id, agent.activity])) as Partial<Record<ProviderId, AgentActivity>>}
              onSelect={(id) => setSuiteId(id)}
            />

            {suiteOps === null ? (
              <p className="text-sm text-fg-dim">Select a suite to wire its steps and agents.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">
                    {suiteOps.programName} · flowchart
                  </div>
                  <h3 className="mt-1 text-lg text-fg">
                    {suiteOps.key !== null && `${suiteOps.key} — `}
                    {suiteOps.name}
                  </h3>
                  <p className="mt-1 text-xs text-fg-dim">
                    Drag to set order. The gear on a step picks its agent. Work items not on this flow still run from Operations or Console.
                  </p>
                </div>

                {view?.available.length ? (
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">Add to flow</div>
                    <div className="flex flex-wrap gap-2">
                      {view.available.map((prompt) => (
                        <button
                          key={prompt.id}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const result = await workspaceApi.addPipelineStep(SERVER_URL, suiteOps.id, {
                                promptId: prompt.id,
                                provider: firstAvailable,
                              });
                              setView(result.pipeline);
                            })
                          }
                          className="rounded-full px-3 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line hover:bg-surface-2 hover:text-fg"
                        >
                          + {prompt.externalKey ?? prompt.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {flowSteps.length === 0 ? (
                  <div className="rounded-panel border border-dashed border-line bg-surface-1/70 px-6 py-12 text-center text-sm text-fg-dim">
                    This suite has no pipeline yet. Add work items above — they snake across the desk, each with its own model.
                  </div>
                ) : (
                  <SnakeFlow
                    items={flowSteps}
                    getKey={(step) => step.promptId}
                    isLiveIndex={(index) => view?.active?.currentPromptId === flowSteps[index]?.promptId}
                    wrapItem={(node, step) => (
                      <div
                        draggable
                        onDragStart={() => setDragId(step.promptId)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (dragId === null || dragId === step.promptId) return;
                          const ids = steps.map((entry) => entry.promptId);
                          const from = ids.indexOf(dragId);
                          const to = ids.indexOf(step.promptId);
                          if (from === -1 || to === -1) return;
                          ids.splice(from, 1);
                          ids.splice(to, 0, dragId);
                          setDragId(null);
                          void act(async () => {
                            const result = await workspaceApi.reorderPipelineSteps(SERVER_URL, suiteOps.id, ids);
                            setView(result.pipeline);
                          });
                        }}
                      >
                        {node}
                      </div>
                    )}
                    renderCard={(step, index) => {
                      const item = byId.get(step.promptId);
                      if (item === undefined) return null;
                      const liveRun = stationOccupancy(item, console_.runs, view?.active);
                      const current = view?.active?.currentPromptId === step.promptId;
                      return (
                        <FlowNode
                          index={index}
                          item={item}
                          rule={step}
                          current={current}
                          occupancy={liveRun}
                          onConfig={() => setConfigId(step.promptId)}
                          onRemove={() =>
                            void act(async () => {
                              const result = await workspaceApi.removePipelineStep(SERVER_URL, step.promptId);
                              setView(result.pipeline);
                            })
                          }
                        />
                      );
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <aside
          className={cn(
            "min-h-0 overflow-y-auto border-t border-line bg-surface-1 p-3 lg:border-t-0 xl:border-l",
            archiveOpen ? "block" : "hidden xl:block",
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">Mission log</div>
            <button
              type="button"
              className="text-[11px] text-fg-dim xl:hidden"
              onClick={() => setArchiveOpen(false)}
            >
              Hide
            </button>
          </div>
          {pipelineId === null ? (
            <p className="text-xs leading-relaxed text-fg-dim">Save a pipeline to keep a history of every run.</p>
          ) : (
            <PipelineArchive runs={runs} selectedId={selectedRunId} onSelect={setSelectedRunId} />
          )}
        </aside>
      </div>

      {!archiveOpen && (
        <button
          type="button"
          onClick={() => setArchiveOpen(true)}
          className="fixed right-3 bottom-16 z-20 rounded-full bg-surface-2 px-3 py-1.5 text-[11px] text-fg ring-1 ring-inset ring-line xl:hidden"
        >
          Mission log
        </button>
      )}

      {configId !== null && (
        <StepConfig
          rule={steps.find((step) => step.promptId === configId) ?? null}
          item={byId.get(configId) ?? null}
          providers={console_.providers}
          models={models}
          onClose={() => setConfigId(null)}
          onChange={(patch) =>
            void act(async () => {
              await workspaceApi.patchPipelineRule(SERVER_URL, configId, patch);
              if (activeSuiteId !== null) setView(await workspaceApi.pipeline(SERVER_URL, activeSuiteId));
            })
          }
        />
      )}

      {saveOpen && (
        <Modal
          open
          onClose={() => setSaveOpen(false)}
          title="Save pipeline"
          description="A named pipeline remembers this workspace and the suites on the rail. You can replay it and read every past run."
          footer={
            <>
              <Button variant="ghost" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || saveName.trim() === ""}
                onClick={() =>
                  void act(async () => {
                    const saved = await persist(saveName);
                    setSaveOpen(false);
                    toast.success(`Saved ${saved.name}`);
                  })
                }
              >
                Save
              </Button>
            </>
          }
        >
          <TextInput
            label="Name"
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
            placeholder="Launch v2"
            autoFocus
          />
        </Modal>
      )}

      {inputItem !== null && <HumanInputDialog item={inputItem} provider={inputProvider} model={models.resolve(inputProvider)} pipeline onClose={() => setInputItem(null)} />}
      {handoffOpen && resumeItem !== null && pipelineId !== null && (
        <Modal
          open
          onClose={() => setHandoffOpen(false)}
          title={`Continue ${resumeItem.prompt.externalKey ?? resumeItem.prompt.title}`}
          description="A read-only agent will prepare the handoff first. After it identifies completed and pending work, the selected developer agent will continue the pipeline."
          size="md"
          footer={<><Button variant="ghost" onClick={() => setHandoffOpen(false)}>Cancel</Button><Button variant="success" disabled={busy} onClick={() => void act(async()=>{await workspaceApi.startHandoff(SERVER_URL,resumeItem.prompt.id,{handoffProvider,handoffModel:models.resolve(handoffProvider),successorProvider,successorModel:models.resolve(successorProvider),pipelineId});setHandoffOpen(false);},"Handoff started")}>Prepare handoff and continue</Button></>}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-fg-muted"><span>Handoff agent · read-only</span><select value={handoffProvider} onChange={(event)=>setHandoffProvider(event.target.value as ProviderId)} className="h-10 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-fg">{console_.providers.filter((provider)=>provider.available&&provider.id!=="cursor").map((provider)=><option key={provider.id} value={provider.id}>{provider.label} · {modelLabel(provider.id,models.resolve(provider.id))??"default"}</option>)}</select></label>
            <label className="space-y-1.5 text-xs text-fg-muted"><span>Successor developer agent</span><select value={successorProvider} onChange={(event)=>setSuccessorProvider(event.target.value as ProviderId)} className="h-10 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-fg">{console_.providers.filter((provider)=>provider.available).map((provider)=><option key={provider.id} value={provider.id}>{provider.label} · {modelLabel(provider.id,models.resolve(provider.id))??"default"}</option>)}</select></label>
          </div>
          <p className="mt-4 text-xs leading-5 text-fg-dim">Nothing starts on app launch. This handoff begins only after you confirm, and its progress appears on the pipeline station before the successor starts.</p>
        </Modal>
      )}
    </main>
  );
}

function CrewStrip({
  crew,
}: {
  crew: Array<{ id: ProviderId; assigned: boolean; activity: AgentActivity; caption: string }>;
}) {
  return (
    <div className="hidden items-center gap-1 sm:flex" aria-label="Assigned agents">
      {crew.map((agent) => (
        <span key={agent.id} title={`${agent.id}: ${agent.caption}`} className={providerTheme[agent.id].text}>
          <AgentAvatar provider={agent.id} size={26} activity={agent.activity} />
        </span>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: "caution" | "warning"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-md px-3 py-2 text-[12px] ring-1 ring-inset",
        tone === "caution" && "bg-caution/10 text-caution ring-caution/30",
        tone === "warning" && "bg-warning/10 text-warning ring-warning/30",
      )}
    >
      {children}
    </div>
  );
}

function FlowNode({
  index,
  item,
  rule,
  current,
  occupancy,
  onConfig,
  onRemove,
}: {
  index: number;
  item: OperationsPrompt;
  rule: PromptPipelineRule;
  current: boolean;
  occupancy: ReturnType<typeof stationOccupancy>;
  onConfig(): void;
  onRemove(): void;
}) {
  const theme = rule.provider === null ? null : providerTheme[rule.provider];
  const who = overrideChip(rule);

  return (
    <div
      className={cn(
        "relative h-full min-w-0 rounded-panel border bg-surface-2 p-3",
        current ? "border-accent/50 ring-1 ring-accent/30" : "border-line",
      )}
    >
      <div className="flex items-start gap-2">
        {rule.provider !== null ? (
          <AgentAvatar
            provider={rule.provider}
            size={28}
            activity={occupancy !== null ? "tooling" : item.operationalState === "COMPLETE" ? "done" : "idle"}
          />
        ) : (
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] numeric text-fg-muted">
            {index + 1}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] text-fg">{item.prompt.externalKey ?? item.prompt.title}</div>
              {item.prompt.externalKey !== null && (
                <div className="truncate text-[11px] text-fg-dim">{item.prompt.title}</div>
              )}
            </div>
            <Badge tone={TONE[item.operationalState]}>{LABEL[item.operationalState]}</Badge>
          </div>
          <div className={cn("mt-2 text-xs", theme?.text ?? "text-fg-muted")}>{who ?? "No provider — open config"}</div>
          <div className="mt-1 text-[10px] text-fg-dim">
            {onDoneChip(rule.onDone)} · {onBlockedChip(rule)}
          </div>
          {occupancy !== null && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
              <AgentAvatar provider={occupancy.provider} size={16} activity="tooling" />
              running
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-1">
        <Button size="sm" variant="secondary" aria-label="Configure step" onClick={onConfig}>
          Config
        </Button>
        <Button size="sm" variant="ghost" aria-label="Remove from flow" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function StepConfig({
  rule,
  item,
  providers,
  models,
  onClose,
  onChange,
}: {
  rule: PromptPipelineRule | null;
  item: OperationsPrompt | null;
  providers: Parameters<typeof useModelSelection>[0];
  models: ReturnType<typeof useModelSelection>;
  onClose(): void;
  onChange(patch: Partial<Omit<PromptPipelineRule, "promptId">>): void;
}) {
  const [modelFor, setModelFor] = useState<ProviderId | null>(null);
  if (rule === null || item === null) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Step · ${item.prompt.externalKey ?? item.prompt.title}`}
      description="Provider and model apply only to this step. Outcome chips decide what happens after it finishes."
      size="md"
    >
      <div className="space-y-4">
        <section>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">AI for this step</div>
          <div className="flex flex-wrap gap-1">
            {PROVIDER_IDS.map((id) => {
              const info = providers.find((entry) => entry.id === id);
              const theme = providerTheme[id];
              const active = rule.provider === id;
              return (
                <div key={id} className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ provider: id, model: models.resolve(id) });
                      setModelFor(modelFor === id ? null : id);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset",
                      active ? theme.chip : "text-fg-muted ring-line hover:bg-surface-3",
                    )}
                  >
                    <AgentAvatar provider={id} size={16} activity={active ? "idle" : "offline"} />
                    {id}
                    {active && rule.model !== null && <span className="ml-1 opacity-70">{modelLabel(id, rule.model)}</span>}
                  </button>
                  {modelFor === id && info !== undefined && (
                    <ModelMenu
                      provider={id}
                      selected={active ? rule.model : models.resolve(id)}
                      configured={info.model}
                      pinned={models.isPinned(id)}
                      onSelect={(value) => {
                        onChange({ provider: id, model: value });
                        setModelFor(null);
                      }}
                      onClear={() => {
                        onChange({ provider: id, model: info.model });
                        setModelFor(null);
                      }}
                      onClose={() => setModelFor(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">On DONE</div>
          <div className="flex flex-wrap gap-1">
            {(["continue", "stop", "skip_rest"] as const).map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => onChange({ onDone: action })}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                  rule.onDone === action ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line",
                )}
              >
                {onDoneChip(action)}
              </button>
            ))}
          </div>
        </section>
        <section>
          <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">On BLOCKED</div>
          <div className="flex flex-wrap gap-1">
            {(["wait", "retry", "recover", "skip"] as const).map((action) => (
              <button
                key={action}
                type="button"
                onClick={() =>
                  onChange(
                    action === "recover"
                      ? { onBlocked: "recover", recoverProvider: rule.recoverProvider ?? rule.provider ?? "claude" }
                      : { onBlocked: action },
                  )
                }
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                  rule.onBlocked === action ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line",
                )}
              >
                {action}
              </button>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}

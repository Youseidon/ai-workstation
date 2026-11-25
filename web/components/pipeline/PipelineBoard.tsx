"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  OperationsPrompt,
  OperationsSnapshot,
  PipelineFlowchartView,
  PipelineRecord,
  PipelineRunDetail,
  PipelineSubStepRule,
  ProgramRecord,
  ProviderId,
  WorkspaceTree,
} from "@agent-console/shared";
import {
  DEFAULT_PIPELINE_POLICY,
  DEFAULT_STATUS_CATALOG,
  DEFAULT_TRIGGER_SENTENCES,
  defaultPromptPipelineRule,
  describeStopReason,
  modelLabel,
  PROVIDER_IDS,
} from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { VerificationPanel } from "@/components/VerificationPanel";
import { TextInput } from "@/components/ui/Field";
import { useDialogs } from "@/components/ui/Dialogs";
import { BtwBar } from "@/components/chat/BtwBar";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { agentState, type AgentActivity } from "@/lib/agentState";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { providerTheme } from "@/lib/providerTheme";
import { workspaceApi } from "@/lib/workspacesApi";
import { useWorkspace } from "@/lib/workspaceContext";
import { ContentTitle } from "@/components/shell/PageCanvas";
import { DetailDrawer, DetailReopen } from "@/components/shell/DetailDrawer";
import { UnsavedChangesGuard } from "@/components/shell/UnsavedChangesGuard";
import { SidebarBack, SidebarCollection, SidebarEmpty, SidebarGroup, SidebarRow } from "@/components/shell/SidebarCollection";
import { PipelineArchive } from "./PipelineArchive";
import { CommandPalette, type PaletteEntry } from "@/components/ui/CommandPalette";
import { PipelineOverviewPanel } from "./PipelineOverviewPanel";
import { PipelineStudio, STUDIO_ICONS, STUDIO_SECTIONS, type StudioSection } from "./PipelineStudio";
import { PipelineConstellation, type ConstellationStage } from "./PipelineConstellation";
import { PipelineStatusBar, type PipelinePosition } from "./PipelineStatusBar";
import { NewPipelineGuide, type NewPipelineGuideStep } from "./NewPipelineGuide";
import { PipelineInspector, type InspectorTab } from "./PipelineInspector";
import { RunConfidenceStrip } from "./RunConfidenceStrip";
import { SnakeFlow } from "./SnakeFlow";
import { StationCard } from "./StationCard";
import { StepConfigForm } from "./StepConfigForm";
import { ExecutionAllocationDialog } from "./ExecutionPanel";
import { AgentAssignments } from "./AgentAssignments";
import { HumanGate } from "./station/HumanGate";
import { collectInbox, NeedsYouInbox } from "./station/NeedsYouInbox";
import { StationPanel, type StationTab } from "./station/StationPanel";
import { ancestorIdsForPrompt, filterPromptTree, isTerminal, type WorkFilter } from "./station/tree";
import { useBoardKeys } from "./station/useBoardKeys";
import { useStationActions } from "./station/useStationActions";
import { WorkList } from "./station/WorkList";
import { SubPipeline, type SubStepRuleView, type SubTrailEntry } from "./SubPipeline";
import { nextPipelineLeaf } from "./continuation";
import {
  CONTROL_LABEL,
  LABEL,
  PIPELINE_LABEL,
  PIPELINE_TONE,
  pipelineStatus,
  stationOccupancy,
  type PipelineControl,
} from "./status";

export function PipelineBoard({
  workbenchPipelineId,
  isNew = false,
  editing: editingProp,
  onEditingChange,
}: {
  workbenchPipelineId?: number;
  isNew?: boolean;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
} = {}) {
  const router = useRouter();
  const workbench = workbenchPipelineId !== undefined || isNew;

  useEffect(() => {
    if (workbenchPipelineId !== undefined) {
      setPipelineId(workbenchPipelineId);
      appliedPipelineId.current = null;
    }
  }, [workbenchPipelineId]);
  const console_ = useAgentConsole();
  const toast = useToast();
  const dialogs = useDialogs();
  const params = useSearchParams();
  const models = useModelSelection(console_.providers);
  const { selected: preferredProvider } = usePreferredProvider(console_.providers);
  const { workspaceId, status: workspaceStatus } = useWorkspace();

  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [runs, setRuns] = useState<PipelineRunDetail[]>([]);
  const [view, setView] = useState<PipelineFlowchartView | null>(null);
  const [viewSuiteId, setViewSuiteId] = useState<number | null>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  /** The item shown in the side panel. Deep links seed it with ?prompt=. */
  const [selectedId, setSelectedId] = useState<number | null>(() => positiveInt(params.get("prompt")));
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMode, setPanelMode] = useState<"item" | "pipeline">(() => (positiveInt(params.get("prompt")) !== null ? "item" : "pipeline"));
  const [studio, setStudio] = useState<StudioSection | null>(() => STUDIO_SECTIONS.find((entry) => entry.id === params.get("studio"))?.id ?? null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [itemTab, setItemTab] = useState<StationTab>(() => (params.get("tab") === "conversation" ? "conversation" : "overview"));
  const [allocationPromptId, setAllocationPromptId] = useState<number | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [layout, setLayout] = useState<BoardLayout>(() => (params.get("view") === "list" ? "list" : "flow"));
  const [filter, setFilter] = useState<WorkFilter>(() => {
    const value = params.get("filter");
    return value === "attention" || value === "working" ? value : "all";
  });
  const [focusRecordId, setFocusRecordId] = useState<number | null>(null);
  const [guideStep, setGuideStep] = useState<NewPipelineGuideStep>("name");
  const [guideDismissed, setGuideDismissed] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [expandedPrograms, setExpandedPrograms] = useState<Set<number>>(new Set());
  const [railQuery, setRailQuery] = useState("");
  /** Drill-down into the sub-steps a station spawned: station id first, deepest last. */
  const [subPath, setSubPath] = useState<number[]>([]);

  const [pipelineId, setPipelineId] = useState<number | null>(() => {
    if (workbenchPipelineId !== undefined) return workbenchPipelineId;
    const value = Number(params.get("pipeline"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [editingInternal, setEditingInternal] = useState(isNew);
  const editing = editingProp ?? editingInternal;
  const setEditing = onEditingChange ?? setEditingInternal;
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
  const currentWorkspaceId = useRef<number | null>(workspaceId);
  currentWorkspaceId.current = workspaceId;
  const [catalogWorkspaceId, setCatalogWorkspaceId] = useState<number | null>(null);

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
    if (currentWorkspaceId.current !== target) return target;
    setTree(nextTree);
    setSnapshot(operations);
    setPipelines(named);
    setCatalogWorkspaceId(target);
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

  const pipeline = catalogWorkspaceId === workspaceId
    ? pipelines.find((item) => item.id === pipelineId && item.workspaceId === workspaceId) ?? null
    : null;
  const live = pipeline?.active ?? pipeline?.latest ?? null;

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
    const providers = saved?.agentProviders ?? [];
    return [
      {
        suiteId: id,
        programName: home?.program.name ?? ops?.programName ?? saved?.programName ?? "Program",
        programKey: home?.program.externalKey ?? ops?.programKey ?? saved?.programKey ?? null,
        suiteName: home?.suite.name ?? ops?.name ?? saved?.suiteName ?? "Suite",
        suiteKey: home?.suite.externalKey ?? ops?.key ?? saved?.suiteKey ?? null,
        promptCount: home?.suite.prompts.length ?? ops?.prompts.length ?? saved?.promptCount ?? 0,
        stepCount: saved?.stepCount ?? 0,
        operations: ops,
        providers,
      },
    ];
  });

  const activeSuiteId = stages.some((stage) => stage.suiteId === suiteId)
    ? suiteId
    : stages.some((stage) => stage.suiteId === live?.currentSuiteId)
      ? (live?.currentSuiteId ?? null)
      : (stages[0]?.suiteId ?? null);

  const showEditor = isNew || editing;

  /*
   * Unsaved edits survive leaving the editor by any route the leave dialog
   * cannot intercept (browser back/forward, a workspace switch, a crashed tab):
   * they are kept per pipeline in session storage and offered back on return.
   */
  const draftKey = workspaceId === null ? null : `agent-console.pipeline-draft:${workspaceId}:${pipelineId ?? "new"}`;
  const [recovered, setRecovered] = useState<{ name: string; suiteIds: number[] } | null>(null);
  const recoveryChecked = useRef<string | null>(null);
  const recoveryPending = useRef(false);
  useEffect(() => {
    // Check once the saved pipeline (or, for a new one, the catalog) is applied to the draft.
    const ready = pipelineId === null ? tree !== null : pipeline !== null && appliedPipelineId.current === pipelineId;
    if (!ready || draftKey === null || recoveryChecked.current === draftKey) return;
    recoveryChecked.current = draftKey;
    try {
      const stored = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as { name?: unknown; suiteIds?: unknown } | null;
      if (stored !== null && typeof stored.name === "string" && Array.isArray(stored.suiteIds) && stored.suiteIds.every((id) => Number.isSafeInteger(id))) {
        recoveryPending.current = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- session storage is read after the pipeline loads
        setRecovered({ name: stored.name, suiteIds: stored.suiteIds as number[] });
      }
    } catch { /* recovery is best-effort */ }
  }, [draftKey, pipelineId, tree, pipeline, draftName, draftSuiteIds]);
  useEffect(() => {
    if (draftKey === null || recoveryChecked.current !== draftKey || recoveryPending.current) return;
    try {
      if (showEditor && dirty) sessionStorage.setItem(draftKey, JSON.stringify({ name: draftName, suiteIds: draftSuiteIds }));
      else if (!dirty) sessionStorage.removeItem(draftKey);
    } catch { /* recovery is best-effort */ }
  }, [draftKey, showEditor, dirty, draftName, draftSuiteIds, recovered]);
  const discardStoredDraft = () => {
    recoveryPending.current = false;
    setRecovered(null);
    try { if (draftKey !== null) sessionStorage.removeItem(draftKey); } catch { /* best-effort */ }
  };

  useEffect(() => {
    if (activeSuiteId === null || pipelineId === null) {
      setView(null);
      setViewSuiteId(null);
      return;
    }
    const requestedSuite = activeSuiteId;
    const requestedPipeline = pipelineId;
    // Keep the current flowchart mounted while a same-suite refresh is in
    // flight. Clearing it here unmounted the station inspector on every rule
    // save (the WebSocket revision triggers this effect), which also destroyed
    // transient controls such as an open model picker. `viewSuiteId` already
    // prevents a previous suite's data from rendering after navigation.
    let disposed = false;
    void workspaceApi
      .pipelineFlowchart(SERVER_URL, requestedPipeline, requestedSuite, showEditor)
      .then((next) => {
        if (!disposed && requestedSuite === activeSuiteId && requestedPipeline === pipelineId) {
          setView(next);
          setViewSuiteId(requestedSuite);
        }
      })
      .catch(() => {
        if (!disposed) {
          setView(null);
          setViewSuiteId(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeSuiteId, pipelineId, showEditor, console_.operationsRevision]);

  const refreshFlowchart = useCallback(
    async (targetSuiteId: number) => {
      if (pipelineId === null) return;
      const next = await workspaceApi.pipelineFlowchart(SERVER_URL, pipelineId, targetSuiteId, showEditor);
      setView(next);
      setViewSuiteId(targetSuiteId);
    },
    [pipelineId, showEditor],
  );

  useEffect(() => {
    if (workbench) return;
    const next = new URLSearchParams();
    if (workspaceId !== null) next.set("workspace", String(workspaceId));
    if (pipeline !== null) next.set("pipeline", String(pipeline.id));
    if (catalogWorkspaceId === workspaceId && activeSuiteId !== null) next.set("suite", String(activeSuiteId));
    const query = next.toString();
    window.history.replaceState(window.history.state, "", query === "" ? "/pipeline" : `/pipeline?${query}`);
  }, [workbench, workspaceId, pipeline, catalogWorkspaceId, activeSuiteId]);

  const occupancy =
    workspaceId === null
      ? null
      : (console_.runs.find((run) => run.workspace.id === workspaceId && run.role === "execute") ?? null);
  const resumable = pipeline?.active != null;

  const suiteOps = activeSuiteId === null ? null : (operationsById.get(activeSuiteId) ?? null);
  const resumeSuiteOps = live?.currentSuiteId === null || live?.currentSuiteId === undefined ? null : (operationsById.get(live.currentSuiteId) ?? null);
  const resumeSuiteRun = resumeSuiteOps?.pipeline?.active ?? resumeSuiteOps?.pipeline?.latest ?? null;
  const findPromptDeep = (items: OperationsPrompt[], promptId: number): OperationsPrompt | null => {
    for (const item of items) {
      if (item.prompt.id === promptId) return item;
      const child = findPromptDeep(item.children, promptId);
      if (child !== null) return child;
    }
    return null;
  };
  const resumeItem = resumeSuiteRun?.currentPromptId == null
    ? null
    : findPromptDeep(resumeSuiteOps?.prompts ?? [], resumeSuiteRun.currentPromptId);
  const steps = useMemo(() => (viewSuiteId === activeSuiteId ? (view?.steps ?? []) : []), [view, viewSuiteId, activeSuiteId]);
  const byId = new Map((suiteOps?.prompts ?? []).map((item) => [item.prompt.id, item]));
  const flowSteps = steps.filter((step) => {
    if (!byId.has(step.promptId)) return false;
    if (!hideCompleted) return true;
    const item = byId.get(step.promptId);
    return item?.operationalState !== "DONE" && item?.operationalState !== "SKIPPED";
  });
  const displayedSteps = flowSteps;

  // Every prompt of the selected suite, stations and descendants alike, so a
  // drill-down can address a node at any depth by id.
  const promptsByIdDeep = useMemo(() => {
    const map = new Map<number, OperationsPrompt>();
    const walk = (list: OperationsPrompt[]): void => {
      for (const entry of list) {
        map.set(entry.prompt.id, entry);
        walk(entry.children);
      }
    };
    walk(suiteOps?.prompts ?? []);
    return map;
  }, [suiteOps]);

  const subStepRules = useMemo(() => {
    const map = new Map<number, PipelineSubStepRule>();
    if (viewSuiteId === activeSuiteId) for (const entry of view?.subSteps ?? []) map.set(entry.promptId, entry);
    return map;
  }, [view, viewSuiteId, activeSuiteId]);

  const subRuleFor = useCallback(
    (promptId: number): SubStepRuleView => {
      const entry = subStepRules.get(promptId);
      if (entry !== undefined) return { rule: entry.rule, inherited: entry.inherited };
      // The flowchart has not landed yet — fall back to the parent's own rule
      // so the card still says something truthful while it loads.
      const node = promptsByIdDeep.get(promptId) ?? null;
      const parentId = node?.prompt.parentPromptId ?? null;
      const fallback = (parentId === null ? null : promptsByIdDeep.get(parentId)?.pipelineRule) ?? node?.pipelineRule ?? null;
      return {
        rule: fallback === null ? defaultPromptPipelineRule(promptId) : { ...fallback, promptId },
        inherited: true,
      };
    },
    [subStepRules, promptsByIdDeep],
  );

  // A drill-down only means anything inside the suite it was opened from.
  const openSubNode = subPath.length === 0 ? null : (promptsByIdDeep.get(subPath[subPath.length - 1]!) ?? null);
  const subTrail: SubTrailEntry[] =
    openSubNode === null
      ? []
      : subPath.flatMap((promptId) => {
          const node = promptsByIdDeep.get(promptId);
          return node === undefined ? [] : [{ promptId, label: node.prompt.externalKey ?? node.prompt.title }];
        });

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

  // Mirror the scheduler's depth-first walk. The suite run may still point at
  // a parent that ran earlier even though its next unstarted child is the item
  // a fresh run will actually launch.
  const stuckSuiteId = (resumeSuiteOps ?? suiteOps)?.id ?? null;
  const pendingPrompt = useMemo(() => {
    const suite = resumeSuiteOps ?? suiteOps;
    if (suite === null) return null;
    return nextPipelineLeaf(suite.prompts);
  }, [resumeSuiteOps, suiteOps]);
  // `recoverable` is broader than the RECOVERY_NEEDED label — it also covers a
  // run that ended UNREPORTED or FAILED, which display under their own status
  // but hold up the pipeline (and the scheduler's own play-blocked check) the
  // same way a crashed run does.
  const stuckPrompt = pendingPrompt !== null && (pendingPrompt.operationalState === "BLOCKED" || pendingPrompt.prompt.recoverable)
    ? pendingPrompt
    : null;

  const playBlocked = useMemo(() => {
    if (console_.connection !== "open") return "the backend is disconnected";
    if (pipelineId === null) return "this pipeline is not saved yet";
    if (draftSuiteIds.length === 0) return "it has no suites";
    if (dirty) return "there are unsaved changes";
    if (stages.some((stage) => stage.stepCount === 0)) return "every suite needs at least one step";
    if (resumeItem?.humanIntervention?.status === "PENDING") return "an approval point is waiting on you";
    if (occupancy !== null && live?.state === "PLAYING" && live.currentSuiteRunId !== occupancy.runId) {
      return `${occupancy.provider} is already writing this workspace`;
    }
    if (stuckPrompt?.operationalState === "BLOCKED") {
      const label = stuckPrompt.prompt.externalKey ?? stuckPrompt.prompt.title;
      return `${label} is blocked and needs a human response first`;
    }
    // Surfaced here too, not just as a failed Play attempt: without this the
    // operator's only sign of trouble was a toast after Play round-tripped to
    // the backend and back, with nothing left to click.
    if (stuckPrompt?.prompt.recoverable === true) {
      const label = stuckPrompt.prompt.externalKey ?? stuckPrompt.prompt.title;
      return `${label} needs recovery — its last run stopped without posting a status`;
    }
    return null;
  }, [console_.connection, pipelineId, draftSuiteIds.length, dirty, stages, occupancy, live, resumeItem, stuckPrompt]);

  // Where the live run actually sits: stage → station → deepest sub-step.
  const runPosition = useMemo<PipelinePosition | null>(() => {
    if (live === null || pipeline === null) return null;
    const stageCount = pipeline.stages.length;
    const stageIndex = live.currentSuiteId === null ? 0 : pipeline.stages.findIndex((stage) => stage.suiteId === live.currentSuiteId) + 1;
    const stageName = pipeline.stages.find((stage) => stage.suiteId === live.currentSuiteId)?.suiteKey
      ?? pipeline.stages.find((stage) => stage.suiteId === live.currentSuiteId)?.suiteName
      ?? null;
    const flat = new Map<number, OperationsPrompt>();
    const walk = (list: OperationsPrompt[]): void => {
      for (const entry of list) {
        flat.set(entry.prompt.id, entry);
        walk(entry.children);
      }
    };
    walk(resumeSuiteOps?.prompts ?? []);
    const currentId = resumeSuiteRun?.currentPromptId ?? null;
    const current = currentId === null ? null : (flat.get(currentId) ?? null);
    let station = current;
    while (station !== null && station.prompt.parentPromptId !== null) {
      station = flat.get(station.prompt.parentPromptId) ?? null;
    }
    const label = (entry: OperationsPrompt | null) => (entry === null ? null : entry.prompt.externalKey ?? entry.prompt.title);
    const subLabel = current !== null && current !== station ? label(current) : null;
    return {
      stageIndex,
      stageCount,
      stageName,
      stationLabel: label(station),
      subStepLabel: subLabel,
      provider: occupancy?.provider ?? null,
    };
  }, [live, pipeline, resumeSuiteOps, resumeSuiteRun, occupancy]);

  // The selected item is also the one whose step settings the Config tab edits.
  const configId = selectedId;
  const configNode = configId === null ? null : (promptsByIdDeep.get(configId) ?? null);
  const configIsSubStep = configNode !== null && configNode.prompt.parentPromptId !== null;
  const configRule = configId === null
    ? null
    : configIsSubStep
      ? subRuleFor(configId).rule
      : (steps.find((step) => step.promptId === configId) ?? null);
  const configInherited = configId !== null && configIsSubStep && subRuleFor(configId).inherited;

  // Prefer the deepest stuck descendant: a station whose sub-step lost its agent
  // is the item that actually needs recovering, and it never appears in the
  // top-level station list.
  const stationState = stuckPrompt?.operationalState ?? resumeItem?.operationalState ?? null;
  // Resolved server-side from the Pipeline policy settings; the built-in
  // defaults stand in for the moment before the first snapshot arrives.
  const policy = snapshot?.policy ?? DEFAULT_PIPELINE_POLICY;

  const status = pipelineStatus({
    run: live,
    policy,
    stationState,
    station: runPosition?.subStepLabel ?? runPosition?.stationLabel ?? null,
    awaitingHuman: resumeItem?.humanIntervention?.status === "PENDING",
    agentActive: live?.state === "PAUSED" && occupancy !== null,
  });
  const statusBlocked = status.primary === "pause" || status.primary === "stop" ? null : playBlocked;

  // An operation that returns a sentence did not do what its button promised;
  // the sentence is shown in place of the success toast, after the refresh so
  // the board already shows the state it describes.
  const act = async (operation: () => Promise<string | void>, success?: string) => {
    setBusy(true);
    try {
      const shortfall = await operation();
      await refreshCatalog();
      if (pipelineId !== null) {
        const items = await workspaceApi.pipelineRuns(SERVER_URL, pipelineId);
        setRuns(items);
      }
      if (typeof shortfall === "string") toast.error("The pipeline did not start", shortfall);
      else if (success !== undefined) toast.success(success);
    } catch (error) {
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // A direct way to clear the blocker without hunting for it: the stuck item
  // is often a sub-step several drill-downs below the station list.
  const recoveryActions = stuckPrompt === null || stuckSuiteId === null ? null : {
    onRetry:
      stuckPrompt.prompt.recoverable
        ? () =>
            void act(async () => {
              await workspaceApi.recover(SERVER_URL, stuckPrompt.prompt.id);
            }, "Recovered — play to run it again")
        : undefined,
    onSkip: () =>
      void act(async () => {
        const confirmed = await dialogs.confirm({
          title: "Skip this step?",
          description: "The pipeline moves straight to the next step. Skipped work is not retried.",
          confirmLabel: "Skip step",
          tone: "danger",
        });
        if (!confirmed) return;
        await workspaceApi.skipPrompt(SERVER_URL, stuckPrompt.prompt.id, "Operator skipped this step.");
      }, "Step skipped"),
    onOpen: () => {
      if (stuckSuiteId !== activeSuiteId) setSuiteId(stuckSuiteId);
      if (stuckPrompt.operationalState === "BLOCKED") openConversation(stuckPrompt.prompt.id);
      else selectItem(stuckPrompt.prompt.id, "overview");
    },
    label: stuckPrompt.prompt.externalKey ?? stuckPrompt.prompt.title,
  };

  /**
   * Every transport button funnels through here, so the header, the status bar
   * and the state machine in `pipelineStatus` can never disagree about which
   * action a state actually allows.
   */
  const runControl = (control: PipelineControl) => {
    if (pipelineId === null) return;
    if (control === "pause") {
      void act(async () => {
        await workspaceApi.pausePipeline(SERVER_URL, pipelineId);
      }, "Pausing — the current agent will finish, then the rail holds.");
      return;
    }
    if (control === "stop") {
      void act(async () => {
        const confirmed = await dialogs.confirm({
          title: "Stop this pipeline?",
          description: "Auto-advance ends and the run closes. The agent working right now, if any, is interrupted. Finished work is kept — a new run picks up from the first unfinished station.",
          confirmLabel: "Stop pipeline",
          tone: "danger",
        });
        if (!confirmed) return;
        await workspaceApi.stopPipeline(SERVER_URL, pipelineId);
      }, "Pipeline stopped");
      return;
    }
    // Resume resumes: the continuation loop carries prior-run notes itself, so
    // there is no handoff dialog between the operator and the next station start.
    void act(async () => {
      const run = await workspaceApi.playPipeline(SERVER_URL, pipelineId);
      // Play answers 200 even when the station could not be started and the
      // run parked again on the way in. Announcing "running" over that is the
      // Resume button that says it resumed and then does nothing.
      if (run.state === "WAITING_HUMAN") {
        return describeStopReason(run.waitReason) ?? "It parked again before any agent started.";
      }
    }, control === "newRun" ? "New run started" : "Pipeline is running");
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
    setCatalogWorkspaceId(null);
    setTree(null);
    setSnapshot(null);
    setPipelines([]);
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
    if (isNew) router.replace(`/pipeline/${saved.id}?edit=1`);
    try {
      setRuns(await workspaceApi.pipelineRuns(SERVER_URL, saved.id));
    } catch {
      setRuns([]);
    }
    return saved;
  };

  /* ---------------------------------------------------------------------- */
  /* Selection and the side panel                                            */
  /* ---------------------------------------------------------------------- */

  const selectItem = (promptId: number, tab?: StationTab) => {
    setSelectedId(promptId);
    setPanelMode("item");
    setPanelOpen(true);
    if (tab !== undefined) setItemTab(tab);
  };
  const openConversation = (promptId: number) => {
    selectItem(promptId, "conversation");
    setFocusSignal((value) => value + 1);
  };
  /** Step settings: select the step, then open its section of the studio. */
  const configureItem = (promptId: number) => {
    selectItem(promptId);
    setStudio("step");
  };
  /** A suite's pencil: point the board at it, then open its agents in the studio. */
  const editSuite = (id: number) => {
    setSuiteId(id);
    setSubPath([]);
    setStudio("agents");
  };
  /** Chips and links name a concern; the studio holds every concern. */
  const openPipelinePanel = (tab: InspectorTab) => {
    if (tab === "station") {
      const target = resumeItem ?? stuckPrompt;
      if (target !== null) configureItem(target.prompt.id);
      return;
    }
    setStudio(tab);
  };
  const closePanel = () => {
    setPanelOpen(false);
    setSelectedId(null);
    setPanelMode("pipeline");
  };

  const stationActions = useStationActions({
    pipelineId,
    pipelineState: live?.state ?? null,
    onAllocationRequired: (promptId) => setAllocationPromptId(resumeItem?.prompt.id ?? promptId),
    refresh: async () => {
      await refreshCatalog();
      if (pipelineId !== null) setRuns(await workspaceApi.pipelineRuns(SERVER_URL, pipelineId));
      if (activeSuiteId !== null) await refreshFlowchart(activeSuiteId);
    },
  });
  const anyBusy = busy || stationActions.busy;

  const selectedItem = selectedId === null ? null : (promptsByIdDeep.get(selectedId) ?? null);
  const selectedParent =
    selectedItem?.prompt.parentPromptId == null ? null : (promptsByIdDeep.get(selectedItem.prompt.parentPromptId) ?? null);

  // Agent assignments need the saved flowchart of the suite on screen.
  const agentsReady = pipeline !== null && activeSuiteId !== null && viewSuiteId === activeSuiteId && view !== null
    && pipeline.stages.some((stage) => stage.suiteId === activeSuiteId);
  const overrideCount = view === null ? 0 : view.steps.filter((step) => step.provider !== null).length
    + view.subSteps.filter((step) => !step.inherited && step.rule.provider !== null).length;
  // Who runs the selected item, and where that choice comes from.
  const selectedAgent = (() => {
    if (configRule === null) return null;
    const suiteProvider = view?.defaults.defaultProvider ?? null;
    const suiteModel = view?.defaults.defaultModel ?? null;
    if (configIsSubStep) {
      if (!configInherited) return { provider: configRule.provider, model: configRule.model, source: "pinned to this sub-step" };
      return configRule.provider !== null
        ? { provider: configRule.provider, model: configRule.model, source: "follows its station" }
        : { provider: suiteProvider, model: suiteModel, source: "follows the suite agent" };
    }
    if (configRule.provider !== null) return { provider: configRule.provider, model: configRule.model, source: "step override" };
    return { provider: suiteProvider, model: suiteModel, source: "suite agent" };
  })();
  const saveFirst = "Save the pipeline first";
  const studioUnavailable: Partial<Record<StudioSection, string>> = {
    ...(pipelineId === null ? { agents: saveFirst, step: saveFirst, history: saveFirst }
      : {
          ...(!agentsReady ? { agents: activeSuiteId === null ? "Select a suite first" : "Loading this suite…" } : {}),
          ...(selectedItem === null || configRule === null ? { step: "Select a step on the board first" } : {}),
        }),
    ...(suiteOps === null ? { verification: "Select a suite first" } : {}),
    ...(activeSuiteId === null ? { definition: "Select a suite first" } : {}),
  };
  const studioBadges: Partial<Record<StudioSection, ReactNode>> = {
    ...(view?.defaults.defaultProvider ? { agents: view.defaults.defaultProvider } : {}),
    ...(selectedItem !== null && configRule !== null ? { step: selectedItem.prompt.externalKey ?? "selected" } : {}),
    ...(runs.length > 0 ? { history: runs.length } : {}),
  };

  const inboxEntries = useMemo(
    () => collectInbox(stages.flatMap((stage) => (stage.operations === null ? [] : [stage.operations]))),
    [stages],
  );

  // Items the list view shows: the flowchart's stations (with their sub-steps)
  // on a saved pipeline; the whole suite while composing a draft.
  const listItems = useMemo(() => {
    const prompts = suiteOps?.prompts ?? [];
    if (pipelineId === null || viewSuiteId !== activeSuiteId) return prompts;
    const order = new Map(steps.map((step, index) => [step.promptId, index]));
    return prompts
      .filter((item) => order.has(item.prompt.id))
      .sort((a, b) => (order.get(a.prompt.id) ?? 0) - (order.get(b.prompt.id) ?? 0));
  }, [suiteOps, pipelineId, viewSuiteId, activeSuiteId, steps]);

  // j / k walk the items in the order they are drawn.
  const navOrder = useMemo(() => {
    if (openSubNode !== null) return openSubNode.children.map((item) => item.prompt.id);
    if (layout === "list") {
      const ids: number[] = [];
      const walk = (list: OperationsPrompt[]) => {
        for (const item of list) {
          ids.push(item.prompt.id);
          walk(item.children);
        }
      };
      walk(filterPromptTree(listItems, filter));
      return ids;
    }
    return displayedSteps.map((step) => step.promptId);
  }, [openSubNode, layout, listItems, filter, displayedSteps]);

  // Remember the layout per pipeline, unless the link asked for one.
  const layoutKey = `agent-console.pipeline-layout.${pipelineId ?? "draft"}`;
  useEffect(() => {
    if (params.get("view") !== null) return;
    try {
      const saved = window.localStorage.getItem(layoutKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is unavailable during SSR
      if (saved === "list" || saved === "flow") setLayout(saved);
    } catch {
      // Storage is a convenience only.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per pipeline
  }, [layoutKey]);
  const changeLayout = (next: BoardLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(layoutKey, next);
    } catch {
      // Storage is a convenience only.
    }
  };

  // Below xl the panel is a sheet over the board; start it closed there.
  useEffect(() => {
    if (positiveInt(params.get("prompt")) !== null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- viewport is unknown during SSR
    if (!window.matchMedia("(min-width: 1280px)").matches) setPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first paint only
  }, []);

  // Keep the address bar shareable without driving state from it.
  useEffect(() => {
    if (!workbench || pipelineId === null) return;
    const next = new URLSearchParams();
    if (editing) next.set("edit", "1");
    if (activeSuiteId !== null) next.set("suite", String(activeSuiteId));
    if (selectedId !== null && panelMode === "item") next.set("prompt", String(selectedId));
    if (layout === "list") next.set("view", "list");
    if (layout === "list" && filter !== "all") next.set("filter", filter);
    if (studio !== null) next.set("studio", studio);
    const query = next.toString();
    window.history.replaceState(window.history.state, "", `/pipeline/${pipelineId}${query === "" ? "" : `?${query}`}`);
  }, [workbench, pipelineId, editing, activeSuiteId, selectedId, panelMode, layout, filter, studio]);

  // ⌘K / Ctrl+K / "/" find anything; "," opens the studio. Typing is left alone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]') !== null) return;
      if (event.key === "/") { event.preventDefault(); setPaletteOpen(true); }
      else if (event.key === ",") { event.preventDefault(); setStudio((current) => current ?? (selectedId !== null ? "step" : "agents")); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  useBoardKeys({
    order: navOrder,
    selectedId,
    panelOpen,
    select: (promptId) => selectItem(promptId),
    reply: openConversation,
    closePanel,
    toggleRun: () => {
      if (status.primary === null || anyBusy || statusBlocked !== null) return;
      runControl(status.primary);
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Header                                                                  */
  /* ---------------------------------------------------------------------- */

  const deletePipeline = () =>
    void act(async () => {
      if (pipelineId === null) return;
      const confirmed = await dialogs.confirm({
        title: `Delete ${draftName}?`,
        description: "Past runs of this pipeline are removed with it.",
        confirmLabel: "Delete",
        tone: "danger",
        confirmPhrase: draftName,
      });
      if (!confirmed) return;
      await workspaceApi.removePipeline(SERVER_URL, pipelineId);
      router.push("/pipeline");
    }, "Pipeline deleted");

  const savePipeline = () => {
    if (pipelineId !== null) {
      void act(async () => {
        await persist(draftName);
      }, "Pipeline changes saved");
      return;
    }
    setSaveName(draftName === "Untitled pipeline" ? "" : draftName);
    setSaveOpen(true);
  };

  const headerMenu: MenuItem[] = [
    // The layout switch is hidden on phones; it lives here there.
    { id: "layout", label: layout === "flow" ? "Show as list" : "Show as flow", onSelect: () => changeLayout(layout === "flow" ? "list" : "flow"), className: "sm:hidden" },
    { id: "find", label: "Find anything…  ⌘K", onSelect: () => setPaletteOpen(true) },
    { id: "agents", label: "Assign agents", onSelect: () => setStudio("agents") },
    { id: "configure", label: "Run rules & budgets", onSelect: () => setStudio("policy") },
    { id: "history", label: "Run history", onSelect: () => setStudio("history") },
    {
      id: "verify",
      label: "Verify suite with agent…",
      disabled: suiteOps === null || anyBusy,
      onSelect: () => {
        if (suiteOps === null) return;
        void stationActions.verify(suiteOps, null).then((started) => {
          if (started) setStudio("verification");
        });
      },
      separated: true,
    },
    {
      id: "audit",
      label: "Audit recorded evidence…",
      disabled: suiteOps === null || anyBusy,
      onSelect: () => {
        if (suiteOps === null) return;
        void stationActions.auditEvidence(suiteOps).then((id) => {
          if (id === null) return;
          setFocusRecordId(id);
          setStudio("verification");
        });
      },
    },
    {
      id: "save",
      label: pipelineId === null ? "Save pipeline…" : "Save changes",
      disabled: anyBusy || !dirty || draftName.trim() === "",
      onSelect: savePipeline,
      separated: true,
    },
    {
      id: "chat",
      label: "Open workspace in Chat",
      disabled: workspaceId === null,
      onSelect: () => router.push(`/?workspace=${workspaceId}`),
    },
    ...(pipelineId === null
      ? []
      : [{ id: "delete", label: "Delete pipeline…", onSelect: deletePipeline, disabled: anyBusy || resumable, title: resumable ? "Stop the pipeline before deleting it" : undefined, tone: "danger" as const, separated: true }]),
  ];

  /* Everything the palette can find: actions, studio sections, suites, steps. */
  const buildPaletteEntries = (): PaletteEntry[] => {
    const entries: PaletteEntry[] = [];
    const busyReason = anyBusy ? "Busy — wait for the current action" : undefined;
    if (pipelineId !== null) {
      for (const control of [status.primary, ...status.secondary]) {
        if (control === null) continue;
        entries.push({
          id: `control-${control}`, group: "Actions", label: CONTROL_LABEL[control], keywords: "run play resume start pause stop transport",
          hint: status.headline, trailing: control === status.primary ? <kbd>Space</kbd> : undefined,
          disabled: busyReason ?? (control === status.primary && statusBlocked !== null ? statusBlocked : undefined),
          run: () => runControl(control),
        });
      }
    }
    for (const entry of inboxEntries) {
      entries.push({
        id: `inbox-${entry.item.prompt.id}`, group: "Needs you", label: `${entry.item.prompt.externalKey ?? entry.item.prompt.title}`,
        hint: entry.ask, keywords: "needs you waiting reply blocked inbox", icon: <span className="text-warning">◆</span>,
        run: () => { if (entry.suite.id !== activeSuiteId) setSuiteId(entry.suite.id); setSubPath([]); openConversation(entry.item.prompt.id); },
      });
    }
    entries.push(
      { id: "verify", group: "Actions", label: "Verify suite with agent", hint: suiteOps?.name, keywords: "check verification", icon: STUDIO_ICONS.verification,
        disabled: suiteOps === null ? "Select a suite first" : busyReason,
        run: () => { if (suiteOps !== null) void stationActions.verify(suiteOps, null).then((started) => { if (started) setStudio("verification"); }); } },
      { id: "audit", group: "Actions", label: "Audit recorded evidence", hint: suiteOps?.name, keywords: "evidence check", icon: STUDIO_ICONS.verification,
        disabled: suiteOps === null ? "Select a suite first" : busyReason,
        run: () => { if (suiteOps !== null) void stationActions.auditEvidence(suiteOps).then((id) => { if (id !== null) { setFocusRecordId(id); setStudio("verification"); } }); } },
      { id: "edit", group: "Actions", label: showEditor ? "Finish editing" : "Edit pipeline", keywords: "compose add remove reorder suites steps", run: () => setEditing(!showEditor), disabled: pipelineId === null ? saveFirst : undefined },
      { id: "save", group: "Actions", label: pipelineId === null ? "Save pipeline" : "Save changes", disabled: !dirty ? "No unsaved changes" : busyReason, run: savePipeline },
      { id: "layout", group: "Actions", label: layout === "flow" ? "Show as list" : "Show as flow", keywords: "layout view board", run: () => changeLayout(layout === "flow" ? "list" : "flow") },
      ...(layout === "flow" && pipelineId !== null ? [{ id: "completed", group: "Actions", label: hideCompleted ? "Show completed steps" : "Hide completed steps", keywords: "filter done", run: () => setHideCompleted((value) => !value) }] : []),
      { id: "details", group: "Actions", label: "Show pipeline details", hint: "Right now, recent runs and the studio launcher", keywords: "panel drawer overview", run: () => { setPanelMode("pipeline"); setPanelOpen(true); } },
      { id: "chat", group: "Actions", label: "Open workspace in Chat", disabled: workspaceId === null ? "Choose a workspace first" : undefined, run: () => router.push(`/?workspace=${workspaceId}`) },
      ...(pipelineId === null ? [] : [{ id: "delete", group: "Actions", label: "Delete pipeline…", keywords: "remove", disabled: resumable ? "Stop the pipeline before deleting it" : busyReason, run: deletePipeline }]),
    );
    for (const section of STUDIO_SECTIONS) {
      entries.push({ id: `studio-${section.id}`, group: "Studio", label: section.label, hint: section.blurb, keywords: `settings configure ${section.keywords}`,
        icon: STUDIO_ICONS[section.id], disabled: studioUnavailable[section.id], run: () => setStudio(section.id) });
    }
    for (const stage of stages) {
      entries.push({ id: `suite-${stage.suiteId}`, group: "Suites", label: `${stage.suiteKey !== null ? `${stage.suiteKey} · ` : ""}${stage.suiteName}`,
        hint: `${stage.programName} · ${stage.stepCount} steps`, keywords: "suite stage",
        trailing: stage.suiteId === live?.currentSuiteId ? <span className="text-info">running</span> : undefined,
        run: () => { setSuiteId(stage.suiteId); setSubPath([]); } });
    }
    const walk = (suiteId: number, suiteName: string, list: OperationsPrompt[]) => {
      for (const item of list) {
        entries.push({ id: `step-${item.prompt.id}`, group: "Steps", label: `${item.prompt.externalKey !== null ? `${item.prompt.externalKey} · ` : ""}${item.prompt.title}`,
          hint: `${suiteName}${item.prompt.parentPromptId !== null ? " · sub-step" : ""}`, keywords: "step prompt station item",
          trailing: <span className="text-fg-dim">{LABEL[item.operationalState]}</span>,
          run: () => { if (suiteId !== activeSuiteId) setSuiteId(suiteId); setSubPath([]); selectItem(item.prompt.id, "overview"); } });
        walk(suiteId, suiteName, item.children);
      }
    };
    for (const stage of stages) if (stage.operations !== null) walk(stage.suiteId, stage.suiteKey ?? stage.suiteName, stage.operations.prompts);
    for (const other of pipelines) {
      if (other.id === pipelineId) continue;
      entries.push({ id: `pipeline-${other.id}`, group: "Pipelines", label: other.name, keywords: "pipeline open switch", run: () => router.push(`/pipeline/${other.id}`) });
    }
    return entries;
  };

  const editButton =
    pipelineId === null ? (
      <Button size="sm" variant="primary" disabled={anyBusy || draftName.trim() === ""} onClick={savePipeline}>
        Save pipeline
      </Button>
    ) : (
      <Button
        size="sm"
        variant={showEditor ? "primary" : "secondary"}
        disabled={anyBusy || (showEditor && draftName.trim() === "")}
        onClick={() => {
          if (!showEditor) {
            setEditing(true);
            return;
          }
          if (!dirty) {
            setEditing(false);
            return;
          }
          void act(async () => {
            await persist(draftName);
            setEditing(false);
          }, "Pipeline changes saved");
        }}
      >
        {showEditor ? (dirty ? "Save & finish" : "Done") : "Edit"}
      </Button>
    );

  const stationCount = stages.reduce((sum, stage) => sum + stage.stepCount, 0);

  return (
    <div className="flex h-full min-h-0 flex-col text-fg">
      <ContentTitle
        title={draftName}
        titleEditor={
          showEditor ? (
            <input
              type="text"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={200}
              aria-label="Pipeline name"
              className="content-title-input"
            />
          ) : undefined
        }
        meta={
          <>
            Pipeline · {tree?.name ?? "Choose a workspace"} · {stages.length} suite{stages.length === 1 ? "" : "s"} · {stationCount} step{stationCount === 1 ? "" : "s"}
            {dirty ? <span className="text-caution"> · unsaved changes</span> : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="board-find" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K /">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              <span>Find anything</span>
              <kbd aria-hidden>⌘K</kbd>
            </button>
            <CrewStrip crew={crew} />
            <LayoutToggle value={layout} onChange={changeLayout} />
            <Button size="sm" variant="secondary" onClick={() => setStudio(selectedItem !== null && panelMode === "item" ? "step" : "agents")} title="Agents, rules, budgets, verification and history (,)">
              <span className="inline-flex items-center gap-1.5">{STUDIO_ICONS.step}Studio</span>
            </Button>
            {editButton}
            <Menu items={headerMenu} label="Pipeline actions" />
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

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]",
          "grid-cols-1",
        )}
      >
        <SidebarCollection
          label={showEditor ? "Pipeline suites" : "Pipeline"}
        >
          {workbench && <SidebarBack href="/pipeline">All pipelines</SidebarBack>}
          {showEditor && (
            <label className="mb-2 block">
              <span className="sr-only">Search suites</span>
              <input
                type="search"
                value={railQuery}
                onChange={(event) => setRailQuery(event.target.value)}
                placeholder="Search suites"
                className="app-sidebar-search"
              />
            </label>
          )}
          {!workbench && (
          <>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs uppercase tracking-[0.18em] text-fg-dim">Pipelines</div>
            <button
              type="button"
              onClick={() => selectPipeline(null)}
              className="text-xs text-accent hover:underline"
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
                "w-full rounded-md px-2.5 py-2 text-left text-sm",
                pipelineId === null ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              Draft
              {draftSuiteIds.length > 0 && (
                <span className="ml-2 text-xs text-fg-dim">{draftSuiteIds.length} suites</span>
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
                  <span className="min-w-0 truncate text-sm">{item.name}</span>
                  {badge !== null && (
                    <Badge tone={PIPELINE_TONE[badge.state]} pulse={badge.state === "PLAYING"}>
                      {PIPELINE_LABEL[badge.state]}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          </>
          )}

          {!showEditor ? (
            <SidebarGroup title={`Suites in this pipeline · ${stages.length}`}>
              {stages.length === 0 ? (
                <SidebarEmpty>No suites yet. Choose Edit to add some.</SidebarEmpty>
              ) : (
                stages.map((stage) => (
                  <SidebarRow
                    key={stage.suiteId}
                    onSelect={() => {
                      setSuiteId(stage.suiteId);
                      setSubPath([]);
                    }}
                    selected={stage.suiteId === activeSuiteId}
                    title={`${stage.suiteKey !== null ? `${stage.suiteKey} · ` : ""}${stage.suiteName}`}
                    detail={stage.programName}
                    status={stage.suiteId === live?.currentSuiteId ? "Running" : undefined}
                  />
                ))
              )}
            </SidebarGroup>
          ) : tree === null ? (
            <SidebarEmpty><span role="status">Loading programs…</span></SidebarEmpty>
          ) : programs.length === 0 ? (
            <SidebarEmpty>This workspace has no programs yet.</SidebarEmpty>
          ) : (
            <>
              <p className="app-sidebar-group">Programs · tick suites to add them</p>
              {programs.map((program) => {
                const needle = railQuery.trim().toLowerCase();
                const suites = needle === ""
                  ? program.suites
                  : program.suites.filter((suite) =>
                      `${program.name} ${program.externalKey ?? ""} ${suite.name} ${suite.externalKey ?? ""}`.toLowerCase().includes(needle),
                    );
                if (needle !== "" && suites.length === 0) return null;
                const open = needle !== "" || expandedPrograms.has(program.id);
                return (
                  <div key={program.id} className="mb-1">
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
                      className="app-sidebar-toggle-row text-fg"
                      aria-expanded={open}
                    >
                      <span aria-hidden className="text-fg-muted">{open ? "▾" : "▸"}</span>
                      <span className="min-w-0 truncate">
                        {program.externalKey !== null && <span className="text-fg-muted">{program.externalKey} · </span>}
                        {program.name}
                      </span>
                      <span className="ml-auto numeric text-fg-muted">{program.suites.length}</span>
                    </button>
                    {open && (
                      <ul className="ml-5">
                        {suites.map((suite) => {
                          const on = draftSuiteIds.includes(suite.id);
                          const ops = operationsById.get(suite.id);
                          return (
                            <li key={suite.id} className="app-sidebar-row" data-checked={on} data-selected={suite.id === activeSuiteId}>
                              <button
                                type="button"
                                onClick={() => toggleSuite(suite.id)}
                                aria-pressed={on}
                                className="app-sidebar-toggle-row text-fg-muted"
                              >
                                <span aria-hidden className="app-sidebar-check">{on ? "✓" : ""}</span>
                                <span className={cn("min-w-0 truncate", on && "text-fg")}>
                                  {suite.externalKey !== null && <span className="text-fg-muted">{suite.externalKey} · </span>}
                                  {suite.name}
                                </span>
                                {ops?.pipeline?.active != null && (
                                  <span className="ml-auto size-1.5 shrink-0 rounded-full bg-info animate-breathe" aria-label="Running in a pipeline" />
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </SidebarCollection>
        <section className="pipeline-desk min-h-0 overflow-auto">
          <div className="w-full space-y-5 px-5 pt-1 pb-10">
            {recovered !== null && (
              <div role="status" className="flex flex-wrap items-center gap-3 rounded-panel border border-caution/40 px-4 py-3 text-sm text-fg">
                <span className="min-w-0 flex-1">You left unsaved changes to this pipeline. Restore them to keep editing.</span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    recoveryPending.current = false;
                    setDraftName(recovered.name);
                    setDraftSuiteIds(recovered.suiteIds);
                    setRecovered(null);
                    setEditing(true);
                  }}
                >
                  Restore
                </Button>
                <Button size="sm" variant="ghost" onClick={discardStoredDraft}>Discard</Button>
              </div>
            )}

            {isNew && !guideDismissed && (
              <NewPipelineGuide
                step={guideStep}
                onStepChange={(next) => {
                  setGuideStep(next);
                  if (next === "policy") setStudio("policy");
                }}
                onOpenPolicy={() => setStudio("policy")}
                onFocusStations={() => setStudio("agents")}
                onDismiss={() => setGuideDismissed(true)}
              />
            )}

            {/* Run bar: what the pipeline is doing and the one control for it.
                Sticky, so the controls are always in the same place. */}
            {pipelineId !== null && (
              <div className="sticky top-0 z-20 -mx-5 bg-surface-0 px-5 pt-2 pb-2">
                <PipelineStatusBar
                  status={status}
                  position={runPosition}
                  blockedReason={statusBlocked}
                  recoveryActions={statusBlocked !== null ? recoveryActions : null}
                  busy={anyBusy}
                  onControl={runControl}
                  onExplain={() => setStudio("policy")}
                  onReviewAllocation={live?.waitReason === "execution:budget_exhausted" && resumeItem ? () => setAllocationPromptId(resumeItem.prompt.id) : undefined}
                  inbox={
                    <NeedsYouInbox
                      entries={inboxEntries}
                      onOpen={(entry) => {
                        if (entry.suite.id !== activeSuiteId) setSuiteId(entry.suite.id);
                        setSubPath([]);
                        openConversation(entry.item.prompt.id);
                      }}
                    />
                  }
                  rules={
                    <RunConfidenceStrip
                      execution={resumeItem?.execution}
                      bare
                      autoReassign={pipeline?.autoReassign ?? false}
                      policy={policy}
                      suiteFallbacks={
                        activeSuiteId === null
                          ? []
                          : (view?.defaults.defaultFallbackProviders
                            ?? suiteOps?.pipeline?.defaults.defaultFallbackProviders
                            ?? [])
                      }
                      stationFallbacks={
                        resumeItem === null
                          ? null
                          : (view?.steps.find((step) => step.promptId === resumeItem.prompt.id)?.fallbackProviders
                            ?? resumeItem.pipelineRule?.fallbackProviders
                            ?? null)
                      }
                      continuation={resumeItem?.continuation ?? null}
                      waitReason={live?.waitReason ?? null}
                      occupancyWrapUp={
                        resumeItem !== null &&
                        stationOccupancy(resumeItem, console_.runs, view?.active)?.source.type === "wrapup"
                      }
                      latestAudit={resumeItem?.latestAudit ?? null}
                      onOpenTab={openPipelinePanel}
                    />
                  }
                />
              </div>
            )}

            {(() => {
              // `/btw` to the station that is working right now. The
              // conversation continues in Chat, in a tab named after the run.
              const stationRun = live?.state === "PLAYING"
                ? console_.runs.find((run) => run.role === "execute" && run.workspace.id === workspaceId && run.source.type === "saved") ?? null
                : null;
              if (stationRun === null) return null;
              return (
                <BtwBar
                  key={stationRun.runId}
                  runId={stationRun.runId}
                  provider={stationRun.provider}
                  canInterrupt
                  trailing={
                    <Link
                      className="text-accent hover:underline"
                      href={`/?thread=${encodeURIComponent(stationRun.runId)}&workspace=${stationRun.workspace.id}`}
                    >
                      Open in Chat ›
                    </Link>
                  }
                />
              );
            })()}

            <PipelineConstellation
              stages={stages}
              selectedSuiteId={activeSuiteId}
              currentSuiteId={live?.currentSuiteId ?? null}
              pipelineState={live?.state ?? null}
              liveProviders={Object.fromEntries(crew.map((agent) => [agent.id, agent.activity])) as Partial<Record<ProviderId, AgentActivity>>}
              onSelect={(id) => {
                setSuiteId(id);
                setSubPath([]);
              }}
              onEdit={pipelineId === null ? undefined : editSuite}
            />

            {agentsReady && view !== null && pipeline !== null && (
              <AgentsSummary
                suiteName={suiteOps?.key ?? suiteOps?.name ?? "this suite"}
                provider={view.defaults.defaultProvider}
                model={view.defaults.defaultModel}
                overrides={overrideCount}
                fallbacks={view.defaults.defaultFallbackProviders}
                autoReassign={pipeline.autoReassign}
                onOpen={() => setStudio("agents")}
              />
            )}

            {suiteOps === null ? (
              <p className="text-sm text-fg-dim">
                {showEditor ? "Tick suites in the sidebar to add them to this pipeline." : "Select a suite above to see its steps."}
              </p>
            ) : openSubNode !== null ? (
              <SubPipeline
                trail={subTrail}
                items={openSubNode.children}
                parentRule={(() => {
                  const rule = subRuleFor(openSubNode.prompt.id).rule;
                  return rule.provider === null && view?.defaults.defaultProvider != null
                    ? { ...rule, provider: view.defaults.defaultProvider, model: view.defaults.defaultModel } : rule;
                })()}
                ruleFor={(id) => {
                  const entry = subRuleFor(id);
                  return entry.rule.provider === null && view?.defaults.defaultProvider != null
                    ? { ...entry, rule: { ...entry.rule, provider: view.defaults.defaultProvider, model: view.defaults.defaultModel } } : entry;
                }}
                activeRun={view?.active ?? null}
                runs={console_.runs}
                selectedId={selectedId}
                onNavigate={(index) => setSubPath((current) => (index === null ? [] : current.slice(0, index + 1)))}
                onOpen={(promptId) => setSubPath((current) => [...current, promptId])}
                onSelect={(promptId) => selectItem(promptId)}
                onConfigure={pipelineId === null ? undefined : configureItem}
                renderGate={(item) =>
                  item.humanIntervention === null ? null : (
                    <HumanGate
                      step={item.humanIntervention}
                      selected={selectedId === item.prompt.id && itemTab === "conversation"}
                      onOpen={() => openConversation(item.prompt.id)}
                    />
                  )
                }
              />
            ) : (
              <div className="space-y-4" key={activeSuiteId ?? "none"}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs uppercase tracking-[0.18em] text-fg-dim">
                      {suiteOps.programName} · {showEditor ? "compose" : layout === "list" ? "list" : "flow"}
                    </div>
                    <h3 className="mt-1 truncate text-lg text-fg">
                      {suiteOps.key !== null && <span className="text-fg-muted">{suiteOps.key} — </span>}
                      {suiteOps.name}
                    </h3>
                  </div>
                  {layout === "flow" && pipelineId !== null && (
                    <button
                      type="button"
                      onClick={() => setHideCompleted((current) => !current)}
                      className="text-xs text-accent hover:underline"
                    >
                      {hideCompleted ? "Show completed" : "Hide completed"}
                    </button>
                  )}
                </div>

                {pipelineId === null ? (
                  <p className="text-sm text-fg-dim">Save this pipeline first, then add steps to each suite.</p>
                ) : (
                  <>
                    {showEditor && view?.available.length ? (
                      <div className="rounded-panel border border-dashed border-line bg-surface-1 p-3">
                        <div className="mb-2 text-xs uppercase tracking-wider text-fg-dim">Add remaining work</div>
                        <div className="flex flex-wrap gap-2">
                          {view.available.map((prompt) => (
                            <button
                              key={prompt.id}
                              type="button"
                              disabled={anyBusy}
                              onClick={() =>
                                void act(async () => {
                                  const result = await workspaceApi.addPipelineFlowchartStep(
                                    SERVER_URL,
                                    pipelineId,
                                    suiteOps.id,
                                    { promptId: prompt.id },
                                    true,
                                  );
                                  setView(result.flowchart);
                                  setViewSuiteId(suiteOps.id);
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

                    {layout === "list" && !showEditor ? (
                      <WorkList
                        items={listItems}
                        filter={filter}
                        selectedId={selectedId}
                        currentId={view?.active?.currentPromptId ?? null}
                        onFilterChange={setFilter}
                        onSelect={(promptId) => selectItem(promptId)}
                        onConfigure={pipelineId === null ? undefined : configureItem}
                      />
                    ) : displayedSteps.length === 0 ? (
                      <div className="rounded-panel border border-dashed border-line bg-surface-1 px-6 py-12 text-center text-sm text-fg-dim">
                        {hideCompleted
                          ? "No unfinished steps. Show completed to see the rest."
                          : showEditor
                            ? "This suite has no steps on this pipeline yet. Add remaining work above."
                            : "This suite has no steps on this pipeline yet. Edit the pipeline to add some."}
                      </div>
                    ) : (
                      <SnakeFlow
                        items={displayedSteps}
                        getKey={(step) => `prompt-${step.promptId}`}
                        isLiveIndex={(index) => view?.active?.currentPromptId === displayedSteps[index]?.promptId}
                        renderGate={(step) => {
                          const gate = byId.get(step.promptId)?.humanIntervention ?? null;
                          return gate === null ? null : (
                            <HumanGate
                              step={gate}
                              selected={selectedId === step.promptId && itemTab === "conversation"}
                              onOpen={() => openConversation(step.promptId)}
                            />
                          );
                        }}
                        wrapItem={
                          showEditor
                            ? (node, step) => (
                                <div
                                  className="h-full min-w-0 w-full cursor-grab active:cursor-grabbing"
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
                                      const result = await workspaceApi.reorderPipelineFlowchartSteps(SERVER_URL, pipelineId, suiteOps.id, ids, true);
                                      setView(result.flowchart);
                                      setViewSuiteId(suiteOps.id);
                                    });
                                  }}
                                >
                                  {node}
                                </div>
                              )
                            : undefined
                        }
                        renderCard={(step, index) => {
                          const item = byId.get(step.promptId);
                          if (item === undefined) return null;
                          const doneChildren = item.children.filter(isTerminal).length;
                          return (
                            <StationCard
                              index={index}
                              item={item}
                              rule={step.provider === null && view?.defaults.defaultProvider != null
                                ? { ...step, provider: view.defaults.defaultProvider, model: view.defaults.defaultModel }
                                : step}
                              inherited={step.provider === null && view?.defaults.defaultProvider != null}
                              current={view?.active?.currentPromptId === step.promptId}
                              occupancy={stationOccupancy(item, console_.runs, view?.active)}
                              selected={selectedId === step.promptId && panelOpen && panelMode === "item"}
                              readOnly={!showEditor}
                              subSteps={item.children.length > 0 ? { done: doneChildren, total: item.children.length } : undefined}
                              onSelect={() => selectItem(step.promptId)}
                              onConfigure={() => configureItem(step.promptId)}
                              onOpenSubPipeline={item.children.length > 0 ? () => setSubPath([step.promptId]) : undefined}
                              onRemove={
                                showEditor
                                  ? () =>
                                      void act(async () => {
                                        const result = await workspaceApi.removePipelineFlowchartStep(SERVER_URL, pipelineId, suiteOps.id, step.promptId, true);
                                        setView(result.flowchart);
                                        setViewSuiteId(suiteOps.id);
                                        if (selectedId === step.promptId) closePanel();
                                      })
                                  : undefined
                              }
                            />
                          );
                        }}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            <p className="hidden pt-2 text-xs text-fg-dim xl:block">
              <Kbd>⌘K</Kbd> or <Kbd>/</Kbd> find anything · <Kbd>,</Kbd> studio · <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>r</Kbd> reply · <Kbd>Space</Kbd> play/pause · <Kbd>Esc</Kbd> close panel
            </p>
          </div>
        </section>

        {/* One side panel, two modes: the selected item, or the pipeline.
            Docked on xl; a sheet over the board below that. */}
        <DetailDrawer
          open={panelOpen}
          onClose={closePanel}
          label={panelMode === "item" ? "Item details" : "Pipeline details"}
          header={
            <div className="app-detail-tabs" role="tablist" aria-label="Details">
              <button type="button" role="tab" aria-selected={panelMode === "item"} disabled={selectedItem === null} onClick={() => setPanelMode("item")}>
                {selectedItem === null ? "Item" : (selectedItem.prompt.externalKey ?? "Item")}
              </button>
              <button type="button" role="tab" aria-selected={panelMode === "pipeline"} onClick={() => setPanelMode("pipeline")}>
                Pipeline
              </button>
            </div>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
                {panelMode === "item" && selectedItem !== null ? (
                  <StationPanel
                    key={selectedItem.prompt.id}
                    suite={suiteOps}
                    item={selectedItem}
                    parent={selectedParent}
                    statusCatalog={snapshot?.statusCatalog ?? DEFAULT_STATUS_CATALOG}
                    triggerSentences={snapshot?.triggerSentences ?? DEFAULT_TRIGGER_SENTENCES}
                    revision={`${console_.operationsRevision}:${selectedItem.lastActivityAt}:${selectedItem.operationalState}`}
                    actions={stationActions}
                    tab={itemTab}
                    onTabChange={setItemTab}
                    focusSignal={focusSignal}
                    onFocusComposer={() => openConversation(selectedItem.prompt.id)}
                    running={stationOccupancy(selectedItem, console_.runs, view?.active) !== null}
                    verifying={console_.runs.some((run) => run.source.type === "verification" && run.source.suiteId === suiteOps?.id)}
                    onSelect={(promptId) => selectItem(promptId)}
                    onOpenSubSteps={
                      selectedItem.children.length > 0
                        ? () => setSubPath(ancestorIdsForPrompt(suiteOps?.prompts ?? [], selectedItem.prompt.id).concat(selectedItem.prompt.id))
                        : undefined
                    }
                    agent={selectedAgent}
                    onConfigure={pipelineId !== null && configRule !== null ? () => setStudio("step") : undefined}
                  />
                ) : (
                  <PipelineOverviewPanel
                    saved={pipelineId !== null}
                    status={status}
                    policy={policy}
                    stationLabel={runPosition?.subStepLabel ?? runPosition?.stationLabel ?? null}
                    runs={runs}
                    selectedRunId={selectedRunId}
                    onSelectRun={setSelectedRunId}
                    onOpenStudio={setStudio}
                    onFind={() => setPaletteOpen(true)}
                    onEditStation={resumeItem === null ? undefined : () => configureItem(resumeItem.prompt.id)}
                    unavailable={studioUnavailable}
                    badges={studioBadges}
                  />
                )}
              </div>
        </DetailDrawer>
      </div>

      {!panelOpen && (
        <DetailReopen onClick={() => {
            setPanelOpen(true);
            if (selectedItem === null) setPanelMode("pipeline");
          }}>
          {inboxEntries.length > 0 ? `${inboxEntries.length} need you · details` : "Show details"}
        </DetailReopen>
      )}

      <PipelineStudio
        open={studio !== null}
        section={studio ?? "agents"}
        onSectionChange={setStudio}
        onClose={() => setStudio(null)}
        context={[draftName, suiteOps === null ? null : `${suiteOps.key !== null ? `${suiteOps.key} · ` : ""}${suiteOps.name}`, selectedItem?.prompt.externalKey ?? null].filter(Boolean).join("  ›  ")}
        unavailable={studioUnavailable}
        badges={studioBadges}
      >
        {studio === "agents" && agentsReady && view !== null && pipeline !== null && activeSuiteId !== null && (
          <AgentAssignments
            pipeline={pipeline}
            suiteName={suiteOps?.name ?? "this suite"}
            view={view}
            providers={console_.providers}
            models={models}
            policy={policy}
            busy={anyBusy}
            promptLabel={(id) => {
              const prompt = promptsByIdDeep.get(id)?.prompt;
              return prompt?.externalKey ?? prompt?.title ?? `Prompt ${id}`;
            }}
            onDefaults={(patch) => void act(async () => {
              await workspaceApi.updatePipelineDefaults(SERVER_URL, pipeline.id, activeSuiteId, patch);
              await refreshFlowchart(activeSuiteId);
            }, "Suite agent assignments saved")}
            onAutoReassign={(autoReassign) => void act(async () => {
              const updated = await workspaceApi.updatePipeline(SERVER_URL, pipeline.id, { autoReassign });
              setPipelines((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
            }, autoReassign ? "Automatic reassignment enabled" : "Automatic reassignment disabled")}
            onPrompt={(id, choice, inheritFromParent) => void act(async () => {
              if (inheritFromParent) await workspaceApi.removePipelineFlowchartStep(SERVER_URL, pipeline.id, activeSuiteId, id, showEditor);
              else await workspaceApi.patchPipelineFlowchartRule(SERVER_URL, pipeline.id, id, choice);
              await refreshFlowchart(activeSuiteId);
            }, "Prompt agent saved")}
            onConfigure={configureItem}
          />
        )}
        {studio === "step" && pipelineId !== null && selectedItem !== null && configRule !== null && (
          <StepConfigForm
            key={selectedItem.prompt.id}
            rule={configRule}
            item={selectedItem}
            subStep={configIsSubStep}
            inherited={configInherited}
            providers={console_.providers}
            models={models}
            policy={policy}
            suiteProvider={view?.defaults.defaultProvider ?? null}
            onExecutionChanged={() => {void refreshCatalog();if(activeSuiteId !== null) void refreshFlowchart(activeSuiteId);}}
            onUseSuiteSettings={!configIsSubStep ? () => void act(async () => {
              await workspaceApi.patchPipelineFlowchartRule(SERVER_URL, pipelineId, selectedItem.prompt.id, { provider: null, model: null });
              if (activeSuiteId !== null) await refreshFlowchart(activeSuiteId);
            }, "Step follows the suite agent again") : undefined}
            onUseStationSettings={
              configIsSubStep && !configInherited
                ? () =>
                    void act(async () => {
                      if (activeSuiteId === null) return;
                      await workspaceApi.removePipelineFlowchartStep(SERVER_URL, pipelineId, activeSuiteId, selectedItem.prompt.id, showEditor);
                      await refreshFlowchart(activeSuiteId);
                    }, "Sub-step follows its station again")
                : undefined
            }
            onChange={(patch) =>
              void act(async () => {
                await workspaceApi.patchPipelineFlowchartRule(SERVER_URL, pipelineId, selectedItem.prompt.id, patch);
                if (activeSuiteId !== null) await refreshFlowchart(activeSuiteId);
              })
            }
          />
        )}
        {(studio === "policy" || studio === "budgets" || studio === "statuses" || studio === "definition") && (
          <PipelineInspector
            section={studio}
            status={status}
            policy={policy}
            stationLabel={runPosition?.subStepLabel ?? runPosition?.stationLabel ?? null}
            suiteId={activeSuiteId}
            onStatusesChanged={() => void refreshCatalog()}
            onSettingsSaved={() => void refreshCatalog()}
            onEditStationFromSummary={resumeItem === null ? undefined : () => configureItem(resumeItem.prompt.id)}
            onEditAgents={() => setStudio("agents")}
          />
        )}
        {studio === "verification" && suiteOps !== null && (
          <VerificationPanel
            key={suiteOps.id}
            suite={suiteOps}
            provider={preferredProvider}
            model={models.resolve(preferredProvider)}
            workspaceBusy={occupancy !== null}
            focusRecordId={focusRecordId}
            onFocusHandled={() => setFocusRecordId(null)}
          />
        )}
        {studio === "history" && (
          <PipelineArchive runs={runs} selectedId={selectedRunId} onSelect={setSelectedRunId} />
        )}
      </PipelineStudio>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} entries={buildPaletteEntries} />

      <UnsavedChangesGuard
        dirty={showEditor && dirty}
        onDiscard={discardStoredDraft}
        what={draftName.trim() === "" ? "this pipeline" : `“${draftName.trim()}”`}
        onSave={async () => {
          if (draftName.trim() === "") {
            toast.error("Name this pipeline first.");
            return false;
          }
          try {
            await persist(draftName);
            return true;
          } catch (error) {
            toast.error("Could not save the pipeline", error instanceof Error ? error.message : String(error));
            return false;
          }
        }}
      />

      <ExecutionAllocationDialog promptId={allocationPromptId} onClose={() => setAllocationPromptId(null)} onChanged={() => {
          void refreshCatalog();
          if (activeSuiteId !== null) void refreshFlowchart(activeSuiteId);
          if (pipelineId !== null) void workspaceApi.pipelineRuns(SERVER_URL, pipelineId).then(setRuns);
        }}/>
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
                disabled={anyBusy || saveName.trim() === ""}
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
    </div>
  );
}

type BoardLayout = "flow" | "list";

function positiveInt(raw: string | null): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function LayoutToggle({ value, onChange }: { value: BoardLayout; onChange(next: BoardLayout): void }) {
  return (
    <div className="hidden rounded-md bg-surface-2 p-0.5 ring-1 ring-inset ring-line sm:flex" role="radiogroup" aria-label="Layout">
      {(["flow", "list"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded px-2.5 py-1 text-xs capitalize transition-colors",
            value === option ? "bg-surface-3 text-fg shadow-sm" : "text-fg-dim hover:text-fg",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-xs text-fg-muted">{children}</kbd>;
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

/** The board's one-line answer to "who is doing this suite?", with the door to change it. */
function AgentsSummary({ suiteName, provider, model, overrides, fallbacks, autoReassign, onOpen }: {
  suiteName: string;
  provider: ProviderId | null;
  model: string | null;
  overrides: number;
  fallbacks: ProviderId[];
  autoReassign: boolean;
  onOpen(): void;
}) {
  return (
    <section aria-label="Agent assignments" className="agents-summary">
      <span className="agents-summary-lead">
        {provider !== null ? <AgentAvatar provider={provider} size={26} activity="idle" /> : <span className="station-agent-empty" aria-hidden>?</span>}
        <span className="min-w-0">
          <span className="block text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-fg-dim">{suiteName} agent</span>
          <span className="block truncate text-sm text-fg">
            {provider ?? <span className="text-caution">Not chosen</span>}
            {provider !== null && model !== null && <span className="text-fg-muted"> · {modelLabel(provider, model)}</span>}
          </span>
        </span>
      </span>
      <span className="agents-summary-facts">
        <span>{overrides} {overrides === 1 ? "override" : "overrides"}</span>
        <span>Fallback {fallbacks.length > 0 ? fallbacks.join(" → ") : "house order"}</span>
        <span className={autoReassign ? "text-success" : undefined}>Auto-reassign {autoReassign ? "on" : "off"}</span>
      </span>
      <Button size="sm" variant={provider === null ? "primary" : "secondary"} onClick={onOpen}>Assign agents</Button>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  OperationsPrompt,
  HumanInterventionStep,
  OperationsSnapshot,
  HandoffRecord,
  PipelineFlowchartView,
  PipelineBlockedStation,
  PipelineRecord,
  PipelineRunDetail,
  PipelinePolicy,
  PipelineSubStepRule,
  ProgramRecord,
  PromptPipelineRule,
  ProviderId,
  WorkspaceTree,
} from "@agent-console/shared";
import { DEFAULT_PIPELINE_POLICY, defaultPromptPipelineRule, handoffRequired, modelLabel, onBlockedConsequence, onDoneConsequence, PROVIDER_IDS } from "@agent-console/shared";
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
import { useWorkspace } from "@/lib/workspaceContext";
import { ModelMenu } from "@/components/ModelMenu";
import { PageChrome } from "@/components/shell/chrome";
import { PipelineArchive } from "./PipelineArchive";
import { PipelineConstellation, type ConstellationStage } from "./PipelineConstellation";
import { PipelineOverview } from "./PipelineOverview";
import { PipelineStatusBar, type PipelinePosition } from "./PipelineStatusBar";
import { RulesPanel } from "./RulesPanel";
import { SettingsGroupDialog } from "@/components/SettingsGroupDialog";
import { PIPELINE_POLICY_GROUP } from "@/lib/settingsGroups";
import { SnakeFlow } from "./SnakeFlow";
import { StationCard } from "./StationCard";
import { SubPipeline, type SubStepRuleView, type SubTrailEntry } from "./SubPipeline";
import { nextPipelineLeaf } from "./continuation";
import {
  onDoneChip,
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
  const { workspaceId, status: workspaceStatus } = useWorkspace();

  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [runs, setRuns] = useState<PipelineRunDetail[]>([]);
  const [view, setView] = useState<PipelineFlowchartView | null>(null);
  const [viewSuiteId, setViewSuiteId] = useState<number | null>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [blockedStations, setBlockedStations] = useState<PipelineBlockedStation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [configId, setConfigId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [handoffProvider, setHandoffProvider] = useState<ProviderId>("claude");
  const [successorProvider, setSuccessorProvider] = useState<ProviderId>("claude");
  const [reusableHandoff, setReusableHandoff] = useState<HandoffRecord | null>(null);
  const [directRetry, setDirectRetry] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [expandedPrograms, setExpandedPrograms] = useState<Set<number>>(new Set());
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

  useEffect(() => {
    if (activeSuiteId === null || pipelineId === null) {
      setView(null);
      setViewSuiteId(null);
      return;
    }
    const requestedSuite = activeSuiteId;
    const requestedPipeline = pipelineId;
    setView(null);
    setViewSuiteId(null);
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
    if (workspaceId === null || pipelineId === null || !workbench) {
      setBlockedStations([]);
      return;
    }
    let disposed = false;
    void workspaceApi
      .pipelineDashboard(SERVER_URL, workspaceId)
      .then((data) => {
        if (!disposed) {
          setBlockedStations(data.blockedStations.filter((station) => station.pipelineId === pipelineId));
        }
      })
      .catch(() => {
        if (!disposed) setBlockedStations([]);
      });
    return () => {
      disposed = true;
    };
  }, [workspaceId, pipelineId, workbench, console_.operationsRevision]);

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

  const firstAvailable = console_.providers.find((item) => item.available)?.id ?? "claude";
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
  const steps = viewSuiteId === activeSuiteId ? (view?.steps ?? []) : [];
  const byId = new Map((suiteOps?.prompts ?? []).map((item) => [item.prompt.id, item]));
  const flowSteps = steps.filter((step) => {
    if (!byId.has(step.promptId)) return false;
    if (!hideCompleted) return true;
    const item = byId.get(step.promptId);
    return item?.operationalState !== "COMPLETE" && item?.operationalState !== "SKIPPED";
  });
  const displayedSteps = flowSteps.flatMap((step) => {
    const item = byId.get(step.promptId);
    if (item?.humanIntervention === null || item?.humanIntervention === undefined) return [{ kind: "prompt" as const, step }];
    return [
      { kind: "prompt" as const, step },
      { kind: "human" as const, step: item.humanIntervention, item },
    ];
  });

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
  const pendingPrompt = useMemo(() => {
    const suite = resumeSuiteOps ?? suiteOps;
    if (suite === null) return null;
    return nextPipelineLeaf(suite.prompts);
  }, [resumeSuiteOps, suiteOps]);
  const stuckPrompt = pendingPrompt?.operationalState === "RECOVERY_NEEDED" || pendingPrompt?.operationalState === "AWAITING_RESPONSE"
    ? pendingPrompt
    : null;

  const playBlocked = useMemo(() => {
    if (console_.connection !== "open") return "the backend is disconnected";
    if (pipelineId === null) return "this pipeline is not saved yet";
    if (draftSuiteIds.length === 0) return "it has no suites";
    if (dirty) return "there are unsaved changes";
    if (stages.some((stage) => stage.stepCount === 0)) return "every suite needs at least one step";
    if (resumeItem?.humanIntervention?.status === "PENDING") return "the human intervention step below is unanswered";
    if (occupancy !== null && live?.state === "PLAYING" && live.currentSuiteRunId !== occupancy.runId) {
      return `${occupancy.provider} is already writing this workspace`;
    }
    if (stuckPrompt?.operationalState === "AWAITING_RESPONSE") {
      const label = stuckPrompt.prompt.externalKey ?? stuckPrompt.prompt.title;
      return `${label} is blocked and needs a human response first`;
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
    // Resolve the same leaf the scheduler will launch before deciding whether
    // that leaf has prior work worth handing off.
    const continuationItem = pendingPrompt ?? resumeItem;
    const continuing = control === "resume" || control === "newRun" || control === "recover";
    if (continuing && continuationItem !== null) {
      const available = console_.providers.find((provider) => provider.available)?.id ?? firstAvailable;
      const readOnly = console_.providers.find((provider) => provider.available && provider.id !== "cursor")?.id ?? available;
      setHandoffProvider(readOnly);
      setSuccessorProvider(available);
      setReusableHandoff(null);
      setDirectRetry(false);
      void act(async () => {
        const activity = await workspaceApi.activity(SERVER_URL, continuationItem.prompt.id);
        const latestExecute = activity.sessions.find((session) => session.role === "execute");
        // The question is not "is this station unfinished" — a station a retry
        // reset to TODO is unfinished with nothing to summarise. It is whether a
        // previous run left work a successor must not redo, under the operator's
        // chosen policy.
        const needed = handoffRequired({
          policy,
          hasPriorRun: latestExecute !== undefined,
          producedWork: activity.producedWork,
        });
        if (!needed || latestExecute === undefined) {
          await workspaceApi.playPipeline(SERVER_URL, pipelineId);
          toast.success(control === "newRun" ? "New run started" : "Pipeline is running");
          return;
        }
        // Either the brief launched a successor that then failed, or it never
        // launched one (its recommendation parked the station for a human).
        // Both leave a written brief, and preparing a second one would pay a
        // read-only agent to summarise the same run twice.
        const reusable = activity.handoffs.find((handoff) => handoff.state === "READY"
          && (handoff.successorRunId === null
            ? handoff.sourceRunId === latestExecute.id
            : handoff.recommendation === "CONTINUE" && handoff.successorRunId === latestExecute.id)) ?? null;
        setSuccessorProvider((latestExecute.provider as ProviderId | undefined) ?? available);
        setDirectRetry(activity.directRetry);
        setReusableHandoff(reusable);
        setHandoffOpen(true);
      });
      return;
    }
    void act(async () => {
      await workspaceApi.playPipeline(SERVER_URL, pipelineId);
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

  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <PageChrome
        title="Pipeline"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <CrewStrip crew={crew} />
            <Badge tone={status.tone} dot pulse={status.pulse} uppercase>
              {status.label}
            </Badge>
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
          "grid min-h-0 flex-1",
          showEditor ? "lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_280px]" : "lg:grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_280px]",
        )}
      >
        {showEditor && (
        <aside className="min-h-0 overflow-y-auto border-r border-line bg-surface-1 p-3">
          {!workbench && (
          <>
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
          </>
          )}

          {workbench && (
            <div className="mb-3">
              <Link href="/pipeline" className="text-[11px] text-accent hover:underline">
                ← All pipelines
              </Link>
            </div>
          )}

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
        )}

        <section className="pipeline-desk min-h-0 overflow-auto p-5">
          <div className="mx-auto max-w-6xl space-y-6">
            {workbench && pipeline !== null && !showEditor && (
              <PipelineOverview pipeline={pipeline} snapshot={snapshot} runs={runs} blockedStations={blockedStations} />
            )}

            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-accent">Pipeline</div>
                {showEditor ? (
                  <label className="mt-1 block">
                    <span className="sr-only">Pipeline name</span>
                    <input
                      type="text"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      maxLength={200}
                      aria-label="Pipeline name"
                      className="w-full min-w-64 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-2xl tracking-tight text-fg outline-none transition-colors focus:border-accent"
                    />
                  </label>
                ) : (
                  <h2 className="mt-1 text-2xl tracking-tight text-fg">{draftName}</h2>
                )}
                <p className="mt-1 text-xs text-fg-dim">
                  {tree?.name ?? "Choose a workspace"} · {stages.length} suite{stages.length === 1 ? "" : "s"}
                  {dirty ? " · unsaved" : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPolicyOpen(true)}
                  title="What Pause and Stop do, when a handoff is offered, and the rule a station starts with"
                >
                  Pipeline policy
                </Button>
                {workbench && pipelineId !== null && !isNew && (
                  <Button
                    size="sm"
                    variant={showEditor ? "primary" : "secondary"}
                    disabled={busy || (showEditor && draftName.trim() === "")}
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
                    {showEditor ? (dirty ? "Save and finish" : "Done editing") : "Edit pipeline"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !dirty || draftName.trim() === ""}
                  onClick={() => {
                    if (pipelineId !== null) {
                      void act(async () => { await persist(draftName); }, "Pipeline changes saved");
                      return;
                    }
                    setSaveName(draftName === "Untitled pipeline" ? "" : draftName);
                    setSaveOpen(true);
                  }}
                >
                  {pipelineId === null ? "Save pipeline" : "Save changes"}
                </Button>
                {pipelineId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || resumable}
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

            <PipelineStatusBar
              status={status}
              position={runPosition}
              blockedReason={statusBlocked}
              busy={busy}
              onControl={runControl}
              onExplain={() => setRulesOpen(true)}
            />

            <RulesPanel
              open={rulesOpen}
              onClose={() => setRulesOpen(false)}
              status={status}
              policy={policy}
              station={runPosition?.subStepLabel ?? runPosition?.stationLabel ?? null}
              onEditPolicy={() => {
                setRulesOpen(false);
                setPolicyOpen(true);
              }}
              onEditStationRule={
                resumeItem === null
                  ? undefined
                  : () => {
                      setRulesOpen(false);
                      setConfigId(resumeItem.prompt.id);
                    }
              }
            />

            {policyOpen && (
              <SettingsGroupDialog
                group={PIPELINE_POLICY_GROUP}
                onClose={() => setPolicyOpen(false)}
                // The board renders from the policy on the operations snapshot,
                // so it has to be re-read before the change is visible here.
                onSaved={() => void refreshCatalog()}
              />
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
              <p className="text-sm text-fg-dim">Select a suite on the rail to inspect its steps.</p>
            ) : openSubNode !== null ? (
              <SubPipeline
                trail={subTrail}
                items={openSubNode.children}
                parentRule={subRuleFor(openSubNode.prompt.id).rule}
                ruleFor={subRuleFor}
                activeRun={view?.active ?? null}
                runs={console_.runs}
                readOnly={pipelineId === null}
                busy={busy}
                onNavigate={(index) => setSubPath((current) => (index === null ? [] : current.slice(0, index + 1)))}
                onOpen={(promptId) => setSubPath((current) => [...current, promptId])}
                onConfig={(promptId) => setConfigId(promptId)}
                onUseStationSettings={(promptId) =>
                  void act(async () => {
                    if (pipelineId === null) return;
                    await workspaceApi.removePipelineFlowchartStep(SERVER_URL, pipelineId, suiteOps.id, promptId, showEditor);
                    await refreshFlowchart(suiteOps.id);
                  }, "Sub-step follows its station again")
                }
                onRetry={(promptId) =>
                  void act(async () => {
                    await workspaceApi.recover(SERVER_URL, promptId);
                  }, "Sub-step recovered — play to run it again")
                }
                onSkip={(promptId) =>
                  void act(async () => {
                    const confirmed = await dialogs.confirm({
                      title: "Skip this sub-step?",
                      description: "The pipeline moves straight to the next sub-step. Skipped work is not retried.",
                      confirmLabel: "Skip sub-step",
                      tone: "danger",
                    });
                    if (!confirmed) return;
                    await workspaceApi.skipPrompt(SERVER_URL, promptId, "Operator skipped this sub-step.");
                  }, "Sub-step skipped")
                }
              />
            ) : (
              <div className="space-y-4" key={activeSuiteId ?? "none"}>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">
                    {suiteOps.programName} · {showEditor ? "flowchart" : "steps"}
                  </div>
                  <h3 className="mt-1 text-lg text-fg">
                    {suiteOps.key !== null && `${suiteOps.key} — `}
                    {suiteOps.name}
                  </h3>
                  <p className="mt-1 text-xs text-fg-dim">
                    {showEditor
                      ? "Drag to set order. Only incomplete work items appear in Add remaining. Completed and skipped count as done."
                      : "Steps configured for this pipeline. Edit pipeline to change suites or wiring."}
                  </p>
                </div>

                {pipelineId === null ? (
                  <p className="text-sm text-fg-dim">Save this pipeline first, then add steps to each suite.</p>
                ) : (
                  <>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-wider text-fg-dim">Flowchart steps</div>
                  <button
                    type="button"
                    onClick={() => setHideCompleted((current) => !current)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    {hideCompleted ? "Show completed" : "Hide completed"}
                  </button>
                </div>

                {showEditor && view?.available.length ? (
                  <div>
                    <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">Add remaining work</div>
                    <div className="flex flex-wrap gap-2">
                      {view.available.map((prompt) => (
                        <button
                          key={prompt.id}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const result = await workspaceApi.addPipelineFlowchartStep(
                                SERVER_URL,
                                pipelineId,
                                suiteOps.id,
                                { promptId: prompt.id, provider: firstAvailable },
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

                {displayedSteps.length === 0 ? (
                  <div className="rounded-panel border border-dashed border-line bg-surface-1/70 px-6 py-12 text-center text-sm text-fg-dim">
                    {hideCompleted
                      ? "No incomplete steps on this flowchart. Show completed or add remaining work above."
                      : showEditor
                        ? "This suite has no steps on this pipeline yet. Add remaining work items above."
                        : "This suite has no steps on this pipeline yet. Edit pipeline to add steps."}
                  </div>
                ) : (
                  <SnakeFlow
                    items={displayedSteps}
                    getKey={(entry) => entry.kind === "prompt" ? `prompt-${entry.step.promptId}` : entry.step.id}
                    isLiveIndex={(index) => {
                      const entry = displayedSteps[index];
                      return entry?.kind === "prompt" && view?.active?.currentPromptId === entry.step.promptId;
                    }}
                    wrapItem={
                      showEditor
                        ? (node, entry) => entry.kind === "human" ? node : (
                      <div
                        draggable
                        onDragStart={() => setDragId(entry.step.promptId)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (dragId === null || dragId === entry.step.promptId || pipelineId === null) return;
                          const ids = steps.map((entry) => entry.promptId);
                          const from = ids.indexOf(dragId);
                          const to = ids.indexOf(entry.step.promptId);
                          if (from === -1 || to === -1) return;
                          ids.splice(from, 1);
                          ids.splice(to, 0, dragId);
                          setDragId(null);
                          void act(async () => {
                            const result = await workspaceApi.reorderPipelineFlowchartSteps(
                              SERVER_URL,
                              pipelineId,
                              suiteOps.id,
                              ids,
                              true,
                            );
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
                    renderCard={(entry, index) => {
                      if (entry.kind === "human") {
                        return (
                          <HumanInterventionNode
                            step={entry.step}
                            busy={busy}
                            onRespond={(content) => act(async () => {
                              await workspaceApi.respond(SERVER_URL, entry.step.promptId, content);
                            }, "Human response recorded")}
                          />
                        );
                      }
                      const step = entry.step;
                      const item = byId.get(step.promptId);
                      if (item === undefined) return null;
                      const liveRun = stationOccupancy(item, console_.runs, view?.active);
                      const current = view?.active?.currentPromptId === step.promptId;
                      const doneChildren = item.children.filter(
                        (child) => child.operationalState === "COMPLETE" || child.operationalState === "SKIPPED",
                      ).length;
                      return (
                        <StationCard
                          index={index}
                          item={item}
                          rule={step}
                          current={current}
                          occupancy={liveRun}
                          readOnly={!showEditor}
                          subSteps={item.children.length > 0 ? { done: doneChildren, total: item.children.length } : undefined}
                          onOpenSubPipeline={item.children.length > 0 ? () => setSubPath([step.promptId]) : undefined}
                          onConfig={() => setConfigId(step.promptId)}
                          onRemove={() =>
                            void act(async () => {
                              const result = await workspaceApi.removePipelineFlowchartStep(
                                SERVER_URL,
                                pipelineId,
                                suiteOps.id,
                                step.promptId,
                                true,
                              );
                              setView(result.flowchart);
                              setViewSuiteId(suiteOps.id);
                            })
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
          rule={configRule}
          item={configNode}
          subStep={configIsSubStep}
          inherited={configInherited}
          providers={console_.providers}
          models={models}
          policy={policy}
          onClose={() => setConfigId(null)}
          onUseStationSettings={
            configIsSubStep && !configInherited
              ? () =>
                  void act(async () => {
                    if (pipelineId === null || activeSuiteId === null) return;
                    await workspaceApi.removePipelineFlowchartStep(SERVER_URL, pipelineId, activeSuiteId, configId, showEditor);
                    await refreshFlowchart(activeSuiteId);
                  }, "Sub-step follows its station again")
              : undefined
          }
          onChange={(patch) =>
            void act(async () => {
              if (pipelineId === null) return;
              await workspaceApi.patchPipelineFlowchartRule(SERVER_URL, pipelineId, configId, patch);
              if (activeSuiteId !== null) await refreshFlowchart(activeSuiteId);
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

      {handoffOpen && (pendingPrompt ?? resumeItem) !== null && pipelineId !== null && (() => {
        const continuationItem = (pendingPrompt ?? resumeItem)!;
        // The read-only agent advises the automatic path; an operator resuming
        // by hand overrides it, and should see what they are overriding.
        const advice = reusableHandoff === null || reusableHandoff.recommendation === null || reusableHandoff.recommendation === "CONTINUE" ? "" : ` It recommended ${reusableHandoff.recommendation.toLowerCase().replace(/_/g, " ")} rather than continuing, so nothing started automatically.`;
        return (
        <Modal
          open
          onClose={() => setHandoffOpen(false)}
          title={`Continue ${continuationItem.prompt.externalKey ?? continuationItem.prompt.title}`}
          description={directRetry?"The previous agent failed before producing any work. Choose a developer agent and retry this station directly; no handoff is needed.":reusableHandoff===null?"A read-only agent will prepare the handoff first. After it identifies completed and pending work, the selected developer agent will continue the pipeline.":`The existing ${reusableHandoff.provider} handoff is ready. Resuming will reuse it and start only the selected developer agent.`}
          size="md"
          footer={<><Button variant="ghost" onClick={() => setHandoffOpen(false)}>Cancel</Button><Button variant="success" disabled={busy} onClick={() => void act(async()=>{if(directRetry)await workspaceApi.retryLaunch(SERVER_URL,continuationItem.prompt.id,{provider:successorProvider,model:null,pipelineId});else await workspaceApi.startHandoff(SERVER_URL,continuationItem.prompt.id,{...(reusableHandoff===null?{handoffProvider,handoffModel:models.resolve(handoffProvider)}:{reuseHandoffId:reusableHandoff.id}),successorProvider,successorModel:models.resolve(successorProvider),pipelineId});setHandoffOpen(false);},directRetry?"Station restarted":reusableHandoff===null?"Handoff started":"Existing handoff reused")}>{directRetry?"Retry without handoff":reusableHandoff===null?"Prepare handoff and continue":"Continue with existing handoff"}</Button></>}
        >
          <div className={`grid gap-4 ${reusableHandoff===null&&!directRetry?"sm:grid-cols-2":""}`}>
            {reusableHandoff===null&&!directRetry&&<label className="space-y-1.5 text-xs text-fg-muted"><span>Handoff agent · read-only</span><select value={handoffProvider} onChange={(event)=>setHandoffProvider(event.target.value as ProviderId)} className="h-10 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-fg">{console_.providers.filter((provider)=>provider.available&&provider.id!=="cursor").map((provider)=><option key={provider.id} value={provider.id}>{provider.label} · {modelLabel(provider.id,models.resolve(provider.id))??"default"}</option>)}</select></label>}
            <label className="space-y-1.5 text-xs text-fg-muted"><span>Successor developer agent</span><select value={successorProvider} onChange={(event)=>setSuccessorProvider(event.target.value as ProviderId)} className="h-10 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-fg">{console_.providers.filter((provider)=>provider.available).map((provider)=><option key={provider.id} value={provider.id}>{provider.label} · {directRetry?"default":modelLabel(provider.id,models.resolve(provider.id))??"default"}</option>)}</select></label>
          </div>
          <p className="mt-4 text-xs leading-5 text-fg-dim">{directRetry?"Launch failures retry with the provider default, so the invalid per-station model is not reused.":reusableHandoff===null?"Nothing starts on app launch. This handoff begins only after you confirm, and its progress appears on the pipeline station before the successor starts.":`Prepared by ${reusableHandoff.provider}${reusableHandoff.completedAt===null?"":` on ${new Date(reusableHandoff.completedAt).toLocaleString()}`}.${advice} No handoff agent will run again.`}</p>
        </Modal>
        );
      })()}
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

function HumanInterventionNode({
  step,
  busy,
  onRespond,
}: {
  step: HumanInterventionStep;
  busy: boolean;
  onRespond(content: string): Promise<void>;
}) {
  const [response, setResponse] = useState("");
  const complete = step.status === "COMPLETE";
  return (
    <div className={cn("relative h-full min-w-0 rounded-panel border p-3", complete ? "border-success/40 bg-success/5" : "border-warning/50 bg-warning/5 ring-1 ring-warning/20")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] text-fg">Human intervention</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-fg-dim">Required before AI continues</div>
        </div>
        <Badge tone={complete ? "success" : "warning"}>{complete ? "Responded" : "Action required"}</Badge>
      </div>
      <div className="mt-3 whitespace-pre-wrap text-xs leading-5 text-fg-muted">{step.requiredAction}</div>
      {complete ? (
        <div className="mt-3 border-t border-line pt-3 text-xs leading-5 text-fg-dim">
          <span className="text-fg-muted">Human response:</span> {step.response}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block text-[11px] text-fg-muted" htmlFor={`${step.id}-response`}>Your response or decision</label>
          <textarea
            id={`${step.id}-response`}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            rows={4}
            placeholder="Record the decision or action taken…"
            className="w-full resize-y rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs text-fg outline-none focus:border-warning"
          />
          <Button size="sm" variant="primary" disabled={busy || response.trim() === ""} onClick={() => void onRespond(response.trim())}>
            Submit response
          </Button>
        </div>
      )}
    </div>
  );
}

function StepConfig({
  rule,
  item,
  subStep = false,
  inherited = false,
  providers,
  models,
  policy,
  onClose,
  onUseStationSettings,
  onChange,
}: {
  rule: PromptPipelineRule | null;
  item: OperationsPrompt | null;
  /** A slice the station spawned by decomposing itself, not a flowchart step. */
  subStep?: boolean;
  /** Sub-step only: still following the parent station rather than pinned here. */
  inherited?: boolean;
  providers: Parameters<typeof useModelSelection>[0];
  models: ReturnType<typeof useModelSelection>;
  /** House rules, so the consequence lines match what will actually happen. */
  policy: PipelinePolicy;
  onClose(): void;
  onUseStationSettings?(): void;
  onChange(patch: Partial<Omit<PromptPipelineRule, "promptId">>): void;
}) {
  const [modelFor, setModelFor] = useState<ProviderId | null>(null);
  if (rule === null || item === null) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${subStep ? "Sub-step" : "Step"} · ${item.prompt.externalKey ?? item.prompt.title}`}
      description={
        subStep
          ? "Sub-steps follow their station unless you pin something here. What you set applies to this slice alone; when it finishes, the station's own rule decides what happens next."
          : "Provider and model apply only to this step. Outcome chips decide what happens after it finishes."
      }
      size="md"
      footer={
        onUseStationSettings === undefined ? undefined : (
          <Button
            variant="ghost"
            title="Remove this sub-step's agent override. Execution status is unchanged."
            onClick={onUseStationSettings}
          >
            Use station settings
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {subStep && (
          <p
            className={cn(
              "rounded-md px-3 py-2 text-[11px] leading-5 ring-1 ring-inset",
              inherited ? "bg-surface-2 text-fg-dim ring-line" : "bg-violet/10 text-violet ring-violet/30",
            )}
          >
            {inherited
              ? "Currently inherited from the station. Choosing an agent below pins it to this sub-step only."
              : "Pinned to this sub-step. Use station settings to remove this override; execution status will not change."}
          </p>
        )}
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
        <section className={subStep ? "hidden" : undefined} aria-hidden={subStep || undefined}>
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
          <p className="mt-2 text-[11px] leading-4 text-fg-dim">{onDoneConsequence(rule.onDone, policy)}</p>
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
          <p className="mt-2 text-[11px] leading-4 text-fg-dim">{onBlockedConsequence(rule, policy)}</p>
        </section>
      </div>
    </Modal>
  );
}

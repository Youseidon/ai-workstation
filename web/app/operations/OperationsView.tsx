"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type {
  OperationsPrompt,
  OperationsSnapshot,
  PromptPipelineRule,
  ProviderId,
} from "@agent-console/shared";
import { AppNav } from "@/components/AppNav";
import { LogPanel } from "@/components/LogPanel";
import { PipelineRail } from "@/components/pipeline/PipelineRail";
import { StationRules } from "@/components/pipeline/RuleChip";
import type { RulePatch } from "@/components/pipeline/RulePopover";
import { LABEL, TONE, pipelineBadge, playBlockedReason, workspaceOccupancy } from "@/components/pipeline/status";
import { ProviderSwitcher } from "@/components/ProviderSwitcher";
import { SettingsPanel } from "@/components/SettingsPanel";
import { StatusBar } from "@/components/StatusBar";
import { VerificationPanel } from "@/components/VerificationPanel";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { applyEvent, type LogItem } from "@/lib/log";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { ApiError, workspaceApi } from "@/lib/workspacesApi";

type Filter = "all" | "attention" | "working";
type View = "prompts" | "sessions";
type Pane = "suites" | "list" | "detail";

export function OperationsView() {
  const console_ = useAgentConsole();
  const { operationsRevision } = console_;
  const toast = useToast();
  const dialogs = useDialogs();
  const params = useSearchParams();

  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Awaited<ReturnType<typeof workspaceApi.activity>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("detail");

  // Deep-link parameters seed the initial selection; after that the user's
  // clicks win. Reading them here rather than in an effect is what lets every
  // selection below be derived during render.
  const [suiteId, setSuiteId] = useState<number | null>(() => {
    const value = Number(params.get("suite"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [promptId, setPromptId] = useState<number | null>(() => {
    const value = Number(params.get("prompt"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(() => {
    const value = params.get("filter");
    return value === "attention" || value === "working" ? value : "all";
  });
  const [view, setView] = useState<View>(() => (params.get("view") === "sessions" ? "sessions" : "prompts"));
  const [preferredProvider, setPreferredProvider] = useState<ProviderId | null>(null);

  const refresh = useCallback(
    () =>
      workspaceApi
        .operations(SERVER_URL)
        .then((value) => {
          setSnapshot(value);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          setLoadError(error instanceof Error ? error.message : "Operations could not be loaded.");
        }),
    [],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh, operationsRevision]);

  /* ---------------------------------------------------------------------- */
  /* Everything below is derived, not synchronised                           */
  /* ---------------------------------------------------------------------- */

  const suites = snapshot?.suites ?? [];
  // A deep-linked prompt implies its suite, even before the user picks one.
  const suite =
    suites.find((item) => item.id === suiteId) ??
    (promptId === null
      ? undefined
      : suites.find((item) => item.prompts.some((p) => p.prompt.id === promptId))) ??
    suites[0] ??
    null;

  const prompts = useMemo(
    () =>
      suite?.prompts.filter(
        (item) =>
          filter === "all" ||
          (filter === "attention" && item.attention) ||
          (filter === "working" && item.operationalState === "WORKING"),
      ) ?? [],
    [suite, filter],
  );

  const sessions = useMemo(() => {
    if (suite === null) return [];
    const visible = new Set(prompts.map((item) => item.prompt.id));
    return suite.sessions.filter((item) => item.promptId !== null && visible.has(item.promptId));
  }, [suite, prompts]);

  // Fall back to the first row rather than storing a correction in state.
  const activePromptId =
    prompts.some((item) => item.prompt.id === promptId) ? promptId : prompts[0]?.prompt.id ?? null;
  const activeSessionId =
    sessions.some((item) => item.id === sessionId) ? sessionId : sessions[0]?.id ?? null;

  const provider = useMemo<ProviderId>(() => {
    const picked = console_.providers.find((item) => item.id === preferredProvider);
    if (picked?.available === true) return picked.id;
    return console_.providers.find((item) => item.available)?.id ?? preferredProvider ?? "codex";
  }, [console_.providers, preferredProvider]);

  const providerInfo = console_.providers.find((item) => item.id === provider) ?? null;
  const models = useModelSelection(console_.providers);
  const selectedModel = models.resolve(provider);
  const workspaceBusy = (id: number) => console_.runs.some((item) => item.workspace.id === id);

  useEffect(() => {
    if (activePromptId === null) return;
    let disposed = false;
    void workspaceApi
      .activity(SERVER_URL, activePromptId)
      .then((item) => {
        if (!disposed) setActivity(item);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [activePromptId, snapshot?.generatedAt]);

  // Keep the address bar shareable without driving state from it.
  useEffect(() => {
    if (suite === null) return;
    const query = new URLSearchParams({ suite: String(suite.id), view });
    if (activePromptId !== null) query.set("prompt", String(activePromptId));
    if (filter !== "all") query.set("filter", filter);
    window.history.replaceState(null, "", `/operations?${query.toString()}`);
  }, [suite, activePromptId, view, filter]);

  const selectedSession = activity?.sessions.find((item) => item.id === activeSessionId) ?? null;
  const logs = useMemo<LogItem[]>(
    () => selectedSession?.events.reduce<LogItem[]>((items, event) => applyEvent(items, event), []) ?? [],
    [selectedSession],
  );

  // Only trust the fetched activity when it belongs to the row that is
  // actually selected — the fetch is async and the selection can move under it.
  const item =
    activity !== null && activity.item.prompt.id === activePromptId ? activity.item : null;
  const canStart =
    console_.connection === "open" &&
    item !== null &&
    !workspaceBusy(item.workspace.id) &&
    providerInfo?.available === true &&
    item.workspace.workDirectoryExists;

  const timeline = useMemo(() => {
    if (activity === null || activity.item.prompt.id !== activePromptId) return [];
    return [
      ...activity.remarks.map((entry) => ({
        id: `r${entry.id}`,
        at: entry.createdAt,
        label: `${entry.actorType} · ${entry.kind}`,
        text: entry.content,
        tone:
          entry.kind === "BLOCKER" || entry.kind === "DECISION_NEEDED"
            ? "border-warning/50"
            : entry.kind === "HUMAN_RESPONSE"
              ? "border-info/50"
              : "border-line",
      })),
      ...activity.events.map((entry) => ({
        id: `e${entry.id}`,
        at: entry.createdAt,
        label: `${entry.actorType} · ${entry.previousStatus} → ${entry.newStatus}`,
        text: [entry.reason, entry.verificationSummary].filter(Boolean).join("\n\n"),
        tone: "border-line",
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [activity, activePromptId]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const act = async (operation: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      if (activePromptId !== null) setActivity(await workspaceApi.activity(SERVER_URL, activePromptId));
      if (success !== undefined) toast.success(success);
    } catch (error) {
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const occupancy = suite === null ? null : workspaceOccupancy(suite.workspaceId, console_.runs);
  const otherPipeline =
    suite === null
      ? null
      : suites.find(
          (entry) =>
            entry.id !== suite.id &&
            entry.workspaceId === suite.workspaceId &&
            (entry.pipeline?.active?.state === "PLAYING" || entry.pipeline?.active?.state === "PAUSED"),
        ) ?? null;
  const railBlocked =
    suite === null
      ? "Select a suite"
      : playBlockedReason({
          suite,
          connection: console_.connection,
          playProvider: provider,
          providerAvailable: providerInfo?.available === true,
          occupancy,
          otherPipeline,
        });
  const waitingPipeline = (targetId: number | null) => {
    const active = suite?.pipeline?.active;
    return active?.state === "WAITING_HUMAN" && active.currentPromptId === targetId ? active : null;
  };

  const toastPlayError = (error: unknown) => {
    if (error instanceof ApiError && error.code === "workspace_busy") {
      toast.error(
        "Workspace busy",
        occupancy !== null
          ? `${occupancy.provider} is already writing ${occupancy.workspace.name}.`
          : error.message,
      );
      return;
    }
    if (error instanceof ApiError && (error.code === "nothing_ready" || error.code === "prompt_not_ready")) {
      toast.warning("Nothing is ready", error.message);
      return;
    }
    toast.error("Could not play", error instanceof Error ? error.message : String(error));
  };

  const playSuite = () => {
    if (suite === null) return;
    const resuming = suite.pipeline?.active?.state === "WAITING_HUMAN" || suite.pipeline?.active?.state === "PAUSED";
    setBusy(true);
    void (async () => {
      try {
        await workspaceApi.playSuite(SERVER_URL, suite.id, { provider, model: selectedModel });
        await refresh();
        toast.success(resuming ? "Resumed" : "Suite playing");
      } catch (error) {
        toastPlayError(error);
      } finally {
        setBusy(false);
      }
    })();
  };

  const pauseSuite = () =>
    void act(async () => {
      if (suite === null) return;
      await workspaceApi.pauseSuite(SERVER_URL, suite.id);
    }, "Paused — current station will finish.");

  const stopSuite = () =>
    void act(async () => {
      if (suite === null) return;
      await workspaceApi.stopSuite(SERVER_URL, suite.id);
    }, "Pipeline stopped");

  const applyRuleLocal = (current: OperationsSnapshot, promptId: number, rule: PromptPipelineRule): OperationsSnapshot => ({
    ...current,
    suites: current.suites.map((entry) => ({
      ...entry,
      prompts: entry.prompts.map((row) => (row.prompt.id === promptId ? { ...row, pipelineRule: rule } : row)),
    })),
  });

  const patchRule = (promptId: number, patch: RulePatch) => {
    if (snapshot === null) return;
    const previous = snapshot;
    const currentRule = snapshot.suites.flatMap((entry) => entry.prompts).find((row) => row.prompt.id === promptId)?.pipelineRule;
    if (currentRule !== undefined) setSnapshot(applyRuleLocal(snapshot, promptId, { ...currentRule, ...patch }));
    void workspaceApi.patchPipelineRule(SERVER_URL, promptId, patch).then(
      (rule) => setSnapshot((live) => (live === null ? live : applyRuleLocal(live, promptId, rule))),
      (error: unknown) => {
        setSnapshot(previous);
        toast.error("Could not save rule", error instanceof Error ? error.message : String(error));
      },
    );
  };

  const start = () => {
    if (item === null || !canStart) return;
    const waiting = waitingPipeline(item.prompt.id);
    const paused = suite?.pipeline?.active;
    if (waiting !== null || (paused?.state === "PAUSED" && paused.currentPromptId === item.prompt.id)) {
      playSuite();
      return;
    }
    const ok = console_.startRun(item.workspace.id, provider, { promptId: item.prompt.id }, selectedModel);
    if (!ok) toast.error("Could not start", "The agent connection is unavailable.");
  };

  const respond = () =>
    void act(async () => {
      if (item === null) return;
      await workspaceApi.respond(
        SERVER_URL,
        item.prompt.id,
        response.trim() ||
          "Retry requested with no additional context. Inspect the existing working tree and prior evidence, then continue incomplete work without repeating resolved blockers.",
      );
      setResponse("");
      if (suite !== null && waitingPipeline(item.prompt.id) !== null) {
        try {
          await workspaceApi.playSuite(SERVER_URL, suite.id, { provider, model: selectedModel });
        } catch (error) {
          toastPlayError(error);
        }
        return;
      }
      if (!console_.startRun(item.workspace.id, provider, { promptId: item.prompt.id }, selectedModel)) {
        throw new Error("Response saved, but the agent connection was unavailable. Run it from the Console.");
      }
    }, "Response sent");

  const recoverAndResume = (target: OperationsPrompt | null = item) =>
    void act(async () => {
      if (target === null) return;
      if (suite?.pipeline?.active?.state === "PLAYING") {
        throw new Error("The pipeline owns this station while it is playing.");
      }
      await workspaceApi.recover(SERVER_URL, target.prompt.id);
      if (suite !== null && waitingPipeline(target.prompt.id) !== null) {
        try {
          await workspaceApi.playSuite(SERVER_URL, suite.id, { provider, model: selectedModel });
        } catch (error) {
          toastPlayError(error);
        }
      } else if (suite?.pipeline?.active != null) {
        throw new Error("This suite is waiting on another station. Resume or stop the pipeline first.");
      } else if (!console_.startRun(target.workspace.id, provider, { promptId: target.prompt.id }, selectedModel)) {
        throw new Error("Recovered, but the agent connection was unavailable. Run it from the Console.");
      }
      setFilter("all");
    }, "Recovered and resumed");

  const stopAgent = async () => {
    if (item?.prompt.currentRun == null) return;
    const confirmed = await dialogs.confirm({
      title: "Stop this agent run?",
      description: "Its work so far and its logs are preserved. The work item will need recovery to continue.",
      confirmLabel: "Stop agent",
      tone: "danger",
    });
    if (!confirmed) return;
    await act(async () => {
      await workspaceApi.interruptRun(SERVER_URL, item.prompt.currentRun!.id);
    }, "Agent stopped");
  };

  const totalAttention = suites.reduce((sum, entry) => sum + entry.attentionCount, 0);
  const totalWorking = suites.reduce((sum, entry) => sum + entry.counts.WORKING, 0);

  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-1 px-4 py-2.5">
        <h1 className="text-xs uppercase tracking-[0.2em] text-fg-muted">agent console</h1>
        <AppNav active="operations" />
        <div className="hidden items-center gap-2 xl:flex">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">Play with</span>
          <ProviderSwitcher
            providers={console_.providers}
            selected={provider}
            disabled={false}
            models={models}
            onSelect={setPreferredProvider}
            onRefresh={() => void console_.refreshProviders()}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterButton active={filter === "attention"} tone="warning" onClick={() => setFilter("attention")}>
            Attention {totalAttention}
          </FilterButton>
          <FilterButton active={filter === "working"} tone="info" onClick={() => setFilter("working")}>
            Working {totalWorking}
          </FilterButton>
          <FilterButton active={filter === "all"} tone="neutral" onClick={() => setFilter("all")}>
            All
          </FilterButton>
          <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </Button>
        </div>
      </header>

      {loadError !== null && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">Live operations are unavailable: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}

      {/* Below xl the three panes stack, one at a time. */}
      <div className="flex items-center gap-1 border-b border-line bg-surface-1 px-4 py-1.5 xl:hidden">
        {(["suites", "list", "detail"] as Pane[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setPane(option)}
            aria-current={pane === option ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-xs capitalize transition-colors",
              pane === option ? "bg-surface-3 text-fg" : "text-fg-dim hover:bg-surface-2 hover:text-fg",
            )}
          >
            {option === "list" ? (view === "prompts" ? "Work items" : "Sessions") : option}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[260px_340px_minmax(0,1fr)]">
        {/* Suites ---------------------------------------------------------- */}
        <aside
          className={cn(
            "min-h-0 overflow-y-auto border-line bg-surface-1 p-3 xl:block xl:border-r",
            pane === "suites" ? "block" : "hidden",
          )}
        >
          <div className="mb-3 text-[10px] uppercase tracking-wider text-fg-dim">Suites</div>
          {snapshot === null ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : suites.length === 0 ? (
            <p className="text-xs leading-relaxed text-fg-dim">
              No suites yet. Create programs and suites on the Workspaces page.
            </p>
          ) : (
            suites.map((entry) => {
              const badge = pipelineBadge(entry);
              const done = entry.counts.COMPLETE;
              const total = entry.prompts.length;
              return (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setSuiteId(entry.id);
                  setPromptId(null);
                  setPane("list");
                }}
                aria-current={suite?.id === entry.id ? "true" : undefined}
                className={cn(
                  "mb-2 w-full rounded-panel border p-3 text-left transition-colors",
                  suite?.id === entry.id
                    ? "border-line-strong bg-surface-3"
                    : "border-line bg-surface-2 hover:bg-surface-3",
                )}
              >
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate">
                    {entry.key !== null && <span className="text-fg-muted">{entry.key} · </span>}
                    {entry.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {badge !== null && (
                      <Badge tone={badge.tone} pulse={badge.pulse}>
                        {badge.label}
                      </Badge>
                    )}
                    {entry.attentionCount > 0 && <Badge tone="warning">{entry.attentionCount}</Badge>}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] text-fg-dim">
                  {entry.workspaceName} · {entry.programName}
                </div>
                {badge === null && total > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full bg-success/70" style={{ width: `${(done / total) * 100}%` }} />
                    </div>
                    <span className="shrink-0 text-[10px] text-fg-dim">
                      {done}/{total} done
                    </span>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {entry.latestVerification === null ? (
                    <Badge tone="neutral">unverified</Badge>
                  ) : (
                    <Badge
                      tone={
                        entry.latestVerification.state === "RUNNING"
                          ? "info"
                          : entry.latestVerification.verdict === "PASS"
                            ? "success"
                            : entry.latestVerification.verdict === "FAIL"
                              ? "danger"
                              : "warning"
                      }
                      dot
                      pulse={entry.latestVerification.state === "RUNNING"}
                    >
                      {entry.latestVerification.state === "RUNNING"
                        ? "verifying"
                        : entry.latestVerification.verdict ?? entry.latestVerification.state}
                    </Badge>
                  )}
                  <span className="text-info">{entry.counts.WORKING} working</span>
                  <span className="text-success">{entry.counts.COMPLETE} done</span>
                </div>
              </button>
              );
            })
          )}
        </aside>

        {/* Work items / sessions ------------------------------------------- */}
        <aside
          className={cn(
            "min-h-0 overflow-y-auto border-line bg-surface-1/60 p-3 xl:block xl:border-r",
            pane === "list" ? "block" : "hidden",
          )}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex rounded-md bg-surface-2 p-0.5 text-[10px] ring-1 ring-inset ring-line">
              {(["prompts", "sessions"] as View[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setView(option)}
                  aria-current={view === option ? "true" : undefined}
                  className={cn(
                    "rounded px-2 py-1 capitalize transition-colors",
                    view === option ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg",
                  )}
                >
                  {option === "prompts" ? "Work items" : "Sessions"}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-fg-dim">
              {view === "prompts" ? (suite?.prompts.length ?? 0) : sessions.length}
            </span>
          </div>

          {view === "prompts" ? (
            <PipelineRail
              suite={suite}
              selectedPromptId={activePromptId}
              occupancyRuns={console_.runs}
              playProvider={provider}
              providers={console_.providers}
              models={models}
              onSelectProvider={setPreferredProvider}
              onRefreshProviders={() => void console_.refreshProviders()}
              playBlockedReason={railBlocked}
              busy={busy}
              loading={snapshot === null}
              onSelect={(id) => {
                setPromptId(id);
                setPane("detail");
              }}
              onPlay={playSuite}
              onPause={pauseSuite}
              onStop={stopSuite}
              onChangeRule={patchRule}
            />
          ) : sessions.length === 0 ? (
            <p className="text-xs text-fg-dim">No sessions for the current filter.</p>
          ) : (
            sessions.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => {
                  setSessionId(run.id);
                  setPromptId(run.promptId);
                  setPane("detail");
                }}
                aria-current={activeSessionId === run.id ? "true" : undefined}
                className={cn(
                  "mb-2 w-full rounded-panel border p-3 text-left transition-colors",
                  activeSessionId === run.id
                    ? "border-line-strong bg-surface-3"
                    : "border-line bg-surface-2 hover:bg-surface-3",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-[13px] text-fg">{run.promptKey ?? run.promptTitle}</span>
                  <Badge
                    tone={
                      run.state === "RUNNING" || run.state === "STARTING"
                        ? "info"
                        : run.state === "DONE"
                          ? "success"
                          : run.state === "ERROR"
                            ? "danger"
                            : "warning"
                    }
                  >
                    {run.state.toLowerCase()}
                  </Badge>
                </div>
                <div className="mt-1 truncate text-xs text-fg-muted">
                  {run.provider}
                  {run.model !== null && ` · ${run.model}`}
                </div>
                <div className="mt-1 text-[10px] text-fg-dim">{new Date(run.startedAt).toLocaleString()}</div>
              </button>
            ))
          )}
        </aside>

        {/* Detail ----------------------------------------------------------- */}
        <section
          className={cn(
            "min-w-0 overflow-y-auto p-5 xl:block",
            pane === "detail" ? "block" : "hidden",
          )}
        >
          {item === null ? (
            <p className="text-sm text-fg-dim">Select a work item to inspect its sessions and interventions.</p>
          ) : (
            <div className="mx-auto max-w-5xl space-y-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <Badge tone={TONE[item.operationalState]} dot pulse={item.operationalState === "WORKING"}>
                    {LABEL[item.operationalState]}
                  </Badge>
                  <h2 className="mt-1.5 text-xl text-fg">
                    {item.prompt.externalKey !== null && `${item.prompt.externalKey} — `}
                    {item.prompt.title}
                  </h2>
                  <p className="mt-1 text-xs text-fg-dim">
                    {item.workspace.name} · {item.prompt.programName} / {item.prompt.suiteName}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {item.operationalState === "READY" && suite?.pipeline?.active?.state !== "PLAYING" && (
                    <Button size="sm" variant="success" disabled={!canStart || busy} onClick={start}>
                      {waitingPipeline(item.prompt.id) !== null || suite?.pipeline?.active?.state === "PAUSED"
                        ? "Resume pipeline"
                        : "Run work item"}
                    </Button>
                  )}
                  {item.operationalState === "RECOVERY_NEEDED" && suite?.pipeline?.active?.state !== "PLAYING" && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => recoverAndResume()}>
                      Recover and resume
                    </Button>
                  )}
                  {item.operationalState === "WORKING" && item.prompt.currentRun !== null && (
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void stopAgent()}>
                      Stop agent
                    </Button>
                  )}
                  <Link
                    href={`/?workspace=${item.workspace.id}&prompt=${item.prompt.id}`}
                    className="rounded-md px-3 py-1.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    Open in Console
                  </Link>
                </div>
              </div>

              <StationRules
                rule={item.pipelineRule}
                disabled={item.operationalState === "WORKING"}
                providers={console_.providers}
                models={models}
                fallbackProvider={provider}
                onChange={(patch) => patchRule(item.prompt.id, patch)}
              />

              {suite !== null && (
                <VerificationPanel
                  key={suite.id}
                  suite={suite}
                  provider={provider}
                  model={selectedModel}
                  workspaceBusy={workspaceBusy(suite.workspaceId) || suite.pipeline?.active?.state === "PLAYING"}
                />
              )}

              {item.latestIntervention !== null && (
                <div className="rounded-panel border border-warning/30 bg-warning/5 p-4">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-warning">
                    Latest intervention
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-6">{item.latestIntervention}</div>
                </div>
              )}

              {item.operationalState === "AWAITING_RESPONSE" && (
                <div className="rounded-panel border border-line bg-surface-1 p-4">
                  <TextArea
                    label="Your response"
                    rows={4}
                    value={response}
                    hint="Answer the blocker, or leave blank to retry with the existing context. Configure secrets outside this box."
                    placeholder="What the agent needs to know to continue…"
                    onChange={(event) => setResponse(event.target.value)}
                  />
                  <div className="mt-3">
                    <Button variant="success" disabled={!canStart || busy} onClick={respond}>
                      Respond and resume
                    </Button>
                  </div>
                </div>
              )}

              <div className="grid gap-4 2xl:grid-cols-2">
                <section className="rounded-panel border border-line bg-surface-1 p-4">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    Sessions · {item === null ? 0 : activity?.sessions.length ?? 0}
                  </h3>
                  {item === null || activity === null || activity.sessions.length === 0 ? (
                    <p className="text-sm text-fg-dim">No sessions yet.</p>
                  ) : (
                    activity.sessions.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => setSessionId(run.id)}
                        aria-current={activeSessionId === run.id ? "true" : undefined}
                        className={cn(
                          "mb-2 w-full rounded-md border p-3 text-left transition-colors",
                          activeSessionId === run.id
                            ? "border-line-strong bg-surface-3"
                            : "border-line bg-surface-2 hover:bg-surface-3",
                        )}
                      >
                        <div className="flex justify-between gap-2 text-xs">
                          <span>
                            {run.provider}
                            {run.model !== null && ` · ${run.model}`}
                          </span>
                          <Badge
                            tone={run.state === "DONE" ? "success" : run.state === "RUNNING" ? "info" : "warning"}
                          >
                            {run.state.toLowerCase()}
                          </Badge>
                        </div>
                        <div className="mt-1 text-[10px] text-fg-dim">
                          {new Date(run.startedAt).toLocaleString()} · {run.events.length} events
                        </div>
                      </button>
                    ))
                  )}
                </section>

                <section className="rounded-panel border border-line bg-surface-1 p-4">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    Issues and activity · {timeline.length}
                  </h3>
                  {timeline.length === 0 ? (
                    <p className="text-sm text-fg-dim">Nothing recorded yet.</p>
                  ) : (
                    <div className="max-h-96 overflow-y-auto">
                      {timeline.map((entry) => (
                        <div key={entry.id} className={cn("mb-4 border-l-2 pl-3", entry.tone)}>
                          <div className="text-[10px] uppercase tracking-wider text-fg-dim">
                            {entry.label} · {new Date(entry.at).toLocaleString()}
                          </div>
                          {entry.text !== "" && (
                            <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-fg-muted">
                              {entry.text}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {selectedSession !== null && (
                <section>
                  <div className="mb-2 text-xs uppercase tracking-wider text-fg-dim">
                    Session log · {selectedSession.provider} · {selectedSession.state.toLowerCase()}
                  </div>
                  {logs.length === 0 ? (
                    <p className="rounded-panel border border-line p-4 text-sm text-fg-dim">
                      No event stream was captured for this session.
                    </p>
                  ) : (
                    <div className="flex h-[55vh] min-h-0 flex-col overflow-hidden rounded-panel border border-line">
                      <LogPanel items={logs} workdir={item.workspace.workDirectory} />
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </section>
      </div>

      <StatusBar
        connection={console_.connection}
        provider={providerInfo ?? undefined}
        model={selectedModel}
        run={console_.run}
        lastRun={console_.lastRun}
        workdir={item?.workspace.workDirectory ?? console_.workdir}
      />

      {settingsOpen && (
        <SettingsPanel
          serverUrl={SERVER_URL}
          onClose={() => setSettingsOpen(false)}
          runInProgress={console_.runs.length > 0}
        />
      )}
    </main>
  );
}

function FilterButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: Tone;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs ring-1 ring-inset transition-colors",
        active && tone === "warning" && "bg-warning/12 text-warning ring-warning/40",
        active && tone === "info" && "bg-info/12 text-info ring-info/40",
        active && tone === "neutral" && "bg-surface-3 text-fg ring-line-strong",
        !active && "text-fg-dim ring-line hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

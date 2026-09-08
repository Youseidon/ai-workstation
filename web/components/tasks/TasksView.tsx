"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DEFAULT_STATUS_CATALOG, DEFAULT_TRIGGER_SENTENCES } from "@agent-console/shared";
import type { OperationsPrompt, OperationsSnapshot } from "@agent-console/shared";
import { PageChrome } from "@/components/shell/chrome";
import { VerificationPanel } from "@/components/VerificationPanel";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { SuiteHeader } from "@/components/tasks/SuiteHeader";
import { SuiteRail } from "@/components/tasks/SuiteRail";
import { WorkItemDetail } from "@/components/tasks/WorkItemDetail";
import { WorkItemList } from "@/components/tasks/WorkItemList";
import {
  findOperationsPromptInSuite,
  findParentPrompt,
  suiteContainsPrompt,
  type TasksFilter,
} from "@/components/tasks/tree";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";

type Pane = "suites" | "list" | "detail";

const DETAIL_HEIGHT_KEY = "agent-console.tasks-detail-height";
const DETAIL_COLLAPSED_KEY = "agent-console.tasks-detail-collapsed";
const DETAIL_HEIGHT_DEFAULT = 320;
const DETAIL_HEIGHT_MIN = 160;
const DETAIL_HEIGHT_MAX_RATIO = 0.75;

function clampDetailHeight(value: number): number {
  const max = Math.max(DETAIL_HEIGHT_MIN, Math.floor(window.innerHeight * DETAIL_HEIGHT_MAX_RATIO));
  return Math.min(max, Math.max(DETAIL_HEIGHT_MIN, Math.round(value)));
}

export function TasksView() {
  const console_ = useAgentConsole();
  const { operationsRevision } = console_;
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const dialogs = useDialogs();
  const params = useSearchParams();

  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Awaited<ReturnType<typeof workspaceApi.activity>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [response, setResponse] = useState("");
  const [pane, setPane] = useState<Pane>("list");
  const [focusRecordId, setFocusRecordId] = useState<number | null>(null);
  const [detailHeight, setDetailHeight] = useState(DETAIL_HEIGHT_DEFAULT);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [dockReady, setDockReady] = useState(false);
  const detailHeightRef = useRef(detailHeight);
  const resizeActiveRef = useRef(false);
  detailHeightRef.current = detailHeight;

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
  const [filter, setFilter] = useState<TasksFilter>(() => {
    const value = params.get("filter");
    // Legacy deep links used filter=attention; the chip is now "Needs you".
    return value === "attention" || value === "working" ? value : "all";
  });
  const { selected: provider } = usePreferredProvider(console_.providers);

  const refresh = useCallback(() => {
    if (workspaceId === null) {
      setSnapshot(null);
      setLoadError(null);
      return Promise.resolve();
    }
    return workspaceApi
      .operations(SERVER_URL, workspaceId)
      .then((value) => {
        setSnapshot(value);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Operations could not be loaded.");
      });
  }, [workspaceId]);

  useEffect(() => {
    // Operations catalog for the selected workspace.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async catalog fetch
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh, operationsRevision]);

  useEffect(() => {
    // Restore dock preferences after mount (SSR has no localStorage).
    try {
      const rawHeight = window.localStorage.getItem(DETAIL_HEIGHT_KEY);
      if (rawHeight !== null) {
        const parsed = Number(rawHeight);
        if (Number.isFinite(parsed)) setDetailHeight(clampDetailHeight(parsed));
      }
      setDetailCollapsed(window.localStorage.getItem(DETAIL_COLLAPSED_KEY) === "1");
    } catch {
      // Ignore storage failures (private mode, quota, etc.).
    }
    setDockReady(true);
  }, []);

  useEffect(() => {
    if (!dockReady) return;
    try {
      window.localStorage.setItem(DETAIL_HEIGHT_KEY, String(detailHeight));
    } catch {
      // Ignore storage failures.
    }
  }, [detailHeight, dockReady]);

  useEffect(() => {
    if (!dockReady) return;
    try {
      window.localStorage.setItem(DETAIL_COLLAPSED_KEY, detailCollapsed ? "1" : "0");
    } catch {
      // Ignore storage failures.
    }
  }, [detailCollapsed, dockReady]);

  const beginResize = useCallback((event: { button: number; clientY: number; preventDefault(): void }) => {
    if (event.button !== 0 || resizeActiveRef.current) return;
    event.preventDefault();
    resizeActiveRef.current = true;
    const startY = event.clientY;
    const startHeight = detailHeightRef.current;
    setResizing(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent | PointerEvent) => {
      // Dragging the top edge up grows the panel; down shrinks it.
      setDetailHeight(clampDetailHeight(startHeight + (startY - moveEvent.clientY)));
    };
    const onUp = () => {
      resizeActiveRef.current = false;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // Listen to both pointer and mouse — some automation drivers only emit mouse events.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Everything below is derived, not synchronised                           */
  /* ---------------------------------------------------------------------- */

  const suites = snapshot?.suites ?? [];
  // A deep-linked prompt implies its suite, even before the user picks one.
  const suite =
    suites.find((item) => item.id === suiteId) ??
    (promptId === null ? undefined : suites.find((item) => suiteContainsPrompt(item, promptId))) ??
    suites[0] ??
    null;

  // Prefer the deep-linked / clicked id when it exists anywhere in the tree;
  // otherwise fall back to the first station root.
  const activePromptId =
    suite !== null && promptId !== null && findOperationsPromptInSuite(suite, promptId) !== null
      ? promptId
      : (suite?.prompts[0]?.prompt.id ?? null);

  const providerInfo = console_.providers.find((item) => item.id === provider) ?? null;
  const models = useModelSelection(console_.providers);
  const selectedModel = models.resolve(provider);
  const workspaceBusy = (id: number) =>
    console_.runs.some((item) => item.workspace.id === id && item.role === "execute");

  const liveVerification =
    suite === null
      ? null
      : (console_.runs.find(
          (run) => run.source.type === "verification" && run.source.suiteId === suite.id,
        ) ?? null);

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
    const query = new URLSearchParams({ suite: String(suite.id) });
    if (activePromptId !== null) query.set("prompt", String(activePromptId));
    if (filter !== "all") query.set("filter", filter);
    window.history.replaceState(null, "", `/tasks?${query.toString()}`);
  }, [suite, activePromptId, filter]);

  // Only trust the fetched activity when it belongs to the row that is
  // actually selected — the fetch is async and the selection can move under it.
  const item =
    activity !== null && activity.item.prompt.id === activePromptId ? activity.item : null;
  const listItem =
    (suite !== null && activePromptId !== null
      ? findOperationsPromptInSuite(suite, activePromptId)
      : null) ?? item;
  const parentItem =
    suite !== null && listItem !== null
      ? findParentPrompt(suite.prompts, listItem.prompt.id)
      : null;
  const canStart =
    console_.connection === "open" &&
    listItem !== null &&
    !workspaceBusy(listItem.workspace.id) &&
    providerInfo?.available === true &&
    listItem.workspace.workDirectoryExists;

  const canAct = (entry: OperationsPrompt) =>
    console_.connection === "open" &&
    !workspaceBusy(entry.workspace.id) &&
    providerInfo?.available === true &&
    entry.workspace.workDirectoryExists;

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

  const start = (target: OperationsPrompt | null = listItem) => {
    if (target === null || !canAct(target)) return;
    const ok = console_.startRun(
      target.workspace.id,
      provider,
      { promptId: target.prompt.id },
      selectedModel,
    );
    if (!ok) toast.error("Could not start", "The agent connection is unavailable.");
  };

  /**
   * Records a parked station as DONE with the evidence in the response box,
   * without spending an agent run to re-report work that is already finished.
   */
  const markComplete = (target: OperationsPrompt | null = listItem) =>
    void act(async () => {
      if (target === null) return;
      await workspaceApi.completePrompt(SERVER_URL, target.prompt.id, response.trim());
      setResponse("");
    }, "Marked complete");

  const respond = () =>
    void act(async () => {
      if (listItem === null) return;
      await workspaceApi.respond(
        SERVER_URL,
        listItem.prompt.id,
        response.trim() ||
          "Retry requested with no additional context. Inspect the existing working tree and prior evidence, then continue incomplete work without repeating resolved blockers.",
      );
      setResponse("");
      if (
        !console_.startRun(
          listItem.workspace.id,
          provider,
          { promptId: listItem.prompt.id },
          selectedModel,
        )
      ) {
        throw new Error("Response saved, but the agent connection was unavailable. Run it from Chat.");
      }
    }, "Response sent");

  const recoverAndResume = (target: OperationsPrompt | null = listItem) =>
    void act(async () => {
      if (target === null) return;
      await workspaceApi.recover(SERVER_URL, target.prompt.id);
      if (
        !console_.startRun(
          target.workspace.id,
          provider,
          { promptId: target.prompt.id },
          selectedModel,
        )
      ) {
        throw new Error("Recovered, but the agent connection was unavailable. Run it from Chat.");
      }
      setFilter("all");
    }, "Recovered and resumed");

  /**
   * Ask a different, read-only agent whether the work is already done. Only
   * offered on a station whose run vanished without posting a status — the
   * server refuses it for a station that asked a human a question.
   */
  const auditCompletion = (target: OperationsPrompt | null = listItem) =>
    void act(async () => {
      if (target === null) return;
      await workspaceApi.startAudit(SERVER_URL, target.prompt.id);
    }, "Audit started");

  const stopAgent = async (target: OperationsPrompt | null = listItem) => {
    if (target?.prompt.currentRun == null) return;
    const confirmed = await dialogs.confirm({
      title: "Stop this agent run?",
      description: "Its work so far and its logs are preserved. The work item will need recovery to continue.",
      confirmLabel: "Stop agent",
      tone: "danger",
    });
    if (!confirmed) return;
    await act(async () => {
      await workspaceApi.interruptRun(SERVER_URL, target.prompt.currentRun!.id);
    }, "Agent stopped");
  };

  const verifySuite = async () => {
    if (suite === null) return;
    const itemCount = suite.prompts.length;
    const confirmed = await dialogs.confirm({
      title: "Verify suite with agent?",
      description: (
        <>
          Starts a real agent run with <b className="text-fg-muted">{providerInfo?.label ?? provider}</b>
          {selectedModel !== null && (
            <>
              {" "}
              · <b className="text-fg-muted">{selectedModel}</b>
            </>
          )}{" "}
          against {itemCount} work item{itemCount === 1 ? "" : "s"}. It changes nothing in the working
          tree and writes a report that is kept.
        </>
      ),
      confirmLabel: "Start verification",
    });
    if (!confirmed) return;
    if (!console_.verifySuite(suite.id, provider, selectedModel)) {
      toast.error("Could not start verification", "The agent connection is unavailable.");
      return;
    }
    toast.info("Verification started", `${suite.key ?? suite.name} is being checked by ${provider}.`);
  };

  const auditSuite = async () => {
    if (suite === null) return;
    const itemCount = suite.prompts.length;
    const confirmed = await dialogs.confirm({
      title: "Audit recorded evidence?",
      description: `No agent runs. This re-reads the evidence already stored for each of the ${itemCount} work item${itemCount === 1 ? "" : "s"} and writes a dated audit record with a verdict. Your working tree is not read or changed.`,
      confirmLabel: "Run audit",
    });
    if (!confirmed) return;
    setAuditing(true);
    try {
      const record = await workspaceApi.auditSuite(SERVER_URL, suite.id);
      await refresh();
      setFocusRecordId(record.id);
      toast.success("Audit recorded", `Verdict ${record.verdict} from the saved evidence.`);
    } catch (error) {
      toast.error("Audit failed", error instanceof Error ? error.message : String(error));
    } finally {
      setAuditing(false);
    }
  };

  const verifyWorkItem = async () => {
    if (suite === null || listItem === null) return;
    const confirmed = await dialogs.confirm({
      title: "Verify this work item?",
      description: (
        <>
          Starts a real agent run with <b className="text-fg-muted">{providerInfo?.label ?? provider}</b>
          {selectedModel !== null && (
            <>
              {" "}
              · <b className="text-fg-muted">{selectedModel}</b>
            </>
          )}{" "}
          scoped to{" "}
          <b className="text-fg-muted">
            {listItem.prompt.externalKey ?? listItem.prompt.title}
          </b>
          . It changes nothing in the working tree and writes a report that is kept.
        </>
      ),
      confirmLabel: "Start verification",
    });
    if (!confirmed) return;
    if (!console_.verifySuite(suite.id, provider, selectedModel, listItem.prompt.id)) {
      toast.error("Could not start verification", "The agent connection is unavailable.");
      return;
    }
    toast.info(
      "Verification started",
      `${listItem.prompt.externalKey ?? listItem.prompt.title} is being checked by ${provider}.`,
    );
  };

  const selectSuite = (id: number) => {
    setSuiteId(id);
    setPromptId(null);
    setPane("list");
  };

  const selectPrompt = (id: number) => {
    setPromptId(id);
    setPane("detail");
    setDetailCollapsed(false);
  };

  const detailProps = {
    suite,
    item: listItem,
    parent: parentItem,
    activity,
    // From the snapshot, not the shipped defaults, so a status the operator has
    // renamed reads the same here as it does on the board. The defaults stand
    // in only for the moment before the first snapshot arrives.
    statusCatalog: snapshot?.statusCatalog ?? DEFAULT_STATUS_CATALOG,
    triggerSentences: snapshot?.triggerSentences ?? DEFAULT_TRIGGER_SENTENCES,
    response,
    busy,
    canStart,
    verifyingItem: liveVerification !== null,
    connectionOpen: console_.connection === "open",
    providerLabel: providerInfo?.label ?? provider,
    model: selectedModel,
    onResponseChange: setResponse,
    onRun: () => start(),
    onStop: () => void stopAgent(),
    onRecover: () => recoverAndResume(),
    onAudit: () => auditCompletion(),
    onRespond: respond,
    onComplete: () => markComplete(),
    onVerifyItem: () => void verifyWorkItem(),
    onSelectChild: selectPrompt,
  } as const;

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-0 text-fg">
      <PageChrome title="Tasks" />

      {loadError !== null && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger"
        >
          <span className="min-w-0 flex-1">Live operations are unavailable: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
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
            {option === "suites" ? "Suites" : option === "list" ? "Work items" : "Detail"}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)]">
          <div
            className={cn(
              // Sized flex column so SuiteRail's internal list scroll can activate.
              "flex min-h-0 flex-col overflow-hidden",
              pane !== "suites" && "max-xl:hidden",
            )}
          >
            <SuiteRail
              suites={suites}
              selectedSuiteId={suite?.id ?? null}
              loading={snapshot === null && loadError === null}
              onSelect={selectSuite}
            />
          </div>

          <section
            className={cn(
              "min-h-0 overflow-y-auto p-4",
              pane !== "list" && "max-xl:hidden",
            )}
          >
            {suite === null ? (
              <p className="text-sm text-fg-dim">Select a suite to see its work items.</p>
            ) : (
              <div className="w-full space-y-4">
                <SuiteHeader
                  suite={suite}
                  providerLabel={providerInfo?.label ?? provider}
                  model={selectedModel}
                  workspaceBusy={workspaceBusy(suite.workspaceId)}
                  connectionOpen={console_.connection === "open"}
                  verifying={liveVerification !== null}
                  auditing={auditing}
                  onVerifySuite={() => void verifySuite()}
                  onAuditSuite={() => void auditSuite()}
                />

                <VerificationPanel
                  key={suite.id}
                  suite={suite}
                  provider={provider}
                  model={selectedModel}
                  workspaceBusy={workspaceBusy(suite.workspaceId)}
                  defaultCollapsed
                  hideActions
                  focusRecordId={focusRecordId}
                  onFocusHandled={() => setFocusRecordId(null)}
                />

                <WorkItemList
                  suite={suite}
                  filter={filter}
                  activePromptId={activePromptId}
                  busy={busy}
                  providerLabel={providerInfo?.label ?? provider}
                  canAct={canAct}
                  onFilterChange={setFilter}
                  onSelect={selectPrompt}
                  onRun={(entry) => start(entry)}
                  onStop={(entry) => void stopAgent(entry)}
                  onRecover={(entry) => recoverAndResume(entry)}
                  onRespond={(entry) => {
                    selectPrompt(entry.prompt.id);
                  }}
                />
              </div>
            )}
          </section>
        </div>

        {/* Mobile: full-screen detail sheet. Desktop: bottom dock. */}
        <aside
          className={cn(
            "border-line bg-surface-1",
            pane === "detail"
              ? "fixed inset-0 z-20 flex flex-col xl:static xl:z-auto"
              : "hidden xl:flex xl:flex-col",
            "xl:shrink-0 xl:border-t",
            resizing && "xl:select-none",
          )}
        >
          <div className="hidden xl:block">
            {detailCollapsed ? (
              <button
                type="button"
                onClick={() => setDetailCollapsed(false)}
                className="flex w-full items-center gap-3 bg-surface-1 px-4 py-2 text-left transition-colors hover:bg-surface-2"
                aria-expanded={false}
                aria-label="Expand detail panel"
                title="Expand detail panel"
              >
                <span className="text-fg-dim" aria-hidden>
                  ▴
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
                  {listItem === null
                    ? "Work item detail"
                    : `${listItem.prompt.externalKey !== null ? `${listItem.prompt.externalKey} — ` : ""}${listItem.prompt.title}`}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-fg-dim">
                  Expand
                </span>
              </button>
            ) : (
              <div
                className={cn(
                  "flex h-7 items-center gap-1 bg-surface-1 pr-1 hover:bg-surface-2",
                  resizing && "bg-surface-2",
                )}
              >
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize detail panel"
                  aria-valuenow={detailHeight}
                  aria-valuemin={DETAIL_HEIGHT_MIN}
                  onPointerDown={beginResize}
                  onMouseDown={beginResize}
                  className="group flex h-full min-w-0 flex-1 cursor-row-resize items-center justify-center"
                >
                  <div
                    className={cn(
                      "h-1 w-10 rounded-full bg-line-strong/70 transition-colors group-hover:bg-fg-dim",
                      resizing && "bg-fg-dim",
                    )}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  iconLeft={<span aria-hidden>▾</span>}
                  onClick={() => setDetailCollapsed(true)}
                  aria-label="Collapse detail panel"
                  title="Collapse detail panel"
                  className="shrink-0"
                />
              </div>
            )}
          </div>

          {/* Desktop dock body */}
          {!detailCollapsed && (
            <div className="hidden min-h-0 flex-col xl:flex" style={{ height: detailHeight }}>
              <WorkItemDetail
                {...detailProps}
                onClose={() => {
                  setDetailCollapsed(true);
                  setPane("list");
                }}
              />
            </div>
          )}

          {/* Mobile full-sheet body */}
          {pane === "detail" && (
            <div className="flex min-h-0 flex-1 flex-col xl:hidden">
              <WorkItemDetail {...detailProps} onClose={() => setPane("list")} />
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

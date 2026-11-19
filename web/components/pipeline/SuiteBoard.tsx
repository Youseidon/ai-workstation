"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_STATUS_CATALOG, DEFAULT_TRIGGER_SENTENCES } from "@agent-console/shared";
import type { OperationsPrompt, OperationsSnapshot, PipelineRecord } from "@agent-console/shared";
import { ContentTitle } from "@/components/shell/PageCanvas";
import { DetailDrawer, DetailReopen } from "@/components/shell/DetailDrawer";
import { SidebarBack, SidebarCollection, SidebarEmpty, SidebarGroup, SidebarRow } from "@/components/shell/SidebarCollection";
import { VerificationPanel } from "@/components/VerificationPanel";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { SnakeFlow } from "./SnakeFlow";
import { StationCard } from "./StationCard";
import { stationOccupancy } from "./status";
import { HumanGate } from "./station/HumanGate";
import { collectInbox, NeedsYouInbox } from "./station/NeedsYouInbox";
import { StationPanel, type StationTab } from "./station/StationPanel";
import { countStations, filterPromptTree, findOperationsPromptInSuite, findParentPrompt, isTerminal, type WorkFilter } from "./station/tree";
import { useBoardKeys } from "./station/useBoardKeys";
import { useStationActions } from "./station/useStationActions";
import { WorkList } from "./station/WorkList";

type Layout = "flow" | "list";

function positiveInt(raw: string | null): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A suite that no pipeline drives. Same layout, panel and action footer as the
 * pipeline board; there is no Play/Pause because there is no rail — each item
 * runs on its own from the panel.
 */
export function SuiteBoard({ suiteId }: { suiteId: number }) {
  const console_ = useAgentConsole();
  const router = useRouter();
  const params = useSearchParams();
  const { workspaceId } = useWorkspace();
  const models = useModelSelection(console_.providers);
  const { selected: preferredProvider } = usePreferredProvider(console_.providers);

  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(() => positiveInt(params.get("prompt")));
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMode, setPanelMode] = useState<"item" | "verify">(() => (positiveInt(params.get("prompt")) !== null ? "item" : "verify"));
  const [itemTab, setItemTab] = useState<StationTab>(() => (params.get("tab") === "conversation" ? "conversation" : "overview"));
  const [focusSignal, setFocusSignal] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => (params.get("view") === "flow" ? "flow" : "list"));
  const [filter, setFilter] = useState<WorkFilter>(() => {
    const value = params.get("filter");
    return value === "attention" || value === "working" ? value : "all";
  });
  const [focusRecordId, setFocusRecordId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (workspaceId === null) return;
    try {
      const [operations, named] = await Promise.all([
        workspaceApi.operations(SERVER_URL, workspaceId),
        workspaceApi.listPipelines(SERVER_URL, workspaceId),
      ]);
      setSnapshot(operations);
      setPipelines(named);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Suite could not be loaded.");
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async catalog fetch, same pattern as the pipeline board
    void refresh();
  }, [refresh, console_.operationsRevision]);

  const suite = snapshot?.suites.find((entry) => entry.id === suiteId) ?? null;
  const inPipelines = pipelines.filter((pipeline) => pipeline.stages.some((stage) => stage.suiteId === suiteId));
  const actions = useStationActions({ pipelineId: null, pipelineState: null, refresh });

  const selectedItem = suite === null || selectedId === null ? null : findOperationsPromptInSuite(suite, selectedId);
  const parent = suite === null || selectedItem === null ? null : findParentPrompt(suite.prompts, selectedItem.prompt.id);
  const inbox = suite === null ? [] : collectInbox([suite]);

  const select = (promptId: number, tab?: StationTab) => {
    setSelectedId(promptId);
    setPanelMode("item");
    setPanelOpen(true);
    if (tab !== undefined) setItemTab(tab);
  };
  const reply = (promptId: number) => {
    select(promptId, "conversation");
    setFocusSignal((value) => value + 1);
  };
  const closePanel = () => {
    setPanelOpen(false);
    setSelectedId(null);
    setPanelMode("verify");
  };

  const order = useMemo(() => {
    const ids: number[] = [];
    const walk = (list: OperationsPrompt[]) => {
      for (const item of list) {
        ids.push(item.prompt.id);
        if (layout === "list") walk(item.children);
      }
    };
    walk(layout === "list" ? filterPromptTree(suite?.prompts ?? [], filter) : (suite?.prompts ?? []));
    return ids;
  }, [suite, layout, filter]);

  useBoardKeys({ order, selectedId, panelOpen, select: (id) => select(id), reply, closePanel });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- viewport is unknown during SSR
    if (positiveInt(params.get("prompt")) === null && !window.matchMedia("(min-width: 1280px)").matches) setPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first paint only
  }, []);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedId !== null && panelMode === "item") next.set("prompt", String(selectedId));
    if (layout === "flow") next.set("view", "flow");
    if (layout === "list" && filter !== "all") next.set("filter", filter);
    const query = next.toString();
    window.history.replaceState(window.history.state, "", `/pipeline/suite/${suiteId}${query === "" ? "" : `?${query}`}`);
  }, [suiteId, selectedId, panelMode, layout, filter]);

  const verifying = console_.runs.some((run) => run.source.type === "verification" && run.source.suiteId === suiteId);
  const stations = countStations(suite?.prompts ?? []);

  const menu: MenuItem[] = [
    { id: "layout", label: layout === "flow" ? "Show as list" : "Show as flow", onSelect: () => setLayout(layout === "flow" ? "list" : "flow"), className: "sm:hidden" },
    {
      id: "verify",
      label: "Verify suite with agent…",
      disabled: suite === null || actions.busy,
      onSelect: () => {
        if (suite === null) return;
        void actions.verify(suite, null).then((started) => {
          if (started) {
            setPanelMode("verify");
            setPanelOpen(true);
          }
        });
      },
    },
    {
      id: "audit",
      label: "Audit recorded evidence…",
      disabled: suite === null || actions.busy,
      onSelect: () => {
        if (suite === null) return;
        void actions.auditEvidence(suite).then((id) => {
          if (id === null) return;
          setFocusRecordId(id);
          setPanelMode("verify");
          setPanelOpen(true);
        });
      },
    },
    { id: "new", label: "Build a pipeline…", onSelect: () => router.push("/pipeline/new"), separated: true },
    {
      id: "chat",
      label: "Open workspace in Chat",
      disabled: suite === null,
      onSelect: () => router.push(`/?workspace=${suite?.workspaceId ?? ""}`),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col text-fg">
      <ContentTitle
        title={suite === null ? "Suite" : `${suite.key !== null ? `${suite.key} · ` : ""}${suite.name}`}
        meta={suite === null ? undefined : <>Suite · {suite.programName}</>}
        actions={
          <div className="flex items-center gap-2">
            <div className="hidden rounded-md bg-surface-2 p-0.5 ring-1 ring-inset ring-line sm:flex" role="radiogroup" aria-label="Layout">
              {(["flow", "list"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={layout === option}
                  onClick={() => setLayout(option)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs capitalize transition-colors",
                    layout === option ? "bg-surface-3 text-fg shadow-sm" : "text-fg-dim hover:text-fg",
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            <Menu items={menu} label="Suite actions" />
          </div>
        }
      />

      <SidebarCollection label="Suite">
        <SidebarBack href="/pipeline">All pipelines</SidebarBack>
        {suite === null ? (
          <SidebarEmpty><span role="status">{snapshot === null ? "Loading suite…" : "This suite is not in the selected workspace."}</span></SidebarEmpty>
        ) : (
          <SidebarGroup title={suite.programName}>
            <SidebarRow selected title={`${suite.key !== null ? `${suite.key} · ` : ""}${suite.name}`} />
          </SidebarGroup>
        )}
      </SidebarCollection>

      {loadError !== null && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">{loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]", "grid-cols-1")}>
        <section className="min-h-0 overflow-auto">
          <div className="w-full space-y-5 px-5 pb-10">
            {suite === null ? (
              snapshot === null ? (
                <div className="space-y-3 pt-5">
                  <Skeleton className="h-10 w-1/2" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <p className="pt-5 text-sm text-fg-dim">This suite is not in the selected workspace.</p>
              )
            ) : (
              <>
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="h-full rounded-full bg-success transition-[width]"
                        style={{ width: `${stations.total === 0 ? 0 : Math.round((stations.done / stations.total) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-fg-dim">
                      {stations.done}/{stations.total} done
                    </span>
                  </div>
                </div>

                {/* Same bar as a pipeline's, without the transport. */}
                <div className="sticky top-0 z-20 -mx-5 bg-surface-0 px-5 py-2">
                  <div className="flex flex-wrap items-center gap-3 rounded-panel border border-line bg-surface-1 px-4 py-2.5">
                    <p className="min-w-0 flex-1 text-xs leading-5 text-fg-muted">
                      {inPipelines.length === 0 ? (
                        <>No pipeline drives this suite — run items one at a time from the panel.</>
                      ) : (
                        <>
                          Driven by{" "}
                          {inPipelines.map((pipeline, index) => (
                            <span key={pipeline.id}>
                              {index > 0 && ", "}
                              <Link href={`/pipeline/${pipeline.id}?suite=${suiteId}`} className="text-accent hover:underline">
                                {pipeline.name}
                              </Link>
                            </span>
                          ))}
                          . Running items here skips the rail&apos;s order.
                        </>
                      )}
                    </p>
                    <NeedsYouInbox entries={inbox} onOpen={(entry) => reply(entry.item.prompt.id)} />
                  </div>
                </div>

                {layout === "list" ? (
                  <WorkList
                    items={suite.prompts}
                    filter={filter}
                    selectedId={selectedId}
                    currentId={null}
                    onFilterChange={setFilter}
                    onSelect={(id) => select(id)}
                  />
                ) : suite.prompts.length === 0 ? (
                  <p className="text-sm text-fg-dim">This suite has no work items.</p>
                ) : (
                  <SnakeFlow
                    items={suite.prompts}
                    getKey={(item) => item.prompt.id}
                    renderGate={(item) =>
                      item.humanIntervention === null ? null : (
                        <HumanGate
                          step={item.humanIntervention}
                          selected={selectedId === item.prompt.id && itemTab === "conversation"}
                          onOpen={() => reply(item.prompt.id)}
                        />
                      )
                    }
                    renderCard={(item, index) => (
                      <StationCard
                        index={index}
                        item={item}
                        rule={item.pipelineRule}
                        current={false}
                        occupancy={stationOccupancy(item, console_.runs, null)}
                        selected={selectedId === item.prompt.id && panelOpen && panelMode === "item"}
                        readOnly
                        subSteps={
                          item.children.length > 0
                            ? { done: item.children.filter(isTerminal).length, total: item.children.length }
                            : undefined
                        }
                        onSelect={() => select(item.prompt.id)}
                      />
                    )}
                  />
                )}
              </>
            )}
          </div>
        </section>

        <DetailDrawer
          open={panelOpen}
          onClose={closePanel}
          label={panelMode === "item" ? "Item details" : "Verification"}
          header={
            <div className="app-detail-tabs" role="tablist" aria-label="Details">
              <button type="button" role="tab" aria-selected={panelMode === "item"} disabled={selectedItem === null} onClick={() => setPanelMode("item")}>
                {selectedItem?.prompt.externalKey ?? "Item"}
              </button>
              <button type="button" role="tab" aria-selected={panelMode === "verify"} onClick={() => setPanelMode("verify")}>
                Verify
              </button>
            </div>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
                {panelMode === "item" && selectedItem !== null ? (
                  <StationPanel
                    key={selectedItem.prompt.id}
                    suite={suite}
                    item={selectedItem}
                    parent={parent}
                    statusCatalog={snapshot?.statusCatalog ?? DEFAULT_STATUS_CATALOG}
                    triggerSentences={snapshot?.triggerSentences ?? DEFAULT_TRIGGER_SENTENCES}
                    revision={`${console_.operationsRevision}:${selectedItem.lastActivityAt}:${selectedItem.operationalState}`}
                    actions={actions}
                    tab={itemTab}
                    onTabChange={setItemTab}
                    focusSignal={focusSignal}
                    onFocusComposer={() => reply(selectedItem.prompt.id)}
                    running={stationOccupancy(selectedItem, console_.runs, null) !== null}
                    verifying={verifying}
                    onSelect={(id) => select(id)}
                  />
                ) : suite !== null ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="min-h-0 flex-1 overflow-y-auto p-3">
                      <VerificationPanel
                        key={suite.id}
                        suite={suite}
                        provider={preferredProvider}
                        model={models.resolve(preferredProvider)}
                        workspaceBusy={console_.runs.some((run) => run.workspace.id === suite.workspaceId && run.role === "execute")}
                        focusRecordId={focusRecordId}
                        onFocusHandled={() => setFocusRecordId(null)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
        </DetailDrawer>
      </div>

      {!panelOpen && (
        <DetailReopen onClick={() => setPanelOpen(true)}>
          Show details
        </DetailReopen>
      )}
    </div>
  );
}

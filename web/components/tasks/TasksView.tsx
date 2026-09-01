"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { OperationsPrompt, OperationsSnapshot } from "@agent-console/shared";
import { PageChrome } from "@/components/shell/chrome";
import { VerificationPanel } from "@/components/VerificationPanel";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { SuiteHeader } from "@/components/tasks/SuiteHeader";
import { SuiteRail } from "@/components/tasks/SuiteRail";
import { WorkItemDetail } from "@/components/tasks/WorkItemDetail";
import { WorkItemList, type TasksFilter } from "@/components/tasks/WorkItemList";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { workspaceApi } from "@/lib/workspacesApi";

type Pane = "suites" | "list" | "detail";

export function TasksView() {
  const console_ = useAgentConsole();
  const { operationsRevision } = console_;
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

  // Fall back to the first row rather than storing a correction in state.
  const activePromptId =
    prompts.some((item) => item.prompt.id === promptId) ? promptId : prompts[0]?.prompt.id ?? null;

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
  const listItem = prompts.find((entry) => entry.prompt.id === activePromptId) ?? item;
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
  };

  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
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

      <div className="grid min-h-0 flex-1 xl:grid-cols-[280px_minmax(0,1fr)_minmax(320px,420px)]">
        <div className={cn("min-h-0 xl:block", pane === "suites" ? "block" : "hidden")}>
          <SuiteRail
            suites={suites}
            selectedSuiteId={suite?.id ?? null}
            loading={snapshot === null && loadError === null}
            onSelect={selectSuite}
          />
        </div>

        <section
          className={cn(
            "min-h-0 overflow-y-auto p-4 xl:block",
            pane === "list" ? "block" : "hidden",
          )}
        >
          {suite === null ? (
            <p className="text-sm text-fg-dim">Select a suite to see its work items.</p>
          ) : (
            <div className="mx-auto max-w-4xl space-y-4">
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
                prompts={prompts}
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

        <aside
          className={cn(
            // Below xl: full-screen sheet. At xl: third grid column.
            "min-h-0 border-line bg-surface-1 xl:relative xl:block xl:border-l",
            pane === "detail"
              ? "fixed inset-0 z-20 block xl:static xl:z-auto"
              : "hidden",
          )}
        >
          <WorkItemDetail
            suite={suite}
            item={listItem}
            activity={activity}
            response={response}
            busy={busy}
            canStart={canStart}
            verifyingItem={liveVerification !== null}
            connectionOpen={console_.connection === "open"}
            providerLabel={providerInfo?.label ?? provider}
            model={selectedModel}
            onResponseChange={setResponse}
            onRun={() => start()}
            onStop={() => void stopAgent()}
            onRecover={() => recoverAndResume()}
            onRespond={respond}
            onVerifyItem={() => void verifyWorkItem()}
            onClose={() => setPane("list")}
          />
        </aside>
      </div>
    </main>
  );
}

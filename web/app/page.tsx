"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PromptOption, WorkspaceRecord } from "@agent-console/shared";
import { Composer } from "@/components/Composer";
import { ConsultBriefing } from "@/components/ConsultBriefing";
import { ContextPicker } from "@/components/ContextPicker";
import { LogPanel } from "@/components/LogPanel";
import { PageChrome } from "@/components/shell/chrome";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

/** Matches server/src/runService.ts CONSULT_LIMIT. */
const CONSULT_LIMIT = 3;

const EXAMPLES = [
  "Summarise the repo layout and the main entry points.",
  "Run the test suite and report anything that fails.",
  "Find TODOs and open questions in the latest work items.",
];

export default function Page() {
  const console_ = useAgentConsole();
  const { providers, connection, items, workdir, operationsRevision } = console_;
  const toast = useToast();
  const dialogs = useDialogs();
  const { selected, setPreferred } = usePreferredProvider(providers);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  const [savedPromptId, setSavedPromptId] = useState<number | null>(null);

  const refreshWorkspaces = useCallback(() => {
    return workspaceApi
      .list(SERVER_URL)
      .then((list) => {
        setWorkspaceError(null);
        setWorkspaces(list);
        const params = new URLSearchParams(window.location.search);
        const requestedWorkspace = Number(params.get("workspace"));
        const requestedPrompt = Number(params.get("prompt"));
        const remembered = Number(localStorage.getItem("agent-console.workspace"));
        setWorkspaceId(
          list.some((w) => w.id === requestedWorkspace)
            ? requestedWorkspace
            : list.some((w) => w.id === remembered)
              ? remembered
              : list[0]?.id ?? null,
        );
        if (Number.isSafeInteger(requestedPrompt) && requestedPrompt > 0) {
          setSavedPromptId(requestedPrompt);
        }
      })
      .catch((error: unknown) => {
        setWorkspaceError(error instanceof Error ? error.message : "Workspaces could not be loaded.");
      })
      .finally(() => setWorkspaceLoading(false));
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const refreshPrompts = useCallback(
    (id: number) =>
      workspaceApi
        .prompts(SERVER_URL, id)
        .then(setPromptOptions)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (workspaceId === null) return;
    localStorage.setItem("agent-console.workspace", String(workspaceId));
    void refreshPrompts(workspaceId);
    const timer = setInterval(() => void refreshPrompts(workspaceId), 60_000);
    return () => clearInterval(timer);
  }, [workspaceId, refreshPrompts, operationsRevision]);

  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const savedPrompt = promptOptions.find((p) => p.id === savedPromptId) ?? null;

  const selectedInfo = useMemo(
    () => providers.find((provider) => provider.id === selected),
    [providers, selected],
  );

  const models = useModelSelection(providers);

  // Scoped to the selected workspace: the server allows concurrent runs in
  // different workspaces, so a run elsewhere must not disable this composer.
  // A consult in this workspace does not own the writer slot.
  const writerRun =
    workspaceId === null
      ? null
      : console_.runs.find((item) => item.workspace.id === workspaceId && item.role === "execute") ?? null;
  const consults =
    workspaceId === null
      ? []
      : console_.runs.filter((item) => item.workspace.id === workspaceId && item.role === "consult");
  const lastConsult =
    console_.lastConsult !== null && console_.lastConsult.workspace.id === workspaceId
      ? console_.lastConsult
      : null;
  const running = writerRun !== null;
  const inputDisabled =
    connection !== "open" || workspaceId === null || activeWorkspace?.workDirectoryExists === false;

  /** Why Run cannot start. A live writer is Stop, not a blocked reason. */
  const runBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (workspaceId === null) return "choose a workspace";
    if (activeWorkspace?.workDirectoryExists === false) return "working directory is missing";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (savedPrompt !== null && !savedPrompt.ready) {
      return savedPrompt.blockedBy.length > 0
        ? `waiting on ${savedPrompt.blockedBy.join(", ")}`
        : `work item is ${savedPrompt.status.toLowerCase()}`;
    }
    return null;
  }, [connection, workspaceId, activeWorkspace, selectedInfo, selected, savedPrompt]);

  /** Ask is independent of the writer lock and of prompt `ready`. */
  const askBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (workspaceId === null) return "choose a workspace";
    if (activeWorkspace?.workDirectoryExists === false) return "working directory is missing";
    if (selected === "cursor") return "Cursor has no sandbox, so it cannot Ask.";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (consults.length >= CONSULT_LIMIT) return "3 consults already running";
    return null;
  }, [connection, workspaceId, activeWorkspace, selected, selectedInfo, consults.length]);

  const writerItems = useMemo(
    () => console_.items.filter((item) => !console_.consultIds.includes(item.runId)),
    [console_.items, console_.consultIds],
  );

  const empty = writerItems.length === 0 && consults.length === 0 && lastConsult === null;

  const recover = async () => {
    if (savedPrompt === null || workspaceId === null) return;
    const confirmed = await dialogs.confirm({
      title: "Recover this interrupted run?",
      description:
        "The previous run's logs and any changes it made to the working tree are preserved. The work item returns to READY so it can be run again.",
      confirmLabel: "Recover",
    });
    if (!confirmed) return;
    try {
      await workspaceApi.recover(SERVER_URL, savedPrompt.id);
      await refreshPrompts(workspaceId);
      toast.success("Run recovered", "The work item is ready to run again.");
    } catch (error) {
      toast.error("Recovery failed", error instanceof Error ? error.message : String(error));
    }
  };

  const send = (prompt: string) => {
    if (workspaceId === null) return;
    const started = console_.startRun(
      workspaceId,
      selected,
      savedPrompt !== null ? { promptId: savedPrompt.id } : { prompt },
      models.resolve(selected),
    );
    if (!started) toast.error("Could not start the run", "The agent connection is unavailable.");
  };

  const ask = (prompt: string) => {
    if (workspaceId === null) return;
    const source =
      savedPrompt !== null
        ? prompt !== ""
          ? { promptId: savedPrompt.id, prompt }
          : { promptId: savedPrompt.id }
        : { prompt };
    const started = console_.startConsult(workspaceId, selected, source, models.resolve(selected));
    if (!started) toast.error("Could not start the consult", "The agent connection is unavailable.");
  };

  const context = (
    <ContextPicker
      workspaces={workspaces}
      workspaceId={workspaceId}
      onWorkspace={(id) => {
        setSavedPromptId(null);
        setPromptOptions([]);
        setWorkspaceId(id);
      }}
      prompts={promptOptions}
      savedPromptId={savedPromptId}
      onPrompt={setSavedPromptId}
      disabled={false}
      activeWorkspace={activeWorkspace}
      onRecover={() => void recover()}
    />
  );

  const composer = (
    <Composer
      disabled={inputDisabled}
      running={running}
      writer={writerRun === null ? null : { provider: writerRun.provider, model: writerRun.model }}
      providers={providers}
      models={models}
      selected={selected}
      runBlockedReason={runBlockedReason}
      askBlockedReason={askBlockedReason}
      savedPrompt={savedPrompt}
      context={context}
      workdir={activeWorkspace?.workDirectory ?? workdir}
      onSubmit={send}
      onAsk={ask}
      onInterrupt={() => console_.interrupt(writerRun?.runId)}
      onClearSavedPrompt={() => setSavedPromptId(null)}
      onTarget={(provider, model) => {
        setPreferred(provider);
        // A bare `@grok` picks the provider at the model it was already going
        // to use — that should not turn an inherited setting into a pin.
        if (model !== models.resolve(provider)) models.select(provider, model);
      }}
    />
  );

  return (
    <main className="flex h-full flex-col bg-surface-0">
      <PageChrome
        title="Chat"
        actions={
          <Button size="sm" variant="ghost" onClick={console_.clearLog} disabled={items.length === 0}>
            Clear log
          </Button>
        }
      />

      {workspaceError !== null && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">The workspace library is unavailable: {workspaceError}</span>
          <Button size="sm" variant="secondary" onClick={() => { setWorkspaceLoading(true); void refreshWorkspaces(); }}>Retry</Button>
        </div>
      )}

      {!workspaceLoading && workspaceError === null && workspaces.length === 0 && (
        <div role="status" className="border-b border-line bg-surface-1 px-4 py-2 text-xs text-fg-muted">
          No workspaces yet. Add one from the Workspaces page before starting an agent.
        </div>
      )}

      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-8">
          <div className="max-w-xl text-center">
            <h2 className="text-xl font-semibold text-fg">Talk to an agent</h2>
            <p className="mt-1.5 text-sm text-fg-muted">
              Run a custom prompt, or attach a work item and send it into the working tree.
            </p>
          </div>
          <div className="flex max-w-2xl flex-wrap justify-center gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={inputDisabled || runBlockedReason !== null}
                onClick={() => {
                  setSavedPromptId(null);
                  send(example);
                }}
                className="rounded-full bg-surface-2 px-3 py-1.5 text-left text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40"
              >
                {example}
              </button>
            ))}
          </div>
          <div className="w-full max-w-3xl">{composer}</div>
        </div>
      ) : (
        <>
          <LogPanel items={writerItems} workdir={activeWorkspace?.workDirectory ?? workdir} />
          <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
            {(consults.length > 0 || lastConsult !== null) && (
              <ConsultBriefing
                consults={consults}
                lastConsult={lastConsult}
                itemsFor={console_.itemsFor}
                workdir={activeWorkspace?.workDirectory ?? workdir}
                onStop={(runId) => console_.interrupt(runId)}
              />
            )}
            {composer}
          </div>
        </>
      )}
    </main>
  );
}

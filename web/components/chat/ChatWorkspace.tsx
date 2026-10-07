"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PromptOption, WorkspaceRecord } from "@agent-console/shared";
import { Composer } from "@/components/Composer";
import { ConsultBriefing } from "@/components/ConsultBriefing";
import { ContextPicker } from "@/components/ContextPicker";
import { LogPanel } from "@/components/LogPanel";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialogs";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

const CONSULT_LIMIT = 3;
const EXAMPLES = [
  "Summarise the repo layout and the main entry points.",
  "Run the test suite and report anything that fails.",
  "Find TODOs and open questions in the latest work items.",
];

interface Props {
  tabId: string;
  workspace: WorkspaceRecord;
  visible: boolean;
  initialPromptId: number | null;
  onTitle(title: string): void;
}

/** One mounted tab. Inactive tabs stay mounted so their draft and context are preserved. */
export function ChatWorkspace({ tabId, workspace, visible, initialPromptId, onTitle }: Props) {
  const console_ = useAgentConsole();
  const { providers, connection, operationsRevision } = console_;
  const toast = useToast();
  const dialogs = useDialogs();
  const { selected, setPreferred } = usePreferredProvider(providers);
  const models = useModelSelection(providers);
  const workspaceId = workspace.id;
  const liveRunIdentity = console_.runs.map((run) => run.runId).join(":");
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  const [savedPromptId, setSavedPromptId] = useState<number | null>(initialPromptId);

  const refreshPrompts = useCallback(
    () => workspaceApi.prompts(SERVER_URL, workspaceId).then(setPromptOptions).catch(() => {}),
    [workspaceId],
  );

  useEffect(() => {
    void refreshPrompts();
    const timer = setInterval(() => void refreshPrompts(), 60_000);
    return () => clearInterval(timer);
  }, [refreshPrompts, operationsRevision]);

  useEffect(() => {
    // The first tab opened for a workspace adopts unowned runs, including runs
    // started elsewhere in the app rather than from a Chat tab.
    console_.claimWorkspaceRuns(tabId, workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the console method changes with its state
  }, [tabId, workspaceId, liveRunIdentity]);

  const savedPrompt = promptOptions.find((prompt) => prompt.id === savedPromptId) ?? null;
  const selectedInfo = useMemo(
    () => providers.find((provider) => provider.id === selected),
    [providers, selected],
  );
  const writerRun =
    console_.runs.find((run) => run.workspace.id === workspaceId && run.role === "execute") ?? null;
  const workspaceConsults = console_.runs.filter(
    (run) => run.workspace.id === workspaceId && run.role === "consult",
  );
  const consults = workspaceConsults.filter((run) => console_.runTabIds[run.runId] === tabId);
  const lastConsult = console_.lastConsultsByTab[tabId] ?? null;
  const running = writerRun !== null;
  const ownsWriter = writerRun !== null && console_.runTabIds[writerRun.runId] === tabId;
  const starting = console_.pendingLaunches.some((launch) => launch.tabId === tabId && launch.role === "execute");
  const launchFailure = console_.launchFailuresByTab[tabId] ?? null;
  const inputDisabled = connection !== "open" || !workspace.workDirectoryExists;

  const runBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (!workspace.workDirectoryExists) return "working directory is missing";
    if (running) return "a writer is already in progress; use Ask for read-only research";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (savedPrompt !== null && !savedPrompt.ready) {
      return savedPrompt.blockedBy.length > 0
        ? `waiting on ${savedPrompt.blockedBy.join(", ")}`
        : `work item is ${savedPrompt.status.toLowerCase()}`;
    }
    return null;
  }, [connection, workspace.workDirectoryExists, running, selectedInfo, selected, savedPrompt]);

  const askBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (!workspace.workDirectoryExists) return "working directory is missing";
    if (selected === "cursor") return "Cursor has no sandbox, so it cannot Ask.";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (workspaceConsults.length >= CONSULT_LIMIT) return "3 consults already running";
    return null;
  }, [connection, workspace.workDirectoryExists, selected, selectedInfo, workspaceConsults.length]);

  const tabItems = console_.itemsForTab(tabId);
  const writerItems = useMemo(
    () => tabItems.filter((item) => !console_.consultIds.includes(item.runId)),
    [tabItems, console_.consultIds],
  );
  const empty = writerItems.length === 0 && consults.length === 0 && lastConsult === null;

  const recover = async () => {
    if (savedPrompt === null) return;
    const confirmed = await dialogs.confirm({
      title: "Recover this interrupted run?",
      description: "The previous run's logs and changes are preserved. The work item returns to READY so it can be run again.",
      confirmLabel: "Recover",
    });
    if (!confirmed) return;
    try {
      await workspaceApi.recover(SERVER_URL, savedPrompt.id);
      await refreshPrompts();
      toast.success("Run recovered", "The work item is ready to run again.");
    } catch (error) {
      toast.error("Recovery failed", error instanceof Error ? error.message : String(error));
    }
  };

  const send = (prompt: string) => {
    // The socket can announce a writer between render and click; enforce the rule here too.
    if (writerRun !== null) {
      toast.error("Writer already in progress", "Use Ask for read-only research in this workspace.");
      return;
    }
    const started = console_.startRun(
      workspaceId,
      selected,
      savedPrompt !== null ? { promptId: savedPrompt.id } : { prompt },
      models.resolve(selected),
      tabId,
    );
    if (!started) {
      toast.error("Could not start the run", "The agent connection is unavailable.");
      return;
    }
    onTitle(savedPrompt?.title ?? prompt);
  };

  const ask = (prompt: string) => {
    const source = savedPrompt !== null
      ? prompt !== "" ? { promptId: savedPrompt.id, prompt } : { promptId: savedPrompt.id }
      : { prompt };
    const started = console_.startConsult(workspaceId, selected, source, models.resolve(selected), tabId);
    if (!started) {
      toast.error("Could not start the consult", "The agent connection is unavailable.");
      return;
    }
    onTitle(savedPrompt?.title ?? prompt);
  };

  const composer = (
    <Composer
      active={visible}
      disabled={inputDisabled}
      running={running}
      starting={starting}
      ownsWriter={ownsWriter}
      writer={writerRun === null ? null : { provider: writerRun.provider, model: writerRun.model }}
      providers={providers}
      models={models}
      selected={selected}
      runBlockedReason={runBlockedReason}
      askBlockedReason={askBlockedReason}
      savedPrompt={savedPrompt}
      context={<ContextPicker workspaceId={workspaceId} prompts={promptOptions} savedPromptId={savedPromptId} onPrompt={setSavedPromptId} disabled={false} activeWorkspace={workspace} onRecover={() => void recover()} />}
      workdir={workspace.workDirectory}
      onSubmit={send}
      onAsk={ask}
      onInterrupt={() => console_.interrupt(writerRun?.runId)}
      onClearSavedPrompt={() => setSavedPromptId(null)}
      onTarget={(provider, model) => {
        setPreferred(provider);
        if (model !== models.resolve(provider)) models.select(provider, model);
      }}
    />
  );

  return (
    <section aria-label={`${workspace.name} work tab`} aria-hidden={!visible} className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 pb-8">
          <div className="max-w-xl text-center">
            <h2 className="text-xl font-semibold text-fg">Talk to an agent</h2>
            <p className="mt-1.5 text-sm text-fg-muted">Run a custom prompt, or attach a work item and send it into this working tree.</p>
          </div>
          <div className="flex max-w-2xl flex-wrap justify-center gap-2">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" disabled={inputDisabled || running || runBlockedReason !== null} onClick={() => { setSavedPromptId(null); send(example); }} className="rounded-full bg-surface-2 px-3 py-1.5 text-left text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40">
                {example}
              </button>
            ))}
          </div>
          <div className="w-full max-w-3xl">
            {launchFailure !== null && (
              <div role="alert" className="mb-2 flex items-start gap-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
                <span className="min-w-0 flex-1"><strong className="font-semibold">Run didn&apos;t start.</strong> {launchFailure}</span>
                <button type="button" onClick={() => console_.dismissLaunchFailure(tabId)} className="shrink-0 text-danger/70 hover:text-danger" aria-label="Dismiss launch error">×</button>
              </div>
            )}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <LogPanel items={writerItems} workdir={workspace.workDirectory} />
          <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
            {launchFailure !== null && (
              <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
                <span className="min-w-0 flex-1"><strong className="font-semibold">Run didn&apos;t start.</strong> {launchFailure}</span>
                <button type="button" onClick={() => console_.dismissLaunchFailure(tabId)} className="shrink-0 text-danger/70 hover:text-danger" aria-label="Dismiss launch error">×</button>
              </div>
            )}
            {(consults.length > 0 || lastConsult !== null) && (
              <ConsultBriefing consults={consults} lastConsult={lastConsult} itemsFor={console_.itemsFor} workdir={workspace.workDirectory} onStop={(runId) => console_.interrupt(runId)} />
            )}
            {composer}
          </div>
        </>
      )}
    </section>
  );
}

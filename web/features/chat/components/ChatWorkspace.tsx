"use client";

import { apiFetch } from "@/api/http";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { conversationTitle, type PromptOption, type WorkspaceRecord } from "@hydra/shared";
import { Composer } from "@/features/chat/components/Composer";
import { DecisionDeck } from "@/features/chat/components/DecisionDeck";
import { ContextPicker } from "@/features/chat/components/ContextPicker";
import { BtwBar } from "./BtwBar";
import { ConversationPanel } from "./ConversationPanel";
import { useToast } from "@/components/ui/Toast";
import { useDialogs } from "@/components/ui/Dialogs";
import { useHydra } from "@/hooks/useHydra";
import { useModelSelection } from "@/features/providers/hooks/useModelSelection";
import { usePreferredProvider } from "@/features/providers/hooks/usePreferredProvider";
import { SERVER_URL } from "@/api/serverUrl";
import { queuedScopeChanged, type QueuedChatScope } from "@/features/chat/lib/chatSubmission";
import { workspaceApi } from "@/api/workspacesApi";
import { HydraMark } from "@/components/brand/HydraMark";

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
  hasEarlier?: boolean;
  historyLoading?: boolean;
  historyError?: string | null;
  onLoadEarlier?(): void;
  onRead?(timestamp:string): void;
}

export function ChatWorkspace({ tabId, workspace, visible, initialPromptId, onTitle, hasEarlier, historyLoading, historyError, onLoadEarlier, onRead }: Props) {
  const console_ = useHydra();
  const { providers, connection, operationsRevision } = console_;
  const toast = useToast();
  const dialogs = useDialogs();
  const { selected, setPreferred } = usePreferredProvider(providers);
  const models = useModelSelection(providers);
  const workspaceId = workspace.id;
  const liveRunIdentity = console_.runs.map((run) => run.runId).join(":");
  const [freshContext, setFreshContext] = useState(false);
  const [contextText, setContextText] = useState<string | null>(null);
  const [queued, setQueued] = useState<(QueuedChatScope & { prompt: string; mode: "ask" | "run" }) | null>(null);
  const queueSending = useRef(false);
  const [quote, setQuote] = useState("");
  const [suggestion,setSuggestion] = useState<{text:string;nonce:number;append?:boolean}>();
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
    if (console_.runs.some((run) => run.runId === tabId)) console_.claimRun(tabId, tabId);
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
  const running = writerRun !== null;
  const ownsWriter = writerRun !== null && console_.runTabIds[writerRun.runId] === tabId;
  const starting = console_.pendingLaunches.some((launch) => launch.tabId === tabId && launch.role === "execute");
  const asking = consults.length > 0
    || console_.pendingLaunches.some((launch) => launch.tabId === tabId && launch.role === "consult");
  const writingHere = ownsWriter || starting;
  const launchFailure = console_.launchFailuresByTab[tabId] ?? null;
  const inputDisabled = connection !== "open" || !workspace.workDirectoryExists;

  const runBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (!workspace.workDirectoryExists) return "working directory is missing";
    if (asking) return "an Ask is running in this tab; wait for it or open another tab";
    if (running) return "a writer is already in progress; use Ask for read-only research";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (savedPrompt !== null && !savedPrompt.ready) {
      return savedPrompt.blockedBy.length > 0
        ? `waiting on ${savedPrompt.blockedBy.join(", ")}`
        : `work item is ${savedPrompt.status.toLowerCase()}`;
    }
    return null;
  }, [connection, workspace.workDirectoryExists, asking, running, selectedInfo, selected, savedPrompt]);

  const askBlockedReason = useMemo<string | null>(() => {
    if (connection !== "open") return "backend disconnected";
    if (!workspace.workDirectoryExists) return "working directory is missing";
    if (writingHere) return "a writer is running in this tab; open another tab to Ask";
    if (asking) return "an Ask is already running in this tab";
    if (selected === "cursor") return "Cursor Ask isolation is not supported by this adapter.";
    if (selectedInfo?.available !== true) return `${selected} is not available`;
    if (workspaceConsults.length >= CONSULT_LIMIT) return "3 consults already running";
    return null;
  }, [connection, workspace.workDirectoryExists, writingHere, asking, selected, selectedInfo, workspaceConsults.length]);

  const tabItems = console_.itemsForTab(tabId);
  const decisionRequests = Object.values(console_.inputRequests).filter((request) => console_.runTabIds[request.runId] === tabId);
  const writerItems = useMemo(
    () => tabItems.filter((item) => !console_.consultIds.includes(item.runId)),
    [tabItems, console_.consultIds],
  );
  const pendingLaunch = console_.pendingLaunches.find((launch) => launch.tabId === tabId) ?? null;
  const liveRuns = console_.runs.filter(run => console_.runTabIds[run.runId] === tabId);
  const empty = tabItems.length === 0 && liveRuns.length === 0 && pendingLaunch === null;

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
    if (runBlockedReason) { toast.error("Could not start the run", runBlockedReason); return; }
    if (asking) {
      toast.error("Ask already running in this tab", "Wait for it to finish, or open another tab.");
      return;
    }
    if (writerRun !== null) {
      toast.error("Writer already in progress", "Use Ask for read-only research in another tab.");
      return;
    }
    const started = console_.startRun(
      workspaceId,
      selected,
      savedPrompt !== null ? { promptId: savedPrompt.id } : { prompt },
      models.resolve(selected),
      tabId,
      freshContext,
    );
    if (!started) {
      toast.error("Could not start the run", "The agent connection is unavailable.");
      return;
    }
    if (writerItems.length === 0) onTitle(savedPrompt?.title ?? conversationTitle(prompt));
  };

  const ask = (prompt: string) => {
    if (askBlockedReason) { toast.error("Could not start Ask", askBlockedReason); return; }
    if (writingHere || asking) {
      toast.error("This tab is busy", "Open another tab to Ask while a run is in progress here.");
      return;
    }
    const source = savedPrompt !== null
      ? prompt !== "" ? { promptId: savedPrompt.id, prompt } : { promptId: savedPrompt.id }
      : { prompt };
    const started = console_.startConsult(workspaceId, selected, source, models.resolve(selected), tabId, freshContext);
    if (!started) {
      toast.error("Could not start the consult", "The agent connection is unavailable.");
      return;
    }
    if (tabItems.length === 0) onTitle(savedPrompt?.title ?? conversationTitle(prompt));
  };

  useEffect(() => {
    if (!queued || queueSending.current) return;
    const timer = setTimeout(() => {
    if (queuedScopeChanged(queued, { provider: selected, model: models.resolve(selected), workspace: workspaceId, fresh: freshContext, permission: selectedInfo?.permissionMode, savedPromptId, directory: workspace.workDirectory }, connection === "open")) {
      setSuggestion({text:queued.prompt,nonce:Date.now(),append:true});
      setQueued(null);
      toast.error("Queued message needs review", "The connection, target or context changed. Your draft is retained.");
      return;
    }
    if (asking || running || starting) return;
    const reason = queued.mode === "ask" ? askBlockedReason : runBlockedReason;
    setQueued(null);
    if (reason) { setSuggestion({text:queued.prompt,nonce:Date.now(),append:true}); toast.error("Queued message was not sent", reason); return; }
    queueSending.current = true;
    if (queued.mode === "ask") ask(queued.prompt); else send(queued.prompt);
    queueSending.current = false;
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, connection, selected, models, workspaceId, freshContext, selectedInfo?.permissionMode, savedPromptId, workspace.workDirectory, asking, running, starting, askBlockedReason, runBlockedReason]);

  const composer = (
    <Composer
      suggestion={suggestion}
      note={ownsWriter && writerRun !== null ? <BtwBar runId={writerRun.runId} provider={writerRun.provider} canInterrupt={writerRun.source.type === "saved"} autoFocus={false} /> : undefined}
      defaultMode="run"
      busy={writingHere || asking}
      onQueue={(prompt, mode, stop) => {
        setQueued({ prompt, mode, provider: selected, model: models.resolve(selected), workspace: workspaceId, fresh: freshContext, permission: selectedInfo?.permissionMode, savedPromptId, directory: workspace.workDirectory });
        setQuote("");
        if (stop) console_.interrupt((writerRun ?? consults[0])?.runId);
      }}
      quote={quote}
      onClearQuote={() => setQuote("")}
      launchPending={pendingLaunch !== null}
      launchFailed={launchFailure}
      draftKey={tabId}
      active={visible}
      disabled={inputDisabled}
      running={running || consults.length > 0}
      starting={starting}
      ownsWriter={ownsWriter || consults.length > 0}
      writer={writerRun === null ? null : { provider: writerRun.provider, model: writerRun.model }}
      providers={providers}
      models={models}
      selected={selected}
      runBlockedReason={runBlockedReason}
      askBlockedReason={askBlockedReason}
      savedPrompt={savedPrompt}
      context={<><div className="mb-2 flex flex-wrap gap-3 text-xs text-fg-muted">
        <details onToggle={event => {
          if (!event.currentTarget.open) return;
          setContextText("Loading recorded context…");
          void apiFetch(`${SERVER_URL}/api/sessions/context?workspace=${workspaceId}&thread=${encodeURIComponent(tabId)}`).then(async response => {
            if (!response.ok) throw new Error("Context unavailable");
            const data = await response.json() as { context: string }; setContextText(data.context);
          }).catch(() => setContextText("Recorded context unavailable. Sending may fail; no history will be invented."));
        }}><summary>Context</summary><p>{workspace.workDirectory} · Ask always starts a read-only session with bounded recorded exchanges. Run resumes a compatible immediate session, otherwise uses the same handoff.</p><label><input type="checkbox" checked={freshContext} onChange={event => setFreshContext(event.target.checked)} /> Start fresh for next message</label><pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap">{freshContext ? "No previous exchanges will be supplied." : contextText}</pre></details>
      </div><ContextPicker workspaceId={workspaceId} prompts={promptOptions} savedPromptId={savedPromptId} onPrompt={setSavedPromptId} disabled={false} activeWorkspace={workspace} onRecover={() => void recover()} /></>}
      workdir={workspace.workDirectory}
      onSubmit={send}
      onAsk={ask}
      onInterrupt={() => console_.interrupt((writerRun ?? consults[0])?.runId)}
      onClearSavedPrompt={() => setSavedPromptId(null)}
      onTarget={(provider, model) => {
        setPreferred(provider);
        if (model !== models.resolve(provider)) models.select(provider, model);
      }}
    />
  );

  return (
    <section aria-label={`${workspace.name} work tab`} aria-hidden={!visible} className={visible ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      <ConversationPanel items={tabItems} workdir={workspace.workDirectory} workspaceId={workspaceId} storageKey={tabId}
        active={visible} hasEarlier={hasEarlier} historyLoading={historyLoading} historyError={historyError} onLoadEarlier={onLoadEarlier} onRead={onRead}
        onQuote={setQuote}
        liveRuns={liveRuns}
        disconnected={connection !== "open"}
        pendingTurn={pendingLaunch ? { id: pendingLaunch.requestId, prompt: pendingLaunch.prompt, provider: selected, model: models.resolve(selected) } : undefined}
        pending={empty ? <div className="chat-empty"><span className="chat-empty-mark"><HydraMark size={76} tone="spectrum" /></span><h2>What shall we work on?</h2><p>Ask a question, explore an idea, or build something together.</p><div className="chat-examples">{EXAMPLES.map(example => <button key={example} type="button" disabled={inputDisabled} onClick={() => setSuggestion({text:example,nonce:Date.now()})}>{example}</button>)}</div></div>
          : null}
        footer={<div className="flex flex-col gap-2">
        {queued && <div className="flex min-w-0 items-start gap-3 rounded-lg border border-line bg-surface-1 px-3 py-2 text-xs text-fg-muted">
          <details className="min-w-0 flex-1"><summary className="cursor-pointer">{queued.mode === "run" ? "Run" : "Ask"} queued · sends after this reply</summary><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{queued.prompt}</pre></details>
          <button type="button" onClick={() => { setSuggestion({text:queued.prompt,nonce:Date.now(),append:true}); setQueued(null); }}>Cancel queued message</button>
        </div>}
        {launchFailure !== null && <div role="alert" className="rounded-lg border border-danger bg-surface-1 px-3 py-2 text-sm text-danger"><strong>Message didn&apos;t start.</strong> {launchFailure}<button type="button" className="ml-3" onClick={() => console_.dismissLaunchFailure(tabId)}>Dismiss</button></div>}
        {decisionRequests.map(request => {
          const run = console_.runs.find(item => item.runId === request.runId);
          return run ? <DecisionDeck key={request.requestId} request={request} provider={run.provider} onSubmit={answers => console_.answerInput(request.runId, request.requestId, answers)} onCancel={() => console_.interrupt(request.runId)} /> : null;
        })}
        {composer}
      </div>} />
    </section>
  );
}

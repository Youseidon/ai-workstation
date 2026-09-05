"use client";

import { useEffect, useState } from "react";
import type { OperationsPrompt, PromptActivity, ProviderId } from "@agent-console/shared";
import { canRetryWithExistingContext } from "@/lib/humanInput";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useAgentConsole } from "@/lib/agentConsole";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type Props = { item: OperationsPrompt; provider: ProviderId; model: string | null; pipeline?: boolean; onClose(): void };
type Draft = { text: string; intent: "answer" | "instructions" | "clarify"; responseId?: number };
const emptyDraft: Draft = { text: "", intent: "answer" };

export function HumanInputDialog(props: Props) {
  return <Modal open title="Needs your input" description={props.item.prompt.title} size="lg" onClose={props.onClose}>
    <HumanInputPanel key={`${props.item.workspace.id}:${props.item.prompt.id}`} {...props} />
  </Modal>;
}

function HumanInputPanel({ item, provider, model, pipeline }: Props) {
  const console_ = useAgentConsole();
  const storageKey = `agent-console.human-input:${item.workspace.id}:${item.prompt.id}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Draft | null;
      if (value && typeof value.text === "string" && ["answer", "instructions", "clarify"].includes(value.intent)) return value;
    } catch { /* A draft is optional. */ }
    return emptyDraft;
  });
  const [activity, setActivity] = useState<PromptActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    workspaceApi.activity(SERVER_URL, item.prompt.id).then(value => {
      if (!cancelled) setActivity(value);
    }).catch(() => { if (!cancelled) setError("Could not load the conversation. Close and reopen this panel to retry."); });
    return () => { cancelled = true; };
  }, [item.prompt.id, console_.operationsRevision, console_.runs.length, revision]);

  const updateDraft = (value: Draft) => {
    setDraft(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { setMessage("Draft stays in this panel; browser storage is unavailable."); }
  };
  const current = activity?.item ?? item;
  const retryable = canRetryWithExistingContext(current);
  const waiting = current.operationalState === "AWAITING_RESPONSE";
  const latestResponse = activity?.remarks.find(entry => entry.kind === "HUMAN_RESPONSE");
  const responseId = draft.responseId ?? (!waiting ? latestResponse?.id : undefined);
  const running = console_.runs.some(run => run.workspace.id === item.workspace.id && run.role !== "consult");
  const available = console_.providers.some(entry => entry.id === provider && entry.available);
  const disabled = !activity || busy || running || !available || console_.connection !== "open";
  const history = [
    ...(activity?.remarks ?? []).filter(entry => ["BLOCKER", "DECISION_NEEDED", "HUMAN_RESPONSE"].includes(entry.kind)).map(entry => ({ id: `remark-${entry.id}`, at: entry.createdAt, label: entry.kind === "HUMAN_RESPONSE" ? "You" : "Agent", text: entry.content })),
    ...(activity?.clarifications ?? []).flatMap(entry => [
      { id: `question-${entry.id}`, at: entry.createdAt, label: "Your clarification question", text: entry.question },
      { id: `answer-${entry.id}`, at: entry.answeredAt ?? entry.createdAt, label: "Agent clarification", text: entry.answer ?? (entry.state === "RUNNING" ? "Thinking…" : `Clarification ${entry.state.toLowerCase()}. Try again or answer the blocker directly.`) },
    ]),
  ].sort((a, b) => a.at.localeCompare(b.at));

  async function submit(retry = false, existingContext = false) {
    setBusy(true); setError(null); setMessage(null);
    try {
      if (draft.intent === "clarify" && !retry) {
        await workspaceApi.clarify(SERVER_URL, item.prompt.id, { question: draft.text.trim(), provider, model });
        setMessage("Clarification requested. The answer will appear below; the pipeline stays paused.");
        updateDraft({ ...emptyDraft, intent: "clarify" });
      } else {
        const content = existingContext ? "Retry requested with existing context. Inspect the previous evidence and continue incomplete work." : draft.intent === "instructions" ? `Updated instructions from the owner (supersede conflicting earlier task instructions):\n\n${draft.text.trim()}` : draft.text.trim();
        setMessage("Saving your answer and starting continuation…");
        const result = await workspaceApi.respondAndContinue(SERVER_URL, item.prompt.id, { provider, model, ...(retry && responseId ? { responseId } : { content }) });
        if (result.started) {
          setStarted(true); updateDraft(emptyDraft);
          try { localStorage.removeItem(storageKey); } catch { /* Continuation already started. */ }
          setMessage(pipeline ? "Answer saved. Pipeline continuation started." : "Answer saved. Continuation started.");
        } else {
          updateDraft({ ...draft, responseId: result.responseId });
          setMessage("Your answer is saved."); setError(result.error ?? "Continuation could not start. Retry when the agent is available.");
        }
      }
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <section className="rounded-panel border border-warning/40 bg-warning/5 p-4" aria-label="Current question">
      <h3 className="mb-2 text-sm font-semibold text-warning">{waiting ? "What the agent needs" : "Your answer is recorded"}</h3>
      <p className="whitespace-pre-wrap text-sm leading-6 text-fg">{waiting ? current.latestIntervention ?? "Review the conversation and provide the instructions needed to continue." : latestResponse?.content ?? "Continue from the saved context."}</p>
    </section>

    {!started && waiting && <>
      <div className="flex flex-wrap gap-2" aria-label="Response type">
        {([["answer", "Answer question"], ["clarify", "Ask for clarification"], ["instructions", "Change instructions"]] as const).map(([intent, label]) => <Button key={intent} size="sm" variant={draft.intent === intent ? "primary" : "secondary"} aria-pressed={draft.intent === intent} disabled={busy} onClick={() => updateDraft({ ...draft, intent, responseId: undefined })}>{label}</Button>)}
      </div>
      <TextArea label={draft.intent === "clarify" ? "Your clarification question" : draft.intent === "instructions" ? "Revised instructions" : "Your answer"} rows={5} value={draft.text} maxLength={19000} disabled={busy} placeholder={draft.intent === "instructions" ? "State what should change and any constraints the agent should keep…" : "Add the details the agent needs…"} hint={draft.intent === "instructions" ? "These instructions will supersede conflicting earlier task instructions and be kept in the conversation." : "Draft saved automatically in this browser. Configure secrets outside this box."} onChange={event => updateDraft({ text: event.target.value, intent: draft.intent })} />
      <Button variant="success" disabled={disabled || !draft.text.trim()} loading={busy} onClick={() => void submit()}>{draft.intent === "clarify" ? "Ask agent" : draft.intent === "instructions" ? "Apply instructions and continue" : pipeline ? "Send answer and continue pipeline" : "Send answer and continue"}</Button>
    </>}
    {!started && waiting && retryable && <Button variant="secondary" disabled={disabled} onClick={() => void submit(false, true)}>Retry with existing context</Button>}
    {!started && !waiting && responseId !== undefined && <Button variant="success" disabled={disabled} loading={busy} onClick={() => void submit(true)}>Continue with saved answer</Button>}
    {message && <p role="status" className="text-sm text-info">{message}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {console_.connection !== "open" && <p className="text-xs text-warning">Reconnect to send. Your draft is retained.</p>}
    {running && <p className="text-xs text-fg-muted">An agent is working. You can continue when it finishes.</p>}
    <p className="text-xs text-fg-dim">{pipeline ? `Continuation uses the pipeline’s assigned agent. Clarification uses ${provider}.` : `Continue or clarify with ${provider}${model ? ` · ${model}` : ""}.`}</p>
    {!available && <p className="text-xs text-warning">The selected agent is unavailable. Select an available agent in the page header.</p>}
    <details className="rounded-panel border border-line p-4" open={draft.intent === "clarify"}>
      <summary className="cursor-pointer text-sm text-fg-muted">Conversation · {history.length}</summary>
      <ol className="mt-4 space-y-4">{history.map(entry => <li key={entry.id} className="border-l-2 border-line pl-3"><div className="text-xs text-fg-dim">{entry.label} · {new Date(entry.at).toLocaleString()}</div><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{entry.text}</p></li>)}</ol>
    </details>
  </div>;
}

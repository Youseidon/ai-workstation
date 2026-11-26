"use client";

import { useState, type ReactNode } from "react";
import type { LogItem } from "@/features/runs/lib/log";
import { activityLabel, type ConversationProgress, type ConversationTurn } from "@/features/chat/lib/conversation";
import { btwDeliveryLabel } from "@/features/runs/components/LogEntry";
import { AssistantContent } from "./AssistantContent";
import { WorkItemPreview } from "./WorkItemPreview";

function CopyAnswer({ text }: { text: string }) {
  const [copied,setCopied] = useState(false);
  return <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy answer"}</button>;
}

function CopyOriginal({ text }: { text: string }) {
  const [status, setStatus] = useState("Copy original");
  return <button type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus("Copied original"); }
    catch { setStatus("Copy failed — select source below"); }
  }}>{status}</button>;
}

function Evidence({ item }: { item: LogItem }) {
  if (item.kind === "context") return <details className="text-xs text-fg-muted"><summary>Context supplied{item.nativeSessionId ? " · Native session continued" : " · Fresh provider session"}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{item.permissionKey}{"\n"}{item.context}</pre></details>;
  if (item.kind === "tool") return <details id={`command-${item.id}`} className="my-2 rounded border border-line p-2" open={item.result?.isError === true}>
    <summary>{item.name} · {item.result === null ? "Pending" : item.result.isError ? "Failed" : "Completed"}{item.result?.exitCode != null ? ` · exit ${item.result.exitCode}` : ""}</summary>
    <time>{item.timestamp}</time>
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap">{typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}</pre>
    {item.result && <><p>{item.result.summary}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap">{item.result.output}</pre></>}
  </details>;
  if (item.kind === "error") return <div role="alert" className="text-danger">{item.message}<pre className="overflow-auto">{item.detail}</pre></div>;
  if (item.kind === "decision") return <details open={item.answers === null}><summary>{item.heading} · {item.answers === null ? "Needs your answer" : "Answered"}</summary>{item.questions.map(q => <p key={q.id}>{q.prompt}</p>)}</details>;
  if (item.kind === "db") return <p className={item.outcome === "rejected" ? "text-danger" : "text-fg-muted"}>{item.operation}: {item.summary}</p>;
  return null;
}

export interface PendingConversationTurn {
  id: string;
  prompt: string;
  provider: LogItem["provider"];
  model: string | null;
}

export function ConversationExchange({ turn, number, progress, hasChanges, onQuote }: {
  turn: ConversationTurn;
  number: number;
  progress: ConversationProgress;
  hasChanges?: boolean;
  onQuote?(text: string): void;
}) {
  const prompt = turn.prompt?.text;
  const workItem = turn.prompt?.workItem;
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = prompt?.replace(/\s+/g, " ").trim() || "Prompt not recorded";
  const excerpt = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
  const promptId = `prompt-${turn.id}`;
  const responseId = `response-${turn.id}`;
  const messageBlocks = turn.blocks.filter(block => block.kind === "text" && block.textKind === "message");
  const text = messageBlocks.map(block => block.kind === "text" ? block.text : "").join("\n\n");
  const streamingId = progress.phase === "responding" ? messageBlocks.at(-1)?.id : undefined;
  const blocks: ReactNode[] = [];
  let lastIdentity = `${turn.attribution.provider}:${turn.attribution.model}`;
  for (let i = 0; i < turn.blocks.length; i++) {
    const item = turn.blocks[i]!;
    if (item.kind === "text" && `${item.provider}:${item.model}` !== lastIdentity) {
      lastIdentity = `${item.provider}:${item.model}`;
      blocks.push(<p key={`${item.id}:identity`} className="text-xs font-semibold text-fg-muted">{item.provider} · {item.model ?? "Model not recorded"}</p>);
    }
    if (item.kind === "tool" && !item.result?.isError) {
      const group = [item];
      while (turn.blocks[i + 1]?.kind === "tool" && !(turn.blocks[i + 1] as Extract<LogItem, { kind: "tool" }>).result?.isError) group.push(turn.blocks[++i] as typeof item);
      blocks.push(<details key={item.id} id={`evidence-${item.id}`} className="chat-activity text-sm text-fg-muted"><summary>{activityLabel(group)}{group.some(t => t.result === null) ? " · Working" : ""}</summary>{group.map(t => <Evidence key={t.id} item={t} />)}</details>);
    } else if (item.kind === "btw") blocks.push(item.direction === "OPERATOR"
      // `/btw` sits inside the run it was sent to, in order, so the reply and
      // what the agent did after it read the note are right below it.
      ? <div key={item.id} className="chat-user rounded-lg border border-accent/30 p-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold"><span>You · btw</span>{item.state !== null && <span className="font-normal text-fg-muted">· {btwDeliveryLabel(item.delivery, item.state)}</span>}</div>
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
        </div>
      : <div key={item.id} className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-fg-muted">Agent reply to your btw</div>
          <AssistantContent text={item.text} />
        </div>);
    else if (item.kind === "text") blocks.push(item.textKind === "thinking"
      ? <details key={item.id} className="chat-reasoning"><summary className="text-xs text-fg-muted">Provider reasoning{progress.phase === "thinking" && item === turn.blocks.at(-1) ? " · Thinking" : ""}</summary><AssistantContent text={item.text} /></details>
      : <div key={item.id} id={`block-${item.id}`} data-reading-anchor><AssistantContent text={item.text} streaming={item.id === streamingId} /></div>);
    else blocks.push(<Evidence key={item.id} item={item} />);
  }
  const tool = turn.blocks.find(block => block.kind === "tool" && !block.result?.isError);
  const longPrompt = prompt !== undefined && (prompt.length > 600 || prompt.split("\n").length > 8);
  const hasProblem = turn.blocks.some(block => block.kind === "error" || block.kind === "tool" && block.result?.isError || block.kind === "decision" && block.answers === null);

  return <article id={`turn-${turn.id}`} className="chat-exchange" aria-label={`Exchange ${number}: ${excerpt}`} data-phase={progress.phase}>
      {prompt !== undefined && <div id={promptId} data-reading-anchor tabIndex={-1} className="chat-user chat-exchange-prompt">
        <span className="sr-only">You</span>
        {workItem ? <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 break-words">{prompt}</span>
          <button type="button" className="rounded-md border border-line px-2 py-1 text-xs text-accent hover:bg-surface-2" onClick={() => setPreviewOpen(true)}>View work item</button>
          <WorkItemPreview item={workItem} open={previewOpen} onClose={() => setPreviewOpen(false)} /></div>
        : longPrompt ? <details className="chat-full-prompt"><summary><span className="chat-prompt-excerpt">{excerpt}</span><span className="mt-2 block text-xs font-semibold">Show full prompt</span></summary><p className="mt-3 whitespace-pre-wrap break-words">{prompt}</p></details>
          : <p className="whitespace-pre-wrap break-words">{prompt}</p>}
      </div>}
      <section className="chat-response" aria-labelledby={responseId}>
        <div className="chat-response-heading"><h2 id={responseId} className="chat-provider-name">{({claude:"Claude",codex:"Codex",cursor:"Cursor",copilot:"Copilot",grok:"Grok",kilocode:"Kilo Code"})[turn.attribution.provider]}</h2></div>
        <div className="chat-response-content space-y-4" aria-busy={progress.active}>{blocks}</div>
        {progress.active && <div role="status" className="chat-response-progress" aria-live="polite"><span className="chat-working-dots" aria-hidden><i /><i /><i /></span><span>{progress.label}{!text && (progress.phase === "working" || progress.phase === "starting") ? " · Waiting for the first reply" : ""}</span></div>}
        {!progress.active && !text && !hasProblem && <p className="mt-3 text-sm text-fg-muted">{progress.phase === "disconnected" ? "Connection lost. Reconnecting to recover this reply…" : progress.phase === "stopped" ? "Stopped before an answer arrived." : progress.phase === "recorded" ? "No answer text was recorded." : "Completed without answer text."}</p>}
        {turn.result && turn.result.state !== "done" && <p className="mt-4 text-sm text-fg-muted">{progress.label}{progress.phase === "stopped" && text ? " · Partial response preserved" : ""}</p>}
        <div className="chat-message-actions">
          {text && <CopyAnswer text={text} />}
          {hasChanges && <a href={`/changes/${encodeURIComponent(turn.id)}`}>View changes</a>}
          {tool && <a href={`#evidence-${tool.id}`} onClick={() => { const element = document.getElementById(`evidence-${tool.id}`); if (element instanceof HTMLDetailsElement) element.open = true; }}>View command evidence</a>}
          {onQuote && text && <button type="button" onClick={() => onQuote(window.getSelection()?.toString() || text)}>Quote to follow up</button>}
          {turn.blocks.length > 0 && <details><summary>More</summary><p className="mt-2">{turn.result ? `${(turn.result.elapsedMs / 1000).toFixed(1)} s · ${progress.label}` : progress.label}</p><CopyOriginal text={text} /><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{text}</pre><p>{turn.id} · {turn.attribution.provider} · {turn.attribution.model ?? "Model not recorded"}</p><time>{turn.prompt?.timestamp ?? turn.blocks[0]?.timestamp}</time>{turn.result?.usage && <pre>{JSON.stringify(turn.result.usage, null, 2)}</pre>}<pre className="max-h-80 overflow-auto whitespace-pre-wrap">{JSON.stringify({ prompt: turn.prompt, blocks: turn.blocks, result: turn.result }, null, 2)}</pre></details>}
        </div>
      </section>
  </article>;
}

"use client";

import { userSessionStorage } from "@/lib/identityStorage";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PromptOption, ProviderId, ProviderInfo } from "@hydra/shared";
import { modelLabel } from "@hydra/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import {
  allTargets,
  currentTargets,
  filterTargets,
  findMention,
  type MentionTarget,
} from "@/features/chat/lib/mentions";
import type { ModelSelection } from "@/features/providers/hooks/useModelSelection";
import { Menu } from "../../../components/ui/Menu";
import { ModelMenu } from "../../providers/components/ModelMenu";
import { Button } from "../../../components/ui/Button";

interface Props {
  suggestion?: { text: string; nonce: number; append?: boolean };
  note?: ReactNode;
  active?: boolean;
  quote?: string;
  onClearQuote?(): void;
  launchPending?: boolean;
  launchFailed?: string | null;
  draftKey?: string;
  busy?: boolean;
  defaultMode?: "ask" | "run";
  onQueue?(prompt: string, mode: "ask" | "run", stop: boolean): void;
  disabled: boolean;
  running: boolean;
  starting?: boolean;
  ownsWriter?: boolean;
  writer: { provider: ProviderId; model: string | null } | null;
  providers: ProviderInfo[];
  models: ModelSelection;
  selected: ProviderId;
  runBlockedReason: string | null;
  askBlockedReason: string | null;
  savedPrompt: PromptOption | null;
  context: ReactNode;
  workdir: string | null;
  onSubmit(prompt: string): void;
  onAsk(prompt: string): void;
  onInterrupt(): void;
  onTarget(provider: ProviderId, model: string | null): void;
  onClearSavedPrompt(): void;
}

export function Composer({
  suggestion, note,
  active: tabActive = true,
  quote = "", onClearQuote, launchPending = false, launchFailed = null, draftKey, busy = false, onQueue, defaultMode = "run",
  disabled,
  running,
  starting = false,
  ownsWriter = true,
  writer,
  providers,
  models,
  selected,
  runBlockedReason,
  askBlockedReason,
  savedPrompt,
  context,
  workdir,
  onSubmit,
  onAsk,
  onInterrupt,
  onTarget,
  onClearSavedPrompt,
}: Props) {
  const [value, setValue] = useState("");
  const [failedDraft, setFailedDraft] = useState("");
  const [askQuestion, setAskQuestion] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mode, setMode] = useState(defaultMode);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [modelOpen,setModelOpen] = useState(false);
  const submitted = useRef<string | null>(null);
  const wasPending = useRef(false);
  const draftLoaded = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const manualHeight = useRef(0);
  const autoHeight = useRef("");

  useEffect(() => {
    if (!draftKey) return;
    draftLoaded.current = false;
    const draft = userSessionStorage.getItem(`chat-draft:${draftKey}`);
    const timer = setTimeout(() => {
      if (draft) setValue(draft);
      const savedMode = userSessionStorage.getItem(`chat-mode:${draftKey}`);
      setMode(savedMode === "ask" || savedMode === "run" ? savedMode : defaultMode);
      setFailedDraft(userSessionStorage.getItem(`chat-submitted:${draftKey}`) ?? "");
      draftLoaded.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [draftKey, defaultMode]);

  useEffect(() => {
    if (draftKey && draftLoaded.current) userSessionStorage.setItem(`chat-draft:${draftKey}`, value);
  }, [value, draftKey]);

  useEffect(() => {
    if (wasPending.current && !launchPending && submitted.current !== null) {
      const sentDraft = submitted.current;
      if (launchFailed) {
        if (value.trim() === "") setValue(sentDraft);
        else setFailedDraft(sentDraft);
      } else {
        setFailedDraft("");
        if (draftKey) userSessionStorage.removeItem(`chat-submitted:${draftKey}`);
        onClearQuote?.();
      }
      submitted.current = null;
    }
    wasPending.current = launchPending;
  }, [launchPending, launchFailed, onClearQuote, draftKey, value]);

  const retainSubmission = (text: string) => {
    submitted.current = text;
    if (draftKey) userSessionStorage.setItem(`chat-submitted:${draftKey}`, text);
    setValue("");
    setAskQuestion("");
  };

  const withQuote = (text: string) => quote ? `${quote.split("\n").map(line => `> ${line}`).join("\n")}\n\n${text}` : text;

  const focusInput = () => {
    setCollapsed(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    if(!suggestion) return;
    const frame=requestAnimationFrame(() => {
      setValue(current => suggestion.append && current.trim() ? `${suggestion.text}\n\n${current}` : suggestion.text);
      if(suggestion.append) { submitted.current=null; setFailedDraft(""); if(draftKey) userSessionStorage.removeItem(`chat-submitted:${draftKey}`); }
      focusInput();
    });
    return () => cancelAnimationFrame(frame);
  },[suggestion,draftKey]);

  useEffect(() => {
    if (!quote) return;
    let focusFrame = 0;
    const frame = requestAnimationFrame(() => {
      setCollapsed(false);
      focusFrame = requestAnimationFrame(() => textareaRef.current?.focus());
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); };
  }, [quote]);

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null || !tabActive) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, manualHeight.current), expanded ? 400 : 176)}px`;
    autoHeight.current = element.style.height;
  }, [value, expanded, collapsed,tabActive]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.style.height !== autoHeight.current) manualHeight.current = parseFloat(element.style.height) || 0;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [savedPrompt]);

  useEffect(() => {
    if (!tabActive) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]") !== null) return;
      event.preventDefault();
      focusInput();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tabActive]);

  const mention = savedPrompt !== null || mentionDismissed ? null : findMention(value, caret);

  const suggestions = useMemo<MentionTarget[]>(() => {
    if (mention === null) return [];
    const pool = mention.query === "" ? currentTargets(providers, models) : allTargets(providers);
    return filterTargets(pool, mention.query).slice(0, 8);
  }, [mention, providers, models]);

  const open = mention !== null && suggestions.length > 0;
  const active = suggestions[Math.min(highlight, suggestions.length - 1)];

  const query = mention?.query ?? null;
  const [lastQuery, setLastQuery] = useState<string | null>(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setHighlight(0);
  }

  const sync = (element: HTMLTextAreaElement) => {
    setValue(element.value);
    setCaret(element.selectionStart);
    setMentionDismissed(false);
  };

  const applyTarget = (entry: MentionTarget) => {
    if (mention === null) return;
    onTarget(entry.provider, entry.model);
    const next = `${value.slice(0, mention.start)}${value.slice(mention.end)}`.replace(/^\s+/, "");
    setValue(next);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element === null) return;
      element.focus();
      const position = Math.min(mention.start, next.length);
      element.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const hasAskText = savedPrompt !== null || value.trim() !== "" || askQuestion.trim() !== "";
  const canRun = !disabled && !launchPending && !running && !starting && runBlockedReason === null && (savedPrompt !== null || value.trim() !== "");
  const canAsk = !disabled && !launchPending && askBlockedReason === null && hasAskText;
  const canQueue = busy && onQueue !== undefined && !disabled && !launchPending && savedPrompt === null && value.trim() !== "";
  const selectedReason = mode === "run" ? runBlockedReason : askBlockedReason;

  const selectMode = (next: "run" | "ask") => {
    setMode(next);
    if (draftKey) userSessionStorage.setItem(`chat-mode:${draftKey}`, next);
    focusInput();
  };

  const queue = (stop: boolean) => {
    if (!canQueue) return;
    retainSubmission(withQuote(value.trim()));
    onQueue?.(withQuote(value.trim()), mode, stop);
    textareaRef.current?.focus();
  };

  const ask = () => {
    if (!canAsk) return;
    if (savedPrompt !== null) {
      retainSubmission(value);
      onAsk(withQuote(askQuestion.trim()));
      return;
    }
    if (value.trim() === "") return;
    retainSubmission(value);
    onAsk(withQuote(value.trim()));
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (canQueue) { queue(false); return; }
    if (mode === "ask") { ask(); return; }
    if (!canRun) return;
    if (savedPrompt !== null) {
      onSubmit("");
      return;
    }
    if (value.trim() === "") return;
    retainSubmission(value);
    onSubmit(withQuote(value.trim()));
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (active !== undefined) applyTarget(active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const selectedInfo = providers.find(provider => provider.id === selected);
  const activeLabel = modelLabel(selected, models.resolve(selected));
  const writerLabel =
    writer === null
      ? null
      : [writer.provider, modelLabel(writer.provider, writer.model)].filter((part) => part !== null).join(" · ");
  const placeholder = disabled
    ? (runBlockedReason ?? askBlockedReason ?? "waiting for the backend…")
    : busy ? "Draft the next step while the agent works…"
    : mode === "run" ? "What should we build or change?"
    : `Ask ${selected} a question about this workspace…`;

  return (
    <div className="chat-composer relative min-w-0" data-expanded={expanded}>
      {open && (
        <div
          role="listbox"
          aria-label="Run target"
          className="glass absolute bottom-full left-3 z-30 mb-2 w-80 animate-slide-up overflow-hidden rounded-lg shadow-2xl"
        >
          <div className="border-b border-line px-2.5 py-1.5 text-xs uppercase tracking-wider text-fg-dim">
            run with…
          </div>
          {suggestions.map((entry, index) => {
            const isActive = entry === active;
            const entryTheme = providerTheme[entry.provider];
            return (
              <button
                key={`${entry.provider}:${entry.model ?? "__default__"}`}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyTarget(entry);
                }}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs",
                  isActive && "bg-surface-3",
                  !entry.available && "opacity-45",
                )}
              >
                <span className={cn("shrink-0", entryTheme.text)}>{entry.provider}</span>
                <span className="shrink-0 text-fg-dim">·</span>
                <span className="truncate text-fg">
                  {modelLabel(entry.provider, entry.model) ?? "default"}
                </span>
                <span className="ml-auto shrink-0 truncate pl-2 text-xs text-fg-dim">
                  {entry.hint}
                </span>
              </button>
            );
          })}
          <div className="border-t border-line px-2.5 py-1 text-xs text-fg-dim">
            ↑↓ move · ⏎ / tab pick · esc dismiss
          </div>
        </div>
      )}

      {collapsed ? <div className="flex items-center justify-between gap-3 px-4 py-2">
        <button type="button" className="chat-text-button" aria-label="Show composer" onClick={focusInput}>Write a message{value.trim() ? " · Draft" : ""}</button>
        {(running || starting) && ownsWriter && <Button size="sm" variant="danger" onClick={onInterrupt}>■ Stop</Button>}
      </div> : <>
        <div className="chat-composer-body px-4 pt-3">
          {failedDraft && <div role="status" className="mb-2 text-xs text-fg-muted">An unsent or unconfirmed message is retained.
            <button type="button" className="ml-2 underline" onClick={() => { setValue(current => current === failedDraft ? current : `${failedDraft}\n\n${current}`); setFailedDraft(""); focusInput(); }}>Restore message</button>
          </div>}
          {quote && <div className="mb-2 border-l-2 border-line-strong pl-3 text-sm text-fg-muted"><p className="max-h-28 overflow-auto whitespace-pre-wrap">{quote}</p><button type="button" className="text-xs" onClick={onClearQuote}>Remove quote</button></div>}
          {writer !== null && writerLabel !== null && !busy && <p className="mb-2 text-xs text-caution">{writerLabel} is changing this workspace. Ask is read-only.</p>}
          {!busy && selectedReason !== null && <p className="mb-2 text-xs text-warning">{selectedReason}</p>}
          {savedPrompt === null ? <textarea ref={textareaRef} rows={1} value={value} disabled={disabled} aria-label="Prompt" placeholder={placeholder}
            onChange={event => sync(event.target)} onKeyUp={event => setCaret(event.currentTarget.selectionStart)} onClick={event => setCaret(event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
            className="chat-prompt w-full bg-transparent text-fg placeholder:text-fg-dim disabled:opacity-50" />
          : <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm"><span>{savedPrompt.externalKey ?? savedPrompt.title}</span>
              <button type="button" className="chat-text-button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? "Hide" : "Preview"} instruction</button>
              <button type="button" className="app-icon-button" aria-label="Remove the attached work item" onClick={onClearSavedPrompt}>×</button>
            </div>
            {previewOpen && <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-fg-muted">{savedPrompt.content}</pre>}
            <p className="text-xs text-fg-muted">{mode === "run" ? "Run this work item in the workspace." : "Discuss this work item without changing files."}</p>
            {mode === "ask" && <input type="text" value={askQuestion} disabled={disabled} aria-label="Research question" placeholder={`Optional question for ${selected}`} onChange={event => setAskQuestion(event.target.value)} onKeyDown={onKeyDown} className="mt-2 w-full bg-transparent py-2 text-sm text-fg placeholder:text-fg-dim" />}
          </div>}
        </div>
        <div className="chat-composer-controls">
          <div ref={targetRef} className="chat-target-controls">
            <select aria-label="Provider for next message" value={selected} onChange={event => { const provider=event.target.value as ProviderId; onTarget(provider,models.resolve(provider)); setModelOpen(false); }}>
              {providers.length === 0 && <option value={selected}>{selected}</option>}
              {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.label}</option>)}
            </select>
            <div className="relative min-w-0">
              <button type="button" className="chat-model-button" aria-label="Choose model" aria-expanded={modelOpen} onClick={() => setModelOpen(!modelOpen)}>{activeLabel ?? "Default model"}<span aria-hidden>⌄</span></button>
              {modelOpen && selectedInfo && <ModelMenu boundaryRef={targetRef} provider={selected} options={selectedInfo.models} accessTier={selectedInfo.modelAccessTier}
                selectionMode={selectedInfo.modelSelectionMode} recommended={selectedInfo.tierDefaultModel} totalModels={selectedInfo.totalModels}
                selected={models.resolve(selected)} configured={selectedInfo.model} pinned={models.isPinned(selected)} placement="above"
                onSelect={model => { onTarget(selected,model); setModelOpen(false); }} onClear={() => { models.clear(selected); setModelOpen(false); }} onClose={() => setModelOpen(false)} />}
            </div>
          </div>
          <div role="group" aria-label="Message mode" className="chat-mode-controls">
            {(["run","ask"] as const).map(option => <button key={option} type="button" aria-label={option === "run" ? "Run" : "Ask"} aria-pressed={mode === option}
              title={option === "run" ? "Run can change this workspace" : "Ask is read-only research"} onClick={() => selectMode(option)}>{option === "run" ? <>Run<span> · Edit</span></> : <>Ask<span> · Read-only</span></>}</button>)}
          </div>
          <details className="chat-context-picker"><summary title="Context and work item">＋ Context{savedPrompt ? " · 1" : ""}</summary>
            <div className="chat-context-popover"><p className="mb-3 break-all text-xs text-fg-muted">{workdir}</p>{context}</div>
          </details>
          {note && <details className="chat-note-picker"><summary>Send note to current run</summary><div className="chat-context-popover">{note}</div></details>}
          <Menu label="Input options" placement="above" items={[
            {id:"expand",label:expanded ? "Shrink input" : "Expand input",disabled:savedPrompt !== null,onSelect:() => { manualHeight.current=0; setExpanded(!expanded); focusInput(); }},
            {id:"hide",label:"Hide composer",onSelect:() => setCollapsed(true)},
          ]} />
          <div className="chat-send-controls">
            {(running || starting) && ownsWriter && <Button size="sm" variant="danger" onClick={onInterrupt}>■ Stop</Button>}
            {canQueue && <Button variant="ghost" size="sm" onClick={() => queue(true)}>Stop & send</Button>}
            <Button size="sm" variant="primary" onClick={submit} disabled={busy ? !canQueue : mode === "run" ? !canRun : !canAsk} loading={launchPending || starting}
              title={busy ? "Send after the current reply finishes" : selectedReason ?? "Enter to send · Shift+Enter for a new line"}>
              {launchPending ? "Sending" : starting ? "Starting" : busy ? `Queue ${mode === "run" ? "Run" : "Ask"}` : mode === "run" ? savedPrompt ? "Run work item" : "Run task" : "Ask"}<span aria-hidden>↑</span>
            </Button>
          </div>
        </div>
      </>}
    </div>
  );
}

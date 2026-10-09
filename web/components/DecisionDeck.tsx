"use client";

import { useMemo, useState } from "react";
import type { AgentInputAnswer, ProviderId } from "@agent-console/shared";
import type { PendingAgentInput } from "@/lib/agentConsole";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { Button } from "./ui/Button";

export function DecisionDeck({ request, provider, onSubmit, onCancel }: {
  request: PendingAgentInput;
  provider: ProviderId;
  onSubmit(answers: Record<string, AgentInputAnswer>): boolean;
  onCancel(): void;
}) {
  const [answers, setAnswers] = useState<Record<string, AgentInputAnswer>>({});
  const [sent, setSent] = useState(false);
  const theme = providerTheme[provider];
  const answered = request.questions.filter((question) => {
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.trim() !== "";
  }).length;
  const complete = useMemo(() => request.questions.every((question) => {
    if (!question.required) return true;
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.trim() !== "";
  }), [answers, request.questions]);

  const choose = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));
  const toggle = (id: string, value: string) => setAnswers((current) => {
    const selected = Array.isArray(current[id]) ? current[id] as string[] : [];
    return { ...current, [id]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] };
  });
  const delegate = () => setAnswers(Object.fromEntries(request.questions.map((question) => [
    question.id,
    question.kind === "multiple" ? ["__agent_decide__"] : question.kind === "single" ? "__agent_decide__" : "Use your best judgment.",
  ])));
  const submit = () => {
    if (!complete || sent) return;
    if (onSubmit(answers)) setSent(true);
  };

  return (
    <section aria-label={`${provider} needs your input`} className="overflow-hidden rounded-xl border border-accent/35 bg-surface-1 shadow-xl shadow-black/20 ring-1 ring-inset ring-accent/10">
      <header className="flex flex-wrap items-start gap-3 border-b border-line bg-accent/[0.06] px-4 py-3">
        <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm ring-1 ring-inset", theme.chip)} aria-hidden>?</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold text-fg">{request.heading}</h3>
            <span className={cn("text-[10px] uppercase tracking-wider", theme.text)}>{provider}</span>
          </div>
          <p className="mt-0.5 text-xs text-fg-dim">The agent is paused. Your answers go back into this same run.</p>
        </div>
        <span className="numeric rounded-full bg-surface-2 px-2 py-1 text-[10px] text-fg-muted ring-1 ring-inset ring-line">{answered} of {request.questions.length}</span>
      </header>

      <div className="max-h-[52vh] space-y-5 overflow-y-auto px-4 py-4">
        {request.questions.map((question, index) => {
          const answer = answers[question.id];
          return (
            <fieldset key={question.id} className="min-w-0">
              <legend className="flex w-full items-start gap-2 text-[13px] font-medium leading-relaxed text-fg">
                <span className="numeric mt-0.5 text-[10px] text-fg-dim">{String(index + 1).padStart(2, "0")}</span>
                <span>{question.prompt}{!question.required && <span className="ml-1 font-normal text-fg-dim">optional</span>}</span>
              </legend>
              {question.why !== null && <p className="ml-6 mt-1 text-[11px] leading-relaxed text-fg-dim">{question.why}</p>}
              {question.kind === "text" ? (
                <textarea value={typeof answer === "string" ? answer : ""} onChange={(event) => choose(question.id, event.target.value)} rows={3} placeholder="Type your answer…" className="ml-6 mt-2 w-[calc(100%-1.5rem)] resize-y rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg ring-1 ring-inset ring-line placeholder:text-fg-dim focus:outline-none focus:ring-2 focus:ring-accent/60" />
              ) : (
                <div className="ml-6 mt-2 grid gap-2 sm:grid-cols-2">
                  {question.options.map((option) => {
                    const selected = question.kind === "multiple" ? Array.isArray(answer) && answer.includes(option.value) : answer === option.value;
                    return (
                      <button key={option.value} type="button" role={question.kind === "multiple" ? "checkbox" : "radio"} aria-checked={selected} onClick={() => question.kind === "multiple" ? toggle(question.id, option.value) : choose(question.id, option.value)} className={cn("rounded-lg px-3 py-2 text-left ring-1 ring-inset transition-colors", selected ? "bg-accent/10 text-fg ring-accent/60" : "bg-surface-2 text-fg-muted ring-line hover:bg-surface-3 hover:text-fg") }>
                        <span className="flex items-center gap-2 text-xs font-medium"><span aria-hidden>{question.kind === "multiple" ? selected ? "☑" : "☐" : selected ? "◉" : "○"}</span>{option.label}{question.recommendation === option.value && <span className="ml-auto text-[9px] uppercase tracking-wider text-accent">Recommended</span>}</span>
                        {option.description !== null && <span className="mt-1 block pl-5 text-[11px] leading-relaxed text-fg-dim">{option.description}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/50 px-4 py-3">
        <button type="button" onClick={delegate} disabled={sent} className="text-xs text-fg-dim underline-offset-4 hover:text-fg hover:underline disabled:opacity-40">Use your best judgment</button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={sent}>Cancel run</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={!complete || sent} loading={sent}>Send answers &amp; continue</Button>
      </footer>
    </section>
  );
}

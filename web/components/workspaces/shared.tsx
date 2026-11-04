"use client";

import { useCallback, useState, type ReactNode } from "react";
import type { ProgramRecord, PromptRecord } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useToast } from "../ui/Toast";

/**
 * Runs a mutation with a busy flag, a toast on failure, and a refresh after.
 * Every workspace modal mutates the same tree, so they share this.
 */
export function useAct(refresh: () => Promise<unknown>) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useCallback(
    async (operation: () => Promise<unknown>, success?: string, reload = true) => {
      setBusy(true);
      try {
        await operation();
        if (reload) await refresh();
        if (success !== undefined) toast.success(success);
        return true;
      } catch (error) {
        toast.error("That did not work", error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast],
  );
  return { act, busy };
}

/** Work items in a program, and how many are done or blocked. */
export function programProgress(program: ProgramRecord) {
  const prompts = program.suites.flatMap((suite) => suite.prompts);
  return {
    suites: program.suites.length,
    total: prompts.length,
    done: prompts.filter((prompt) => prompt.status === "DONE").length,
    blocked: prompts.filter((prompt) => prompt.status === "BLOCKED").length,
    active: prompts.filter((prompt) => prompt.status === "IN_PROGRESS").length,
  };
}

export function statusDotClass(status: PromptRecord["status"]) {
  return status === "DONE" ? "bg-success" : status === "BLOCKED" ? "bg-warning" : status === "IN_PROGRESS" ? "bg-info" : "bg-fg-dim";
}

export function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function lineCount(text: string) {
  return text.trim() === "" ? 0 : text.trimEnd().split("\n").length;
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange(value: T): void;
  label: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-0 p-0.5" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            value === option.value ? "bg-surface-3 text-fg shadow-sm" : "text-fg-dim hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SectionHeading({ title, hint, actions }: { title: string; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
        {hint !== undefined && <p className="mt-0.5 text-[11px] text-fg-dim">{hint}</p>}
      </div>
      {actions}
    </div>
  );
}

type IconProps = { className?: string };

export function ChevronIcon({ className }: IconProps) {
  return <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function FolderIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3l1.5 1.75h7A1.75 1.75 0 0 1 17.5 7v7.25A1.75 1.75 0 0 1 15.75 16h-11A2.25 2.25 0 0 1 2.5 13.75v-8.5Z" fill="currentColor" opacity=".22"/><path d="M2.5 6.5h15M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3l1.5 1.75h7A1.75 1.75 0 0 1 17.5 7v7.25A1.75 1.75 0 0 1 15.75 16h-11A2.25 2.25 0 0 1 2.5 13.75v-8.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>;
}
export function StackIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="m10 2.75 7.25 3.75L10 10.25 2.75 6.5 10 2.75Z" fill="currentColor" opacity=".2"/><path d="m3 10 7 3.5 7-3.5M3 13.5l7 3.5 7-3.5M2.75 6.5 10 2.75l7.25 3.75L10 10.25 2.75 6.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
export function DocumentIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M5 2.5h6l4 4v11H5v-15Z" fill="currentColor" opacity=".16"/><path d="M11 2.5H5v15h10v-11m-4-4 4 4m-4-4v4h4M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
export function SparkIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6L10 2.5Z" fill="currentColor" opacity=".2" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>;
}
export function GearIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.25"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>;
}
export function InboxIcon({ className }: IconProps) {
  return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M3 11.5 5 4h10l2 7.5v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M3 11.5h4l1 2h4l1-2h4" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>;
}

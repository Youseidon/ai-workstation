"use client";

import Link from "next/link";
import type { PromptOption, WorkspaceRecord } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { Badge, type Tone } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Combobox, type ComboboxItem } from "./ui/Combobox";

/** How a saved prompt reads at a glance. */
export function promptState(prompt: PromptOption): { text: string; tone: Tone } {
  if (prompt.currentRun?.processActive === true) return { text: "agent working", tone: "info" };
  if (prompt.recovery.kind === "start_unknown") return { text: "ownership unknown", tone: "warning" };
  if (prompt.recoverable) return { text: "recovery needed", tone: "caution" };
  if (prompt.blockedBy.length > 0) return { text: "waiting", tone: "neutral" };
  switch (prompt.status) {
    case "DONE": return { text: "done", tone: "success" };
    case "BLOCKED": return { text: "blocked", tone: "warning" };
    case "IN_PROGRESS": return { text: "in progress", tone: "info" };
    case "SKIPPED": return { text: "skipped", tone: "neutral" };
    default: return { text: "ready", tone: "accent" };
  }
}

interface Props {
  workspaceId: number | null;
  prompts: PromptOption[];
  savedPromptId: number | null;
  onPrompt(id: number | null): void;
  disabled: boolean;
  activeWorkspace: WorkspaceRecord | null;
  onRecover(): void;
}

/**
 * Work-item chip for the composer's header. Workspace is chosen in the sidebar
 * beacon — only the prompt within that project is picked here.
 */
export function ContextPicker({
  workspaceId,
  prompts,
  savedPromptId,
  onPrompt,
  disabled,
  activeWorkspace,
  onRecover,
}: Props) {
  const promptItems: ComboboxItem<number>[] = prompts.map((prompt) => {
    const state = promptState(prompt);
    return {
      value: prompt.id,
      label: prompt.title,
      prefix: prompt.externalKey ?? undefined,
      description: `${prompt.programName} / ${prompt.suiteName}`,
      badge: { text: state.text, tone: state.tone },
      note: prompt.blockedBy.length > 0 ? `waiting on ${prompt.blockedBy.join(", ")}` : undefined,
      keywords: prompt.status,
    };
  });

  const savedPrompt = prompts.find((prompt) => prompt.id === savedPromptId) ?? null;
  const savedRun = savedPrompt?.currentRun ?? null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Combobox
        label="Work item"
        value={savedPromptId}
        items={promptItems}
        onChange={(id) => onPrompt(id)}
        disabled={disabled || workspaceId === null}
        placeholder={workspaceId === null ? "Choose a workspace first" : "Custom prompt"}
        emptyText="This workspace has no saved work items."
        className="w-56"
        widthClass="w-[30rem]"
        leading={
          <button
            type="button"
            onClick={() => onPrompt(null)}
            className={cn(
              "flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-xs",
              savedPromptId === null ? "text-accent" : "text-fg-muted hover:bg-surface-3",
            )}
          >
            <span className="flex-1">Custom prompt — type your own instruction</span>
            {savedPromptId === null && <span aria-hidden>✓</span>}
          </button>
        }
      />

      {savedPrompt !== null && (
        <Button size="sm" variant="ghost" onClick={() => onPrompt(null)} title="Clear the selected work item">
          Clear
        </Button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {activeWorkspace !== null && !activeWorkspace.workDirectoryExists && (
          <Badge tone="danger" dot>
            working directory is missing
          </Badge>
        )}
        {savedRun?.processActive === true && (
          <>
            <Badge tone="info" dot pulse>
              agent working · {savedRun.provider}
            </Badge>
            <Link
              href="/activity"
              className="rounded-md px-2 py-1 text-xs text-info ring-1 ring-inset ring-info/30 transition-colors hover:bg-info/10"
            >
              View session
            </Link>
          </>
        )}
        {savedPrompt?.recoverable === true && (
          <Button size="sm" variant="secondary" onClick={onRecover}>
            Recover interrupted run
          </Button>
        )}
        {savedPrompt?.recovery.kind === "start_unknown" && (
          <div
            role="status"
            data-testid="start-unknown-warning"
            className="max-w-full min-w-0 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] leading-4 text-warning"
          >
            <span className="font-semibold">Ownership unknown.</span>{" "}
            <span className="break-words text-fg-muted">
              Confirm provider process state before recovery. Recovery stays blocked until the server knows the previous start is stopped or no spawn.
            </span>
          </div>
        )}
        {savedPrompt?.status === "IN_PROGRESS" &&
          savedRun?.processActive !== true &&
          savedPrompt.recoverable !== true &&
          savedPrompt.recovery.kind !== "start_unknown" && (
            <Badge tone="warning">reconciling run state…</Badge>
          )}
      </div>
    </div>
  );
}

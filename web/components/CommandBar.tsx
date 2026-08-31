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
  workspaces: WorkspaceRecord[];
  workspaceId: number | null;
  onWorkspace(id: number): void;
  prompts: PromptOption[];
  savedPromptId: number | null;
  onPrompt(id: number | null): void;
  disabled: boolean;
  activeWorkspace: WorkspaceRecord | null;
  onRecover(): void;
}

/**
 * Where a run's context is chosen: which workspace, and which work item.
 *
 * This used to be a one-line strip of native selects wedged between the status
 * bar and the composer — below the transcript, nowhere near either the thing it
 * configured or the place you act. Selection belongs at the top, with the
 * composer at the bottom for doing.
 */
export function CommandBar({
  workspaces,
  workspaceId,
  onWorkspace,
  prompts,
  savedPromptId,
  onPrompt,
  disabled,
  activeWorkspace,
  onRecover,
}: Props) {
  const workspaceItems: ComboboxItem<number>[] = workspaces.map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
    description: workspace.workDirectory,
    badge: workspace.workDirectoryExists
      ? undefined
      : { text: "missing directory", tone: "danger" as Tone },
  }));

  const promptItems: ComboboxItem<number>[] = prompts.map((prompt) => {
    const state = promptState(prompt);
    return {
      value: prompt.id,
      label: prompt.title,
      prefix: prompt.externalKey ?? undefined,
      description: `${prompt.programName} / ${prompt.suiteName}`,
      badge: { text: state.text, tone: state.tone },
      note: prompt.blockedBy.length > 0 ? `waiting on ${prompt.blockedBy.join(", ")}` : undefined,
      disabled: prompt.blockedBy.length > 0,
      keywords: prompt.status,
    };
  });

  const savedPrompt = prompts.find((prompt) => prompt.id === savedPromptId) ?? null;
  const savedRun = savedPrompt?.currentRun ?? null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-1 px-4 py-2">
      <label className="text-[10px] uppercase tracking-wider text-fg-dim">Workspace</label>
      <Combobox
        label="Workspace"
        value={workspaceId}
        items={workspaceItems}
        onChange={onWorkspace}
        disabled={disabled}
        placeholder={workspaces.length === 0 ? "No workspaces yet" : "Choose a workspace"}
        emptyText="No workspaces match."
        className="w-56"
        widthClass="w-[24rem]"
      />

      <span aria-hidden className="text-fg-dim">▸</span>

      <label className="text-[10px] uppercase tracking-wider text-fg-dim">Work item</label>
      <Combobox
        label="Work item"
        value={savedPromptId}
        items={promptItems}
        onChange={(id) => onPrompt(id)}
        disabled={disabled || workspaceId === null}
        placeholder="Custom prompt"
        emptyText="This workspace has no saved work items."
        className="w-72"
        widthClass="w-[34rem]"
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
              href="/operations?view=sessions"
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
        {savedPrompt?.status === "IN_PROGRESS" &&
          savedRun?.processActive !== true &&
          savedPrompt.recoverable !== true && (
            <Badge tone="warning">reconciling run state…</Badge>
          )}
      </div>
    </div>
  );
}

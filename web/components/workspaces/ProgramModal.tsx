"use client";

import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseVerifyBlock } from "@agent-console/shared";
import type { AgentRequestTarget, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { workspaceApi } from "@/lib/workspacesApi";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { TextArea, TextInput } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { useDialogs } from "../ui/Dialogs";
import {
  ChevronIcon, DocumentIcon, FolderIcon, Segmented, SparkIcon, StackIcon,
  formatDate, programProgress, statusDotClass, useAct,
} from "./shared";

interface Props {
  serverUrl: string;
  program: ProgramRecord;
  /** Pending proposals that target this program. */
  pendingProposals: number;
  refresh(): Promise<unknown>;
  onClose(): void;
  /** Ask an agent about, or for changes to, the selected part of the program. */
  onPropose(target: AgentRequestTarget): void;
  onReviewProposals(): void;
}

type Selection = { suiteId: number | null; promptId: number | null };

/**
 * One program, opened: its suites and work items on the left, the selected
 * one on the right. Edits save in place; changes an agent should make go
 * through "Propose changes with AI", which opens a reviewable proposal.
 */
export function ProgramModal({ serverUrl, program, pendingProposals, refresh, onClose, onPropose, onReviewProposals }: Props) {
  const dialogs = useDialogs();
  const { act, busy } = useAct(refresh);
  const [selection, setSelection] = useState<Selection>({ suiteId: null, promptId: null });
  const [expandedSuites, setExpandedSuites] = useState<Set<number>>(() => new Set(program.suites.map((suite) => suite.id)));
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(() => new Set());

  const suite = program.suites.find((entry) => entry.id === selection.suiteId) ?? null;
  const prompt = suite?.prompts.find((entry) => entry.id === selection.promptId) ?? null;
  const progress = programProgress(program);

  const create = async (kind: "suite" | "prompt", parentId: number) => {
    const name = await dialogs.prompt({
      title: kind === "prompt" ? "New work item" : "New suite",
      label: kind === "prompt" ? "Title" : "Suite name",
      placeholder: kind === "prompt" ? "What should the agent accomplish?" : "e.g. Database migration",
      validate: (value) => (value.length < 2 ? "Give it a name of at least two characters." : null),
    });
    if (name === null) return;
    if (kind === "suite") {
      await act(() => workspaceApi.createChild(serverUrl, "programs", parentId, "suites", { name, overview: "" }), "Suite created");
    } else {
      await act(
        () => workspaceApi.createChild(serverUrl, "suites", parentId, "prompts", { title: name, content: "Describe the task here." }),
        "Work item created",
      );
      setExpandedSuites((current) => new Set(current).add(parentId));
    }
  };

  const remove = async (kind: "program" | "suite" | "prompt", id: number, name: string) => {
    const label = kind === "prompt" ? "work item" : kind;
    const confirmed = await dialogs.confirm({
      title: `Delete this ${label}?`,
      description:
        kind === "prompt"
          ? `“${name}” and its history will be removed.`
          : `“${name}” and everything inside it will be removed. This cannot be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    const ok = await act(() => workspaceApi.removeChild(serverUrl, `${kind}s` as "programs" | "suites" | "prompts", id), "Deleted");
    if (!ok) return;
    if (kind === "program") onClose();
    else setSelection(kind === "suite" ? { suiteId: null, promptId: null } : { suiteId: selection.suiteId, promptId: null });
  };

  const target: AgentRequestTarget = { kind: "program", programId: program.id, suiteId: selection.suiteId, promptId: selection.promptId };
  const proposeLabel = prompt !== null ? "this work item" : suite !== null ? "this suite" : "this program";

  const renderPrompt = (entry: PromptRecord, owner: SuiteRecord, level: number): ReactNode => {
    const children = owner.prompts.filter((child) => child.parentPromptId === entry.id);
    const open = expandedPrompts.has(entry.id);
    return (
      <div key={entry.id} role="treeitem" aria-selected={entry.id === selection.promptId} aria-expanded={children.length > 0 ? open : undefined}>
        <TreeRow
          level={level}
          active={entry.id === selection.promptId}
          expanded={open}
          leaf={children.length === 0}
          icon={<span className={cn("mx-1 size-2 rounded-full", statusDotClass(entry.status))} title={entry.status.toLowerCase()} />}
          label={entry.title}
          meta={entry.externalKey ?? undefined}
          onClick={() => {
            setSelection({ suiteId: owner.id, promptId: entry.id });
            if (children.length > 0) setExpandedPrompts((current) => toggle(current, entry.id));
          }}
        />
        {open && children.length > 0 && <div role="group">{children.map((child) => renderPrompt(child, owner, level + 1))}</div>}
      </div>
    );
  };

  return (
    <Modal
      open
      size="2xl"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <FolderIcon className="size-4 text-info" />
          {program.name}
        </span>
      }
      description={`${progress.suites} suite${progress.suites === 1 ? "" : "s"} · ${progress.total} work item${progress.total === 1 ? "" : "s"} · ${progress.done} done${progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ""}`}
      headerActions={
        pendingProposals > 0 ? (
          <button type="button" onClick={onReviewProposals} className="mt-0.5 flex shrink-0 items-center gap-2 text-[11px] text-fg-muted hover:text-fg">
            <Badge tone="info">{pendingProposals} pending</Badge>
            <span className="hidden sm:inline">Review →</span>
          </button>
        ) : undefined
      }
      bodyClassName="p-0"
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-danger! hover:bg-danger/10" disabled={busy} onClick={() => void remove("program", program.id, program.name)}>
            Delete program
          </Button>
          <Button variant="secondary" iconLeft={<SparkIcon className="size-4 text-accent" />} onClick={() => onPropose(target)}>
            Ask AI about {proposeLabel}
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="grid h-[min(68vh,44rem)] grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
        <nav className="min-h-0 overflow-y-auto border-b border-line bg-surface-1/60 p-2 md:border-b-0 md:border-r" role="tree" aria-label={`${program.name} contents`}>
          <TreeRow
            level={0}
            active={selection.suiteId === null}
            leaf
            icon={<FolderIcon className="size-4 text-info" />}
            label="Program overview"
            onClick={() => setSelection({ suiteId: null, promptId: null })}
          />
          <div className="my-1.5 border-t border-line" />
          {program.suites.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-fg-dim">No suites yet. Suites group work items that run together.</p>
          )}
          {program.suites.map((entry) => {
            const open = expandedSuites.has(entry.id);
            return (
              <div key={entry.id} role="treeitem" aria-expanded={open} aria-selected={entry.id === selection.suiteId && selection.promptId === null}>
                <TreeRow
                  level={0}
                  active={entry.id === selection.suiteId && selection.promptId === null}
                  expanded={open}
                  icon={<StackIcon className="size-4 text-violet" />}
                  label={entry.name}
                  meta={`${entry.prompts.length}`}
                  onClick={() => {
                    const alreadySelected = entry.id === selection.suiteId && selection.promptId === null;
                    setSelection({ suiteId: entry.id, promptId: null });
                    if (alreadySelected || !open) setExpandedSuites((current) => toggle(current, entry.id));
                  }}
                />
                {open && (
                  <div role="group">
                    {entry.prompts.filter((child) => child.parentPromptId === null).map((child) => renderPrompt(child, entry, 1))}
                    <TreeAdd level={1} label="Work item" disabled={busy} onClick={() => void create("prompt", entry.id)} />
                  </div>
                )}
              </div>
            );
          })}
          <TreeAdd level={0} label="Suite" disabled={busy} onClick={() => void create("suite", program.id)} />
        </nav>

        <section className="min-h-0 overflow-y-auto">
          {prompt !== null ? (
            <PromptEditor
              key={`${prompt.id}:${prompt.updatedAt}`}
              value={prompt}
              busy={busy}
              onSave={(patch) => act(() => workspaceApi.updateChild(serverUrl, "prompts", prompt.id, patch), "Work item saved")}
              onDelete={() => void remove("prompt", prompt.id, prompt.title)}
            />
          ) : suite !== null ? (
            <NamedEditor
              key={`${suite.id}:${suite.updatedAt}`}
              kind="suite"
              value={suite}
              busy={busy}
              onSave={(patch) => act(() => workspaceApi.updateChild(serverUrl, "suites", suite.id, patch), "Suite saved")}
              onDelete={() => void remove("suite", suite.id, suite.name)}
            />
          ) : (
            <NamedEditor
              key={`${program.id}:${program.updatedAt}`}
              kind="program"
              value={program}
              busy={busy}
              onSave={(patch) => act(() => workspaceApi.updateChild(serverUrl, "programs", program.id, patch), "Program saved")}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}

function toggle(current: Set<number>, id: number) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function TreeRow({ level, active, expanded, leaf = false, icon, label, meta, onClick }: {
  level: number; active: boolean; expanded?: boolean; leaf?: boolean; icon: ReactNode; label: string; meta?: string; onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      style={{ paddingLeft: `${0.5 + level * 1.1}rem` }}
      className={cn(
        "mb-0.5 flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors",
        active ? "bg-surface-3 text-fg shadow-sm" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <ChevronIcon className={cn("size-3 shrink-0 transition-transform", leaf && "invisible", expanded && "rotate-90")} />
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
      {meta !== undefined && <span className="shrink-0 font-mono text-[9px] tabular-nums text-fg-dim">{meta}</span>}
    </button>
  );
}

function TreeAdd({ level, label, disabled, onClick }: { level: number; label: string; disabled: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{ paddingLeft: `${1.75 + level * 1.1}rem` }}
      className="mb-0.5 flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[11px] text-fg-dim hover:bg-surface-2 hover:text-accent disabled:opacity-40"
    >
      <span className="text-sm leading-none">+</span>
      {label}
    </button>
  );
}

function DetailHeader({ eyebrow, title, aside }: { eyebrow: ReactNode; title: string; aside?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-4">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-dim">{eyebrow}</div>
        <h3 className="truncate text-base font-semibold tracking-tight text-fg">{title}</h3>
      </div>
      {aside}
    </header>
  );
}

function NamedEditor({ value, kind, busy, onSave, onDelete }: {
  value: ProgramRecord | SuiteRecord;
  kind: "program" | "suite";
  busy: boolean;
  onSave(patch: { name: string; overview: string }): Promise<boolean>;
  onDelete?(): void;
}) {
  const [draft, setDraft] = useState({ name: value.name, overview: value.overview });
  const dirty = draft.name !== value.name || draft.overview !== value.overview;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft);
      }}
    >
      <DetailHeader
        eyebrow={kind === "program" ? <><FolderIcon className="size-3.5 text-info" /> Program</> : <><StackIcon className="size-3.5 text-violet" /> Suite {value.externalKey}</>}
        title={draft.name || `Untitled ${kind}`}
        aside={<span className="text-[10px] text-fg-dim">Updated {formatDate(value.updatedAt)}</span>}
      />
      <div className="space-y-4 px-6 py-5">
        <TextInput label="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <TextArea
          label="Overview"
          rows={8}
          hint={`Context the agent is given for every work item in this ${kind}.`}
          value={draft.overview}
          onChange={(event) => setDraft({ ...draft, overview: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={!dirty} loading={busy && dirty}>Save {kind}</Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setDraft({ name: value.name, overview: value.overview })}>Revert</Button>
          )}
          {onDelete !== undefined && (
            <Button variant="ghost" size="sm" className="ml-auto text-danger! hover:bg-danger/10" onClick={onDelete}>Delete {kind}</Button>
          )}
        </div>
      </div>
    </form>
  );
}

function PromptEditor({ value, busy, onSave, onDelete }: {
  value: PromptRecord;
  busy: boolean;
  onSave(patch: { title: string; content: string }): Promise<boolean>;
  onDelete(): void;
}) {
  const [draft, setDraft] = useState({ title: value.title, content: value.content });
  const [mode, setMode] = useState<"view" | "edit">("view");
  const dirty = draft.title !== value.title || draft.content !== value.content;
  const verifyCommands = useMemo(() => parseVerifyBlock(draft.content).commands, [draft.content]);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onSave(draft)) setMode("view");
      }}
    >
      <DetailHeader
        eyebrow={<><DocumentIcon className="size-3.5 text-accent" /> Work item {value.externalKey !== null && <span className="font-mono normal-case tracking-normal">{value.externalKey}</span>}</>}
        title={draft.title || "Untitled work item"}
        aside={
          <div className="flex items-center gap-2">
            <Badge tone={value.status === "DONE" ? "success" : value.status === "BLOCKED" ? "warning" : value.status === "IN_PROGRESS" ? "info" : "neutral"}>
              {value.status.toLowerCase().replace("_", " ")}
            </Badge>
            <Segmented<"view" | "edit"> label="Work item mode" value={mode} onChange={setMode} options={[{ value: "view", label: "Preview" }, { value: "edit", label: "Edit" }]} />
          </div>
        }
      />

      {mode === "view" ? (
        <article className="prompt-document px-6 py-5">
          {draft.content.trim() === "" ? (
            <p className="text-sm italic text-fg-dim">No instructions have been written yet.</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.content}</ReactMarkdown>
          )}
        </article>
      ) : (
        <div className="space-y-4 px-6 py-5">
          <TextInput label="Title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <TextArea
            label="Instructions"
            rows={16}
            className="font-terminal"
            hint="Markdown. A ## Verify block of shell commands becomes this item's definition of done."
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </div>
      )}

      {verifyCommands.length > 0 && (
        <div className="mx-6 mb-4 rounded-md border border-line bg-surface-0/60 px-3 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">Checked when marked done</p>
          <ul className="space-y-1 font-mono text-[11px] text-fg-muted">
            {verifyCommands.map((command) => (
              <li key={command.text} className="truncate" title={command.text}>{command.text}</li>
            ))}
          </ul>
        </div>
      )}

      {value.result !== "" && mode === "view" && (
        <div className="mx-6 mb-4 rounded-md border border-line bg-surface-2/50 px-3 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">Latest result</p>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">{value.result}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-3">
        {mode === "view" ? (
          <Button variant="secondary" size="sm" onClick={() => setMode("edit")}>Edit work item</Button>
        ) : (
          <>
            <Button type="submit" variant="primary" size="sm" disabled={!dirty} loading={busy && dirty}>Save changes</Button>
            <Button variant="ghost" size="sm" onClick={() => { setDraft({ title: value.title, content: value.content }); setMode("view"); }}>
              {dirty ? "Revert" : "Cancel"}
            </Button>
          </>
        )}
        <span className="text-[10px] text-fg-dim">Updated {formatDate(value.updatedAt)}</span>
        <Button variant="ghost" size="sm" className="ml-auto text-danger! hover:bg-danger/10" onClick={onDelete}>Delete</Button>
      </div>
    </form>
  );
}

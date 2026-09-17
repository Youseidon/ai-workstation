"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseVerifyBlock } from "@agent-console/shared";
import type {
  ProgramRecord,
  PromptRecord,
  SuiteRecord,
  WorkspaceRecord,
  WorkspaceTree,
} from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextArea, TextInput } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { Skeleton } from "./ui/Spinner";
import { useDialogs } from "./ui/Dialogs";
import { ProgramAgentPanel } from "./programs/ProgramAgentPanel";
import { ProgramDraftPanel } from "./programs/ProgramDraftPanel";
import { useToast } from "./ui/Toast";

type Kind = "program" | "suite" | "prompt";
type InstructionField = "claudeMd" | "agentsMd";

/**
 * The execution library: workspaces, and the programs, suites and work items
 * inside them.
 *
 * Creation used to go through `window.prompt` and deletion through
 * `window.confirm` — neither can be labelled, validated, themed or guarded, and
 * deleting a workspace cascades through every session and verification it owns.
 * Inputs are now labelled, errors surface as toasts rather than a bar bolted to
 * the top of the page, and the destructive cascade asks you to type the name.
 */
export function WorkspaceManager({ serverUrl }: { serverUrl: string }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const { workspaceId: globalWorkspaceId, setWorkspaceId, refresh: refreshGlobal } = useWorkspace();
  const globalIdRef = useRef(globalWorkspaceId);
  useEffect(() => {
    globalIdRef.current = globalWorkspaceId;
  }, [globalWorkspaceId]);
  const [items, setItems] = useState<WorkspaceRecord[] | null>(null);
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [programId, setProgramId] = useState<number | null>(null);
  const [suiteId, setSuiteId] = useState<number | null>(null);
  const [promptId, setPromptId] = useState<number | null>(null);
  const [instructionField, setInstructionField] = useState<InstructionField | null>(null);
  const [expandedPrograms, setExpandedPrograms] = useState<Set<number>>(() => new Set());
  const [expandedSuites, setExpandedSuites] = useState<Set<number>>(() => new Set());
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  // Bumped when a revision is opened from a program: remounts the drafts panel
  // with that draft open, and scrolls to it.
  const [draftsFocus, setDraftsFocus] = useState<{ generation: number; draftId: number | null }>({ generation: 0, draftId: null });
  const draftsPanel = useRef<HTMLDivElement>(null);

  const program = tree?.programs.find((x) => x.id === programId) ?? null;
  const suite = program?.suites.find((x) => x.id === suiteId) ?? null;
  const prompt = suite?.prompts.find((x) => x.id === promptId) ?? null;

  const loadList = useCallback(
    (select?: number) =>
      workspaceApi
        .list(serverUrl)
        .then(async (list) => {
          setItems(list);
          const preferred = select ?? globalIdRef.current;
          const id =
            preferred !== null && preferred !== undefined && list.some((item) => item.id === preferred)
              ? preferred
              : list[0]?.id;
          setTree(id === undefined ? null : await workspaceApi.tree(serverUrl, id));
          await refreshGlobal();
        })
        .catch(() => setItems([])),
    [serverUrl, refreshGlobal],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const refresh = useCallback(async () => {
    if (tree === null) return;
    setTree(await workspaceApi.tree(serverUrl, tree.id));
  }, [serverUrl, tree]);

  /** Runs a mutation with a spinner, a toast on failure, and a refresh after. */
  const act = async (operation: () => Promise<unknown>, success?: string, reload = true) => {
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
  };

  const choose = async (id: number) => {
    setProgramId(null);
    setSuiteId(null);
    setPromptId(null);
    setInstructionField(null);
    setExpandedPrograms(new Set());
    setExpandedSuites(new Set());
    setExpandedPrompts(new Set());
    setWorkspaceId(id);
    try {
      setTree(await workspaceApi.tree(serverUrl, id));
    } catch (error) {
      toast.error("Could not open workspace", error instanceof Error ? error.message : String(error));
    }
  };

  const toggleProgram = (id: number) => {
    setExpandedPrograms((current) => toggleSet(current, id));
  };

  const toggleSuite = (id: number) => {
    setExpandedSuites((current) => toggleSet(current, id));
  };

  const togglePrompt = (id: number) => {
    setExpandedPrompts((current) => toggleSet(current, id));
  };

  const create = async (kind: Kind, parentId?: number) => {
    const name = await dialogs.prompt({
      title: kind === "prompt" ? "New work item" : `New ${kind}`,
      label: kind === "prompt" ? "Title" : `${kind[0]!.toUpperCase()}${kind.slice(1)} name`,
      placeholder: kind === "prompt" ? "What should the agent accomplish?" : `${kind} name`,
      validate: (value) => (value.length < 2 ? "Give it a name of at least two characters." : null),
    });
    if (name === null) return;
    if (kind === "program" && tree !== null) {
      await act(
        () => workspaceApi.createChild(serverUrl, "workspaces", tree.id, "programs", { name, overview: "" }),
        "Program created",
      );
    } else if (kind === "suite" && (parentId ?? program?.id) !== undefined) {
      await act(
        () => workspaceApi.createChild(serverUrl, "programs", parentId ?? program!.id, "suites", { name, overview: "" }),
        "Suite created",
      );
    } else if (kind === "prompt" && (parentId ?? suite?.id) !== undefined) {
      await act(
        () =>
          workspaceApi.createChild(serverUrl, "suites", parentId ?? suite!.id, "prompts", {
            title: name,
            content: "Describe the task here.",
          }),
        "Work item created",
      );
    }
  };

  const removeChild = async (kind: Kind, id: number, name: string) => {
    const confirmed = await dialogs.confirm({
      title: `Delete this ${kind}?`,
      description:
        kind === "prompt"
          ? `“${name}” and its history will be removed.`
          : `“${name}” and everything inside it will be removed. This cannot be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    const ok = await act(
      () => workspaceApi.removeChild(serverUrl, `${kind}s` as "programs" | "suites" | "prompts", id),
      "Deleted",
    );
    if (!ok) return;
    if (kind === "prompt") setPromptId(null);
    if (kind === "suite") { setSuiteId(null); setPromptId(null); }
    if (kind === "program") { setProgramId(null); setSuiteId(null); setPromptId(null); }
  };

  const removeWorkspace = async () => {
    if (tree === null) return;
    const confirmed = await dialogs.confirm({
      title: "Delete this workspace?",
      description:
        "Every program, suite, work item, session and verification inside it is deleted with it. Files in the working directory are not touched.",
      confirmLabel: "Delete workspace",
      tone: "danger",
      // A cascade this large should not hang on a reflexive Enter.
      confirmPhrase: tree.name,
    });
    if (!confirmed) return;
    await act(
      async () => {
        await workspaceApi.remove(serverUrl, tree.id);
        setTree(null);
        await loadList();
      },
      "Workspace deleted",
      false,
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <aside className="shrink-0 overflow-y-auto border-b border-line bg-surface-1 p-3 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">Workspaces</span>
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            + New
          </Button>
        </div>
        {items === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs leading-relaxed text-fg-dim">
            No workspaces yet. A workspace points at a directory the agents may read and write.
          </p>
        ) : (
          <ul className="space-y-1">
            {items.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  onClick={() => void choose(workspace.id)}
                  aria-current={tree?.id === workspace.id ? "true" : undefined}
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left transition-colors",
                    tree?.id === workspace.id
                      ? "bg-surface-3 text-fg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{workspace.name}</span>
                    {!workspace.workDirectoryExists && <Badge tone="danger">missing</Badge>}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-fg-dim">
                    {workspace.workDirectory}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        {tree === null ? (
          <p className="text-sm text-fg-dim">Create a workspace to get started.</p>
        ) : (
          <>
            <WorkspaceEditor
              key={`${tree.id}:${tree.updatedAt}`}
              value={tree}
              busy={busy}
              onSave={(patch) =>
                void act(
                  async () => {
                    await workspaceApi.update(serverUrl, tree.id, patch);
                    await loadList(tree.id);
                  },
                  "Workspace saved",
                  false,
                )
              }
              onDelete={() => void removeWorkspace()}
            />

            <div ref={draftsPanel} className="mt-5 scroll-mt-4">
              <ProgramDraftPanel
                key={`${tree.id}:${draftsFocus.generation}`}
                serverUrl={serverUrl}
                workspaceId={tree.id}
                onApplied={async () => {
                  await refresh();
                  await refreshGlobal();
                }}
                initialOpenId={draftsFocus.draftId}
              />
            </div>

            <div className="mt-5 grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-panel border border-line bg-surface-1 lg:grid-cols-[21rem_minmax(0,1fr)]">
              <DirectoryTree
                tree={tree}
                instructionField={instructionField}
                programId={programId}
                suiteId={suiteId}
                promptId={promptId}
                expandedPrograms={expandedPrograms}
                expandedSuites={expandedSuites}
                expandedPrompts={expandedPrompts}
                busy={busy}
                onAddProgram={() => void create("program")}
                onAddSuite={(id) => void create("suite", id)}
                onAddPrompt={(id) => void create("prompt", id)}
                onInstruction={(field) => {
                  setInstructionField(field);
                  setProgramId(null);
                  setSuiteId(null);
                  setPromptId(null);
                }}
                onProgram={(id) => {
                  setInstructionField(null);
                  setProgramId(id);
                  setSuiteId(null);
                  setPromptId(null);
                  toggleProgram(id);
                }}
                onSuite={(parentId, id) => {
                  setInstructionField(null);
                  setProgramId(parentId);
                  setSuiteId(id);
                  setPromptId(null);
                  setExpandedPrograms((current) => new Set(current).add(parentId));
                  toggleSuite(id);
                }}
                onPrompt={(parentProgramId, parentSuiteId, id) => {
                  setInstructionField(null);
                  setProgramId(parentProgramId);
                  setSuiteId(parentSuiteId);
                  setPromptId(id);
                  setExpandedPrograms((current) => new Set(current).add(parentProgramId));
                  setExpandedSuites((current) => new Set(current).add(parentSuiteId));
                }}
                onTogglePrompt={togglePrompt}
              />

              <div className="min-w-0 border-t border-line bg-surface-0/40 p-4 sm:p-6 lg:border-l lg:border-t-0">
              {instructionField !== null ? (
                <InstructionEditor
                  key={`${tree.id}:${instructionField}:${tree.updatedAt}`}
                  field={instructionField}
                  value={tree[instructionField]}
                  updatedAt={tree.updatedAt}
                  busy={busy}
                  onSave={(content) =>
                    void act(
                      () => workspaceApi.update(serverUrl, tree.id, { [instructionField]: content }),
                      `${instructionField === "claudeMd" ? "CLAUDE.md" : "AGENTS.md"} saved`,
                    )
                  }
                />
              ) : prompt !== null ? (
                <PromptEditor
                  key={`${prompt.id}:${prompt.updatedAt}`}
                  value={prompt}
                  busy={busy}
                  onSave={(patch) =>
                    void act(() => workspaceApi.updateChild(serverUrl, "prompts", prompt.id, patch), "Work item saved")
                  }
                  onDelete={() => void removeChild("prompt", prompt.id, prompt.title)}
                />
              ) : suite !== null ? (
                <NamedEditor
                  key={`${suite.id}:${suite.updatedAt}`}
                  value={suite}
                  kind="suite"
                  busy={busy}
                  onSave={(patch) =>
                    void act(() => workspaceApi.updateChild(serverUrl, "suites", suite.id, patch), "Suite saved")
                  }
                  onDelete={() => void removeChild("suite", suite.id, suite.name)}
                />
              ) : program !== null ? (
                <NamedEditor
                  key={`${program.id}:${program.updatedAt}`}
                  value={program}
                  kind="program"
                  busy={busy}
                  onSave={(patch) =>
                    void act(() => workspaceApi.updateChild(serverUrl, "programs", program.id, patch), "Program saved")
                  }
                  onDelete={() => void removeChild("program", program.id, program.name)}
                />
              ) : (
                <EmptyDetail />
              )}
              {instructionField === null && program !== null && (
                <div className="mt-4">
                  <ProgramAgentPanel
                    key={program.id}
                    serverUrl={serverUrl}
                    workDirectory={tree.workDirectory}
                    program={program}
                    focus={
                      prompt !== null
                        ? `work item ${prompt.externalKey === null ? "" : `${prompt.externalKey} — `}${prompt.title}`
                        : suite !== null
                          ? `suite ${suite.externalKey === null ? "" : `${suite.externalKey} — `}${suite.name}`
                          : null
                    }
                    onRevisionStarted={(draftId) => {
                      setDraftsFocus((current) => ({ generation: current.generation + 1, draftId }));
                      requestAnimationFrame(() => draftsPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
                    }}
                  />
                </div>
              )}
              </div>
            </div>
          </>
        )}
      </section>

      <CreateWorkspaceDialog
        open={creating}
        busy={busy}
        onClose={() => setCreating(false)}
        onCreate={async (draft) => {
          const ok = await act(
            async () => {
              await workspaceApi.create(serverUrl, draft);
              await loadList();
            },
            "Workspace created",
            false,
          );
          if (ok) setCreating(false);
        }}
      />
    </div>
  );
}

function toggleSet(current: Set<number>, id: number) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function DirectoryTree({
  tree, instructionField, programId, suiteId, promptId, expandedPrograms, expandedSuites, expandedPrompts, busy,
  onAddProgram, onAddSuite, onAddPrompt, onInstruction, onProgram, onSuite, onPrompt, onTogglePrompt,
}: {
  tree: WorkspaceTree;
  instructionField: InstructionField | null;
  programId: number | null;
  suiteId: number | null;
  promptId: number | null;
  expandedPrograms: Set<number>;
  expandedSuites: Set<number>;
  expandedPrompts: Set<number>;
  busy: boolean;
  onAddProgram(): void;
  onAddSuite(programId: number): void;
  onAddPrompt(suiteId: number): void;
  onInstruction(field: InstructionField): void;
  onProgram(id: number): void;
  onSuite(programId: number, id: number): void;
  onPrompt(programId: number, suiteId: number, id: number): void;
  onTogglePrompt(id: number): void;
}) {
  const renderPrompt = (prompt: PromptRecord, programId: number, suiteId: number, level: number): React.ReactNode => {
    const children = tree.programs.find((item) => item.id === programId)?.suites.find((item) => item.id === suiteId)?.prompts.filter((item) => item.parentPromptId === prompt.id) ?? [];
    const open = expandedPrompts.has(prompt.id);
    return <div key={prompt.id} role="treeitem" aria-expanded={children.length > 0 ? open : undefined} aria-selected={prompt.id === promptId}>
      <TreeRow level={level} active={prompt.id === promptId} expanded={open} leaf={children.length === 0}
        icon={<DocumentIcon className="size-4 text-accent" />} label={prompt.title}
        meta={prompt.externalKey ?? undefined} status={prompt.status}
        onClick={() => {
          onPrompt(programId, suiteId, prompt.id);
          if (children.length > 0) onTogglePrompt(prompt.id);
        }} />
      {open && children.length > 0 && <div role="group">{children.map((child) => renderPrompt(child, programId, suiteId, level + 1))}</div>}
    </div>;
  };

  return (
    <aside className="flex min-h-[24rem] flex-col bg-surface-1">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-xs font-semibold text-fg">Project directory</h2>
          <p className="mt-0.5 text-[10px] text-fg-dim">{tree.programs.length} program{tree.programs.length === 1 ? "" : "s"}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onAddProgram}>+ Program</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree" aria-label={`${tree.name} contents`}>
        <div className="mb-2 border-b border-line pb-2">
          <TreeRow level={0} active={instructionField === "claudeMd"} leaf
            icon={<DocumentIcon className="size-4 text-accent" />} label="CLAUDE.md"
            onClick={() => onInstruction("claudeMd")} />
          <TreeRow level={0} active={instructionField === "agentsMd"} leaf
            icon={<DocumentIcon className="size-4 text-accent" />} label="AGENTS.md"
            onClick={() => onInstruction("agentsMd")} />
        </div>
        {tree.programs.length === 0 ? (
          <div className="m-2 rounded-md border border-dashed border-line p-5 text-center">
            <FolderIcon className="mx-auto mb-2 size-7 text-fg-dim" />
          <p className="text-xs text-fg-muted">No programs yet.</p>
            <button type="button" className="mt-2 text-xs text-accent hover:underline" onClick={onAddProgram}>Create a program</button>
          </div>
        ) : tree.programs.map((program) => {
          const programOpen = expandedPrograms.has(program.id);
          return (
            <div key={program.id} role="treeitem" aria-expanded={programOpen} aria-selected={program.id === programId && suiteId === null}>
              <TreeRow level={0} active={program.id === programId && suiteId === null} expanded={programOpen}
                icon={<FolderIcon className="size-4 text-info" />} label={program.name}
                meta={`${program.suites.length}`} onClick={() => onProgram(program.id)} />
              {programOpen && <div role="group">
                {program.suites.map((suite) => {
                  const suiteOpen = expandedSuites.has(suite.id);
                  return <div key={suite.id} role="treeitem" aria-expanded={suiteOpen} aria-selected={suite.id === suiteId && promptId === null}>
                    <TreeRow level={1} active={suite.id === suiteId && promptId === null} expanded={suiteOpen}
                      icon={<StackIcon className="size-4 text-violet" />} label={suite.name}
                      meta={`${suite.prompts.length}`} onClick={() => onSuite(program.id, suite.id)} />
                    {suiteOpen && <div role="group">
                      {suite.prompts.filter((prompt) => prompt.parentPromptId === null).map((prompt) => renderPrompt(prompt, program.id, suite.id, 2))}
                      <TreeAdd level={2} label="New work item" disabled={busy} onClick={() => {
                        onAddPrompt(suite.id);
                      }} />
                    </div>}
                  </div>;
                })}
                <TreeAdd level={1} label="New suite" disabled={busy} onClick={() => {
                  onAddSuite(program.id);
                }} />
              </div>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function TreeRow({ level, active, expanded, leaf = false, icon, label, meta, status, onClick }: {
  level: number; active: boolean; expanded?: boolean; leaf?: boolean; icon: React.ReactNode;
  label: string; meta?: string; status?: PromptRecord["status"]; onClick(): void;
}) {
  return <button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
    style={{ paddingLeft: `${0.5 + level * 1.25}rem` }}
    className={cn("group mb-0.5 flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left transition-colors",
      active ? "bg-surface-3 text-fg shadow-sm" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
    <ChevronIcon className={cn("size-3 shrink-0 transition-transform", leaf && "invisible", expanded && "rotate-90")} />
    <span className="shrink-0">{icon}</span>
    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
    {status !== undefined && <span className={cn("size-1.5 shrink-0 rounded-full", status === "DONE" ? "bg-success" : status === "BLOCKED" ? "bg-warning" : status === "IN_PROGRESS" ? "bg-info" : "bg-fg-dim")} title={status.toLowerCase()} />}
    {meta && <span className="shrink-0 text-[9px] tabular-nums text-fg-dim">{meta}</span>}
  </button>;
}

function TreeAdd({ level, label, disabled, onClick }: { level: number; label: string; disabled: boolean; onClick(): void }) {
  return <button type="button" disabled={disabled} onClick={onClick} style={{ paddingLeft: `${2.25 + level * 1.25}rem` }}
    className="mb-0.5 flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[11px] text-fg-dim hover:bg-surface-2 hover:text-accent disabled:opacity-40">
    <span className="text-sm leading-none">+</span>{label}
  </button>;
}

function EmptyDetail() {
  return <div className="flex min-h-[26rem] flex-col items-center justify-center text-center">
    <DocumentIcon className="mb-3 size-9 text-fg-dim" />
    <h2 className="text-sm font-medium text-fg">Select something to view</h2>
    <p className="mt-1 max-w-xs text-xs leading-relaxed text-fg-dim">Choose a program, suite, or work item from the directory to view and edit its details.</p>
  </div>;
}

function InstructionEditor({
  field,
  value,
  updatedAt,
  busy,
  onSave,
}: {
  field: InstructionField;
  value: string;
  updatedAt: string;
  busy: boolean;
  onSave(content: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const name = field === "claudeMd" ? "CLAUDE.md" : "AGENTS.md";
  const providerHint = field === "claudeMd" ? "Read by Claude Code." : "Read by Codex, Cursor, and Grok.";
  const dirty = draft !== value;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
      className="overflow-hidden rounded-panel border border-line bg-surface-1 shadow-[var(--shadow-panel)]"
    >
      <header className="border-b border-line bg-surface-1 px-5 py-4 sm:px-7 sm:py-5">
        <div className="mb-2 flex items-center gap-2">
          <DocumentIcon className="size-4 text-accent" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Repository instructions</span>
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-fg sm:text-xl">{name}</h2>
        <p className="mt-1 text-xs text-fg-dim">{providerHint} Stored with this workspace and written to the project root before each run.</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="inline-flex rounded-md border border-line bg-surface-0 p-0.5" aria-label="Document mode">
            <ModeButton active={mode === "view"} onClick={() => setMode("view")}>View</ModeButton>
            <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>Edit</ModeButton>
          </div>
          <span className="text-[10px] text-fg-dim">Updated {formatDate(updatedAt)}</span>
        </div>
      </header>

      {mode === "view" ? (
        <article className="prompt-document min-h-[24rem] bg-surface-0/35 px-5 py-7 sm:px-8 lg:px-10">
          {draft.trim() === "" ? <p className="text-sm italic text-fg-dim">No instructions have been written yet.</p> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>}
        </article>
      ) : (
        <div className="p-5 sm:p-7">
          <TextArea label="Instruction" rows={18} className="font-terminal"
            hint="Markdown is rendered in View mode. Saving updates the file used by future agent runs."
            value={draft} onChange={(event) => setDraft(event.target.value)} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-1 px-5 py-3 sm:px-7">
        {mode === "view" ? (
          <Button variant="secondary" onClick={() => setMode("edit")}>Edit {name}</Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>Save changes</Button>
        )}
        {dirty && <span className="text-[11px] text-warning">unsaved changes</span>}
      </div>
    </form>
  );
}

function ChevronIcon({ className }: { className?: string }) { return <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function FolderIcon({ className }: { className?: string }) { return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3l1.5 1.75h7A1.75 1.75 0 0 1 17.5 7v7.25A1.75 1.75 0 0 1 15.75 16h-11A2.25 2.25 0 0 1 2.5 13.75v-8.5Z" fill="currentColor" opacity=".22"/><path d="M2.5 6.5h15M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3l1.5 1.75h7A1.75 1.75 0 0 1 17.5 7v7.25A1.75 1.75 0 0 1 15.75 16h-11A2.25 2.25 0 0 1 2.5 13.75v-8.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg>; }
function StackIcon({ className }: { className?: string }) { return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="m10 2.75 7.25 3.75L10 10.25 2.75 6.5 10 2.75Z" fill="currentColor" opacity=".2"/><path d="m3 10 7 3.5 7-3.5M3 13.5l7 3.5 7-3.5M2.75 6.5 10 2.75l7.25 3.75L10 10.25 2.75 6.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function DocumentIcon({ className }: { className?: string }) { return <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true"><path d="M5 2.5h6l4 4v11H5v-15Z" fill="currentColor" opacity=".16"/><path d="M11 2.5H5v15h10v-11m-4-4 4 4m-4-4v4h4M7.5 10h5M7.5 13h5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

function CreateWorkspaceDialog({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onClose(): void;
  onCreate(draft: { name: string; workDirectory: string; description: string }): void;
}) {
  const [draft, setDraft] = useState({ name: "", workDirectory: "", description: "" });
  const [touched, setTouched] = useState(false);
  const nameError = touched && draft.name.trim() === "" ? "A name is required." : null;
  const pathError =
    touched && !draft.workDirectory.trim().startsWith("/")
      ? "Use an absolute path, starting with /."
      : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New workspace"
      description="A workspace points at a directory the agents may read and write."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (draft.name.trim() === "" || !draft.workDirectory.trim().startsWith("/")) return;
              onCreate(draft);
            }}
          >
            Create workspace
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput
          label="Name"
          required
          value={draft.name}
          error={nameError}
          placeholder="my-project"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextInput
          label="Working directory"
          required
          value={draft.workDirectory}
          error={pathError}
          hint="Agents run here. Point it at the project you want worked on."
          placeholder="/home/you/projects/my-project"
          onChange={(event) => setDraft({ ...draft, workDirectory: event.target.value })}
        />
        <TextArea
          label="Standing instructions"
          rows={4}
          value={draft.description}
          hint="Prepended to every custom prompt run in this workspace. Optional."
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
    </Modal>
  );
}

function WorkspaceEditor({
  value,
  busy,
  onSave,
  onDelete,
}: {
  value: WorkspaceTree;
  busy: boolean;
  onSave(patch: { name: string; workDirectory: string; description: string }): void;
  onDelete(): void;
}) {
  const [draft, setDraft] = useState({
    name: value.name,
    workDirectory: value.workDirectory,
    description: value.description,
  });
  const dirty =
    draft.name !== value.name ||
    draft.workDirectory !== value.workDirectory ||
    draft.description !== value.description;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
      className="rounded-panel border border-line bg-surface-1 p-4"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TextInput
          label="Name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextInput
          label="Working directory"
          value={draft.workDirectory}
          error={value.workDirectoryExists ? null : "This directory does not exist on disk."}
          onChange={(event) => setDraft({ ...draft, workDirectory: event.target.value })}
        />
        <TextArea
          label="Standing instructions"
          fieldClassName="md:col-span-2"
          rows={3}
          hint="Program context. Rendered into every work-item run in this workspace."
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>
          Save workspace
        </Button>
        {dirty && <span className="text-[11px] text-warning">unsaved changes</span>}
        <Button variant="ghost" className="ml-auto text-danger" onClick={onDelete}>
          Delete workspace
        </Button>
      </div>
    </form>
  );
}

function NamedEditor({
  value,
  kind,
  busy,
  onSave,
  onDelete,
}: {
  value: ProgramRecord | SuiteRecord;
  kind: "program" | "suite";
  busy: boolean;
  onSave(patch: { name: string; overview: string }): void;
  onDelete(): void;
}) {
  const [draft, setDraft] = useState({ name: value.name, overview: value.overview });
  const dirty = draft.name !== value.name || draft.overview !== value.overview;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
      className="space-y-4 rounded-panel border border-line bg-surface-1 p-4"
    >
      <TextInput
        label={`${kind[0]!.toUpperCase()}${kind.slice(1)} name`}
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <TextArea
        label="Overview"
        rows={4}
        hint="Context the agent is given for every work item in this group."
        value={draft.overview}
        onChange={(event) => setDraft({ ...draft, overview: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>
          Save {kind}
        </Button>
        {dirty && <span className="text-[11px] text-warning">unsaved changes</span>}
        <Button variant="ghost" className="ml-auto text-danger" onClick={onDelete}>
          Delete {kind}
        </Button>
      </div>
    </form>
  );
}

function PromptEditor({
  value,
  busy,
  onSave,
  onDelete,
}: {
  value: PromptRecord;
  busy: boolean;
  onSave(patch: { title: string; content: string }): void;
  onDelete(): void;
}) {
  const [draft, setDraft] = useState({ title: value.title, content: value.content });
  const [mode, setMode] = useState<"view" | "edit">("view");
  const dirty = draft.title !== value.title || draft.content !== value.content;
  const verifyCommands = useMemo(() => parseVerifyBlock(draft.content).commands, [draft.content]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
      className="overflow-hidden rounded-panel border border-line bg-surface-1 shadow-[var(--shadow-panel)]"
    >
      <header className="border-b border-line bg-surface-1 px-5 py-4 sm:px-7 sm:py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <DocumentIcon className="size-4 text-accent" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-dim">Work item</span>
              {value.externalKey !== null && <span className="font-mono text-[10px] text-fg-dim">{value.externalKey}</span>}
            </div>
            <h2 className="text-lg font-semibold tracking-tight text-fg sm:text-xl">{draft.title || "Untitled work item"}</h2>
          </div>
          <Badge tone={value.status === "DONE" ? "success" : value.status === "BLOCKED" ? "warning" : "neutral"}>
            {value.status.toLowerCase().replace("_", " ")}
          </Badge>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="inline-flex rounded-md border border-line bg-surface-0 p-0.5" aria-label="Document mode">
            <ModeButton active={mode === "view"} onClick={() => setMode("view")}>View</ModeButton>
            <ModeButton active={mode === "edit"} onClick={() => setMode("edit")}>Edit</ModeButton>
          </div>
          <span className="text-[10px] text-fg-dim">Updated {formatDate(value.updatedAt)}</span>
        </div>
      </header>

      {mode === "view" ? (
        <article className="prompt-document min-h-[24rem] bg-surface-0/35 px-5 py-7 sm:px-8 lg:px-10">
          {draft.content.trim() === "" ? (
            <p className="text-sm italic text-fg-dim">No instructions have been written yet.</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.content}</ReactMarkdown>
          )}
        </article>
      ) : (
        <div className="space-y-5 p-5 sm:p-7">
          <TextInput
            label="Title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <TextArea
            label="Instruction"
            rows={16}
            className="font-terminal"
            hint="Markdown is rendered in View mode and fetched by the agent at run time."
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
          {verifyCommands.length > 0 && (
            <div className="rounded-md border border-line bg-surface-0/60 px-3 py-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">These run on `done`</p>
              <ul className="space-y-1 font-mono text-[11px] text-fg-muted">
                {verifyCommands.map((command) => (
                  <li key={command.text} className="truncate" title={command.text}>{command.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {verifyCommands.length > 0 && mode === "view" && (
        <div className="border-t border-line bg-surface-0/40 px-5 py-3 sm:px-8">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">These run on `done`</p>
          <ul className="space-y-1 font-mono text-[11px] text-fg-muted">
            {verifyCommands.map((command) => (
              <li key={command.text} className="truncate" title={command.text}>{command.text}</li>
            ))}
          </ul>
        </div>
      )}

      {value.result !== "" && mode === "view" && (
        <div className="border-t border-line bg-surface-2/50 px-5 py-4 sm:px-8">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">Latest result</p>
          <p className="text-xs leading-relaxed text-fg-muted">{value.result}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-1 px-5 py-3 sm:px-7">
        {mode === "view" ? (
          <Button variant="secondary" onClick={() => setMode("edit")}>Edit work item</Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>Save changes</Button>
        )}
        {dirty && <span className="text-[11px] text-warning">unsaved changes</span>}
        <Button variant="ghost" className="ml-auto text-danger" onClick={onDelete}>Delete</Button>
      </div>
    </form>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick}
    className={cn("rounded px-3 py-1 text-[11px] font-medium transition-colors", active ? "bg-surface-3 text-fg shadow-sm" : "text-fg-dim hover:text-fg")}>
    {children}
  </button>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

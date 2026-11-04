"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRequestMode, AgentRequestTarget, ProgramRecord, WorkspaceRecord, WorkspaceTree } from "@agent-console/shared";
import { INSTRUCTION_FILE_NAMES } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Skeleton } from "./ui/Spinner";
import { useDialogs } from "./ui/Dialogs";
import { useToast } from "./ui/Toast";
import { AgentRequestModal } from "./workspaces/AgentRequestModal";
import { INSTRUCTION_HINTS, InstructionFileModal, type InstructionField } from "./workspaces/InstructionFileModal";
import { ProgramModal } from "./workspaces/ProgramModal";
import { ProposalsModal, useProposalSummary } from "./workspaces/ProposalsModal";
import { WorkspaceSettingsModal } from "./workspaces/WorkspaceSettingsModal";
import {
  DocumentIcon, FolderIcon, GearIcon, InboxIcon, SectionHeading, SparkIcon,
  formatDate, lineCount, programProgress, useAct,
} from "./workspaces/shared";

/** At most one modal is open; opening another replaces it. */
type Sheet =
  | { kind: "create" }
  | { kind: "settings" }
  | { kind: "instructions"; field: InstructionField }
  | { kind: "program"; programId: number }
  | { kind: "request"; target: AgentRequestTarget; mode?: AgentRequestMode }
  | { kind: "proposals"; openKey: string | null };

/**
 * The workspaces page: pick or create a workspace, point it at a project, and
 * see what is in it. Everything that is read or written in depth — a program,
 * an instruction file, a request to an agent, a proposal — opens in a modal,
 * so the page itself stays an overview.
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
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const { summary, reload: reloadSummary } = useProposalSummary(serverUrl, tree?.id ?? null);

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

  const treeId = tree?.id ?? null;
  const refresh = useCallback(async () => {
    if (treeId === null) return;
    setTree(await workspaceApi.tree(serverUrl, treeId));
  }, [serverUrl, treeId]);

  const { act, busy } = useAct(refresh);

  const choose = async (id: number) => {
    setSheet(null);
    setWorkspaceId(id);
    try {
      setTree(await workspaceApi.tree(serverUrl, id));
    } catch (error) {
      toast.error("Could not open workspace", error instanceof Error ? error.message : String(error));
    }
  };

  const closeSheet = () => {
    setSheet(null);
    void reloadSummary();
  };

  const removeWorkspace = async () => {
    if (tree === null) return;
    const confirmed = await dialogs.confirm({
      title: "Delete this workspace?",
      description:
        "Every program, suite, work item, session and verification inside it is deleted with it. Files in the project directory are not touched.",
      confirmLabel: "Delete workspace",
      tone: "danger",
      // A cascade this large should not hang on a reflexive Enter.
      confirmPhrase: tree.name,
    });
    if (!confirmed) return;
    const ok = await act(
      async () => {
        await workspaceApi.remove(serverUrl, tree.id);
        setTree(null);
        await loadList();
      },
      "Workspace deleted",
      false,
    );
    if (ok) setSheet(null);
  };

  const createEmptyProgram = async () => {
    if (tree === null) return;
    const name = await dialogs.prompt({
      title: "New empty program",
      label: "Program name",
      placeholder: "e.g. Payments migration",
      validate: (value) => (value.length < 2 ? "Give it a name of at least two characters." : null),
    });
    if (name === null) return;
    let created: number | null = null;
    const ok = await act(async () => {
      const result = (await workspaceApi.createChild(serverUrl, "workspaces", tree.id, "programs", { name, overview: "" })) as { program?: { id: number } };
      created = result.program?.id ?? null;
    }, "Program created");
    if (ok && created !== null) setSheet({ kind: "program", programId: created });
    else if (ok) setSheet(null);
  };

  const openProposals = (openKey: string | null = null) => setSheet({ kind: "proposals", openKey });
  const program = sheet?.kind === "program" ? tree?.programs.find((entry) => entry.id === sheet.programId) ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <aside className="shrink-0 overflow-y-auto border-b border-line bg-surface-1 p-3 lg:w-64 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim">Workspaces</span>
          <Button size="sm" variant="secondary" onClick={() => setSheet({ kind: "create" })}>
            + New
          </Button>
        </div>
        {items === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs leading-relaxed text-fg-dim">No workspaces yet.</p>
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
                    tree?.id === workspace.id ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{workspace.name}</span>
                    {!workspace.workDirectoryExists && <Badge tone="danger">missing</Badge>}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-dim">{workspace.workDirectory}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        {items !== null && tree === null ? (
          <EmptyWorkspaces onCreate={() => setSheet({ kind: "create" })} />
        ) : tree === null ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-8 p-5 sm:p-8">
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{tree.name}</h1>
                <p className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[11px] text-fg-dim">
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 max-w-full truncate">{tree.workDirectory}</span>
                  {!tree.workDirectoryExists && <Badge tone="danger">not found on disk</Badge>}
                </p>
                {tree.description.trim() !== "" && (
                  <p className="mt-2 line-clamp-2 max-w-2xl text-xs leading-relaxed text-fg-muted" title={tree.description}>
                    {tree.description}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" iconLeft={<InboxIcon className="size-4" />} onClick={() => openProposals()}>
                  Proposals
                  {summary.pending > 0 && <Badge tone="info" className="ml-1.5">{summary.pending}</Badge>}
                </Button>
                <Button
                  variant="secondary"
                  iconLeft={<SparkIcon className="size-4 text-accent" />}
                  onClick={() => setSheet({ kind: "request", target: { kind: "workspace" } })}
                >
                  Ask AI
                </Button>
                <Button variant="ghost" iconOnly aria-label="Workspace settings" title="Workspace settings" iconLeft={<GearIcon className="size-4" />} onClick={() => setSheet({ kind: "settings" })} />
              </div>
            </header>

            {!tree.workDirectoryExists && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger">
                The project directory does not exist, so agents cannot run here.
                <Button size="sm" variant="secondary" onClick={() => setSheet({ kind: "settings" })}>Fix the path</Button>
              </div>
            )}

            {summary.pending > 0 && (
              <button
                type="button"
                onClick={() => openProposals()}
                className="flex w-full items-center gap-3 rounded-panel border border-info/40 bg-info/10 px-4 py-3 text-left text-xs text-fg transition-colors hover:bg-info/15"
              >
                <InboxIcon className="size-4 shrink-0 text-info" />
                <span className="flex-1">
                  {summary.pending} proposal{summary.pending === 1 ? " is" : "s are"} waiting for your review.
                </span>
                <span className="text-info">Review →</span>
              </button>
            )}

            <section>
              <SectionHeading title="Instruction files" hint="Repository guidance written to the project root before each run." />
              <div className="grid gap-3 sm:grid-cols-2">
                {(["claudeMd", "agentsMd"] as const).map((field) => (
                  <InstructionCard
                    key={field}
                    field={field}
                    value={tree[field]}
                    pending={summary.byField[field]}
                    onOpen={() => setSheet({ kind: "instructions", field })}
                  />
                ))}
              </div>
            </section>

            <section>
              <SectionHeading
                title="Programs"
                hint="Each program is a plan of suites and work items for agents to run."
                actions={
                  tree.programs.length > 0 && (
                    <Button size="sm" variant="primary" onClick={() => setSheet({ kind: "request", target: { kind: "new-program" } })}>
                      + New program
                    </Button>
                  )
                }
              />
              {tree.programs.length === 0 ? (
                <div className="rounded-panel border border-dashed border-line px-6 py-10 text-center">
                  <FolderIcon className="mx-auto mb-3 size-8 text-fg-dim" />
                  <p className="text-sm font-medium text-fg">No programs yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-fg-dim">
                    Describe what you want done and an agent drafts the plan, or start from an empty program.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button
                      variant="primary"
                      iconLeft={<SparkIcon className="size-4" />}
                      onClick={() => setSheet({ kind: "request", target: { kind: "new-program" } })}
                    >
                      Draft with AI
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => void createEmptyProgram()}>Start empty</Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {tree.programs.map((entry) => (
                    <ProgramCard
                      key={entry.id}
                      program={entry}
                      pending={summary.byProgram.get(entry.id) ?? 0}
                      onOpen={() => setSheet({ kind: "program", programId: entry.id })}
                    />
                  ))}
                  {summary.newPrograms > 0 && (
                    <button
                      type="button"
                      onClick={() => openProposals()}
                      className="flex min-h-[8.5rem] flex-col items-center justify-center gap-1 rounded-panel border border-dashed border-info/50 p-4 text-center text-xs text-fg-muted transition-colors hover:bg-surface-2"
                    >
                      <Badge tone="info">{summary.newPrograms} drafted</Badge>
                      <span className="mt-1">New program{summary.newPrograms === 1 ? "" : "s"} waiting for review</span>
                    </button>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </section>

      {sheet?.kind === "create" && (
        <WorkspaceSettingsModal
          open
          workspace={null}
          busy={busy}
          onClose={closeSheet}
          onSubmit={async (draft) => {
            const ok = await act(
              async () => {
                const created = (await workspaceApi.create(serverUrl, draft)) as { workspace?: { id: number } };
                const id = created.workspace?.id;
                if (id !== undefined) setWorkspaceId(id);
                await loadList(id);
              },
              "Workspace created",
              false,
            );
            if (ok) setSheet(null);
          }}
        />
      )}

      {tree !== null && sheet?.kind === "settings" && (
        <WorkspaceSettingsModal
          key={`${tree.id}:${tree.updatedAt}`}
          open
          workspace={tree}
          busy={busy}
          onClose={closeSheet}
          onDelete={() => void removeWorkspace()}
          onSubmit={async (draft) => {
            const ok = await act(
              async () => {
                await workspaceApi.update(serverUrl, tree.id, draft);
                await loadList(tree.id);
              },
              "Workspace saved",
              false,
            );
            if (ok) setSheet(null);
          }}
        />
      )}

      {tree !== null && sheet?.kind === "instructions" && (
        <InstructionFileModal
          key={`${tree.id}:${sheet.field}:${tree.updatedAt}`}
          field={sheet.field}
          value={tree[sheet.field]}
          updatedAt={tree.updatedAt}
          busy={busy}
          pendingProposals={summary.byField[sheet.field]}
          onClose={closeSheet}
          onSave={async (content) => {
            const ok = await act(
              () => workspaceApi.update(serverUrl, tree.id, { [sheet.field]: content }),
              `${INSTRUCTION_FILE_NAMES[sheet.field]} saved`,
            );
            if (ok) await refreshGlobal();
            return ok;
          }}
          onPropose={() => setSheet({ kind: "request", target: { kind: "instructions", field: sheet.field }, mode: "change" })}
          onReviewProposals={() => openProposals()}
        />
      )}

      {tree !== null && program !== null && (
        <ProgramModal
          key={program.id}
          serverUrl={serverUrl}
          program={program}
          pendingProposals={summary.byProgram.get(program.id) ?? 0}
          refresh={refresh}
          onClose={closeSheet}
          onPropose={(target) => setSheet({ kind: "request", target })}
          onReviewProposals={() => openProposals()}
        />
      )}

      {tree !== null && sheet?.kind === "request" && (
        <AgentRequestModal
          key={JSON.stringify(sheet.target)}
          serverUrl={serverUrl}
          tree={tree}
          target={sheet.target}
          mode={sheet.mode}
          onClose={closeSheet}
          onProposalOpened={(key) => {
            void reloadSummary();
            openProposals(key);
          }}
          onCreateEmptyProgram={() => void createEmptyProgram()}
        />
      )}

      {tree !== null && sheet?.kind === "proposals" && (
        <ProposalsModal
          serverUrl={serverUrl}
          workspaceId={tree.id}
          instructions={{ claudeMd: tree.claudeMd, agentsMd: tree.agentsMd }}
          openKey={sheet.openKey}
          onClose={closeSheet}
          onApplied={async () => {
            await refresh();
            await refreshGlobal();
            await reloadSummary();
          }}
        />
      )}
    </div>
  );
}

function EmptyWorkspaces({ onCreate }: { onCreate(): void }) {
  return (
    <div className="flex h-full min-h-[24rem] flex-col items-center justify-center p-8 text-center">
      <FolderIcon className="mb-3 size-10 text-fg-dim" />
      <h2 className="text-base font-semibold text-fg">Create your first workspace</h2>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-fg-dim">
        A workspace points at a project directory. Agents read and write there, and its programs describe the work.
      </p>
      <Button className="mt-5" variant="primary" onClick={onCreate}>+ New workspace</Button>
    </div>
  );
}

function InstructionCard({ field, value, pending, onOpen }: { field: InstructionField; value: string; pending: number; onOpen(): void }) {
  const lines = lineCount(value);
  const firstLine = value.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-w-0 items-start gap-3 rounded-panel border border-line bg-surface-1 p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <DocumentIcon className="mt-0.5 size-5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium text-fg">{INSTRUCTION_FILE_NAMES[field]}</span>
          {pending > 0 && <Badge tone="info">{pending} proposal{pending === 1 ? "" : "s"}</Badge>}
        </span>
        <span className="mt-0.5 block text-[11px] text-fg-dim">{INSTRUCTION_HINTS[field]}</span>
        <span className="mt-2 block truncate text-[11px] text-fg-muted">
          {lines === 0 ? <span className="italic text-fg-dim">Empty — click to write it</span> : `${lines} line${lines === 1 ? "" : "s"} · ${firstLine ?? ""}`}
        </span>
      </span>
    </button>
  );
}

function ProgramCard({ program, pending, onOpen }: { program: ProgramRecord; pending: number; onOpen(): void }) {
  const progress = programProgress(program);
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[8.5rem] min-w-0 flex-col rounded-panel border border-line bg-surface-1 p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <span className="flex items-start gap-2">
        <FolderIcon className="mt-0.5 size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{program.name}</span>
        {pending > 0 && <Badge tone="info">{pending} proposal{pending === 1 ? "" : "s"}</Badge>}
      </span>
      <span className="mt-1.5 line-clamp-2 flex-1 text-[11px] leading-relaxed text-fg-dim">
        {program.overview.trim() === "" ? "No overview yet." : program.overview}
      </span>
      <span className="mt-3 block">
        <span className="flex items-center justify-between text-[10px] tabular-nums text-fg-dim">
          <span>
            {progress.suites} suite{progress.suites === 1 ? "" : "s"} · {progress.total} item{progress.total === 1 ? "" : "s"}
            {progress.blocked > 0 && <span className="text-warning"> · {progress.blocked} blocked</span>}
          </span>
          <span>{progress.done}/{progress.total} done</span>
        </span>
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <span className="block h-full rounded-full bg-success transition-[width]" style={{ width: `${percent}%` }} />
        </span>
        <span className="mt-1.5 block text-[10px] text-fg-dim">Updated {formatDate(program.updatedAt)}</span>
      </span>
    </button>
  );
}

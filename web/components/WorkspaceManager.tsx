"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ProgramRecord,
  PromptRecord,
  SuiteRecord,
  WorkspaceRecord,
  WorkspaceTree,
} from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { workspaceApi } from "@/lib/workspacesApi";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { TextArea, TextInput } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { Skeleton } from "./ui/Spinner";
import { useDialogs } from "./ui/Dialogs";
import { useToast } from "./ui/Toast";

type Kind = "program" | "suite" | "prompt";

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
  const [items, setItems] = useState<WorkspaceRecord[] | null>(null);
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [programId, setProgramId] = useState<number | null>(null);
  const [suiteId, setSuiteId] = useState<number | null>(null);
  const [promptId, setPromptId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const program = tree?.programs.find((x) => x.id === programId) ?? null;
  const suite = program?.suites.find((x) => x.id === suiteId) ?? null;
  const prompt = suite?.prompts.find((x) => x.id === promptId) ?? null;

  const loadList = useCallback(
    (select?: number) =>
      workspaceApi
        .list(serverUrl)
        .then(async (list) => {
          setItems(list);
          const id = select ?? list[0]?.id;
          setTree(id === undefined ? null : await workspaceApi.tree(serverUrl, id));
        })
        .catch(() => setItems([])),
    [serverUrl],
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
    try {
      setTree(await workspaceApi.tree(serverUrl, id));
    } catch (error) {
      toast.error("Could not open workspace", error instanceof Error ? error.message : String(error));
    }
  };

  const create = async (kind: Kind) => {
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
    } else if (kind === "suite" && program !== null) {
      await act(
        () => workspaceApi.createChild(serverUrl, "programs", program.id, "suites", { name, overview: "" }),
        "Suite created",
      );
    } else if (kind === "prompt" && suite !== null) {
      await act(
        () =>
          workspaceApi.createChild(serverUrl, "suites", suite.id, "prompts", {
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

            <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Column title="Programs" count={tree.programs.length} onAdd={() => void create("program")} disabled={busy}>
                {tree.programs.map((item) => (
                  <Row
                    key={item.id}
                    active={item.id === programId}
                    label={item.name}
                    hint={`${item.suites.length} suite${item.suites.length === 1 ? "" : "s"}`}
                    onClick={() => {
                      setProgramId(item.id);
                      setSuiteId(null);
                      setPromptId(null);
                    }}
                  />
                ))}
              </Column>
              <Column
                title="Suites"
                count={program?.suites.length ?? 0}
                onAdd={program === null ? undefined : () => void create("suite")}
                disabled={busy}
                empty={program === null ? "Pick a program first." : "No suites yet."}
              >
                {(program?.suites ?? []).map((item) => (
                  <Row
                    key={item.id}
                    active={item.id === suiteId}
                    label={item.name}
                    hint={`${item.prompts.length} item${item.prompts.length === 1 ? "" : "s"}`}
                    onClick={() => {
                      setSuiteId(item.id);
                      setPromptId(null);
                    }}
                  />
                ))}
              </Column>
              <Column
                title="Work items"
                count={suite?.prompts.length ?? 0}
                onAdd={suite === null ? undefined : () => void create("prompt")}
                disabled={busy}
                empty={suite === null ? "Pick a suite first." : "No work items yet."}
              >
                {(suite?.prompts ?? []).map((item) => (
                  <Row
                    key={item.id}
                    active={item.id === promptId}
                    label={item.title}
                    prefix={item.externalKey}
                    hint={item.status.toLowerCase()}
                    onClick={() => setPromptId(item.id)}
                  />
                ))}
              </Column>
            </div>

            <div className="mt-4">
              {prompt !== null ? (
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
                <p className="text-sm text-fg-dim">Select an item above to edit its details.</p>
              )}
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

function Column({
  title,
  count,
  onAdd,
  disabled,
  empty = "Nothing here yet.",
  children,
}: {
  title: string;
  count: number;
  onAdd?: () => void;
  disabled: boolean;
  empty?: string;
  children: React.ReactNode[];
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface-1">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-fg-muted">
          {title} <span className="text-fg-dim">{count}</span>
        </span>
        <Button size="sm" variant="ghost" disabled={onAdd === undefined || disabled} onClick={onAdd}>
          + Add
        </Button>
      </div>
      <div className="max-h-80 overflow-y-auto p-2">
        {children.length === 0 ? <p className="px-1 py-2 text-xs text-fg-dim">{empty}</p> : children}
      </div>
    </div>
  );
}

function Row({
  active,
  label,
  prefix,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  prefix?: string | null;
  hint?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
        active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {prefix != null && prefix !== "" && (
        <span className="shrink-0 text-[11px] font-semibold text-fg-dim">{prefix}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      {hint !== undefined && <span className="shrink-0 text-[10px] text-fg-dim">{hint}</span>}
    </button>
  );
}

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
          hint="Prepended to every custom prompt run in this workspace."
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
  const dirty = draft.title !== value.title || draft.content !== value.content;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
      className="space-y-4 rounded-panel border border-line bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={value.status === "DONE" ? "success" : value.status === "BLOCKED" ? "warning" : "neutral"}>
          {value.status.toLowerCase()}
        </Badge>
        {value.externalKey !== null && <span className="text-xs text-fg-dim">{value.externalKey}</span>}
        {value.result !== "" && (
          <span className="min-w-0 truncate text-xs text-fg-dim" title={value.result}>
            {value.result}
          </span>
        )}
      </div>
      <TextInput
        label="Title"
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <TextArea
        label="Instruction"
        rows={12}
        className="font-terminal"
        hint="Markdown. The agent fetches this from the database at run time."
        value={draft.content}
        onChange={(event) => setDraft({ ...draft, content: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>
          Save work item
        </Button>
        {dirty && <span className="text-[11px] text-warning">unsaved changes</span>}
        <Button variant="ghost" className="ml-auto text-danger" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </form>
  );
}

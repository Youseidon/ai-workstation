"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InstructionProposalRecord,
  ProgramDraftBody,
  ProgramDraftPreview,
  ProgramDraftPrompt,
  ProgramDraftRecord,
  ProgramDraftSuite,
  ProgramRevisionChange,
  ProviderId,
  ProviderInfo,
} from "@agent-console/shared";
import { INSTRUCTION_FILE_NAMES, canApplyProgramDraft, diffLineCounts, diffLines, diffProgramRevision, parseVerifyBlock, programDraftPreview } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { workspaceApi } from "@/lib/workspacesApi";
import { InstructionProposalEditor } from "../requests/InstructionProposalEditor";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { TextArea, TextInput } from "../ui/Field";
import { Spinner } from "../ui/Spinner";
import { useDialogs } from "../ui/Dialogs";
import { useToast } from "../ui/Toast";
import { useProviders } from "./useProviders";
import { ProviderModelPicker, useAgentChoice } from "./ProviderModelPicker";

interface Props {
  serverUrl: string;
  workspaceId: number;
  /** The stored instruction files, to tell whether a proposal against one is stale. */
  instructions: { claudeMd: string; agentsMd: string };
  /** Called after an apply, so the tree beside this panel repaints. */
  onApplied(): void | Promise<void>;
  /**
   * A proposal to open on mount — `program:<id>` or `instructions:<id>` — e.g.
   * the one just opened from the request bar. The caller remounts the panel (by
   * `key`) to show one opened elsewhere.
   */
  initialOpenKey?: string | null;
}

type Entry = { draft: ProgramDraftRecord; preview: ProgramDraftPreview };

type Row =
  | { key: string; createdAt: string; kind: "program"; entry: Entry }
  | { key: string; createdAt: string; kind: "instructions"; proposal: InstructionProposalRecord };

const STATE_TONE = { PENDING: "info", APPLIED: "success", DISCARDED: "neutral" } as const;

const CHANGE_TONE = { added: "success", changed: "info", moved: "violet", removed: "danger" } as const;

/**
 * Everything agents (or the operator) have proposed in this workspace: new
 * programs, changes to programs, and changes to CLAUDE.md and AGENTS.md.
 *
 * Requests are made from the request modal; this is where their results are
 * read and decided on: a list on the left (what waits on you first), the open
 * proposal on the right. A proposal is not a change. Nothing is created or
 * modified until Apply, which is why Apply is the only primary button in each.
 */
export function ProgramDraftPanel({ serverUrl, workspaceId, instructions, onApplied, initialOpenKey = null }: Props) {
  const toast = useToast();
  const dialogs = useDialogs();
  const console_ = useAgentConsole();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [proposals, setProposals] = useState<InstructionProposalRecord[] | null>(null);
  const { providers } = useProviders(serverUrl);
  const [openKey, setOpenKey] = useState<string | null>(initialOpenKey);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [drafts, instructionProposals] = await Promise.all([
        workspaceApi.programDrafts(serverUrl, workspaceId),
        workspaceApi.instructionProposals(serverUrl, workspaceId),
      ]);
      setEntries(drafts);
      setProposals(instructionProposals);
    } catch (error) {
      toast.error("Could not load proposals", error instanceof Error ? error.message : String(error));
      setEntries([]);
      setProposals([]);
    }
  }, [serverUrl, workspaceId, toast]);

  useEffect(() => {
    setOpenKey(initialOpenKey);
    void load();
  }, [load, initialOpenKey]);

  // While an author run is filling a draft in, its suites appear a post at a time.
  // Polling rather than the run socket: this panel is not the console, and a
  // five-second refresh is enough to watch a plan take shape.
  const authoring = (entries ?? []).some((entry) => entry.draft.state === "PENDING" && entry.draft.runId !== null);
  useEffect(() => {
    if (!authoring) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [authoring, load]);

  // An instruction proposal is written when its run ends, and any execute run
  // can leave one behind, so the list reloads whenever the set of live runs
  // changes — debounced, since a pipeline can start and end runs in a burst.
  const liveRunIds = console_.runs.map((run) => run.runId);
  const liveRuns = liveRunIds.join(",");
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 300);
    return () => clearTimeout(timer);
  }, [liveRuns, load]);

  const act = async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await operation();
      await load();
      if (success !== undefined) toast.success(success);
      return true;
    } catch (error) {
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rows: Row[] | null = entries === null || proposals === null
    ? null
    : [
        ...entries.map((entry): Row => ({ key: `program:${entry.draft.id}`, createdAt: entry.draft.createdAt, kind: "program", entry })),
        ...proposals.map((proposal): Row => ({ key: `instructions:${proposal.id}`, createdAt: proposal.createdAt, kind: "instructions", proposal })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pendingCount = rows?.filter((row) => (row.kind === "program" ? row.entry.draft.state : row.proposal.state) === "PENDING").length ?? 0;

  const pending = rows?.filter((row) => rowState(row) === "PENDING") ?? [];
  const resolved = rows?.filter((row) => rowState(row) !== "PENDING") ?? [];
  // With nothing chosen, the first proposal waiting on a decision is shown.
  const activeKey = rows?.some((row) => row.key === openKey) ? openKey : pending[0]?.key ?? null;
  const active = rows?.find((row) => row.key === activeKey) ?? null;
  const [showResolved, setShowResolved] = useState(false);
  const resolvedOpen = showResolved || (active !== null && rowState(active) !== "PENDING");
  const writingRun = (row: Row) => {
    const runId = row.kind === "program" ? row.entry.draft.runId : row.proposal.origin === "request" ? row.proposal.runId : null;
    return runId !== null && rowState(row) === "PENDING" && liveRunIds.includes(runId);
  };

  const renderRow = (row: Row) => (
    <li key={row.key}>
      <ProposalRow row={row} active={row.key === activeKey} writing={writingRun(row)} onSelect={() => setOpenKey(row.key)} />
    </li>
  );

  if (rows === null) {
    return <div className="flex items-center gap-2 p-6 text-xs text-fg-dim"><Spinner /> Loading proposals…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-sm font-medium text-fg">No proposals yet</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-fg-dim">
          Ask an agent to draft a program, or to change a program, CLAUDE.md or AGENTS.md. What it writes lands here for you to review.
        </p>
      </div>
    );
  }

  return (
    <div className="grid h-[min(72vh,48rem)] grid-cols-1 md:grid-cols-[19rem_minmax(0,1fr)]">
      <nav aria-label="Proposals" className="min-h-0 overflow-y-auto border-b border-line bg-surface-1/60 md:border-b-0 md:border-r">
        <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-dim">
          Waiting for review · {pendingCount}
        </p>
        {pending.length === 0 ? (
          <p className="px-4 pb-3 text-[11px] text-fg-dim">Nothing waiting. You are all caught up.</p>
        ) : (
          <ul className="space-y-0.5 px-2 pb-2">{pending.map(renderRow)}</ul>
        )}
        {resolved.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowResolved(!resolvedOpen)}
              aria-expanded={resolvedOpen}
              className="flex w-full items-center justify-between border-t border-line px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-fg-dim hover:text-fg"
            >
              Applied or discarded · {resolved.length}
              <span aria-hidden>{resolvedOpen ? "−" : "+"}</span>
            </button>
            {resolvedOpen && <ul className="space-y-0.5 px-2 pb-2">{resolved.map(renderRow)}</ul>}
          </>
        )}
      </nav>

      <section className="min-h-0 overflow-y-auto">
        {active === null ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-fg-dim">Select a proposal to review it.</div>
        ) : active.kind === "instructions" ? (
          <InstructionProposalEditor
            key={`${active.proposal.id}:${active.proposal.updatedAt}`}
            proposal={active.proposal}
            current={instructions[active.proposal.field]}
            writing={writingRun(active)}
            providers={providers}
            busy={busy}
            onSave={(content) => act(() => workspaceApi.saveInstructionProposal(serverUrl, active.proposal.id, content), "Proposal saved")}
            onApply={async (force) => {
              const name = INSTRUCTION_FILE_NAMES[active.proposal.field];
              const confirmed = await dialogs.confirm(force
                ? {
                    title: `Apply over the newer ${name}?`,
                    description: `${name} was changed after this proposal was opened. Applying replaces it with the proposed text, undoing that change. The replaced text is kept in the file's history.`,
                    confirmLabel: "Apply anyway",
                    tone: "danger",
                  }
                : {
                    title: `Apply these changes to ${name}?`,
                    description: `Every later run in this workspace reads the new ${name}. The current text is kept in the file's history, so it can be restored.`,
                    confirmLabel: "Apply",
                  });
              if (!confirmed) return;
              const ok = await act(() => workspaceApi.applyInstructionProposal(serverUrl, active.proposal.id, { force }), `${name} updated`);
              if (ok) await onApplied();
            }}
            onRework={(feedback, provider, model) =>
              act(
                () => workspaceApi.reviseInstructionProposal(serverUrl, active.proposal.id, { provider, model, feedback }),
                "The agent is reworking the proposal",
              )
            }
            onDiscard={async () => {
              const confirmed = await dialogs.confirm({
                title: "Discard this proposal?",
                description: "It is kept as a record, but it can no longer be applied. The same edit will not be proposed again.",
                confirmLabel: "Discard",
                tone: "danger",
              });
              if (confirmed) await act(() => workspaceApi.discardInstructionProposal(serverUrl, active.proposal.id), "Discarded");
            }}
            onDelete={async () => {
              const confirmed = await dialogs.confirm({
                title: "Delete this proposal?",
                description: "It is removed outright. If it was applied, the file keeps the applied text.",
                confirmLabel: "Delete",
                tone: "danger",
              });
              if (confirmed) {
                setOpenKey(null);
                await act(() => workspaceApi.removeInstructionProposal(serverUrl, active.proposal.id), "Deleted");
              }
            }}
          />
        ) : (
          <ProgramDraftEntry
            serverUrl={serverUrl}
            entry={active.entry}
            providers={providers}
            busy={busy}
            act={act}
            onApplied={onApplied}
            onDeleted={() => setOpenKey(null)}
          />
        )}
      </section>
    </div>
  );
}

function rowState(row: Row) {
  return row.kind === "program" ? row.entry.draft.state : row.proposal.state;
}

function ProposalRow({ row, active, writing, onSelect }: { row: Row; active: boolean; writing: boolean; onSelect(): void }) {
  const counts = useMemo(
    () => (row.kind === "instructions" ? diffLineCounts(diffLines(row.proposal.baseline, row.proposal.content)) : null),
    [row],
  );
  let kindBadge: { tone: "caution" | "violet" | "accent"; label: string };
  let title: string;
  let detail: string;
  if (row.kind === "instructions") {
    const name = INSTRUCTION_FILE_NAMES[row.proposal.field];
    kindBadge = { tone: "caution", label: name };
    title = row.proposal.goal === "" ? `Changes to ${name}` : row.proposal.goal;
    detail = `+${counts!.added} −${counts!.removed} lines${row.proposal.origin === "run" ? " · edited during a run" : ""}`;
  } else {
    const { draft, preview } = row.entry;
    const revision = draft.targetProgramId !== null;
    kindBadge = revision ? { tone: "violet", label: draft.baseline?.name ?? draft.body.name } : { tone: "accent", label: "new program" };
    title = revision ? draft.goal : draft.body.name === "" ? draft.goal : draft.body.name;
    detail = revision && draft.baseline !== null
      ? `${diffProgramRevision(draft.baseline, draft.body).length} change(s)`
      : `${preview.suites} suites · ${preview.prompts} work items`;
  }
  const state = rowState(row);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "w-full rounded-md px-3 py-2 text-left transition-colors",
        active ? "bg-surface-3 text-fg shadow-sm" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <span className="flex items-center gap-1.5">
        <Badge tone={kindBadge.tone}>{kindBadge.label}</Badge>
        {state !== "PENDING" && <Badge tone={STATE_TONE[state]}>{state.toLowerCase()}</Badge>}
        {writing && <Spinner size={11} />}
      </span>
      <span className="mt-1 block truncate text-[12.5px]">{title}</span>
      <span className="mt-0.5 block truncate text-[10.5px] text-fg-dim">
        {writing ? "An agent is writing…" : detail}
      </span>
    </button>
  );
}

/** One program draft, opened: its editor wired to the draft routes. */
function ProgramDraftEntry({ serverUrl, entry, providers, busy, act, onApplied, onDeleted }: {
  serverUrl: string;
  entry: Entry;
  providers: ProviderInfo[];
  busy: boolean;
  act(operation: () => Promise<unknown>, success?: string): Promise<boolean>;
  onApplied(): void | Promise<void>;
  onDeleted(): void;
}) {
  const toast = useToast();
  const dialogs = useDialogs();
  return (
    <DraftEditor
      key={`${entry.draft.id}:${entry.draft.updatedAt}`}
      serverUrl={serverUrl}
      entry={entry}
      providers={providers}
      busy={busy}
      onSave={(body) => act(() => workspaceApi.saveProgramDraft(serverUrl, entry.draft.id, body), "Draft saved")}
      onApply={async (withPipeline, changes) => {
        const revision = entry.draft.targetProgramId !== null;
        const confirmed = await dialogs.confirm(revision
          ? {
              title: "Apply these changes to the program?",
              description: `${changes} change(s) will be written into "${entry.draft.baseline?.name ?? entry.draft.body.name}". Changed work items keep their status and history, and each edit is saved as a revision you can restore. Removed items are deleted.`,
              confirmLabel: "Apply changes",
            }
          : {
              title: "Create this program?",
              description: `${entry.preview.prompts} work items in ${entry.preview.suites} suites will be added to this workspace. The draft is kept as a record.`,
              confirmLabel: "Create program",
            });
        if (!confirmed) return;
        const ok = await act(async () => {
          const result = await workspaceApi.applyProgramDraft(serverUrl, entry.draft.id, { withPipeline });
          if (result.pipelineError !== null) {
            toast.error(revision ? "The changes were applied; a new item was not added to a pipeline" : "The program was created; its pipeline was not", result.pipelineError);
          }
          if (result.revision !== null) {
            const r = result.revision;
            toast.success("Changes applied", `${r.added} added · ${r.updated} updated · ${r.moved} moved · ${r.removed} removed${r.pipelineSteps > 0 ? ` · ${r.pipelineSteps} pipeline station(s) added` : ""}`);
          }
          return result;
        }, entry.draft.targetProgramId !== null ? undefined : "Program created");
        if (ok) await onApplied();
      }}
      onRevise={(feedback, reviseProvider, model) =>
        act(
          () => workspaceApi.reviseProgramDraft(serverUrl, entry.draft.id, { provider: reviseProvider, model, feedback }),
          "The agent is revising the draft",
        )
      }
      onDiscard={async () => {
        const confirmed = await dialogs.confirm({
          title: "Discard this draft?",
          description: "It is kept as a record, but it can no longer be applied or written to.",
          confirmLabel: "Discard",
          tone: "danger",
        });
        if (confirmed) await act(() => workspaceApi.discardProgramDraft(serverUrl, entry.draft.id), "Discarded");
      }}
      onDelete={async () => {
        const confirmed = await dialogs.confirm({
          title: "Delete this draft?",
          description: "It is removed outright. Any program already created from it is untouched.",
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (confirmed) {
          onDeleted();
          await act(() => workspaceApi.removeProgramDraft(serverUrl, entry.draft.id), "Deleted");
        }
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */

interface EditorProps {
  serverUrl: string;
  entry: Entry;
  providers: ProviderInfo[];
  busy: boolean;
  onSave(body: ProgramDraftBody): Promise<boolean>;
  onApply(withPipeline: boolean, changes: number): Promise<void>;
  onRevise(feedback: string, provider: ProviderId, model: string | null): Promise<boolean>;
  onDiscard(): Promise<void>;
  onDelete(): Promise<void>;
}

/**
 * The draft, editable in place.
 *
 * The preview and the issue list are recomputed locally from the same shared
 * functions the server applies with, so what the buttons say is true of the
 * text on screen rather than of the last thing that was saved.
 */
function DraftEditor({ serverUrl, entry, providers, busy, onSave, onApply, onRevise, onDiscard, onDelete }: EditorProps) {
  const [body, setBody] = useState<ProgramDraftBody>(entry.draft.body);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [withPipeline, setWithPipeline] = useState(true);
  const [feedback, setFeedback] = useState("");
  const reviseAgent = useAgentChoice(providers);
  const reviseProvider = reviseAgent.choice.provider;
  const saved = useRef(entry.draft.body);

  useEffect(() => {
    setBody(entry.draft.body);
    saved.current = entry.draft.body;
  }, [entry.draft.body]);

  const editable = entry.draft.state === "PENDING";
  const baseline = entry.draft.targetProgramId !== null ? entry.draft.baseline : null;
  const revision = entry.draft.targetProgramId !== null;
  const changes = useMemo(() => (baseline === null ? [] : diffProgramRevision(baseline, body)), [baseline, body]);
  const changeByKey = useMemo(() => {
    const byKey = new Map<string, ProgramRevisionChange>();
    for (const change of changes) if (change.scope !== "program") byKey.set(`${change.scope}:${change.key}`, change);
    return byKey;
  }, [changes]);
  const preview = useMemo(() => programDraftPreview(body), [body]);
  const applicable = useMemo(() => canApplyProgramDraft(body), [body]);
  const dirty = useMemo(() => JSON.stringify(body) !== JSON.stringify(saved.current), [body]);

  const patchSuite = (index: number, patch: Partial<ProgramDraftSuite>) => {
    setBody((current) => ({
      ...current,
      suites: current.suites.map((suite, at) => (at === index ? { ...suite, ...patch } : suite)),
    }));
  };
  const patchPrompt = (suiteIndex: number, promptIndex: number, patch: Partial<ProgramDraftPrompt>) => {
    patchSuite(suiteIndex, {
      prompts: body.suites[suiteIndex]!.prompts.map((prompt, at) => (at === promptIndex ? { ...prompt, ...patch } : prompt)),
    });
  };
  const removePrompt = (suiteIndex: number, promptIndex: number) => {
    patchSuite(suiteIndex, { prompts: body.suites[suiteIndex]!.prompts.filter((_, at) => at !== promptIndex) });
  };

  return (
    <div className="space-y-4 p-5">
      <p className="text-[11px] leading-relaxed text-fg-dim">
        {revision ? "Changes asked for" : "Asked for"}: <span className="whitespace-pre-wrap text-fg-muted">{entry.draft.goal}</span>
      </p>
      {revision && (
        <div className="rounded-md border border-line bg-surface-1 p-3">
          <p className="text-[11px] font-medium text-fg-muted">
            {changes.length === 0
              ? entry.draft.runId !== null && entry.draft.state === "PENDING" ? "No changes yet — the agent is still reading." : "No changes yet."
              : `${changes.length} change(s) to ${baseline?.name ?? "the program"}`}
          </p>
          {changes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {changes.map((change) => (
                <li key={`${change.scope}:${change.kind}:${change.key}`} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                  <Badge tone={CHANGE_TONE[change.kind]}>{change.kind}</Badge>
                  <span className="text-fg-muted">
                    {change.scope === "program" ? "Program" : change.scope === "suite" ? `Suite ${change.key}` : change.key} · {change.label}
                  </span>
                  {change.details.length > 0 && <span className="text-fg-dim">{change.details.join("; ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {entry.draft.body.notes !== "" && (
        <details className="rounded-md border border-line bg-surface-1 px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-fg-muted">What the agent read</summary>
          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-fg-dim">{entry.draft.body.notes}</p>
        </details>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <TextInput
          label="Program name"
          value={body.name}
          disabled={!editable}
          onChange={(event) => setBody((current) => ({ ...current, name: event.target.value }))}
        />
        <TextInput
          label="Overview"
          value={body.overview}
          disabled={!editable}
          onChange={(event) => setBody((current) => ({ ...current, overview: event.target.value }))}
        />
      </div>

      <ul className="space-y-3">
        {body.suites.map((suite, suiteIndex) => (
          <li key={suite.key} className="rounded-md border border-line bg-surface-1 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Badge tone="neutral">{suite.key}</Badge>
              <TextInput
                label="Suite"
                fieldClassName="min-w-[12rem] flex-1"
                value={suite.name}
                disabled={!editable}
                onChange={(event) => patchSuite(suiteIndex, { name: event.target.value })}
              />
              <span className="pb-2 text-[11px] text-fg-dim">
                {suite.prompts.length} item{suite.prompts.length === 1 ? "" : "s"}
              </span>
            </div>
            {suite.prompts.length === 0 ? (
              <p className="mt-2 text-[11px] text-caution">
                No work items yet{entry.draft.runId !== null && entry.draft.state === "PENDING" ? " — the agent has not posted this suite" : ""}.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {suite.prompts.map((prompt, promptIndex) => {
                  const id = `${suite.key}:${prompt.key}`;
                  const verify = parseVerifyBlock(prompt.content).commands;
                  return (
                    <li key={prompt.key} className="rounded border border-line/70">
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-[12px] text-fg-muted hover:text-fg"
                          onClick={() => setExpanded(expanded === id ? null : id)}
                        >
                          <span className="text-fg-dim">{prompt.key}</span> {prompt.title}
                        </button>
                        {changeByKey.has(`item:${prompt.key}`) && (
                          <Badge tone={CHANGE_TONE[changeByKey.get(`item:${prompt.key}`)!.kind]}>{changeByKey.get(`item:${prompt.key}`)!.kind}</Badge>
                        )}
                        {prompt.gate !== null && <Badge tone="violet">gate</Badge>}
                        {prompt.dependsOn.length > 0 && (
                          <span className="text-[10px] text-fg-dim">after {prompt.dependsOn.join(", ")}</span>
                        )}
                        <Badge tone={verify.length > 0 ? "success" : "warning"}>
                          {verify.length > 0 ? `${verify.length} check${verify.length === 1 ? "" : "s"}` : "no checks"}
                        </Badge>
                      </div>
                      {expanded === id && (
                        <div className="space-y-2 border-t border-line/70 p-2">
                          <TextInput
                            label="Title"
                            value={prompt.title}
                            disabled={!editable}
                            onChange={(event) => patchPrompt(suiteIndex, promptIndex, { title: event.target.value })}
                          />
                          <TextArea
                            label="Instructions"
                            rows={14}
                            className="font-mono text-[11px]"
                            value={prompt.content}
                            disabled={!editable}
                            hint="A ## Verify block of shell commands becomes this item's definition of done."
                            onChange={(event) => patchPrompt(suiteIndex, promptIndex, { content: event.target.value })}
                          />
                          <div className="flex flex-wrap items-end gap-2">
                            <TextInput
                              label="Depends on"
                              fieldClassName="w-56"
                              value={prompt.dependsOn.join(", ")}
                              disabled={!editable}
                              hint="Keys, comma separated"
                              onChange={(event) =>
                                patchPrompt(suiteIndex, promptIndex, {
                                  dependsOn: event.target.value.split(",").map((value) => value.trim().toUpperCase()).filter((value) => value !== ""),
                                })
                              }
                            />
                            {editable && (
                              <Button size="sm" variant="ghost" onClick={() => removePrompt(suiteIndex, promptIndex)}>
                                Remove item
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {preview.issues.length > 0 && (
        <ul className="space-y-1 rounded-md border border-caution/40 bg-caution/10 p-3 text-[11px] text-caution">
          {preview.issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}

      <p className="text-[11px] text-fg-dim">
        {preview.prompts} work items · {preview.dependencies} dependencies · {preview.gates} gates · {preview.verifiable} with checks
      </p>

      {entry.draft.state === "APPLIED" ? (
        <p className="text-[11px] text-success">{revision ? "Applied. The program has these changes." : "Applied. This program is in the tree."}</p>
      ) : entry.draft.state === "DISCARDED" ? (
        <div className="flex gap-2">
          <p className="flex-1 text-[11px] text-fg-dim">Discarded.</p>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void onDelete()}>Delete</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || !applicable || dirty || (revision && changes.length === 0)}
              onClick={() => void onApply(withPipeline, changes.length)}
              title={dirty ? "Save your edits first" : !applicable ? "Every suite needs at least one work item, and titles must be unique within a suite" : revision && changes.length === 0 ? "Nothing has changed yet" : undefined}
            >
              {revision ? "Apply changes" : "Create program"}
            </Button>
            <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={withPipeline}
                onChange={(event) => setWithPipeline(event.target.checked)}
                className="accent-accent"
              />
              {revision ? "and put new work items on the pipelines that run their suite" : "and a pipeline to run it"}
            </label>
            <Button variant="secondary" loading={busy && dirty} disabled={busy || !dirty} onClick={() => void onSave(body)}>
              Save edits
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onDiscard()}>Discard</Button>
          </div>
          <div className={cn("space-y-3 border-t border-line pt-3", providers.length === 0 && "opacity-60")}>
            <TextInput
              label="Ask the agent to change it"
              value={feedback}
              placeholder="e.g. Split S2; it is three sessions of work. Add a rollback item."
              onChange={(event) => setFeedback(event.target.value)}
            />
            <div className="flex flex-wrap items-end justify-between gap-3">
              <ProviderModelPicker providers={providers} state={reviseAgent} label="Agent and model" placement="above" />
              <Button
                variant="secondary"
                disabled={busy || reviseProvider === "" || feedback.trim() === ""}
                onClick={() => void onRevise(feedback.trim(), reviseProvider as ProviderId, reviseAgent.choice.model)}
              >
                Revise
              </Button>
            </div>
          </div>
        </>
      )}
      <p className="text-[10px] text-fg-dim">
        Draft {entry.draft.id} · updated {new Date(entry.draft.updatedAt).toLocaleString()}
        {entry.draft.runId !== null && ` · run ${entry.draft.runId}`}
        {` · ${serverUrl.replace(/^https?:\/\//, "")}`}
      </p>
    </div>
  );
}

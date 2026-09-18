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
import { Select, TextArea, TextInput } from "../ui/Field";
import { Spinner } from "../ui/Spinner";
import { useDialogs } from "../ui/Dialogs";
import { useToast } from "../ui/Toast";
import { useProviders } from "./useProviders";

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
 * Requests are made from the request bar; this is where their results are read
 * and decided on. The screen is arranged around the one fact that matters: a
 * proposal is not a change. Nothing is created or modified until Apply, which
 * is why Apply is the only primary button in each one.
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

  const toggle = (key: string) => setOpenKey(openKey === key ? null : key);

  return (
    <section className="rounded-panel border border-line bg-surface-1">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-[13px] font-medium text-fg">Proposals</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
            New programs, changes to programs, and changes to CLAUDE.md and AGENTS.md, written by an agent or by you. Nothing is created or changed until you apply it.
          </p>
        </div>
        {rows !== null && rows.length > 0 && (
          <span className="text-[11px] text-fg-dim">{pendingCount} pending · {rows.length} total</span>
        )}
      </header>

      {rows === null ? (
        <div className="flex items-center gap-2 p-4 text-xs text-fg-dim"><Spinner /> Loading proposals…</div>
      ) : rows.length === 0 ? (
        <p className="p-4 text-xs leading-relaxed text-fg-dim">No proposals yet. Ask for one above with Change, Draft or Edit myself.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => row.kind === "instructions" ? (
            <li key={row.key}>
              <InstructionProposalRow
                proposal={row.proposal}
                open={openKey === row.key}
                writing={row.proposal.origin === "request" && row.proposal.runId !== null && liveRunIds.includes(row.proposal.runId)}
                onToggle={() => toggle(row.key)}
              />
              {openKey === row.key && (
                <InstructionProposalEditor
                  key={`${row.proposal.id}:${row.proposal.updatedAt}`}
                  proposal={row.proposal}
                  current={instructions[row.proposal.field]}
                  writing={row.proposal.origin === "request" && row.proposal.runId !== null && liveRunIds.includes(row.proposal.runId)}
                  providers={providers}
                  busy={busy}
                  onSave={(content) => act(() => workspaceApi.saveInstructionProposal(serverUrl, row.proposal.id, content), "Proposal saved")}
                  onApply={async (force) => {
                    const name = INSTRUCTION_FILE_NAMES[row.proposal.field];
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
                    const ok = await act(() => workspaceApi.applyInstructionProposal(serverUrl, row.proposal.id, { force }), `${name} updated`);
                    if (ok) await onApplied();
                  }}
                  onRework={(feedback, provider) =>
                    act(
                      () => workspaceApi.reviseInstructionProposal(serverUrl, row.proposal.id, { provider, feedback }),
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
                    if (confirmed) await act(() => workspaceApi.discardInstructionProposal(serverUrl, row.proposal.id), "Discarded");
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
                      await act(() => workspaceApi.removeInstructionProposal(serverUrl, row.proposal.id), "Deleted");
                    }
                  }}
                />
              )}
            </li>
          ) : (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => toggle(row.key)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
              >
                <Badge tone={STATE_TONE[row.entry.draft.state]}>{row.entry.draft.state.toLowerCase()}</Badge>
                <Badge tone={row.entry.draft.targetProgramId !== null ? "violet" : "accent"}>
                  {row.entry.draft.targetProgramId !== null ? "program changes" : "new program"}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">
                    {row.entry.draft.targetProgramId !== null
                      ? `${row.entry.draft.baseline?.name ?? row.entry.draft.body.name}: ${row.entry.draft.goal}`
                      : row.entry.draft.body.name === "" ? row.entry.draft.goal : row.entry.draft.body.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
                    {row.entry.draft.targetProgramId !== null && row.entry.draft.baseline !== null
                      ? `${diffProgramRevision(row.entry.draft.baseline, row.entry.draft.body).length} change(s) to an existing program`
                      : `${row.entry.preview.filledSuites}/${row.entry.preview.suites} suites · ${row.entry.preview.prompts} work items${row.entry.preview.verifiable > 0 ? ` · ${row.entry.preview.verifiable} verifiable` : ""}`}
                    {row.entry.draft.runId !== null && row.entry.draft.state === "PENDING" && liveRunIds.includes(row.entry.draft.runId) && " · an agent is writing"}
                  </span>
                </span>
                <span className="text-[11px] text-fg-dim">{openKey === row.key ? "hide" : "open"}</span>
              </button>
              {openKey === row.key && (
                <ProgramDraftEntry
                  serverUrl={serverUrl}
                  entry={row.entry}
                  providers={providers}
                  busy={busy}
                  act={act}
                  onApplied={onApplied}
                  onDeleted={() => setOpenKey(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InstructionProposalRow({ proposal, open, writing, onToggle }: { proposal: InstructionProposalRecord; open: boolean; writing: boolean; onToggle(): void }) {
  const counts = useMemo(() => diffLineCounts(diffLines(proposal.baseline, proposal.content)), [proposal.baseline, proposal.content]);
  return (
    <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2">
      <Badge tone={STATE_TONE[proposal.state]}>{proposal.state.toLowerCase()}</Badge>
      <Badge tone="caution">{INSTRUCTION_FILE_NAMES[proposal.field]}</Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{proposal.goal === "" ? `Changes to ${INSTRUCTION_FILE_NAMES[proposal.field]}` : proposal.goal}</span>
        <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
          {writing ? "an agent is writing" : `+${counts.added} −${counts.removed} lines`}
          {proposal.origin === "run" && " · edited during a run"}
        </span>
      </span>
      <span className="text-[11px] text-fg-dim">{open ? "hide" : "open"}</span>
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
      onRevise={(feedback, reviseProvider) =>
        act(
          () => workspaceApi.reviseProgramDraft(serverUrl, entry.draft.id, { provider: reviseProvider, feedback }),
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
  onRevise(feedback: string, provider: ProviderId): Promise<boolean>;
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
  const [reviseProvider, setReviseProvider] = useState<ProviderId | "">(
    providers.find((provider) => provider.available)?.id ?? "",
  );
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
    <div className="space-y-4 border-t border-line bg-surface-0/40 p-4">
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
          <div className={cn("flex flex-wrap items-end gap-2 border-t border-line pt-3", providers.length === 0 && "opacity-60")}>
            <TextInput
              label="Ask the agent to change it"
              fieldClassName="min-w-[16rem] flex-1"
              value={feedback}
              placeholder="e.g. Split S2; it is three sessions of work. Add a rollback item."
              onChange={(event) => setFeedback(event.target.value)}
            />
            <Select fieldClassName="w-40" value={reviseProvider} onChange={(event) => setReviseProvider(event.target.value as ProviderId)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.id}</option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={busy || reviseProvider === "" || feedback.trim() === ""}
              onClick={() => void onRevise(feedback.trim(), reviseProvider as ProviderId)}
            >
              Revise
            </Button>
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

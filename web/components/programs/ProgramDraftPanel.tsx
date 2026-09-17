"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProgramDraftBody,
  ProgramDraftPreview,
  ProgramDraftPrompt,
  ProgramDraftRecord,
  ProgramDraftSuite,
  ProgramRevisionChange,
  ProviderId,
  ProviderInfo,
} from "@agent-console/shared";
import { canApplyProgramDraft, diffProgramRevision, parseVerifyBlock, programDraftPreview } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { workspaceApi } from "@/lib/workspacesApi";
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
  /** Called after an apply, so the tree beside this panel repaints. */
  onApplied(): void | Promise<void>;
  /**
   * A draft to open on mount, e.g. the revision just started from a program.
   * The caller remounts the panel (by `key`) to show one opened elsewhere.
   */
  initialOpenId?: number | null;
}

type Entry = { draft: ProgramDraftRecord; preview: ProgramDraftPreview };

const STATE_TONE = { PENDING: "info", APPLIED: "success", DISCARDED: "neutral" } as const;

const CHANGE_TONE = { added: "success", changed: "info", moved: "violet", removed: "danger" } as const;

/**
 * Ask an agent to plan a program, then decide what to do with what it wrote.
 *
 * The screen is arranged around the one fact that matters: a draft is a
 * proposal. The agent fills it in, the operator edits it in place, and nothing
 * exists in the library until Apply — which is why Apply is the only primary
 * button here and why the issues list sits directly above it.
 */
export function ProgramDraftPanel({ serverUrl, workspaceId, onApplied, initialOpenId = null }: Props) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const { providers, firstAvailable } = useProviders(serverUrl);
  const [goal, setGoal] = useState("");
  const [picked, setProvider] = useState<ProviderId | "">("");
  const provider = picked !== "" ? picked : firstAvailable;
  const [openId, setOpenId] = useState<number | null>(initialOpenId);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await workspaceApi.programDrafts(serverUrl, workspaceId));
    } catch (error) {
      toast.error("Could not load drafts", error instanceof Error ? error.message : String(error));
      setEntries([]);
    }
  }, [serverUrl, workspaceId, toast]);

  useEffect(() => {
    setOpenId(initialOpenId);
    void load();
  }, [load, initialOpenId]);

  // While an author run is filling one in, its suites appear a post at a time.
  // Polling rather than the run socket: this panel is not the console, and a
  // five-second refresh is enough to watch a plan take shape.
  const authoring = (entries ?? []).some((entry) => entry.draft.state === "PENDING" && entry.draft.runId !== null);
  useEffect(() => {
    if (!authoring) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [authoring, load]);

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

  const start = async (withAgent: boolean) => {
    if (goal.trim() === "") {
      toast.error("Say what to plan", "Describe the outcome you want a program for.");
      return;
    }
    if (withAgent && provider === "") {
      toast.error("No provider", "No agent is available to draft with. Write the draft by hand instead.");
      return;
    }
    const started = await act(async () => {
      const result = await workspaceApi.startProgramDraft(serverUrl, workspaceId, {
        goal: goal.trim(),
        ...(withAgent ? { provider: provider as ProviderId } : {}),
      });
      setOpenId(result.draft.id);
      return result;
    }, withAgent ? "The agent is reading the workspace" : "Empty draft opened");
    if (started) setGoal("");
  };

  const open = entries?.find((entry) => entry.draft.id === openId) ?? null;

  return (
    <section className="rounded-panel border border-line bg-surface-1">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h3 className="text-[13px] font-medium text-fg">Draft a program with an agent</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
            An agent reads this workspace and proposes suites of work items. Changes proposed to an existing program land here too. Nothing is created or changed until you apply it.
          </p>
        </div>
        {entries !== null && entries.length > 0 && (
          <span className="text-[11px] text-fg-dim">{entries.length} draft{entries.length === 1 ? "" : "s"}</span>
        )}
      </header>

      <div className="space-y-3 border-b border-line p-4">
        <TextArea
          label="What should the program achieve?"
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="e.g. Move the API off the legacy host, one endpoint at a time, without downtime."
          hint="Say the outcome and any constraints. The agent decides the suites and the work items."
        />
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label="Agent"
            fieldClassName="w-52"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId | "")}
          >
            {providers.length === 0 && <option value="">no provider detected</option>}
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {entry.id}{entry.available ? "" : " — unavailable"}
              </option>
            ))}
          </Select>
          <Button variant="primary" loading={busy} onClick={() => void start(true)}>
            Draft it
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void start(false)}>
            Write one myself
          </Button>
        </div>
      </div>

      {entries === null ? (
        <div className="flex items-center gap-2 p-4 text-xs text-fg-dim"><Spinner /> Loading drafts…</div>
      ) : entries.length === 0 ? (
        <p className="p-4 text-xs leading-relaxed text-fg-dim">No drafts yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.draft.id}>
              <button
                type="button"
                onClick={() => setOpenId(openId === entry.draft.id ? null : entry.draft.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
              >
                <Badge tone={STATE_TONE[entry.draft.state]}>{entry.draft.state.toLowerCase()}</Badge>
                {entry.draft.targetProgramId !== null && <Badge tone="violet">changes</Badge>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">
                    {entry.draft.targetProgramId !== null
                      ? `${entry.draft.baseline?.name ?? entry.draft.body.name}: ${entry.draft.goal}`
                      : entry.draft.body.name === "" ? entry.draft.goal : entry.draft.body.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
                    {entry.draft.targetProgramId !== null && entry.draft.baseline !== null
                      ? `${diffProgramRevision(entry.draft.baseline, entry.draft.body).length} change(s) to an existing program`
                      : `${entry.preview.filledSuites}/${entry.preview.suites} suites · ${entry.preview.prompts} work items${entry.preview.verifiable > 0 ? ` · ${entry.preview.verifiable} verifiable` : ""}`}
                    {entry.draft.runId !== null && entry.draft.state === "PENDING" && " · an agent is writing"}
                  </span>
                </span>
                <span className="text-[11px] text-fg-dim">{openId === entry.draft.id ? "hide" : "open"}</span>
              </button>
              {openId === entry.draft.id && open !== null && (
                <DraftEditor
                  key={`${entry.draft.id}:${entry.draft.updatedAt}`}
                  serverUrl={serverUrl}
                  entry={open}
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
                      setOpenId(null);
                      await act(() => workspaceApi.removeProgramDraft(serverUrl, entry.draft.id), "Deleted");
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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

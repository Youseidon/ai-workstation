"use client";

/**
 * What "done" means here, and how each criterion currently stands.
 *
 * The panel is the same in two places on purpose. On a work item it shows the
 * live results and can run the commands; on a scope (a suite, a workspace) it
 * edits the criteria that everything underneath inherits. Two panels would have
 * drifted into disagreeing about what a criterion is, which is the failure the
 * status catalog already had once.
 *
 * The distinction it works hardest to keep visible is between FAILED and
 * UNVERIFIED. "It was checked and it did not pass" and "nothing has checked it"
 * send an operator to completely different places, and collapsing them is what
 * makes a verdict untrustworthy — the same reason UNREPORTED exists as a status
 * separate from FAILED.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DOD_COMMAND_TIMEOUT_DEFAULT_MS,
  DOD_CRITERION_KINDS,
  DOD_ENFORCEMENTS,
  DOD_ENFORCEMENT_LABEL,
  DOD_KIND_HINT,
  DOD_KIND_LABEL,
  DOD_SCOPE_LABEL,
} from "@agent-console/shared";
import type {
  DefinitionOfDone,
  DodCriterion,
  DodCriterionKind,
  DodCriterionResult,
  DodEnforcement,
  DodEvaluation,
} from "@agent-console/shared";
import { workspaceApi } from "@/lib/workspacesApi";
import { SERVER_URL } from "@/lib/serverUrl";
import { Badge, Button, Select, Switch, TextInput, useToast } from "@/components/ui";
import { cn } from "@/lib/cn";

const RESULT_TONE = { PASSED: "success", FAILED: "danger", UNVERIFIED: "caution" } as const;
const RESULT_LABEL = { PASSED: "passed", FAILED: "failed", UNVERIFIED: "not checked" } as const;

/** Who said so. A recorded exit code and a model's opinion are not the same claim. */
const SOURCE_LABEL: Record<string, string> = {
  RUNNER: "this server ran it",
  REVIEWER: "a reviewer judged it",
  AGENT: "the agent reported it",
  HUMAN: "you recorded it",
};

interface Draft {
  kind: DodCriterionKind;
  text: string;
  command: string;
  cwd: string;
  expectExitCode: number;
  timeoutMs: number;
  required: boolean;
}

const emptyDraft = (): Draft => ({
  kind: "COMMAND", text: "", command: "", cwd: "",
  expectExitCode: 0, timeoutMs: DOD_COMMAND_TIMEOUT_DEFAULT_MS, required: true,
});

const draftOf = (criterion: DodCriterion): Draft => ({
  kind: criterion.kind,
  text: criterion.text,
  command: criterion.command ?? "",
  cwd: criterion.cwd ?? "",
  expectExitCode: criterion.expectExitCode,
  timeoutMs: criterion.timeoutMs,
  required: criterion.required,
});

function CriterionForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <div className="rounded border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-fg-dim">
          Kind
          <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as DodCriterionKind })}>
            {DOD_CRITERION_KINDS.map((kind) => <option key={kind} value={kind}>{DOD_KIND_LABEL[kind]}</option>)}
          </Select>
        </label>
        <span className="flex items-center gap-1.5 pb-1 text-[11px] text-fg-dim" title="An optional criterion is checked and reported, but never stops a work item closing.">
          Required
          <Switch checked={draft.required} aria-label="Required" onCheckedChange={(next) => setDraft({ ...draft, required: next })} />
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-fg-dim">{DOD_KIND_HINT[draft.kind]}</p>

      <label className="mt-2 block text-[11px] text-fg-dim">
        What has to be true <span className="text-fg-dim/60">— in your words, and what a reviewer is shown</span>
        <TextInput
          value={draft.text}
          placeholder={draft.kind === "COMMAND" ? "the test suite passes" : "the API returns 404 for a missing record"}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
      </label>

      {draft.kind === "COMMAND" && (
        <>
          <label className="mt-2 block text-[11px] text-fg-dim">
            Command <span className="text-fg-dim/60">— run by this server, in the workspace, as your user</span>
            <TextInput
              value={draft.command}
              placeholder="npm test"
              className="font-mono"
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            />
          </label>
          <div className="mt-2 flex flex-wrap items-end gap-3 text-[11px] text-fg-dim">
            <label className="text-[11px] text-fg-dim">
              Directory <span className="text-fg-dim/60">— relative to the workspace</span>
              <TextInput value={draft.cwd} placeholder="(the workspace root)" onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} />
            </label>
            <label className="flex items-center gap-1.5" title="Usually 0. A criterion can also assert that something still fails.">
              Expects exit
              <input
                type="number" min={0} max={255} value={draft.expectExitCode}
                onChange={(event) => setDraft({ ...draft, expectExitCode: Number(event.target.value) })}
                className="w-14 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg"
              />
            </label>
            <label className="flex items-center gap-1.5" title="It is killed after this, along with anything it started, and the criterion does not pass.">
              Timeout (s)
              <input
                type="number" min={1} max={600} value={Math.round(draft.timeoutMs / 1000)}
                onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) * 1000 })}
                className="w-16 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg"
              />
            </label>
          </div>
        </>
      )}

      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={onSubmit}>{submitLabel}</Button>
        {onCancel !== undefined && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

function CriterionRow({
  criterion,
  result,
  editable,
  onSave,
  onRemove,
}: {
  criterion: DodCriterion;
  /** Absent on a scope editor, where there is no work item to have results. */
  result: DodCriterionResult | null;
  editable: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(criterion));
  const [busy, setBusy] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  useEffect(() => setDraft(draftOf(criterion)), [criterion]);

  if (editing) {
    return (
      <div className="border-t border-line py-3 first:border-t-0">
        <CriterionForm
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          submitLabel="Save"
          onCancel={() => { setDraft(draftOf(criterion)); setEditing(false); }}
          onSubmit={() => {
            setBusy(true);
            void onSave({ ...draft, cwd: draft.cwd.trim() === "" ? null : draft.cwd.trim() })
              .then(() => setEditing(false))
              .finally(() => setBusy(false));
          }}
        />
      </div>
    );
  }

  return (
    <div className="border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {result !== null && <Badge tone={RESULT_TONE[result.result]}>{RESULT_LABEL[result.result]}</Badge>}
        <span className="text-[13px] text-fg">{criterion.text}</span>
        {!criterion.required && <span className="text-[10px] text-fg-dim" title="Checked and reported, but it never stops a close.">optional</span>}
        <span className="text-[10px] text-fg-dim">{DOD_KIND_LABEL[criterion.kind]}</span>
        {editable && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => { setBusy(true); void onRemove().finally(() => setBusy(false)); }}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      {criterion.command !== null && (
        <code className="mt-1 block break-all font-mono text-[11px] text-fg-muted">
          {criterion.cwd === null ? "" : `${criterion.cwd}$ `}{criterion.command}
          {criterion.expectExitCode !== 0 && <span className="text-fg-dim"> (expects exit {criterion.expectExitCode})</span>}
        </code>
      )}

      {result !== null && (
        <div className="mt-1 text-[11px] text-fg-dim">
          {result.evidence}
          {result.source !== null && <span> · {SOURCE_LABEL[result.source] ?? result.source}</span>}
          {result.createdAt !== null && <span> · {new Date(result.createdAt).toLocaleString("en-GB", { hour12: false })}</span>}
          {/* The command's own output, not a summary of it. An operator
              debugging a refused close needs the compiler's words. */}
          {result.output !== "" && (
            <button type="button" className="ml-2 text-accent underline decoration-accent/40 underline-offset-2" onClick={() => setShowOutput(!showOutput)}>
              {showOutput ? "hide output" : "show output"}
            </button>
          )}
        </div>
      )}
      {showOutput && result !== null && (
        <pre className="mt-1 max-h-64 overflow-auto rounded border border-line bg-surface-2 p-2 font-mono text-[11px] leading-5 text-fg-muted">{result.output}</pre>
      )}
    </div>
  );
}

/**
 * `promptId` turns the panel into the live view for one work item: results,
 * inheritance, and a button that runs the commands. Without it, the panel edits
 * one scope's criteria and nothing else.
 */
export function DefinitionOfDonePanel({
  scope,
  scopeId,
  promptId,
  onChanged,
}: {
  scope: "workspace" | "program" | "suite" | "prompt";
  scopeId: number;
  promptId?: number;
  onChanged?: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [definition, setDefinition] = useState<DefinitionOfDone | null>(null);
  const [evaluation, setEvaluation] = useState<DodEvaluation | null>(null);
  const [own, setOwn] = useState<DefinitionOfDone | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (promptId === undefined) {
      void workspaceApi.scopeDefinitionOfDone(SERVER_URL, scope, scopeId)
        .then((result) => { setDefinition(result); setOwn(result); setEvaluation(null); })
        .catch(() => { setDefinition(null); setOwn(null); });
      return;
    }
    void Promise.all([
      workspaceApi.definitionOfDone(SERVER_URL, promptId),
      workspaceApi.scopeDefinitionOfDone(SERVER_URL, "prompt", promptId),
    ])
      .then(([resolved, mine]) => { setDefinition(resolved.definitionOfDone); setEvaluation(resolved.evaluation); setOwn(mine); })
      .catch(() => { setDefinition(null); setOwn(null); });
  }, [scope, scopeId, promptId]);
  useEffect(load, [load]);

  const act = async (work: Promise<unknown>, done: string) => {
    try {
      await work;
      load();
      onChanged?.();
      toast.success(done);
    } catch (error) {
      // The server refuses a criterion it could not run, by field. Saying which
      // beats "something went wrong" — that is the whole point of validating at
      // the moment the criterion is written rather than at 3am.
      toast.error("That change was refused", error instanceof Error ? error.message : undefined);
    }
  };

  if (definition === null) return <p className="text-[11px] text-fg-dim">Loading the definition of done…</p>;

  // Criteria are inherited whole from the nearest scope that has any, so
  // editing is only ever offered where they actually live. Anything else would
  // be a form that edits a different work item's rules without saying so.
  const editingScope = promptId === undefined ? { scope, scopeId } : (definition.inheritedFrom ?? { scope: "prompt" as const, scopeId: promptId });
  const inherited = promptId !== undefined && definition.inheritedFrom !== null && definition.inheritedFrom.scope !== "prompt";
  const resultFor = (criterion: DodCriterion): DodCriterionResult | null =>
    evaluation?.criteria.find((entry) => entry.criterionId === criterion.id) ?? null;

  return (
    <section className="rounded border border-line bg-surface-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">Definition of done</h3>
        {evaluation !== null && definition.criteria.length > 0 && (
          <Badge tone={evaluation.satisfied ? "success" : evaluation.blocking ? "danger" : "caution"}>
            {evaluation.satisfied ? "met" : evaluation.blocking ? "not met — this work item cannot close" : "not met"}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-fg-dim" title="What happens when a required criterion does not pass. Inherits from Pipeline policy unless you say otherwise here.">
            If not met
            <Select
              value={definition.enforcement}
              onChange={(event) => void act(
                workspaceApi.setDodEnforcement(SERVER_URL, editingScope.scope, editingScope.scopeId, event.target.value as DodEnforcement),
                "Enforcement updated",
              )}
            >
              {DOD_ENFORCEMENTS.map((value) => <option key={value} value={value}>{DOD_ENFORCEMENT_LABEL[value]}</option>)}
            </Select>
          </label>
          {promptId !== undefined && definition.criteria.some((entry) => entry.kind === "COMMAND") && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="Runs the command criteria now — the same execution a close is decided on"
              onClick={() => { setBusy(true); void act(workspaceApi.runDefinitionOfDone(SERVER_URL, promptId), "Checks run").finally(() => setBusy(false)); }}
            >
              Check now
            </Button>
          )}
        </div>
      </div>

      {inherited && definition.inheritedFrom !== null && (
        <p className="mt-1 text-[11px] text-fg-dim">
          Inherited from {DOD_SCOPE_LABEL[definition.inheritedFrom.scope]}. Adding a criterion here gives this
          work item its own definition of done, which replaces the inherited one rather than adding to it.
        </p>
      )}

      {definition.criteria.length === 0 ? (
        <p className="mt-2 text-[11px] leading-5 text-fg-dim">
          Nothing is defined, so nothing is checked and a work item closes on whatever the agent or the
          reviewer says. Add a command and that stops being true.
        </p>
      ) : (
        <div className="mt-2">
          {definition.criteria.map((criterion) => (
            <CriterionRow
              key={criterion.id}
              criterion={criterion}
              result={resultFor(criterion)}
              editable={!inherited || own !== null}
              onSave={(patch) => act(
                // An inherited criterion is edited where it lives, not copied
                // down: silently forking it would leave two rules that look the
                // same and diverge the moment either is changed.
                workspaceApi.patchDodCriterion(SERVER_URL, definition.inheritedFrom?.scope ?? editingScope.scope, definition.inheritedFrom?.scopeId ?? editingScope.scopeId, criterion.id, patch),
                "Criterion updated",
              )}
              onRemove={() => act(
                workspaceApi.removeDodCriterion(SERVER_URL, definition.inheritedFrom?.scope ?? editingScope.scope, definition.inheritedFrom?.scopeId ?? editingScope.scopeId, criterion.id),
                "Criterion removed",
              )}
            />
          ))}
        </div>
      )}

      <div className={cn("mt-3", adding && "space-y-2")}>
        {adding ? (
          <CriterionForm
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            submitLabel="Add criterion"
            onCancel={() => { setDraft(emptyDraft()); setAdding(false); }}
            onSubmit={() => {
              setBusy(true);
              void act(
                workspaceApi.addDodCriterion(SERVER_URL, editingScope.scope, editingScope.scopeId, { ...draft, cwd: draft.cwd.trim() === "" ? null : draft.cwd.trim() }),
                "Criterion added",
              )
                .then(() => { setDraft(emptyDraft()); setAdding(false); })
                .finally(() => setBusy(false));
            }}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>Add a criterion</Button>
        )}
      </div>
    </section>
  );
}

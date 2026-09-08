"use client";

/**
 * The status catalog, editable.
 *
 * Every state the pipeline can show is one row here: what it is called, what it
 * means, how it looks, and what it does to the run. The labels used to be
 * hardcoded in two maps in `status.ts` that disagreed with the shared rule
 * table — so the same run read as "blocked" in one place and "Needs you" in
 * another, and nobody could change either.
 *
 * Locked fields render their reason in place of a control. That is the same
 * convention `RulesPanel` uses for locked rule rows, and it is deliberate: some
 * of these are invariants rather than preferences, and a screen that could
 * break them would be worse than no screen. Showing why beats hiding the field.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_STATUS_CATALOG,
  STATUS_ICONS,
  STATUS_ON_ENTER,
  STATUS_TONES,
  statusDefinition,
  statusFieldEditable,
} from "@agent-console/shared";
import type { StatusDefinition, StatusEditableKey, StatusOnEnter } from "@agent-console/shared";
import { workspaceApi } from "@/lib/workspacesApi";
import { SERVER_URL } from "@/lib/serverUrl";
import { Badge, Button, Select, Switch, TextInput, useToast } from "@/components/ui";
import { StatusIcon } from "./StatusIcon";

/** What entering a state sets in motion, in words rather than a token. */
const ON_ENTER_LABEL: Record<StatusOnEnter, string> = {
  none: "Nothing — it just sits there",
  advance: "Move on to the next station",
  park: "Hold the run and wait for you",
  review: "Send a reviewer to check the work",
  continue: "Re-run the same station with its prior notes",
  handoff: "Prepare a continuation brief",
  retry: "Run it again",
};

function Locked({ reason }: { reason: string }) {
  return (
    <span
      className="cursor-help border-b border-dotted border-fg-dim/50 text-[11px] text-fg-dim"
      title={reason}
    >
      Fixed
    </span>
  );
}

function Row({
  definition,
  onSave,
  onReset,
  overridden,
}: {
  definition: StatusDefinition;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onReset: () => Promise<void>;
  overridden: boolean;
}) {
  const [draft, setDraft] = useState(definition);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(definition), [definition]);

  const dirty =
    draft.label !== definition.label
    || draft.shortLabel !== definition.shortLabel
    || draft.description !== definition.description
    || draft.tone !== definition.tone
    || draft.icon !== definition.icon
    || draft.needsAttention !== definition.needsAttention
    || draft.blocksParent !== definition.blocksParent
    || draft.precedence !== definition.precedence
    || draft.onEnter !== definition.onEnter;

  const editable = (field: StatusEditableKey) => statusFieldEditable(definition, field);
  const reason = definition.lockedReason ?? "This field cannot be changed.";

  return (
    <div className="border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={draft.tone}>
          <StatusIcon icon={draft.icon} className="mr-1" />
          {draft.label}
        </Badge>
        <code className="text-[10px] text-fg-dim">{definition.id}</code>
        {!definition.storable && (
          <span
            className="text-[10px] text-fg-dim"
            title="Worked out fresh on every read from what is true right now, never written to the database."
          >
            live
          </span>
        )}
        {overridden && <span className="text-[10px] text-accent">edited</span>}
        <div className="ml-auto flex items-center gap-2">
          {overridden && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => { setBusy(true); void onReset().finally(() => setBusy(false)); }}
            >
              Reset
            </Button>
          )}
          <Button
            size="sm"
            disabled={!dirty || busy}
            onClick={() => {
              setBusy(true);
              void onSave({
                label: draft.label, shortLabel: draft.shortLabel, description: draft.description,
                tone: draft.tone, icon: draft.icon,
                ...(editable("needsAttention") ? { needsAttention: draft.needsAttention } : {}),
                ...(editable("blocksParent") ? { blocksParent: draft.blocksParent } : {}),
                ...(editable("precedence") ? { precedence: draft.precedence } : {}),
                ...(editable("onEnter") ? { onEnter: draft.onEnter } : {}),
              }).finally(() => setBusy(false));
            }}
          >
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="text-[11px] text-fg-dim">
          Label
          <TextInput value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </label>
        <label className="text-[11px] text-fg-dim">
          Short label <span className="text-fg-dim/60">— for tight spaces</span>
          <TextInput value={draft.shortLabel} onChange={(e) => setDraft({ ...draft, shortLabel: e.target.value })} />
        </label>
      </div>

      <label className="mt-2 block text-[11px] text-fg-dim">
        What it means <span className="text-fg-dim/60">— shown wherever this state has to explain itself</span>
        <TextInput value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </label>

      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-fg-dim">
          Colour
          <Select value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value as StatusDefinition["tone"] })}>
            {STATUS_TONES.map((tone) => <option key={tone} value={tone}>{tone}</option>)}
          </Select>
        </label>
        <label className="text-[11px] text-fg-dim">
          Icon
          <Select value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value as StatusDefinition["icon"] })}>
            {STATUS_ICONS.map((icon) => <option key={icon} value={icon}>{icon}</option>)}
          </Select>
        </label>
        <label className="text-[11px] text-fg-dim">
          On entering
          {editable("onEnter")
            ? (
              <Select value={draft.onEnter} onChange={(e) => setDraft({ ...draft, onEnter: e.target.value as StatusOnEnter })}>
                {STATUS_ON_ENTER.map((value) => <option key={value} value={value}>{ON_ENTER_LABEL[value]}</option>)}
              </Select>
            )
            : <div className="pt-1"><Locked reason={reason} /></div>}
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-fg-dim">
        <span className="flex items-center gap-1.5" title="No further work is expected. Terminal states settle a parent and let the pipeline move past them.">
          Finished
          <span className="text-fg">{definition.isTerminal ? "yes" : "no"}</span>
          {!editable("isTerminal") && <Locked reason={reason} />}
        </span>
        <span className="flex items-center gap-1.5" title="Whether something that declared a dependency on this item may now run.">
          Satisfies dependencies
          <span className="text-fg">{definition.satisfiesDependency ? "yes" : "no"}</span>
          {!editable("satisfiesDependency") && <Locked reason={reason} />}
        </span>
        <span className="flex items-center gap-1.5" title="Whether this state belongs on the attention list.">
          Needs attention
          {editable("needsAttention")
            ? <Switch checked={draft.needsAttention} aria-label="Needs attention" onCheckedChange={(next) => setDraft({ ...draft, needsAttention: next })} />
            : <span className="text-fg">{definition.needsAttention ? "yes" : "no"}</span>}
        </span>
        {draft.needsAttention && editable("precedence") && (
          <label className="flex items-center gap-1.5" title="When every sub-step has settled, a parent takes the highest-precedence attention status among them. Higher wins.">
            Rollup precedence
            <input
              type="number"
              min={0}
              value={draft.precedence}
              onChange={(e) => setDraft({ ...draft, precedence: Number(e.target.value) })}
              className="w-16 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg"
            />
          </label>
        )}
      </div>
    </div>
  );
}

export function StatusCatalogPanel({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<StatusDefinition[] | null>(null);

  const load = useCallback(() => {
    void workspaceApi.statuses(SERVER_URL)
      .then((result) => setCatalog(result.statuses))
      .catch(() => setCatalog([...DEFAULT_STATUS_CATALOG]));
  }, []);
  useEffect(load, [load]);

  const act = async (work: Promise<unknown>, done: string) => {
    try {
      await work;
      load();
      onChanged?.();
      toast.success(done);
    } catch (error) {
      // The server refuses a locked field by name, so the message says which
      // control was rejected rather than that "something" went wrong.
      toast.error("That change was refused", error instanceof Error ? error.message : undefined);
    }
  };

  if (catalog === null) return <p className="text-[11px] text-fg-dim">Loading the status catalog…</p>;

  const shipped = (id: string) => statusDefinition(DEFAULT_STATUS_CATALOG, id as never);
  const isOverridden = (definition: StatusDefinition) => {
    const base = shipped(definition.id);
    return (Object.keys(base) as Array<keyof StatusDefinition>)
      .some((key) => key !== "locked" && JSON.stringify(base[key]) !== JSON.stringify(definition[key]));
  };

  return (
    <div>
      <p className="mb-3 text-[11px] text-fg-dim">
        Every state a work item can be in. The names and descriptions are yours — rename one here and it
        changes on the board, on the station cards and in the status bar at once. A few fields are fixed
        because the pipeline relies on them; those say why instead of showing a control.
      </p>
      {catalog.map((definition) => (
        <Row
          key={definition.id}
          definition={definition}
          overridden={isOverridden(definition)}
          onSave={(patch) => act(workspaceApi.patchStatus(SERVER_URL, definition.id, patch), `${definition.label} updated`)}
          onReset={() => act(workspaceApi.resetStatus(SERVER_URL, definition.id), `${definition.id} back to its default`)}
        />
      ))}
    </div>
  );
}

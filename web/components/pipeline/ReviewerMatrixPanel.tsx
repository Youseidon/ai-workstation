"use client";

/**
 * What a reviewer does, in each situation the app has no first-hand account of.
 *
 * This replaced one global three-way switch — off / report / autocomplete —
 * which meant every situation had to be handled identically. An operator could
 * not say "check a run that went quiet, but leave a crash for me", could not
 * choose which agent does the checking, and on a single-provider setup got no
 * review at all, silently. The server side has been configurable since the
 * reviewer matrix landed; until now nothing called it, so none of it was
 * reachable by anyone who did not write SQL.
 *
 * Same conventions as `StatusCatalogPanel`, deliberately: one row per thing,
 * saved explicitly, reset back to the shipped default, and a field that is not
 * the operator's to change shows *why* rather than showing nothing.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_REVIEWER_CONFIG,
  MODEL_CATALOG,
  PROVIDER_IDS,
  REVIEW_ACTIONS,
  REVIEW_ACTION_LABEL,
  REVIEW_ACTION_CONSEQUENCE,
  REVIEW_TRIGGERS,
  REVIEW_TRIGGER_LABEL,
} from "@agent-console/shared";
import type { ReviewAction, ReviewTrigger, ReviewerConfig } from "@agent-console/shared";
import { workspaceApi } from "@/lib/workspacesApi";
import { SERVER_URL } from "@/lib/serverUrl";
import { Badge, Button, Select, Switch, useToast } from "@/components/ui";

/**
 * Why each situation is worth treating differently, in the operator's terms.
 * The trigger labels say *what* happened; these say what it means for trust.
 */
const TRIGGER_HINT: Record<ReviewTrigger, string> = {
  unreported:
    "The run finished cleanly and never said what it achieved. Often the work is sitting in the "
    + "tree already — this is the situation the reviewer was built for.",
  failed:
    "The process exited abnormally. It may still have finished the work first, so it is worth "
    + "checking; a crash is an observed fact, and closing on one deserves more caution.",
  dodUnmet:
    "A required criterion did not pass. A reviewer can say whether the criterion is wrong or the "
    + "work is — but it cannot overturn a command's exit code.",
  childFailed:
    "A sub-step needs attention, so its parent cannot be treated as finished until someone "
    + "establishes what is actually outstanding.",
};

/** BLOCKED is absent from REVIEW_TRIGGERS on purpose, and that is worth saying. */
const WHY_NO_BLOCKED =
  "An agent that posted BLOCKED stopped to ask you a question. There is no situation for it here "
  + "on purpose: a machine reviewing past it would be overruling a request for a human decision.";

function Row({
  config,
  onSave,
  onReset,
}: {
  config: ReviewerConfig;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(config);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(config), [config]);

  const shipped = DEFAULT_REVIEWER_CONFIG[config.trigger];
  const dirty = (Object.keys(config) as Array<keyof ReviewerConfig>).some((key) => draft[key] !== config[key]);
  const overridden = (Object.keys(shipped) as Array<keyof ReviewerConfig>).some((key) => config[key] !== shipped[key]);
  const models = draft.provider === null ? [] : MODEL_CATALOG[draft.provider as keyof typeof MODEL_CATALOG] ?? [];

  return (
    <div className="border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={draft.enabled ? "info" : "neutral"}>{REVIEW_TRIGGER_LABEL[config.trigger]}</Badge>
        <code className="text-[10px] text-fg-dim">{config.trigger}</code>
        {overridden && <span className="text-[10px] text-accent">edited</span>}
        <div className="ml-auto flex items-center gap-2">
          {overridden && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setBusy(true); void onReset().finally(() => setBusy(false)); }}>
              Reset
            </Button>
          )}
          <Button
            size="sm"
            disabled={!dirty || busy}
            onClick={() => {
              setBusy(true);
              void onSave({
                enabled: draft.enabled,
                provider: draft.provider,
                model: draft.model,
                maxAttempts: draft.maxAttempts,
                mustDifferFromSource: draft.mustDifferFromSource,
                onComplete: draft.onComplete,
                onIncomplete: draft.onIncomplete,
                onUnverifiable: draft.onUnverifiable,
              }).finally(() => setBusy(false));
            }}
          >
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <p className="mt-1 text-[11px] leading-5 text-fg-dim">{TRIGGER_HINT[config.trigger]}</p>

      <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2 text-[11px] text-fg-dim">
        <span className="flex items-center gap-1.5" title="Whether a reviewer is sent by itself when this happens. Off means it waits for you.">
          Send a reviewer
          <Switch
            checked={draft.enabled}
            aria-label={`Send a reviewer when ${REVIEW_TRIGGER_LABEL[config.trigger].toLowerCase()}`}
            onCheckedChange={(next) => setDraft({ ...draft, enabled: next })}
          />
        </span>
        <label className="text-[11px] text-fg-dim">
          Reviewer
          <Select
            value={draft.provider ?? ""}
            onChange={(event) => setDraft({ ...draft, provider: event.target.value === "" ? null : event.target.value, model: null })}
          >
            <option value="">whichever is available</option>
            {/* Cursor is absent because it cannot be held read-only, and a
                reviewer that can edit the tree is not reviewing it. */}
            {PROVIDER_IDS.filter((id) => id !== "cursor").map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
        </label>
        <label className="text-[11px] text-fg-dim">
          Model
          <Select
            value={draft.model ?? ""}
            disabled={draft.provider === null}
            onChange={(event) => setDraft({ ...draft, model: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">whatever it picks</option>
            {models.filter((option) => option.id !== null).map((option) => <option key={option.id} value={option.id!}>{option.label}</option>)}
          </Select>
        </label>
        <label className="flex items-center gap-1.5" title="How many times a reviewer may be sent to the same run before the pipeline stops asking.">
          Attempts
          <input
            type="number"
            min={1}
            max={5}
            value={draft.maxAttempts}
            onChange={(event) => setDraft({ ...draft, maxAttempts: Number(event.target.value) })}
            className="w-14 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg"
          />
        </label>
        <span
          className="flex items-center gap-1.5"
          title="Marking your own homework is the failure this mechanism exists to avoid. Turning it off is only worth it on a single-agent setup, where the alternative is no review at all."
        >
          Must differ from the agent on trial
          <Switch
            checked={draft.mustDifferFromSource}
            aria-label="The reviewer must not be the agent whose run is on trial"
            onCheckedChange={(next) => setDraft({ ...draft, mustDifferFromSource: next })}
          />
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Verdict
          label="If it says the work is complete"
          value={draft.onComplete}
          onChange={(next) => setDraft({ ...draft, onComplete: next })}
        />
        <Verdict
          label="If it says the work is unfinished"
          value={draft.onIncomplete}
          onChange={(next) => setDraft({ ...draft, onIncomplete: next })}
        />
        <Verdict
          label="If it cannot tell either way"
          value={draft.onUnverifiable}
          onChange={(next) => setDraft({ ...draft, onUnverifiable: next })}
        />
      </div>
    </div>
  );
}

function Verdict({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReviewAction;
  onChange: (next: ReviewAction) => void;
}) {
  return (
    <label className="text-[11px] text-fg-dim">
      {label}
      <Select value={value} onChange={(event) => onChange(event.target.value as ReviewAction)}>
        {REVIEW_ACTIONS.map((action) => (
          // The consequence, not just the name: "finish the work" and "write a
          // brief about the work" are one word apart in the label and a whole
          // agent run apart in what they cost.
          <option key={action} value={action} title={REVIEW_ACTION_CONSEQUENCE[action]}>
            {REVIEW_ACTION_LABEL[action]}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function ReviewerMatrixPanel(): React.ReactElement {
  const toast = useToast();
  const [reviewers, setReviewers] = useState<ReviewerConfig[] | null>(null);

  const load = useCallback(() => {
    void workspaceApi.reviewers(SERVER_URL)
      .then(setReviewers)
      // The shipped defaults are the honest fallback: they are what the server
      // resolves to when nothing has been said, so a failed read shows what is
      // actually in force rather than an empty panel.
      .catch(() => setReviewers(REVIEW_TRIGGERS.map((trigger) => DEFAULT_REVIEWER_CONFIG[trigger])));
  }, []);
  useEffect(load, [load]);

  const act = async (work: Promise<unknown>, done: string) => {
    try {
      await work;
      load();
      toast.success(done);
    } catch (error) {
      toast.error("That change was refused", error instanceof Error ? error.message : undefined);
    }
  };

  if (reviewers === null) return <p className="text-[11px] text-fg-dim">Loading the reviewer settings…</p>;

  return (
    <div>
      <p className="mb-3 text-[11px] leading-5 text-fg-dim">
        When a run ends and the app has no first-hand account of what happened, it can send a second,
        read-only agent to look at the tree and say whether the work is actually there. Each situation is
        answered on its own — including whether a verdict is allowed to close a work item without you.
      </p>
      {reviewers.map((config) => (
        <Row
          key={config.trigger}
          config={config}
          onSave={(patch) => act(workspaceApi.patchReviewer(SERVER_URL, config.trigger, patch), `${REVIEW_TRIGGER_LABEL[config.trigger]} updated`)}
          onReset={() => act(workspaceApi.resetReviewer(SERVER_URL, config.trigger), `${config.trigger} back to its default`)}
        />
      ))}
      <p className="mt-3 border-t border-line pt-2 text-[11px] leading-5 text-fg-dim">{WHY_NO_BLOCKED}</p>
    </div>
  );
}

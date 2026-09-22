"use client";

/**
 * Why a work item is showing what it is showing.
 *
 * This is the panel the whole status redesign exists to make possible. Before
 * it, a red badge was an assertion the operator had to take on faith: the app
 * could say FAILED without anything having decided that, and there was nowhere
 * to look. Now every change records what caused it, which rule decided, and
 * what backed the decision — so the badge is the start of an answer rather than
 * the end of one.
 *
 * Nothing here is inferred at render time. Every line is read from the ledger
 * row written in the same transaction as the status. If a field is missing it
 * is left out rather than guessed at; a plausible-looking reconstruction is
 * exactly the thing that made the old behaviour untrustworthy.
 */

import { describeTrigger, statusDefinition, STEP_TRANSITIONS } from "@agent-console/shared";
import type { OperationsPrompt, PromptStatusEvent, StatusDefinition } from "@agent-console/shared";
import { StatusIcon } from "@/components/pipeline/StatusIcon";
import { Badge } from "@/components/ui/Badge";

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString("en-GB", { hour12: false });
}

/** Evidence is free-form JSON; render it as plain pairs rather than guessing a shape. */
function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(([, value]) => value !== null && value !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-[11px] sm:grid-cols-[max-content_minmax(0,1fr)]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-fg-dim">{key}</dt>
          <dd className="break-words text-fg-muted">
            {typeof value === "object" ? JSON.stringify(value) : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WhyThisStatus({
  item,
  events,
  catalog,
  triggerSentences,
}: {
  item: OperationsPrompt;
  /** Newest first, as the API returns them. */
  events: PromptStatusEvent[];
  catalog: readonly StatusDefinition[];
  triggerSentences: Record<string, string>;
}) {
  const definition = statusDefinition(catalog, item.operationalState);
  // The newest ledger row is the one that put it here. An overlay (a live
  // process, an unmet prerequisite) has no ledger row of its own, so the last
  // stored change is still the honest answer to "how did it get to this point".
  const latest = events[0] ?? null;
  const rule = latest?.ruleId == null
    ? null
    : STEP_TRANSITIONS.find((row) => row.id === latest.ruleId) ?? null;
  const sentence = describeTrigger(latest?.trigger ?? null, triggerSentences);

  return (
    <section className="rounded border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={definition.tone} dot pulse={item.operationalState === "WORKING"}>
          <StatusIcon icon={definition.icon} className="mr-1" />
          {definition.label}
        </Badge>
        <span className="text-[11px] text-fg-muted">{definition.description}</span>
      </div>

      {!definition.storable && (
        <p className="mt-2 text-[11px] text-fg-dim">
          This is a live state, worked out from what is true right now rather than stored. The change
          below is the last one actually recorded against this work item.
        </p>
      )}

      {latest === null ? (
        <p className="mt-2 text-[11px] text-fg-dim">
          Nothing has changed this work item’s status yet.
        </p>
      ) : (
        <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-fg-dim">Because</dt>
          <dd className="text-fg">
            {sentence ?? latest.reason}
            {latest.previousStatus !== latest.newStatus && (
              <span className="ml-2 text-fg-dim">
                {statusDefinition(catalog, latest.previousStatus).label} →{" "}
                {statusDefinition(catalog, latest.newStatus).label}
              </span>
            )}
          </dd>

          <dt className="text-fg-dim">Set by</dt>
          <dd className="text-fg-muted">
            {latest.actorType === "AGENT" ? "the agent, through the database API"
              : latest.actorType === "USER" ? "you"
              : latest.actorType === "IMPORT" ? "an import"
              : "the pipeline"}
            <span className="text-fg-dim"> · {when(latest.createdAt)}</span>
          </dd>

          {rule !== null && (
            <>
              <dt className="text-fg-dim">Deciding rule</dt>
              <dd className="text-fg-muted">
                <code className="text-[10px] text-fg-dim">{rule.id}</code>
                <span className="ml-2">{rule.because}</span>
              </dd>
            </>
          )}

          {latest.reason !== "" && sentence !== null && sentence !== latest.reason && (
            <>
              <dt className="text-fg-dim">Detail</dt>
              <dd className="break-words text-fg-muted">{latest.reason}</dd>
            </>
          )}

          {latest.verificationSummary !== "" && (
            <>
              <dt className="text-fg-dim">Evidence given</dt>
              <dd className="break-words text-fg-muted">{latest.verificationSummary}</dd>
            </>
          )}
        </dl>
      )}

      {latest?.evidence != null && (
        <div className="mt-2">
          <div className="text-[11px] text-fg-dim">What backs this</div>
          <Evidence evidence={latest.evidence} />
        </div>
      )}

      {events.length > 1 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="text-[11px] text-fg-dim">How it got here</div>
          <ol className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            {[...events].reverse().map((event, index) => (
              <li key={event.id} className="flex items-center gap-1">
                {index > 0 && <span className="text-fg-dim/50">→</span>}
                <span
                  className="text-fg-muted"
                  title={`${describeTrigger(event.trigger, triggerSentences) ?? event.reason} · ${when(event.createdAt)}`}
                >
                  {statusDefinition(catalog, event.newStatus).shortLabel}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

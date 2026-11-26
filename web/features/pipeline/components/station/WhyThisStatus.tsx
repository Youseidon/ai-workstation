"use client";

import { describeTrigger, statusDefinition, STEP_TRANSITIONS } from "@hydra/shared";
import type { OperationsPrompt, PromptStatusEvent, StatusDefinition } from "@hydra/shared";
import { StatusIcon } from "@/features/pipeline/components/StatusIcon";
import { Badge } from "@/components/ui/Badge";

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString("en-GB", { hour12: false });
}

function Evidence({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence).filter(([, value]) => value !== null && value !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
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
  events: PromptStatusEvent[];
  catalog: readonly StatusDefinition[];
  triggerSentences: Record<string, string>;
}) {
  const definition = statusDefinition(catalog, item.operationalState);
  const latest = events[0] ?? null;
  const rule = latest?.ruleId == null
    ? null
    : STEP_TRANSITIONS.find((row) => row.id === latest.ruleId) ?? null;
  const sentence = describeTrigger(latest?.trigger ?? null, triggerSentences);

  return (
    <section className="rounded border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={definition.tone} dot pulse={item.operationalState === "WORKING"}>
          <StatusIcon icon={definition.icon} className="mr-1" />
          {definition.label}
        </Badge>
        <span className="text-xs text-fg-muted">{definition.description}</span>
      </div>

      {!definition.storable && (
        <p className="mt-2 text-xs text-fg-dim">
          This is a live state, worked out from what is true right now rather than stored. The change
          below is the last one actually recorded against this work item.
        </p>
      )}

      {latest === null ? (
        <p className="mt-2 text-xs text-fg-dim">
          Nothing has changed this work item’s status yet.
        </p>
      ) : (
        <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
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
                <code className="text-xs text-fg-dim">{rule.id}</code>
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
          <div className="text-xs text-fg-dim">What backs this</div>
          <Evidence evidence={latest.evidence} />
        </div>
      )}

      {events.length > 1 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="text-xs text-fg-dim">How it got here</div>
          <ol className="mt-1 flex flex-wrap items-center gap-1 text-xs">
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

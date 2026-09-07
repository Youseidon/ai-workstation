"use client";

import { DefinitionOfDonePanel } from "./DefinitionOfDonePanel";
import { StatusCatalogPanel } from "./StatusCatalogPanel";
import type { PipelinePolicy, ProviderId, RuleContext, RulePolicy, TransitionRow } from "@agent-console/shared";
import { COOLING_MINUTES, TRANSIENT_PATTERNS } from "@agent-console/shared";
import { Modal } from "@/components/ui/Modal";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { CONTROL_LABEL, TRANSITIONS, type PipelineStatusView } from "./status";
import { SuiteFallbackEditor } from "./SuiteFallbackEditor";

/**
 * The interlocking, rendered.
 *
 * Every row here is read straight out of the shared rule table — the same array
 * the status bar matches against and the tests enumerate. That is the point: if
 * this panel and the buttons ever disagreed, one of them would be lying, and
 * the operator would have no way to tell which.
 */
export function RulesPanel({
  open,
  onClose,
  status,
  policy,
  station,
  onEditStationRule,
  onEditPolicy,
  onStatusesChanged,
  suiteId,
  pipelineId,
  suiteFallbackProviders = [],
  onSuiteFallbacksChanged,
}: {
  open: boolean;
  onClose(): void;
  status: PipelineStatusView;
  policy: PipelinePolicy;
  /** Where the run sits, for the "right now" summary. */
  station: string | null;
  /** Opens the current station's rule editor; omitted when there is no station. */
  onEditStationRule?(): void;
  /** Opens the Pipeline policy form, so a setting is changed where it is read. */
  onEditPolicy?(): void;
  /** Re-read the board after a status is renamed, so the change shows at once. */
  onStatusesChanged?(): void;
  /**
   * The suite the board is showing, for its definition of done. Omitted when
   * the board is not on one, in which case the section is left out rather than
   * shown editing nothing.
   */
  suiteId?: number | null;
  /** Named pipeline that owns the stage; required to PATCH suite fallbacks. */
  pipelineId?: number | null;
  /** Suite-level ordered fallbacks; empty means house default. */
  suiteFallbackProviders?: ProviderId[];
  onSuiteFallbacksChanged?(): void;
}) {
  const controls = [
    ...(status.primary === null ? [] : [{ control: status.primary, primary: true }]),
    ...status.secondary.map((control) => ({ control, primary: false })),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="What decides these buttons"
      description="One table decides which controls a run offers. The row you are on is highlighted."
    >
      <section className="space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-dim">Right now</h3>
        <dl className="space-y-2.5">
          <Line term="State">
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={status.tone} pulse={status.pulse} size={7} />
              <span className="font-medium text-fg">{status.label}</span>
              {station !== null && <span className="text-fg-dim">· {station}</span>}
            </span>
            <p className="mt-1 text-fg-muted">{status.headline}</p>
          </Line>
          <Line term="Because">{status.because}</Line>
          {controls.map(({ control, primary }) => (
            <Line key={control} term={CONTROL_LABEL[control]}>
              {primary ? (status.hint ?? "Continues the run from here.") : secondaryHint(control)}
            </Line>
          ))}
        </dl>
      </section>

      <section className="mt-6 space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-dim">Every state</h3>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <Th>When the run is</Th>
                <Th>You get</Th>
                <Th>Set by</Th>
              </tr>
            </thead>
            <tbody>
              {TRANSITIONS.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  here={row.id === status.rowId}
                  onEditStationRule={onEditStationRule}
                  onEditPolicy={onEditPolicy}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] leading-5 text-fg-dim">
          Pause is currently{" "}
          <span className="text-fg-muted">
            {policy.pauseMode === "immediate" ? "immediate" : "graceful"}
          </span>{" "}
          and Stop{" "}
          <span className="text-fg-muted">
            {policy.stopInterruptsAgent ? "interrupts" : "does not interrupt"}
          </span>{" "}
          the running agent. A station that does not finish is continued up to{" "}
          <span className="text-fg-muted">{policy.maxContinuations}</span>
          {policy.reviewAfterContinuations
            ? ", then a read-only reviewer is sent before the rail parks."
            : ", then the rail parks."}
          {" "}House fallbacks:{" "}
          <span className="text-fg-muted">
            {policy.fallbackProviders.length > 0 ? policy.fallbackProviders.join(" → ") : "none"}
          </span>
          .
        </p>
      </section>

      <section className="mt-6 space-y-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-dim">
          Provider fallbacks
        </h3>
        <p className="text-[11px] leading-5 text-fg-dim">
          When an agent cannot start or dies before doing any work for a reason that says nothing
          about the work, the station is started on the next provider in its fallback list. That
          does not consume a continuation. The failing provider cools for a few minutes.
        </p>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[28rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <Th>Id</Th>
                <Th>Because</Th>
                <Th>Cooling</Th>
              </tr>
            </thead>
            <tbody>
              {TRANSIENT_PATTERNS.map((row) => (
                <tr key={row.id} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2 font-mono text-[11px] text-fg">{row.id}</td>
                  <td className="px-3 py-2 text-fg-muted">{row.because}</td>
                  <td className="px-3 py-2 text-fg-dim">{COOLING_MINUTES[row.id] ?? 5} min</td>
                </tr>
              ))}
              <tr className="border-b border-line/60 last:border-b-0">
                <td className="px-3 py-2 font-mono text-[11px] text-fg">start_failed</td>
                <td className="px-3 py-2 text-fg-muted">The agent process failed to start.</td>
                <td className="px-3 py-2 text-fg-dim">{COOLING_MINUTES.start_failed} min</td>
              </tr>
              <tr className="border-b border-line/60 last:border-b-0">
                <td className="px-3 py-2 font-mono text-[11px] text-fg">died_before_work</td>
                <td className="px-3 py-2 text-fg-muted">
                  The agent never made a tool call, so nothing about the work was learned.
                </td>
                <td className="px-3 py-2 text-fg-dim">{COOLING_MINUTES.died_before_work} min</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* The states themselves, editable. Kept in the same dialog as the rule
          table because they are one subject: the table decides which state a run
          lands in, and this decides what that state is called and what it does. */}
      <section className="mt-6 border-t border-line pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
          Every status
        </h3>
        <div className="mt-2">
          <StatusCatalogPanel onChanged={onStatusesChanged} />
        </div>
      </section>

      {suiteId != null && (
        <section className="mt-6 border-t border-line pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
            This suite&rsquo;s provider fallbacks
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-fg-dim">
            Used when a station leaves its own list empty. Empty here means the house default (
            {policy.fallbackProviders.join(" → ") || "none"}).
          </p>
          <div className="mt-2">
            {pipelineId != null && (
              <SuiteFallbackEditor
                pipelineId={pipelineId}
                suiteId={suiteId}
                value={suiteFallbackProviders}
                onChanged={onSuiteFallbacksChanged}
              />
            )}
          </div>
        </section>
      )}

      {suiteId != null && (
        <section className="mt-6 border-t border-line pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
            This suite&rsquo;s definition of done
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-fg-dim">
            Inherited by every work item in the suite that has not written its own. A single item can
            still say something different on its own detail panel.
          </p>
          <div className="mt-2">
            <DefinitionOfDonePanel scope="suite" scopeId={suiteId} />
          </div>
        </section>
      )}
    </Modal>
  );
}

function Line({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim sm:pt-[3px]">
        {term}
      </dt>
      <dd className="min-w-0 text-[13px] leading-5 text-fg-muted">{children}</dd>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim">
      {children}
    </th>
  );
}

function Row({
  row,
  here,
  onEditStationRule,
  onEditPolicy,
}: {
  row: TransitionRow;
  here: boolean;
  onEditStationRule?(): void;
  onEditPolicy?(): void;
}) {
  const controls = [
    ...(row.primary === null ? [] : [row.primary]),
    ...row.secondary,
  ].map((control) => CONTROL_LABEL[control]);

  return (
    <tr
      className={cn(
        "border-b border-line/60 last:border-b-0",
        here && "bg-accent/[0.07]",
      )}
    >
      <td
        className={cn(
          "border-l-2 px-3 py-2 align-top",
          here ? "border-l-accent text-fg" : "border-l-transparent text-fg-muted",
        )}
      >
        {row.condition}
        {here && (
          <span className="ml-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
            you are here
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-fg-muted">{controls.join(" · ") || "—"}</td>
      <td className="px-3 py-2 align-top">
        <SetBy policy={row.policy} onEditStationRule={onEditStationRule} onEditPolicy={onEditPolicy} />
      </td>
    </tr>
  );
}

/**
 * A locked row explains itself rather than showing nothing — "no control here"
 * and "a control you are not allowed to change" look identical otherwise.
 */
function SetBy({
  policy,
  onEditStationRule,
  onEditPolicy,
}: {
  policy: RulePolicy;
  onEditStationRule?(): void;
  onEditPolicy?(): void;
}) {
  if (policy.kind === "setting") {
    if (onEditPolicy === undefined) {
      return <span title={policy.reason} className="text-fg-muted">Pipeline policy</span>;
    }
    return (
      <button
        type="button"
        title={policy.reason}
        onClick={onEditPolicy}
        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        Pipeline policy
      </button>
    );
  }
  if (policy.kind === "stationRule") {
    const label = policy.field === "onDone" ? "This station's “on done”" : "This station's “on unfinished”";
    if (onEditStationRule === undefined) {
      return <span title={policy.reason} className="text-fg-muted">{label}</span>;
    }
    return (
      <button
        type="button"
        title={policy.reason}
        onClick={onEditStationRule}
        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {label}
      </button>
    );
  }
  return (
    <span title={policy.reason} className="cursor-help text-fg-dim underline decoration-dotted underline-offset-2">
      Fixed
    </span>
  );
}

function secondaryHint(control: string): string {
  if (control === "stop") return "Ends the run. Finished stations are kept; a new run picks up the rest.";
  if (control === "newRun") return "Starts a fresh run from the first unfinished station.";
  if (control === "pause") return "Holds the rail without ending the run.";
  return "Continues the run from here.";
}

/** Exported for tests: the context shape the panel's summary reads. */
export type RulesPanelContext = RuleContext;

"use client";

import type { PipelinePolicy, RuleContext, RulePolicy, TransitionRow } from "@agent-console/shared";
import { Modal } from "@/components/ui/Modal";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { CONTROL_LABEL, TRANSITIONS, type PipelineStatusView } from "./status";

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
          the running agent. Handoffs are offered{" "}
          <span className="text-fg-muted">{requirementPhrase(policy)}</span>.
        </p>
      </section>
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
    const label = policy.field === "onDone" ? "This station's “on done”" : "This station's “on blocked”";
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

function requirementPhrase(policy: PipelinePolicy): string {
  if (policy.handoffRequirement === "always") return "before every resume";
  if (policy.handoffRequirement === "never") return "never";
  return "when the previous run produced work";
}

/** Exported for tests: the context shape the panel's summary reads. */
export type RulesPanelContext = RuleContext;

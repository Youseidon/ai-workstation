"use client";

import { useState, type ReactNode } from "react";
import type { PipelinePolicy, RulePolicy, TransitionRow } from "@hydra/shared";
import { COOLING_MINUTES, TRANSIENT_PATTERNS } from "@hydra/shared";
import { SettingsGroupPanel } from "@/features/settings/components/SettingsGroupPanel";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { PIPELINE_POLICY_GROUP, RUN_BUDGETS_GROUP } from "@/features/settings/lib/settingsGroups";
import { DefinitionOfDonePanel } from "./DefinitionOfDonePanel";
import { StatusCatalogPanel } from "./StatusCatalogPanel";
import { CONTROL_LABEL, TRANSITIONS, type PipelineStatusView } from "../lib/status";

export type InspectorTab = "station" | "history" | "verification" | "policy" | "budgets" | "statuses" | "definition";

export type RulesSection = "policy" | "budgets" | "statuses" | "definition";

export function PipelineInspector({
  section,
  status,
  policy,
  stationLabel,
  suiteId,
  onStatusesChanged,
  onSettingsSaved,
  onEditStationFromSummary,
  onEditAgents,
}: {
  section: RulesSection;
  status: PipelineStatusView;
  policy: PipelinePolicy;
  stationLabel: string | null;
  suiteId?: number | null;
  onStatusesChanged?(): void;
  onSettingsSaved?(): void;
  onEditStationFromSummary?(): void;
  onEditAgents?(): void;
}) {
  const [showTransitions, setShowTransitions] = useState(false);

  if (section === "policy") {
    return (
      <div className="space-y-6">
        <RightNowSummary status={status} station={stationLabel} policy={policy} onEditStation={onEditStationFromSummary} />
        <section className="studio-card space-y-2">
          <h3 className="text-sm font-semibold text-fg">House pipeline policy</h3>
          <SettingsGroupPanel group={PIPELINE_POLICY_GROUP} onSaved={onSettingsSaved} compact />
        </section>
        <section className="studio-card space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-fg">Every state</h3>
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowTransitions((value) => !value)}>
              {showTransitions ? "Hide table" : "Show table"}
            </button>
          </div>
          {showTransitions && <TransitionsTable status={status} onEditStationRule={onEditStationFromSummary} />}
          <FallbacksReference onEditAgents={onEditAgents} />
        </section>
      </div>
    );
  }

  if (section === "budgets") {
    return (
      <section className="studio-card">
        <SettingsGroupPanel group={RUN_BUDGETS_GROUP} onSaved={onSettingsSaved} compact />
      </section>
    );
  }

  if (section === "statuses") {
    return (
      <section className="studio-card space-y-2">
        <p className="text-xs leading-5 text-fg-dim">Labels, tones, and enter behaviour for every status the board can show.</p>
        <StatusCatalogPanel onChanged={onStatusesChanged} />
      </section>
    );
  }

  return suiteId == null ? (
    <EmptyTab title="No suite selected" body="Select a suite on the board to edit its definition of done." />
  ) : (
    <section className="studio-card space-y-2">
      <p className="text-xs leading-5 text-fg-dim">Inherited by every work item in the suite that has not written its own.</p>
      <DefinitionOfDonePanel scope="suite" scopeId={suiteId} />
    </section>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-panel border border-dashed border-line bg-surface-2 px-3 py-6 text-center">
      <p className="text-sm text-fg">{title}</p>
      <p className="mt-1 text-xs leading-5 text-fg-dim">{body}</p>
    </div>
  );
}

export function RightNowSummary({
  status,
  station,
  policy,
  onEditStation,
  onEditPolicy,
}: {
  status: PipelineStatusView;
  station: string | null;
  policy: PipelinePolicy;
  onEditStation?(): void;
  onEditPolicy?(): void;
}) {
  const controls = [
    ...(status.primary === null ? [] : [{ control: status.primary, primary: true }]),
    ...status.secondary.map((control) => ({ control, primary: false })),
  ];

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface-2 p-3">
      <h3 className="text-xs font-medium uppercase tracking-[0.16em] text-fg-dim">Right now</h3>
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
      <p className="text-xs leading-5 text-fg-dim">
        Pause is{" "}
        <button type="button" className="text-accent hover:underline" onClick={onEditPolicy}>
          {policy.pauseMode === "immediate" ? "immediate" : "graceful"}
        </button>
        ; Stop{" "}
        <button type="button" className="text-accent hover:underline" onClick={onEditPolicy}>
          {policy.stopInterruptsAgent ? "interrupts" : "does not interrupt"}
        </button>
        . Continuations up to{" "}
        <button type="button" className="text-accent hover:underline" onClick={onEditPolicy}>
          {policy.maxContinuations}
        </button>
        {policy.reviewAfterContinuations ? ", then a reviewer runs." : ", then the rail parks."}
        {onEditStation !== undefined && (
          <>
            {" "}
            <button type="button" className="text-accent hover:underline" onClick={onEditStation}>
              Edit this station
            </button>
            .
          </>
        )}
      </p>
    </section>
  );
}

function TransitionsTable({
  status,
  onEditStationRule,
  onEditPolicy,
}: {
  status: PipelineStatusView;
  onEditStationRule?(): void;
  onEditPolicy?(): void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[20rem] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-line bg-surface-2">
            <Th>When</Th>
            <Th>You get</Th>
            <Th>Set by</Th>
          </tr>
        </thead>
        <tbody>
          {TRANSITIONS.map((row) => (
            <TransitionRowView
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
  );
}

function FallbacksReference({ onEditAgents }: { onEditAgents?(): void }) {
  return (
    <div className="space-y-2 pt-2">
      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-dim">
        Transient failure cooling
      </h4>
      <p className="text-xs leading-5 text-fg-dim">Reported account reset times take precedence. Quota errors naming a five-hour or weekly cap use that window when no reset time is available. Automatic reassignment and the suite fallback order are set per pipeline in{" "}
        {onEditAgents === undefined ? "Suite agents" : <button type="button" className="text-accent hover:underline" onClick={onEditAgents}>Suite agents</button>}.</p>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[16rem] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              <Th>Id</Th>
              <Th>Cooling</Th>
            </tr>
          </thead>
          <tbody>
            {TRANSIENT_PATTERNS.map((row) => (
              <tr key={row.id} className="border-b border-line/60 last:border-b-0">
                <td className="px-2 py-1.5 font-mono text-xs text-fg">{row.id}</td>
                <td className="px-2 py-1.5 text-fg-dim">{COOLING_MINUTES[row.id] ?? 5} min</td>
              </tr>
            ))}
            <tr className="border-b border-line/60 last:border-b-0">
              <td className="px-2 py-1.5 font-mono text-xs text-fg">start_failed</td>
              <td className="px-2 py-1.5 text-fg-dim">{COOLING_MINUTES.start_failed} min</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5 font-mono text-xs text-fg">died_before_work</td>
              <td className="px-2 py-1.5 text-fg-dim">{COOLING_MINUTES.died_before_work} min</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransitionRowView({
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
  const controls = [...(row.primary === null ? [] : [row.primary]), ...row.secondary].map(
    (control) => CONTROL_LABEL[control],
  );

  return (
    <tr className={cn("border-b border-line/60 last:border-b-0", here && "bg-accent/[0.07]")}>
      <td
        className={cn(
          "border-l-2 px-2 py-1.5 align-top",
          here ? "border-l-accent text-fg" : "border-l-transparent text-fg-muted",
        )}
      >
        {row.condition}
        {here && (
          <span className="ml-1 text-xs font-semibold uppercase tracking-[0.1em] text-accent">
            here
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 align-top text-fg-muted">{controls.join(" · ") || "—"}</td>
      <td className="px-2 py-1.5 align-top">
        <SetBy policy={row.policy} onEditStationRule={onEditStationRule} onEditPolicy={onEditPolicy} />
      </td>
    </tr>
  );
}

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
      return (
        <span title={policy.reason} className="text-fg-muted">
          Pipeline policy
        </span>
      );
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
    const label = policy.field === "onDone" ? "On done" : "On unfinished";
    if (onEditStationRule === undefined) {
      return (
        <span title={policy.reason} className="text-fg-muted">
          {label}
        </span>
      );
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
    <span
      title={policy.reason}
      className="cursor-help text-fg-dim underline decoration-dotted underline-offset-2"
    >
      Fixed
    </span>
  );
}

function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-dim">{term}</dt>
      <dd className="min-w-0 text-xs leading-5 text-fg-muted">{children}</dd>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-fg-dim">
      {children}
    </th>
  );
}

function secondaryHint(control: string): string {
  if (control === "stop") return "Ends the run. Finished stations are kept; a new run picks up the rest.";
  if (control === "newRun") return "Starts a fresh run from the first unfinished station.";
  if (control === "pause") return "Holds the rail without ending the run.";
  return "Continues the run from here.";
}

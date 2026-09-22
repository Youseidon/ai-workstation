"use client";

import { useState, type ReactNode } from "react";
import type {
  OperationsPrompt,
  PipelinePolicy,
  PromptPipelineRule,
  ProviderId,
  RulePolicy,
  TransitionRow,
} from "@agent-console/shared";
import { COOLING_MINUTES, TRANSIENT_PATTERNS } from "@agent-console/shared";
import { SettingsGroupPanel } from "@/components/SettingsGroupPanel";
import { StatusDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { PIPELINE_POLICY_GROUP, RUN_BUDGETS_GROUP } from "@/lib/settingsGroups";
import { useModelSelection } from "@/lib/useModelSelection";
import { DefinitionOfDonePanel } from "./DefinitionOfDonePanel";
import { StatusCatalogPanel } from "./StatusCatalogPanel";
import { StepConfigForm } from "./StepConfigForm";
import { SuiteFallbackEditor } from "./SuiteFallbackEditor";
import { CONTROL_LABEL, TRANSITIONS, type PipelineStatusView } from "./status";

export type InspectorTab = "station" | "policy" | "budgets" | "statuses" | "definition";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "station", label: "Station" },
  { id: "policy", label: "Policy" },
  { id: "budgets", label: "Budgets" },
  { id: "statuses", label: "Statuses" },
  { id: "definition", label: "Definition" },
];

/**
 * Right-hand config drawer for the pipeline board. One tab per concern so
 * operators are not dropped into a single mega-form.
 */
export function PipelineInspector({
  open,
  tab,
  onTabChange,
  onClose,
  status,
  policy,
  stationLabel,
  suiteId,
  pipelineId,
  suiteFallbackProviders = [],
  onSuiteFallbacksChanged,
  onStatusesChanged,
  onSettingsSaved,
  onEditStationFromSummary,
  station,
}: {
  open: boolean;
  tab: InspectorTab;
  onTabChange(tab: InspectorTab): void;
  onClose(): void;
  status: PipelineStatusView;
  policy: PipelinePolicy;
  stationLabel: string | null;
  suiteId?: number | null;
  pipelineId?: number | null;
  suiteFallbackProviders?: ProviderId[];
  onSuiteFallbacksChanged?(): void;
  onStatusesChanged?(): void;
  onSettingsSaved?(): void;
  /** Jump from the transitions table into the station editor. */
  onEditStationFromSummary?(): void;
  station: null | {
    rule: PromptPipelineRule;
    item: OperationsPrompt;
    subStep: boolean;
    inherited: boolean;
    providers: Parameters<typeof useModelSelection>[0];
    models: ReturnType<typeof useModelSelection>;
    onUseStationSettings?(): void;
    onChange(patch: Partial<Omit<PromptPipelineRule, "promptId">>): void;
  };
}) {
  const [showTransitions, setShowTransitions] = useState(false);

  if (!open) return null;

  return (
    <aside
      className="flex min-h-0 w-full flex-col border-t border-line bg-surface-1 xl:w-[360px] xl:border-t-0 xl:border-l"
      aria-label="Pipeline configuration"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">Configure</div>
          <div className="text-[13px] text-fg">Pipeline settings</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close configuration">
          Close
        </Button>
      </div>

      <div className="flex gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => onTabChange(entry.id)}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors",
              tab === entry.id ? "bg-surface-3 text-fg" : "text-fg-dim hover:bg-surface-2 hover:text-fg",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "station" && (
          station === null ? (
            <EmptyTab
              title="No station selected"
              body="Click Configure on a station card to edit its agent, outcomes, and fallbacks here."
            />
          ) : (
            <StepConfigForm
              rule={station.rule}
              item={station.item}
              subStep={station.subStep}
              inherited={station.inherited}
              providers={station.providers}
              models={station.models}
              policy={policy}
              onUseStationSettings={station.onUseStationSettings}
              onChange={station.onChange}
            />
          )
        )}

        {tab === "policy" && (
          <div className="space-y-6">
            <RightNowSummary
              status={status}
              station={stationLabel}
              policy={policy}
              onEditStation={onEditStationFromSummary}
              onEditPolicy={() => onTabChange("policy")}
            />

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
                House pipeline policy
              </h3>
              <SettingsGroupPanel group={PIPELINE_POLICY_GROUP} onSaved={onSettingsSaved} compact />
            </section>

            {suiteId != null && pipelineId != null && (
              <section className="space-y-2 border-t border-line pt-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
                  Suite provider fallbacks
                </h3>
                <p className="text-[11px] leading-5 text-fg-dim">
                  Used when a station leaves its own list empty. Empty here means the house default (
                  {policy.fallbackProviders.join(" → ") || "none"}).
                </p>
                <SuiteFallbackEditor
                  pipelineId={pipelineId}
                  suiteId={suiteId}
                  value={suiteFallbackProviders}
                  onChanged={onSuiteFallbacksChanged}
                />
              </section>
            )}

            <section className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-dim">
                  Every state
                </h3>
                <button
                  type="button"
                  className="text-[11px] text-accent hover:underline"
                  onClick={() => setShowTransitions((value) => !value)}
                >
                  {showTransitions ? "Hide table" : "Show table"}
                </button>
              </div>
              {showTransitions && (
                <TransitionsTable
                  status={status}
                  onEditStationRule={onEditStationFromSummary}
                  onEditPolicy={() => onTabChange("policy")}
                />
              )}
              <FallbacksReference />
            </section>
          </div>
        )}

        {tab === "budgets" && (
          <SettingsGroupPanel group={RUN_BUDGETS_GROUP} onSaved={onSettingsSaved} compact />
        )}

        {tab === "statuses" && (
          <div className="space-y-2">
            <p className="text-[11px] leading-5 text-fg-dim">
              Labels, tones, and enter behaviour for every status the board can show.
            </p>
            <StatusCatalogPanel onChanged={onStatusesChanged} />
          </div>
        )}

        {tab === "definition" && (
          suiteId == null ? (
            <EmptyTab
              title="No suite selected"
              body="Select a suite on the constellation to edit its definition of done."
            />
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] leading-5 text-fg-dim">
                Inherited by every work item in the suite that has not written its own.
              </p>
              <DefinitionOfDonePanel scope="suite" scopeId={suiteId} />
            </div>
          )
        )}
      </div>
    </aside>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-panel border border-dashed border-line bg-surface-2/50 px-3 py-6 text-center">
      <p className="text-sm text-fg">{title}</p>
      <p className="mt-1 text-[11px] leading-5 text-fg-dim">{body}</p>
    </div>
  );
}

function RightNowSummary({
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
    <section className="space-y-3 rounded-panel border border-line bg-surface-2/60 p-3">
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
      <p className="text-[11px] leading-5 text-fg-dim">
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

function FallbacksReference() {
  return (
    <div className="space-y-2 pt-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim">
        Transient failure cooling
      </h4>
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
                <td className="px-2 py-1.5 font-mono text-[11px] text-fg">{row.id}</td>
                <td className="px-2 py-1.5 text-fg-dim">{COOLING_MINUTES[row.id] ?? 5} min</td>
              </tr>
            ))}
            <tr className="border-b border-line/60 last:border-b-0">
              <td className="px-2 py-1.5 font-mono text-[11px] text-fg">start_failed</td>
              <td className="px-2 py-1.5 text-fg-dim">{COOLING_MINUTES.start_failed} min</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5 font-mono text-[11px] text-fg">died_before_work</td>
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
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
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
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim">{term}</dt>
      <dd className="min-w-0 text-[12px] leading-5 text-fg-muted">{children}</dd>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim">
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

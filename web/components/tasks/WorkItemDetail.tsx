"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { CompletionAuditRecord, OperationsPrompt, OperationsSuite, StatusDefinition } from "@agent-console/shared";
import { LogPanel } from "@/components/LogPanel";
import { LABEL, TONE } from "@/components/pipeline/status";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/Field";
import { cn } from "@/lib/cn";
import { sessionEndReason } from "@/lib/sessionEndReason";
import { applyEvent, type LogItem } from "@/lib/log";
import { DefinitionOfDonePanel } from "@/components/pipeline/DefinitionOfDonePanel";
import { WhyThisStatus } from "./WhyThisStatus";

type DetailTab = "overview" | "sessions" | "activity";

const VERDICT_TONE = {
  COMPLETE: { border: "border-success/30", bg: "bg-success/5", text: "text-success" },
  INCOMPLETE: { border: "border-warning/30", bg: "bg-warning/5", text: "text-warning" },
  UNVERIFIABLE: { border: "border-caution/30", bg: "bg-caution/10", text: "text-caution" },
} as const;

/**
 * The answer an operator comes back hours later to look for: did the agent that
 * vanished without posting a status actually finish the work? Verdict first,
 * then the checks it stands on — a verdict with no visible evidence behind it
 * is exactly the thing this feature exists to stop trusting.
 */
function CompletionAuditCard({ audit }: { audit: CompletionAuditRecord }): React.ReactElement {
  const tone = audit.verdict === null ? { border: "border-info/30", bg: "bg-info/5", text: "text-info" } : VERDICT_TONE[audit.verdict];
  return (
    <div className={cn("rounded-panel border p-4", tone.border, tone.bg)}>
      <div className={cn("text-[10px] uppercase tracking-wider", tone.text)}>
        Completion audit · {audit.verdict === null ? audit.state.toLowerCase() : audit.verdict.toLowerCase()}
        {audit.applied && " · station closed"}
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        Read-only {audit.provider} check of the run that ended without posting a status
        {audit.report === null ? "" : ` · ${audit.report.confidence.toLowerCase()} confidence`}
      </div>
      {audit.report !== null && audit.report.checks.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          {audit.report.checks.slice(0, 8).map((check) => (
            <div key={check.criterion} className="flex gap-2">
              <span className={cn("shrink-0 font-mono", check.result === "PASSED" ? "text-success" : check.result === "FAILED" ? "text-danger" : "text-fg-dim")}>
                {check.result === "PASSED" ? "✓" : check.result === "FAILED" ? "✗" : "?"}
              </span>
              <span className="text-fg-muted">
                {check.criterion}
                {check.evidence === "" ? "" : <span className="text-fg-dim"> — {check.evidence}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {audit.report !== null && audit.report.remainingWork.length > 0 && (
        <div className="mt-3 text-xs">
          <div className="mb-1 text-fg-dim">Still missing</div>
          {audit.report.remainingWork.slice(0, 6).map((entry) => <div key={entry} className="text-fg-muted">• {entry}</div>)}
        </div>
      )}
      {audit.error !== null && <div className="mt-2 text-xs text-warning">{audit.error}</div>}
    </div>
  );
}

type ActivityPayload = Awaited<ReturnType<typeof import("@/lib/workspacesApi").workspaceApi.activity>>;

export function WorkItemDetail({
  suite,
  item,
  activity,
  statusCatalog,
  triggerSentences,
  response,
  busy,
  canStart,
  verifyingItem,
  connectionOpen,
  providerLabel,
  model,
  onResponseChange,
  onRun,
  onStop,
  onRecover,
  onAudit,
  onRespond,
  onComplete,
  onVerifyItem,
  onClose,
}: {
  suite: OperationsSuite | null;
  item: OperationsPrompt | null;
  activity: ActivityPayload | null;
  /** Resolved catalog from the operations snapshot, so renames show here too. */
  statusCatalog: readonly StatusDefinition[];
  triggerSentences: Record<string, string>;
  response: string;
  busy: boolean;
  canStart: boolean;
  verifyingItem: boolean;
  connectionOpen: boolean;
  providerLabel: string;
  model: string | null;
  onResponseChange(value: string): void;
  onRun(): void;
  onStop(): void;
  onRecover(): void;
  onAudit(): void;
  onRespond(): void;
  onComplete(): void;
  onVerifyItem(): void;
  onClose?(): void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [sessionId, setSessionId] = useState<string | null>(null);

  const sessions = activity !== null && item !== null && activity.item.prompt.id === item.prompt.id
    ? activity.sessions
    : [];
  const activeSessionId =
    sessions.some((entry) => entry.id === sessionId) ? sessionId : sessions[0]?.id ?? null;
  const selectedSession = sessions.find((entry) => entry.id === activeSessionId) ?? null;

  const logs = useMemo<LogItem[]>(
    () => selectedSession?.events.reduce<LogItem[]>((items, event) => applyEvent(items, event), []) ?? [],
    [selectedSession],
  );

  const timeline = useMemo(() => {
    if (activity === null || item === null || activity.item.prompt.id !== item.prompt.id) return [];
    return [
      ...activity.remarks.map((entry) => ({
        id: `r${entry.id}`,
        at: entry.createdAt,
        label: `${entry.actorType} · ${entry.kind}`,
        text: entry.content,
        tone:
          entry.kind === "BLOCKER" || entry.kind === "DECISION_NEEDED"
            ? "border-warning/50"
            : entry.kind === "HUMAN_RESPONSE"
              ? "border-info/50"
              : "border-line",
      })),
      ...activity.events.map((entry) => ({
        id: `e${entry.id}`,
        at: entry.createdAt,
        label: `${entry.actorType} · ${entry.previousStatus} → ${entry.newStatus}`,
        text: [entry.reason, entry.verificationSummary].filter(Boolean).join("\n\n"),
        tone: "border-line",
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }, [activity, item]);

  if (item === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-fg-dim">
        Select a work item to inspect its overview, sessions, and activity.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Badge tone={TONE[item.operationalState]} dot pulse={item.operationalState === "WORKING"}>
              {LABEL[item.operationalState]}
            </Badge>
            <h2 className="mt-1.5 truncate text-base text-fg">
              {item.prompt.externalKey !== null && (
                <span className="text-fg-muted">{item.prompt.externalKey} — </span>
              )}
              {item.prompt.title}
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-fg-dim">
              {item.workspace.name} · {item.prompt.programName} / {item.prompt.suiteName}
            </p>
          </div>
          {onClose !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              className="xl:hidden"
              onClick={onClose}
              aria-label="Close detail"
            >
              ✕
            </Button>
          )}
        </div>

        <div className="mt-3 flex rounded-md bg-surface-2 p-0.5 text-[10px] ring-1 ring-inset ring-line">
          {(
            [
              ["overview", "Overview"],
              ["sessions", `Sessions · ${sessions.length}`],
              ["activity", `Activity · ${timeline.length}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? "true" : undefined}
              className={cn(
                "flex-1 rounded px-2 py-1.5 transition-colors",
                tab === id ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" && (
          <div className="space-y-4">
            {item.latestAudit !== null && <CompletionAuditCard audit={item.latestAudit} />}
            {/* The answer to "why is it showing this", from the ledger rather
                than reconstructed at render time. First thing in the overview
                because it is the first thing an operator asks of a status they
                do not trust. */}
            <WhyThisStatus
              item={item}
              events={activity !== null && activity.item.prompt.id === item.prompt.id ? activity.events : []}
              catalog={statusCatalog}
              triggerSentences={triggerSentences}
            />

            {/* What this item has to satisfy before it closes, and where each
                criterion currently stands. Directly under "why this status"
                because when the answer up there is "a criterion did not pass",
                this is the next thing the operator wants. */}
            <DefinitionOfDonePanel scope="prompt" scopeId={item.prompt.id} promptId={item.prompt.id} />

            <div className="flex flex-wrap gap-2">
              {item.operationalState === "READY" && (
                <Button size="sm" variant="success" disabled={!canStart || busy} onClick={onRun}>
                  Run work item
                </Button>
              )}
              {item.operationalState === "RECOVERY_NEEDED" && (
                <>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={onRecover}>
                    Recover and resume
                  </Button>
                  {/* Recovering re-runs the work. Ask first whether it needs re-running. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={onAudit}
                    title="Send a read-only agent to check whether the work was already finished"
                  >
                    Audit what the run left
                  </Button>
                </>
              )}
              {item.operationalState === "WORKING" && item.prompt.currentRun !== null && (
                <Button size="sm" variant="danger" disabled={busy} onClick={onStop}>
                  Stop agent
                </Button>
              )}
              {suite !== null && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!connectionOpen || busy}
                  loading={verifyingItem}
                  onClick={onVerifyItem}
                  title={`Verify with ${providerLabel}${model === null ? "" : ` · ${model}`}`}
                >
                  Verify this work item
                </Button>
              )}
              <Link
                href={`/?workspace=${item.workspace.id}&prompt=${item.prompt.id}`}
                className="rounded-md px-3 py-1.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
              >
                Open in Chat
              </Link>
            </div>

            {item.latestIntervention !== null && (
              <div className="rounded-panel border border-warning/30 bg-warning/5 p-4">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-warning">
                  Latest intervention
                </div>
                <div className="whitespace-pre-wrap text-sm leading-6">{item.latestIntervention}</div>
              </div>
            )}

            {(item.operationalState === "BLOCKED" ||
              item.operationalState === "RECOVERY_NEEDED") && (
              <div className="rounded-panel border border-line bg-surface-1 p-4">
                <TextArea
                  label={item.operationalState === "BLOCKED" ? "Your response" : "Evidence"}
                  rows={4}
                  value={response}
                  hint={
                    item.operationalState === "BLOCKED"
                      ? "Answer the blocker, or leave blank to retry with the existing context. Configure secrets outside this box."
                      : "Paste the agent's own summary here if the work is already finished, then mark it complete."
                  }
                  placeholder="What the agent needs to know to continue…"
                  onChange={(event) => onResponseChange(event.target.value)}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {item.operationalState === "BLOCKED" && (
                    <Button variant="success" disabled={!canStart || busy} onClick={onRespond}>
                      Respond and resume
                    </Button>
                  )}
                  {/*
                    For work that is finished but whose status never landed —
                    an interrupted run, a rejected final Progress call. The box
                    above becomes the recorded verification summary, so this is
                    deliberately disabled until there is evidence to record.
                  */}
                  <Button
                    variant="secondary"
                    disabled={busy || response.trim() === ""}
                    onClick={onComplete}
                    title={
                      response.trim() === ""
                        ? "Paste the evidence that this work is finished before marking it complete"
                        : "Record this as DONE without running the agent again. Your override is always honoured, including over an unmet definition of done — and is recorded as such."
                    }
                  >
                    Mark complete
                  </Button>
                </div>
              </div>
            )}

            <p className="text-xs leading-relaxed text-fg-dim">
              Suite verification lives above the work-item list. Use{" "}
              <b className="text-fg-muted">Verify this work item</b> to scope an agent check to this
              row only — it still writes a kept suite report.
            </p>
          </div>
        )}

        {tab === "sessions" && (
          <div className="space-y-4">
            {sessions.length === 0 ? (
              <p className="text-sm text-fg-dim">No sessions yet.</p>
            ) : (
              sessions.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSessionId(run.id)}
                  aria-current={activeSessionId === run.id ? "true" : undefined}
                  className={cn(
                    "mb-2 w-full rounded-md border p-3 text-left transition-colors",
                    activeSessionId === run.id
                      ? "border-line-strong bg-surface-3"
                      : "border-line bg-surface-2 hover:bg-surface-3",
                  )}
                >
                  <div className="flex justify-between gap-2 text-xs">
                    <span>
                      {run.provider}
                      {run.model !== null && ` · ${run.model}`}
                    </span>
                    <Badge
                      tone={
                        run.state === "DONE" ? "success" : run.state === "RUNNING" ? "info" : "warning"
                      }
                    >
                      {run.state.toLowerCase()}
                    </Badge>
                    <Badge tone="neutral">{run.role}</Badge>
                    {sessionEndReason(run.state, run.events) !== null && (
                      <Badge tone="neutral">{sessionEndReason(run.state, run.events)}</Badge>
                    )}
                  </div>
                  <div className="mt-1 text-[10px] text-fg-dim">
                    {new Date(run.startedAt).toLocaleString()} · {run.events.length} events
                  </div>
                </button>
              ))
            )}

            {selectedSession !== null && (
              <section>
                <div className="mb-2 text-xs uppercase tracking-wider text-fg-dim">
                  Session log · {selectedSession.provider} · {selectedSession.state.toLowerCase()}
                </div>
                {logs.length === 0 ? (
                  <p className="rounded-panel border border-line p-4 text-sm text-fg-dim">
                    No event stream was captured for this session.
                  </p>
                ) : (
                  <div className="flex h-[45vh] min-h-0 flex-col overflow-hidden rounded-panel border border-line">
                    <LogPanel items={logs} workdir={item.workspace.workDirectory} />
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {tab === "activity" && (
          <div>
            {timeline.length === 0 ? (
              <p className="text-sm text-fg-dim">Nothing recorded yet.</p>
            ) : (
              <div className="space-y-4">
                {timeline.map((entry) => (
                  <div key={entry.id} className={cn("border-l-2 pl-3", entry.tone)}>
                    <div className="text-[10px] uppercase tracking-wider text-fg-dim">
                      {entry.label} · {new Date(entry.at).toLocaleString()}
                    </div>
                    {entry.text !== "" && (
                      <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-fg-muted">
                        {entry.text}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

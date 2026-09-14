"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { OperationsPrompt, OperationsSuite, StartUnknownClassification } from "@agent-console/shared";
import { LogPanel } from "@/components/LogPanel";
import { LABEL, TONE } from "@/components/pipeline/status";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { applyEvent, type LogItem } from "@/lib/log";

type DetailTab = "overview" | "sessions" | "activity";

type ActivityPayload = Awaited<ReturnType<typeof import("@/lib/workspacesApi").workspaceApi.activity>>;

export function WorkItemDetail({
  suite,
  item,
  activity,
  busy,
  canStart,
  verifyingItem,
  connectionOpen,
  providerLabel,
  model,
  onRun,
  onStop,
  onRecover,
  onClassifyStartUnknown,
  onRespond,
  onVerifyItem,
  onClose,
}: {
  suite: OperationsSuite | null;
  item: OperationsPrompt | null;
  activity: ActivityPayload | null;
  busy: boolean;
  canStart: boolean;
  verifyingItem: boolean;
  connectionOpen: boolean;
  providerLabel: string;
  model: string | null;
  onRun(): void;
  onStop(): void;
  onRecover(): void;
  onClassifyStartUnknown(classification: StartUnknownClassification, expectedStartIntentId: string): void;
  onRespond(): void;
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
            {(item.operationalState === "AWAITING_RESPONSE" || (item.prompt.status === "TODO" && activity?.remarks.some(entry => entry.kind === "HUMAN_RESPONSE"))) && (
              <div className="rounded-panel border border-warning/40 bg-warning/5 p-4">
                <h3 className="mb-2 text-sm font-semibold text-warning">{item.operationalState === "AWAITING_RESPONSE" ? "Needs your input" : "Answer saved"}</h3>
                <p className="mb-3 text-xs leading-5 text-fg-muted">Review the latest question, answer it, or change the instructions before continuing.</p>
                <Button variant="success" onClick={onRespond}>{item.operationalState === "AWAITING_RESPONSE" ? "Review and respond" : "Continue with saved answer"}</Button>
              </div>
            )}
            {item.latestHandoff !== null && (
              <div className="rounded-panel border border-info/30 bg-info/5 p-4">
                <div className="text-[10px] uppercase tracking-wider text-info">
                  Handoff · {item.latestHandoff.state.toLowerCase().replaceAll("_", " ")}
                </div>
                {item.latestHandoff.recommendation !== null && (
                  <div className="mt-1 text-xs text-fg-muted">
                    Recommendation: {item.latestHandoff.recommendation.toLowerCase().replaceAll("_", " ")}
                  </div>
                )}
                {item.latestHandoff.brief !== null && (
                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                    <div><div className="mb-1 text-fg-dim">Completed</div>{item.latestHandoff.brief.completedWork.slice(0, 4).map((entry) => <div key={entry}>• {entry}</div>)}</div>
                    <div><div className="mb-1 text-fg-dim">Pending</div>{item.latestHandoff.brief.pendingWork.slice(0, 4).map((entry) => <div key={entry}>• {entry}</div>)}</div>
                  </div>
                )}
                {item.latestHandoff.error !== null && <div className="mt-2 text-xs text-warning">{item.latestHandoff.error}</div>}
              </div>
            )}
            {item.prompt.recovery.kind === "start_unknown" && (
              <div
                role="status"
                data-testid="start-unknown-warning"
                className="min-w-0 rounded-panel border border-warning/40 bg-warning/10 p-4"
              >
                <h3 className="mb-2 text-sm font-semibold text-warning">Ownership unknown</h3>
                <p className="break-words text-xs leading-5 text-fg-muted">
                  Confirm provider process state before recovery. Recovery stays blocked until the server knows the previous start is stopped or no spawn.
                </p>
                {item.prompt.recovery.startIntentId !== undefined && item.prompt.recovery.startIntentId !== null && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => onClassifyStartUnknown("known_stopped", item.prompt.recovery.startIntentId!)}>
                      Mark known stopped
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onClassifyStartUnknown("known_no_spawn", item.prompt.recovery.startIntentId!)}>
                      Mark no spawn
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {item.operationalState === "READY" && (
                <Button size="sm" variant="success" disabled={!canStart || busy} onClick={onRun}>
                  Run work item
                </Button>
              )}
              {item.operationalState === "RECOVERY_NEEDED" && item.prompt.recovery.kind !== "start_unknown" && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={onRecover}>
                  Recover and resume
                </Button>
              )}
              {item.operationalState === "RECOVERY_NEEDED" && item.prompt.recovery.kind === "start_unknown" && (
                <Badge tone="warning">Recovery blocked</Badge>
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

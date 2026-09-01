"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OperationsSuite,
  SuiteVerificationCheck,
  SuiteVerificationDetail,
  SuiteVerificationRecord,
  SuiteVerificationVerdict,
} from "@agent-console/shared";
import { formatElapsed } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";
import { applyEvent, type LogItem } from "@/lib/log";
import { useAgentConsole, type RunStatus } from "@/lib/agentConsole";
import { Badge, type Tone } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Skeleton } from "./ui/Spinner";
import { useDialogs } from "./ui/Dialogs";
import { useToast } from "./ui/Toast";
import { LogPanel } from "./LogPanel";

const VERDICT_TONE: Record<SuiteVerificationVerdict, Tone> = {
  PASS: "success",
  WARNING: "warning",
  FAIL: "danger",
};

const CHECK_TONE: Record<SuiteVerificationCheck, Tone> = {
  VERIFIED: "success",
  WARNING: "warning",
  FAILED: "danger",
  UNVERIFIED: "neutral",
};

const CHECK_LABEL: Record<SuiteVerificationCheck, string> = {
  VERIFIED: "Verified",
  WARNING: "Warning",
  FAILED: "Failed",
  UNVERIFIED: "Unverified",
};

function when(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/**
 * Everything a suite's verification history has to say.
 *
 * Verifications used to leave nothing behind — the agent kind ran as an
 * anonymous prompt whose events were never stored, and the record audit was
 * recomputed per request and thrown away. Both are now durable, so this panel
 * reads persisted records rather than in-page state, and survives reload,
 * navigation and restart.
 *
 * On the Tasks page the verify/audit buttons live on SuiteHeader; this panel
 * collapses to a one-line verdict and expands for history and reports.
 */
export function VerificationPanel({
  suite,
  provider,
  model,
  workspaceBusy,
  defaultCollapsed = false,
  hideActions = false,
  focusRecordId = null,
  onFocusHandled,
}: {
  suite: OperationsSuite;
  provider: Parameters<ReturnType<typeof useAgentConsole>["verifySuite"]>[1];
  model: string | null;
  workspaceBusy: boolean;
  /** Start collapsed to a one-line verdict summary (Tasks page). */
  defaultCollapsed?: boolean;
  /** Hide built-in verify/audit buttons when a parent owns those actions. */
  hideActions?: boolean;
  /** After an external audit, select this record, expand, and scroll its banner. */
  focusRecordId?: number | null;
  onFocusHandled?(): void;
}) {
  const console_ = useAgentConsole();
  const toast = useToast();
  const dialogs = useDialogs();
  const [history, setHistory] = useState<SuiteVerificationRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SuiteVerificationDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [showReport, setShowReport] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const verdictRef = useRef<HTMLDivElement | null>(null);

  // The live verification run for this suite, if one is going right now.
  const liveRun = useMemo<RunStatus | null>(
    () =>
      console_.runs.find(
        (run) => run.source.type === "verification" && run.source.suiteId === suite.id,
      ) ?? null,
    [console_.runs, suite.id],
  );

  // Every state write happens in a promise continuation rather than in the
  // synchronous part of the call, so using this from an effect cannot cascade
  // renders.
  const load = useCallback(
    () =>
      workspaceApi
        .verifications(SERVER_URL, suite.id)
        .then((records) => {
          setHistory(records);
          setSelectedId((current) =>
            current !== null && records.some((r) => r.id === current) ? current : records[0]?.id ?? null,
          );
          return records;
        })
        .catch(() => {
          // An unreachable backend is not "no history"; show an empty list
          // rather than a skeleton that never resolves.
          setHistory([]);
          return [] as SuiteVerificationRecord[];
        }),
    [suite.id],
  );

  // Refetches when the suite changes and again when a verification finishes —
  // a completed run means a new record exists, so ask rather than guess.
  const liveRunId = liveRun?.runId ?? null;
  useEffect(() => {
    void load();
  }, [load, liveRunId]);

  // External audit/verify completion: reload, select the new record, expand,
  // and bring the verdict banner into view.
  useEffect(() => {
    if (focusRecordId === null) return;
    let disposed = false;
    void load().then((records) => {
      if (disposed) return;
      if (records.some((record) => record.id === focusRecordId)) {
        setSelectedId(focusRecordId);
        setCollapsed(false);
        requestAnimationFrame(() => {
          verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
      onFocusHandled?.();
    });
    return () => {
      disposed = true;
    };
  }, [focusRecordId, load, onFocusHandled]);

  // `liveRunId` is a dependency for a reason: the record is selected while it is
  // still RUNNING and empty, and its id does not change when it completes.
  // Without this the panel would keep showing the empty in-progress snapshot
  // after the verification had finished and written its results.
  useEffect(() => {
    if (selectedId === null) return;
    let disposed = false;
    void workspaceApi
      .verification(SERVER_URL, selectedId)
      .then((value) => { if (!disposed) setDetail(value); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [selectedId, liveRunId]);

  // Never render a detail that belongs to a different record than the one
  // selected — the fetch above is async and the user can click again mid-flight.
  const shown = detail !== null && detail.id === selectedId ? detail : null;

  const startAgentVerification = async () => {
    const itemCount = suite.prompts.length;
    const confirmed = await dialogs.confirm({
      title: "Verify suite with agent?",
      description: (
        <>
          Starts a real agent run with <b className="text-fg-muted">{provider}</b>
          {model !== null && (
            <>
              {" "}
              · <b className="text-fg-muted">{model}</b>
            </>
          )}{" "}
          against {itemCount} work item{itemCount === 1 ? "" : "s"}. It changes nothing in the working
          tree and writes a report that is kept.
        </>
      ),
      confirmLabel: "Start verification",
    });
    if (!confirmed) return;
    if (!console_.verifySuite(suite.id, provider, model)) {
      toast.error("Could not start verification", "The agent connection is unavailable.");
      return;
    }
    toast.info("Verification started", `${suite.key ?? suite.name} is being checked by ${provider}.`);
    setCollapsed(false);
    setShowTranscript(true);
  };

  const runAudit = async () => {
    const itemCount = suite.prompts.length;
    const confirmed = await dialogs.confirm({
      title: "Audit recorded evidence?",
      description: `No agent runs. This re-reads the evidence already stored for each of the ${itemCount} work item${itemCount === 1 ? "" : "s"} and writes a dated audit record with a verdict. Your working tree is not read or changed.`,
      confirmLabel: "Run audit",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const record = await workspaceApi.auditSuite(SERVER_URL, suite.id);
      await load();
      setSelectedId(record.id);
      setCollapsed(false);
      toast.success("Audit recorded", `Verdict ${record.verdict} from the saved evidence.`);
      requestAnimationFrame(() => {
        verdictRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (error) {
      toast.error("Audit failed", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copyReport = async () => {
    if (shown === null || shown.reportMarkdown === "") return;
    try {
      await navigator.clipboard.writeText(shown.reportMarkdown);
      toast.success("Report copied");
    } catch {
      toast.error("Could not copy", "The browser refused clipboard access.");
    }
  };

  // What changed since the verification before this one.
  const changes = useMemo(() => {
    if (history === null || shown === null) return [];
    const index = history.findIndex((record) => record.id === shown.id);
    const previous = history[index + 1];
    if (previous === undefined) return [];
    const before = new Map(previous.items.map((item) => [item.promptKey ?? item.title, item.check]));
    return shown.items
      .map((item) => ({ item, was: before.get(item.promptKey ?? item.title) }))
      .filter((entry) => entry.was !== undefined && entry.was !== entry.item.check);
  }, [history, shown]);

  const liveItems = liveRun === null ? [] : console_.itemsFor(liveRun.runId);
  const persistedItems = useMemo<LogItem[]>(
    () => (shown?.events ?? []).reduce<LogItem[]>((items, event) => applyEvent(items, event), []),
    [shown],
  );

  const summaryRecord = shown ?? suite.latestVerification;
  const summaryLine = (() => {
    if (liveRun !== null) return `${liveRun.provider} is verifying…`;
    if (summaryRecord == null) return "never verified";
    if ("verdict" in summaryRecord && summaryRecord.verdict !== null) {
      const age = "startedAt" in summaryRecord ? ` · ${when(summaryRecord.startedAt)}` : "";
      if ("summary" in summaryRecord && summaryRecord.summary != null && typeof summaryRecord.summary === "object") {
        const summary = summaryRecord.summary as { verified?: number; total?: number };
        if (typeof summary.verified === "number" && typeof summary.total === "number") {
          return `${summaryRecord.verdict} · ${summary.verified}/${summary.total} verified${age}`;
        }
      }
      return `${summaryRecord.verdict}${age}`;
    }
    if ("state" in summaryRecord) return String(summaryRecord.state).toLowerCase();
    return "unverified";
  })();

  return (
    <section className="rounded-panel border border-line bg-surface-1">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span aria-hidden className="text-[9px] text-fg-dim">
            {collapsed ? "▸" : "▾"}
          </span>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Verification</h3>
          <span className="truncate text-xs text-fg-dim">{summaryLine}</span>
          {suite.latestVerification === null && (history?.length ?? 0) === 0 && liveRun === null && (
            <Badge tone="neutral">never verified</Badge>
          )}
        </button>
        {!hideActions && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={workspaceBusy || console_.connection !== "open"}
              loading={liveRun !== null}
              onClick={() => void startAgentVerification()}
              title="Run an independent agent that re-checks every item against the working tree"
            >
              {liveRun !== null ? "Verifying…" : "Verify with agent"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => void runAudit()}
              title="Read back the evidence already recorded, without running anything"
            >
              Audit records
            </Button>
          </div>
        )}
      </header>

      {!collapsed && (
        <>
          {/* Live run ---------------------------------------------------------- */}
          {liveRun !== null && (
            <div className="border-b border-line p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs text-violet">
                  <span className="size-1.5 animate-pulse-ring rounded-full bg-violet" />
                  {liveRun.provider} is verifying · {formatElapsed(liveRun.elapsedMs)}
                </span>
                <Button size="sm" variant="danger" onClick={() => console_.interrupt(liveRun.runId)}>
                  Stop
                </Button>
              </div>
              <div className="flex h-[38vh] min-h-0 flex-col overflow-hidden rounded-md border border-violet/30">
                <LogPanel items={liveItems} workdir={null} />
              </div>
            </div>
          )}

          {history === null ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : history.length === 0 ? (
            <p className="p-4 text-sm text-fg-dim">
              This suite has never been verified.{" "}
              <b className="text-fg-muted">Verify suite with agent</b> runs an independent agent that
              re-checks every item against the working tree and writes a report that is kept.{" "}
              <b className="text-fg-muted">Audit recorded evidence</b> only reads back the evidence
              already stored.
            </p>
          ) : (
            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_240px]">
              <div className="min-w-0 space-y-4">
                {shown === null ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <>
                    <div ref={verdictRef}>
                      <VerdictBanner record={shown} />
                    </div>

                    {changes.length > 0 && (
                      <div className="rounded-md border border-line bg-surface-2 p-3">
                        <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">
                          Changed since the previous verification
                        </div>
                        <ul className="space-y-1 text-xs">
                          {changes.map(({ item, was }) => (
                            <li key={item.promptKey ?? item.title} className="flex flex-wrap items-center gap-2">
                              <span className="text-fg">{item.promptKey ?? item.title}</span>
                              <Badge tone={CHECK_TONE[was!]}>{CHECK_LABEL[was!]}</Badge>
                              <span aria-hidden className="text-fg-dim">
                                →
                              </span>
                              <Badge tone={CHECK_TONE[item.check]}>{CHECK_LABEL[item.check]}</Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {shown.items.length > 0 ? (
                      <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
                        {shown.items.map((item, index) => (
                          <li key={`${item.promptKey ?? item.title}-${index}`} className="bg-surface-2 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <span className="text-[13px] text-fg">
                                {item.promptKey !== null && (
                                  <span className="mr-1.5 font-semibold text-fg-muted">{item.promptKey}</span>
                                )}
                                {item.title}
                                {item.promptId === null && (
                                  <span
                                    className="ml-2 text-[10px] text-fg-dim"
                                    title="The agent named an item that does not match a work item in this suite"
                                  >
                                    unmatched
                                  </span>
                                )}
                              </span>
                              <Badge tone={CHECK_TONE[item.check]} dot>
                                {CHECK_LABEL[item.check]}
                              </Badge>
                            </div>
                            {item.commands !== "" && (
                              <p className="mt-1.5 font-terminal text-[11px] text-fg-dim">$ {item.commands}</p>
                            )}
                            {item.evidence !== "" && (
                              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
                                {item.evidence}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      shown.state === "DONE" && (
                        <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                          No per-item table could be read out of this report. The full report is below, exactly as
                          the agent wrote it.
                        </p>
                      )
                    )}

                    {shown.reportMarkdown !== "" && (
                      <Disclosure
                        open={showReport}
                        onToggle={() => setShowReport((value) => !value)}
                        label={`Full report · ${shown.reportMarkdown.length.toLocaleString()} chars`}
                        action={
                          <Button size="sm" variant="ghost" onClick={() => void copyReport()}>
                            Copy
                          </Button>
                        }
                      >
                        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-0 p-3 font-terminal text-fg-muted">
                          {shown.reportMarkdown}
                        </pre>
                      </Disclosure>
                    )}

                    {shown.events.length > 0 && (
                      <Disclosure
                        open={showTranscript}
                        onToggle={() => setShowTranscript((value) => !value)}
                        label={`Transcript · ${shown.events.length} events`}
                      >
                        <div className="flex h-[45vh] min-h-0 flex-col overflow-hidden rounded-md border border-line">
                          <LogPanel items={persistedItems} workdir={null} />
                        </div>
                      </Disclosure>
                    )}
                  </>
                )}
              </div>

              {/* History ------------------------------------------------------- */}
              <aside className="min-w-0">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">
                  History · {history.length}
                </div>
                <ul className="space-y-1.5">
                  {history.map((record) => (
                    <li key={record.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(record.id)}
                        aria-current={record.id === selectedId ? "true" : undefined}
                        className={cn(
                          "w-full rounded-md border p-2.5 text-left transition-colors",
                          record.id === selectedId
                            ? "border-line-strong bg-surface-3"
                            : "border-line bg-surface-2 hover:bg-surface-3",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge tone={record.verdict === null ? "info" : VERDICT_TONE[record.verdict]}>
                            {record.verdict ?? record.state}
                          </Badge>
                          <span className="text-[10px] text-fg-dim">{when(record.startedAt)}</span>
                        </div>
                        <div className="mt-1 truncate text-[11px] text-fg-muted">
                          {record.kind === "AGENT"
                            ? `agent · ${record.provider ?? "?"}`
                            : "record audit"}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function VerdictBanner({ record }: { record: SuiteVerificationRecord }) {
  const tone = record.verdict === null ? "info" : VERDICT_TONE[record.verdict];
  const duration =
    record.endedAt === null
      ? null
      : formatElapsed(new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime());
  return (
    <div
      className={cn(
        "holo rounded-md border p-4",
        tone === "success" && "border-success/40 bg-success/5",
        tone === "warning" && "border-warning/40 bg-warning/5",
        tone === "danger" && "border-danger/40 bg-danger/5",
        tone === "info" && "border-info/40 bg-info/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "text-lg font-semibold",
            tone === "success" && "text-success",
            tone === "warning" && "text-warning",
            tone === "danger" && "text-danger",
            tone === "info" && "text-info",
          )}
        >
          {record.verdict ?? record.state}
        </span>
        <span className="text-xs text-fg-muted">
          {record.kind === "AGENT"
            ? `independent agent · ${record.provider ?? "?"}${record.model === null ? "" : ` · ${record.model}`}`
            : "audit of recorded evidence"}
        </span>
        <span className="ml-auto text-xs text-fg-dim">
          {new Date(record.startedAt).toLocaleString()}
          {duration !== null && ` · ${duration}`}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Badge tone="success">{record.summary.verified} verified</Badge>
        {record.summary.warnings > 0 && <Badge tone="warning">{record.summary.warnings} warnings</Badge>}
        {record.summary.failed > 0 && <Badge tone="danger">{record.summary.failed} failed</Badge>}
        {record.summary.unverified > 0 && <Badge tone="neutral">{record.summary.unverified} unverified</Badge>}
        <Badge tone="neutral">{record.summary.total} total</Badge>
      </div>

      {record.stats !== null && (
        <p className="mt-3 text-[10px] text-fg-dim">
          Dossier: {record.stats.workItems} work items · {record.stats.uniqueCommands} deduplicated commands ·{" "}
          {record.stats.dossierCharacters.toLocaleString()} context chars from{" "}
          {record.stats.sourceCharacters.toLocaleString()} source chars
        </p>
      )}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  action,
  children,
}: {
  open: boolean;
  onToggle(): void;
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          <span aria-hidden className="text-[9px]">
            {open ? "▾" : "▸"}
          </span>
          {label}
        </button>
        {action}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  CompletionAuditRecord,
  OperationsPrompt,
  OperationsSuite,
  PromptActivity,
  ProviderId,
  StatusDefinition,
} from "@hydra/shared";
import { isProviderId, modelLabel } from "@hydra/shared";
import { AgentAvatar } from "@/features/providers/components/AgentAvatar";
import { Modal } from "@/components/ui/Modal";
import { LogPanel } from "@/features/runs/components/LogPanel";
import { DefinitionOfDonePanel } from "@/features/pipeline/components/DefinitionOfDonePanel";
import { LABEL, TONE } from "@/features/pipeline/lib/status";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { applyEvent, type LogItem } from "@/features/runs/lib/log";
import { SERVER_URL } from "@/api/serverUrl";
import { sessionEndReason } from "@/features/runs/lib/sessionEndReason";
import { workspaceApi } from "@/api/workspacesApi";
import { Conversation, GateGlyph, buildThread } from "./Conversation";
import { isTerminal } from "../../lib/station/tree";
import type { StationActions } from "../../hooks/station/useStationActions";
import { WhyThisStatus } from "./WhyThisStatus";

export type StationTab = "overview" | "conversation" | "activity" | "sessions";

/**
 * The right-hand panel for one work item. Header says what it is, tabs say
 * everything known about it, and the footer holds every action — always in the
 * same place, with the action that fits its state on the far right.
 */
export function StationPanel({
  suite,
  item,
  parent,
  statusCatalog,
  triggerSentences,
  revision,
  actions,
  tab,
  onTabChange,
  focusSignal,
  onFocusComposer,
  running,
  verifying,
  agent,
  onConfigure,
  onSelect,
  onOpenSubSteps,
}: {
  suite: OperationsSuite | null;
  item: OperationsPrompt;
  parent: OperationsPrompt | null;
  statusCatalog: readonly StatusDefinition[];
  triggerSentences: Record<string, string>;
  /** Changes whenever server data may have changed; re-reads the activity. */
  revision: string | number;
  actions: StationActions;
  tab: StationTab;
  onTabChange(tab: StationTab): void;
  focusSignal: number;
  onFocusComposer(): void;
  /** This item's run is the one working right now. */
  running: boolean;
  verifying: boolean;
  /** Who runs this item, shown under the title. */
  agent?: { provider: ProviderId | null; model: string | null; source: string } | null;
  /** Opens this step's settings in the Pipeline studio; hidden without it. */
  onConfigure?(): void;
  onSelect(promptId: number): void;
  onOpenSubSteps?(): void;
}) {
  const activity = usePromptActivity(item.prompt.id, revision);
  const thread = useMemo(() => buildThread(item, activity), [item, activity]);
  const sessions = activity?.sessions ?? [];
  const waiting = thread.some((entry) => entry.open === true);

  const tabs: Array<[StationTab, string, ReactNode?]> = [
    ["overview", "Overview"],
    ["conversation", "Conversation", waiting ? <GateGlyph pending className="animate-pulse" /> : thread.length > 0 ? thread.length : null],
    ["activity", "Activity"],
    ["sessions", "Sessions", sessions.length > 0 ? sessions.length : null],
  ];
  const activeTab = tab;
  const [logFor, setLogFor] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line px-4 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {parent !== null && (
              <button
                type="button"
                onClick={() => onSelect(parent.prompt.id)}
                className="mb-1 block max-w-full truncate text-xs text-accent hover:underline"
              >
                ← {parent.prompt.externalKey ?? parent.prompt.title}
              </button>
            )}
            <div className="flex items-center gap-2">
              <Badge tone={TONE[item.operationalState]} dot pulse={item.operationalState === "WORKING"}>
                {LABEL[item.operationalState]}
              </Badge>
              {item.prompt.externalKey !== null && (
                <span className="truncate text-xs font-semibold text-fg-muted">{item.prompt.externalKey}</span>
              )}
            </div>
            <h2 className="mt-1.5 line-clamp-2 text-base leading-5 text-fg" title={item.prompt.title}>
              {item.prompt.title}
            </h2>
            <p className="mt-0.5 truncate text-xs text-fg-dim">
              {item.prompt.programName} / {item.prompt.suiteName}
            </p>
          </div>
        </div>
        {(agent != null || onConfigure !== undefined) && (
          <div className="station-agent-strip mt-2.5">
            {agent?.provider != null ? <AgentAvatar provider={agent.provider} size={20} activity={running ? "thinking" : "idle"} /> : <span className="station-agent-empty" aria-hidden>?</span>}
            <span className="min-w-0 flex-1 truncate text-xs" title={agent == null ? undefined : [agent.provider ?? "No agent chosen", agent.provider != null && agent.model !== null ? modelLabel(agent.provider, agent.model) : null, agent.source].filter(Boolean).join(" · ")}>
              <span className="text-fg">{agent?.provider ?? "No agent chosen"}</span>
              {agent?.provider != null && agent.model !== null && <span className="text-fg-muted"> · {modelLabel(agent.provider, agent.model)}</span>}
              {agent != null && <span className="text-fg-dim"> · {agent.source}</span>}
            </span>
            {onConfigure !== undefined && (
              <button type="button" className="station-configure" onClick={onConfigure} title="Agent, outcomes, fallbacks and execution allowance for this step">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="16" cy="7" r="2.2" stroke="currentColor" strokeWidth="2" /><circle cx="10" cy="17" r="2.2" stroke="currentColor" strokeWidth="2" /></svg>
                Configure step
              </button>
            )}
          </div>
        )}

        <nav className="-mb-px mt-3 flex gap-3.5 overflow-x-auto" role="tablist" aria-label="Item details">
          {tabs.map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => onTabChange(id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 pb-2 text-xs transition-colors",
                activeTab === id ? "border-accent text-fg" : "border-transparent text-fg-dim hover:text-fg",
              )}
            >
              {label}
              {badge !== null && badge !== undefined && (
                <span className="numeric rounded-full bg-surface-3 px-1.5 text-xs leading-4 text-fg-muted">{badge}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "overview" && (
          <div className="h-full space-y-4 overflow-y-auto p-4">
            {waiting && (
              <button
                type="button"
                onClick={onFocusComposer}
                className="flex w-full items-start gap-2.5 rounded-panel border border-warning/40 bg-warning/8 px-3 py-2.5 text-left transition-colors hover:bg-warning/12"
              >
                <GateGlyph pending className="mt-1 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs uppercase tracking-wider text-warning">Waiting on you</span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-fg-muted">
                    {[...thread].reverse().find((entry) => entry.open === true)?.text}
                  </span>
                </span>
                <span className="shrink-0 self-center text-xs text-accent">Reply ›</span>
              </button>
            )}
            {item.latestAudit !== null && <CompletionAuditCard audit={item.latestAudit} />}
            <WhyThisStatus
              item={item}
              events={activity?.events ?? []}
              catalog={statusCatalog}
              triggerSentences={triggerSentences}
            />
            <DefinitionOfDonePanel scope="prompt" scopeId={item.prompt.id} promptId={item.prompt.id} />
            {item.children.length > 0 && (
              <section className="rounded-panel border border-line bg-surface-1 p-3">
                <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wider text-fg-dim">
                  <span>Sub-steps · {item.children.filter((item) => isTerminal(item)).length}/{item.children.length}</span>
                  {onOpenSubSteps !== undefined && (
                    <button type="button" onClick={onOpenSubSteps} className="normal-case tracking-normal text-accent hover:underline">
                      Open flow ›
                    </button>
                  )}
                </div>
                <ul className="space-y-1">
                  {item.children.map((child) => (
                    <li key={child.prompt.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(child.prompt.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs text-fg">
                          {child.prompt.externalKey !== null && (
                            <span className="mr-1.5 text-xs font-semibold text-fg-muted">{child.prompt.externalKey}</span>
                          )}
                          {child.prompt.title}
                        </span>
                        <Badge tone={TONE[child.operationalState]}>{LABEL[child.operationalState]}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {activeTab === "conversation" && (
          <Conversation
            item={item}
            activity={activity}
            busy={actions.busy}
            focusSignal={focusSignal}
            onAnswer={(text) => actions.respond(item, text)}
            onNote={(text) =>
              actions.act(async () => {
                await workspaceApi.addBriefing(SERVER_URL, item.prompt.id, text.trim());
              }, "Note attached — the agent reads it on its next run")
            }
          />
        )}

        {activeTab === "sessions" && <SessionCards sessions={sessions} onOpen={setLogFor} />}

        {activeTab === "activity" && <Timeline activity={activity} />}
      </div>

      {logFor !== null && (
        <Modal open onClose={() => setLogFor(null)} size="2xl" bodyClassName="session-log-body"
          title={`Sessions · ${item.prompt.externalKey ?? item.prompt.title}`}
          description="Every agent session on this item, with its full event stream.">
          <SessionBrowser item={item} sessions={sessions} initial={logFor} />
        </Modal>
      )}

      <ActionBar
        suite={suite}
        item={item}
        actions={actions}
        running={running}
        verifying={verifying}
        waiting={waiting}
        hasConfig={onConfigure !== undefined}
        onReply={onFocusComposer}
        onConfig={() => onConfigure?.()}
      />
    </div>
  );
}

/**
 * The footer. Three fixed slots, left to right: the overflow menu (every
 * action, always in the same order), one secondary action, and the primary
 * action that fits the item's state — so the eye and the hand learn one place.
 */
function ActionBar({
  suite,
  item,
  actions,
  running,
  verifying,
  waiting,
  hasConfig,
  onReply,
  onConfig,
}: {
  suite: OperationsSuite | null;
  item: OperationsPrompt;
  actions: StationActions;
  running: boolean;
  verifying: boolean;
  waiting: boolean;
  hasConfig: boolean;
  onReply(): void;
  onConfig(): void;
}) {
  const router = useRouter();
  const busy = actions.busy;
  const terminal = isTerminal(item);
  const working = item.operationalState === "WORKING" && item.prompt.currentRun !== null;
  const recoverable = item.prompt.recoverable;
  const runGate = actions.runGate(item);

  const doRun = () => void actions.run(item);
  const doBrief = () => void actions.brief(item, running);
  const doVerify = () => {
    if (suite !== null) void actions.verify(suite, item);
  };
  const doComplete = () => void actions.markComplete(item);
  const doAudit = () => void actions.audit(item);

  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  if (working) {
    secondary = <Button size="sm" variant="secondary" disabled={busy} onClick={doBrief}>Rerun with context…</Button>;
    primary = <Button size="sm" variant="danger" disabled={busy} onClick={() => void actions.stop(item)}>Stop agent</Button>;
  } else if (waiting) {
    secondary = <Button size="sm" variant="secondary" disabled={busy} onClick={doComplete}>Mark complete…</Button>;
    primary = <Button size="sm" variant="success" disabled={busy} onClick={onReply}>Reply</Button>;
  } else if (recoverable) {
    secondary = (
      <Button size="sm" variant="secondary" disabled={busy} onClick={doAudit} title="A read-only agent checks whether the work was already finished">
        Audit run
      </Button>
    );
    primary = <Button size="sm" variant="primary" disabled={busy} onClick={() => void actions.recover(item)}>Recover & resume</Button>;
  } else if (terminal) {
    primary = (
      <Button size="sm" variant="primary" disabled={busy || suite === null} loading={verifying} onClick={doVerify}>
        Verify
      </Button>
    );
  } else {
    secondary = <Button size="sm" variant="secondary" disabled={busy} onClick={doBrief}>Run with context…</Button>;
    primary = (
      <Button size="sm" variant="success" disabled={busy || runGate !== null} title={runGate ?? undefined} onClick={doRun}>
        Run
      </Button>
    );
  }

  const menu: MenuItem[] = [
    { id: "run", label: "Run now", onSelect: doRun, disabled: busy || terminal || working || runGate !== null, title: runGate ?? undefined },
    { id: "brief", label: working ? "Rerun with context…" : "Run with context…", onSelect: doBrief, disabled: busy || terminal },
    { id: "verify", label: "Verify with agent", onSelect: doVerify, disabled: busy || suite === null || verifying },
    { id: "audit", label: "Audit what the run left", onSelect: doAudit, disabled: busy || !recoverable, title: recoverable ? undefined : "Only after a run ended without posting a status" },
    { id: "complete", label: "Mark complete…", onSelect: doComplete, disabled: busy || terminal },
    ...(hasConfig ? [{ id: "config", label: "Configure step", onSelect: onConfig, separated: true }] : []),
    {
      id: "chat",
      label: "Open in Chat",
      onSelect: () => router.push(`/?workspace=${item.workspace.id}&prompt=${item.prompt.id}`),
      separated: !hasConfig,
    },
    { id: "skip", label: "Skip…", onSelect: () => void actions.skip(item), disabled: busy || terminal, tone: "danger", separated: true },
  ];

  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-1 px-3 py-2.5">
      <Menu items={menu} label="All item actions" placement="above" align="left" variant="secondary" />
      <div className="ml-auto flex items-center gap-2">
        {secondary}
        {primary}
      </div>
    </footer>
  );
}

function usePromptActivity(promptId: number, revision: string | number): PromptActivity | null {
  const [state, setState] = useState<{ id: number; value: PromptActivity } | null>(null);
  useEffect(() => {
    let disposed = false;
    void workspaceApi
      .activity(SERVER_URL, promptId)
      .then((value) => {
        if (!disposed) setState({ id: promptId, value });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [promptId, revision]);
  // Only trust the fetched payload when it belongs to the item on screen.
  return state !== null && state.id === promptId && state.value.item.prompt.id === promptId ? state.value : null;
}

function RunAvatar({ provider, size, live }: { provider: string; size: number; live: boolean }) {
  return isProviderId(provider) ? <AgentAvatar provider={provider} size={size} activity={live ? "thinking" : "offline"} /> : null;
}

function sessionModel(provider: string, model: string): string {
  return isProviderId(provider) ? (modelLabel(provider, model) ?? model) : model;
}

/** The drawer's session list: one wrapping card per session; the log opens wide. */
function SessionCards({ sessions, onOpen }: { sessions: PromptActivity["sessions"]; onOpen(id: string): void }) {
  if (sessions.length === 0) return <p className="p-4 text-sm text-fg-dim">No sessions yet.</p>;
  return (
    <ul className="h-full space-y-2 overflow-y-auto p-3">
      {sessions.map((run) => {
        const ended = sessionEndReason(run.state, run.events);
        return (
          <li key={run.id}>
            <button type="button" onClick={() => onOpen(run.id)} className="session-card">
              <span className="flex min-w-0 items-center gap-2">
                <RunAvatar provider={run.provider} size={18} live={run.state === "RUNNING"} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg">
                  {run.provider}
                  {run.model !== null && <span className="text-fg-dim"> · {sessionModel(run.provider, run.model)}</span>}
                </span>
                <span className="session-card-open" aria-hidden>Open log ↗</span>
              </span>
              <span className="flex flex-wrap items-center gap-1">
                <Badge tone={run.state === "DONE" ? "success" : run.state === "RUNNING" ? "info" : "warning"}>{run.state.toLowerCase()}</Badge>
                <Badge tone="neutral">{run.role}</Badge>
                {ended !== null && <Badge tone="neutral">{ended}</Badge>}
                {run.changes !== null && run.changes.filesChanged > 0 && <Badge tone="info">{run.changes.filesChanged} files changed</Badge>}
              </span>
              <span className="text-xs text-fg-dim">{new Date(run.startedAt).toLocaleString()} · {run.events.length} events</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The wide session reader: sessions on the left, the chosen session's full log on the right. */
function SessionBrowser({ item, sessions, initial }: { item: OperationsPrompt; sessions: PromptActivity["sessions"]; initial: string }) {
  const [sessionId, setSessionId] = useState<string>(initial);
  const active = sessions.find((entry) => entry.id === sessionId) ?? sessions[0] ?? null;
  const logs = useMemo<LogItem[]>(
    () => active?.events.reduce<LogItem[]>((items, event) => applyEvent(items, event), []) ?? [],
    [active],
  );

  return (
    <div className="session-browser">
      <ul className="session-browser-list" aria-label="Sessions">
        {sessions.map((run) => (
          <li key={run.id}>
            <button type="button" onClick={() => setSessionId(run.id)} aria-current={active?.id === run.id ? "true" : undefined} className="session-card">
              <span className="flex min-w-0 items-center gap-2">
                <RunAvatar provider={run.provider} size={16} live={false} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg">{run.provider}{run.model !== null && <span className="text-fg-dim"> · {sessionModel(run.provider, run.model)}</span>}</span>
              </span>
              <span className="flex flex-wrap gap-1"><Badge tone={run.state === "DONE" ? "success" : run.state === "RUNNING" ? "info" : "warning"}>{run.state.toLowerCase()}</Badge><Badge tone="neutral">{run.role}</Badge></span>
              <span className="text-xs text-fg-dim">{new Date(run.startedAt).toLocaleString()} · {run.events.length} events</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="session-browser-log">
        {active !== null && active.changes !== null && active.changes.filesChanged > 0 && (
          <Link href={`/changes/${encodeURIComponent(active.id)}`} className="shrink-0 border-b border-line px-4 py-2 text-xs text-accent hover:underline">
            Review {active.changes.filesChanged} changed {active.changes.filesChanged === 1 ? "file" : "files"} ›
          </Link>
        )}
        {logs.length === 0 ? (
          <p className="p-4 text-sm text-fg-dim">No event stream was captured for this session.</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <LogPanel items={logs} workdir={item.workspace.workDirectory} />
          </div>
        )}
      </div>
    </div>
  );
}

function Timeline({ activity }: { activity: PromptActivity | null }) {
  const entries = useMemo(() => {
    if (activity === null) return [];
    return [
      ...activity.remarks.map((entry) => ({
        id: `r${entry.id}`,
        at: entry.createdAt,
        label: `${entry.actorType} · ${entry.kind.replaceAll("_", " ").toLowerCase()}`,
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
    ].sort((a, b) => b.at.localeCompare(a.at));
  }, [activity]);

  if (entries.length === 0) return <p className="p-4 text-sm text-fg-dim">Nothing recorded yet.</p>;
  return (
    <ol className="h-full min-w-0 space-y-4 overflow-y-auto overflow-x-hidden p-4">
      {entries.map((entry) => (
        <li key={entry.id} className={cn("min-w-0 border-l-2 pl-3", entry.tone)}>
          <div className="flex flex-wrap gap-x-2 text-xs text-fg-dim">
            <span className="break-words font-medium uppercase tracking-wider">{entry.label}</span>
            <span>{new Date(entry.at).toLocaleString()}</span>
          </div>
          {entry.text !== "" && (
            <ClampedText text={entry.text} className="mt-1 text-xs leading-5 text-fg-muted" />
          )}
        </li>
      ))}
    </ol>
  );
}

function ClampedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 5;
  return (
    <div className={className}>
      <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", long && !open && "line-clamp-5")}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-0.5 text-xs text-accent hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

const VERDICT_TONE = {
  COMPLETE: { border: "border-success/30", bg: "bg-success/5", text: "text-success" },
  INCOMPLETE: { border: "border-warning/30", bg: "bg-warning/5", text: "text-warning" },
  UNVERIFIABLE: { border: "border-caution/30", bg: "bg-caution/10", text: "text-caution" },
} as const;

/**
 * Did the agent that vanished without posting a status actually finish? Verdict
 * first, then the checks it stands on.
 */
function CompletionAuditCard({ audit }: { audit: CompletionAuditRecord }) {
  const tone = audit.verdict === null ? { border: "border-info/30", bg: "bg-info/5", text: "text-info" } : VERDICT_TONE[audit.verdict];
  return (
    <div className={cn("rounded-panel border p-3", tone.border, tone.bg)}>
      <div className={cn("text-xs uppercase tracking-wider", tone.text)}>
        Completion audit · {audit.verdict === null ? audit.state.toLowerCase() : audit.verdict.toLowerCase()}
        {audit.applied && " · station closed"}
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        Read-only {audit.provider} check of the run that ended without posting a status
        {audit.report === null ? "" : ` · ${audit.report.confidence.toLowerCase()} confidence`}
      </div>
      {audit.report !== null && audit.report.checks.length > 0 && (
        <div className="mt-2 space-y-1 text-xs">
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
        <div className="mt-2 text-xs">
          <div className="mb-1 text-fg-dim">Still missing</div>
          {audit.report.remainingWork.slice(0, 6).map((entry) => (
            <div key={entry} className="text-fg-muted">• {entry}</div>
          ))}
        </div>
      )}
      {audit.error !== null && <div className="mt-2 text-xs text-warning">{audit.error}</div>}
    </div>
  );
}

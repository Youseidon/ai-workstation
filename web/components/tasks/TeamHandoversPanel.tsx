"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamHandoverSummary } from "@agent-console/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type Filter = "open" | "all";
type Action = TeamHandoverSummary["actions"][number];

const CLOSED_STATES = new Set(["COMPLETED", "CANCELLED", "WITHDRAWN"]);

function stateTone(state: string): Tone {
  if (state === "COMPLETED") return "success";
  if (state === "RETURNED") return "info";
  if (state === "OFFERED" || state === "WAITING_INPUT") return "warning";
  if (state === "CANCELLED" || state === "WITHDRAWN") return "neutral";
  return "accent";
}

function stateLabel(state: string): string {
  return state.toLowerCase().replaceAll("_", " ");
}

function actionLabel(action: Action): string {
  if (action === "return") return "Return work";
  return action[0]!.toUpperCase() + action.slice(1);
}

function relativeTime(value: string): string {
  const delta = new Date(value).getTime() - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (!Number.isFinite(minutes)) return value;
  if (minutes < 1) return delta < 0 ? "just now" : "now";
  if (minutes < 60) return `${minutes}m ${delta < 0 ? "ago" : "left"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ${delta < 0 ? "ago" : "left"}`;
  const days = Math.round(hours / 24);
  return `${days}d ${delta < 0 ? "ago" : "left"}`;
}

function offerExpired(item: TeamHandoverSummary): boolean {
  return item.offerDeadline !== null && Date.parse(item.offerDeadline) <= Date.now();
}

function nextStep(item: TeamHandoverSummary): string {
  if (item.role === "requester") {
    if (item.state === "RETURNED") {
      return item.localTask === null
        ? "Returned work is ready, but this workstation has no linked task to review it in."
        : "Review the returned work in the task, then apply it or request specific changes.";
    }
    if (item.state === "OFFERED") return "Waiting for a teammate to accept or decline this offer.";
    if (item.state === "PREPARING") return "Finish preparing the offer, or withdraw it if it is no longer needed.";
    if (["STARTING", "RUNNING", "WAITING_INPUT"].includes(item.state)) {
      return `${item.executor?.label ?? "A teammate"} owns the work now. It will return here for your review.`;
    }
    if (item.state === "APPLYING") return "The returned result is being applied to the requester checkout.";
    if (item.state === "COMPLETED") return "The returned result was applied and this handover is closed.";
    if (item.state === "WITHDRAWN") return "This offer was withdrawn. No teammate can act on it.";
    if (item.state === "CANCELLED") return "This handover was cancelled and has no remaining actions.";
  }

  if (item.role === "receiver") {
    if (item.state === "OFFERED") {
      if (offerExpired(item)) return "The offer window expired. Accept and decline are no longer available.";
      if (!item.repository.ready) return "Accept is unavailable until this repository is ready. You can still decline the offer.";
      return "Accept to claim and run this work here, or decline it for the team.";
    }
    if (item.actions.includes("return")) return "The local run has ended. Return the work so the requester can review it.";
    if (["STARTING", "RUNNING", "WAITING_INPUT"].includes(item.state)) return "This work is active on the executor workstation.";
    if (item.state === "RETURNED") return "The work was returned. The requester now reviews and applies it or requests changes.";
    if (item.state === "COMPLETED") return "The requester applied the result. This handover is closed.";
    if (item.state === "WITHDRAWN") return "The requester withdrew this offer. No action is available.";
    if (item.state === "CANCELLED") return "This handover was cancelled and has no remaining actions.";
  }

  return "This handover is visible for status only; no action is assigned to this workstation.";
}

function actionAvailability(item: TeamHandoverSummary): string | null {
  if (item.actions.length > 0) {
    const available = item.actions.map(actionLabel).join(", ");
    if (item.role === "receiver" && item.state === "OFFERED" && !item.repository.ready) {
      return `Available now: ${available}. Accept requires repository setup.`;
    }
    return `Available now: ${available}.`;
  }
  if (item.role === "receiver" && item.state === "OFFERED") {
    if (offerExpired(item)) return "No actions available: this offer expired.";
    return "No live action is available yet. Refresh after the handover record is renewed.";
  }
  return null;
}

/** Kept separate so the inbox interaction and its real POST route can be tested together. */
export async function submitTeamHandoverAction(itemId: string, action: Action): Promise<void> {
  await workspaceApi.teamHandoverAction(SERVER_URL, itemId, action);
}

export function TeamHandoversView({
  items,
  visible,
  filter,
  loading,
  error,
  busyActions,
  onFilter,
  onRefresh,
  onAction,
  onOpenTask,
}: {
  items: TeamHandoverSummary[];
  visible: TeamHandoverSummary[];
  filter: Filter;
  loading: boolean;
  error: string | null;
  busyActions: ReadonlySet<string>;
  onFilter(filter: Filter): void;
  onRefresh(): void;
  onAction(itemId: string, action: Action): void | Promise<void>;
  onOpenTask(task: NonNullable<TeamHandoverSummary["localTask"]>): void;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Team handovers</h2>
          <p className="mt-0.5 text-xs text-fg-dim">
            {loading && items.length === 0 ? "Loading shared tasks…" : `${items.length} shared task${items.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-surface-2 p-0.5 ring-1 ring-inset ring-line" aria-label="Handover filter">
            {(["open", "all"] as Filter[]).map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                onClick={() => onFilter(option)}
                className={`h-7 rounded px-2.5 text-xs capitalize ${filter === option ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg"}`}
              >
                {option}
              </button>
            ))}
          </div>
          <Button size="sm" variant="secondary" loading={loading} onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>

      <p className="mt-3 rounded-md border border-line bg-surface-1 px-3 py-2 text-xs leading-5 text-fg-dim">
        Reminders are persistent: if an undecided action expires, it is renewed here without another Telegram post.
        Accepted, declined and applied decisions stay final.
      </p>

      {loading && items.length === 0 && (
        <p role="status" className="py-12 text-center text-sm text-fg-dim">Loading team handovers…</p>
      )}
      {error !== null && (
        <p role="alert" className="mt-4 border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {error}{items.length > 0 ? " Showing the last loaded handovers." : " Use Refresh to try again."}
        </p>
      )}
      {!loading && error === null && visible.length === 0 && (
        <p className="py-12 text-center text-sm text-fg-dim">
          {filter === "open"
            ? "No open team handovers. New offers and returned work will appear here."
            : "No team handovers yet. Published offers will appear here."}
        </p>
      )}

      <div className="divide-y divide-line">
        {visible.map(item => {
          const availability = actionAvailability(item);
          const itemBusy = [...busyActions].some(key => key.startsWith(`${item.itemId}:`));
          const taskButtonLabel = item.role === "requester" && item.state === "RETURNED"
            ? "Review returned work"
            : item.role === "receiver"
              ? "Open local task"
              : "Open task";
          return (
            <article key={item.itemId} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={stateTone(item.state)} dot pulse={["RUNNING", "STARTING", "APPLYING"].includes(item.state)} uppercase>
                      {stateLabel(item.state)}
                    </Badge>
                    <Badge tone={item.role === "requester" ? "violet" : item.role === "receiver" ? "info" : "neutral"}>{item.role}</Badge>
                    {item.resultLabel !== null && <Badge tone={item.resultLabel === "full" ? "success" : "warning"}>{item.resultLabel} result</Badge>}
                  </div>
                  <h3 className="mt-2 break-words text-sm font-medium text-fg">{item.localTask?.title ?? item.itemId}</h3>
                  <p className="mt-1 break-all font-mono text-[11px] text-fg-dim">{item.itemId}</p>
                </div>
                <span className="shrink-0 text-xs text-fg-dim" title={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt)}</span>
              </div>

              <p data-testid="team-handover-next-step" className="mt-3 text-xs leading-5 text-fg-muted">{nextStep(item)}</p>

              <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-fg-dim">Requester</dt><dd className="mt-0.5 text-fg-muted">{item.requester.label}</dd></div>
                <div><dt className="text-fg-dim">Executor</dt><dd className="mt-0.5 text-fg-muted">{item.executor?.label ?? "Unclaimed"}</dd></div>
                <div><dt className="text-fg-dim">Agent</dt><dd className="mt-0.5 text-fg-muted">{item.provider === null ? "Not selected" : `${item.provider}${item.model === null ? "" : ` / ${item.model}`}`}</dd></div>
                <div>
                  <dt className="text-fg-dim">Repository</dt>
                  <dd className={`mt-0.5 ${item.repository.ready ? "text-success" : "text-warning"}`}>
                    {item.repository.ready ? `Ready · ${item.repository.workspaceName}` : "Setup required"}
                  </dd>
                </div>
              </dl>

              {!item.repository.ready && item.role === "receiver" && item.repository.reason !== null && (
                <p className="mt-3 border-l-2 border-warning pl-3 text-xs leading-5 text-warning">{item.repository.reason}</p>
              )}
              {item.offerDeadline !== null && item.state === "OFFERED" && (
                <p className={`mt-2 text-xs ${offerExpired(item) ? "text-warning" : "text-fg-dim"}`}>
                  {offerExpired(item) ? "Offer expired " : "Offer expires "}{relativeTime(item.offerDeadline)}
                </p>
              )}
              {availability !== null && (
                <p data-testid="team-handover-action-availability" className="mt-2 text-xs text-fg-dim">{availability}</p>
              )}

              {(item.actions.length > 0 || item.localTask !== null) && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {item.localTask !== null && (
                    <Button
                      size="sm"
                      variant={item.role === "requester" && item.state === "RETURNED" ? "primary" : "secondary"}
                      data-testid="team-handover-open-task"
                      onClick={() => onOpenTask(item.localTask!)}
                    >
                      {taskButtonLabel}
                    </Button>
                  )}
                  {item.actions.map(action => {
                    const actionKey = `${item.itemId}:${action}`;
                    return (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "accept" ? "success" : action === "withdraw" ? "danger" : action === "return" ? "primary" : "secondary"}
                        loading={busyActions.has(actionKey)}
                        disabled={itemBusy}
                        data-testid={`team-handover-action-${action}`}
                        onClick={() => onAction(item.itemId, action)}
                      >
                        {actionLabel(action)}
                      </Button>
                    );
                  })}
                  {itemBusy && <span role="status" className="text-xs text-fg-dim">Updating this handover…</span>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function TeamHandoversPanel({
  onOpenTask,
}: {
  onOpenTask(task: NonNullable<TeamHandoverSummary["localTask"]>): void;
}) {
  const [items, setItems] = useState<TeamHandoverSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Set<string>>(() => new Set());
  const toast = useToast();

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setItems(await workspaceApi.teamHandovers(SERVER_URL));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Team handovers could not be loaded.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const visible = useMemo(
    () => filter === "all" ? items : items.filter(item => !CLOSED_STATES.has(item.state)),
    [filter, items],
  );

  async function act(itemId: string, action: Action): Promise<void> {
    const actionKey = `${itemId}:${action}`;
    setBusyActions(current => new Set(current).add(actionKey));
    try {
      await submitTeamHandoverAction(itemId, action);
      await load(true);
      toast.success(action === "accept" ? "Handover accepted" : action === "return" ? "Work returned" : action === "withdraw" ? "Offer withdrawn" : "Offer declined");
    } catch (caught) {
      toast.error("Handover action failed", caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyActions(current => {
        const next = new Set(current);
        next.delete(actionKey);
        return next;
      });
    }
  }

  return (
    <TeamHandoversView
      items={items}
      visible={visible}
      filter={filter}
      loading={loading}
      error={error}
      busyActions={busyActions}
      onFilter={setFilter}
      onRefresh={() => void load()}
      onAction={act}
      onOpenTask={onOpenTask}
    />
  );
}

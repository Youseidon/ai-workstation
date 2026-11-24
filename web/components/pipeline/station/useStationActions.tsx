"use client";

import { useState } from "react";
import { describeStopReason } from "@agent-console/shared";
import type { OperationsPrompt, OperationsSuite, PipelineState, ProviderId } from "@agent-console/shared";
import { useDialogs } from "@/components/ui/Dialogs";
import { useToast } from "@/components/ui/Toast";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { workspaceApi } from "@/lib/workspacesApi";

export const DEFAULT_RETRY_RESPONSE =
  "Retry requested with no additional context. Inspect the existing working tree and prior evidence, then continue incomplete work without repeating resolved blockers.";

export interface StationActionContext {
  /** The saved pipeline this board drives, or null on a suite without one. */
  pipelineId: number | null;
  /** State of the pipeline's live run, when there is one. */
  pipelineState: PipelineState | null;
  /** Re-read everything the board shows. Called after every action. */
  refresh(): Promise<unknown>;
  /** Opens the explicit allocation review when an execution limit prevents Run. */
  onAllocationRequired?(promptId: number): void;
}

class AllocationRequiredError extends Error {
  constructor(readonly promptId: number) {
    super("Review the proposed limits and approve a new allocation to continue from the saved work.");
  }
}

/**
 * Why an item-level action is not available right now, or null when it is.
 * One answer, worded for a tooltip, so a disabled button always says why.
 */
export type Gate = string | null;

/**
 * Every action an operator can take on one work item, in one place. The
 * pipeline board and the suite view both use it, so "Respond & resume" means
 * the same thing wherever it is clicked.
 *
 * "Resume" follows the context: on a saved pipeline it plays the rail (which
 * picks the item back up in order), on a bare suite it starts a run for the
 * item directly.
 */
export function useStationActions({ pipelineId, pipelineState, refresh, onAllocationRequired }: StationActionContext) {
  const console_ = useAgentConsole();
  const dialogs = useDialogs();
  const toast = useToast();
  const models = useModelSelection(console_.providers);
  const { selected: preferred } = usePreferredProvider(console_.providers);
  const [busy, setBusy] = useState(false);

  const providerFor = (item: OperationsPrompt): ProviderId => {
    const pinned = item.pipelineRule.provider;
    if (pinned !== null && console_.providers.some((entry) => entry.id === pinned && entry.available)) return pinned;
    return preferred;
  };
  const providerLabel = (provider: ProviderId) =>
    console_.providers.find((entry) => entry.id === provider)?.label ?? provider;
  const modelFor = (item: OperationsPrompt, provider: ProviderId) =>
    item.pipelineRule.provider === provider && item.pipelineRule.model != null ? item.pipelineRule.model : models.resolve(provider);

  const workspaceBusy = (workspaceId: number) =>
    console_.runs.some((run) => run.workspace.id === workspaceId && run.role === "execute");
  const playing = pipelineState === "PLAYING";

  /** Why a manual run of this item cannot start, or null. */
  const runGate = (item: OperationsPrompt): Gate => {
    if (console_.connection !== "open") return "The backend is disconnected";
    if (playing) return "The pipeline is playing — it runs this item in order";
    if (!item.workspace.workDirectoryExists) return "The workspace directory does not exist";
    if (workspaceBusy(item.workspace.id)) return "Another agent is already writing this workspace";
    const provider = providerFor(item);
    if (console_.providers.find((entry) => entry.id === provider)?.available !== true) {
      return `${providerLabel(provider)} is not available`;
    }
    return null;
  };

  /** Runs an operation, refreshes, then toasts. A returned sentence is a shortfall. */
  const act = async (operation: () => Promise<string | void>, success?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const shortfall = await operation();
      await refresh();
      if (typeof shortfall === "string") {
        toast.error("That did not fully work", shortfall);
        return false;
      }
      if (success !== undefined) toast.success(success);
      return true;
    } catch (error) {
      if (error instanceof AllocationRequiredError) {
        onAllocationRequired?.(error.promptId);
        toast.show({
          title: "Approve a new allocation to continue",
          description: error.message,
          tone: "warning",
          duration: 0,
          ...(onAllocationRequired ? { action: { label: "Review new allocation", onClick: () => onAllocationRequired(error.promptId) } } : {}),
        });
        await refresh();
        return false;
      }
      toast.error("That did not work", error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startItem = (item: OperationsPrompt): string | void => {
    const provider = providerFor(item);
    const ok = console_.startRun(item.workspace.id, provider, { promptId: item.prompt.id }, modelFor(item, provider));
    if (!ok) return "The agent connection is unavailable. Run it from Chat.";
  };

  /** Continue after a human step: play the rail, or run the item on a bare suite. */
  const resume = async (item: OperationsPrompt): Promise<string | void> => {
    if (pipelineId !== null) {
      if (playing) return;
      const run = await workspaceApi.playPipeline(SERVER_URL, pipelineId);
      if (run.state === "WAITING_HUMAN") {
        if (run.waitReason === "execution:budget_exhausted") throw new AllocationRequiredError(item.prompt.id);
        return describeStopReason(run.waitReason) ?? "It parked again before any agent started.";
      }
      return;
    }
    return startItem(item);
  };

  const run = (item: OperationsPrompt) =>
    act(async () => resume(item), pipelineId !== null ? "Pipeline is running" : `Run requested for ${label(item)}`);

  const stop = async (item: OperationsPrompt) => {
    const runId = item.prompt.currentRun?.id;
    if (runId === undefined) return false;
    const confirmed = await dialogs.confirm({
      title: "Stop this agent run?",
      description: "Its work so far and its logs are kept. The item will need recovery to continue.",
      confirmLabel: "Stop agent",
      tone: "danger",
    });
    if (!confirmed) return false;
    return act(async () => {
      await workspaceApi.interruptRun(SERVER_URL, runId);
    }, "Agent stopped");
  };

  /** Answer a blocker or an approval point, then continue. */
  const respond = (item: OperationsPrompt, content: string) =>
    act(async () => {
      await workspaceApi.respond(SERVER_URL, item.prompt.id, content.trim() || DEFAULT_RETRY_RESPONSE);
      return resume(item);
    }, pipelineId !== null && playing ? "Response recorded" : "Response sent — resuming");

  const recover = (item: OperationsPrompt) =>
    act(async () => {
      await workspaceApi.recover(SERVER_URL, item.prompt.id);
      return resume(item);
    }, "Recovered and resumed");

  const audit = (item: OperationsPrompt) =>
    act(async () => {
      await workspaceApi.startAudit(SERVER_URL, item.prompt.id);
    }, "Audit started");

  const markComplete = async (item: OperationsPrompt) => {
    const evidence = await dialogs.prompt({
      title: `Mark ${label(item)} complete`,
      description:
        "Records this item as done without running an agent again. Your override is always honoured — including over an unmet definition of done — and is recorded as such.",
      label: "Evidence the work is finished",
      placeholder: "Paste the agent's own summary, a commit, or what you checked…",
      multiline: true,
      confirmLabel: "Mark complete",
      validate: (value) => (value.trim() === "" ? "Evidence is required" : null),
    });
    if (evidence === null) return false;
    return act(async () => {
      await workspaceApi.completePrompt(SERVER_URL, item.prompt.id, evidence.trim());
    }, "Marked complete");
  };

  const skip = async (item: OperationsPrompt) => {
    const confirmed = await dialogs.confirm({
      title: `Skip ${label(item)}?`,
      description: "The pipeline moves straight past it. Skipped work is not retried.",
      confirmLabel: "Skip",
      tone: "danger",
    });
    if (!confirmed) return false;
    return act(async () => {
      await workspaceApi.skipPrompt(SERVER_URL, item.prompt.id, "Operator skipped this item.");
    }, "Skipped");
  };

  /**
   * "Run with context": a note read first by every run of this item until it
   * is done. What happens after saving depends on where the rail is.
   */
  const brief = async (item: OperationsPrompt, running: boolean) => {
    let existing: string[] = [];
    try {
      existing = (await workspaceApi.briefings(SERVER_URL, item.prompt.id)).map((row) => row.content);
    } catch {
      // A failed read only hides the earlier notes; adding one still works.
    }
    const content = await dialogs.prompt({
      title: `Run ${label(item)} with context`,
      description:
        existing.length === 0 ? (
          "Tell the agent what you have already done or decided. It goes at the top of the prompt for this item only."
        ) : (
          <>
            Already noted (the agent reads all of these):
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {existing.map((text, index) => (
                <li key={index} className="line-clamp-3 whitespace-pre-wrap">
                  {text}
                </li>
              ))}
            </ul>
          </>
        ),
      label: "Note for the agent",
      placeholder: "I already ran the backend build and it passes. Continue from the frontend wiring.",
      multiline: true,
      confirmLabel: running ? "Stop & rerun with this" : playing ? "Attach note" : pipelineId !== null ? "Attach & play" : "Attach & run",
      validate: (value) => (value.trim() === "" ? "Write a note first" : null),
    });
    if (content === null) return false;

    if (pipelineId === null) {
      return act(async () => {
        await workspaceApi.addBriefing(SERVER_URL, item.prompt.id, content);
        return startItem(item);
      }, "Running with your note");
    }
    if (running) {
      const confirmed = await dialogs.confirm({
        title: "Stop the running agent?",
        description: "The agent is interrupted and the item starts again with your note at the top of its prompt. Committed work is kept.",
        confirmLabel: "Stop & rerun",
        tone: "danger",
      });
      if (!confirmed) return false;
      return act(async () => {
        await workspaceApi.stopPipeline(SERVER_URL, pipelineId);
        const run = await workspaceApi.playPipeline(SERVER_URL, pipelineId, { briefing: { promptId: item.prompt.id, content } });
        if (run.state === "WAITING_HUMAN") return describeStopReason(run.waitReason) ?? "It parked again before any agent started.";
      }, "Restarted with your note");
    }
    if (playing) {
      return act(async () => {
        await workspaceApi.addBriefing(SERVER_URL, item.prompt.id, content);
      }, "Note attached — read when this item starts");
    }
    return act(async () => {
      const run = await workspaceApi.playPipeline(SERVER_URL, pipelineId, { briefing: { promptId: item.prompt.id, content } });
      if (run.state === "WAITING_HUMAN") return describeStopReason(run.waitReason) ?? "It parked again before any agent started.";
    }, "Pipeline is running with your note");
  };

  const verify = async (suite: OperationsSuite, item: OperationsPrompt | null) => {
    const provider = item === null ? preferred : providerFor(item);
    const model = item === null ? models.resolve(provider) : modelFor(item, provider);
    const scope = item === null ? `${suite.prompts.length} work item${suite.prompts.length === 1 ? "" : "s"} in ${suite.key ?? suite.name}` : label(item);
    const confirmed = await dialogs.confirm({
      title: item === null ? "Verify suite with an agent?" : "Verify this item with an agent?",
      description: (
        <>
          Starts a read-only run with <b className="text-fg-muted">{providerLabel(provider)}</b>
          {model !== null && <> · <b className="text-fg-muted">{model}</b></>} against {scope}. It changes
          nothing in the working tree and writes a report that is kept.
        </>
      ),
      confirmLabel: "Start verification",
    });
    if (!confirmed) return false;
    if (!console_.verifySuite(suite.id, provider, model, item?.prompt.id ?? null)) {
      toast.error("Could not start verification", "The agent connection is unavailable.");
      return false;
    }
    toast.info("Verification started", `${scope} is being checked by ${providerLabel(provider)}.`);
    return true;
  };

  const auditEvidence = async (suite: OperationsSuite): Promise<number | null> => {
    const count = suite.prompts.length;
    const confirmed = await dialogs.confirm({
      title: "Audit recorded evidence?",
      description: `No agent runs. This re-reads the evidence already stored for each of the ${count} work item${count === 1 ? "" : "s"} and writes a dated audit record with a verdict. Your working tree is not read or changed.`,
      confirmLabel: "Run audit",
    });
    if (!confirmed) return null;
    let id: number | null = null;
    await act(async () => {
      const record = await workspaceApi.auditSuite(SERVER_URL, suite.id);
      id = record.id;
    }, "Audit recorded");
    return id;
  };

  return {
    busy,
    act,
    runGate,
    providerFor,
    providerLabel,
    run,
    stop,
    respond,
    recover,
    audit,
    markComplete,
    skip,
    brief,
    verify,
    auditEvidence,
  };
}

export type StationActions = ReturnType<typeof useStationActions>;

function label(item: OperationsPrompt): string {
  return item.prompt.externalKey ?? item.prompt.title;
}

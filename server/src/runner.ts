import type {
  AdapterEvent,
  NormalizedEvent,
  ProviderId,
  ResultPayload,
  RunRole,
  RunState,
  StatusPayload,
  TokenUsage,
} from "@agent-console/shared";
import { billableInputTokens, isMeaningfulUsage, mergeUsage } from "@agent-console/shared";
import { permissionForRun, settings } from "./settings.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import type { AgentAdapter, PermissionOverride } from "./adapters/types.ts";

/** How long a provider gets to stop cleanly before the run is hard-aborted. */
const INTERRUPT_GRACE_MS = 2000;
/** Fraction of any budget at which the run is warned to bank its work. */
const BUDGET_WARN_FRACTION = 0.8;
const redactRunCredentials=(value:string)=>value.replace(/Bearer\s+[A-Za-z0-9_-]{20,}/g,"Bearer [REDACTED_RUN_TOKEN]");
function redactValue(value:unknown):unknown { if(typeof value==="string")return redactRunCredentials(value);if(Array.isArray(value))return value.map(redactValue);if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactValue(item)]));return value; }

/**
 * Keeps a tool result readable while stopping one command from flooding the
 * context. Head and tail both survive because the interesting parts of a long
 * output are the first lines (what ran) and the last (how it ended); the middle
 * of a 60 KB build log is what nobody needs and everybody pays for on every
 * subsequent turn.
 */
export function truncateToolOutput(output: string, limit: number): { output: string; truncated: boolean } {
  if (limit <= 0 || output.length <= limit) return { output, truncated: false };
  const head = Math.max(0, Math.floor(limit * 0.6));
  const tail = Math.max(0, limit - head);
  const omitted = output.length - head - tail;
  const marker = `\n\n… [${omitted.toLocaleString()} characters omitted by the orchestrator; re-run a narrower command if you need the middle] …\n\n`;
  return { output: `${output.slice(0, head)}${marker}${output.slice(output.length - tail)}`, truncated: true };
}

/**
 * What a run is allowed to spend. Enforced here rather than per adapter, so a
 * provider without its own turn limit is bounded exactly like one that has it.
 * `null` disables an individual budget.
 */
export interface RunBudget {
  maxToolCalls: number | null;
  maxWallClockMs: number | null;
  maxInputTokens: number | null;
  maxToolOutputBytes: number | null;
  /** Consecutive identical tool calls tolerated before the run is stopped. */
  noProgressToolCalls: number | null;
  /** Per-result cap; 0 disables truncation. */
  maxToolResultBytes: number;
}

/** A snapshot with every budget disabled, for tests and unmetered roles. */
export function emptyBudgetSnapshot(): BudgetSnapshot {
  const none = { used: 0, limit: null };
  return { toolCalls: none, wallClockMs: none, inputTokens: none, toolOutputBytes: none, pressure: 0, warning: null, exhausted: false };
}

/** What a run actually spent. Persisted on `agent_run` when it ends. */
export interface RunMetrics {
  usage: TokenUsage | null;
  toolCalls: number;
  toolOutputBytes: number;
  /** Set when the runner stopped the run itself. */
  stopReason: string | null;
}

/** Live budget state, surfaced to the agent through the Progress API. */
export interface BudgetSnapshot {
  toolCalls: { used: number; limit: number | null };
  wallClockMs: { used: number; limit: number | null };
  /** Cost-weighted: cache reads count at their cache-read rate, not in full. */
  inputTokens: { used: number; limit: number | null };
  toolOutputBytes: { used: number; limit: number | null };
  /** 0-1, the highest utilisation across all active budgets. */
  pressure: number;
  warning: string | null;
  exhausted: boolean;
}

export interface RunHandle {
  runId: string;
  provider: ProviderId;
  /** Resolved once at start, so `run_started` and every event agree. */
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  interrupt(): Promise<void>;
  /** Stop the provider after it has posted its authoritative terminal status. */
  complete?(): Promise<void>;
  /** Live budget state, for the Progress API to hand back to the agent. */
  budget(): BudgetSnapshot;
  done: Promise<Extract<RunState, "done" | "interrupted" | "error">>;
}

export interface StartRunArgs {
  runId?: string;
  adapter: AgentAdapter;
  prompt: string;
  cwd: string;
  /** Model picked in the UI for this run; falls back to the adapter's setting. */
  model?: string | null;
  role?: RunRole;
  permissionOverride?: PermissionOverride;
  /** Decomposition depth of the work item; sub-steps get a smaller allowance. */
  budgetDepth?: number;
  /** Omitted budgets fall back to the settings defaults for this run's depth. */
  budget?: Partial<RunBudget>;
  onEvent(event: NormalizedEvent): void;
  onEnd(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">, metrics: RunMetrics): void;
}

export function runRoleStartError(role: RunRole, provider: string): string | null {
  if ((role === "consult" || role === "handoff") && provider === "cursor") return `Cursor cannot run as a ${role}; it has no sandbox.`;
  return null;
}

/**
 * Owns everything that is true of a run regardless of provider: the run id,
 * server-side elapsed clock, periodic status heartbeat, cumulative token usage,
 * and terminal state. Adapters only describe what the agent did.
 */
export function startRun(args: StartRunArgs): RunHandle {
  const { adapter, prompt } = args;
  const runId = args.runId ?? newId("run");
  const provider = adapter.id;
  const log = createLogger(`${provider}:${runId.slice(4, 12)}`);
  const cwd = args.cwd;
  // Resolved once: settings could change mid-run, but a run reports the model
  // it actually started with from its first event to its last.
  const model = args.model ?? adapter.model;
  const role = args.role ?? "execute";
  const permissionOverride: PermissionOverride =
    role === "consult" ? "consult" : role === "handoff" ? "handoff" : (args.permissionOverride ?? "inherit");
  const resolvedPermission = permissionForRun(provider, permissionOverride);
  const permissionMode = permissionOverride === "inherit" ? null : resolvedPermission.mode;

  const startedAt = Date.now();
  const abortController = new AbortController();
  let usage: TokenUsage | null = null;
  let finished = false;
  let interruptRequested = false;
  let completionRequested = false;

  // Consults and handoffs are single-shot reads; the budgets exist to bound the
  // open-ended execute loop, so only that role is metered.
  const defaults = settings.budgetFor(role === "execute" ? (args.budgetDepth ?? 0) : 0);
  const budget: RunBudget = {
    maxToolCalls: args.budget?.maxToolCalls !== undefined ? args.budget.maxToolCalls : defaults.maxToolCalls,
    maxWallClockMs: args.budget?.maxWallClockMs !== undefined ? args.budget.maxWallClockMs : defaults.maxWallClockMs,
    maxInputTokens: args.budget?.maxInputTokens !== undefined ? args.budget.maxInputTokens : defaults.maxInputTokens,
    maxToolOutputBytes: args.budget?.maxToolOutputBytes !== undefined ? args.budget.maxToolOutputBytes : defaults.maxToolOutputBytes,
    noProgressToolCalls: args.budget?.noProgressToolCalls !== undefined ? args.budget.noProgressToolCalls : defaults.noProgressToolCalls,
    maxToolResultBytes: args.budget?.maxToolResultBytes ?? defaults.maxToolResultBytes,
  };
  let toolCalls = 0;
  let toolOutputBytes = 0;
  let repeatSignature: string | null = null;
  let repeatCount = 0;
  let budgetStopReason: string | null = null;
  let warned = false;

  const elapsed = () => Date.now() - startedAt;

  const ratio = (used: number, limit: number | null): number =>
    limit === null || limit <= 0 ? 0 : used / limit;

  // What the input budget meters: cache reads discounted to their real cost.
  const spentInputTokens = (): number => billableInputTokens(usage, provider, model);

  const budgetSnapshot = (): BudgetSnapshot => {
    const inputTokens = spentInputTokens();
    const pressure = Math.max(
      ratio(toolCalls, budget.maxToolCalls),
      ratio(elapsed(), budget.maxWallClockMs),
      ratio(inputTokens, budget.maxInputTokens),
      ratio(toolOutputBytes, budget.maxToolOutputBytes),
    );
    return {
      toolCalls: { used: toolCalls, limit: budget.maxToolCalls },
      wallClockMs: { used: elapsed(), limit: budget.maxWallClockMs },
      inputTokens: { used: inputTokens, limit: budget.maxInputTokens },
      toolOutputBytes: { used: toolOutputBytes, limit: budget.maxToolOutputBytes },
      pressure,
      warning: pressure >= BUDGET_WARN_FRACTION && budgetStopReason === null
        ? "You have used most of this run's budget. Bank your work now: post a PROGRESS remark recording exactly what is verified, then post DONE or BLOCKED, or decompose the remainder. Do not start new investigation."
        : null,
      exhausted: budgetStopReason !== null,
    };
  };

  /** Returns a stop reason once any budget is spent, otherwise null. */
  const breachedBudget = (): string | null => {
    if (budget.maxToolCalls !== null && toolCalls >= budget.maxToolCalls) return `budget_tool_calls:${budget.maxToolCalls}`;
    if (budget.maxWallClockMs !== null && elapsed() >= budget.maxWallClockMs) return `budget_wall_clock_ms:${budget.maxWallClockMs}`;
    if (budget.maxInputTokens !== null && spentInputTokens() >= budget.maxInputTokens) return `budget_input_tokens:${budget.maxInputTokens}`;
    if (budget.maxToolOutputBytes !== null && toolOutputBytes >= budget.maxToolOutputBytes) return `budget_tool_output_bytes:${budget.maxToolOutputBytes}`;
    if (budget.noProgressToolCalls !== null && repeatCount >= budget.noProgressToolCalls) return `budget_no_progress:${budget.noProgressToolCalls}`;
    return null;
  };

  const stampUsage = (incoming: TokenUsage | null | undefined): TokenUsage | null =>
    isMeaningfulUsage(incoming) ? incoming : usage;

  const stamp = (event: AdapterEvent): NormalizedEvent => {
    const base = { id: newId("evt"), runId, provider, model, timestamp: new Date().toISOString() };
    switch (event.type) {
      case "status": {
        const payload: StatusPayload = {
          state: event.payload.state ?? "running",
          elapsedMs: event.payload.elapsedMs ?? elapsed(),
          usage: stampUsage(event.payload.usage),
          detail: event.payload.detail ?? null,
        };
        return { ...base, type: "status", payload };
      }
      case "result": {
        const payload: ResultPayload = {
          state: event.payload.state ?? "done",
          elapsedMs: event.payload.elapsedMs ?? elapsed(),
          usage: stampUsage(event.payload.usage),
          text: event.payload.text ?? null,
          exitCode: event.payload.exitCode ?? null,
        };
        return { ...base, type: "result", payload };
      }
      case "error":
        return {
          ...base,
          type: "error",
          payload: {
            message: event.payload.message,
            fatal: event.payload.fatal ?? false,
            detail: event.payload.detail ?? null,
          },
        };
      case "assistant_text":
        return { ...base, type: "assistant_text", payload: { ...event.payload, text:redactRunCredentials(event.payload.text) } };
      case "tool_use":
        return { ...base, type: "tool_use", payload: { ...event.payload, summary:redactRunCredentials(event.payload.summary), input:redactValue(event.payload.input) } };
      case "tool_result": {
        const redacted = redactRunCredentials(event.payload.output);
        const { output } = truncateToolOutput(redacted, budget.maxToolResultBytes);
        return { ...base, type: "tool_result", payload: { ...event.payload, summary:redactRunCredentials(event.payload.summary), output } };
      }
    }
  };

  const emit = (event: AdapterEvent) => {
    const normalized = stamp(event);
    if (normalized.type === "status" || normalized.type === "result") {
      usage = mergeUsage(usage, normalized.payload.usage);
    }
    if (normalized.type === "tool_use") {
      toolCalls += 1;
      // A thrash loop repeats the same call with the same input. Hashing the
      // head of the input rather than all of it keeps a long file write from
      // looking unique on a trailing byte.
      const signature = `${normalized.payload.name}:${JSON.stringify(normalized.payload.input).slice(0, 200)}`;
      if (signature === repeatSignature) repeatCount += 1;
      else { repeatSignature = signature; repeatCount = 1; }
    }
    if (normalized.type === "tool_result") {
      toolOutputBytes += Buffer.byteLength(normalized.payload.output);
      // A write means the run is making progress, whatever it repeated to get there.
      if (!normalized.payload.isError) repeatCount = Math.min(repeatCount, 1);
    }
    args.onEvent(normalized);
    if (finished || budgetStopReason !== null) return;
    if (!warned && budgetSnapshot().pressure >= BUDGET_WARN_FRACTION) {
      warned = true;
      log.warn(`budget at ${Math.round(budgetSnapshot().pressure * 100)}%`);
    }
    const breach = breachedBudget();
    if (breach !== null) {
      budgetStopReason = breach;
      log.warn(`budget exhausted (${breach}); stopping run`);
      void stopForBudget();
    }
  };

  /**
   * Ends the run the same way a posted terminal status does, rather than
   * aborting. An abort loses everything the run has done; the caller records
   * BLOCKED with whatever was banked, so the work is resumable.
   */
  const stopForBudget = async (): Promise<void> => {
    completionRequested = true;
    void adapter.interrupt(runId).catch((error: unknown) => log.warn("budget stop failed", error));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, INTERRUPT_GRACE_MS));
    if (!finished) abortController.abort();
  };

  emit({
    type: "status",
    payload: { state: "starting", detail: model === null ? `cwd ${cwd}` : `${model} · cwd ${cwd}` },
  });

  // Server-side clock: the browser renders what the server reports rather than
  // running its own timer that drifts from the real run.
  const ticker = setInterval(() => {
    if (finished) return;
    emit({ type: "status", payload: { state: "running" } });
  }, Math.max(250, settings.statusIntervalMs));

  const done = (async (): Promise<Extract<RunState, "done" | "interrupted" | "error">> => {
    let finalState: Extract<RunState, "done" | "interrupted" | "error"> = "done";
    let sawResult = false;
    let sawFatalError = false;
    try {
      for await (const incoming of adapter.run(prompt, {
        runId,
        cwd,
        model,
        signal: abortController.signal,
        log,
        permissionOverride,
      })) {
        const event = completionRequested && incoming.type === "result"
          ? { ...incoming, payload: { ...incoming.payload, state: "done" as const } }
          : incoming;
        if (event.type === "result") {
          sawResult = true;
          finalState = event.payload.state ?? "done";
          // No more heartbeats once the provider has reported a terminal state.
          clearInterval(ticker);
        }
        if (event.type === "error" && event.payload.fatal === true) sawFatalError = true;
        emit(event);
      }
      if (!sawResult) {
        finalState = completionRequested ? "done" : interruptRequested ? "interrupted" : sawFatalError ? "error" : "done";
        emit({ type: "result", payload: { state: finalState } });
      }
    } catch (error) {
      finalState = completionRequested ? "done" : interruptRequested ? "interrupted" : "error";
      log.error("adapter threw", error);
      if (finalState === "error") {
        emit({
          type: "error",
          payload: {
            message: `${adapter.label} failed`,
            fatal: true,
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
      emit({ type: "result", payload: { state: finalState } });
    } finally {
      finished = true;
      clearInterval(ticker);
    }

    emit({ type: "status", payload: { state: finalState } });
    log.info(`run ${finalState} in ${elapsed()}ms · ${toolCalls} tool calls · ${toolOutputBytes} bytes of tool output`);
    args.onEnd(runId, finalState, { usage, toolCalls, toolOutputBytes, stopReason: budgetStopReason });
    return finalState;
  })();

  return {
    runId,
    provider,
    model,
    role,
    permissionMode,
    budget: budgetSnapshot,
    async interrupt() {
      if (finished) return;
      interruptRequested = true;
      log.info("interrupt requested");
      // Ask the adapter to stop gracefully, but never block on it: a provider
      // whose interrupt hangs must not leave the run un-cancellable.
      void adapter.interrupt(runId).catch((error: unknown) => log.warn("graceful interrupt failed", error));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, INTERRUPT_GRACE_MS));
      if (!finished) {
        log.warn("graceful interrupt did not finish the run; aborting");
        abortController.abort();
      }
    },
    async complete() {
      if (finished) return;
      completionRequested = true;
      log.info("terminal status posted; stopping provider");
      // The provider transports only expose cancellation. At this point the
      // database status is authoritative, so cancellation is translated to a
      // successful process end by the runner.
      void adapter.interrupt(runId).catch((error: unknown) => log.warn("completion stop failed", error));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, INTERRUPT_GRACE_MS));
      if (!finished) {
        log.warn("provider did not stop after terminal status; aborting");
        abortController.abort();
      }
    },
    done,
  };
}

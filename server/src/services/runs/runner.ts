import type { RunBudget, BudgetSnapshot, RunHandle, StartRunArgs } from "../../contracts/runs.ts";
import { createHash } from "node:crypto";
import type {
  AdapterEvent,
  NormalizedEvent,
  ProviderId,
  ResultPayload,
  RunRole,
  RunState,
  StatusPayload,
  TokenUsage,
} from "@hydra/shared";
import {
  billableInputTokens,
  inputTokenAllowance,
  eligibleModels,
  isMeaningfulUsage,
  mergeUsage,
  MODEL_CATALOG,
  modelAllowedInTier,
  modelMatchesEffort,
  recommendedModel,
} from "@hydra/shared";
import { permissionForRun, settings } from "../../config/settings.ts";
import { newId } from "../../utils/ids.ts";
import { createLogger } from "../../utils/logger.ts";
import type { PermissionOverride } from "../../contracts/agentAdapter.ts";

const INTERRUPT_GRACE_MS = 2000;
const BUDGET_WARN_FRACTION = 0.8;
const redactRunCredentials=(value:string)=>value.replace(/Bearer\s+[A-Za-z0-9_-]{20,}/g,"Bearer [REDACTED_RUN_TOKEN]");
function redactValue(value:unknown):unknown { if(typeof value==="string")return redactRunCredentials(value);if(Array.isArray(value))return value.map(redactValue);if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactValue(item)]));return value; }

export function truncateToolOutput(output: string, limit: number): { output: string; truncated: boolean } {
  if (limit <= 0 || output.length <= limit) return { output, truncated: false };
  const head = Math.max(0, Math.floor(limit * 0.6));
  const tail = Math.max(0, limit - head);
  const omitted = output.length - head - tail;
  const marker = `\n\n… [${omitted.toLocaleString()} characters omitted by the orchestrator; re-run a narrower command if you need the middle] …\n\n`;
  return { output: `${output.slice(0, head)}${marker}${output.slice(output.length - tail)}`, truncated: true };
}

export function emptyBudgetSnapshot(): BudgetSnapshot {
  const none = { used: 0, limit: null };
  return { toolCalls: none, wallClockMs: none, inputTokens: none, toolOutputBytes: none, openToolCallMs: none, pressure: 0, warning: null, exhausted: false };
}

export function runRoleStartError(role: RunRole, provider: string): string | null {
  if ((role === "consult" || role === "handoff") && provider === "cursor") return `Cursor read-only ${role} isolation is not supported by this adapter.`;
  return null;
}

export function startRun(args: StartRunArgs): RunHandle {
  const { adapter, prompt } = args;
  const runId = args.runId ?? newId("run");
  const provider = adapter.id;
  const log = createLogger(`${provider}:${runId.slice(4, 12)}`);
  const cwd = args.cwd;
  const requestedModel = args.model ?? adapter.model;
  const tier = settings.modelAccessTier;
  const effort = settings.reasoningEffortFor(provider);
  const allowed = modelAllowedInTier(provider, requestedModel, tier)
    && modelMatchesEffort(provider, requestedModel, effort);
  const fallbackTier = tier === "all" ? "frontier" : tier;
  const model = args.preserveModel || allowed || settings.modelSelectionMode === "auto"
    ? requestedModel
    : recommendedModel(
      provider,
      eligibleModels(provider, MODEL_CATALOG[provider], fallbackTier, effort),
      fallbackTier,
    );
  if (tier !== "all" && model === null) {
    throw new Error(`No ${tier} model is available for ${provider}`);
  }
  const role = args.role ?? "execute";
  const permissionOverride: PermissionOverride =
    role === "consult" ? "consult" : role === "handoff" ? "handoff" : (args.permissionOverride ?? "inherit");
  const resolvedPermission = permissionForRun(provider, permissionOverride);
  const permissionMode = permissionOverride === "inherit" ? null : resolvedPermission.mode;

  const startedAt = Date.now();
  const abortController = new AbortController();
  let usage: TokenUsage | null = null;
  let sessionId: string | null = args.resumeSessionId ?? null;
  let finished = false;
  let interruptRequested = false;
  let completionRequested = false;

  const base = settings.budgetFor();
  const budget: RunBudget = {
    maxTotalTokens:args.budget?.maxTotalTokens ?? null,
    maxToolCalls: args.budget?.maxToolCalls !== undefined ? args.budget.maxToolCalls : base.maxToolCalls,
    maxWallClockMs: args.budget?.maxWallClockMs !== undefined ? args.budget.maxWallClockMs : base.maxWallClockMs,
    maxInputTokens: args.budget?.maxInputTokens !== undefined
      ? args.budget.maxInputTokens
      : inputTokenAllowance(base.maxSpendUsd, provider, model),
    maxToolOutputBytes: args.budget?.maxToolOutputBytes !== undefined ? args.budget.maxToolOutputBytes : base.maxToolOutputBytes,
    noProgressToolCalls: args.budget?.noProgressToolCalls !== undefined ? args.budget.noProgressToolCalls : base.noProgressToolCalls,
    maxToolResultBytes: args.budget?.maxToolResultBytes ?? base.maxToolResultBytes,
    maxOpenToolCallMs: args.budget?.maxOpenToolCallMs !== undefined ? args.budget.maxOpenToolCallMs : base.maxOpenToolCallMs,
  };
  let processStarted:boolean|null=args.onSpawn ? false : null;
  let toolCalls = 0;
  let toolOutputBytes = 0;
  let repeatSignature: string | null = null;
  let repeatCount = 0;
  let budgetStopReason: string | null = null;
  let peakMemoryBytes: number | null = null;
  const openTools = new Map<string, { startedAt: number; timer: NodeJS.Timeout | null }>();
  let warned = false;

  const elapsed = () => Date.now() - startedAt;

  const ratio = (used: number, limit: number | null): number =>
    limit === null || limit <= 0 ? 0 : used / limit;

  const spentInputTokens = (): number => billableInputTokens(usage, provider, model);

  const budgetSnapshot = (): BudgetSnapshot => {
    const inputTokens = spentInputTokens();
    const oldestOpenToolMs = Math.max(0, ...[...openTools.values()].map((tool) => Date.now() - tool.startedAt));
    const pressure = Math.max(
      ratio(toolCalls, budget.maxToolCalls),
      ratio(elapsed(), budget.maxWallClockMs),
      ratio(inputTokens, budget.maxInputTokens),
      ratio(toolOutputBytes, budget.maxToolOutputBytes),
      ratio(oldestOpenToolMs, budget.maxOpenToolCallMs),
    );
    return {
      toolCalls: { used: toolCalls, limit: budget.maxToolCalls },
      wallClockMs: { used: elapsed(), limit: budget.maxWallClockMs },
      inputTokens: { used: inputTokens, limit: budget.maxInputTokens },
      toolOutputBytes: { used: toolOutputBytes, limit: budget.maxToolOutputBytes },
      openToolCallMs: { used: oldestOpenToolMs, limit: budget.maxOpenToolCallMs },
      pressure,
      warning: pressure >= BUDGET_WARN_FRACTION && budgetStopReason === null
        ? "You have used most of this run's budget. Bank your work now: post a PROGRESS remark recording exactly what is verified, then post DONE or BLOCKED, or decompose the remainder. Do not start new investigation."
        : null,
      exhausted: budgetStopReason !== null,
    };
  };

  const breachedBudget = (): string | null => {
    if(budget.maxTotalTokens!==null && budget.maxTotalTokens!==undefined && usage && Math.max(usage.totalTokens,usage.inputTokens+usage.outputTokens)>=budget.maxTotalTokens) return `budget_total_tokens:${budget.maxTotalTokens}`;

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
          ...(event.payload.sessionId === undefined ? {} : { sessionId: event.payload.sessionId }),
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
          stopReason: event.payload.stopReason ?? null,
          peakMemoryBytes: event.payload.peakMemoryBytes ?? null,
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
    if (normalized.type === "status" && sessionId === null) {
      const announced = normalized.payload.sessionId;
      if (typeof announced === "string" && announced !== "") sessionId = announced;
    }
    if (normalized.type === "tool_use") {
      toolCalls += 1;
      const signature = `${normalized.payload.name}:${createHash("sha256").update(JSON.stringify(normalized.payload.input)).digest("hex")}`;
      if (signature === repeatSignature) repeatCount += 1;
      else { repeatSignature = signature; repeatCount = 1; }
      const previous = openTools.get(normalized.payload.toolUseId);
      if (previous?.timer !== null && previous?.timer !== undefined) clearTimeout(previous.timer);
      const timer = budget.maxOpenToolCallMs === null ? null : setTimeout(() => {
        if (finished || budgetStopReason !== null || !openTools.has(normalized.payload.toolUseId)) return;
        budgetStopReason = `budget_open_tool_call_ms:${budget.maxOpenToolCallMs}`;
        log.warn(`tool ${normalized.payload.name} (${normalized.payload.toolUseId}) remained open; stopping run (${budgetStopReason})`);
        emit({
          type: "error",
          payload: {
            message: `Tool call ${normalized.payload.name} did not return within ${budget.maxOpenToolCallMs}ms`,
            fatal: true,
            detail: budgetStopReason,
          },
        });
        void stopForBudget();
      }, budget.maxOpenToolCallMs);
      timer?.unref();
      openTools.set(normalized.payload.toolUseId, { startedAt: Date.now(), timer });
    }
    if (normalized.type === "tool_result") {
      const open = openTools.get(normalized.payload.toolUseId);
      if (open?.timer !== null && open?.timer !== undefined) clearTimeout(open.timer);
      openTools.delete(normalized.payload.toolUseId);
      toolOutputBytes += Buffer.byteLength(normalized.payload.output);
    }
    if (normalized.type === "result") {
      if (normalized.payload.stopReason !== null && normalized.payload.stopReason !== undefined) {
        budgetStopReason = normalized.payload.stopReason;
      }
      if (normalized.payload.peakMemoryBytes !== null && normalized.payload.peakMemoryBytes !== undefined) {
        peakMemoryBytes = normalized.payload.peakMemoryBytes;
      }
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
        stationPolicy: args.stationPolicy,
        launcherPath: args.launcherPath,
        deadlineMs:budget.maxWallClockMs ?? undefined,
        resumeSessionId: args.resumeSessionId ?? null,
        onSpawn: args.onSpawn ? identity=>{processStarted=true;args.onSpawn!(identity);} : undefined,
      })) {
        const event = completionRequested && incoming.type === "result"
          ? { ...incoming, payload: { ...incoming.payload, state: "done" as const } }
          : incoming;
        if (event.type === "result") {
          sawResult = true;
          finalState = event.payload.state ?? "done";
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
      for (const open of openTools.values()) if (open.timer !== null) clearTimeout(open.timer);
      openTools.clear();
    }

    emit({ type: "status", payload: { state: finalState } });
    log.info(`run ${finalState} in ${elapsed()}ms · ${toolCalls} tool calls · ${toolOutputBytes} bytes of tool output`);
    args.onEnd(runId, finalState, { usage, toolCalls, toolOutputBytes, stopReason: budgetStopReason, peakMemoryBytes, sessionId, processStarted });
    return finalState;
  })();

  return {
    runId,
    provider,
    model,
    role,
    permissionMode,
    budget: budgetSnapshot,
    sessionId: () => sessionId,
    async interrupt() {
      if (finished) return;
      interruptRequested = true;
      log.info("interrupt requested");
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

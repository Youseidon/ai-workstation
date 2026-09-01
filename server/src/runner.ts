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
import { isMeaningfulUsage, mergeUsage } from "@agent-console/shared";
import { permissionForRun, settings } from "./settings.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import type { AgentAdapter, PermissionOverride } from "./adapters/types.ts";

/** How long a provider gets to stop cleanly before the run is hard-aborted. */
const INTERRUPT_GRACE_MS = 2000;
const redactRunCredentials=(value:string)=>value.replace(/Bearer\s+[A-Za-z0-9_-]{20,}/g,"Bearer [REDACTED_RUN_TOKEN]");
function redactValue(value:unknown):unknown { if(typeof value==="string")return redactRunCredentials(value);if(Array.isArray(value))return value.map(redactValue);if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactValue(item)]));return value; }

export interface RunHandle {
  runId: string;
  provider: ProviderId;
  /** Resolved once at start, so `run_started` and every event agree. */
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  interrupt(): Promise<void>;
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
  onEvent(event: NormalizedEvent): void;
  onEnd(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">): void;
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

  const elapsed = () => Date.now() - startedAt;

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
      case "tool_result":
        return { ...base, type: "tool_result", payload: { ...event.payload, summary:redactRunCredentials(event.payload.summary), output:redactRunCredentials(event.payload.output) } };
    }
  };

  const emit = (event: AdapterEvent) => {
    const normalized = stamp(event);
    if (normalized.type === "status" || normalized.type === "result") {
      usage = mergeUsage(usage, normalized.payload.usage);
    }
    args.onEvent(normalized);
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
    try {
      for await (const event of adapter.run(prompt, {
        runId,
        cwd,
        model,
        signal: abortController.signal,
        log,
        permissionOverride,
      })) {
        if (event.type === "result") {
          sawResult = true;
          finalState = event.payload.state ?? "done";
          // No more heartbeats once the provider has reported a terminal state.
          clearInterval(ticker);
        }
        emit(event);
      }
      if (!sawResult) {
        finalState = interruptRequested ? "interrupted" : "done";
        emit({ type: "result", payload: { state: finalState } });
      }
    } catch (error) {
      finalState = interruptRequested ? "interrupted" : "error";
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
    log.info(`run ${finalState} in ${elapsed()}ms`);
    args.onEnd(runId, finalState);
    return finalState;
  })();

  return {
    runId,
    provider,
    model,
    role,
    permissionMode,
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
    done,
  };
}

export interface QueuedChatScope {
  workspace: number;
  provider: string;
  model: string | null;
  permission: string | undefined;
  savedPromptId: number | null;
  directory: string;
  fresh: boolean;
}

/** Queued actions never silently acquire a changed target or permission scope. */
export function queuedScopeChanged(queued: QueuedChatScope, current: QueuedChatScope, connected: boolean): boolean {
  return !connected || (Object.keys(current) as (keyof QueuedChatScope)[]).some(key => queued[key] !== current[key]);
}

/** Acceptance is correlated by request identity, never provider or prompt text. */
export function settleAcceptedRequest<T extends { requestId: string }>(pending: T[], requestId: string | undefined): T[] {
  return requestId === undefined ? pending : pending.filter(request => request.requestId !== requestId);
}

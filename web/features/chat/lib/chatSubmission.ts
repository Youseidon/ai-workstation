export interface QueuedChatScope {
  workspace: number;
  provider: string;
  model: string | null;
  permission: string | undefined;
  savedPromptId: number | null;
  directory: string;
  fresh: boolean;
}

export function queuedScopeChanged(queued: QueuedChatScope, current: QueuedChatScope, connected: boolean): boolean {
  return !connected || (Object.keys(current) as (keyof QueuedChatScope)[]).some(key => queued[key] !== current[key]);
}

export function settleAcceptedRequest<T extends { requestId: string }>(pending: T[], requestId: string | undefined): T[] {
  return requestId === undefined ? pending : pending.filter(request => request.requestId !== requestId);
}

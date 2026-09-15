import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/*
 * Node's fetch and https race IPv4 and IPv6 but give each connection attempt
 * only 250ms by default. Where IPv6 has no route and IPv4 to api.telegram.org
 * takes longer than that to connect (WSL, some home networks), every request
 * fails with ETIMEDOUT although the host is reachable. The server sets the same
 * value in server/src/index.ts; every harness process that talks to real
 * Telegram calls this first. Global to the process, so safe to call again.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

export function allowSlowConnects(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}

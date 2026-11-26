/**
 * The backend origin. Inlined at build time by `next.config.ts` from the repo
 * root `.env`, and defined once here so pages cannot drift apart.
 */
const configured = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000";
const url = new URL(configured);
// Loopback aliases must agree with the page host for SameSite cookies to work.
if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(url.hostname) && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  url.hostname = window.location.hostname;
}
export const SERVER_URL = url.origin;

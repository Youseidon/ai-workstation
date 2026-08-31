/**
 * The backend origin. Inlined at build time by `next.config.ts` from the repo
 * root `.env`, and defined once here so pages cannot drift apart.
 */
export const SERVER_URL = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000";

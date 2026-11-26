const configured = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000";
const url = new URL(configured);
if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(url.hostname) && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  url.hostname = window.location.hostname;
}
export const SERVER_URL = url.origin;

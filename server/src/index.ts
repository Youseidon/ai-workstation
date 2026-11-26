import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node's happy-eyeballs gives each resolved address 250 ms before trying the
// next. On WSL2 and other hosts without a working IPv6 route, IPv6 fails
// instantly and a slower IPv4 handshake (Telegram measured ~285 ms) is
// abandoned, so fetch reports ETIMEDOUT although the host is reachable.
// Applies to both the gateway and account runtimes started from here.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

if (process.argv.includes("--identity-worker")) {
  if (!process.env.HYDRA_WORKER_SECRET) throw new Error("Account runtimes require a gateway credential.");
  await import("./api/server.ts");
} else {
  await import("./api/identityGateway.ts");
}

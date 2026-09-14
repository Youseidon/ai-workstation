import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// The end-to-end harness builds and serves its own copy of the app next to the
// operator's dev server. In harness mode the repository .env (which holds the
// real bot token) is never loaded, output goes to a separate build directory so
// `next dev`'s web/.next is untouched, and the server URL must be explicit so a
// forgotten variable cannot silently point the harness at the operator's app.
const harnessMode = process.env.AGENT_CONSOLE_HARNESS === "1";

if (harnessMode) {
  if (!process.env.NEXT_PUBLIC_AGENT_SERVER_URL) {
    throw new Error("Harness mode requires NEXT_PUBLIC_AGENT_SERVER_URL.");
  }
  if (!process.env.AGENT_CONSOLE_WEB_DIST_DIR || process.env.AGENT_CONSOLE_WEB_DIST_DIR === ".next") {
    throw new Error("Harness mode requires AGENT_CONSOLE_WEB_DIST_DIR other than .next.");
  }
} else {
  // One .env at the repo root configures both processes; Next would otherwise
  // only look inside web/.
  loadEnv({ path: "../.env", quiet: true });
}

const nextConfig: NextConfig = {
  ...(harnessMode ? { distDir: process.env.AGENT_CONSOLE_WEB_DIST_DIR } : {}),
  // The event schema lives in a workspace package of raw TypeScript, shared
  // verbatim with the server so the two can never drift.
  transpilePackages: ["@agent-console/shared"],
  // Hide the Next.js "N" route/bundler indicator in the bottom-left corner.
  // Compile and runtime errors still surface; this only removes the badge.
  devIndicators: false,
  env: {
    NEXT_PUBLIC_AGENT_SERVER_URL:
      process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000",
  },
};

export default nextConfig;

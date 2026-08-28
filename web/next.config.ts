import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// One .env at the repo root configures both processes; Next would otherwise
// only look inside web/.
loadEnv({ path: "../.env", quiet: true });

const nextConfig: NextConfig = {
  // The event schema lives in a workspace package of raw TypeScript, shared
  // verbatim with the server so the two can never drift.
  transpilePackages: ["@agent-console/shared"],
  env: {
    NEXT_PUBLIC_AGENT_SERVER_URL:
      process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000",
  },
};

export default nextConfig;

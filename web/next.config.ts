import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

loadEnv({ path: "../.env", quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ["@hydra/shared"],
  devIndicators: false,
  agentRules: false,
  env: {
    NEXT_PUBLIC_AGENT_SERVER_URL:
      process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000",
  },
};

export default nextConfig;

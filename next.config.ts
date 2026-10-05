import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // gitagent uses dynamic imports (MCP, telemetry, providers) that the bundler can't resolve; load it from node_modules at runtime.
  serverExternalPackages: ["@open-gitagent/gitagent"],
};

export default nextConfig;

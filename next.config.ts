import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the workspace root to the directory holding this config. Without it,
  // building from a git worktree makes Next infer the main checkout as root
  // (multiple lockfiles) and compile the wrong src tree.
  turbopack: {
    root: __dirname,
  },
  // Persist the turbopack build cache under .next/cache so the Dockerfile's
  // BuildKit cache mount carries it across image builds.
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
};

export default nextConfig;

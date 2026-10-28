import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  // The release cut passes an id derived from its build inputs, so the same inputs export the
  // same bytes; the live dashboard keeps a fresh id per build.
  generateBuildId: () => process.env.LIFEOS_BUILD_ID ?? `build-${Date.now()}`,
};

export default nextConfig;

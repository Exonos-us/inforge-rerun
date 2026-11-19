import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";

// Dokploy builds without .git, so a production build stamps itself. Written back to process.env so
// every process of the same build inlines one value.
process.env.NEXT_PUBLIC_BUILD_SHA ??= process.env.NODE_ENV === "production" ? `build-${Date.now()}` : "dev";

const nextConfig: NextConfig = {
  // A phone on the same wifi opens the dev server by its LAN address, which Next refuses to serve
  // scripts to unless it is listed here. A Conductor cloud workspace serves it behind
  // *.conductor.show: without that origin the page arrives but never hydrates, so every click dies.
  allowedDevOrigins: [...(process.env.ALLOWED_DEV_ORIGINS?.split(",") ?? []), "*.conductor.show"],
  transpilePackages: ["@rerun/ui", "@rerun/emails", "@rerun/db", "@rerun/analytics"],
  // ssh2 (the Incus hosts transport) loads an optional native crypto binding; bundled, Turbopack
  // cannot place the .node asset in an ESM chunk. Left external, Node requires it at runtime and
  // falls back to pure JS when the binding is missing.
  serverExternalPackages: ["ssh2"],
  // Inlined into both bundles at build time, so a tab can compare the build it runs against the one
  // /api/version reports. Locally both read "dev" and the update prompt never fires.
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.NEXT_PUBLIC_BUILD_SHA,
  },
  experimental: {
    serverActions: { bodySizeLimit: "64mb" },
    // Set by `next upgrade --agent=security`: keeps the app on the security channel.
    agentUpgrade: "security",
  },
  // The brand pages live in the back office of Rerun Cloud, an app of its own.
  async redirects() {
    const adminUrl = process.env.NEXT_PUBLIC_ADMIN_URL;
    if (!adminUrl) return [];
    return [
      { source: "/logo", destination: `${adminUrl}/admin/brand/logo`, permanent: false },
      { source: "/brand/:path*", destination: `${adminUrl}/admin/brand/:path*`, permanent: false },
    ];
  },
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/array/:path*", destination: "https://eu-assets.i.posthog.com/array/:path*" },
      { source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ];
  },
  skipTrailingSlashRedirect: true,
};

// A build that reports no errors (staging leaves the project token empty) has no source maps to upload.
const posthogApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;
const reportsErrorsToPostHog = Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN);

export default withPostHogConfig(nextConfig, {
  personalApiKey: posthogApiKey ?? "",
  projectId: posthogProjectId,
  host: "https://eu.posthog.com",
  sourcemaps: {
    enabled: Boolean(reportsErrorsToPostHog && posthogApiKey && posthogProjectId),
    releaseMode: "symbol-set",
    releaseName: "rerun-ui",
    releaseVersion: process.env.NEXT_PUBLIC_BUILD_SHA,
  },
});

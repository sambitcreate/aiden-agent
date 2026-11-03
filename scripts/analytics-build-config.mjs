import path from "node:path";
import { fileURLToPath } from "node:url";

// Decides what product-analytics configuration a build carries. Only a
// distribution build (`npm run dist`, `npm run dist:linux`) gets the PostHog
// project key, read from AIDEN_POSTHOG_PROJECT_KEY. Development, unpacked,
// test and E2E builds keep the committed keyless module and cannot send.
// The key never touches the repository or the disk: the build substitutes
// the module's contents in memory.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ANALYTICS_BUILD_CONFIG_MODULE = path.join(
  repositoryRoot,
  "main/services/analytics/analytics-build-config.ts",
);

const PROJECT_KEY = /^phc_[A-Za-z0-9_-]{20,100}$/u;

/**
 * @param {{ env: Record<string, string | undefined>, version: string }} input
 * @returns {{ config: { projectKey?: string, channel: "release" | "beta" | "dev" }, warning?: string } | undefined}
 *   undefined for a non-distribution build, which keeps the committed module.
 */
export function resolveAnalyticsBuildConfig({ env, version }) {
  if (env.AIDEN_DISTRIBUTION_BUILD !== "1") return undefined;
  const channel = version.includes("-") ? "beta" : "release";
  const projectKey = env.AIDEN_POSTHOG_PROJECT_KEY?.trim() ?? "";
  if (!projectKey) {
    return {
      config: { channel },
      warning:
        "AIDEN_POSTHOG_PROJECT_KEY is not set: this distribution build cannot send usage data. Release builds must set it.",
    };
  }
  if (!PROJECT_KEY.test(projectKey)) {
    throw new Error("AIDEN_POSTHOG_PROJECT_KEY is not a PostHog project key (phc_…).");
  }
  return { config: { projectKey, channel } };
}

export function analyticsBuildConfigSource(config) {
  return `export const ANALYTICS_BUILD_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
}

/** esbuild plugin that swaps the committed keyless module for `config`. */
export function analyticsBuildConfigPlugin(config) {
  return {
    name: "aiden-analytics-build-config",
    setup(build) {
      build.onLoad({ filter: /analytics-build-config\.ts$/ }, (args) =>
        path.resolve(args.path) === ANALYTICS_BUILD_CONFIG_MODULE
          ? { contents: analyticsBuildConfigSource(config), loader: "js" }
          : undefined,
      );
    },
  };
}

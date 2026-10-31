// The PostHog project key and release channel baked into a build. This
// committed file is what development, unpacked, test and E2E builds use: no
// key, so nothing can ever be sent. A distribution build (`npm run dist`, the
// release workflow) replaces it with a generated, gitignored module carrying
// the key from `AIDEN_POSTHOG_PROJECT_KEY` (see scripts/build-electron.mjs).

export interface AnalyticsBuildConfig {
  readonly projectKey?: string;
  readonly channel: "release" | "beta" | "dev";
}

export const ANALYTICS_BUILD_CONFIG: AnalyticsBuildConfig = { channel: "dev" };

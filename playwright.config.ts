import type { PlaywrightTestConfig } from "@playwright/test";

const liveLmStudioAcceptance = process.env.AIDEN_E2E_LIVE_LMSTUDIO === "1";

/**
 * Electron tests are intentionally serial: Aiden owns global Electron state
 * (single-instance handling, native menus, and optional global shortcuts).
 * Every test still gets independent user-data and portable-config roots.
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests/e2e",
  testMatch: liveLmStudioAcceptance ? "**/*.live.spec.ts" : "**/*.spec.ts",
  testIgnore: liveLmStudioAcceptance ? undefined : "**/*.live.spec.ts",
  outputDir: "./test-results/e2e",
  fullyParallel: false,
  workers: 1,
  // A test can finish its assertions before Electron enters its bounded
  // application-service shutdown (up to 35s in the fixture on loaded runners).
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report/e2e", open: "never" }]]
    : "line",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
};

export default config;

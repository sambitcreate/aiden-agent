import type { PlaywrightTestConfig } from "@playwright/test";

/** Chromium-only containment spike. Not the Electron app suite. */
const config: PlaywrightTestConfig = {
  testDir: "./tests/generative-ui",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "line" : "list",
  use: {
    browserName: "chromium",
    headless: true,
  },
};

export default config;

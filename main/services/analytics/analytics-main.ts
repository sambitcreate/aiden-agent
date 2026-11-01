/** Electron-main binding of product analytics. */

import { release } from "node:os";

import { app, logger } from "../../platform.js";
import { configStore } from "../config-store.js";
import { providerRegistry } from "../provider-registry.js";
import { ANALYTICS_BUILD_CONFIG } from "./analytics-build-config.js";
import type { PostHogTransport } from "./analytics-client.js";
import type { AnalyticsSuperProperties } from "./analytics-events.js";
import { createAnalyticsService, createLoggingTransport, type AnalyticsService } from "./analytics-service.js";

// macOS reports its own major (26); elsewhere this is the kernel major, which
// docs/analytics.md says for Linux.
function osMajor(): number {
  const version = process.platform === "darwin" ? process.getSystemVersion() : release();
  const major = Number.parseInt(version, 10);
  return Number.isSafeInteger(major) && major >= 0 && major <= 999 ? major : 0;
}

function superProperties(): AnalyticsSuperProperties {
  return {
    app_version: app.getVersion(),
    platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
    arch: process.arch === "arm64" || process.arch === "x64" ? process.arch : "other",
    os_major: osMajor(),
    surface: "desktop",
    channel: ANALYTICS_BUILD_CONFIG.channel,
  };
}

// Only a build with a project key can send. A development build can instead
// print would-be events to the dev log with AIDEN_ANALYTICS_DEBUG=1.
function transportFactory(): (() => Promise<PostHogTransport>) | undefined {
  const apiKey = ANALYTICS_BUILD_CONFIG.projectKey;
  if (apiKey) {
    return async () => {
      const { createPostHogTransport } = await import("./analytics-client.js");
      return createPostHogTransport({
        apiKey,
        onError: (error) => logger.warn("analytics", "Usage data could not be sent.", { errorType: error instanceof Error ? error.name : typeof error }),
      });
    };
  }
  if (!app.isPackaged && process.env.AIDEN_ANALYTICS_DEBUG === "1") {
    return async () => createLoggingTransport((line) => logger.info("analytics", line));
  }
  return undefined;
}

let service: AnalyticsService | undefined;

// Created on first use, after main has settled the userData path.
export function analyticsService(): AnalyticsService {
  service ??= createAnalyticsService({
    store: {
      read: () => configStore.getAnalyticsState(),
      update: (mutate) => configStore.updateAnalyticsState(mutate),
    },
    env: process.env,
    createTransport: transportFactory(),
    superProperties: superProperties(),
    appRoots: [app.getAppPath()],
    runDirectory: app.getPath("userData"),
    isBuiltinProvider: (providerId) => providerRegistry.isBuiltinProvider(providerId),
    log: (message, error) =>
      logger.warn("analytics", message, { errorType: error instanceof Error ? error.name : typeof error }),
  });
  return service;
}

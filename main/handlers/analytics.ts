import {
  ANALYTICS_EVENTS,
  EXCEPTION_PROPERTIES,
  SUPER_PROPERTIES,
  type AnalyticsPropSpec,
} from "../services/analytics/analytics-events.js";
import type { AnalyticsService, AnalyticsStatus } from "../services/analytics/analytics-service.js";
import type { AnalyticsRegistryView, AnalyticsPropertyView } from "../../renderer/shared/analytics.js";

function describe(name: string, spec: AnalyticsPropSpec): AnalyticsPropertyView {
  const optional = spec.optional === true;
  switch (spec.kind) {
    case "enum":
      return { name, kind: "enum", values: [...spec.values], optional };
    case "integer":
      return { name, kind: "integer", optional };
    default:
      return { name, kind: spec.kind, optional };
  }
}

function properties(specs: Readonly<Record<string, AnalyticsPropSpec>>): AnalyticsPropertyView[] {
  return Object.entries(specs).map(([name, spec]) => describe(name, spec));
}

// "What's sent" is rendered from the same registry the code sends from, so the
// list cannot drift from what actually leaves the machine.
export function analyticsRegistryView(): AnalyticsRegistryView {
  return {
    events: Object.entries(ANALYTICS_EVENTS).map(([name, specs]) => ({ name, properties: properties(specs) })),
    exceptionProperties: properties(EXCEPTION_PROPERTIES),
    superProperties: properties(SUPER_PROPERTIES),
  };
}

/** Usage-data consent: status, the Settings switch, the one-time notice and the event list. */
export function registerAnalyticsHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  analytics: Pick<AnalyticsService, "status" | "setEnabled" | "markNoticeShown">;
}): void {
  dependencies.handle("analytics:status", (): Promise<AnalyticsStatus> => dependencies.analytics.status());
  dependencies.handle("analytics:setEnabled", (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid usage data setting.");
    return dependencies.analytics.setEnabled(enabled);
  });
  dependencies.handle("analytics:markNoticeShown", (_event, choice) => {
    if (choice !== "ok" && choice !== "turn-off") throw new Error("Invalid usage data notice choice.");
    return dependencies.analytics.markNoticeShown(choice === "turn-off" ? { enabled: false } : undefined);
  });
  dependencies.handle("analytics:registry", () => analyticsRegistryView());
}

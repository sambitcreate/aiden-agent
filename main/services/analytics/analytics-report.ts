/** Host-neutral seam: shared services report here; each host registers its own sender. */

import type { AnalyticsEventName, AnalyticsEventProps } from "./analytics-events.js";

export type AnalyticsReporter = <E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>) => void;

let reporter: AnalyticsReporter | undefined;

export function setAnalyticsReporter(next: AnalyticsReporter | undefined): void {
  reporter = next;
}

export function reportAnalyticsEvent<E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>): void {
  try {
    reporter?.(event, props);
  } catch {
    // Analytics must never break the action it observes.
  }
}

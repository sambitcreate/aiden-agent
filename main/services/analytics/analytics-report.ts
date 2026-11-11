/** Host-neutral seam: shared services report here; each host registers its own sender. */

import type { AnalyticsEventName, AnalyticsEventProps } from "./analytics-events.js";

export type AnalyticsReporter = <E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>) => void;

let reporter: AnalyticsReporter | undefined;
let actionReporter: (() => AnalyticsReporter) | undefined;

export function setAnalyticsReporter(next: AnalyticsReporter | undefined, captureAction?: () => AnalyticsReporter): void {
  reporter = next;
  actionReporter = next ? captureAction : undefined;
}

/** Capture before looking up report metadata, so later consent cannot authorize an earlier action. */
export function captureAnalyticsReporter(): AnalyticsReporter {
  const current = reporter;
  let captured: AnalyticsReporter | undefined;
  try { captured = actionReporter?.() ?? current; } catch { return () => {}; }
  return (event, props) => {
    if (reporter !== current) return;
    try { captured?.(event, props); } catch { /* Reporting never breaks the action. */ }
  };
}

export function reportAnalyticsEvent<E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>): void {
  try {
    reporter?.(event, props);
  } catch {
    // Analytics must never break the action it observes.
  }
}

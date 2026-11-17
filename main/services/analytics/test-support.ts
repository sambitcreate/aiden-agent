import { ANALYTICS_EVENTS, pickValidProps, type AnalyticsEventName } from "./analytics-events.js";
import { setAnalyticsReporter } from "./analytics-report.js";

export interface CapturedAnalyticsEvent {
  readonly event: AnalyticsEventName;
  /** What the core would keep: `undefined` means the registry would drop the whole event. */
  readonly props: Record<string, unknown> | undefined;
}

/** Records what a service reports for one test, filtered through the real registry. */
export function captureAnalyticsEvents(t: { after(fn: () => void): void }): CapturedAnalyticsEvent[] {
  const captured: CapturedAnalyticsEvent[] = [];
  setAnalyticsReporter((event, props) => {
    captured.push({ event, props: pickValidProps(ANALYTICS_EVENTS[event], props as Record<string, unknown>) });
  });
  t.after(() => setAnalyticsReporter(undefined));
  return captured;
}

/** Lets a report that runs after the action has returned land. */
export async function analyticsSettled(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

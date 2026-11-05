import { DEFAULT_ANALYTICS_STATE, disableAnalytics, enableAnalytics, markNoticeShown, type AnalyticsState } from "../../../main/services/analytics/analytics-consent.js";
import {
  CONSENT_SWITCH_WAIT_MS,
  serverAnalyticsContext,
  serverAnalyticsFile,
  serverSendStatus,
  serverTransportFactory,
  readServerAnalyticsState,
  sendServerOptOut,
  updateServerAnalyticsState,
  type ServerAnalyticsContext,
  type ServerBlockReason,
} from "./server-analytics.ts";

const USAGE = "Usage: aiden telemetry status | on | off";

export interface TelemetryReport {
  enabled: boolean;
  /** This install can send right now. A running server picks up `on` at its next start. */
  sending: boolean;
  /** Why it cannot: environment, ci, disabled, no_key or notice_pending. */
  reason?: ServerBlockReason;
  file: string;
}

function report(state: AnalyticsState, context: ServerAnalyticsContext): TelemetryReport {
  const status = serverSendStatus(state, { env: context.env, hasKey: serverTransportFactory(context) !== undefined });
  return {
    enabled: state.enabled,
    sending: status.canSend,
    ...(status.canSend ? {} : { reason: status.reason }),
    file: serverAnalyticsFile(context.agentDir),
  };
}

/** `aiden telemetry status|on|off`: the server's switch for anonymous usage and crash data. */
export async function telemetryCommand(agentDir: string, args: readonly string[], context: ServerAnalyticsContext = serverAnalyticsContext(agentDir)): Promise<TelemetryReport> {
  const [action = "status", ...rest] = args;
  if (rest.length > 0) throw new Error(USAGE);
  if (action === "status") return report(readServerAnalyticsState(agentDir), context);
  if (action === "on") {
    // Choosing it by name also answers the notice, as the desktop's switch does.
    const now = (context.now ?? (() => new Date()))();
    return report(updateServerAnalyticsState(agentDir, (state) => markNoticeShown(enableAnalytics(state), now), CONSENT_SWITCH_WAIT_MS), context);
  }
  if (action !== "off") throw new Error(USAGE);
  // Saved first, so a running server stops and the ID is gone whatever the network does.
  let before = DEFAULT_ANALYTICS_STATE;
  const after = updateServerAnalyticsState(agentDir, (state) => {
    before = state;
    return disableAnalytics(state);
  }, CONSENT_SWITCH_WAIT_MS);
  const createTransport = serverTransportFactory(context);
  const couldSend = serverSendStatus(before, { env: context.env, hasKey: createTransport !== undefined }).canSend;
  if (couldSend && before.installId && createTransport) await sendServerOptOut(before.installId, context, createTransport);
  return report(after, context);
}

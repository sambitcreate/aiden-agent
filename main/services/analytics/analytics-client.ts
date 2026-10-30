import { PostHog, type PostHogOptions } from "posthog-node";

import { validateOutgoingEvent, type AnalyticsMessage, type AnalyticsTransport } from "./analytics-core.js";

// The only module that imports posthog-node. It is constructed only when a
// release key is present and sending is allowed; dev, test and E2E builds
// have no key and never reach this file at runtime.

export const ANALYTICS_HOST = "https://us.i.posthog.com";
export const ANALYTICS_SHUTDOWN_TIMEOUT_MS = 1_500;

export interface PostHogTransport extends AnalyticsTransport {
  // Sends one message now, outside the batch (used for analytics_disabled).
  captureNow(message: AnalyticsMessage): Promise<void>;
  flush(): Promise<void>;
  // Flushes what is queued within the timeout, then stops.
  shutdown(timeoutMs?: number): Promise<void>;
  // Drops everything queued without sending it, then stops.
  discard(): Promise<void>;
}

export interface PostHogTransportOptions {
  readonly apiKey: string;
  // Tests inject a fake fetch so nothing reaches the network.
  readonly fetch?: PostHogOptions["fetch"];
  readonly onError?: (error: unknown) => void;
}

class AidenPostHog extends PostHog {
  // `disabled` short-circuits capture, flush and shutdown in the SDK, so
  // setting it drops the in-memory queue without a final request.
  stopWithoutFlushing(): void {
    this.disabled = true;
  }
}

export function postHogClientOptions(fetchImpl?: PostHogOptions["fetch"]): PostHogOptions {
  return {
    host: ANALYTICS_HOST,
    flushAt: 20,
    flushInterval: 30_000,
    maxQueueSize: 500,
    requestTimeout: 10_000,
    persistence: "memory",
    disableGeoip: true,
    // All exceptions go through our sanitizer and are sent as plain
    // `$exception` captures, so the SDK never parses stacks itself or reads
    // source files from disk for context lines.
    enableExceptionAutocapture: false,
    // No personal or secret key is configured, so flags are never polled.
    featureFlagsPollingInterval: null,
    before_send: (event) => validateOutgoingEvent(event),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

export function createPostHogTransport(options: PostHogTransportOptions): PostHogTransport {
  const client = new AidenPostHog(options.apiKey, postHogClientOptions(options.fetch));
  let stopped = false;
  // The SDK reports every failed send here, including background flushes.
  client.on("error", (error: unknown) => options.onError?.(error));

  const toEvent = (message: AnalyticsMessage) => ({
    distinctId: message.distinctId,
    event: message.event,
    properties: message.properties,
    disableGeoip: true,
  });

  // A failed send (offline, rejected batch) never reaches the caller: the
  // SDK has already reported it through "error", keeps network failures
  // queued for the next flush, and drops batches the server rejects.
  const quietly = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch {
      // Reported through the "error" listener above.
    }
  };

  return {
    capture(message) {
      if (!stopped) client.capture(toEvent(message));
    },
    async captureNow(message) {
      if (!stopped) await quietly(() => client.captureImmediate(toEvent(message)));
    },
    async flush() {
      if (!stopped) await quietly(() => client.flush());
    },
    async shutdown(timeoutMs = ANALYTICS_SHUTDOWN_TIMEOUT_MS) {
      if (stopped) return;
      stopped = true;
      await quietly(() => client.shutdown(timeoutMs));
    },
    async discard() {
      if (stopped) return;
      stopped = true;
      client.stopWithoutFlushing();
      await quietly(() => client.shutdown(0));
    },
  };
}

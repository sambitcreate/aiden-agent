import { randomUUID as nodeRandomUUID } from "node:crypto";

import type { PostHogTransport } from "./analytics-client.js";
import {
  analyticsSendStatus,
  disableAnalytics,
  enableAnalytics,
  envDisablesAnalytics,
  ensureInstallId,
  markNoticeShown,
  type AnalyticsState,
} from "./analytics-consent.js";
import { createAnalyticsCore, validateOutgoingEvent, type AnalyticsCore, type AnalyticsMessage } from "./analytics-core.js";
import { beginRun, deletePendingCrash, endRun } from "./analytics-crash.js";
import type { AnalyticsEventProps, AnalyticsSuperProperties } from "./analytics-events.js";

// Lifecycle of product analytics in the desktop main process: read consent,
// create the transport only once sending is allowed, send the "who's using it"
// events, and stop at once when the person turns it off. Every entry point
// catches its own failures; analytics never throws into the app.

export interface AnalyticsStateStore {
  read(): Promise<AnalyticsState>;
  update(mutate: (state: AnalyticsState) => AnalyticsState): Promise<AnalyticsState>;
}

export interface AnalyticsServiceOptions {
  readonly store: AnalyticsStateStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  // Undefined when the build carries no project key: the service then never
  // creates a transport and nothing can reach the network.
  readonly createTransport?: () => Promise<PostHogTransport>;
  readonly superProperties: AnalyticsSuperProperties;
  readonly appRoots: readonly string[];
  // Where the run marker and pending-crash file live (userData).
  readonly runDirectory: string;
  readonly isBuiltinProvider: (providerId: string) => boolean;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly setInterval?: (callback: () => void, ms: number) => { unref?(): void };
  readonly clearInterval?: (timer: unknown) => void;
  readonly log?: (message: string, error?: unknown) => void;
}

export interface AnalyticsStatus {
  readonly enabled: boolean;
  // DO_NOT_TRACK or AIDEN_ANALYTICS=0 overrides the setting.
  readonly envDisabled: boolean;
  // This build can send (a release build, or the development debug log).
  readonly hasKey: boolean;
  // Sending waits for the person to see the notice.
  readonly noticePending: boolean;
}

export type OnboardingOutcome = "incomplete" | "deferred" | "completed";

export interface AnalyticsService {
  start(): Promise<void>;
  status(): Promise<AnalyticsStatus>;
  setEnabled(enabled: boolean): Promise<AnalyticsStatus>;
  // The one-time notice for people upgrading into analytics. `enabled: false`
  // is its Turn off button.
  markNoticeShown(choice?: { readonly enabled?: boolean }): Promise<AnalyticsStatus>;
  onboardingFinished(outcome: OnboardingOutcome, providerId?: string): Promise<void>;
  // Sends what is queued within the timeout, then stops the transport.
  shutdown(timeoutMs?: number): Promise<void>;
  // Synchronous last step of a clean quit: the next launch is not a crash.
  markCleanExit(): void;
}

export const ACTIVE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const DISABLED_EVENT_TIMEOUT_MS = 1_500;

// The person's own calendar day, so "active today" matches their today.
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

// `AIDEN_ANALYTICS_DEBUG=1` in development: run every message through the same
// outgoing guard, then write it to the dev log instead of the network.
export function createLoggingTransport(write: (line: string) => void): PostHogTransport {
  let stopped = false;
  const emit = (message: AnalyticsMessage) => {
    if (stopped) return;
    const checked = validateOutgoingEvent({ event: message.event, properties: message.properties });
    if (checked) write(`[analytics debug] ${checked.event} ${JSON.stringify(checked.properties)}`);
  };
  return {
    capture: emit,
    captureNow: async (message) => emit(message),
    flush: async () => {},
    shutdown: async () => {
      stopped = true;
    },
    discard: async () => {
      stopped = true;
    },
  };
}

export function createAnalyticsService(options: AnalyticsServiceOptions): AnalyticsService {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const startTimer = options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer = options.clearInterval ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
  const hasKey = options.createTransport !== undefined;
  const envDisabled = envDisablesAnalytics(options.env);

  let launchKind: AnalyticsEventProps<"app_opened">["launch_kind"] = "cold";
  let pendingUpdate: AnalyticsEventProps<"app_updated"> | undefined;
  let openedSent = false;
  let transport: PostHogTransport | undefined;
  let core: AnalyticsCore | undefined;
  let installId: string | undefined;
  let timer: unknown;
  let activeDay: string | undefined;
  let activation: Promise<void> | undefined;
  // Bumped on every stop so an activation that started before it cannot
  // bring a transport back to life.
  let generation = 0;
  // Set only while analytics_disabled is tracked, so it goes out on its own.
  let sendNow: ((message: AnalyticsMessage) => void) | undefined;
  // Consent changes run one at a time, in the order they were asked for, so
  // a slow opt-out (waiting on its final request) cannot finish after a
  // newer opt-in and overwrite it.
  let consentQueue: Promise<unknown> = Promise.resolve();

  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const run = consentQueue.then(work, work);
    consentQueue = run.catch(() => undefined);
    return run;
  }

  function log(message: string, error?: unknown): void {
    try {
      options.log?.(message, error);
    } catch {
      // Logging must not turn an analytics failure into an app failure.
    }
  }

  function toStatus(state: AnalyticsState): AnalyticsStatus {
    return {
      enabled: state.enabled,
      envDisabled,
      hasKey,
      noticePending: hasKey && !envDisabled && state.enabled && !state.noticeShownAt,
    };
  }

  async function checkActiveDay(): Promise<void> {
    try {
      if (!core) return;
      const today = localDay(now());
      if (activeDay === today) return;
      activeDay = today;
      const state = await options.store.read();
      if (state.lastActiveDay === today) return;
      if (!core?.track("app_active", {})) {
        activeDay = undefined;
        return;
      }
      await options.store.update((current) => ({ ...current, lastActiveDay: today }));
    } catch (error) {
      log("Daily activity could not be recorded.", error);
    }
  }

  async function activate(): Promise<void> {
    const started = generation;
    const withId = await options.store.update((state) => ensureInstallId(state, randomUUID));
    if (started !== generation || !withId.installId || !options.createTransport) return;
    const created = await options.createTransport();
    if (started !== generation) {
      await created.discard();
      return;
    }
    installId = withId.installId;
    transport = created;
    core = createAnalyticsCore({
      transport: {
        capture: (message) => (sendNow ? sendNow(message) : created.capture(message)),
      },
      getDistinctId: () => installId,
      superProperties: options.superProperties,
      appRoots: options.appRoots,
      onInternalError: (error) => log("An analytics event could not be prepared.", error),
    });
    if (!openedSent) {
      openedSent = true;
      core.track("app_opened", { launch_kind: launchKind });
    }
    if (pendingUpdate) {
      core.track("app_updated", pendingUpdate);
      pendingUpdate = undefined;
    }
    await checkActiveDay();
    if (started !== generation) return;
    const interval = startTimer(() => void checkActiveDay(), ACTIVE_CHECK_INTERVAL_MS);
    interval.unref?.();
    timer = interval;
  }

  async function activateIfAllowed(): Promise<void> {
    if (core) return;
    if (activation) return activation;
    const state = await options.store.read();
    if (!analyticsSendStatus(state, { env: options.env, hasKey }).canSend) return;
    if (core) return;
    activation ??= activate()
      .catch((error: unknown) => log("Analytics could not start.", error))
      .finally(() => {
        activation = undefined;
      });
    return activation;
  }

  // Stops capture and drops whatever is queued, without sending it.
  async function stop(): Promise<void> {
    generation += 1;
    if (timer !== undefined) stopTimer(timer);
    timer = undefined;
    activeDay = undefined;
    const stopping = transport;
    transport = undefined;
    core = undefined;
    installId = undefined;
    await stopping?.discard().catch((error: unknown) => log("Queued analytics could not be dropped.", error));
  }

  async function sendDisabledEvent(): Promise<void> {
    const sending = core;
    const current = transport;
    if (!sending || !current) return;
    let pending: Promise<void> | undefined;
    sendNow = (message) => {
      pending = current.captureNow(message);
    };
    try {
      sending.track("analytics_disabled", {});
    } finally {
      sendNow = undefined;
    }
    if (pending) await within(pending, DISABLED_EVENT_TIMEOUT_MS);
  }

  async function turnOff(): Promise<AnalyticsState> {
    await sendDisabledEvent();
    await stop();
    const state = await options.store.update((current) => {
      const { lastActiveDay: _lastActiveDay, ...rest } = disableAnalytics(current);
      return rest;
    });
    try {
      deletePendingCrash(options.runDirectory);
    } catch (error) {
      log("The pending crash report could not be deleted.", error);
    }
    return state;
  }

  async function status(): Promise<AnalyticsStatus> {
    try {
      return toStatus(await options.store.read());
    } catch (error) {
      log("Analytics settings could not be read.", error);
      return { enabled: false, envDisabled, hasKey, noticePending: false };
    }
  }

  return {
    async start() {
      let previousRunUnclean = false;
      try {
        previousRunUnclean = beginRun(options.runDirectory).previousRunUnclean;
      } catch (error) {
        log("The analytics run marker could not be written.", error);
      }
      try {
        const version = options.superProperties.app_version;
        const state = await options.store.read();
        const updated = state.lastVersion !== undefined && state.lastVersion !== version;
        launchKind = previousRunUnclean ? "after_crash" : updated ? "after_update" : "cold";
        if (updated) pendingUpdate = { from_version: state.lastVersion!, to_version: version };
        if (state.lastVersion !== version) {
          await options.store.update((current) => ({ ...current, lastVersion: version }));
        }
        await activateIfAllowed();
      } catch (error) {
        log("Analytics could not start.", error);
      }
    },

    status,

    setEnabled(enabled) {
      return inOrder(async () => {
        try {
          if (enabled) {
            await options.store.update(enableAnalytics);
            await activateIfAllowed();
          } else {
            await turnOff();
          }
        } catch (error) {
          log("The analytics setting could not be saved.", error);
          throw new Error("The usage data setting could not be saved.");
        }
        return status();
      });
    },

    markNoticeShown(choice) {
      return inOrder(async () => {
        try {
          if (choice?.enabled === false) await turnOff();
          await options.store.update((state) => markNoticeShown(state, now()));
          await activateIfAllowed();
        } catch (error) {
          log("The analytics notice could not be recorded.", error);
          throw new Error("The usage data notice could not be saved.");
        }
        return status();
      });
    },

    onboardingFinished(outcome, providerId) {
      if (outcome !== "completed" && outcome !== "deferred") return Promise.resolve();
      // Marking the notice seen and starting to send is a consent change too,
      // so it waits behind any switch change already in progress.
      return inOrder(async () => {
        try {
          // The final onboarding step shows the usage-data row, so finishing
          // onboarding is the new-install notice.
          await options.store.update((state) => markNoticeShown(state, now()));
          await activateIfAllowed();
          const provider = providerId === undefined
            ? undefined
            : options.isBuiltinProvider(providerId) ? providerId : "custom";
          core?.track("onboarding_finished", { outcome, ...(provider ? { provider_id: provider } : {}) });
        } catch (error) {
          log("Onboarding analytics could not be recorded.", error);
        }
      });
    },

    async shutdown(timeoutMs = 1_500) {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
      const current = transport;
      if (!current) return;
      await within(current.shutdown(timeoutMs), timeoutMs + 250);
    },

    markCleanExit() {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
      try {
        endRun(options.runDirectory);
      } catch (error) {
        log("The analytics run marker could not be removed.", error);
      }
    },
  };
}

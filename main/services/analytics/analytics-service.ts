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
import {
  acknowledgePendingCrash,
  beginRun,
  crashSignalFor,
  deletePendingCrash,
  endRun,
  readPendingCrash,
  writePendingCrashSync,
  type CrashDiagnosticDetail,
  type CrashDiagnosticEvent,
  type RunStart,
} from "./analytics-crash.js";
import type { AnalyticsEventName, AnalyticsEventProps, AnalyticsSuperProperties } from "./analytics-events.js";
import type { AnalyticsReporter } from "./analytics-report.js";
import { sanitizeException } from "./analytics-sanitize.js";

// Lifecycle of product analytics in the desktop main process: read consent,
// create the transport only once sending is allowed, send the "who's using it"
// events, and stop at once when the person turns it off. Every entry point
// catches its own failures; analytics never throws into the app.

export interface AnalyticsStateStore {
  read(): Promise<AnalyticsState>;
  update(mutate: (state: AnalyticsState) => AnalyticsState, isCurrent?: () => boolean): Promise<AnalyticsState>;
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
  // Consent as saved on disk, read synchronously. Only a fatal crash during
  // startup needs it, before the transport exists.
  readonly readStateSync?: () => AnalyticsState | undefined;
  // Sending started or stopped. The renderer adds raw error fields to its
  // diagnostics reports only while it is on.
  readonly onSendingChanged?: (sending: boolean) => void;
  readonly uptimeSeconds?: () => number;
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
  setEnabled(enabled: boolean, isCurrent?: () => boolean): Promise<AnalyticsStatus>;
  // The one-time notice for people upgrading into analytics. `enabled: false`
  // is its Turn off button.
  markNoticeShown(choice?: { readonly enabled?: boolean }, isCurrent?: () => boolean): Promise<AnalyticsStatus>;
  onboardingFinished(outcome: OnboardingOutcome, providerId?: string): Promise<void>;
  // A feature event, dropped unless sending is allowed right now. Synchronous
  // and never throws, so the action it observes neither waits nor fails.
  track<E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>): void;
  /** Bind delayed metadata to the action's current consent and initial-startup authority. */
  actionReporter(): AnalyticsReporter;
  // Sends what is queued within the timeout, then stops the transport.
  shutdown(timeoutMs?: number): Promise<void>;
  // Synchronous last step of a clean quit: the next launch is not a crash.
  markCleanExit(): void;
  // Synchronous and first in a launch that owns the app, so a crash during
  // startup still leaves the marker. start() does it if this was not called.
  beginRun(): void;
  // The diagnostics journal's tap: crashes and uncaught errors become reports,
  // everything else is ignored. Runs on the crash path, so it never throws.
  handleDiagnosticEvent(event: CrashDiagnosticEvent, detail?: CrashDiagnosticDetail): void;
  // Whether the renderer may add raw error fields, for reports made now.
  sendsErrorDetails(): Promise<boolean>;
}

export const ACTIVE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const DISABLED_EVENT_TIMEOUT_MS = 1_500;
// How long a renderer asking about error details waits for startup to settle.
const STARTUP_STATUS_TIMEOUT_MS = 1_000;

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
  let revoked = false;
  const emit = (message: AnalyticsMessage) => {
    if (stopped) return;
    const checked = validateOutgoingEvent({ event: message.event, properties: message.properties });
    if (!checked) return;
    // The dev log caps a line at 1,024 characters, so the frames go last.
    const { $exception_list: exceptions, ...fields } = checked.properties ?? {};
    write(`[analytics debug] ${checked.event} ${JSON.stringify(exceptions === undefined ? fields : { ...fields, $exception_list: exceptions })}`);
  };
  return {
    capture: (message) => { if (!revoked) emit(message); },
    revokeQueue: () => { revoked = true; },
    captureOptOut: async (message) => {
      emit(message);
      stopped = true;
    },
    captureNow: async (message) => {
      if (revoked || stopped) return false;
      emit(message);
      return true;
    },
    flush: async () => {},
    shutdown: async () => {
      stopped = true;
    },
    discard: async () => {
      stopped = true;
    },
  };
}

const MAX_HELD_EVENTS = 100;

export function createAnalyticsService(options: AnalyticsServiceOptions): AnalyticsService {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const startTimer = options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer = options.clearInterval ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
  const hasKey = options.createTransport !== undefined;
  const envDisabled = envDisablesAnalytics(options.env);

  let run: RunStart | undefined;
  // Owed to the next activation: set only when sending was allowed at launch,
  // so a crash from before the notice or an opt-in is never reported.
  let uncleanExitOwed = false;
  let startup: Promise<void> | undefined;
  // Reports still on their way, which shutdown waits for inside its deadline.
  const crashSends = new Set<Promise<void>>();
  // Startup can fail repeatedly; the first failure is the one worth keeping.
  let earlyCrashWritten = false;
  let launchKind: AnalyticsEventProps<"app_opened">["launch_kind"] = "cold";
  let pendingUpdate: AnalyticsEventProps<"app_updated"> | undefined;
  let openedSent = false;
  let transport: PostHogTransport | undefined;
  let core: AnalyticsCore | undefined;
  let installId: string | undefined;
  let timer: unknown;
  let activeDay: string | undefined;
  let activation: Promise<void> | undefined;
  // Remote and IPC open before start() settles, so an action in that window
  // waits here. It goes out only under the consent saved when the launch began:
  // start() drops these if that consent doesn't allow sending, and any consent
  // change during startup drops them too, so a later yes can't cover them.
  let heldUntilStarted: Array<() => void> | undefined = [];
  // Bumped on every stop so an activation that started before it cannot
  // bring a transport back to life.
  let generation = 0;
  // Invalidated when consent is requested, before its asynchronous write or transport teardown.
  let actionEpoch = 0;
  let pendingConsentChanges = 0;
  let shutdownRequested = false;
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

  function changeConsent<T>(work: () => Promise<T>): Promise<T> {
    actionEpoch += 1;
    heldUntilStarted = undefined;
    pendingConsentChanges += 1;
    return inOrder(work).finally(() => { pendingConsentChanges -= 1; });
  }

  function log(message: string, error?: unknown): void {
    try {
      options.log?.(message, error);
    } catch {
      // Logging must not turn an analytics failure into an app failure.
    }
  }

  function sendingChanged(sending: boolean): void {
    try {
      options.onSendingChanged?.(sending);
    } catch (error) {
      log("The renderer could not be told about usage data.", error);
    }
  }

  function startRun(): RunStart {
    if (run) return run;
    try {
      run = beginRun(options.runDirectory, randomUUID());
    } catch (error) {
      log("The analytics run marker could not be written.", error);
      run = { previousRunUnclean: false };
    }
    return run;
  }

  // Runs a core call and keeps the finished message instead of queueing it, so
  // a crash goes out on its own request and flood control still decides.
  function captureAlone(capture: () => void): AnalyticsMessage | undefined {
    let captured: AnalyticsMessage | undefined;
    sendNow = (message) => { captured = message; };
    try {
      capture();
    } finally {
      sendNow = undefined;
    }
    return captured;
  }

  function sendCrash(message: AnalyticsMessage, recordId: string): void {
    const active = transport;
    if (!active) return;
    const sending: Promise<void> = active.captureNow(message)
      .then((sent) => { if (sent) acknowledgePendingCrash(options.runDirectory, recordId); })
      .catch((error: unknown) => log("A crash report could not be sent.", error))
      .finally(() => { crashSends.delete(sending); });
    crashSends.add(sending);
  }

  // A crash waiting to be sent. Returns whether it came from the last run: it
  // then explains that run's unclean exit, which needs no report of its own. An
  // older record that could not be sent until now says nothing about that run.
  function replayPendingCrash(): boolean {
    const pending = readPendingCrash(options.runDirectory);
    if (!pending) return false;
    if (pending.installId !== installId) {
      deletePendingCrash(options.runDirectory);
      return false;
    }
    const message = captureAlone(() => core?.captureSanitizedException(pending.exception, {
      ...pending.context,
      origin: "pending_crash",
      eventId: pending.id,
      occurredAt: pending.capturedAt,
    }));
    if (message) sendCrash(message, pending.id);
    return pending.runId !== undefined && pending.runId === run?.previousRunId;
  }

  // Before activation there is no transport and no install id in memory. The
  // saved consent decides, and activation or the next launch sends the record.
  function persistEarlyFatal(error: unknown, origin: "uncaught_exception" | "unhandled_rejection"): void {
    if (earlyCrashWritten || generation !== 0) return;
    const state = options.readStateSync?.();
    if (!state?.installId || !analyticsSendStatus(state, { env: options.env, hasKey }).canSend) return;
    earlyCrashWritten = true;
    writePendingCrashSync(
      options.runDirectory,
      sanitizeException(error, { appRoots: options.appRoots }),
      fatalContext(origin),
      now(),
      { id: randomUUID(), installId: state.installId, runId: run?.runId },
    );
  }

  function fatalContext(origin: "uncaught_exception" | "unhandled_rejection") {
    return {
      source: "main",
      level: "fatal",
      processType: "browser",
      origin,
      uptimeSeconds: uptimeSeconds(),
      appVersion: options.superProperties.app_version,
    } as const;
  }

  // The record reaches the disk before anything is attempted on the network:
  // the process may not outlive this call.
  function reportFatal(error: unknown, origin: "uncaught_exception" | "unhandled_rejection"): void {
    if (!core || !installId) {
      persistEarlyFatal(error, origin);
      return;
    }
    const exception = sanitizeException(error, { appRoots: options.appRoots });
    const context = fatalContext(origin);
    const id = randomUUID();
    const message = captureAlone(() => core?.captureSanitizedException(exception, { ...context, eventId: id }));
    if (!message) return;
    writePendingCrashSync(options.runDirectory, exception, context, now(), { id, installId, runId: run?.runId });
    sendCrash(message, id);
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
    let claimed: string | undefined;
    let tracked = false;
    try {
      if (!core) return;
      const today = localDay(now());
      if (activeDay === today) return;
      activeDay = claimed = today;
      const state = await options.store.read();
      if (state.lastActiveDay === today) return;
      if (!core?.track("app_active", {})) {
        activeDay = undefined;
        return;
      }
      tracked = true;
      await options.store.update((current) => ({ ...current, lastActiveDay: today }));
    } catch (error) {
      log("Daily activity could not be recorded.", error);
      // Nothing went out yet, so the next hourly check tries again.
      if (!tracked && activeDay === claimed) activeDay = undefined;
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
    const explained = replayPendingCrash();
    if (uncleanExitOwed) {
      uncleanExitOwed = false;
      // The ordinary queue flushes every 30 seconds, and a launch that is
      // about to crash again may not last that long.
      if (!explained && core.track("app_crashed", { kind: "unclean_exit" })) void created.flush();
    }
    sendingChanged(true);
    if (pendingUpdate) {
      const update = pendingUpdate;
      pendingUpdate = undefined;
      if (core.track("app_updated", update)) {
        await options.store.update((current) => ({ ...current, lastVersion: update.to_version }));
      }
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
    if (!activation) {
      const run: Promise<void> = activate()
        .catch((error: unknown) => log("Analytics could not start.", error))
        .finally(() => {
          if (activation === run) activation = undefined;
        });
      activation = run;
    }
    return activation;
  }

  // A late activation sees the new generation and discards its transport.
  function cancelStartup(): void {
    generation += 1;
    heldUntilStarted = undefined;
  }

  // Stops capture and drops whatever is queued, without sending it.
  function stop(): void {
    generation += 1;
    activation = undefined;
    if (timer !== undefined) stopTimer(timer);
    timer = undefined;
    activeDay = undefined;
    uncleanExitOwed = false;
    transport?.revokeQueue();
    transport = undefined;
    const wasSending = core !== undefined;
    core = undefined;
    installId = undefined;
    if (wasSending) sendingChanged(false);
  }

  async function turnOff(isCurrent?: () => boolean, noticeAnswered = false): Promise<void> {
    const stopping = transport;
    let finalMessage: AnalyticsMessage | undefined;
    sendNow = (message) => { finalMessage = message; };
    try {
      core?.track("analytics_disabled", {});
    } finally {
      sendNow = undefined;
      stop();
    }
    try {
      await options.store.update((current) => {
        const { lastActiveDay: _lastActiveDay, ...rest } = disableAnalytics(current);
        const off = { ...rest, lastVersion: options.superProperties.app_version };
        return noticeAnswered ? markNoticeShown(off, now()) : off;
      }, isCurrent);
      pendingUpdate = undefined;
      try {
        deletePendingCrash(options.runDirectory);
      } catch (error) {
        log("The pending crash report could not be deleted.", error);
      }
      if (stopping && finalMessage) await within(stopping.captureOptOut(finalMessage), DISABLED_EVENT_TIMEOUT_MS);
    } catch (error) {
      // If publication lost its owner, resume only under the still-saved consent.
      if (isCurrent && !isCurrent()) await activateIfAllowed();
      throw error;
    } finally {
      await stopping?.discard().catch((error: unknown) => log("Queued analytics could not be dropped.", error));
    }
  }

  async function status(): Promise<AnalyticsStatus> {
    try {
      return toStatus(await options.store.read());
    } catch (error) {
      log("Analytics settings could not be read.", error);
      return { enabled: false, envDisabled, hasKey, noticePending: false };
    }
  }

  async function runStartup(): Promise<void> {
    const { previousRunUnclean } = startRun();
    try {
      const version = options.superProperties.app_version;
      const state = await options.store.read();
      const updated = state.lastVersion !== undefined && state.lastVersion !== version;
      if (updated) pendingUpdate = { from_version: state.lastVersion!, to_version: version };
      // While only the notice holds sending back, keep the old version so an
      // update the person quits before answering is still reported next launch.
      const sendStatus = analyticsSendStatus(state, { env: options.env, hasKey });
      if (!sendStatus.canSend) heldUntilStarted = undefined;
      const waitingForNotice = !sendStatus.canSend && sendStatus.reason === "notice_pending";
      // A crash from before the notice or an opt-in is never reported, in any form.
      launchKind = previousRunUnclean && sendStatus.canSend ? "after_crash" : updated ? "after_update" : "cold";
      // A crash captured under consent that is gone is deleted unsent.
      if (sendStatus.canSend) uncleanExitOwed = previousRunUnclean;
      else deletePendingCrash(options.runDirectory);
      if (state.lastVersion !== version && !(updated && waitingForNotice)) {
        await options.store.update((current) => ({ ...current, lastVersion: version }));
      }
      await activateIfAllowed();
    } catch (error) {
      log("Analytics could not start.", error);
    } finally {
      const held = heldUntilStarted;
      heldUntilStarted = undefined;
      held?.forEach((send) => send());
    }
  }

  function trackFeature<E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>): void {
    if (pendingConsentChanges !== 0 || shutdownRequested) return;
    if (heldUntilStarted && heldUntilStarted.length < MAX_HELD_EVENTS) {
      heldUntilStarted.push(() => core?.track(event, props));
    } else {
      core?.track(event, props);
    }
  }

  return {
    start() {
      startup ??= runStartup();
      return startup;
    },

    beginRun() {
      startRun();
    },

    handleDiagnosticEvent(event, detail) {
      try {
        const signal = crashSignalFor(event, detail);
        switch (signal?.kind) {
          case "fatal":
            reportFatal(signal.error, signal.origin);
            break;
          case "main_rejection":
            core?.captureException(signal.error, {
              source: "main",
              level: "error",
              processType: "browser",
              origin: "unhandled_rejection",
              uptimeSeconds: uptimeSeconds(),
            });
            break;
          case "renderer_error":
            core?.captureException(signal.error, {
              source: "renderer",
              level: "error",
              processType: "renderer",
              origin: signal.origin,
              uptimeSeconds: uptimeSeconds(),
            });
            break;
          case "process_gone":
            core?.track("app_crashed", signal.props);
            break;
          case "orderly_exit":
            endRun(options.runDirectory);
            break;
        }
      } catch (error) {
        log("A crash could not be reported.", error);
      }
    },

    async sendsErrorDetails() {
      await within(startup ?? Promise.resolve(), STARTUP_STATUS_TIMEOUT_MS);
      return core !== undefined;
    },

    status,

    setEnabled(enabled, isCurrent) {
      return changeConsent(async () => {
        if (isCurrent && !isCurrent()) throw new Error("Inactive usage data request.");
        try {
          if (enabled) {
            // Switching usage data on in Settings is a choice made with the
            // description in view, so it also answers the notice.
            await options.store.update((state) => markNoticeShown(enableAnalytics(state), now()), isCurrent);
            await activateIfAllowed();
          } else {
            await turnOff(isCurrent);
          }
        } catch (error) {
          log("The analytics setting could not be saved.", error);
          throw new Error("The usage data setting could not be saved.");
        }
        return status();
      });
    },

    markNoticeShown(choice, isCurrent) {
      return changeConsent(async () => {
        if (isCurrent && !isCurrent()) throw new Error("Inactive usage data request.");
        try {
          if (choice?.enabled === false) {
            await turnOff(isCurrent, true);
          } else {
            await options.store.update((state) => markNoticeShown(state, now()), isCurrent);
            await activateIfAllowed();
          }
        } catch (error) {
          log("The analytics notice could not be recorded.", error);
          throw new Error("The usage data notice could not be saved.");
        }
        return status();
      });
    },

    onboardingFinished(outcome, providerId) {
      if (outcome !== "completed" && outcome !== "deferred") return Promise.resolve();
      // Report the outcome only after any explicit disclosure or switch change.
      return inOrder(async () => {
        try {
          const provider = providerId === undefined
            ? undefined
            : options.isBuiltinProvider(providerId) ? providerId : "custom";
          core?.track("onboarding_finished", { outcome, ...(provider ? { provider_id: provider } : {}) });
        } catch (error) {
          log("Onboarding analytics could not be recorded.", error);
        }
      });
    },

    track: trackFeature,

    actionReporter() {
      const epoch = actionEpoch, activeGeneration = generation;
      // Startup may authorize its original held actions. An inactive service
      // after startup cannot borrow a later opt-in or disclosure.
      const eligible = !shutdownRequested && pendingConsentChanges === 0 && (core !== undefined || heldUntilStarted !== undefined);
      return (event, props) => {
        if (!eligible || epoch !== actionEpoch || activeGeneration !== generation) return;
        trackFeature(event, props);
      };
    },

    async shutdown(timeoutMs = 1_500) {
      shutdownRequested = true;
      actionEpoch += 1;
      // A queued opt-in can create a fresh transport and activity timer.
      // Finish the accepted consent changes before shutting down either one.
      await within(consentQueue.then(async () => {
        // A startup still running gets a short share of the budget, so what it
        // held reaches this flush. Past that it is cancelled.
        await within(startup ?? Promise.resolve(), timeoutMs / 3);
        cancelStartup();
        if (timer !== undefined) stopTimer(timer);
        timer = undefined;
        return Promise.all([transport?.shutdown(timeoutMs), ...crashSends]);
      }), timeoutMs + 250);
      cancelStartup();
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

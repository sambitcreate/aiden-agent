import {
  ANALYTICS_EVENTS,
  EXCEPTION_EVENT,
  EXCEPTION_PROPERTIES,
  SUPER_PROPERTIES,
  isAnalyticsEventName,
  isValidPropValue,
  pickValidProps,
  type AnalyticsEventName,
  type AnalyticsPropSpec,
  type AnalyticsEventProps,
  type AnalyticsExceptionProps,
  type AnalyticsSuperProperties,
} from "./analytics-events.js";
import { sanitizeException, uptimeBucket, type SanitizedException } from "./analytics-sanitize.js";

// The transport-agnostic heart of product analytics: validate against the
// registry, attach super properties, apply flood control, and hand a finished
// message to the transport. It never throws into the caller.

export interface AnalyticsMessage {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
}

export interface AnalyticsTransport {
  capture(message: AnalyticsMessage): void;
}

export interface AnalyticsLimits {
  // Exceptions and app_crashed events per app session.
  readonly maxExceptionsPerSession: number;
  // Non-fatal repeats of the same exception fingerprint per app session.
  readonly maxPerFingerprint: number;
}

export const DEFAULT_ANALYTICS_LIMITS: AnalyticsLimits = { maxExceptionsPerSession: 25, maxPerFingerprint: 3 };

export interface ExceptionContext {
  readonly source: AnalyticsExceptionProps["source"];
  readonly level: AnalyticsExceptionProps["level"];
  readonly processType?: AnalyticsExceptionProps["process_type"];
  readonly origin?: AnalyticsExceptionProps["origin"];
  readonly uptimeSeconds?: number;
  // A crash replayed on the next launch is reported against the version that
  // crashed, not the one sending it.
  readonly appVersion?: string;
}

export interface AnalyticsCoreOptions {
  readonly transport: AnalyticsTransport;
  // Undefined whenever sending is not allowed (off, notice pending, no key).
  readonly getDistinctId: () => string | undefined;
  readonly superProperties: AnalyticsSuperProperties;
  readonly appRoots: readonly string[];
  readonly limits?: Partial<AnalyticsLimits>;
  readonly onInternalError?: (error: unknown) => void;
}

export interface AnalyticsCore {
  track<E extends AnalyticsEventName>(event: E, props: AnalyticsEventProps<E>): boolean;
  captureException(error: unknown, context: ExceptionContext): boolean;
  captureSanitizedException(exception: SanitizedException, context: ExceptionContext): boolean;
  resetSession(): void;
}

const PERSONLESS = { $process_person_profile: false } as const;
const STRIPPED_SDK_KEYS = new Set(["$set", "$set_once", "$unset", "$groups", "$group_set", "$anon_distinct_id"]);

function exceptionList(exception: SanitizedException, context: ExceptionContext): Record<string, unknown>[] {
  const platform = context.source === "renderer" ? "web:javascript" : "node:javascript";
  return exception.errors.map((error, index) => ({
    type: error.type,
    value: error.value,
    mechanism: index === 0
      ? { type: "generic", handled: context.level !== "fatal", synthetic: false, exception_id: 0 }
      : { type: "chained", source: "cause", synthetic: false, exception_id: index, parent_id: index - 1 },
    stacktrace: {
      type: "raw",
      // PostHog expects the outermost caller first, the reverse of a V8 stack.
      frames: [...error.frames].reverse().map((frame) => ({
        platform,
        filename: frame.filename,
        function: frame.function,
        ...(frame.lineno === undefined ? {} : { lineno: frame.lineno, colno: frame.colno }),
        in_app: frame.inApp,
      })),
    },
  }));
}

export function createAnalyticsCore(options: AnalyticsCoreOptions): AnalyticsCore {
  const limits = { ...DEFAULT_ANALYTICS_LIMITS, ...options.limits };
  const superProperties = pickValidProps(SUPER_PROPERTIES, options.superProperties);
  let sessionExceptions = 0;
  const fingerprintCounts = new Map<string, number>();

  function reportInternal(error: unknown): void {
    try {
      options.onInternalError?.(error);
    } catch {
      // Analytics must never take the app down, including through its logger.
    }
  }

  function send(event: string, properties: Record<string, unknown>, overrides?: { appVersion?: string }): boolean {
    if (!superProperties) return false;
    const distinctId = options.getDistinctId();
    if (!distinctId) return false;
    const appVersion = overrides?.appVersion !== undefined
      && pickValidProps({ app_version: SUPER_PROPERTIES.app_version }, { app_version: overrides.appVersion })
      ? overrides.appVersion
      : superProperties.app_version;
    options.transport.capture({
      distinctId,
      event,
      properties: { ...properties, ...superProperties, app_version: appVersion, ...PERSONLESS },
    });
    return true;
  }

  function admitException(fingerprint: string | undefined, fatal: boolean): boolean {
    if (sessionExceptions >= limits.maxExceptionsPerSession) return false;
    if (fingerprint !== undefined && !fatal) {
      const seen = fingerprintCounts.get(fingerprint) ?? 0;
      if (seen >= limits.maxPerFingerprint) return false;
      fingerprintCounts.set(fingerprint, seen + 1);
    }
    sessionExceptions += 1;
    return true;
  }

  function captureSanitizedException(exception: SanitizedException, context: ExceptionContext): boolean {
    try {
      if (!options.getDistinctId()) return false;
      if (!admitException(exception.fingerprint, context.level === "fatal")) return false;
      const props = pickValidProps(EXCEPTION_PROPERTIES, {
        source: context.source,
        level: context.level,
        process_type: context.processType,
        origin: context.origin,
        uptime_bucket: context.uptimeSeconds === undefined ? undefined : uptimeBucket(context.uptimeSeconds),
      });
      if (!props) return false;
      return send(EXCEPTION_EVENT, {
        ...props,
        $exception_list: exceptionList(exception, context),
        $exception_level: context.level,
        $exception_fingerprint: exception.fingerprint,
      }, { appVersion: context.appVersion });
    } catch (error) {
      reportInternal(error);
      return false;
    }
  }

  return {
    track(event, props) {
      try {
        if (!isAnalyticsEventName(event)) return false;
        const picked = pickValidProps(ANALYTICS_EVENTS[event], props as Record<string, unknown>);
        if (!picked) return false;
        if (!options.getDistinctId()) return false;
        if (event === "app_crashed" && !admitException(undefined, true)) return false;
        return send(event, picked);
      } catch (error) {
        reportInternal(error);
        return false;
      }
    },
    captureException(error, context) {
      try {
        if (!options.getDistinctId()) return false;
        return captureSanitizedException(sanitizeException(error, { appRoots: options.appRoots }), context);
      } catch (internal) {
        reportInternal(internal);
        return false;
      }
    },
    captureSanitizedException,
    resetSession() {
      sessionExceptions = 0;
      fingerprintCounts.clear();
    },
  };
}

// The last line of defence, run by the SDK on every outgoing message: only
// registry events, only their declared properties plus super properties and
// the SDK's own `$` metadata, and never person or group data.
export function validateOutgoingEvent<M extends { event: string; properties?: Record<string, unknown> }>(
  message: M,
): M | null {
  const allowed = isAnalyticsEventName(message.event)
    ? ANALYTICS_EVENTS[message.event]
    : message.event === EXCEPTION_EVENT
      ? EXCEPTION_PROPERTIES
      : undefined;
  if (!allowed) return null;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message.properties ?? {})) {
    if (key.startsWith("$")) {
      if (STRIPPED_SDK_KEYS.has(key) || key.startsWith("$feature")) continue;
      if (key.startsWith("$exception") && message.event !== EXCEPTION_EVENT) continue;
      properties[key] = value;
      continue;
    }
    const spec: AnalyticsPropSpec | undefined = Object.prototype.hasOwnProperty.call(allowed, key)
      ? (allowed as Record<string, AnalyticsPropSpec>)[key]
      : Object.prototype.hasOwnProperty.call(SUPER_PROPERTIES, key)
        ? (SUPER_PROPERTIES as Record<string, AnalyticsPropSpec>)[key]
        : undefined;
    if (spec && isValidPropValue(spec, value)) properties[key] = value;
  }
  properties.$process_person_profile = false;
  const cleaned: Record<string, unknown> = { ...message, properties };
  for (const key of ["$set", "$set_once", "groups"]) delete cleaned[key];
  return cleaned as M;
}

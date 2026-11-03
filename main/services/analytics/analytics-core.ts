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
import {
  MAX_CAUSE_DEPTH,
  parseSanitizedError,
  sanitizeException,
  uptimeBucket,
  type SanitizedError,
  type SanitizedException,
} from "./analytics-sanitize.js";

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
const EXCEPTION_PLATFORMS = new Set(["node:javascript", "web:javascript"]);
const EXCEPTION_LEVELS = new Set(["fatal", "error"]);
const FINGERPRINT = /^[0-9a-f]{32}$/u;

function exceptionList(exception: SanitizedException, context: ExceptionContext): Record<string, unknown>[] {
  return buildExceptionList(
    exception.errors,
    context.source === "renderer" ? "web:javascript" : "node:javascript",
    context.level !== "fatal",
  );
}

function buildExceptionList(errors: readonly SanitizedError[], platform: string, handled: boolean): Record<string, unknown>[] {
  return errors.map((error, index) => ({
    type: error.type,
    value: error.value,
    mechanism: index === 0
      ? { type: "generic", handled, synthetic: false, exception_id: 0 }
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// Rebuilds a `$exception_list` from scratch, admitting only what
// exceptionList could have produced from a sanitized exception.
function validExceptionList(value: unknown, fallbackPlatform: string): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAUSE_DEPTH + 1) return undefined;
  let platform: string | undefined;
  let handled = true;
  const errors: SanitizedError[] = [];
  for (const [index, raw] of value.entries()) {
    const entry = recordOf(raw);
    const frames = recordOf(entry?.stacktrace)?.frames;
    if (!entry || !Array.isArray(frames)) return undefined;
    if (index === 0) {
      const mechanismHandled = recordOf(entry.mechanism)?.handled;
      if (typeof mechanismHandled !== "boolean") return undefined;
      handled = mechanismHandled;
    }
    const v8Frames: unknown[] = [];
    for (const rawFrame of [...frames].reverse()) {
      const frame = recordOf(rawFrame);
      if (!frame || typeof frame.platform !== "string" || !EXCEPTION_PLATFORMS.has(frame.platform)) return undefined;
      if (platform !== undefined && frame.platform !== platform) return undefined;
      platform = frame.platform;
      v8Frames.push({ filename: frame.filename, function: frame.function, lineno: frame.lineno, colno: frame.colno, inApp: frame.in_app });
    }
    const error = parseSanitizedError({ type: entry.type, value: entry.value, frames: v8Frames });
    if (!error) return undefined;
    errors.push(error);
  }
  return buildExceptionList(errors, platform ?? fallbackPlatform, handled);
}

// The last line of defence, run by the SDK on every outgoing message: only
// registry events, only their declared properties plus super properties,
// validated exception fields on `$exception`, and never person, group or any
// other `$` data. The SDK adds its own library metadata after this runs.
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
  const source = message.properties ?? {};
  if (message.event === EXCEPTION_EVENT) {
    const list = validExceptionList(source.$exception_list, source.source === "renderer" ? "web:javascript" : "node:javascript");
    if (!list) return null;
    if (typeof source.$exception_level !== "string" || !EXCEPTION_LEVELS.has(source.$exception_level)) return null;
    if (typeof source.$exception_fingerprint !== "string" || !FINGERPRINT.test(source.$exception_fingerprint)) return null;
    properties.$exception_list = list;
    properties.$exception_level = source.$exception_level;
    properties.$exception_fingerprint = source.$exception_fingerprint;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("$")) continue;
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

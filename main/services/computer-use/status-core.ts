import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ComputerUseStatus } from "../types.js";
import {
  CUA_DRIVER_TCC_HOST_BUNDLE_ID,
  CUA_DRIVER_TOOL_SCHEMA,
  CUA_DRIVER_VERSION,
  CuaDriverError,
} from "./contract.js";
import type { CuaDriverHostLike } from "./controller.js";

const DEFAULT_CACHE_MS = 10_000;
const PROBE_TIMEOUT_MS = 20_000;
const SHUTDOWN_GRACE_MS = 5_000;
const REQUIRED_HEALTH_CHECKS = ["binary_version", "platform_supported", "session_active"] as const;

export interface ComputerUseStatusDependencies {
  isEnabled(): Promise<boolean>;
  createHost(signal: AbortSignal): Promise<CuaDriverHostLike>;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function disabledStatus(): ComputerUseStatus {
  return {
    enabled: false,
    beta: true,
    state: "disabled",
    detail: "Turn on the Computer Use beta to make it available in individual chats.",
    ready: false,
    available: false,
    retryable: false,
    canRequestPermissions: false,
    permissions: { accessibility: null, screenRecording: null },
  };
}

function fixedErrorStatus(error: unknown): ComputerUseStatus {
  const code = error instanceof CuaDriverError ? error.code : "unknown";
  if (code === "unsupported_platform") {
    return {
      enabled: true,
      beta: true,
      state: "unsupported",
      detail: "Aiden Computer Use currently requires macOS 14.4 or newer.",
      ready: false,
      available: false,
      retryable: false,
      canRequestPermissions: false,
      permissions: { accessibility: null, screenRecording: null },
    };
  }
  if (code === "host_identity_invalid" || code === "bridge_identity_invalid") {
    return {
      enabled: true,
      beta: true,
      state: "production_build_required",
      detail: "Computer Use requires a signed production build of Aiden.",
      ready: false,
      available: false,
      retryable: false,
      canRequestPermissions: false,
      permissions: { accessibility: null, screenRecording: null },
    };
  }
  if (
    code === "driver_integrity_failed" ||
    code === "invalid_driver_path" ||
    code === "identity_verification_failed" ||
    code === "incompatible_driver" ||
    code === "invalid_tools"
  ) {
    return {
      enabled: true,
      beta: true,
      state: "incompatible",
      detail: "The bundled Computer Use helper failed its compatibility or integrity check.",
      ready: false,
      available: false,
      retryable: false,
      canRequestPermissions: false,
      permissions: { accessibility: null, screenRecording: null },
    };
  }
  if (code === "driver_missing") {
    return {
      enabled: true,
      beta: true,
      state: "unavailable",
      detail: "The pinned Computer Use helper is unavailable in this Aiden build.",
      ready: false,
      available: false,
      retryable: false,
      canRequestPermissions: false,
      permissions: { accessibility: null, screenRecording: null },
    };
  }
  return {
    enabled: true,
    beta: true,
    state: "error",
    detail: "Aiden could not check Computer Use readiness. Try again.",
    ready: false,
    available: false,
    retryable: true,
    canRequestPermissions: false,
    permissions: { accessibility: null, screenRecording: null },
  };
}

function structuredToolResult(value: unknown, toolName: string): Record<string, unknown> {
  const parsed = CallToolResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.isError) {
    throw new CuaDriverError(
      "incompatible_driver",
      `cua-driver returned an invalid ${toolName} result.`,
    );
  }
  const structured = asRecord(parsed.data.structuredContent);
  if (!structured) {
    throw new CuaDriverError(
      "incompatible_driver",
      `cua-driver returned no structured ${toolName} result.`,
    );
  }
  return structured;
}

function readinessStatus(
  health: Record<string, unknown>,
  permissions: Record<string, unknown>,
): ComputerUseStatus {
  const healthChecks = Array.isArray(health.checks) ? health.checks : [];
  const healthByName = new Map(
    healthChecks.flatMap((value) => {
      const check = asRecord(value);
      return typeof check?.name === "string" && typeof check.status === "string"
        ? [[check.name, check.status] as const]
        : [];
    }),
  );
  if (
    health.overall !== "ok" ||
    health.platform !== "darwin" ||
    health.schema_version !== CUA_DRIVER_TOOL_SCHEMA ||
    health.driver_version !== CUA_DRIVER_VERSION ||
    REQUIRED_HEALTH_CHECKS.some((name) => healthByName.get(name) !== "pass")
  ) {
    throw new CuaDriverError(
      "incompatible_driver",
      "cua-driver health did not match Aiden's pinned contract.",
    );
  }

  const accessibility =
    typeof permissions.accessibility === "boolean" ? permissions.accessibility : null;
  const screenRecordingPreflight =
    typeof permissions.screen_recording === "boolean" ? permissions.screen_recording : null;
  const screenRecordingCapturable =
    typeof permissions.screen_recording_capturable === "boolean"
      ? permissions.screen_recording_capturable
      : null;
  const source = asRecord(permissions.source);
  if (
    accessibility === null ||
    screenRecordingPreflight === null ||
    screenRecordingCapturable === null ||
    source?.attribution !== "host" ||
    source.embedded !== true ||
    source.host_bundle_id !== CUA_DRIVER_TCC_HOST_BUNDLE_ID ||
    source.disclaim_env !== false
  ) {
    throw new CuaDriverError(
      "incompatible_driver",
      "cua-driver returned an invalid permission report.",
    );
  }
  // ScreenCaptureKit is the live capability probe. The cheaper TCC preflight
  // can be stale or answer for the wrong responsible process.
  const screenRecording = screenRecordingCapturable;

  if (accessibility && screenRecording) {
    return {
      enabled: true,
      beta: true,
      state: "ready",
      detail: "Accessibility and Screen Recording are available to Aiden Computer Use.",
      ready: true,
      available: true,
      retryable: false,
      canRequestPermissions: false,
      driverVersion: CUA_DRIVER_VERSION,
      permissions: { accessibility, screenRecording },
    };
  }

  const missing = [
    accessibility ? null : "Accessibility",
    screenRecording ? null : "Screen Recording",
  ].filter((item): item is string => item !== null);
  return {
    enabled: true,
    beta: true,
    state: "permission_required",
    detail: `${missing.join(" and ")} permission${missing.length === 1 ? " is" : "s are"} required.`,
    ready: false,
    available: true,
    retryable: true,
    canRequestPermissions: true,
    driverVersion: CUA_DRIVER_VERSION,
    permissions: { accessibility, screenRecording },
  };
}

async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function requestCancelledError(signal?: AbortSignal): CuaDriverError {
  return signal?.reason instanceof CuaDriverError
    ? signal.reason
    : new CuaDriverError("cancelled", "Computer Use readiness request was cancelled.");
}

function throwIfRequestCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw requestCancelledError(signal);
}

function waitWithRequestSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfRequestCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const aborted = () => finish({ error: requestCancelledError(signal) });
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
    if (signal.aborted) aborted();
  });
}

/** Readiness/permission probing with a short cache and one authenticated helper per probe. */
export class ComputerUseStatusService {
  private cached: { expiresAt: number; status: ComputerUseStatus } | null = null;
  private inFlight: {
    revision: number;
    kind: "status" | "permission";
    promise: Promise<ComputerUseStatus>;
  } | null = null;
  private readonly probeControllers = new Set<AbortController>();
  private revision = 0;
  private runtimeEnabled: boolean | null = null;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly dependencies: ComputerUseStatusDependencies,
    private readonly cacheMs = DEFAULT_CACHE_MS,
  ) {}

  invalidate(): void {
    this.cached = null;
    this.revision += 1;
    for (const controller of this.probeControllers) {
      controller.abort(new CuaDriverError("cancelled", "Computer Use readiness changed."));
    }
  }

  /** Apply the live gate before a persistence transition can yield. */
  setRuntimeEnabled(enabled: boolean): void {
    if (this.closed) return;
    this.runtimeEnabled = enabled;
    this.invalidate();
  }

  private async enabledAtRevision(revision: number): Promise<boolean | null> {
    if (this.closed) return false;
    if (this.runtimeEnabled !== null) {
      return revision === this.revision ? this.runtimeEnabled : null;
    }
    const persisted = await this.dependencies.isEnabled();
    if (this.closed) return false;
    if (revision !== this.revision) return null;
    return this.runtimeEnabled ?? persisted;
  }

  async status(
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<ComputerUseStatus> {
    for (;;) {
      throwIfRequestCancelled(options.signal);
      if (this.closed) return fixedErrorStatus(new CuaDriverError("host_closed", "closed"));
      const revision = this.revision;
      const enabled = await this.enabledAtRevision(revision);
      throwIfRequestCancelled(options.signal);
      if (enabled === null) continue;
      if (!enabled) return disabledStatus();

      const now = (this.dependencies.now ?? Date.now)();
      if (!options.force && this.cached && this.cached.expiresAt > now) return this.cached.status;

      const existing = this.inFlight;
      if (existing) {
        await waitWithRequestSignal(existing.promise, options.signal);
        throwIfRequestCancelled(options.signal);
        if (this.inFlight?.promise === existing.promise) this.inFlight = null;
        continue;
      }

      // There is no await between the revision-bound gate check above and
      // probe(), so disabling cannot interleave before createHost is invoked.
      const probe = this.probe(false, options.signal);
      this.inFlight = { revision, kind: "status", promise: probe };
      const result = await probe;
      throwIfRequestCancelled(options.signal);
      if (this.inFlight?.promise === probe) this.inFlight = null;
      if (revision !== this.revision) continue;
      const stillEnabled = await this.enabledAtRevision(revision);
      throwIfRequestCancelled(options.signal);
      if (stillEnabled === null) continue;
      if (!stillEnabled) return disabledStatus();
      this.cached = {
        status: result,
        expiresAt: (this.dependencies.now ?? Date.now)() + this.cacheMs,
      };
      return result;
    }
  }

  async requestPermissions(options: { signal?: AbortSignal } = {}): Promise<ComputerUseStatus> {
    throwIfRequestCancelled(options.signal);
    if (this.inFlight?.kind !== "permission") this.invalidate();
    for (;;) {
      throwIfRequestCancelled(options.signal);
      if (this.closed) return fixedErrorStatus(new CuaDriverError("host_closed", "closed"));
      const revision = this.revision;
      const enabled = await this.enabledAtRevision(revision);
      throwIfRequestCancelled(options.signal);
      if (enabled === null) continue;
      if (!enabled) return disabledStatus();

      const existing = this.inFlight;
      if (existing) {
        const result = await waitWithRequestSignal(existing.promise, options.signal);
        throwIfRequestCancelled(options.signal);
        if (this.inFlight?.promise === existing.promise) this.inFlight = null;
        if (existing.kind === "permission" && existing.revision === revision) {
          if (revision !== this.revision) continue;
          const stillEnabled = await this.enabledAtRevision(revision);
          throwIfRequestCancelled(options.signal);
          if (stillEnabled === null) continue;
          if (!stillEnabled) return disabledStatus();
          return result;
        }
        continue;
      }

      const probe = this.promptAndRecheck(revision, options.signal);
      this.inFlight = { revision, kind: "permission", promise: probe };
      const result = await probe;
      throwIfRequestCancelled(options.signal);
      if (this.inFlight?.promise === probe) this.inFlight = null;
      if (revision !== this.revision) continue;
      const stillEnabled = await this.enabledAtRevision(revision);
      throwIfRequestCancelled(options.signal);
      if (stillEnabled === null) continue;
      if (!stillEnabled) return disabledStatus();
      this.cached = {
        status: result,
        expiresAt: (this.dependencies.now ?? Date.now)() + this.cacheMs,
      };
      return result;
    }
  }

  private async promptAndRecheck(
    revision: number,
    signal?: AbortSignal,
  ): Promise<ComputerUseStatus> {
    const prompted = await this.probe(true, signal);
    throwIfRequestCancelled(signal);
    if (revision !== this.revision || this.closed) return prompted;
    const enabled = await this.enabledAtRevision(revision);
    throwIfRequestCancelled(signal);
    if (enabled !== true || !prompted.available)
      return enabled === false ? disabledStatus() : prompted;
    // The embedded child can retain a stale TCC answer. probe() has already
    // shut down its host before this fresh helper is constructed.
    return this.probe(false, signal);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.invalidate();
    const pending = this.inFlight?.promise ?? Promise.resolve();
    this.shutdownPromise = settleWithin(pending, SHUTDOWN_GRACE_MS);
    return this.shutdownPromise;
  }

  private async probe(prompt: boolean, signal?: AbortSignal): Promise<ComputerUseStatus> {
    throwIfRequestCancelled(signal);
    const controller = new AbortController();
    this.probeControllers.add(controller);
    const requestAborted = () => controller.abort(requestCancelledError(signal));
    signal?.addEventListener("abort", requestAborted, { once: true });
    if (signal?.aborted) requestAborted();
    const timer = setTimeout(
      () =>
        controller.abort(
          new CuaDriverError("startup_timeout", "Computer Use readiness timed out.", true),
        ),
      PROBE_TIMEOUT_MS,
    );
    timer.unref();
    let host: CuaDriverHostLike | null = null;
    try {
      host = await this.dependencies.createHost(controller.signal);
      const session = await host.createSession(controller.signal);
      const health = structuredToolResult(
        await session.callTool(
          "health_report",
          { include: [...REQUIRED_HEALTH_CHECKS] },
          { signal: controller.signal },
        ),
        "health report",
      );
      const permissions = structuredToolResult(
        await session.callTool("check_permissions", { prompt }, { signal: controller.signal }),
        "permission",
      );
      return readinessStatus(health, permissions);
    } catch (error) {
      return fixedErrorStatus(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", requestAborted);
      this.probeControllers.delete(controller);
      if (host) await settleWithin(host.shutdown(), SHUTDOWN_GRACE_MS);
    }
  }
}

/**
 * Product analytics for the `aiden serve` process, kept apart from the
 * desktop's Electron binding. Only that process sends, plus the switch in
 * telemetry.ts; admin commands never run it. Consent lives in its own file in
 * the agent directory, never in Pi's settings.json. The sanitizer, core and
 * PostHog client are imported only once a server may send. See docs/analytics.md.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { ANALYTICS_BUILD_CONFIG, type AnalyticsBuildConfig } from "../../../main/services/analytics/analytics-build-config.js";
import type { PostHogTransport } from "../../../main/services/analytics/analytics-client.js";
import {
  DEFAULT_ANALYTICS_STATE,
  analyticsSendStatus,
  ensureInstallId,
  envDisablesAnalytics,
  markNoticeShown,
  parseAnalyticsState,
  type AnalyticsBlockReason,
  type AnalyticsState,
} from "../../../main/services/analytics/analytics-consent.js";
import type { AnalyticsCore, AnalyticsMessage } from "../../../main/services/analytics/analytics-core.js";
import type { AnalyticsEventProps, AnalyticsSuperProperties } from "../../../main/services/analytics/analytics-events.js";
import { setAnalyticsReporter, type AnalyticsReporter } from "../../../main/services/analytics/analytics-report.js";
import { atomicJson } from "./state.ts";

type Env = Readonly<Record<string, string | undefined>>;
export type ServerLaunch = AnalyticsEventProps<"server_started">["launch"];

export const SERVER_ANALYTICS_FILE = "aiden-analytics.json";
export const SERVER_CRASH_COUNT_FILE = "aiden-analytics-crashes.json";
export const SERVER_ANALYTICS_NOTICE = "This Aiden server sends anonymous usage and crash data. Turn off: aiden telemetry off\n";
/** How long a crash may wait for its report before the process dies as it would have. */
export const CRASH_FLUSH_CAP_MS = 1_000;
/** A server drains its own work first; analytics adds no more than this to a stop. */
export const SERVE_EXIT_FLUSH_CAP_MS = 250;
/** A service manager restarts a crashing server every few seconds; this stops it flooding the project. */
export const MAX_CRASH_REPORTS_PER_DAY = 25;
/** A process that died holding the consent lock loses it after this. */
const CONSENT_LOCK_STALE_MS = 5_000;
/** `aiden telemetry on|off` outwaits a dead holder, so a crash can't make the switch fail. */
export const CONSENT_SWITCH_WAIT_MS = CONSENT_LOCK_STALE_MS + 1_000;
/** A waiting server's event loop is stopped, so it gives up quickly and sends nothing. */
const SERVER_LOCK_WAIT_MS = 100;
const LOCK_RETRY_MS = 10;
const OPT_OUT_CAP_MS = 1_500;
const MAX_EARLY_EVENTS = 50;

/** Decides whether a request may go out. A transport checks it before every dispatch. */
export type SendGate = () => boolean;
export type ServerTransportFactory = (allowSend?: SendGate) => Promise<PostHogTransport>;

/** The parts of `process` crash capture touches. Tests pass a fake. */
export interface CrashHost {
  on(event: "uncaughtException", listener: (error: unknown, origin: string) => void): unknown;
  removeListener(event: "uncaughtException", listener: (error: unknown, origin: string) => void): unknown;
  listenerCount(event: "uncaughtException"): number;
}

export interface ServerAnalyticsContext {
  readonly agentDir: string;
  /** The bundle root: holds the version's package.json, and stack frames under it are the app's. */
  readonly appDir: string;
  readonly env: Env;
  readonly stderr: { write(text: string): unknown; readonly isTTY?: boolean };
  readonly buildConfig?: AnalyticsBuildConfig;
  /** Tests inject a fake transport. Otherwise a keyless build gets none and never loads the client. */
  readonly createTransport?: ServerTransportFactory;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly crashHost?: CrashHost;
  readonly crashFlushCapMs?: number;
  /** Ends the process the way an uncaught error would have. */
  readonly rethrow?: (error: unknown) => void;
}

export function serverAnalyticsContext(agentDir: string): ServerAnalyticsContext {
  const entry = process.env.AIDEN_CLI_ENTRY;
  return { agentDir, appDir: entry ? dirname(entry) : process.cwd(), env: process.env, stderr: process.stderr };
}

export function serverAnalyticsFile(agentDir: string): string {
  return join(agentDir, SERVER_ANALYTICS_FILE);
}

/** A file that is there but unreadable may have held an opt-out, so it counts as off. */
const UNREADABLE_STATE: AnalyticsState = { enabled: false };

/** A missing file reads as the default, which has no notice and so sends nothing. */
export function readServerAnalyticsState(agentDir: string): AnalyticsState {
  let text: string;
  try {
    text = readFileSync(serverAnalyticsFile(agentDir), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? DEFAULT_ANALYTICS_STATE : UNREADABLE_STATE;
  }
  try {
    const raw = JSON.parse(text) as { enabled?: unknown } | null;
    return typeof raw?.enabled === "boolean" ? parseAnalyticsState(raw) : UNREADABLE_STATE;
  } catch {
    return UNREADABLE_STATE;
  }
}

const lockRetryClock = new Int32Array(new SharedArrayBuffer(4));

/**
 * Exclusive across processes. Every change to the consent file and every
 * request happens inside it, so once `aiden telemetry off` returns no stale
 * write can restore the old state and no new request can start. `work` must be
 * synchronous: the lock is released as soon as it returns.
 */
function withConsentLock<T>(agentDir: string, waitMs: number, work: () => T): T {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let unlock: () => void;
    try {
      unlock = lockfile.lockSync(serverAnalyticsFile(agentDir), { realpath: false, stale: CONSENT_LOCK_STALE_MS });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(lockRetryClock, 0, 0, LOCK_RETRY_MS);
      continue;
    }
    try {
      return work();
    } finally {
      try {
        unlock();
      } catch {
        // The work is done, and a lock left behind goes stale by itself.
      }
    }
  }
}

export function updateServerAnalyticsState(agentDir: string, mutate: (state: AnalyticsState) => AnalyticsState, waitMs = SERVER_LOCK_WAIT_MS): AnalyticsState {
  return withConsentLock(agentDir, waitMs, () => {
    const current = readServerAnalyticsState(agentDir);
    const next = mutate(current);
    if (next !== current) atomicJson(serverAnalyticsFile(agentDir), next);
    return next;
  });
}

/** Runs `send` if consent holds. A lock that can't be had sends nothing. */
function admitted<T>(agentDir: string, allowSend: SendGate, send: () => T): T | undefined {
  try {
    return withConsentLock(agentDir, SERVER_LOCK_WAIT_MS, () => (allowSend() ? send() : undefined));
  } catch {
    return undefined;
  }
}

export type ServerBlockReason = AnalyticsBlockReason | "ci";
export type ServerSendStatus = { readonly canSend: true } | { readonly canSend: false; readonly reason: ServerBlockReason };

/** The desktop's rules plus one of the server's own: nothing is ever sent with `CI` set. */
export function serverSendStatus(state: AnalyticsState, context: { readonly env: Env; readonly hasKey: boolean }): ServerSendStatus {
  if (!envDisablesAnalytics(context.env) && context.env.CI !== undefined) return { canSend: false, reason: "ci" };
  return analyticsSendStatus(state, context);
}

/**
 * The transport this build can use, or undefined: only a keyed build sends. A
 * keyless build can write would-be events to stderr with AIDEN_ANALYTICS_DEBUG=1.
 */
export function serverTransportFactory(context: ServerAnalyticsContext): ServerTransportFactory | undefined {
  if (context.createTransport) return context.createTransport;
  const apiKey = (context.buildConfig ?? ANALYTICS_BUILD_CONFIG).projectKey;
  if (apiKey) {
    return async (allowSend) => {
      const { createPostHogTransport } = await import("../../../main/services/analytics/analytics-client.js");
      return createPostHogTransport({
        apiKey,
        ...(allowSend
          ? {
              fetch: async (url, options) => {
                // Answered here because the SDK prints a stack trace for a failed flush.
                return admitted(context.agentDir, allowSend, () => fetch(url, options)) ?? new Response("{}", { status: 200 });
              },
            }
          : {}),
      });
    };
  }
  if (context.env.AIDEN_ANALYTICS_DEBUG === "1") {
    return async () => {
      const { createLoggingTransport } = await import("../../../main/services/analytics/analytics-service.js");
      return createLoggingTransport((line) => context.stderr.write(`${line}\n`));
    };
  }
  return undefined;
}

function superProperties(context: ServerAnalyticsContext): AnalyticsSuperProperties {
  const { version } = JSON.parse(readFileSync(join(context.appDir, "package.json"), "utf8")) as { version: string };
  const major = Number.parseInt(release(), 10);
  return {
    app_version: version,
    platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
    arch: process.arch === "arm64" || process.arch === "x64" ? process.arch : "other",
    os_major: Number.isSafeInteger(major) && major >= 0 && major <= 999 ? major : 0,
    surface: "server",
    channel: (context.buildConfig ?? ANALYTICS_BUILD_CONFIG).channel,
  };
}

function crashesToday(agentDir: string, day: string): number {
  try {
    const saved = JSON.parse(readFileSync(join(agentDir, SERVER_CRASH_COUNT_FILE), "utf8")) as { day?: unknown; count?: unknown };
    return saved.day === day && Number.isSafeInteger(saved.count) ? (saved.count as number) : 0;
  } catch {
    return 0;
  }
}

function today(context: ServerAnalyticsContext): string {
  return (context.now ?? (() => new Date()))().toISOString().slice(0, 10);
}

/** Ref'd on purpose: a caller awaiting this must not lose its exit code to an empty event loop. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

const NODE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const MAX_REPORTED_CAUSES = 4;

/**
 * What a server's crash report may say about an error: its type, frames and
 * Node error code. A server's messages quote file names, hosts and prompt text
 * that no redactor can recognize, so the message itself never leaves.
 */
function withoutMessage(value: unknown, depth = 0): unknown {
  try {
    if (typeof value !== "object" || value === null) return { name: "NonError", message: "" };
    const { name, stack, code, cause } = value as { name?: unknown; stack?: unknown; code?: unknown; cause?: unknown };
    return {
      name,
      stack,
      message: typeof code === "string" && NODE_ERROR_CODE.test(code) ? code : "",
      ...(cause !== undefined && cause !== null && depth < MAX_REPORTED_CAUSES ? { cause: withoutMessage(cause, depth + 1) } : {}),
    };
  } catch {
    // Reading an exotic thrown object can itself throw.
    return { name: "NonError", message: "" };
  }
}

export interface ServerAnalyticsRun {
  /** The server is up. A start that fails, such as a second `aiden serve`, is not counted. */
  ready(): void;
  /** Sends what is queued within a short cap. Call before the process exits. */
  finish(): Promise<void>;
}

const INERT_RUN: ServerAnalyticsRun = { ready: () => {}, finish: async () => {} };

let reportRejection: ((reason: unknown) => void) | undefined;

/** A rejection the server logged and survived. Fatal ones arrive as uncaught exceptions. */
export function reportServerRejection(reason: unknown): void {
  try {
    reportRejection?.(reason);
  } catch {
    // Analytics must never turn a logged rejection into a crash.
  }
}

function createRun(launch: ServerLaunch, context: ServerAnalyticsContext, createTransport: ServerTransportFactory): ServerAnalyticsRun {
  const crashHost = context.crashHost ?? process;
  const rethrow = context.rethrow ?? ((error: unknown) => { setImmediate(() => { throw error; }); });
  const early: ((ready: AnalyticsCore) => void)[] = [];
  let core: AnalyticsCore | undefined;
  let transport: PostHogTransport | undefined;
  let installId: string | undefined;
  let stopped = false;
  // Pending while a crash is being reported. Never settles when it is fatal.
  let crash: Promise<void> | undefined;

  function detach(): void {
    crashHost.removeListener("uncaughtException", onUncaught);
    setAnalyticsReporter(undefined);
    reportRejection = undefined;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    detach();
    transport?.revokeQueue();
    void transport?.discard().catch(() => undefined);
  }

  // The switch lives in a file that `aiden telemetry off` can change while a
  // server runs. Reading it before every event and every request means nothing
  // leaves after the switch, and the old ID never sends again.
  function consentHolds(): boolean {
    if (stopped) return false;
    const current = readServerAnalyticsState(context.agentDir);
    if (current.enabled && installId !== undefined && current.installId === installId) return true;
    stop();
    return false;
  }

  async function activate(): Promise<void> {
    if (stopped) return;
    const state = updateServerAnalyticsState(context.agentDir, (current) => ensureInstallId(current, context.randomUUID ?? nodeRandomUUID));
    if (!state.enabled || !state.installId) { stop(); return; }
    installId = state.installId;
    const [{ createAnalyticsCore }, created] = await Promise.all([
      import("../../../main/services/analytics/analytics-core.js"),
      createTransport(consentHolds),
    ]);
    if (stopped) { await created.discard(); return; }
    transport = created;
    const ready = createAnalyticsCore({
      transport: created,
      getDistinctId: () => (consentHolds() ? installId : undefined),
      superProperties: superProperties(context),
      appRoots: [context.appDir],
    });
    core = ready;
    for (const send of early.splice(0)) send(ready);
    void created.flush();
  }

  const reporter: AnalyticsReporter = (event, props) => {
    if (core) core.track(event, props);
    else if (!stopped && early.length < MAX_EARLY_EVENTS) early.push((ready) => ready.track(event, props));
  };

  function onUncaught(error: unknown, origin: string): void {
    if (crash) return;
    // With another listener Node would have kept running, so this one must too.
    const fatal = crashHost.listenerCount("uncaughtException") === 1;
    if (fatal) {
      try {
        const day = today(context);
        atomicJson(join(context.agentDir, SERVER_CRASH_COUNT_FILE), { day, count: crashesToday(context.agentDir, day) + 1 });
      } catch {
        // Without the count a crash loop is limited only by its restart delay.
      }
    }
    const reported = within(activation.then(() => {
      core?.captureException(withoutMessage(error), {
        source: "server",
        level: fatal ? "fatal" : "error",
        processType: "server",
        origin: origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
        uptimeSeconds: process.uptime(),
      });
      return transport?.flush();
    }), context.crashFlushCapMs ?? CRASH_FLUSH_CAP_MS);
    crash = reported.then(() => {
      if (!fatal) { crash = undefined; return undefined; }
      crashHost.removeListener("uncaughtException", onUncaught);
      rethrow(error);
      return new Promise<void>(() => undefined);
    });
  }

  setAnalyticsReporter(reporter);
  crashHost.on("uncaughtException", onUncaught);
  reportRejection = (reason) => {
    void activation.then(() => core?.captureException(withoutMessage(reason), {
      source: "server",
      level: "error",
      processType: "server",
      origin: "unhandled_rejection",
      uptimeSeconds: process.uptime(),
    }));
  };

  // Off the startup path: nothing here delays the server that is starting.
  const activation: Promise<void> = new Promise<void>((resolve) => { setImmediate(resolve); })
    .then(activate)
    .catch(() => stop());

  return {
    ready() {
      reporter("server_started", { launch });
      // Otherwise the event would wait for the SDK's 30 s timer.
      void transport?.flush();
    },
    async finish() {
      // A fatal crash ends the process through its own rethrow, whatever exit was coming.
      await crash;
      await within(activation.then(() => transport?.shutdown(SERVE_EXIT_FLUSH_CAP_MS)), SERVE_EXIT_FLUSH_CAP_MS);
      // A failure during the stop decides how the process ends, not this stop.
      while (crash) await crash;
      stopped = true;
      detach();
    },
  };
}

/**
 * The one-time notice, recorded once shown. A keyless build sends nothing, so
 * it has nothing to announce. Never throws: a notice that could not be recorded
 * stays pending, and sending stays off.
 */
export function showServerNotice(context: ServerAnalyticsContext): void {
  try {
    if (!serverTransportFactory(context)) return;
    const status = serverSendStatus(readServerAnalyticsState(context.agentDir), { env: context.env, hasKey: true });
    if (status.canSend || status.reason !== "notice_pending") return;
    context.stderr.write(SERVER_ANALYTICS_NOTICE);
    const now = (context.now ?? (() => new Date()))();
    updateServerAnalyticsState(context.agentDir, (current) => markNoticeShown(current, now));
  } catch {
    // Analytics must never stop a server from starting.
  }
}

/** A server started by hand shows the notice only where someone can read it. */
export function showServerNoticeInTerminal(context: ServerAnalyticsContext): void {
  if (context.stderr.isTTY === true) showServerNotice(context);
}

/**
 * Starts reporting for this `aiden serve` process if it may send. A server that
 * never showed the notice stays silent. Returns at once and never throws.
 */
export function startServerAnalytics(launch: ServerLaunch, context: ServerAnalyticsContext): ServerAnalyticsRun {
  try {
    showServerNoticeInTerminal(context);
    const createTransport = serverTransportFactory(context);
    if (!createTransport) return INERT_RUN;
    const state = readServerAnalyticsState(context.agentDir);
    if (!serverSendStatus(state, { env: context.env, hasKey: true }).canSend) return INERT_RUN;
    if (crashesToday(context.agentDir, today(context)) >= MAX_CRASH_REPORTS_PER_DAY) return INERT_RUN;
    return createRun(launch, context, createTransport);
  } catch {
    return INERT_RUN;
  }
}

/**
 * The last event of an install, built by the same core as every other event
 * and sent on its own client. Never throws: the switch is already saved.
 */
export async function sendServerOptOut(installId: string, context: ServerAnalyticsContext, createTransport: ServerTransportFactory): Promise<void> {
  let transport: PostHogTransport | undefined;
  try {
    const { createAnalyticsCore } = await import("../../../main/services/analytics/analytics-core.js");
    const created = await createTransport();
    transport = created;
    let finalMessage: AnalyticsMessage | undefined;
    createAnalyticsCore({
      transport: { capture: (message) => { finalMessage = message; } },
      getDistinctId: () => installId,
      superProperties: superProperties(context),
      appRoots: [context.appDir],
    }).track("analytics_disabled", {});
    if (finalMessage) await within(created.captureOptOut(finalMessage), OPT_OUT_CAP_MS);
  } catch {
    // The install ID is already gone; a lost final event only skews one count.
  } finally {
    await transport?.discard().catch(() => undefined);
  }
}

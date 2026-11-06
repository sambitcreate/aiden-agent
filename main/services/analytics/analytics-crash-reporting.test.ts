import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PostHogTransport } from "./analytics-client.js";
import type { AnalyticsState } from "./analytics-consent.js";
import { validateOutgoingEvent, type AnalyticsMessage } from "./analytics-core.js";
import { PENDING_CRASH_FILE, RUN_MARKER_FILE } from "./analytics-crash.js";
import { createAnalyticsService, createLoggingTransport, type AnalyticsService, type AnalyticsServiceOptions } from "./analytics-service.js";

// Real sanitizing, consent and pending-crash files, through a fake transport,
// across simulated exits and relaunches: each `launch()` is a new process
// sharing only the settings and the run directory.

const SUPER = { app_version: "1.40.0", platform: "darwin", arch: "arm64", os_major: 26, surface: "desktop", channel: "release" } as const;
const APP_ROOT = "/Applications/Aiden.app/Contents/Resources/app.asar";
const NOTICE = "2026-10-01T00:00:00.000Z";
const ALLOWED: AnalyticsState = { enabled: true, noticeShownAt: NOTICE, lastVersion: "1.40.0" };

let nextUuid = 0;
function uuid(): string {
  nextUuid += 1;
  return `00000000-0000-4000-8000-${String(nextUuid).padStart(12, "0")}`;
}

type SendResult = "ok" | "fail" | "hang" | "reject";

function device(t: { after(fn: () => void): void }, initial: AnalyticsState = ALLOWED) {
  const directory = mkdtempSync(join(tmpdir(), "aiden-crash-reporting-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let stored = initial;
  const network: AnalyticsMessage[] = [];
  const queued: AnalyticsMessage[] = [];
  const sending: boolean[] = [];
  let sendResult: SendResult = "ok";

  function transport(): PostHogTransport {
    let open = true;
    return {
      capture: (message) => { if (open) queued.push(message); },
      revokeQueue: () => { open = false; queued.length = 0; },
      captureOptOut: async (message) => void network.push(message),
      captureNow: (message) => {
        if (!open) return Promise.resolve(false);
        if (sendResult === "hang") return new Promise<boolean>(() => undefined);
        if (sendResult === "reject") return Promise.reject(new Error("transport broke"));
        if (sendResult === "fail") return Promise.resolve(false);
        network.push(message);
        return Promise.resolve(true);
      },
      flush: async () => void network.push(...queued.splice(0)),
      shutdown: async () => {
        network.push(...queued.splice(0));
        open = false;
      },
      discard: async () => { open = false; queued.length = 0; },
    };
  }

  function launch(overrides: Partial<AnalyticsServiceOptions> = {}): AnalyticsService {
    return createAnalyticsService({
      store: {
        read: async () => stored,
        update: async (mutate) => (stored = mutate(stored)),
      },
      env: {},
      createTransport: async () => transport(),
      superProperties: { ...SUPER },
      appRoots: [APP_ROOT],
      runDirectory: directory,
      isBuiltinProvider: () => false,
      readStateSync: () => stored,
      onSendingChanged: (value) => sending.push(value),
      uptimeSeconds: () => 90,
      randomUUID: uuid,
      setInterval: () => ({}),
      clearInterval: () => undefined,
      ...overrides,
    });
  }

  const crashes = () => [...network, ...queued].filter((message) => message.event === "$exception" || message.event === "app_crashed");
  return {
    directory,
    launch,
    network,
    queued,
    sending,
    crashes,
    pendingFile: () => join(directory, PENDING_CRASH_FILE),
    hasPending: () => existsSync(join(directory, PENDING_CRASH_FILE)),
    hasMarker: () => existsSync(join(directory, RUN_MARKER_FILE)),
    stored: () => stored,
    setStored: (next: AnalyticsState) => { stored = next; },
    setSendResult: (next: SendResult) => { sendResult = next; },
    forgetNetwork: () => { network.length = 0; queued.length = 0; },
  };
}

function fatalError(message = "Maximum call stack size exceeded"): Error {
  const error = new RangeError(message);
  error.stack = `RangeError: ${message}\n    at boot (${APP_ROOT}/build/main/index.js:5:2)`;
  return error;
}

const fatalEvent = { event: "uncaught-exception", fields: { origin: "uncaughtException" } };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function exceptionValues(message: AnalyticsMessage): string[] {
  return (message.properties.$exception_list as { value: string }[]).map((entry) => entry.value);
}

test("a fatal crash reaches disk first, goes out at once, and leaves no record once acknowledged", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.forgetNetwork();
  d.setSendResult("hang");

  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });

  // Synchronously on disk: the process may not live to the next tick.
  assert.equal(d.hasPending(), true);
  assert.equal(readFileSync(d.pendingFile(), "utf8").includes("/Applications"), false);

  d.setSendResult("ok");
  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  await settle();

  const sent = d.network[d.network.length - 1]!;
  assert.equal(sent.event, "$exception");
  assert.equal(sent.properties.level, "fatal");
  assert.equal(sent.properties.source, "main");
  assert.equal(sent.properties.process_type, "browser");
  assert.equal(sent.properties.origin, "uncaught_exception");
  assert.equal(sent.properties.uptime_bucket, "1-10m");
  assert.equal(sent.properties.$process_person_profile, false);
  assert.equal(d.hasPending(), false);
});

test("a rejection that does end the process, under Node's throw mode, keeps its origin on the fatal report", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.forgetNetwork();

  service.handleDiagnosticEvent({ event: "uncaught-exception", fields: { origin: "unhandledRejection" } }, { rawError: fatalError() });
  await settle();

  assert.equal(d.network[0]!.properties.origin, "unhandled_rejection");
  assert.equal(d.network[0]!.properties.level, "fatal");
});

test("a main-process rejection the app survives is an error, sanitized, with nothing left for the next launch", async (t) => {
  const d = device(t);
  const service = d.launch();
  service.beginRun();
  await service.start();
  d.forgetNetwork();

  const reason = new TypeError("Summarise my divorce papers at /Users/jane/legal.pdf");
  reason.stack = `TypeError: ${reason.message}\n    at run (${APP_ROOT}/build/main/index.js:9:1)\n    at read (/Users/jane/x.js:1:1)`;
  service.handleDiagnosticEvent({ event: "unhandled-rejection" }, { rawError: reason });
  await settle();

  const [report] = d.crashes();
  assert.equal(d.crashes().length, 1);
  assert.equal(report!.properties.level, "error");
  assert.equal(report!.properties.source, "main");
  assert.equal(report!.properties.origin, "unhandled_rejection");
  assert.equal(d.hasPending(), false);
  const sent = JSON.stringify(report);
  for (const leak of ["divorce", "jane", "legal.pdf"]) assert.equal(sent.includes(leak), false, leak);
  assert.notEqual(validateOutgoingEvent(report!), null);

  // Repeats of one rejection stop at the flood limit, like any non-fatal error.
  for (let index = 0; index < 5; index += 1) service.handleDiagnosticEvent({ event: "unhandled-rejection" }, { rawError: reason });
  assert.equal(d.crashes().length, 3);
});

test("the development debug log keeps a report's fields inside its 1,024-character line", async (t) => {
  const d = device(t);
  const lines: string[] = [];
  const service = d.launch({ createTransport: async () => createLoggingTransport((line) => lines.push(line)) });
  await service.start();

  const error = new RangeError("Maximum call stack size exceeded");
  const frames = Array.from({ length: 30 }, (_, index) => `    at step${index} (${APP_ROOT}/build/main/index.js:${index + 1}:1)`);
  error.stack = `RangeError: ${error.message}\n${frames.join("\n")}`;
  service.handleDiagnosticEvent({ event: "unhandled-rejection" }, { rawError: error });

  const line = lines.find((entry) => entry.includes("$exception"));
  assert.ok(line && line.length > 1_024);
  assert.match(line.slice(0, 1_024), /"source":"main".*"origin":"unhandled_rejection"|"origin":"unhandled_rejection".*"source":"main"/u);
});

test("startup failing after capture began is kept as a fatal crash, and sent on the next launch", async (t) => {
  const d = device(t, { ...ALLOWED, installId: uuid() });
  const crashed = d.launch();
  crashed.beginRun();

  crashed.handleDiagnosticEvent({ event: "bootstrap-import-failed" }, { rawError: fatalError() });
  assert.equal(d.hasPending(), true);

  const next = d.launch();
  next.beginRun();
  await next.start();
  await settle();

  assert.deepEqual(d.crashes().map((message) => [message.event, message.properties.level, message.properties.origin]), [["$exception", "fatal", "pending_crash"]]);
  assert.equal(d.hasPending(), false);
});

test("an older crash still waiting to be sent does not explain away the last run's native crash", async (t) => {
  const d = device(t);
  const fatalRun = d.launch();
  fatalRun.beginRun();
  await fatalRun.start();
  d.setSendResult("fail");
  fatalRun.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  await settle();
  assert.equal(d.hasPending(), true);
  fatalRun.handleDiagnosticEvent({ event: "process-exit" });
  d.forgetNetwork();

  // Offline again, and this run dies with no JavaScript running.
  const nativeRun = d.launch();
  nativeRun.beginRun();
  await nativeRun.start();
  await settle();
  d.forgetNetwork();

  d.setSendResult("ok");
  const next = d.launch();
  next.beginRun();
  await next.start();
  await settle();
  await next.shutdown();

  assert.deepEqual(d.crashes().map((message) => message.event).sort(), ["$exception", "app_crashed"]);
  assert.equal(d.crashes().find((message) => message.event === "app_crashed")?.properties.kind, "unclean_exit");
});

test("a crash the process did not outlive is sent once on the next launch, as the version and time it happened", async (t) => {
  const d = device(t);
  const crashing = d.launch({ now: () => new Date("2026-10-30T12:00:00.000Z") });
  await crashing.start();
  d.setSendResult("hang");
  crashing.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  const firstId = JSON.parse(readFileSync(d.pendingFile(), "utf8")).id as string;
  d.setSendResult("ok");
  d.forgetNetwork();

  // Exit without a clean quit, then relaunch on a newer version.
  const next = d.launch({ superProperties: { ...SUPER, app_version: "1.41.0" } });
  await next.start();
  await settle();

  const crashes = d.crashes();
  assert.equal(crashes.length, 1, "the unclean exit is already explained by the crash");
  assert.equal(crashes[0]!.event, "$exception");
  assert.equal(crashes[0]!.properties.origin, "pending_crash");
  assert.equal(crashes[0]!.properties.app_version, "1.40.0");
  assert.equal(crashes[0]!.uuid, firstId);
  assert.equal(crashes[0]!.timestamp, "2026-10-30T12:00:00.000Z");
  assert.equal(d.hasPending(), false);

  next.markCleanExit();
  d.forgetNetwork();
  await d.launch().start();
  assert.deepEqual(d.crashes(), []);
});

test("a crash that could not be sent waits for a launch that can, under the same event id", async (t) => {
  const d = device(t);
  const crashing = d.launch();
  await crashing.start();
  d.setSendResult("fail");
  crashing.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  await settle();
  assert.equal(d.hasPending(), true);
  const id = JSON.parse(readFileSync(d.pendingFile(), "utf8")).id as string;

  const offline = d.launch();
  await offline.start();
  await settle();
  assert.equal(d.hasPending(), true, "still offline at this launch");
  assert.deepEqual(d.crashes(), []);
  offline.handleDiagnosticEvent({ event: "process-exit" });

  d.setSendResult("ok");
  await d.launch().start();
  await settle();
  assert.deepEqual(d.crashes().map((message) => message.uuid), [id]);
  assert.equal(d.hasPending(), false);
});

test("turning usage data off deletes a pending crash, and turning it back on never sends it", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.setSendResult("hang");
  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  d.setSendResult("ok");
  assert.equal(d.hasPending(), true);

  await service.setEnabled(false);
  assert.equal(d.hasPending(), false);

  d.forgetNetwork();
  await service.setEnabled(true);
  service.markCleanExit();
  await d.launch().start();
  await settle();
  assert.deepEqual(d.crashes(), []);
});

test("a crash from before an opt-out is discarded unsent, by consent or by install id", async (t) => {
  const off = device(t);
  const first = off.launch();
  await first.start();
  off.setSendResult("hang");
  first.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  off.setSendResult("ok");
  off.forgetNetwork();

  // Settings changed behind the app: off at the next launch.
  off.setStored({ ...off.stored(), enabled: false });
  await off.launch().start();
  assert.equal(off.hasPending(), false);
  assert.deepEqual(off.network, []);

  // A delete that failed leaves a record, but a new install id disowns it.
  const stale = device(t);
  const old = stale.launch();
  await old.start();
  stale.setSendResult("hang");
  old.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  stale.setSendResult("ok");
  const { installId: _old, ...rest } = stale.stored();
  stale.setStored(rest);
  stale.forgetNetwork();

  await stale.launch().start();
  await settle();
  assert.deepEqual(stale.crashes().filter((message) => message.event === "$exception"), []);
  assert.equal(stale.hasPending(), false);
});

test("the environment switches and a keyless build delete a pending crash unsent", async (t) => {
  for (const launchOptions of [
    { env: { DO_NOT_TRACK: "1" } },
    { env: { AIDEN_ANALYTICS: "0" } },
    { createTransport: undefined },
  ] as Partial<AnalyticsServiceOptions>[]) {
    const d = device(t);
    const first = d.launch();
    await first.start();
    d.setSendResult("hang");
    first.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
    d.setSendResult("ok");
    d.forgetNetwork();

    await d.launch(launchOptions).start();

    assert.equal(d.hasPending(), false);
    assert.deepEqual(d.network, []);
  }
});

test("before the notice has been shown nothing is captured, kept or sent later", async (t) => {
  const d = device(t, { enabled: true });
  const first = d.launch();
  first.beginRun();
  await first.start();

  first.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  first.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "crashed", exitCode: 1 } });
  first.handleDiagnosticEvent({ event: "renderer-global-error" }, { rawError: { message: "x" } });
  assert.equal(d.hasPending(), false);

  // Crash out of that run, then answer the notice in the next one.
  const second = d.launch();
  await second.start();
  await second.markNoticeShown();
  await settle();

  assert.deepEqual(d.crashes(), [], "a crash from before the notice is never reported");
  assert.equal(d.network.concat(d.queued).find((message) => message.event === "app_opened")?.properties.launch_kind, "cold", "nor is it hinted at");
});

test("a fatal crash during startup is kept only under consent already saved, and activation sends it", async (t) => {
  const consenting = device(t, { ...ALLOWED, installId: "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b" });
  const early = consenting.launch();
  early.beginRun();
  early.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  assert.equal(consenting.hasPending(), true);
  await early.start();
  await settle();
  assert.equal(consenting.crashes().length, 1);
  assert.equal(consenting.hasPending(), false);

  for (const state of [
    { enabled: true },
    { enabled: false, noticeShownAt: NOTICE },
    { ...ALLOWED },
    undefined,
  ] as (AnalyticsState | undefined)[]) {
    const refused = device(t, state ?? ALLOWED);
    const service = refused.launch({ readStateSync: () => state });
    service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
    assert.equal(refused.hasPending(), false, JSON.stringify(state));
  }

  const environment = device(t, { ...ALLOWED, installId: "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b" });
  environment.launch({ env: { DO_NOT_TRACK: "1" } }).handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  assert.equal(environment.hasPending(), false);
});

test("a run that ended without a quit is reported once; an orderly stop is not a crash", async (t) => {
  const d = device(t);
  const first = d.launch();
  first.beginRun();
  await first.start();
  assert.equal(d.hasMarker(), true);
  d.forgetNetwork();

  const second = d.launch();
  second.beginRun();
  await second.start();
  const unclean = d.crashes();
  assert.deepEqual(unclean.map((message) => [message.event, message.properties.kind]), [["app_crashed", "unclean_exit"]]);
  assert.equal(d.network.some((message) => message.event === "app_crashed"), true, "flushed at once, not left in the queue");
  d.forgetNetwork();

  // A signal or an explicit exit ends the run through JavaScript.
  second.handleDiagnosticEvent({ event: "process-signal", fields: { signal: "SIGTERM" } });
  assert.equal(d.hasMarker(), false);

  const third = d.launch();
  third.beginRun();
  await third.start();
  third.handleDiagnosticEvent({ event: "process-exit", fields: { exitCode: 1 } });
  assert.equal(d.hasMarker(), false);
  await d.launch().start();
  assert.deepEqual(d.crashes(), []);
});

test("process deaths are sent as app_crashed with only categorical fields", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.forgetNetwork();

  service.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "oom", exitCode: 137 } });
  service.handleDiagnosticEvent({ event: "child-process-gone", fields: { processType: "GPU", reason: "crashed", exitCode: 11 } });
  service.handleDiagnosticEvent({ event: "browser-tab-process-gone", fields: { reason: "crashed", exitCode: 11 } });
  service.handleDiagnosticEvent({ event: "renderer-crash-loop", fields: { crashCount: 4 } });
  service.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "clean-exit", exitCode: 0 } });
  service.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "killed", exitCode: 15 } }, { duringShutdown: true });

  assert.deepEqual(d.queued.map((message) => [message.properties.kind, message.properties.reason, message.properties.exit_code]), [
    ["renderer", "oom", 137],
    ["gpu", "crashed", 11],
    ["browser_tab", "crashed", 11],
    ["renderer_loop", undefined, undefined],
  ]);
  for (const message of d.queued) assert.ok(validateOutgoingEvent(message));
});

test("hostile renderer input is sanitized in main and passes the outgoing guard with nothing left in it", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.forgetNetwork();
  const secrets = [
    "/Users/jane.doe/Documents/taxes.pdf",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "jane.doe@example.com",
    "my landlord refuses to fix the mould",
    "#/chats/1234/settings",
    "taxes.pdf",
    "chat:start",
  ];

  service.handleDiagnosticEvent({ event: "renderer-global-error" }, {
    rawError: {
      name: "jane.doe@example.com",
      message: `IPC chat:start failed for "${secrets[3]}" with ${secrets[1]} from ${secrets[0]} (${secrets[2]}) at ${secrets[4]}`,
      stack: [
        `Error: ${secrets[3]}`,
        `    at ${secrets[3]} (${APP_ROOT}/build/renderer/app.js:1:1)`,
        `    at sendTurn (file://${APP_ROOT}/build/renderer/assets/index-Ab12.js:40:7)`,
        `    at hook (${secrets[0]}:3:1)`,
        `    at notes (${APP_ROOT}/taxes.pdf:1:1)`,
      ].join("\n"),
      route: secrets[4],
      windowTitle: secrets[3],
      args: [secrets[1]],
    },
  });

  const [message] = d.queued;
  assert.ok(message);
  assert.equal(message.properties.source, "renderer");
  assert.equal(message.properties.level, "error");
  assert.equal(message.properties.process_type, "renderer");
  const checked = validateOutgoingEvent({ event: message.event, properties: message.properties });
  assert.ok(checked);
  const serialized = JSON.stringify(checked.properties);
  for (const secret of [...secrets, "jane", "mould"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.deepEqual(exceptionValues(message), ["[message withheld]"]);
  assert.equal(serialized.includes("app:///build/renderer/assets/index-Ab12.js"), true);
  for (const key of ["route", "windowTitle", "args", "title"]) {
    assert.equal(key in checked.properties, false);
  }
});

test("flood control: three of one renderer error, fatal repeats past that, twenty-five in all", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.forgetNetwork();

  for (let i = 0; i < 40; i += 1) {
    service.handleDiagnosticEvent({ event: "renderer-global-error" }, { rawError: { name: "TypeError", message: "Failed to fetch" } });
  }
  assert.equal(d.queued.length, 3);

  for (let i = 0; i < 40; i += 1) service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  await settle();
  assert.equal(d.crashes().length, 25);

  // The cap also stops the disk writes.
  rmSync(d.pendingFile(), { force: true });
  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  service.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "crashed", exitCode: 1 } });
  assert.equal(d.hasPending(), false);
  assert.equal(d.crashes().length, 25);
});

test("reporting never throws, whatever fails underneath it", async (t) => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("a getter threw");
    },
  });

  const d = device(t);
  const logged: string[] = [];
  const service = d.launch({
    log: (message) => {
      logged.push(message);
      throw new Error("the logger failed too");
    },
  });
  await service.start();
  d.setSendResult("reject");

  assert.doesNotThrow(() => service.handleDiagnosticEvent(fatalEvent, { rawError: hostile }));
  assert.doesNotThrow(() => service.handleDiagnosticEvent(fatalEvent, { rawError: undefined }));
  assert.doesNotThrow(() => service.handleDiagnosticEvent({ event: "renderer-global-error" }, { rawError: hostile }));
  await settle();

  const unwritable = device(t);
  const failing = unwritable.launch({ runDirectory: "/nonexistent/aiden/analytics" });
  await failing.start();
  assert.doesNotThrow(() => failing.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() }));

  const broken = device(t);
  const noState = broken.launch({ readStateSync: () => { throw new Error("settings unreadable"); } });
  assert.doesNotThrow(() => noState.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() }));
});

test("a crash report still on its way cannot hold up quitting past the shutdown deadline", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  d.setSendResult("hang");
  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });

  // The deadline's own timer is unref'd; Electron's loop keeps it alive in the app.
  const keepAlive = setTimeout(() => undefined, 5_000);
  t.after(() => clearTimeout(keepAlive));
  const started = performance.now();
  await service.shutdown(50);

  assert.ok(performance.now() - started < 1_000);
  assert.equal(d.hasPending(), true, "kept for the next launch");
});

test("the renderer is told when raw errors may be sent, and start() settles the answer", async (t) => {
  const d = device(t);
  const service = d.launch();
  assert.equal(await service.sendsErrorDetails(), false);
  const started = service.start();
  assert.equal(await service.sendsErrorDetails(), true);
  await started;
  assert.deepEqual(d.sending, [true]);

  await service.setEnabled(false);
  assert.equal(await service.sendsErrorDetails(), false);
  assert.deepEqual(d.sending, [true, false]);

  const pending = device(t, { enabled: true });
  const noticed = pending.launch();
  await noticed.start();
  assert.equal(await noticed.sendsErrorDetails(), false);
  await noticed.markNoticeShown();
  assert.equal(await noticed.sendsErrorDetails(), true);
});

test("a report after opt-out sends nothing, even if the renderer has not heard yet", async (t) => {
  const d = device(t);
  const service = d.launch();
  await service.start();
  await service.setEnabled(false);
  d.forgetNetwork();

  service.handleDiagnosticEvent({ event: "renderer-global-error" }, { rawError: { message: "x" } });
  service.handleDiagnosticEvent(fatalEvent, { rawError: fatalError() });
  service.handleDiagnosticEvent({ event: "renderer-process-gone", fields: { reason: "crashed", exitCode: 1 } });
  await settle();

  assert.deepEqual(d.crashes(), []);
  assert.equal(d.hasPending(), false);
});

test("a stale pending file the parser rejects is removed and sends nothing", async (t) => {
  const d = device(t);
  writeFileSync(d.pendingFile(), JSON.stringify({ version: 1, id: "x", exception: { errors: [{ value: "/Users/jane" }] } }));

  await d.launch().start();

  assert.equal(d.hasPending(), false);
  assert.deepEqual(d.crashes(), []);
});

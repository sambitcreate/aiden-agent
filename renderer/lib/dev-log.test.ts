import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { RendererDiagnosticReport } from "../shared/diagnostics";

test("a window's suppressed summary waits a full window, even after an earlier window rolled over", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent: Array<{ at: number; suppressed: number | undefined }> = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fakeWindow = Object.assign(Object.create(globalThis) as typeof globalThis, {
    addEventListener: () => undefined,
    aidenAPI: {
      ipc: {
        invoke: async (channel: string, report?: RendererDiagnosticReport) => {
          if (channel === "diagnostics:policy") {
            return { enabled: true, runtimeProfile: "development", windowMs: 1_000, maxPerKey: 1 };
          }
          if (channel === "diagnostics:renderer-event") sent.push({ at: Date.now(), suppressed: report?.suppressed });
          return { accepted: true, referenceId: "RD-test" };
        },
        onNotification: () => () => undefined,
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fakeWindow });
  try {
    const { installRendererDiagnostics, reportRendererDiagnostic } = await import("./dev-log.js");
    await installRendererDiagnostics();
    const report = () => reportRendererDiagnostic("global-error", new TypeError("boom"), "window");
    const advanceTo = (time: number) => mock.timers.tick(time - Date.now());

    report();
    advanceTo(500);
    report(); // suppressed; its summary is due at 1500
    advanceTo(1_000);
    report(); // a new window: the old summary goes now and this one is sent
    advanceTo(1_100);
    report(); // suppressed in the new window; its summary is due at 2100
    advanceTo(1_500);
    advanceTo(2_100);
    await Promise.resolve();

    assert.deepEqual(sent, [
      { at: 0, suppressed: undefined },
      { at: 1_000, suppressed: 1 },
      { at: 1_000, suppressed: undefined },
      { at: 2_100, suppressed: 1 },
    ]);
  } finally {
    mock.timers.reset();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("raw error fields leave the renderer only while main says so, and only for uncaught errors", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sent: RendererDiagnosticReport[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fakeWindow = Object.assign(Object.create(globalThis) as typeof globalThis, {
    addEventListener: () => undefined,
    aidenAPI: {
      ipc: {
        invoke: async (channel: string, report?: RendererDiagnosticReport) => {
          if (channel === "diagnostics:policy") {
            return { enabled: true, runtimeProfile: "production", windowMs: 60_000, maxPerKey: 3, errorDetails: false };
          }
          if (channel === "diagnostics:renderer-event" && report) sent.push(report);
          return { accepted: true, referenceId: "RD-test" };
        },
        onNotification: (channel: string, handler: (payload: unknown) => void) => {
          listeners.set(channel, handler);
          return () => undefined;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fakeWindow });
  try {
    // A fresh module instance, independent of the test above.
    const { installRendererDiagnostics, reportRendererDiagnostic } = (await import("./dev-log.js?details" as string)) as typeof import("./dev-log.js");
    await installRendererDiagnostics();
    const error = new RangeError("reply text");
    error.stack = "RangeError: reply text\n    at f (file:///x.js:1:1)";

    reportRendererDiagnostic("global-error", error, "window");
    assert.deepEqual(Object.keys(sent[0]!).sort(), ["context", "errorType", "kind", "referenceId"]);

    listeners.get("analytics:sending-changed")!({ sending: true });
    reportRendererDiagnostic("unhandled-rejection", error, "window");
    assert.deepEqual(sent[1]!.error, { name: "RangeError", message: "reply text", stack: "\n    at f (file:///x.js:1:1)" });

    // Caught errors are local diagnostics, never crash reports.
    reportRendererDiagnostic("react-caught", error, "subtree");
    reportRendererDiagnostic("route-error", error, "router");
    reportRendererDiagnostic("react-recoverable", error, "root");
    assert.equal(sent.slice(2).some((report) => "error" in report), false);

    reportRendererDiagnostic("react-uncaught", "thrown text", "root");
    assert.deepEqual(sent[5]!.error, { message: "thrown text" });
    reportRendererDiagnostic("react-uncaught", { apiKey: "secret" }, "router");
    assert.deepEqual(sent[6]!.error, {});

    listeners.get("analytics:sending-changed")!({ sending: false });
    reportRendererDiagnostic("global-error", error, "root");
    assert.equal("error" in sent[7]!, false);
  } finally {
    mock.timers.reset();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

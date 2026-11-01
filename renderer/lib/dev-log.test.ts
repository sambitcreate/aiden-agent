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

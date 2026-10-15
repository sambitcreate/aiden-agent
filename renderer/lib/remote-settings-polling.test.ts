import assert from "node:assert/strict";
import test from "node:test";
import type { QueryObserverOptions } from "@tanstack/react-query";

// TanStack treats a process without `window` as a server and never schedules
// refetch intervals, so the stub must exist before query-core is evaluated.
(globalThis as { window?: unknown }).window ??= {};
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { aidenRemoteSettingsQueryOptions } = await import("./queries.js");

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function setup(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const window = { focused: true, visibility: "visible" as DocumentVisibilityState };
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    get visibilityState() { return window.visibility; },
    hasFocus: () => window.focused,
  };
  const client = new QueryClient();
  client.mount();
  const cleanups: (() => void)[] = [];
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    client.clear();
    globals.document = previous;
  });
  // Each Remote snapshot read costs two Tailscale CLI runs in main.
  let snapshots = 0;
  const mount = (live: boolean) => {
    const observer = new QueryObserver(client, {
      ...aidenRemoteSettingsQueryOptions(live),
      queryFn: async () => ++snapshots,
    } as unknown as QueryObserverOptions<unknown, Error>);
    cleanups.push(observer.subscribe(() => {}));
  };
  const minutes = async (n: number) => {
    for (let s = 0; s < n * 60; s += 5) {
      t.mock.timers.tick(5_000);
      await flush();
    }
  };
  return { window, mount, minutes, snapshots: () => snapshots };
}

test("the always-mounted Remote badge reads status once a minute and not at all while the window is inactive", async (t) => {
  const s = setup(t);
  s.mount(false);
  await flush();
  assert.equal(s.snapshots(), 1);
  await s.minutes(5);
  assert.equal(s.snapshots(), 6, "one snapshot per active minute (was six)");

  s.window.focused = false;
  await s.minutes(10);
  // At most the tick that was already scheduled when the window blurred.
  assert.ok(s.snapshots() <= 7, `inactive window kept polling: ${s.snapshots()}`);
});

test("an open Remote popover or settings page keeps status live", async (t) => {
  const s = setup(t);
  s.mount(false);
  s.mount(true);
  await flush();
  const before = s.snapshots();
  await s.minutes(1);
  assert.equal(s.snapshots() - before, 6, "a ten-second cadence while a live surface is open");
});

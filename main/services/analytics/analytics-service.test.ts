import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PostHogTransport } from "./analytics-client.js";
import type { AnalyticsState } from "./analytics-consent.js";
import type { AnalyticsMessage } from "./analytics-core.js";
import { PENDING_CRASH_FILE, RUN_MARKER_FILE } from "./analytics-crash.js";
import { createAnalyticsService, type AnalyticsServiceOptions } from "./analytics-service.js";

const SUPER = { app_version: "1.40.0", platform: "darwin", arch: "arm64", os_major: 26, surface: "desktop", channel: "release" } as const;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// A transport that keeps a batch queue, like the real client: queued messages
// count as sent only once flushed, and discard drops them.
function fakeTransport() {
  const queued: AnalyticsMessage[] = [];
  const sent: AnalyticsMessage[] = [];
  const immediate: AnalyticsMessage[] = [];
  let state: "open" | "shut" | "discarded" = "open";
  const transport: PostHogTransport = {
    capture: (message) => void (state === "open" && queued.push(message)),
    captureNow: async (message) => void immediate.push(message),
    flush: async () => void sent.push(...queued.splice(0)),
    shutdown: async () => {
      sent.push(...queued.splice(0));
      state = "shut";
    },
    discard: async () => {
      queued.length = 0;
      state = "discarded";
    },
  };
  return { transport, queued, sent, immediate, state: () => state };
}

function harness(overrides: Partial<AnalyticsServiceOptions> & { initial?: AnalyticsState; keyless?: boolean } = {}) {
  const runDirectory = mkdtempSync(join(tmpdir(), "aiden-analytics-service-"));
  let stored: AnalyticsState = overrides.initial ?? { enabled: true };
  const transports: ReturnType<typeof fakeTransport>[] = [];
  let ids = 0;
  let clock = new Date(2026, 9, 30, 9, 0, 0);
  const ticks: (() => void)[] = [];
  const options: AnalyticsServiceOptions = {
    store: {
      read: async () => stored,
      update: async (mutate) => (stored = mutate(stored)),
    },
    env: {},
    createTransport: overrides.keyless
      ? undefined
      : async () => {
        const fake = fakeTransport();
        transports.push(fake);
        return fake.transport;
      },
    superProperties: { ...SUPER },
    appRoots: [],
    runDirectory,
    isBuiltinProvider: (id) => id === "anthropic",
    now: () => clock,
    randomUUID: () => uuid(++ids),
    setInterval: (callback) => {
      ticks.push(callback);
      return {};
    },
    clearInterval: () => {
      ticks.length = 0;
    },
    ...overrides,
  };
  const service = createAnalyticsService(options);
  const events = () => transports.flatMap((fake) => [...fake.queued, ...fake.sent, ...fake.immediate]);
  return {
    service,
    runDirectory,
    transports,
    events,
    names: () => events().map((message) => message.event),
    stored: () => stored,
    setClock: (date: Date) => {
      clock = date;
    },
    tick: async () => {
      for (const callback of ticks) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    cleanup: () => rmSync(runDirectory, { recursive: true, force: true }),
  };
}

test("nothing is created or sent before the person has seen the notice", async (t) => {
  const h = harness();
  t.after(h.cleanup);

  await h.service.start();

  assert.equal(h.transports.length, 0);
  assert.equal(h.stored().installId, undefined);
  assert.deepEqual(await h.service.status(), { enabled: true, envDisabled: false, hasKey: true, noticePending: true });

  await h.service.markNoticeShown();

  assert.deepEqual(h.names(), ["app_opened", "app_active"]);
  const [opened] = h.events();
  assert.equal(opened!.distinctId, h.stored().installId);
  assert.deepEqual(
    { launch_kind: opened!.properties.launch_kind, person: opened!.properties.$process_person_profile, channel: opened!.properties.channel },
    { launch_kind: "cold", person: false, channel: "release" },
  );
  assert.equal((await h.service.status()).noticePending, false);
});

test("a build without a key never creates a transport, even with the notice shown", async (t) => {
  const h = harness({ keyless: true, initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } });
  t.after(h.cleanup);

  await h.service.start();
  await h.service.onboardingFinished("completed", "anthropic");

  assert.equal(h.transports.length, 0);
  assert.equal(h.stored().installId, undefined);
  assert.deepEqual(await h.service.status(), { enabled: true, envDisabled: false, hasKey: false, noticePending: false });
});

test("DO_NOT_TRACK and AIDEN_ANALYTICS=0 override an enabled setting", async (t) => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { AIDEN_ANALYTICS: "0" }]) {
    const h = harness({ env, initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } });
    t.after(h.cleanup);

    await h.service.start();
    await h.service.setEnabled(true);

    assert.equal(h.transports.length, 0, JSON.stringify(env));
    assert.equal((await h.service.status()).envDisabled, true);
  }
});

test("a launch after an unclean exit or an update is labelled, and the update is reported once", async (t) => {
  const shown = { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } as const;

  const crashed = harness({ initial: { ...shown, lastVersion: "1.40.0" } });
  t.after(crashed.cleanup);
  writeFileSync(join(crashed.runDirectory, RUN_MARKER_FILE), "");
  await crashed.service.start();
  assert.equal(crashed.events()[0]!.properties.launch_kind, "after_crash");

  const updated = harness({ initial: { ...shown, lastVersion: "1.39.2" } });
  t.after(updated.cleanup);
  await updated.service.start();
  const byName = new Map(updated.events().map((message) => [message.event, message.properties]));
  assert.equal(byName.get("app_opened")!.launch_kind, "after_update");
  assert.deepEqual(
    [byName.get("app_updated")!.from_version, byName.get("app_updated")!.to_version],
    ["1.39.2", "1.40.0"],
  );
  assert.equal(updated.stored().lastVersion, "1.40.0");

  // The next launch of the same version, after a clean quit, is an ordinary one.
  updated.service.markCleanExit();
  const again = createAnalyticsService({
    store: { read: async () => updated.stored(), update: async (mutate) => mutate(updated.stored()) },
    env: {},
    createTransport: async () => {
      const fake = fakeTransport();
      updated.transports.push(fake);
      return fake.transport;
    },
    superProperties: { ...SUPER },
    appRoots: [],
    runDirectory: updated.runDirectory,
    isBuiltinProvider: () => false,
    setInterval: () => ({}),
    now: () => new Date(2026, 9, 30, 9, 0, 0),
    clearInterval: () => {},
  });
  await again.start();
  const relaunch = updated.transports[updated.transports.length - 1]!;
  assert.deepEqual(relaunch.queued.map((message) => [message.event, message.properties.launch_kind]), [["app_opened", "cold"]]);
});

test("an update the person quits on before answering the notice is still reported, and turning off forgets it", async (t) => {
  const upgrading = { enabled: true, lastVersion: "1.39.2" } as const;
  const first = harness({ initial: { ...upgrading } });
  t.after(first.cleanup);
  await first.service.start();
  first.service.markCleanExit();
  assert.equal(first.transports.length, 0);

  // Next launch of the same build, on the same stored state.
  const second = harness({ initial: first.stored() });
  t.after(second.cleanup);
  await second.service.start();
  await second.service.markNoticeShown();
  const byName = new Map(second.events().map((message) => [message.event, message.properties]));
  assert.equal(byName.get("app_opened")!.launch_kind, "after_update");
  assert.deepEqual(
    [byName.get("app_updated")!.from_version, byName.get("app_updated")!.to_version],
    ["1.39.2", "1.40.0"],
  );
  assert.equal(second.stored().lastVersion, "1.40.0");

  // Answering the notice with Turn off leaves no update owed to a later opt-in.
  const declined = harness({ initial: { ...upgrading } });
  t.after(declined.cleanup);
  await declined.service.start();
  await declined.service.markNoticeShown({ enabled: false });
  declined.service.markCleanExit();
  const later = harness({ initial: declined.stored() });
  t.after(later.cleanup);
  await later.service.start();
  await later.service.setEnabled(true);
  assert.deepEqual(later.names(), ["app_opened", "app_active"]);
  assert.equal(later.events()[0]!.properties.launch_kind, "cold");
});

test("app_active goes out once per local calendar day, across hourly checks and restarts", async (t) => {
  const h = harness({ initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } });
  t.after(h.cleanup);

  await h.service.start();
  await h.tick();
  h.setClock(new Date(2026, 9, 30, 23, 59));
  await h.tick();
  assert.deepEqual(h.names().filter((name) => name === "app_active").length, 1);
  assert.equal(h.stored().lastActiveDay, "2026-10-30");

  h.setClock(new Date(2026, 9, 31, 0, 1));
  await h.tick();
  assert.deepEqual(h.names().filter((name) => name === "app_active").length, 2);

  const restarted = harness({ initial: h.stored() });
  t.after(restarted.cleanup);
  restarted.setClock(new Date(2026, 9, 31, 8, 0));
  await restarted.service.start();
  assert.deepEqual(restarted.names(), ["app_opened"]);
});

test("a settings read that fails at the daily check is retried on the next check", async (t) => {
  let failReads = false;
  let stored: AnalyticsState = { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" };
  const h = harness({
    store: {
      read: async () => {
        if (failReads) throw new Error("disk busy");
        return stored;
      },
      update: async (mutate) => (stored = mutate(stored)),
    },
    log: () => {},
  });
  t.after(h.cleanup);
  await h.service.start();
  h.setClock(new Date(2026, 9, 31, 8, 0));

  failReads = true;
  await h.tick();
  assert.equal(h.names().filter((name) => name === "app_active").length, 1);

  failReads = false;
  await h.tick();
  assert.equal(h.names().filter((name) => name === "app_active").length, 2);
  assert.equal(stored.lastActiveDay, "2026-10-31");
});

test("turning off says so once, drops the queue, and forgets the install id and pending crash", async (t) => {
  const h = harness({ initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } });
  t.after(h.cleanup);
  await h.service.start();
  const firstId = h.stored().installId;
  writeFileSync(join(h.runDirectory, PENDING_CRASH_FILE), "{}");
  const [fake] = h.transports;

  const status = await h.service.setEnabled(false);

  assert.deepEqual(fake!.immediate.map((message) => [message.event, message.distinctId]), [["analytics_disabled", firstId]]);
  assert.deepEqual(fake!.sent, [], "queued events were sent instead of dropped");
  assert.equal(fake!.state(), "discarded");
  assert.deepEqual(h.stored(), { enabled: false, noticeShownAt: "2026-10-01T00:00:00.000Z", lastVersion: "1.40.0" });
  assert.equal(existsSync(join(h.runDirectory, PENDING_CRASH_FILE)), false);
  assert.equal(status.enabled, false);

  await h.tick();
  await h.service.onboardingFinished("completed", "anthropic");
  assert.equal(h.transports.length, 1, "a stopped service started sending again");

  await h.service.setEnabled(true);
  const second = h.transports[1]!;
  assert.notEqual(h.stored().installId, firstId);
  assert.deepEqual(second.queued.map((message) => message.event), ["app_active"]);
  assert.equal(second.queued[0]!.distinctId, h.stored().installId);
});

test("switching off then back on while the opt-out is still sending leaves it on", async (t) => {
  let releaseDisabled!: () => void;
  const created: ReturnType<typeof fakeTransport>[] = [];
  const h = harness({
    initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" },
    createTransport: async () => {
      const fake = fakeTransport();
      if (created.length === 0) {
        fake.transport.captureNow = (message) => new Promise((resolve) => {
          fake.immediate.push(message);
          releaseDisabled = () => resolve();
        });
      }
      created.push(fake);
      return fake.transport;
    },
  });
  t.after(h.cleanup);
  await h.service.start();

  const turningOff = h.service.setEnabled(false);
  const turningOn = h.service.setEnabled(true);
  while (!releaseDisabled) await new Promise((resolve) => setImmediate(resolve));
  releaseDisabled();
  const [off, on] = await Promise.all([turningOff, turningOn]);

  assert.equal(off.enabled, false);
  assert.equal(on.enabled, true);
  assert.equal(h.stored().enabled, true);
  assert.equal((await h.service.status()).enabled, true);
  assert.equal(created.length, 2);
  assert.equal(created[0]!.state(), "discarded");
  assert.equal(created[1]!.state(), "open");
});

test("switching off and back on while startup is still connecting leaves sending on", async (t) => {
  const created: ReturnType<typeof fakeTransport>[] = [];
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  const h = harness({
    initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" },
    createTransport: async () => {
      if (++calls === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      const fake = fakeTransport();
      created.push(fake);
      return fake.transport;
    },
  });
  t.after(h.cleanup);

  const starting = h.service.start();
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await h.service.setEnabled(false);
  const turningOn = h.service.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([starting, turningOn]);

  const live = created.filter((fake) => fake.state() === "open");
  assert.equal(live.length, 1, "exactly one transport is left sending");
  assert.ok(live[0]!.queued.some((message) => message.event === "app_opened"));
});

test("switching usage data back on in Settings while the notice waits answers it and starts sending", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await h.service.start();
  await h.service.setEnabled(false);
  assert.equal(h.transports.length, 0);

  const status = await h.service.setEnabled(true);

  assert.deepEqual(status, { enabled: true, envDisabled: false, hasKey: true, noticePending: false });
  assert.deepEqual(h.names(), ["app_opened", "app_active"]);
});

test("the notice's Turn off records the notice as seen and sends nothing", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await h.service.start();

  const status = await h.service.markNoticeShown({ enabled: false });

  assert.equal(h.transports.length, 0);
  assert.deepEqual(status, { enabled: false, envDisabled: false, hasKey: true, noticePending: false });
  assert.ok(h.stored().noticeShownAt);
});

test("finishing onboarding starts sending and reports a custom provider without its id", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await h.service.start();

  await h.service.onboardingFinished("incomplete");
  assert.equal(h.transports.length, 0);

  await h.service.onboardingFinished("completed", "my-company-gateway");
  const finished = h.events().find((message) => message.event === "onboarding_finished");
  assert.deepEqual([finished!.properties.outcome, finished!.properties.provider_id], ["completed", "custom"]);
  assert.equal(JSON.stringify(h.events()).includes("my-company-gateway"), false);
});

test("onboarding finished with the switch turned off sends nothing", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await h.service.start();

  await h.service.setEnabled(false);
  await h.service.onboardingFinished("deferred");

  assert.equal(h.transports.length, 0);
  assert.equal((await h.service.status()).noticePending, false);
});

test("a failing settings store never throws out of start, onboarding or status", async (t) => {
  const h = harness({
    store: {
      read: async () => {
        throw new Error("disk gone");
      },
      update: async () => {
        throw new Error("disk gone");
      },
    },
  });
  t.after(h.cleanup);

  await h.service.start();
  await h.service.onboardingFinished("completed", "anthropic");
  assert.equal((await h.service.status()).enabled, false);
  await assert.rejects(h.service.setEnabled(false), /could not be saved/u);
  assert.equal(h.transports.length, 0);
});

test("quitting flushes what is queued and a clean exit clears the run marker", async (t) => {
  const h = harness({ initial: { enabled: true, noticeShownAt: "2026-10-01T00:00:00.000Z" } });
  t.after(h.cleanup);
  await h.service.start();

  await h.service.shutdown();
  h.service.markCleanExit();

  assert.deepEqual(h.transports[0]!.sent.map((message) => message.event), ["app_opened", "app_active"]);
  assert.equal(existsSync(join(h.runDirectory, RUN_MARKER_FILE)), false);
});

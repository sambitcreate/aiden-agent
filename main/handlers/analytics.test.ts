import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AnalyticsState } from "../services/analytics/analytics-consent.js";
import { createAnalyticsService } from "../services/analytics/analytics-service.js";
import type { AnalyticsRegistryView } from "../../renderer/shared/analytics.js";
import { registerAnalyticsHandlers } from "./analytics.js";

function register(initial: AnalyticsState = { enabled: true }) {
  const runDirectory = mkdtempSync(join(tmpdir(), "aiden-analytics-ipc-"));
  let stored = initial;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const analytics = createAnalyticsService({
    store: { read: async () => stored, update: async (mutate) => (stored = mutate(stored)) },
    env: {},
    superProperties: { app_version: "1.40.0", platform: "darwin", arch: "arm64", os_major: 26, surface: "desktop", channel: "dev" },
    appRoots: [],
    runDirectory,
    isBuiltinProvider: () => true,
  });
  registerAnalyticsHandlers({ handle: (channel, handler) => void handlers.set(channel, handler), analytics });
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler({}, ...args);
  };
  return { invoke, stored: () => stored, cleanup: () => rmSync(runDirectory, { recursive: true, force: true }) };
}

test("the switch turns usage data off and on, and only a boolean is accepted", async (t) => {
  const { invoke, stored, cleanup } = register();
  t.after(cleanup);

  assert.deepEqual(await invoke("analytics:status"), { enabled: true, envDisabled: false, hasKey: false, noticePending: false });
  assert.equal(((await invoke("analytics:setEnabled", false)) as { enabled: boolean }).enabled, false);
  assert.equal(stored().enabled, false);
  assert.equal(((await invoke("analytics:setEnabled", true)) as { enabled: boolean }).enabled, true);
  for (const bad of ["false", 0, undefined, null]) {
    await assert.rejects(invoke("analytics:setEnabled", bad), /Invalid usage data setting/u, String(bad));
  }
  assert.equal(stored().enabled, true);
});

test("the notice's OK keeps usage data on and Turn off turns it off; both record the notice", async (t) => {
  const ok = register();
  t.after(ok.cleanup);
  assert.equal(((await ok.invoke("analytics:markNoticeShown", "ok")) as { enabled: boolean }).enabled, true);
  assert.ok(ok.stored().noticeShownAt);

  const off = register();
  t.after(off.cleanup);
  assert.equal(((await off.invoke("analytics:markNoticeShown", "turn-off")) as { enabled: boolean }).enabled, false);
  assert.deepEqual([off.stored().enabled, Boolean(off.stored().noticeShownAt)], [false, true]);

  await assert.rejects(off.invoke("analytics:markNoticeShown", "dismiss"), /Invalid usage data notice choice/u);
});

test("the What's sent list comes from the registry, with allowed values and every-event fields", async (t) => {
  const { invoke, cleanup } = register();
  t.after(cleanup);

  const registry = (await invoke("analytics:registry")) as AnalyticsRegistryView;
  const opened = registry.events.find((event) => event.name === "app_opened");
  assert.deepEqual(opened?.properties, [
    { name: "launch_kind", kind: "enum", values: ["cold", "after_update", "after_crash"], optional: false },
  ]);
  const finished = registry.events.find((event) => event.name === "onboarding_finished");
  assert.equal(finished?.properties.find((property) => property.name === "provider_id")?.optional, true);
  assert.ok(registry.superProperties.some((property) => property.name === "app_version"));
  assert.ok(registry.exceptionProperties.some((property) => property.name === "source"));
  // Nothing that could carry content is described as free text.
  const kinds = new Set([...registry.events.flatMap((event) => event.properties), ...registry.superProperties].map((p) => p.kind));
  assert.equal(kinds.has("string" as never), false);
});

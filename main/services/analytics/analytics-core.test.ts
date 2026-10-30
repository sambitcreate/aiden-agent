import assert from "node:assert/strict";
import test from "node:test";

import { createAnalyticsCore, validateOutgoingEvent, type AnalyticsMessage } from "./analytics-core.js";
import type { AnalyticsSuperProperties } from "./analytics-events.js";

const APP_ROOT = "/Applications/Aiden.app/Contents/Resources/app.asar";
const INSTALL_ID = "0b6f4a6e-3c1d-4f8e-9a2b-7c5d1e0f9a8b";
const SUPER: AnalyticsSuperProperties = {
  app_version: "1.40.0",
  platform: "darwin",
  arch: "arm64",
  os_major: 26,
  surface: "desktop",
  channel: "release",
};

function harness(overrides: { distinctId?: string | undefined; superProperties?: AnalyticsSuperProperties } = {}) {
  const sent: AnalyticsMessage[] = [];
  const internalErrors: unknown[] = [];
  const core = createAnalyticsCore({
    transport: { capture: (message) => sent.push(message) },
    getDistinctId: () => ("distinctId" in overrides ? overrides.distinctId : INSTALL_ID),
    superProperties: overrides.superProperties ?? SUPER,
    appRoots: [APP_ROOT],
    limits: { maxExceptionsPerSession: 5, maxPerFingerprint: 2 },
    onInternalError: (error) => internalErrors.push(error),
  });
  return { core, sent, internalErrors };
}

function failing(message: string, fn = "save"): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${fn} (${APP_ROOT}/dist/main/store.js:12:3)\n    at run (${APP_ROOT}/dist/main/index.js:1:1)`;
  return error;
}

test("a tracked event carries its props, the super properties and no person profile", () => {
  const { core, sent } = harness();

  assert.equal(core.track("chat_message_sent", {
    provider_id: "anthropic",
    model_id: "claude-sonnet",
    in_workspace: true,
    thinking: "medium",
    origin: "phone",
  }), true);

  assert.deepEqual(sent, [{
    distinctId: INSTALL_ID,
    event: "chat_message_sent",
    properties: {
      provider_id: "anthropic",
      model_id: "claude-sonnet",
      in_workspace: true,
      thinking: "medium",
      origin: "phone",
      ...SUPER,
      $process_person_profile: false,
    },
  }]);
});

test("nothing is sent without a distinct id", () => {
  const { core, sent } = harness({ distinctId: undefined });

  assert.equal(core.track("app_active", {}), false);
  assert.equal(core.captureException(failing("x"), { source: "main", level: "error" }), false);
  assert.deepEqual(sent, []);
});

test("an event with a bad or missing required prop is dropped, and unknown props never leave", () => {
  const { core, sent } = harness();

  // Values the type system would reject still reach track() from untyped call sites.
  const untyped = core.track as (event: string, props: Record<string, unknown>) => boolean;
  assert.equal(untyped("chat_created", { workspace_kind: "/Users/jane/project" }), false);
  assert.equal(untyped("chat_created", {}), false);
  assert.equal(untyped("not_an_event", {}), false);
  assert.equal(untyped("chat_created", { workspace_kind: "folder", path: "/Users/jane/project" }), true);

  assert.equal(sent.length, 1);
  assert.equal("path" in sent[0]!.properties, false);
});

test("an invalid optional prop is omitted rather than dropping the event", () => {
  const { core, sent } = harness();
  const untyped = core.track as (event: string, props: Record<string, unknown>) => boolean;

  assert.equal(untyped("onboarding_finished", { outcome: "completed", provider_id: "Has Spaces" }), true);
  assert.equal("provider_id" in sent[0]!.properties, false);
});

test("invalid super properties disable sending entirely", () => {
  const { core, sent } = harness({ superProperties: { ...SUPER, app_version: "/Users/jane" } });

  assert.equal(core.track("app_active", {}), false);
  assert.deepEqual(sent, []);
});

test("an exception is sent in PostHog's format with the outermost frame first", () => {
  const { core, sent } = harness();

  assert.equal(core.captureException(failing("disk full"), {
    source: "main",
    level: "fatal",
    processType: "browser",
    origin: "uncaught_exception",
    uptimeSeconds: 120,
  }), true);

  const [message] = sent;
  assert.equal(message!.event, "$exception");
  assert.equal(message!.properties.$process_person_profile, false);
  assert.equal(message!.properties.uptime_bucket, "1-10m");
  assert.equal(message!.properties.$exception_level, "fatal");
  const [entry] = message!.properties.$exception_list as {
    type: string;
    value: string;
    mechanism: { handled: boolean };
    stacktrace: { type: string; frames: { function: string; platform: string }[] };
  }[];
  assert.equal(entry!.value, "disk full");
  assert.equal(entry!.mechanism.handled, false);
  assert.equal(entry!.stacktrace.type, "raw");
  assert.deepEqual(entry!.stacktrace.frames.map((frame) => frame.function), ["run", "save"]);
  assert.equal(entry!.stacktrace.frames[0]!.platform, "node:javascript");
});

test("a replayed crash is reported against the version that crashed", () => {
  const { core, sent } = harness();

  core.captureException(failing("x"), { source: "main", level: "fatal", origin: "pending_crash", appVersion: "1.39.2" });
  core.captureException(failing("x", "load"), { source: "main", level: "fatal", appVersion: "not a version" });

  assert.deepEqual(sent.map((message) => message.properties.app_version), ["1.39.2", SUPER.app_version]);
});

test("repeats of one error are capped per session, but fatal errors are not", () => {
  const { core, sent } = harness();

  for (let i = 0; i < 4; i += 1) core.captureException(failing(`same ${i}`), { source: "renderer", level: "error" });
  assert.equal(sent.length, 2);

  core.captureException(failing("same"), { source: "main", level: "fatal" });
  assert.equal(sent.length, 3);
});

test("the session cap covers exceptions and app_crashed together, and resets", () => {
  const { core, sent } = harness();

  for (let i = 0; i < 4; i += 1) core.captureException(failing("x", `fn${i}`), { source: "main", level: "error" });
  assert.equal(core.track("app_crashed", { kind: "gpu" }), true);
  assert.equal(core.track("app_crashed", { kind: "gpu" }), false);
  assert.equal(core.captureException(failing("x", "late"), { source: "main", level: "fatal" }), false);
  assert.equal(sent.length, 5);

  core.resetSession();
  assert.equal(core.track("app_crashed", { kind: "renderer" }), true);
});

test("a failing transport never throws into the caller", () => {
  const internalErrors: unknown[] = [];
  const core = createAnalyticsCore({
    transport: { capture: () => { throw new Error("socket closed"); } },
    getDistinctId: () => INSTALL_ID,
    superProperties: SUPER,
    appRoots: [APP_ROOT],
    onInternalError: (error) => internalErrors.push(error),
  });

  assert.equal(core.track("app_active", {}), false);
  assert.equal(core.captureException(failing("x"), { source: "main", level: "error" }), false);
  assert.equal(internalErrors.length, 2);
});

test("the outgoing guard strips person, group and undeclared data", () => {
  const cleaned = validateOutgoingEvent({
    distinctId: INSTALL_ID,
    event: "terminal_opened",
    $set: { email: "jane@example.com" },
    groups: { company: "acme" },
    properties: {
      ...SUPER,
      $set: { email: "jane@example.com" },
      $set_once: { name: "Jane" },
      $groups: { company: "acme" },
      $feature_flag: "beta",
      $exception_list: [],
      $lib: "posthog-node",
      cwd: "/Users/jane",
      app_version: "/Users/jane",
      $process_person_profile: true,
    },
  });

  assert.ok(cleaned);
  assert.equal("$set" in cleaned, false);
  assert.equal("groups" in cleaned, false);
  assert.deepEqual(cleaned.properties, {
    platform: "darwin",
    arch: "arm64",
    os_major: 26,
    surface: "desktop",
    channel: "release",
    $lib: "posthog-node",
    $process_person_profile: false,
  });
});

test("the outgoing guard rejects events outside the registry", () => {
  assert.equal(validateOutgoingEvent({ event: "$identify", properties: {} }), null);
  assert.equal(validateOutgoingEvent({ event: "$pageview", properties: {} }), null);
  assert.ok(validateOutgoingEvent({ event: "$exception", properties: { source: "main", level: "error" } }));
});

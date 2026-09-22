import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAscCommands,
  parseMonitorOptions,
  runMonitor,
  summarizeReview,
  summarizeTestFlightSubmissions,
} from "./ios-asc-monitor.mjs";

const baseEnvironment = {
  AIDEN_ASC_PROFILE: "Aiden Release ASC",
  AIDEN_ASC_APP_ID: "1234567890",
  AIDEN_ASC_BUILD_ID: "9876543210",
};

test("monitor requires exact identifiers and an explicit profile", () => {
  assert.throws(
    () => parseMonitorOptions(["--mode", "processing"], {}),
    /explicit control-free --profile/u,
  );
  assert.throws(
    () => parseMonitorOptions(["--mode", "review"], { ...baseEnvironment, AIDEN_ASC_APP_ID: "Aiden" }),
    /exact numeric --app-id/u,
  );
  assert.throws(
    () => parseMonitorOptions(["--mode", "testflight"], { ...baseEnvironment, AIDEN_ASC_BUILD_ID: "" }),
    /exact --build-id/u,
  );
  assert.throws(
    () => parseMonitorOptions(["--mode", "review", "--unknown", "value"], baseEnvironment),
    /unknown option/u,
  );
});

test("processing is scoped to the exact build and every command uses strict named auth", () => {
  const options = parseMonitorOptions(["--mode", "processing"], baseEnvironment);
  const commands = buildAscCommands(options);

  assert.deepEqual(commands, [[
    "--strict-auth",
    "--profile",
    "Aiden Release ASC",
    "builds",
    "info",
    "--build-id",
    "9876543210",
    "--output",
    "json",
  ]]);
});

test("review status is read-only and version-scoped when supplied", () => {
  const options = parseMonitorOptions(
    ["--mode", "review", "--version", "1.5"],
    baseEnvironment,
  );
  const command = buildAscCommands(options)[0];

  assert.deepEqual(command.slice(0, 6), [
    "--strict-auth",
    "--profile",
    "Aiden Release ASC",
    "review",
    "status",
    "--app",
  ]);
  assert.ok(command.includes("1234567890"));
  assert.ok(command.includes("IOS"));
  assert.ok(command.includes("1.5"));
  assert.ok(!command.some((argument) => /submit|create|update|delete|publish|upload/iu.test(argument)));
});

test("TestFlight summaries omit tester identity, feedback text, screenshots, and crash content", () => {
  const payload = {
    data: [
      {
        id: "feedback-2",
        attributes: {
          createdDate: "2026-08-19T12:00:00Z",
          comment: "private tester feedback",
          email: "tester@example.com",
          screenshotUrl: "https://example.com/private.png",
          crashLog: "private crash content",
        },
        relationships: { tester: { data: { id: "tester-1" } } },
      },
      {
        id: "feedback-1",
        attributes: { createdDate: "2026-08-18T12:00:00Z" },
      },
    ],
  };

  const summary = summarizeTestFlightSubmissions(payload);
  assert.equal(summary.count, 2);
  assert.equal(summary.newestCreatedDate, "2026-08-19T12:00:00Z");
  assert.match(summary.fingerprint, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(summary), /private|tester@example|screenshot/u);
});

test("review summary retains state signals without contact or review-note fields", () => {
  const summary = summarizeReview({
    status: "WAITING_FOR_REVIEW",
    nextAction: "WAIT",
    version: "1.5",
    contactEmail: "review@example.com",
    notes: "private review notes",
  });

  assert.deepEqual(summary.fields, [
    { path: "nextAction", value: "WAIT" },
    { path: "status", value: "WAITING_FOR_REVIEW" },
    { path: "version", value: "1.5" },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /review@example|private review/u);
});

test("runner disables telemetry and emits only summarized TestFlight state", () => {
  const calls = [];
  const payloads = [
    { data: [{ id: "crash-1", attributes: { createdDate: "2026-08-19T10:00:00Z" } }] },
    { data: [{ id: "feedback-1", attributes: { createdDate: "2026-08-19T11:00:00Z" } }] },
  ];
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    return { status: 0, stdout: JSON.stringify(payloads[calls.length - 1]), stderr: "" };
  };
  const options = parseMonitorOptions(["--mode", "testflight"], baseEnvironment);
  const result = runMonitor(options, execute);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.binary === "asc"));
  assert.ok(calls.every((call) => call.options.env.ASC_TELEMETRY_DISABLED === "1"));
  assert.ok(calls.every((call) => call.args.includes("--strict-auth")));
  assert.ok(calls.every((call) => call.args.includes("Aiden Release ASC")));
  assert.deepEqual(result.crashes.count, 1);
  assert.deepEqual(result.feedback.count, 1);
});

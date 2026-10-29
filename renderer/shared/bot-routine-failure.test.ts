import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ROUTINE_FAILURE_DETAIL_CHARS,
  classifyBotRoutineFailure,
  parseBotRoutineFailure,
} from "./bot-routine-failure.js";

test("classifies provider timeouts and overloads as temporary", () => {
  for (const detail of [
    "503 Service Unavailable",
    "request timed out after 60s",
    "ECONNRESET while reading the response",
    "429 Too Many Requests",
  ]) {
    const failure = classifyBotRoutineFailure({ reason: "model_error", detail });
    assert.equal(failure.kind, "temporary", detail);
  }
});

test("classifies an expired token as sign_in", () => {
  const failure = classifyBotRoutineFailure({
    reason: "model_error",
    detail: "401 Unauthorized: token expired",
  });
  assert.equal(failure.kind, "sign_in");
  assert.equal(failure.code, "authentication");
});

test("classifies authority drift as access_changed", () => {
  const failure = classifyBotRoutineFailure({ authority: "model_changed" });
  assert.equal(failure.kind, "access_changed");
  assert.equal(failure.code, "model_changed");

  // Precedence: the authority classification wins over a provider message.
  const both = classifyBotRoutineFailure({ authority: "capability_changed", detail: "503 Service Unavailable" });
  assert.equal(both.kind, "access_changed");
  assert.equal(both.code, "capability_changed");
});

test("classifies a missing model as model_setup", () => {
  const failure = classifyBotRoutineFailure({ sessionReason: "needs_model" });
  assert.equal(failure.kind, "model_setup");
  assert.equal(failure.code, "needs_model");

  // An exhausted account cannot run the routine either.
  const quota = classifyBotRoutineFailure({ reason: "model_error", detail: "insufficient_quota: billing required" });
  assert.equal(quota.kind, "model_setup");
  assert.equal(quota.code, "quota");
});

test("bounds and redacts detail", () => {
  const secret = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA";
  const detail = `401 Unauthorized: the key ${secret} was rejected. ${"Padding sentence. ".repeat(150)}`;
  assert.ok(detail.length > 2_000);

  const failure = classifyBotRoutineFailure({ reason: "model_error", detail });

  assert.ok(failure.detail, "the failure keeps a detail");
  assert.ok([...failure.detail].length <= BOT_ROUTINE_FAILURE_DETAIL_CHARS);
  assert.equal(failure.detail.includes(secret), false);
  assert.equal(failure.detail.includes("sk-"), false);
  assert.equal(failure.detail.length, BOT_ROUTINE_FAILURE_DETAIL_CHARS);
});

test("falls back to other", () => {
  const failure = classifyBotRoutineFailure({ reason: "restart_limit" });
  assert.equal(failure.kind, "other");
  assert.equal(failure.code, "restart_limit");

  assert.deepEqual(classifyBotRoutineFailure({}), { kind: "other", code: "unknown" });
});

test("a stored failure must carry a known kind", () => {
  assert.deepEqual(parseBotRoutineFailure({ kind: "stalled", code: "watchdog" }), {
    kind: "stalled",
    code: "watchdog",
  });
  assert.equal(parseBotRoutineFailure({ kind: "exploded", code: "boom" }), undefined);
  assert.equal(parseBotRoutineFailure({ kind: "other" }), undefined);
  assert.equal(parseBotRoutineFailure("temporary"), undefined);
  assert.deepEqual(
    parseBotRoutineFailure({ kind: "tool_error", code: "claim_check", detail: "x".repeat(2_000), toolName: "read" }),
    {
      kind: "tool_error",
      code: "claim_check",
      detail: "x".repeat(BOT_ROUTINE_FAILURE_DETAIL_CHARS),
      toolName: "read",
    },
  );
});

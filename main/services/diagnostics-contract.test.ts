import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticEvent,
  createDiagnosticOperationId,
  diagnosticEventLine,
  MAX_DIAGNOSTIC_EVENT_BYTES,
  normalizeDiagnosticFields,
  projectDiagnosticError,
  sanitizeDiagnosticText,
} from "./diagnostics-contract.js";

const sessionId = "session-test";

test("diagnostic events normalize names and allowlisted scalar fields", () => {
  const event = createDiagnosticEvent(
    {
      level: "warn",
      area: "persistence",
      event: "store-write-failed",
      durationMs: 12.6,
      outcome: "failed",
      code: "storage-failed",
      fields: {
        storeClass: "settings",
        retryable: true,
        attempts: 2,
        ignored_key: "not admitted",
      },
    },
    sessionId,
    () => new Date("2026-08-27T12:00:00.000Z"),
  );

  assert.equal(event.event, "store-write-failed");
  assert.equal(event.durationMs, 13);
  assert.deepEqual(event.fields, {
    storeClass: "settings",
    retryable: true,
    attempts: 2,
  });
  assert.equal(JSON.parse(diagnosticEventLine(event)).sessionId, sessionId);
  assert.match(createDiagnosticOperationId(), /^op-[0-9a-f]{16}$/u);
  assert.equal(
    createDiagnosticEvent(
      { level: "info", area: "app", event: "electron-ready", operationId: "chat-user-owned" },
      sessionId,
    ).operationId,
    undefined,
  );
});

test("diagnostic text removes credentials URLs paths identifiers and controls", () => {
  const values = [
    "Authorization: Bearer hidden-token",
    "Basic YWxpY2U6cGFzc3dvcmQ=",
    "password=hunter2",
    '"apiKey":"plain-secret-value"',
    'password = "correct horse battery staple"',
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signaturevalue",
    "ghp_1234567890abcdefghijklmnopqrst",
    "https://user:pass@private.example/v1?token=hidden",
    "file:///Users/alice/private.ts",
    "/Users/alice/project/private.ts",
    "/workspace/project/private.ts",
    "C:\\Users\\alice\\private.ts",
    "550e8400-e29b-41d4-a716-446655440000",
    "control\u0000split",
  ].join(" ");
  const sanitized = sanitizeDiagnosticText(values, 2_048);
  assert.doesNotMatch(
    sanitized,
    /hidden-token|YWxpY2U6cGFzc3dvcmQ|hunter2|plain-secret-value|correct horse|aws-secret-value|eyJhbGci|ghp_|private\.example|alice|private\.ts|550e8400/u,
  );
  assert.equal(sanitized.includes("\u0000"), false);
  assert.match(sanitized, /REDACTED/u);
});

test("diagnostic field normalization rejects unsafe keys and non-scalars", () => {
  const fields = normalizeDiagnosticFields({
    retryable: true,
    attempts: Number.NaN,
    "unsafe-key": "dropped",
    object: { secret: true } as never,
  });
  assert.deepEqual(fields, { retryable: true, attempts: 0 });
});

test("categorical fields reject grammar-valid but unregistered strings", () => {
  assert.deepEqual(normalizeDiagnosticFields({
    origin: "PrivateSecret",
    processType: "SecretProcess",
    reason: "private-reason",
    remoteCode: "private_code",
    storeClass: "private-store",
    platform: "darwin",
    arch: "arm64",
  }), { platform: "darwin", arch: "arm64" });
});

test("Tailscale status diagnostics retain only closed failure categories", () => {
  const event = createDiagnosticEvent(
    {
      level: "warn",
      area: "remote",
      event: "tailscale-status-read-unavailable",
      outcome: "unavailable",
      fields: {
        tailscalePhase: "serve",
        failureCategory: "invalid-response",
        attempts: 3,
        commandOutput: "The Tailscale GUI failed at /Users/private/tailnet.ts.net",
      },
    },
    sessionId,
  );

  assert.deepEqual(event.fields, {
    tailscalePhase: "serve",
    failureCategory: "invalid-response",
    attempts: 3,
  });
  assert.doesNotMatch(JSON.stringify(event), /Users|tailnet\.ts\.net/u);
});

test("the closed field vocabulary keeps hostile oversized inputs below the envelope cap", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`field${index}`, "x".repeat(240)]),
  );
  const event = createDiagnosticEvent(
    { level: "error", area: "diagnostics", event: "oversize", fields },
    sessionId,
  );
  assert.ok(Buffer.byteLength(diagnosticEventLine(event)) <= MAX_DIAGNOSTIC_EVENT_BYTES + 1);
  assert.equal(event.fields, undefined);
});

test("error projection keeps categories and fingerprints without raw messages", () => {
  const error = Object.assign(new Error("Bearer hidden-token at /Users/alice/private.ts"), {
    code: "EACCES",
  });
  const projected = projectDiagnosticError(error);
  assert.deepEqual(Object.keys(projected).sort(), ["code", "errorType", "fingerprint"]);
  assert.equal(projected.code, "permission-denied");
  assert.equal(projected.errorType, "Error");
  assert.match(projected.fingerprint ?? "", /^[0-9a-f]{16}$/u);
  const sameFrames = Object.assign(new Error("different private content"), { code: "EACCES" });
  sameFrames.stack = error.stack?.replace(error.message, sameFrames.message);
  assert.equal(projectDiagnosticError(sameFrames).fingerprint, projected.fingerprint);
  const hostile = new Error("private");
  hostile.name = "CorrectHorseBatteryStaple";
  assert.equal(projectDiagnosticError(hostile).errorType, "UnknownError");
  const budget = Object.assign(new Error("private budget details"), {
    name: "SubagentTreeBudgetExhaustedError",
    code: "subagent_tree_budget_exhausted",
  });
  assert.equal(projectDiagnosticError(budget).errorType, "SubagentTreeBudgetExhaustedError");
  assert.equal(projectDiagnosticError(budget).code, "contract-rejected");
});

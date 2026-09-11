import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticEvent,
  createDiagnosticOperationId,
  diagnosticEventLine,
  MAX_DIAGNOSTIC_EVENT_BYTES,
  normalizeDiagnosticFields,
  projectDiagnosticError,
  rendererDiagnosticClassification,
  sanitizeDiagnosticText,
} from "./diagnostics-contract.js";

const sessionId = "session-test";

test("main-generated renderer references survive normalization without admitting arbitrary content", () => {
  const referenceId = "RD-e20a0162-266b-49ab-ae0a-078f74efe71c";
  assert.equal(normalizeDiagnosticFields({ referenceId })?.referenceId, referenceId);
  assert.equal(createDiagnosticEvent({ level: "error", area: "renderer", event: "renderer-global-error", fields: { referenceId } }, sessionId).fields?.referenceId, referenceId);
  for (const value of [`${referenceId}\nprivate`, `https://private/${referenceId}`, `Bearer ${referenceId}`]) {
    assert.equal(normalizeDiagnosticFields({ referenceId: value }), undefined);
  }
});

test("structural causes retain HTTP evidence and cancellation without payloads", () => {
  const secret = "private-prompt-auth-endpoint-task-content";
  const error = Object.assign(new Error(secret), { cause: { status: 429, message: secret, request: secret } });
  const projected = projectDiagnosticError(error);
  assert.equal(projected.code, "rate-limited");
  assert.equal(projected.causeCode, "rate-limited");
  assert.equal(projected.httpStatus, 429);
  assert.doesNotMatch(JSON.stringify(projected), /private-prompt/);
  assert.equal(projectDiagnosticError(new Error("HTTP 503 private text")).httpStatus, undefined);
  assert.equal(projectDiagnosticError({ status: "503" }).httpStatus, undefined);
  assert.equal(projectDiagnosticError({ statusCode: 503 }).code, "service-unavailable");
  const wrappedStatus = projectDiagnosticError({ status: 200, cause: { status: 503 } });
  assert.equal(wrappedStatus.code, "service-unavailable");
  assert.equal(wrappedStatus.httpStatus, 503);
  const outerStatus = projectDiagnosticError({ status: 429, cause: { status: 503 } });
  assert.equal(outerStatus.code, "rate-limited");
  assert.equal(outerStatus.httpStatus, 429);
  assert.equal(projectDiagnosticError({ code: "ECONNRESET", cause: { status: 503 } }).httpStatus, undefined);
  assert.equal(projectDiagnosticError({ status: 404 }).code, "not-found");
  assert.equal(projectDiagnosticError(Object.assign(new Error(secret), { cause: { code: "ABORT_ERR" } })).code, "cancelled");
  assert.equal(projectDiagnosticError(Object.assign(new Error(secret), { name: "AbortError" })).code, "cancelled");
  assert.equal(projectDiagnosticError(new TypeError(secret)).errorType, "TypeError");
  assert.equal(projectDiagnosticError(new (class extends Error {})(secret)).errorType, "Error");
  assert.equal(projectDiagnosticError(new (class extends TypeError {})(secret)).errorType, "TypeError");
});

test("renderer cancellation is counted as cancelled, not a process crash or failure", () => {
  for (const suppressed of [0, 5]) {
    assert.deepEqual(rendererDiagnosticClassification("AbortError", suppressed), {
      code: "cancelled", outcome: "cancelled",
    });
  }
  assert.deepEqual(rendererDiagnosticClassification("TypeError"), { code: "renderer-exception", outcome: "failed" });
  assert.deepEqual(rendererDiagnosticClassification("UnknownError", 5), { code: "renderer-exception", outcome: "degraded" });
});

test("unknown cyclic and accessor errors stay bounded and content-free", () => {
  for (const value of [null, undefined, "private-prompt", 0, {}, { code: "private-code" }]) {
    assert.equal(projectDiagnosticError(value).code, "unknown");
    assert.doesNotMatch(JSON.stringify(projectDiagnosticError(value)), /private/);
  }
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(projectDiagnosticError(cycle).code, "unknown");
  const getters = Object.defineProperties({}, Object.fromEntries(
    ["name", "code", "status", "statusCode", "cause", "stack"].map((key) => [key, { get() { throw new Error("private"); } }]),
  ));
  assert.equal(projectDiagnosticError(getters).code, "unknown");
  let traps = 0;
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() { traps += 1; throw new Error("private trap"); },
    getPrototypeOf() { traps += 1; throw new Error("private prototype"); },
  });
  assert.equal(projectDiagnosticError(hostile).code, "unknown");
  assert.equal(projectDiagnosticError({ cause: hostile }).code, "unknown");
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(projectDiagnosticError(revoked.proxy).code, "unknown");
  assert.equal(traps, 0);
  assert.equal(projectDiagnosticError({ code: "X".repeat(100_000) }).code, "unknown");
  assert.equal(projectDiagnosticError({ code: "private-a" }).fingerprint, projectDiagnosticError({ code: "private-b" }).fingerprint);
  function alpha() { return new Error("private-a"); }
  function beta() { return new Error("private-b"); }
  assert.equal(projectDiagnosticError(alpha()).fingerprint, projectDiagnosticError(beta()).fingerprint);
  assert.notEqual(projectDiagnosticError({ status: 429 }).fingerprint, projectDiagnosticError({ status: 503 }).fingerprint);
  assert.deepEqual(normalizeDiagnosticFields({
    httpStatus: 429, causeCode: "cancelled", failurePhase: "mcp-tool-discovery", providerCategory: "model_unavailable",
  }), { httpStatus: 429, causeCode: "cancelled", failurePhase: "mcp-tool-discovery", providerCategory: "model_unavailable" });
  for (const httpStatus of [99, 600, 429.5, Number.NaN, Infinity, "429"]) {
    assert.equal(normalizeDiagnosticFields({ httpStatus }), undefined);
  }
  assert.equal(normalizeDiagnosticFields({ causeCode: "secret", failurePhase: "secret", providerCategory: "secret" }), undefined);
});

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

test("remote request diagnostics admit bounded methods and route templates only", () => {
  const event = createDiagnosticEvent(
    {
      level: "warn",
      area: "remote",
      event: "remote-request-failed",
      outcome: "degraded",
      fields: {
        routeCategory: "chats",
        method: "POST",
        route: "/chats/:id/turns",
        statusClass: "4xx",
        latencyBucket: "2s-plus",
        remoteCode: "not_found",
      },
    },
    sessionId,
  );
  assert.equal(event.fields?.method, "POST");
  assert.equal(event.fields?.route, "/chats/:id/turns");
  assert.equal(event.fields?.routeCategory, "chats");
  assert.equal(event.fields?.remoteCode, "not_found");
  assert.deepEqual(normalizeDiagnosticFields({
    method: "GET",
    route: "/scheduled-tasks/:id/runs",
  }), { method: "GET", route: "/scheduled-tasks/:id/runs" });
  assert.deepEqual(normalizeDiagnosticFields({
    method: "DELETE",
    route: "/workspaces/:id/git/managed-worktree",
  }), { method: "DELETE", route: "/workspaces/:id/git/managed-worktree" });
});

test("remote request diagnostics reject unregistered methods and untrusted route strings", () => {
  assert.deepEqual(normalizeDiagnosticFields({
    method: "STEAL",
    route: "/chats/:id/turns",
  }), { route: "/chats/:id/turns" });
  assert.deepEqual(normalizeDiagnosticFields({
    method: "POST",
    route: "/chats/:id/turns?token=hidden",
  }), { method: "POST" });
  assert.deepEqual(normalizeDiagnosticFields({
    method: "GET",
    route: "/Users/alice/private.ts",
  }), { method: "GET" });
  assert.equal(normalizeDiagnosticFields({
    route: "chats/:id",
  }), undefined);
  assert.equal(normalizeDiagnosticFields({
    route: "/chats//:id",
  }), undefined);
  assert.equal(normalizeDiagnosticFields({
    route: `/${"x".repeat(500)}`,
  }), undefined);
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

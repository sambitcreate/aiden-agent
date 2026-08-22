import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AIDEN_REMOTE_BASE_PATH,
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_ERROR_CODES,
  AIDEN_REMOTE_EVENT_TYPES,
  AIDEN_REMOTE_MAX_SSE_FRAME_BYTES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  parseAidenRemoteStreamEvent,
  parseAidenSseFrames,
  reconcileAidenSseFrames,
  parseAidenRemoteContractFixture,
} from "./aiden-remote-protocol.js";

const protocolRoot = path.resolve(process.cwd(), "protocol/aiden-remote/v1");

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(protocolRoot, relativePath), "utf8"));
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

// Keep this authority vector byte-for-byte aligned with
// AidenRemotePhase0Tests.testEndpointAuthorityGrammarMatchesDesktopVectors.
const endpointAuthorityVectors: readonly [string, boolean][] = [
  ["aiden.example.test", true],
  ["localhost", true],
  ["aiden-lan.local", true],
  ["192.168.1.42", true],
  ["192.0.2.1:443", true],
  ["aiden.0", false],
  ["aiden.123", false],
  ["aiden.example.test:1", true],
  ["aiden.example.test:65535", true],
  ["[::]", true],
  ["[::1]", true],
  ["[2001:db8::1]:443", true],
  ["[::ffff:192.0.2.1]", true],
  ["aiden.example.test:0443", false],
  ["aiden.example.test:00001", false],
  ["aiden.example.test:0", false],
  ["aiden.example.test:65536", false],
  ["aiden.example.test:abc", false],
  ["aiden.example.test:", false],
  [":443", false],
  ["aiden.example.test:1:2", false],
  ["aiden.example.test%2eexample.test", false],
  ["aiden.example.test%25", false],
  ["aiden．example.test", false],
  ["aiden\u{0301}.example.test", false],
  ["aiden.example.test\u{0009}", false],
  ["aiden.example.test\u{001f}", false],
  ["aiden.example.test\u{007f}", false],
  ["aiden..example.test", false],
  ["-aiden.example.test", false],
  ["aiden-.example.test", false],
  ["aiden_example.test", false],
  ["123", false],
  ["192.168.001.1", false],
  ["256.1.1.1", false],
  ["[fe80::1%25en0]", false],
  ["[v1.fe]", false],
  ["[::1", false],
  ["[::1]x", false],
  ["::1", false],
  ["[::1]:00001", false],
  ["[::1]:65536", false],
  ["[2001:db8::1::2]", false],
  ["[192.0.2.1::]", false],
  ["[::ffff:192.000.2.1]", false],
  ["[2001:db8:0:0:0:0:0]", false],
];

test("shared Aiden Remote v1 fixture is complete, ordered, and contains no unsafe wire keys", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  assert.equal(fixture.protocolVersion, AIDEN_REMOTE_PROTOCOL_VERSION);
  assert.deepEqual(fixture.capabilities, AIDEN_REMOTE_CAPABILITIES);
  assert.deepEqual(
    new Set(fixture.events.map((event) => event.type)),
    new Set(AIDEN_REMOTE_EVENT_TYPES),
  );
  assert.equal(JSON.stringify(fixture).includes("/Users/"), false);
  assert.equal(JSON.stringify(fixture).includes("BEGIN PRIVATE KEY"), false);
});

test("shared manual pairing vector decrypts with the frozen cross-platform construction", async () => {
  const vector = record(await json("fixtures/manual-pairing-vector.json"), "manual vector");
  const bootstrap = record(vector.bootstrap, "manual bootstrap");
  const code = String(vector.code).replace(/-/gu, "");
  const payload = String(vector.payload);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{20}$/u);
  assert.equal(bootstrap.kind, "aiden-manual-pairing-v1");
  assert.equal(bootstrap.protocolVersion, 1);
  assert.match(String(bootstrap.sessionId), /^pairing_[A-Za-z0-9_-]{32}$/u);

  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(code, "ascii"),
    Buffer.from(String(bootstrap.salt), "base64url"),
    Buffer.from(`aiden-manual-pairing-v1\n${String(bootstrap.sessionId)}`, "utf8"),
    32,
  ));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(bootstrap.nonce), "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(
    `aiden-manual-pairing-v1\n${String(bootstrap.sessionId)}\n${String(bootstrap.expiresAt)}`,
    "utf8",
  ));
  decipher.setAuthTag(Buffer.from(String(bootstrap.tag), "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(bootstrap.ciphertext), "base64url")),
    decipher.final(),
  ]).toString("utf8");
  assert.equal(plaintext, payload);
  assert.equal(JSON.stringify(bootstrap).includes(code), false);
  const decrypted = record(JSON.parse(payload), "pairing payload");
  const pairingBootstrap = record(decrypted.bootstrap, "pairing bootstrap");
  assert.match(String(pairingBootstrap.secret), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(bootstrap).includes(String(pairingBootstrap.secret)), false);
});

test("OpenAPI freezes every planned route under authenticated Aiden v1 semantics", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  assert.equal(document.openapi, "3.1.0");
  const info = record(document.info, "OpenAPI info");
  assert.equal(info.version, "1.0.0");
  const paths = record(document.paths, "OpenAPI paths");
  const requiredPaths = [
    "/health",
    "/pairing/manual-bootstrap",
    "/pairing/exchange",
    "/server",
    "/workspaces",
    "/workspaces/{workspaceId}",
    "/workspace-browser/roots",
    "/workspace-browser/children",
    "/workspace-browser/selections",
    "/chats",
    "/chats/{chatId}",
    "/chats/{chatId}/move",
    "/chats/{chatId}/turns",
    "/chats/{chatId}/attachments",
    "/chats/{chatId}/attachments/{attachmentId}",
    "/streams/{streamId}",
    "/streams/{streamId}/events",
    "/streams/{streamId}/cancel",
    "/approvals/{approvalId}/respond",
    "/models",
    "/usage",
    "/workspaces/{workspaceId}/files",
    "/workspaces/{workspaceId}/files/{fileId}",
    "/workspaces/{workspaceId}/git/review",
    "/workspaces/{workspaceId}/git/diff",
    "/workspaces/{workspaceId}/git/branches",
    "/workspaces/{workspaceId}/git/checkout",
    "/workspaces/{workspaceId}/git/commit",
    "/workspaces/{workspaceId}/git/push-capability",
    "/workspaces/{workspaceId}/git/push",
    "/workspaces/{workspaceId}/git/compare",
    "/workspaces/{workspaceId}/git/comparison-diff",
    "/workspaces/{workspaceId}/git/worktrees",
    "/workspaces/{workspaceId}/git/managed-worktree",
    "/scheduled-tasks",
    "/scheduled-tasks/{taskId}",
    "/scheduled-tasks/{taskId}/pause",
    "/scheduled-tasks/{taskId}/resume",
    "/scheduled-tasks/{taskId}/run",
    "/scheduled-tasks/{taskId}/runs",
    "/scheduled-tasks/preview",
    "/scheduled-tasks/scripts",
    "/scheduled-tasks/mcp-servers",
    "/scheduled-tasks/settings",
  ];
  assert.deepEqual(Object.keys(paths), requiredPaths);
  assert.deepEqual(document.security, [{ deviceBearer: [], protocolVersion: [] }]);
  const securitySchemes = record(record(document.components, "components").securitySchemes, "security schemes");
  assert.deepEqual(securitySchemes.protocolVersion, {
    type: "apiKey",
    in: "header",
    name: "Aiden-Protocol-Version",
    description: "Must be exactly 1.",
  });
  const healthGet = record(record(paths["/health"], "health").get, "health get");
  assert.deepEqual(healthGet.security, []);
  const pairingPost = record(record(paths["/pairing/exchange"], "pairing").post, "pairing post");
  assert.deepEqual(pairingPost.security, []);
  const manualPairingPost = record(
    record(paths["/pairing/manual-bootstrap"], "manual pairing").post,
    "manual pairing post",
  );
  assert.deepEqual(manualPairingPost.security, []);

  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [route, pathValue] of Object.entries(paths)) {
    if (route !== "/health" && route !== "/pairing/exchange" && route !== "/pairing/manual-bootstrap") {
      const inherited = (record(pathValue, route).parameters as Array<Record<string, unknown>> | undefined) ?? [];
      assert(inherited.some((parameter) => parameter.$ref === "#/components/parameters/ProtocolVersion"), `${route} must require the exact protocol-version header`);
    }
    for (const [method, operationValue] of Object.entries(record(pathValue, route))) {
      if (!methods.has(method)) continue;
      const operationRecord = record(operationValue, `${method} ${route}`);
      if (route === "/health" || route === "/pairing/exchange" || route === "/pairing/manual-bootstrap") continue;
      assert(
        AIDEN_REMOTE_CAPABILITIES.includes(
          operationRecord["x-aiden-capability"] as (typeof AIDEN_REMOTE_CAPABILITIES)[number],
        ),
        `${method} ${route} must name a known capability`,
      );
    }
  }

  const resolveLocalReference = (reference: string): unknown => {
    assert.match(reference, /^#\//, `Only local OpenAPI references are allowed: ${reference}`);
    return reference
      .slice(2)
      .split("/")
      .map((segment) => segment.split("~1").join("/").split("~0").join("~"))
      .reduce<unknown>((current, segment) => record(current, reference)[segment], document);
  };
  const inspectReferences = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspectReferences);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref") {
        if (typeof child !== "string") throw new Error("OpenAPI $ref must be a string.");
        assert.notEqual(resolveLocalReference(child), undefined, `Unresolved OpenAPI reference ${child}`);
      } else {
        inspectReferences(child);
      }
    }
  };
  inspectReferences(document);
});

test("mutation contracts require idempotency or revision preconditions", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const paths = record(document.paths, "paths");
  const operation = (route: string, method: string) =>
    record(record(paths[route], route)[method], `${method} ${route}`);
  const parameterRefs = (route: string, method: string) =>
    ((operation(route, method).parameters as Array<Record<string, unknown>> | undefined) ?? []).map(
      (parameter) => parameter.$ref,
    );

  for (const [route, method] of [
    ["/workspaces", "post"],
    ["/chats", "post"],
    ["/chats/{chatId}/move", "post"],
    ["/chats/{chatId}/turns", "post"],
    ["/streams/{streamId}/cancel", "post"],
    ["/approvals/{approvalId}/respond", "post"],
    ["/workspaces/{workspaceId}/git/branches", "post"],
    ["/workspaces/{workspaceId}/git/checkout", "post"],
    ["/workspaces/{workspaceId}/git/commit", "post"],
    ["/workspaces/{workspaceId}/git/push", "post"],
    ["/workspaces/{workspaceId}/git/worktrees", "post"],
    ["/workspaces/{workspaceId}/git/managed-worktree", "delete"],
    ["/scheduled-tasks", "post"],
    ["/scheduled-tasks/{taskId}/pause", "post"],
    ["/scheduled-tasks/{taskId}/resume", "post"],
    ["/scheduled-tasks/{taskId}/run", "post"],
  ] as const) {
    assert(parameterRefs(route, method).includes("#/components/parameters/IdempotencyKey"));
  }

  for (const [route, method] of [
    ["/workspaces/{workspaceId}", "patch"],
    ["/workspaces/{workspaceId}", "delete"],
    ["/chats/{chatId}", "patch"],
    ["/chats/{chatId}", "delete"],
    ["/scheduled-tasks/{taskId}", "patch"],
    ["/scheduled-tasks/{taskId}", "delete"],
    ["/scheduled-tasks/settings", "patch"],
    ["/scheduled-tasks/{taskId}/pause", "post"],
    ["/scheduled-tasks/{taskId}/resume", "post"],
  ] as const) {
    assert(parameterRefs(route, method).includes("#/components/parameters/IfMatch"));
  }
});

test("wire schemas are allowlists and pairing requires pinned HTTPS identity", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const components = record(document.components, "components");
  const schemas = record(components.schemas, "schemas");
  for (const name of [
    "Server",
    "Workspace",
    "Chat",
    "MessageAttachment",
    "FileIndex",
    "FileDocument",
    "GitResult",
    "ScheduledTask",
    "ErrorEnvelope",
  ]) {
    assert.equal(record(schemas[name], name).additionalProperties, false, `${name} must be an allowlist`);
  }
  for (const name of [
    "PairingBootstrap",
    "GitDiffRequest",
    "GitCreateBranchRequest",
    "GitCheckoutRequest",
    "GitCommitRequest",
    "GitPushRequest",
    "GitCompareRequest",
    "GitComparisonDiffRequest",
    "GitCreateWorktreeRequest",
  ]) {
    assert.equal(record(schemas[name], name).additionalProperties, false, `${name} must be an allowlist`);
  }
  const attachmentUploadVariants = record(schemas.AttachmentUpload, "AttachmentUpload").oneOf;
  assert(Array.isArray(attachmentUploadVariants));
  assert.equal(attachmentUploadVariants.length, 2);
  for (const [index, variant] of attachmentUploadVariants.entries()) {
    assert.equal(record(variant, `AttachmentUpload.oneOf[${index}]`).additionalProperties, false);
  }
  const gitProjectionVariants = record(schemas.GitProjection, "GitProjection").oneOf;
  assert(Array.isArray(gitProjectionVariants));
  assert(gitProjectionVariants.length > 0);
  for (const [index, variant] of gitProjectionVariants.entries()) {
    assert.equal(record(variant, `GitProjection.oneOf[${index}]`).additionalProperties, false);
  }
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const bootstrap = fixture.pairingBootstrap;
  const pairing = record(fixture.pairingExchange, "pairing exchange fixture");
  assert.match(bootstrap.endpoint, /^https:\/\//);
  assert.match(bootstrap.serverSpkiSha256, /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.equal(bootstrap.secret.length >= 32, true);
  assert.equal(pairing.endpoint, bootstrap.endpoint);
  assert.equal(pairing.serverSpkiSha256, bootstrap.serverSpkiSha256);
  assert.equal(record(schemas.PairingBootstrap, "PairingBootstrap").additionalProperties, false);
  const pairingBootstrapEndpointPattern = record(
    record(record(schemas.PairingBootstrap, "PairingBootstrap").properties, "PairingBootstrap properties").endpoint,
    "PairingBootstrap endpoint",
  ).pattern;
  const pairingExchangeEndpointPattern = record(
    record(record(schemas.PairingExchangeResponse, "PairingExchangeResponse").properties, "PairingExchangeResponse properties").endpoint,
    "PairingExchangeResponse endpoint",
  ).pattern;
  for (const pattern of [pairingBootstrapEndpointPattern, pairingExchangeEndpointPattern]) {
    assert.equal(typeof pattern, "string");
    const endpoint = new RegExp(pattern as string);
    for (const [authority, valid] of endpointAuthorityVectors) {
      assert.equal(
        endpoint.test(`https://${authority}${AIDEN_REMOTE_BASE_PATH}`),
        valid,
        `OpenAPI endpoint pattern disagrees for ${authority}`,
      );
    }
    assert.equal(endpoint.test("https://user:secret@aiden.example.test/api/aiden/v1"), false);
  }
  assert.deepEqual(record(schemas.WorkspacePatch, "WorkspacePatch").required, ["confirmedForeground"]);
  assert.deepEqual(record(schemas.ScheduleSettingsMutation, "ScheduleSettingsMutation").required, ["confirmedForeground"]);
  const messageRoles = record(record(record(schemas.Message, "Message").properties, "Message properties").role, "Message role").enum;
  assert(Array.isArray(messageRoles));
  assert.equal(messageRoles.includes("system"), false);
  assert.equal(record(schemas.ErrorDetails, "ErrorDetails").additionalProperties, false);
  const streamEvent = record(schemas.StreamEvent, "StreamEvent");
  assert.equal(streamEvent.additionalProperties, true, "SSE envelopes must remain additively extensible");
  const streamEventVariants = streamEvent.allOf;
  assert(Array.isArray(streamEventVariants));
  const conditionalForType = (type: string) => streamEventVariants.find((variant) => {
    const condition = record(record(record(variant, "StreamEvent conditional").if, "if").properties, "if properties");
    const typeCondition = record(condition.type, "type condition");
    return typeCondition.const === type;
  });
  for (const [type, terminal] of [
    ["heartbeat", false],
    ["done", true],
    ["error", true],
    ["cancelled", true],
  ] as const) {
    const conditional = record(conditionalForType(type), `${type} conditional`);
    const thenProperties = record(record(conditional.then, `${type} then`).properties, `${type} then properties`);
    assert.equal(record(thenProperties.terminal, `${type} terminal`).const, terminal);
  }
  const unknownConditional = streamEventVariants.find((variant) => {
    const condition = record(record(record(variant, "unknown conditional").if, "if").properties, "if properties");
    const typeCondition = record(condition.type, "unknown type condition");
    return "not" in typeCondition;
  });
  const unknownThen = record(record(record(unknownConditional, "unknown conditional").then, "unknown then").properties, "unknown then properties");
  assert.equal(record(unknownThen.terminal, "unknown terminal").const, false);
  const streamStates = record(record(record(schemas.StreamStatus, "StreamStatus").properties, "StreamStatus properties").state, "StreamStatus state").enum;
  assert(Array.isArray(streamStates));
  assert(streamStates.includes("reconciling"));
  const statusConditional = record(conditionalForType("status"), "status conditional");
  const statusThenProperties = record(record(statusConditional.then, "status then").properties, "status then properties");
  const statusPayloadStates = record(record(record(statusThenProperties.payload, "status payload").properties, "status payload properties").state, "status payload state").enum;
  assert.deepEqual(statusPayloadStates, ["queued", "running", "waiting_for_approval", "reconciling"]);
  assert.deepEqual(record(schemas.ErrorCode, "ErrorCode").enum, AIDEN_REMOTE_ERROR_CODES);
  const remotePattern = record(record(record(schemas.GitPushRequest, "GitPushRequest").properties, "GitPushRequest properties").remote, "Git remote").pattern;
  assert.equal(typeof remotePattern, "string");
  const safeRemote = new RegExp(remotePattern as string);
  assert.equal(safeRemote.test("origin"), true);
  assert.equal(safeRemote.test("https://user:secret@example.test/repo.git"), false);
});

test("pairing, typed SSE payloads, and error details fail closed", async () => {
  const source = record(await json("fixtures/contract.json"), "fixture");
  const clone = () => structuredClone(source);
  const bootstrapWithExtraField = clone();
  record(bootstrapWithExtraField.pairingBootstrap, "bootstrap").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(bootstrapWithExtraField), /unsupported field/);
  const exchangeWithExtraField = clone();
  record(exchangeWithExtraField.pairingExchange, "exchange").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(exchangeWithExtraField), /unsupported field/);
  const errorEnvelopeWithExtraField = clone();
  record(errorEnvelopeWithExtraField.error, "error envelope").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(errorEnvelopeWithExtraField), /unsupported field/);
  const errorBodyWithExtraField = clone();
  record(record(errorBodyWithExtraField.error, "error envelope").error, "error").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(errorBodyWithExtraField), /unsupported field/);
  const errorDetailsWithExtraField = clone();
  record(record(errorDetailsWithExtraField.error, "error envelope").error, "error").details = { unexpected: true };
  assert.throws(() => parseAidenRemoteContractFixture(errorDetailsWithExtraField), /unsupported field/);

  const oversizedBootstrapInstance = clone();
  record(oversizedBootstrapInstance.pairingBootstrap, "bootstrap").instanceId = "i".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedBootstrapInstance), /instanceId.*128/);
  const oversizedExchangeInstance = clone();
  record(oversizedExchangeInstance.pairingExchange, "exchange").instanceId = "i".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedExchangeInstance), /instanceId.*128/);
  const oversizedDeviceId = clone();
  record(oversizedDeviceId.pairingExchange, "exchange").deviceId = "d".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedDeviceId), /deviceId.*128/);
  const oversizedUtf8Endpoint = clone();
  record(oversizedUtf8Endpoint.pairingBootstrap, "bootstrap").endpoint =
    `https://${"é".repeat(1_020)}.test/api/aiden/v1`;
  assert.throws(() => parseAidenRemoteContractFixture(oversizedUtf8Endpoint), /UTF-8 bytes/);

  const weakSecret = clone();
  record(weakSecret.pairingBootstrap, "bootstrap").secret = "predictable-secret-that-is-long-enough";
  assert.throws(() => parseAidenRemoteContractFixture(weakSecret), /32 random bytes/);
  const wrongExchange = clone();
  record(wrongExchange.pairingExchange, "exchange").endpoint = "https://other.example.test/api/aiden/v1";
  assert.throws(() => parseAidenRemoteContractFixture(wrongExchange), /does not match bootstrap/);
  const userInfoEndpoint = clone();
  record(userInfoEndpoint.pairingBootstrap, "bootstrap").endpoint = "https://user:secret@aiden-fixture.example.test/api/aiden/v1";
  assert.throws(() => parseAidenRemoteContractFixture(userInfoEndpoint), /canonical HTTPS Aiden v1 URL/);
  for (const endpoint of [
    "https://:443/api/aiden/v1",
    "https://aiden-fixture.example.test:0/api/aiden/v1",
    "https://aiden-fixture.example.test:65536/api/aiden/v1",
    "https://aiden-fixture.example.test:abc/api/aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/v1?",
    "https://aiden-fixture.example.test/api/aiden/v1#",
    "https://aiden-fixture.example.test/api/./aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/../aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/v1/../v1",
    "https://aiden-fixture.example.test/api/aiden/v1/%2e%2e/v1",
    "https://aiden-fixture.example.test/api/aiden/v1/%2E",
    "https://aiden-fixture.example.test/%61pi/aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/%76%31",
  ]) {
    const nonCanonicalPath = clone();
    record(nonCanonicalPath.pairingBootstrap, "bootstrap").endpoint = endpoint;
    assert.throws(() => parseAidenRemoteContractFixture(nonCanonicalPath), /canonical HTTPS Aiden v1 URL/);
  }
  const longLived = clone();
  record(longLived.pairingBootstrap, "bootstrap").expiresAt = "2026-08-18T19:06:00.000Z";
  assert.throws(() => parseAidenRemoteContractFixture(longLived), /five minutes/);
  const permissiveExpiry = clone();
  record(permissiveExpiry.pairingBootstrap, "bootstrap").expiresAt = "August 18, 2026 19:05:00 GMT";
  assert.throws(() => parseAidenRemoteContractFixture(permissiveExpiry), /strict RFC 3339/);
  const malformedServerTime = clone();
  record(malformedServerTime.server, "server").serverTime = "not-a-date";
  assert.throws(() => parseAidenRemoteContractFixture(malformedServerTime), /serverTime.*RFC 3339/);
  const missingServerTime = clone();
  delete record(missingServerTime.server, "server").serverTime;
  assert.throws(() => parseAidenRemoteContractFixture(missingServerTime), /serverTime.*RFC 3339/);
  const unknownCapability = clone();
  record(unknownCapability.pairingExchange, "exchange").capabilities = ["admin:everything"];
  assert.throws(() => parseAidenRemoteContractFixture(unknownCapability), /Unknown pairing capability/);
  const unsafeDetails = clone();
  record(record(unsafeDetails.error, "error envelope").error, "error").details = { absolutePath: "/private/secret" };
  assert.throws(() => parseAidenRemoteContractFixture(unsafeDetails), /unsupported field/);
  for (const requiredField of ["message", "requestId", "retryable"]) {
    const malformed = clone();
    delete record(record(malformed.error, "error envelope").error, "error")[requiredField];
    assert.throws(() => parseAidenRemoteContractFixture(malformed));
  }
  for (const [field, value] of [
    ["retryAfterSeconds", 86_401],
    ["limit", 1_000_001],
    ["minimumClientVersion", "v".repeat(41)],
    ["field", "f".repeat(121)],
  ] as const) {
    const malformed = clone();
    record(record(malformed.error, "error envelope").error, "error").details = { [field]: value };
    assert.throws(() => parseAidenRemoteContractFixture(malformed), new RegExp(`Error detail ${field} is invalid`));
  }

  const event = record((source.events as unknown[])[0], "event");
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { ...record(event.payload, "payload"), hiddenPrompt: "secret" } }), /unsupported field/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { chatId: "chat_fixture_01" } }), /missing required field/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { chatId: "chat_fixture_01", turnId: "turn_fixture_01", nextSequence: "2" } }), /must be positive/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, protocolVersion: 2 }), /unsupported protocolVersion/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, streamId: "" }), /non-empty string/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, sequence: 0 }), /positive/);
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, timestamp: "August 18, 2026 19:01:01 GMT" }),
    /strict RFC 3339/,
  );
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: { ignored: true } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "status", payload: { state: "reconciling" } }));
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "status", payload: { state: "done" } }), /status state is invalid/);
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "idempotency_capacity", message: "Retry later." } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "idempotency_in_flight", message: "Still reconciling." } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "handle_capacity", message: "Browse again later." } }));
  assert.equal(parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: {}, futureEnvelopeMetadata: true }), null);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: undefined }), /payload must be an object/);
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: { absolutePath: "/private/secret" } }),
    /Forbidden Aiden Remote wire key/,
  );
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "future_terminal", terminal: true, payload: {} }), /Unknown terminal/);
});

test("endpoint authority grammar stays exact across LAN and tailnet host forms", async () => {
  const source = record(await json("fixtures/contract.json"), "fixture");
  for (const [authority, valid] of endpointAuthorityVectors) {
    const candidate = structuredClone(source);
    const endpoint = `https://${authority}${AIDEN_REMOTE_BASE_PATH}`;
    record(candidate.pairingBootstrap, "bootstrap").endpoint = endpoint;
    if (valid) {
      record(candidate.pairingExchange, "exchange").endpoint = endpoint;
      assert.doesNotThrow(() => parseAidenRemoteContractFixture(candidate), authority);
    } else {
      assert.throws(
        () => parseAidenRemoteContractFixture(candidate),
        /canonical HTTPS Aiden v1 URL/,
        authority,
      );
    }
  }
});

test("OpenAPI and runtime stream sequence bounds stay at the JSON safe-integer maximum", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const paths = record(document.paths, "paths");
  const streamEvents = record(paths["/streams/{streamId}/events"], "stream events");
  const get = record(streamEvents.get, "stream events get");
  const parameters = get.parameters as Array<Record<string, unknown>>;
  const parameterSchema = (name: string): Record<string, unknown> => {
    const parameter = parameters.find((candidate) => candidate.name === name);
    assert(parameter, `missing stream sequence parameter ${name}`);
    return record(parameter.schema, `${name} schema`);
  };
  for (const name of ["Last-Event-ID", "after"]) {
    assert.equal(parameterSchema(name).maximum, Number.MAX_SAFE_INTEGER, `${name} maximum`);
  }

  const schemas = record(record(document.components, "components").schemas, "schemas");
  const streamStatusProperties = record(record(schemas.StreamStatus, "StreamStatus").properties, "StreamStatus properties");
  assert.equal(record(streamStatusProperties.lastSequence, "lastSequence").maximum, Number.MAX_SAFE_INTEGER);
  const streamEvent = record(schemas.StreamEvent, "StreamEvent");
  const streamEventVariants = streamEvent.allOf as Array<Record<string, unknown>>;
  const streamEventBaseProperties = record(
    streamEvent.properties,
    "StreamEvent base properties",
  );
  assert.equal(record(streamEventBaseProperties.sequence, "sequence").maximum, Number.MAX_SAFE_INTEGER);
  const snapshotConditional = streamEventVariants.find((variant) => {
    const condition = record(record(variant.if, "snapshot if").properties, "snapshot if properties");
    return record(condition.type, "snapshot type").const === "snapshot";
  });
  assert(snapshotConditional, "missing snapshot conditional");
  const snapshotPayload = record(
    record(record(snapshotConditional.then, "snapshot then").properties, "snapshot then properties").payload,
    "snapshot payload",
  );
  const snapshotProperties = record(
    snapshotPayload.properties,
    "snapshot payload properties",
  );
  assert.equal(record(snapshotProperties.nextSequence, "nextSequence").maximum, Number.MAX_SAFE_INTEGER);

  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const event = record(fixture.events[0], "event");
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({
    ...event,
    sequence: Number.MAX_SAFE_INTEGER,
  }));
  assert.throws(
    () => parseAidenRemoteStreamEvent({
      ...event,
      sequence: 9007199254740992,
    }),
    /safe integer/,
  );
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({
    ...event,
    payload: {
      chatId: "chat_fixture_01",
      turnId: "turn_fixture_01",
      nextSequence: Number.MAX_SAFE_INTEGER,
    },
  }));
  assert.throws(
    () => parseAidenRemoteStreamEvent({
      ...event,
      payload: {
        chatId: "chat_fixture_01",
        turnId: "turn_fixture_01",
        nextSequence: 9007199254740992,
      },
    }),
    /positive/,
  );
});

test("JSON entry points reject non-finite values, invalid UTF-16, and unsupported object graphs", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const event = record(fixture.events[0], "event");

  for (const value of [Infinity, Number.NaN]) {
    assert.throws(
      () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: { value } }),
      /numbers must be finite/,
    );
  }
  for (const token of ["Infinity", "NaN", "1e400"]) {
    assert.throws(
      () => parseAidenSseFrames(`id: 1\ndata: ${token}\n\n`),
      /Malformed Aiden SSE JSON data/,
    );
  }

  let deepMetadata: Record<string, unknown> = {};
  for (let index = 0; index < 129; index += 1) {
    deepMetadata = { nested: deepMetadata };
  }
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: deepMetadata }),
    /maximum nesting depth/,
  );

  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 16_385 }, (_, index) => [`key${index}`, index]),
  );
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: tooManyKeys }),
    /maximum object-key count/,
  );

  const cyclicMetadata: Record<string, unknown> = {};
  cyclicMetadata.self = cyclicMetadata;
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: cyclicMetadata }),
    /cycles are not supported/,
  );

  for (const escape of ["\\ud800", "\\udc00"]) {
    assert.throws(
      () => parseAidenSseFrames(`id: 1\ndata: {"value":"${escape}"}\n\n`),
      /Malformed Aiden SSE JSON data/,
    );
  }
  const validPair = parseAidenSseFrames('id: 1\ndata: {"value":"\\ud83d\\ude00"}\n\n');
  assert.deepEqual(validPair[0]?.data, { value: "😀" });
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"😀":1,"\\ud83d\\ude00":2}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
});

test("SSE framing resumes by id, ignores duplicates and unknown nonterminal events, and reconciles gaps", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const [first, second] = fixture.events;
  const wire = `id: ${first.sequence}\ndata: ${JSON.stringify(first)}\n\nid: ${second.sequence}\ndata: ${JSON.stringify(second)}\n\n`;
  const frames = parseAidenSseFrames(wire);
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"a":1,"a":2}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"outer":{"a":1,"\\u0061":2}}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
  assert.throws(
    () => parseAidenSseFrames(`id: 1\ndata: ${"x".repeat(AIDEN_REMOTE_MAX_SSE_FRAME_BYTES)}\n\n`),
    /exceeds the byte limit/,
  );
  assert.deepEqual(reconcileAidenSseFrames(frames, 0, first.streamId), { events: [first, second], reconcileRequired: false });
  assert.deepEqual(reconcileAidenSseFrames(frames, 1, first.streamId), { events: [second], reconcileRequired: false });
  assert.equal(reconcileAidenSseFrames([{ ...frames[1], id: "3" }], 1, first.streamId).reconcileRequired, true);
  assert.equal(reconcileAidenSseFrames([{ ...frames[1], data: { ...record(frames[1].data, "data"), sequence: 3 } }], 1, first.streamId).reconcileRequired, true);
  const future = { ...record(frames[0].data, "data"), type: "future_progress", terminal: false, payload: {} };
  assert.deepEqual(reconcileAidenSseFrames([{ id: "1", data: future }], 0, first.streamId), { events: [], reconcileRequired: false });
  const futureBetween = { ...future, sequence: 2 };
  const third = { ...second, sequence: 3 };
  assert.deepEqual(reconcileAidenSseFrames([{ id: "1", data: first }, { id: "2", data: futureBetween }, { id: "3", data: third }], 0, first.streamId), { events: [first, third], reconcileRequired: false });
  const terminal = { ...first, sequence: 1, type: "done", terminal: true, payload: { messageId: "message-terminal" } };
  const afterTerminal = { ...second, sequence: 2, type: "heartbeat", terminal: false, payload: {} };
  const terminalResult = reconcileAidenSseFrames([{ id: "1", data: terminal }, { id: "2", data: afterTerminal }], 0, first.streamId);
  assert.equal(terminalResult.reconcileRequired, true);
  assert.deepEqual(terminalResult.events.map((event) => event.type), ["done"]);
  assert.equal(
    reconcileAidenSseFrames([{ id: "1", data: { ...first, streamId: "stream_other" } }], 0, first.streamId).reconcileRequired,
    true,
  );
  assert.equal(
    reconcileAidenSseFrames([{ id: "1", data: { ...future, streamId: "stream_other" } }], 0, first.streamId).reconcileRequired,
    true,
  );
});

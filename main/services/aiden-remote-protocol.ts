import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";

export const AIDEN_REMOTE_PROTOCOL_VERSION = 1 as const;
export const AIDEN_REMOTE_BASE_PATH = "/api/aiden/v1" as const;
export const AIDEN_REMOTE_MAX_SSE_FRAME_BYTES = 1_048_576;

const AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH = 128;
const AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES = 2_048;
const AIDEN_REMOTE_MAX_ENDPOINT_PORT = 65_535;
const AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH = 128;
const AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS = 16_384;

export const AIDEN_REMOTE_CAPABILITIES = [
  "server:read",
  "chat:read",
  "chat:write",
  "approval:respond",
  "workspace:read",
  "workspace:browse",
  "workspace:manage",
  "files:read",
  "files:write",
  "git:read",
  "git:write",
  "schedule:read",
  "schedule:write",
] as const;

export type AidenRemoteCapability = (typeof AIDEN_REMOTE_CAPABILITIES)[number];

export const AIDEN_REMOTE_EVENT_TYPES = [
  "snapshot",
  "status",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "timeline",
  "approval_required",
  "done",
  "error",
  "cancelled",
  "heartbeat",
] as const;

export type AidenRemoteEventType = (typeof AIDEN_REMOTE_EVENT_TYPES)[number];
export type AidenRemoteTerminalEventType = "done" | "error" | "cancelled";

export const AIDEN_REMOTE_ERROR_CODES = [
  "invalid_request",
  "payload_too_large",
  "rate_limited",
  "authentication_required",
  "credential_revoked",
  "capability_denied",
  "pairing_closed",
  "pairing_expired",
  "pairing_already_used",
  "server_identity_changed",
  "not_found",
  "already_exists",
  "revision_conflict",
  "idempotency_conflict",
  "idempotency_capacity",
  "idempotency_in_flight",
  "workspace_unavailable",
  "workspace_changing",
  "permission_confirmation_required",
  "handle_invalid",
  "handle_expired",
  "handle_wrong_device",
  "root_policy_changed",
  "filesystem_identity_changed",
  "path_outside_root",
  "handle_capacity",
  "turn_already_active",
  "stream_gone",
  "approval_already_resolved",
  "approval_expired",
  "operation_in_progress",
  "operation_stale",
  "git_capability_denied",
  "schedule_disabled",
  "schedule_run_in_progress",
  "server_interrupted",
  "internal_error",
] as const;

export type AidenRemoteErrorCode = (typeof AIDEN_REMOTE_ERROR_CODES)[number];

export interface AidenRemoteErrorEnvelope {
  error: {
    code: AidenRemoteErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: {
      currentRevision?: string;
      retryAfterSeconds?: number;
      chatId?: string;
      minimumClientVersion?: string;
      limit?: number;
      field?: string;
    };
  };
}

export interface AidenRemoteStreamEvent {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  streamId: string;
  sequence: number;
  timestamp: string;
  type: AidenRemoteEventType;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface AidenRemoteContractFixture {
  contractRevision: number;
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  capabilities: AidenRemoteCapability[];
  health: { ok: true; protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION };
  pairingBootstrap: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    endpoint: string;
    serverSpkiSha256: string;
    secret: string;
    expiresAt: string;
  };
  pairingExchange: {
    protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
    instanceId: string;
    deviceId: string;
    credential: string;
    capabilities: AidenRemoteCapability[];
    displayName: string;
    endpoint: string;
    serverSpkiSha256: string;
  };
  events: AidenRemoteStreamEvent[];
  error: AidenRemoteErrorEnvelope;
  [key: string]: unknown;
}

export const AIDEN_REMOTE_FORBIDDEN_WIRE_KEYS = new Set([
  "authorization",
  "credentialDigest",
  "providerFingerprint",
  "mcpServerBindings",
  "folderPath",
  "repositoryPath",
  "worktreePath",
  "worktreeGitDir",
  "ownershipToken",
  "worktreeDevice",
  "worktreeInode",
  "createdFromHead",
  "canonicalPath",
  "absolutePath",
  "scriptPath",
  "environment",
  "stdout",
  "stderr",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        Number.isNaN(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertAidenRemoteJsonValue(value: unknown, location: string): void {
  let objectKeyCount = 0;
  const activeObjects = new WeakSet<object>();

  function fail(message: string): never {
    throw new Error(`Invalid Aiden Remote JSON value at ${location}: ${message}`);
  }

  function visit(current: unknown, depth: number, currentLocation: string): void {
    if (depth > AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH) {
      fail(`maximum nesting depth is ${AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH}.`);
    }
    if (current === null) return;
    if (typeof current === "string") {
      if (!isValidJsonString(current)) fail("strings must not contain unpaired UTF-16 surrogates.");
      return;
    }
    if (typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("numbers must be finite.");
      return;
    }
    if (typeof current !== "object") {
      fail("value must be a JSON-compatible primitive, array, or plain object.");
    }

    if (activeObjects.has(current)) fail("cycles are not supported.");
    activeObjects.add(current);

    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        const arrayIndexes = new Set<number>();
        for (const ownKey of ownKeys) {
          if (ownKey === "length") {
            const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
            if (
              !descriptor ||
              descriptor.enumerable ||
              !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
              descriptor.value !== current.length
            ) {
              fail("arrays must have the standard length property.");
            }
            continue;
          }
          if (typeof ownKey !== "string") fail("symbol array properties are not supported.");
          const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
          const index = Number(ownKey);
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== ownKey ||
            arrayIndexes.has(index)
          ) {
            fail("arrays must contain only dense numeric JSON elements.");
          }
          arrayIndexes.add(index);
        }
        if (arrayIndexes.size !== current.length) {
          fail("arrays must contain only dense numeric JSON elements.");
        }
        for (let index = 0; index < current.length; index += 1) {
          visit(current[index], depth + 1, `${currentLocation}[${index}]`);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("objects must use the plain JSON object prototype.");
      }
      const ownKeys = Reflect.ownKeys(current);
      const objectEntries: Array<[string, unknown]> = [];
      for (const ownKey of ownKeys) {
        if (typeof ownKey !== "string") fail("symbol object properties are not supported.");
        const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          fail(`object property ${ownKey} must be an enumerable data property.`);
        }
        if (!isValidJsonString(ownKey)) fail("object keys must not contain unpaired UTF-16 surrogates.");
        if (AIDEN_REMOTE_FORBIDDEN_WIRE_KEYS.has(ownKey)) {
          throw new Error(`Forbidden Aiden Remote wire key ${ownKey} at ${currentLocation}.`);
        }
        objectKeyCount += 1;
        if (objectKeyCount > AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS) {
          fail(`maximum object-key count is ${AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS}.`);
        }
        objectEntries.push([ownKey, descriptor.value]);
      }
      for (const [key, child] of objectEntries) {
        visit(child, depth + 1, `${currentLocation}.${key}`);
      }
    } finally {
      activeObjects.delete(current);
    }
  }

  visit(value, 0, location);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Aiden Remote fixture field ${key} must be a non-empty string.`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Aiden Remote fixture field ${key} must be a safe integer.`);
  }
  return value as number;
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

export function assertNoForbiddenWireKeys(value: unknown, location = "fixture"): void {
  assertAidenRemoteJsonValue(value, location);
}

const EVENT_PAYLOAD_KEYS: Record<AidenRemoteEventType, readonly string[]> = {
  snapshot: ["chatId", "turnId", "nextSequence"],
  status: ["state"],
  text_delta: ["text"],
  reasoning_delta: ["text"],
  tool_started: ["toolId", "name"],
  tool_finished: ["toolId", "status"],
  timeline: ["timeline"],
  approval_required: ["approvalId", "summary", "expiresAt"],
  done: ["messageId"],
  error: ["code", "message"],
  cancelled: ["source"],
  heartbeat: [],
};

const TERMINAL_EVENT_TYPES = new Set<AidenRemoteEventType>(["done", "error", "cancelled"]);

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
}

function assertBoundedString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requiredString(record, key);
  if (characterLength(value) > maxLength) throw new Error(`Aiden Remote field ${key} exceeds ${maxLength} characters.`);
  return value;
}

function parseStrictRfc3339(value: string, label: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) throw new Error(`${label} must be a strict RFC 3339 date-time.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offset = match[8]!;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !Number.isInteger(daysInMonth) ||
    day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error(`${label} must be a valid strict RFC 3339 date-time.`);
  }

  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) {
    throw new Error(`${label} must have a valid RFC 3339 UTC offset.`);
  }
  const milliseconds = Number(fraction.slice(1).padEnd(3, "0").slice(0, 3) || "0");
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, milliseconds));
  date.setUTCFullYear(year);
  const signedOffsetMinutes = offset === "Z" ? 0 : (offset[0] === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutes);
  return date.getTime() - signedOffsetMinutes * 60_000;
}

function validateEventPayload(type: AidenRemoteEventType, payload: Record<string, unknown>): void {
  const keys = EVENT_PAYLOAD_KEYS[type];
  assertExactKeys(payload, keys, `${type} payload`);
  for (const key of keys) {
    if (!(key in payload)) throw new Error(`${type} payload is missing required field ${key}.`);
  }
  if (type === "snapshot") {
    assertBoundedString(payload, "chatId", 128);
    assertBoundedString(payload, "turnId", 128);
    if (!Number.isSafeInteger(payload.nextSequence) || (payload.nextSequence as number) < 1) throw new Error("snapshot nextSequence must be positive.");
  } else if (type === "status") {
    const state = requiredString(payload, "state");
    if (!["queued", "running", "waiting_for_approval", "reconciling"].includes(state)) throw new Error("status state is invalid.");
  } else if (type === "text_delta" || type === "reasoning_delta") {
    assertBoundedString(payload, "text", 200_000);
  } else if (type === "tool_started") {
    assertBoundedString(payload, "toolId", 128);
    assertBoundedString(payload, "name", 120);
  } else if (type === "tool_finished") {
    assertBoundedString(payload, "toolId", 128);
    if (!["succeeded", "failed", "cancelled"].includes(requiredString(payload, "status"))) throw new Error("tool status is invalid.");
  } else if (type === "timeline") {
    if (!parseGenerationTimeline(payload.timeline)) {
      throw new Error("timeline payload must contain a renderer-safe generation timeline.");
    }
  } else if (type === "approval_required") {
    assertBoundedString(payload, "approvalId", 128);
    assertBoundedString(payload, "summary", 2_000);
    parseStrictRfc3339(requiredString(payload, "expiresAt"), "Approval expiry");
  } else if (type === "done") {
    assertBoundedString(payload, "messageId", 128);
  } else if (type === "error") {
    const code = assertBoundedString(payload, "code", 80);
    if (!(AIDEN_REMOTE_ERROR_CODES as readonly string[]).includes(code)) throw new Error("stream error code is invalid.");
    assertBoundedString(payload, "message", 2_000);
  } else if (type === "cancelled") {
    if (!["device", "server"].includes(requiredString(payload, "source"))) throw new Error("cancellation source is invalid.");
  }
}

function assertBase64Url32(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw new Error(`${label} must encode exactly 32 random bytes as unpadded base64url.`);
  }
}

function isCanonicalAidenIPv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function parseAidenIPv6Side(value: string): number | null {
  if (!value) return 0;
  const groups = value.split(":");
  if (groups.some((group) => group.length === 0)) return null;
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (group.includes(".")) {
      if (index !== groups.length - 1 || !isCanonicalAidenIPv4(group)) return null;
      count += 2;
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/u.test(group)) return null;
      count += 1;
    }
  }
  return count;
}

function isCanonicalAidenIPv6(value: string): boolean {
  if (!value || !/^[0-9A-Fa-f:.]+$/u.test(value)) return false;
  const sides = value.split("::");
  if (sides.length > 2) return false;
  if (sides.length === 2) {
    if (sides[0]!.includes(".")) return false;
    const left = parseAidenIPv6Side(sides[0]!);
    const right = parseAidenIPv6Side(sides[1]!);
    return left !== null && right !== null && left + right < 8;
  }
  return parseAidenIPv6Side(value) === 8;
}

function isCanonicalAidenDnsHost(value: string): boolean {
  if (!value || value.length > 253) return false;
  const labels = value.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (labels.every((label) => /^[0-9]+$/u.test(label))) {
    // Numeric-only authorities are ambiguous under WHATWG URL parsing. Keep
    // only canonical dotted-decimal IPv4 rather than letting `123` become
    // `0.0.0.123` on one platform and a DNS name on another.
    return isCanonicalAidenIPv4(value);
  }
  // A DNS authority must not end in a numeric-only label. This keeps
  // `aiden.123` distinct from canonical IPv4 while retaining numeric labels
  // in non-terminal positions.
  if (/^[0-9]+$/u.test(labels[labels.length - 1]!)) return false;
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function isCanonicalAidenPort(value: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= AIDEN_REMOTE_MAX_ENDPOINT_PORT;
}

function isCanonicalAidenAuthority(value: string): boolean {
  // Keep the raw grammar ASCII-only. This rejects C0/DEL, all Unicode
  // whitespace and normalization-sensitive host spellings before either URL
  // implementation can decode or normalize them.
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7f || codePoint <= 0x20 || codePoint === 0x7f) return false;
  }

  let host: string;
  let rawPort: string | undefined;
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket <= 1 || value.indexOf("[", 1) >= 0 || value.indexOf("]", closingBracket + 1) >= 0) return false;
    host = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (suffix) {
      if (!suffix.startsWith(":")) return false;
      rawPort = suffix.slice(1);
    }
    if (!isCanonicalAidenIPv6(host)) return false;
  } else {
    if (value.includes("[") || value.includes("]")) return false;
    const firstColon = value.indexOf(":");
    if (firstColon >= 0) {
      if (firstColon !== value.lastIndexOf(":")) return false;
      host = value.slice(0, firstColon);
      rawPort = value.slice(firstColon + 1);
    } else {
      host = value;
    }
    if (!isCanonicalAidenDnsHost(host)) return false;
  }

  return rawPort === undefined || isCanonicalAidenPort(rawPort);
}

function hasCanonicalRawEndpointSyntax(value: string): boolean {
  // WHATWG URL parsing removes raw and percent-encoded dot segments and
  // normalizes empty trailing query/fragment markers. Match the complete wire
  // syntax first so only one exact HTTPS endpoint spelling reaches URL parsing.
  const match = /^https:\/\/([^/?#]+)\/api\/aiden\/v1$/u.exec(value);
  if (!match) return false;

  const authority = match[1]!;
  return isCanonicalAidenAuthority(authority);
}

export function assertAidenRemoteEndpoint(value: string): void {
  if (Buffer.byteLength(value, "utf8") > AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES) {
    throw new Error(`Pairing endpoint exceeds ${AIDEN_REMOTE_MAX_ENDPOINT_UTF8_BYTES} UTF-8 bytes.`);
  }
  if (!hasCanonicalRawEndpointSyntax(value)) {
    throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash || endpoint.pathname !== AIDEN_REMOTE_BASE_PATH
  ) throw new Error("Pairing endpoint must be the canonical HTTPS Aiden v1 URL.");
}

export function parseAidenRemoteStreamEvent(value: unknown): AidenRemoteStreamEvent | null {
  if (!isRecord(value)) throw new Error("Aiden Remote event must be an object.");
  if ("payload" in value && !isRecord(value.payload)) {
    throw new Error("Aiden Remote event payload must be an object.");
  }
  if (value.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Aiden Remote event has an unsupported protocolVersion.");
  }
  const streamId = assertBoundedString(value, "streamId", 128);
  const sequence = requiredInteger(value, "sequence");
  if (sequence < 1) throw new Error("Aiden Remote event sequence must be positive.");
  const timestamp = requiredString(value, "timestamp");
  parseStrictRfc3339(timestamp, "Aiden Remote event timestamp");
  const type = assertBoundedString(value, "type", 80);
  if (typeof value.terminal !== "boolean") throw new Error("Aiden Remote event terminal must be boolean.");
  if (!isRecord(value.payload)) throw new Error("Aiden Remote event payload must be an object.");
  if (Object.keys(value.payload).length > 32) throw new Error("Aiden Remote event payload has too many properties.");
  if (!(AIDEN_REMOTE_EVENT_TYPES as readonly string[]).includes(type)) {
    if (value.terminal) throw new Error(`Unknown terminal Aiden Remote event type ${type}.`);
    assertNoForbiddenWireKeys(value, "event");
    return null;
  }
  const knownType = type as AidenRemoteEventType;
  if (value.terminal !== TERMINAL_EVENT_TYPES.has(knownType)) {
    throw new Error(`Aiden Remote event ${type} has an invalid terminal classification.`);
  }
  validateEventPayload(knownType, value.payload);
  assertNoForbiddenWireKeys(value, "event");
  return {
    protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
    streamId,
    sequence,
    timestamp,
    type: knownType,
    terminal: value.terminal,
    payload: value.payload,
  };
}

export function assertOrderedAidenRemoteEvents(events: readonly AidenRemoteStreamEvent[]): void {
  const lastByStream = new Map<string, number>();
  const terminalStreams = new Set<string>();
  for (const event of events) {
    if (terminalStreams.has(event.streamId)) {
      throw new Error(`Aiden Remote stream ${event.streamId} contains an event after terminal state.`);
    }
    const previous = lastByStream.get(event.streamId) ?? 0;
    if (event.sequence !== previous + 1) {
      throw new Error(
        `Aiden Remote stream ${event.streamId} expected sequence ${previous + 1}, received ${event.sequence}.`,
      );
    }
    lastByStream.set(event.streamId, event.sequence);
    if (event.terminal) {
      terminalStreams.add(event.streamId);
    }
  }
}

export function parseAidenRemoteContractFixture(value: unknown): AidenRemoteContractFixture {
  if (!isRecord(value)) throw new Error("Aiden Remote contract fixture must be an object.");
  if (value.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Aiden Remote contract fixture protocolVersion must be 1.");
  }
  const contractRevision = requiredInteger(value, "contractRevision");
  if (contractRevision < 1) throw new Error("Aiden Remote contractRevision must be positive.");
  if (!Array.isArray(value.capabilities)) throw new Error("Fixture capabilities must be an array.");
  const capabilities = value.capabilities.map((entry) => {
    if (
      typeof entry !== "string" ||
      !(AIDEN_REMOTE_CAPABILITIES as readonly string[]).includes(entry)
    ) {
      throw new Error(`Unknown Aiden Remote capability ${String(entry)}.`);
    }
    return entry as AidenRemoteCapability;
  });
  if (!isRecord(value.health) || value.health.ok !== true || value.health.protocolVersion !== 1) {
    throw new Error("Fixture health response is invalid.");
  }
  assertExactKeys(value.health, ["ok", "protocolVersion"], "Fixture health response");
  if (!isRecord(value.pairingBootstrap)) {
    throw new Error("Fixture pairing bootstrap is invalid.");
  }
  const pairingBootstrap = value.pairingBootstrap;
  assertExactKeys(
    pairingBootstrap,
    ["protocolVersion", "instanceId", "endpoint", "serverSpkiSha256", "secret", "expiresAt"],
    "Fixture pairing bootstrap",
  );
  if (pairingBootstrap.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION) {
    throw new Error("Fixture pairing bootstrap protocolVersion must be 1.");
  }
  const instanceId = assertBoundedString(pairingBootstrap, "instanceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH);
  const endpoint = requiredString(pairingBootstrap, "endpoint");
  const fingerprint = requiredString(pairingBootstrap, "serverSpkiSha256");
  const secret = requiredString(pairingBootstrap, "secret");
  assertAidenRemoteEndpoint(endpoint);
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(fingerprint)) {
    throw new Error("Pairing bootstrap fingerprint must be a SHA-256 SPKI digest.");
  }
  assertBase64Url32(secret, "Pairing bootstrap secret");
  const expiresAt = requiredString(pairingBootstrap, "expiresAt");
  const expiryTime = parseStrictRfc3339(expiresAt, "Pairing bootstrap expiry");
  if (!isRecord(value.server) || typeof value.server.serverTime !== "string") {
    throw new Error("Fixture serverTime must be a strict RFC 3339 date-time.");
  }
  const serverTime = parseStrictRfc3339(value.server.serverTime, "Fixture serverTime");
  if (expiryTime <= serverTime) throw new Error("Pairing bootstrap must not be expired.");
  if (expiryTime - serverTime > 5 * 60_000) throw new Error("Pairing bootstrap TTL must not exceed five minutes.");
  if (!isRecord(value.pairingExchange)) throw new Error("Fixture pairing exchange is invalid.");
  const pairingExchange = value.pairingExchange;
  assertExactKeys(
    pairingExchange,
    ["protocolVersion", "instanceId", "deviceId", "credential", "capabilities", "displayName", "endpoint", "serverSpkiSha256"],
    "Fixture pairing exchange",
  );
  if (pairingExchange.protocolVersion !== 1) throw new Error("Pairing exchange protocolVersion must be 1.");
  if (assertBoundedString(pairingExchange, "instanceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH) !== instanceId) throw new Error("Pairing exchange instance does not match bootstrap.");
  assertBoundedString(pairingExchange, "deviceId", AIDEN_REMOTE_MAX_IDENTIFIER_LENGTH);
  assertBase64Url32(requiredString(pairingExchange, "credential"), "Pairing device credential");
  if (!Array.isArray(pairingExchange.capabilities)) throw new Error("Pairing exchange capabilities must be an array.");
  const exchangeCapabilities = pairingExchange.capabilities.map((entry) => {
    if (typeof entry !== "string" || !(AIDEN_REMOTE_CAPABILITIES as readonly string[]).includes(entry)) throw new Error(`Unknown pairing capability ${String(entry)}.`);
    return entry as AidenRemoteCapability;
  });
  if (new Set(exchangeCapabilities).size !== exchangeCapabilities.length) throw new Error("Pairing exchange capabilities must be unique.");
  assertBoundedString(pairingExchange, "displayName", 80);
  if (requiredString(pairingExchange, "endpoint") !== endpoint || requiredString(pairingExchange, "serverSpkiSha256") !== fingerprint) throw new Error("Pairing exchange identity does not match bootstrap.");
  if (!Array.isArray(value.events)) throw new Error("Fixture events must be an array.");
  const events = value.events.map(parseAidenRemoteStreamEvent).filter((event): event is AidenRemoteStreamEvent => event !== null);
  assertOrderedAidenRemoteEvents(events);
  if (!isRecord(value.error) || !isRecord(value.error.error)) {
    throw new Error("Fixture error envelope is invalid.");
  }
  assertExactKeys(value.error, ["error"], "Error envelope");
  const errorBody = value.error.error;
  assertExactKeys(errorBody, ["code", "message", "requestId", "retryable", "details"], "Error envelope error");
  const code = requiredString(errorBody, "code");
  if (!(AIDEN_REMOTE_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`Unknown Aiden Remote error code ${code}.`);
  }
  if (characterLength(requiredString(errorBody, "message")) > 2_000) throw new Error("Error message is too long.");
  if (characterLength(requiredString(errorBody, "requestId")) > 128) throw new Error("Error requestId is too long.");
  if (typeof errorBody.retryable !== "boolean") throw new Error("Error retryable must be boolean.");
  if (errorBody.details !== undefined) {
    if (!isRecord(errorBody.details)) throw new Error("Error details must be an object.");
    assertExactKeys(errorBody.details, ["currentRevision", "retryAfterSeconds", "chatId", "minimumClientVersion", "limit", "field"], "Error details");
    const stringDetailMaxima = {
      currentRevision: 128,
      chatId: 128,
      minimumClientVersion: 40,
      field: 120,
    } as const;
    for (const [key, maximum] of Object.entries(stringDetailMaxima)) {
      const detail = errorBody.details[key];
      if (detail !== undefined && (typeof detail !== "string" || detail.length === 0 || characterLength(detail) > maximum)) throw new Error(`Error detail ${key} is invalid.`);
    }
    const boundedNumericDetails = {
      retryAfterSeconds: 86_400,
      limit: 1_000_000,
    } as const;
    for (const [key, maximum] of Object.entries(boundedNumericDetails)) {
      const detail = errorBody.details[key];
      if (detail !== undefined && (!Number.isSafeInteger(detail) || (detail as number) < 0 || (detail as number) > maximum)) throw new Error(`Error detail ${key} is invalid.`);
    }
  }
  assertNoForbiddenWireKeys(value);
  return {
    ...value,
    contractRevision,
    protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
    capabilities,
    health: { ok: true, protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION },
    pairingBootstrap: pairingBootstrap as unknown as AidenRemoteContractFixture["pairingBootstrap"],
    pairingExchange: { ...(pairingExchange as unknown as AidenRemoteContractFixture["pairingExchange"]), capabilities: exchangeCapabilities },
    events,
    error: value.error as unknown as AidenRemoteErrorEnvelope,
  };
}

export interface AidenSseFrame { id: string; data: unknown }

/**
 * JSON.parse keeps only the last occurrence of a duplicate object key. Scan
 * the raw JSON first so that no duplicate can hide an SSE envelope field.
 * Keys are decoded while scanning, which also catches escaped-equivalent
 * spellings such as "a" and "\\u0061" at every nesting level.
 */
export function parseAidenRemoteJson(
  serialized: string,
  label = "JSON data",
): unknown {
  let offset = 0;
  let objectKeys = 0;

  function fail(): never {
    throw new Error(`Malformed Aiden ${label}.`);
  }

  function skipWhitespace(): void {
    while (serialized[offset] === " " || serialized[offset] === "\t" || serialized[offset] === "\n" || serialized[offset] === "\r") {
      offset += 1;
    }
  }

  function readString(decode: boolean): string | undefined {
    if (serialized[offset] !== '"') fail();
    offset += 1;
    let segmentStart = offset;
    let decoded = "";
    while (offset < serialized.length) {
      const character = serialized[offset]!;
      if (character === '"') {
        decoded += serialized.slice(segmentStart, offset);
        if (!isValidJsonString(decoded)) fail();
        offset += 1;
        return decode ? decoded : undefined;
      }
      if (character === "\\") {
        decoded += serialized.slice(segmentStart, offset);
        offset += 1;
        const escaped = serialized[offset];
        if (escaped === undefined) fail();
        if (escaped === "u") {
          const hexadecimal = serialized.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) fail();
          decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
          offset += 5;
          segmentStart = offset;
          continue;
        }
        const replacement = escaped === '"'
          ? '"'
          : escaped === "\\"
            ? "\\"
            : escaped === "/"
              ? "/"
              : escaped === "b"
                ? "\b"
                : escaped === "f"
                  ? "\f"
                  : escaped === "n"
                    ? "\n"
                    : escaped === "r"
                      ? "\r"
                      : escaped === "t"
                        ? "\t"
                        : undefined;
        if (replacement === undefined) fail();
        decoded += replacement;
        offset += 1;
        segmentStart = offset;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      offset += 1;
    }
    fail();
  }

  function readNumber(): void {
    const numberStart = offset;
    if (serialized[offset] === "-") offset += 1;
    if (serialized[offset] === "0") {
      offset += 1;
    } else {
      const first = serialized.charCodeAt(offset);
      if (first < 0x31 || first > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === ".") {
      offset += 1;
      const firstFraction = serialized.charCodeAt(offset);
      if (firstFraction < 0x30 || firstFraction > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (serialized[offset] === "e" || serialized[offset] === "E") {
      offset += 1;
      if (serialized[offset] === "+" || serialized[offset] === "-") offset += 1;
      const firstExponent = serialized.charCodeAt(offset);
      if (firstExponent < 0x30 || firstExponent > 0x39) fail();
      do {
        offset += 1;
      } while (serialized.charCodeAt(offset) >= 0x30 && serialized.charCodeAt(offset) <= 0x39);
    }
    if (!Number.isFinite(Number(serialized.slice(numberStart, offset)))) fail();
  }

  function readValue(depth: number): void {
    if (depth > AIDEN_REMOTE_MAX_JSON_NESTING_DEPTH) fail();
    skipWhitespace();
    const character = serialized[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        const key = readString(true);
        objectKeys += 1;
        if (objectKeys > AIDEN_REMOTE_MAX_JSON_OBJECT_KEYS || key === undefined || keys.has(key)) fail();
        keys.add(key);
        skipWhitespace();
        if (serialized[offset] !== ":") fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "}") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (serialized[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (serialized[offset] === "]") {
          offset += 1;
          return;
        }
        if (serialized[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === '"') {
      readString(false);
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      readNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (serialized.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    fail();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== serialized.length) fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Malformed Aiden Remote ${label}.`);
  }
  assertNoForbiddenWireKeys(parsed, label);
  return parsed;
}

export function parseAidenSseFrames(input: string): AidenSseFrame[] {
  return input.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    if (Buffer.byteLength(frame, "utf8") > AIDEN_REMOTE_MAX_SSE_FRAME_BYTES) {
      throw new Error("Aiden SSE frame exceeds the byte limit.");
    }
    let id: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!id || data.length === 0) throw new Error("Malformed Aiden SSE frame.");
    return { id, data: parseAidenRemoteJson(data.join("\n"), "SSE JSON data") };
  });
}

export function reconcileAidenSseFrames(
  frames: readonly AidenSseFrame[],
  lastEventId: number,
  expectedStreamId: string,
): { events: AidenRemoteStreamEvent[]; reconcileRequired: boolean } {
  if (expectedStreamId.length === 0 || expectedStreamId.length > 128) {
    throw new Error("Aiden SSE expected streamId must be a bounded non-empty string.");
  }
  const events: AidenRemoteStreamEvent[] = [];
  let expected = lastEventId + 1;
  let terminalSeen = false;
  for (const frame of frames) {
    const event = parseAidenRemoteStreamEvent(frame.data);
    const streamId = event?.streamId ?? (isRecord(frame.data) && typeof frame.data.streamId === "string" ? frame.data.streamId : undefined);
    if (streamId !== expectedStreamId) return { events, reconcileRequired: true };
    const sequence = event?.sequence ?? (isRecord(frame.data) ? frame.data.sequence : undefined);
    if (!Number.isSafeInteger(sequence) || frame.id !== String(sequence)) return { events, reconcileRequired: true };
    if ((sequence as number) <= lastEventId) continue;
    if (sequence !== expected) return { events, reconcileRequired: true };
    if (terminalSeen) return { events, reconcileRequired: true };
    if (event) {
      events.push(event);
      terminalSeen = event.terminal;
    }
    expected += 1;
  }
  return { events, reconcileRequired: false };
}

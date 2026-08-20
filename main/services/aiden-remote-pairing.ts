import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  assertAidenRemoteEndpoint,
  type AidenRemoteCapability,
} from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type {
  AidenRemoteDeviceType,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";

const PAIRING_WINDOW_MS = 5 * 60_000;
const PAIRING_ATTEMPTS_PER_SOURCE = 10;
const PAIRING_RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_SOURCES = 1_024;

export interface AidenRemotePairingBootstrap {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  instanceId: string;
  endpoint: string;
  serverSpkiSha256: string;
  secret: string;
  expiresAt: string;
}

export interface AidenRemotePairingExchangeInput {
  secret: string;
  deviceName: string;
  deviceType: AidenRemoteDeviceType;
  clientVersion: string;
}

export interface AidenRemotePairingExchangeResponse {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  instanceId: string;
  deviceId: string;
  credential: string;
  capabilities: AidenRemoteCapability[];
  endpoint: string;
  serverSpkiSha256: string;
}

interface PairingWindow {
  secretDigest: Buffer;
  endpoint: string;
  serverSpkiSha256: string;
  expiresAt: number;
  consumed: boolean;
}

export interface AidenRemotePairingDependencies {
  now(): number;
  randomBytes(size: number): Buffer;
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    characterLength(value) <= maximum
  );
}

function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseAidenRemotePairingExchangeInput(
  value: unknown,
): AidenRemotePairingExchangeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "Pairing details are invalid.",
      400,
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "secret",
    "deviceName",
    "deviceType",
    "clientVersion",
  ]);
  if (
    Object.keys(record).length !== allowed.size ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    typeof record.secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.secret) ||
    !bounded(record.deviceName, 80) ||
    (record.deviceType !== "iphone" && record.deviceType !== "ipad") ||
    !bounded(record.clientVersion, 40)
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "Pairing details are invalid.",
      400,
    );
  }
  return {
    secret: record.secret,
    deviceName: record.deviceName,
    deviceType: record.deviceType,
    clientVersion: record.clientVersion,
  };
}

export class AidenRemotePairingService {
  private window: PairingWindow | null = null;
  private attempts = new Map<string, number[]>();

  constructor(
    private readonly instanceId: string,
    private readonly devices: Pick<AidenRemoteStateRegistry, "issueDevice">,
    private readonly dependencies: AidenRemotePairingDependencies = {
      now: Date.now,
      randomBytes,
    },
  ) {}

  begin(
    endpoint: string,
    serverSpkiSha256: string,
  ): AidenRemotePairingBootstrap {
    assertAidenRemoteEndpoint(endpoint);
    if (!/^sha256\/[A-Za-z0-9+/]{43}=$/u.test(serverSpkiSha256)) {
      throw new Error("Aiden Remote server fingerprint is invalid.");
    }
    const secret = this.dependencies.randomBytes(32).toString("base64url");
    const expiresAt = this.dependencies.now() + PAIRING_WINDOW_MS;
    this.window = {
      secretDigest: digestSecret(secret),
      endpoint,
      serverSpkiSha256,
      expiresAt,
      consumed: false,
    };
    return {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      endpoint,
      serverSpkiSha256,
      secret,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  close(): void {
    this.window = null;
  }

  private admitAttempt(source: string): void {
    const now = this.dependencies.now();
    const cutoff = now - PAIRING_RATE_WINDOW_MS;
    for (const [key, timestamps] of this.attempts) {
      const retained = timestamps.filter((timestamp) => timestamp > cutoff);
      if (retained.length === 0) this.attempts.delete(key);
      else if (retained.length !== timestamps.length) this.attempts.set(key, retained);
    }
    if (!this.attempts.has(source) && this.attempts.size >= MAX_RATE_LIMIT_SOURCES) {
      throw new AidenRemoteServiceError(
        "rate_limited",
        "Too many pairing attempts. Try again shortly.",
        429,
        true,
        { retryAfterSeconds: 60 },
      );
    }
    const timestamps = this.attempts.get(source) ?? [];
    if (timestamps.length >= PAIRING_ATTEMPTS_PER_SOURCE) {
      throw new AidenRemoteServiceError(
        "rate_limited",
        "Too many pairing attempts. Try again shortly.",
        429,
        true,
        { retryAfterSeconds: 60 },
      );
    }
    timestamps.push(now);
    this.attempts.set(source, timestamps);
  }

  async exchange(
    value: unknown,
    source: string,
  ): Promise<AidenRemotePairingExchangeResponse> {
    this.admitAttempt(source);
    const input = parseAidenRemotePairingExchangeInput(value);
    const current = this.window;
    if (!current) {
      throw new AidenRemoteServiceError(
        "pairing_closed",
        "Open a new pairing window in Aiden Settings.",
        403,
      );
    }
    if (this.dependencies.now() >= current.expiresAt) {
      this.window = null;
      throw new AidenRemoteServiceError(
        "pairing_expired",
        "This pairing code expired. Open a new pairing window.",
        403,
      );
    }
    if (current.consumed) {
      throw new AidenRemoteServiceError(
        "pairing_already_used",
        "This pairing code was already used.",
        409,
      );
    }
    if (!sameDigest(current.secretDigest, digestSecret(input.secret))) {
      throw new AidenRemoteServiceError(
        "authentication_required",
        "The pairing code is not valid.",
        401,
      );
    }

    // Consume synchronously before any durable work. Concurrent exchanges and
    // persistence failures can never turn this high-authority secret reusable.
    current.consumed = true;
    const issued = await this.devices.issueDevice({
      name: input.deviceName,
      type: input.deviceType,
      clientVersion: input.clientVersion,
      capabilities: AIDEN_REMOTE_CAPABILITIES,
    });
    return {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      deviceId: issued.device.id,
      credential: issued.credential,
      capabilities: [...issued.device.capabilities],
      endpoint: current.endpoint,
      serverSpkiSha256: current.serverSpkiSha256,
    };
  }
}

import {
  createCipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_LEGACY_CAPABILITIES,
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
const MANUAL_PAIRING_CODE_CHARACTERS = 20;
const MANUAL_PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MANUAL_PAIRING_KIND = "aiden-manual-pairing-v1" as const;
const MANUAL_PAIRING_SALT_BYTES = 16;
const MANUAL_PAIRING_NONCE_BYTES = 12;
const MANUAL_PAIRING_TAG_BYTES = 16;
const MAX_PAIRING_PAYLOAD_BYTES = 4_096;

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
  acceptsDisplayName?: boolean;
  acceptsBotCapabilities?: boolean;
}

export interface AidenRemotePairingExchangeResponse {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  instanceId: string;
  deviceId: string;
  credential: string;
  capabilities: AidenRemoteCapability[];
  endpoint: string;
  serverSpkiSha256: string;
  displayName?: string;
}

interface PairingWindow {
  sessionId: string;
  secretDigest: Buffer;
  endpoint: string;
  serverSpkiSha256: string;
  expiresAt: number;
  consumed: boolean;
  cancelled: boolean;
  issuedDeviceId?: string;
  issuanceFailed: boolean;
  manualCodeKey: Buffer;
  manualSalt: Buffer;
  manualBootstrap?: AidenRemoteManualPairingBootstrap;
}

export interface AidenRemotePairingWindowStatus {
  sessionId: string;
  state: "awaiting_scan" | "finishing" | "failed" | "expired";
  deviceId?: string;
}

export interface AidenRemoteDesktopPairing {
  sessionId: string;
  bootstrap: AidenRemotePairingBootstrap;
  manualCode: string;
  qrPayload?: string;
}

export interface AidenRemoteManualPairingBootstrap {
  kind: typeof MANUAL_PAIRING_KIND;
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  sessionId: string;
  expiresAt: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
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

function encodeCrockfordBase32(bytes: Buffer, characters: number): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && result.length < characters) {
      bits -= 5;
      result += MANUAL_PAIRING_CODE_ALPHABET[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (result.length < characters && bits > 0) {
    result += MANUAL_PAIRING_CODE_ALPHABET[(value << (5 - bits)) & 31];
  }
  if (result.length !== characters) throw new Error("Manual pairing code generation failed.");
  return result;
}

export function formatAidenManualPairingCode(code: string): string {
  return code.match(/.{1,4}/gu)?.join("-") ?? code;
}

export function normalizeAidenManualPairingCode(value: string): string {
  const normalized = value.replace(/[ -]/gu, "").toUpperCase();
  if (
    normalized.length !== MANUAL_PAIRING_CODE_CHARACTERS
    || [...normalized].some((character) => !MANUAL_PAIRING_CODE_ALPHABET.includes(character))
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The manual pairing code is invalid.",
      400,
    );
  }
  return normalized;
}

function manualPairingInfo(sessionId: string): Buffer {
  return Buffer.from(`${MANUAL_PAIRING_KIND}\n${sessionId}`, "utf8");
}

function manualPairingAdditionalData(sessionId: string, expiresAt: string): Buffer {
  return Buffer.from(`${MANUAL_PAIRING_KIND}\n${sessionId}\n${expiresAt}`, "utf8");
}

function deriveManualPairingKey(code: string, salt: Buffer, sessionId: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(code, "ascii"),
    salt,
    manualPairingInfo(sessionId),
    32,
  ));
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
    "acceptsDisplayName",
    "acceptsBotCapabilities",
  ]);
  if (
    Object.keys(record).length < 4 ||
    Object.keys(record).length > allowed.size ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    typeof record.secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.secret) ||
    !bounded(record.deviceName, 80) ||
    (record.deviceType !== "iphone" && record.deviceType !== "ipad") ||
    !bounded(record.clientVersion, 40) ||
    (record.acceptsDisplayName !== undefined && typeof record.acceptsDisplayName !== "boolean") ||
    (record.acceptsBotCapabilities !== undefined && typeof record.acceptsBotCapabilities !== "boolean")
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
    ...(record.acceptsDisplayName === true ? { acceptsDisplayName: true } : {}),
    ...(record.acceptsBotCapabilities === true ? { acceptsBotCapabilities: true } : {}),
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
    private readonly onStatusChanged: () => void = () => undefined,
    private readonly displayName: () => string = () => "Aiden Agent",
    private readonly botCapabilitiesSupported: () => boolean = () => true,
  ) {}

  begin(
    endpoint: string,
    serverSpkiSha256: string,
  ): AidenRemoteDesktopPairing {
    assertAidenRemoteEndpoint(endpoint);
    if (!/^sha256\/[A-Za-z0-9+/]{43}=$/u.test(serverSpkiSha256)) {
      throw new Error("Aiden Remote server fingerprint is invalid.");
    }
    if (this.window) this.window.cancelled = true;
    this.eraseManualKeyMaterial(this.window);
    const secret = this.dependencies.randomBytes(32).toString("base64url");
    const manualCode = encodeCrockfordBase32(
      this.dependencies.randomBytes(13),
      MANUAL_PAIRING_CODE_CHARACTERS,
    );
    const sessionId = `pairing_${this.dependencies.randomBytes(24).toString("base64url")}`;
    const expiresAt = this.dependencies.now() + PAIRING_WINDOW_MS;
    const manualSalt = this.dependencies.randomBytes(MANUAL_PAIRING_SALT_BYTES);
    this.window = {
      sessionId,
      secretDigest: digestSecret(secret),
      endpoint,
      serverSpkiSha256,
      expiresAt,
      consumed: false,
      cancelled: false,
      issuanceFailed: false,
      manualCodeKey: deriveManualPairingKey(manualCode, manualSalt, sessionId),
      manualSalt,
    };
    this.onStatusChanged();
    return {
      sessionId,
      manualCode: formatAidenManualPairingCode(manualCode),
      bootstrap: {
        protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
        instanceId: this.instanceId,
        endpoint,
        serverSpkiSha256,
        secret,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  sealManualPayload(sessionId: string, payload: string): AidenRemoteManualPairingBootstrap {
    const current = this.window;
    if (!current || current.sessionId !== sessionId) {
      throw new Error("The pairing window changed before its manual payload was prepared.");
    }
    if (current.manualBootstrap) {
      throw new Error("The manual pairing payload is already prepared.");
    }
    const plaintext = Buffer.from(payload, "utf8");
    if (plaintext.length === 0 || plaintext.length > MAX_PAIRING_PAYLOAD_BYTES) {
      throw new Error("Aiden Remote pairing payload is too large.");
    }
    const nonce = this.dependencies.randomBytes(MANUAL_PAIRING_NONCE_BYTES);
    const expiresAt = new Date(current.expiresAt).toISOString();
    const cipher = createCipheriv("aes-256-gcm", current.manualCodeKey, nonce, {
      authTagLength: MANUAL_PAIRING_TAG_BYTES,
    });
    cipher.setAAD(manualPairingAdditionalData(sessionId, expiresAt));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const bootstrap: AidenRemoteManualPairingBootstrap = {
      kind: MANUAL_PAIRING_KIND,
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      sessionId,
      expiresAt,
      salt: current.manualSalt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    current.manualBootstrap = bootstrap;
    current.manualCodeKey.fill(0);
    current.manualSalt.fill(0);
    return bootstrap;
  }

  manualBootstrap(): AidenRemoteManualPairingBootstrap {
    const current = this.window;
    if (!current) {
      throw new AidenRemoteServiceError(
        "pairing_closed",
        "Open a new pairing window in Aiden Settings.",
        403,
      );
    }
    if (this.dependencies.now() >= current.expiresAt) {
      this.onStatusChanged();
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
    if (!current.manualBootstrap) {
      throw new AidenRemoteServiceError(
        "pairing_closed",
        "The manual pairing payload is unavailable. Open a new pairing window.",
        503,
        true,
      );
    }
    return { ...current.manualBootstrap };
  }

  close(sessionId?: string): boolean {
    if (sessionId && this.window?.sessionId !== sessionId) return false;
    if (!this.window) return false;
    this.window.cancelled = true;
    this.eraseManualKeyMaterial(this.window);
    this.window = null;
    this.onStatusChanged();
    return true;
  }

  private eraseManualKeyMaterial(window: PairingWindow | null): void {
    window?.manualCodeKey.fill(0);
    window?.manualSalt.fill(0);
  }

  status(): AidenRemotePairingWindowStatus | undefined {
    const current = this.window;
    if (!current) return undefined;
    if (current.issuedDeviceId) {
      return {
        sessionId: current.sessionId,
        state: "finishing",
        deviceId: current.issuedDeviceId,
      };
    }
    if (current.issuanceFailed) {
      return { sessionId: current.sessionId, state: "failed" };
    }
    if (current.consumed) {
      return {
        sessionId: current.sessionId,
        state: "finishing",
      };
    }
    if (this.dependencies.now() >= current.expiresAt) {
      return { sessionId: current.sessionId, state: "expired" };
    }
    return {
      sessionId: current.sessionId,
      state: "awaiting_scan",
    };
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
      this.onStatusChanged();
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
    this.onStatusChanged();
    const acceptsBotCapabilities =
      input.acceptsBotCapabilities === true && this.botCapabilitiesSupported();
    let issued: Awaited<ReturnType<AidenRemoteStateRegistry["issueDevice"]>>;
    try {
      issued = await this.devices.issueDevice({
        name: input.deviceName,
        type: input.deviceType,
        clientVersion: input.clientVersion,
        capabilities: acceptsBotCapabilities
          ? AIDEN_REMOTE_CAPABILITIES
          : AIDEN_REMOTE_LEGACY_CAPABILITIES,
        acceptsBotCapabilities,
        authorizeCommit: () => this.window === current && !current.cancelled,
      });
      if (this.window !== current || current.cancelled) {
        throw new AidenRemoteServiceError(
          "pairing_closed",
          "This pairing window was closed before the device was created.",
          403,
        );
      }
      current.issuedDeviceId = issued.device.id;
      this.onStatusChanged();
    } catch (error) {
      if (this.window === current && !current.cancelled) {
        current.issuanceFailed = true;
        this.onStatusChanged();
      }
      throw error;
    }
    return {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      deviceId: issued.device.id,
      credential: issued.credential,
      capabilities: [...issued.device.capabilities],
      endpoint: current.endpoint,
      serverSpkiSha256: current.serverSpkiSha256,
      ...(input.acceptsDisplayName ? { displayName: this.displayName() } : {}),
    };
  }
}

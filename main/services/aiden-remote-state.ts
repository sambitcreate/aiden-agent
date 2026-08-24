import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import {
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_LEGACY_CAPABILITIES,
} from "./aiden-remote-protocol.js";
import type { AidenTailscaleOwnership } from "./aiden-remote-tailscale-route.js";
import type { AidenTailscalePendingRouteOutcome } from "./aiden-remote-tailscale.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

const STATE_VERSION = 1 as const;
const DEFAULT_LAN_PORT = 49_220;
const MAX_DEVICES = 32;
const MAX_RETAINED_DEVICES = 128;
const MAX_APPROVED_ROOTS = 32;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
export const MAX_AIDEN_REMOTE_DISPLAY_NAME_CHARACTERS = 80;
const FALLBACK_AIDEN_REMOTE_DISPLAY_NAME = "Aiden Agent";

export type AidenRemoteDeviceType = "iphone" | "ipad";
export type AidenRemoteConnectionMode = "lan" | "tailscale" | "both";

interface StoredAidenRemoteDevice {
  id: string;
  name: string;
  type: AidenRemoteDeviceType;
  clientVersion: string;
  lookupDigest: string;
  credentialSalt: string;
  credentialDigest: string;
  capabilities: AidenRemoteCapability[];
  acceptsBotCapabilities: boolean;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface AidenRemoteApprovedRoot {
  id: string;
  label: string;
  folderPath: string;
  device: string;
  inode: string;
  policyRevision: string;
  createdAt: number;
}

export interface AidenRemoteStateDocument {
  version: typeof STATE_VERSION;
  instanceId: string;
  displayName: string;
  enabled: boolean;
  connectionMode: AidenRemoteConnectionMode;
  lanPort: number;
  lanPortCommitted: boolean;
  devices: StoredAidenRemoteDevice[];
  approvedRoots: AidenRemoteApprovedRoot[];
  tailscaleOwnership?: AidenTailscaleOwnership;
  tailscalePendingOutcome?: AidenTailscalePendingRouteOutcome;
}

export interface AidenRemoteStateStorage {
  load(): Promise<unknown>;
  save(document: AidenRemoteStateDocument): Promise<void>;
  needsSaveAfterLoad?(): Promise<boolean>;
}

export interface AidenRemoteDeviceProjection {
  id: string;
  name: string;
  type: AidenRemoteDeviceType;
  clientVersion: string;
  capabilities: AidenRemoteCapability[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface AidenRemoteAuthenticatedDevice {
  id: string;
  name: string;
  capabilities: ReadonlySet<AidenRemoteCapability>;
  acceptsBotCapabilities: boolean;
  revoked: boolean;
}

export interface AidenRemoteIssuedCredential {
  credential: string;
  device: AidenRemoteDeviceProjection;
}

export interface AidenRemoteStateDependencies {
  now(): number;
  randomBytes(size: number): Buffer;
  deriveCredentialDigest(credential: string, salt: Buffer): Promise<Buffer>;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    Object.keys(record).every((key) => allowed.has(key))
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let characters = 0;
  for (const _character of value) characters += 1;
  return characters <= maximum;
}

export function normalizeAidenRemoteDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Aiden Remote display name must be text.");
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    !boundedString(normalized, MAX_AIDEN_REMOTE_DISPLAY_NAME_CHARACTERS) ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new Error(
      `Aiden Remote display name must be 1–${MAX_AIDEN_REMOTE_DISPLAY_NAME_CHARACTERS} visible characters.`,
    );
  }
  return normalized;
}

export function defaultAidenRemoteDisplayName(computerName: string): string {
  const withoutLocalSuffix = computerName.trim().replace(/\.local\.?$/iu, "");
  try {
    return normalizeAidenRemoteDisplayName(withoutLocalSuffix);
  } catch {
    return FALLBACK_AIDEN_REMOTE_DISPLAY_NAME;
  }
}

function digestString(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseCapabilities(value: unknown): AidenRemoteCapability[] | null {
  if (!Array.isArray(value) || value.length > AIDEN_REMOTE_CAPABILITIES.length) {
    return null;
  }
  const capabilities = new Set<AidenRemoteCapability>();
  for (const capability of value) {
    if (
      typeof capability !== "string" ||
      !(AIDEN_REMOTE_CAPABILITIES as readonly string[]).includes(capability) ||
      capabilities.has(capability as AidenRemoteCapability)
    ) {
      return null;
    }
    capabilities.add(capability as AidenRemoteCapability);
  }
  const parsed = [...capabilities];
  if (parsed.includes("bot:write") && !parsed.includes("bot:read")) {
    return null;
  }
  return parsed;
}

function isBotCapability(value: unknown): value is "bot:read" | "bot:write" {
  return value === "bot:read" || value === "bot:write";
}

function parsePersistedCapabilities(
  value: unknown,
  acceptsBotCapabilities: boolean,
): AidenRemoteCapability[] | null {
  // Bot vocabulary is opt-in. Strip grants that an older or corrupt persisted
  // record could not have negotiated before validating the remaining list.
  const negotiatedValue = !acceptsBotCapabilities && Array.isArray(value)
    ? value.filter((capability) => !isBotCapability(capability))
    : value;
  return parseCapabilities(negotiatedValue);
}

function parseDevice(value: unknown): StoredAidenRemoteDevice | null {
  const record = ownRecord(value);
  const required = [
    "id",
    "name",
    "type",
    "clientVersion",
    "lookupDigest",
    "credentialSalt",
    "credentialDigest",
    "capabilities",
    "createdAt",
    "lastSeenAt",
  ] as const;
  if (
    !record ||
    !exactKeys(record, required, ["acceptsBotCapabilities", "revokedAt"])
  ) return null;
  const acceptsBotCapabilities = record.acceptsBotCapabilities === true;
  const capabilities = parsePersistedCapabilities(
    record.capabilities,
    acceptsBotCapabilities,
  );
  if (
    !boundedString(record.id, 128) ||
    !boundedString(record.name, 80) ||
    (record.type !== "iphone" && record.type !== "ipad") ||
    !boundedString(record.clientVersion, 40) ||
    !digestString(record.lookupDigest) ||
    !digestString(record.credentialSalt) ||
    !digestString(record.credentialDigest) ||
    !capabilities ||
    (record.acceptsBotCapabilities !== undefined &&
      typeof record.acceptsBotCapabilities !== "boolean") ||
    !safeTimestamp(record.createdAt) ||
    !safeTimestamp(record.lastSeenAt) ||
    (record.revokedAt !== undefined && !safeTimestamp(record.revokedAt))
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    clientVersion: record.clientVersion,
    lookupDigest: record.lookupDigest,
    credentialSalt: record.credentialSalt,
    credentialDigest: record.credentialDigest,
    capabilities,
    acceptsBotCapabilities,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

function parseApprovedRoot(value: unknown): AidenRemoteApprovedRoot | null {
  const record = ownRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "id",
      "label",
      "folderPath",
      "device",
      "inode",
      "policyRevision",
      "createdAt",
    ]) ||
    !boundedString(record.id, 128) ||
    !boundedString(record.label, 160) ||
    !boundedString(record.folderPath, 4_096) ||
    !boundedString(record.device, 64) ||
    !boundedString(record.inode, 64) ||
    !boundedString(record.policyRevision, 128) ||
    !safeTimestamp(record.createdAt)
  ) {
    return null;
  }
  return record as unknown as AidenRemoteApprovedRoot;
}

function parseOwnership(value: unknown): AidenTailscaleOwnership | undefined {
  if (value === undefined) return undefined;
  const record = ownRecord(value);
  if (
    !record ||
    !exactKeys(record, ["path", "target"]) ||
    record.path !== "/api/aiden/v1" ||
    !boundedString(record.target, 2_048)
  ) {
    throw new Error("Aiden Remote state has an invalid Tailscale ownership record.");
  }
  return { path: record.path, target: record.target };
}

function parsePendingOutcome(value: unknown): AidenTailscalePendingRouteOutcome | undefined {
  if (value === undefined) return undefined;
  const record = ownRecord(value);
  if (
    !record
    || !exactKeys(
      record,
      [
        "operation",
        "target",
        "beforeFingerprint",
        "preservedFingerprint",
        "normalizeListenerScaffolding",
        "createdAt",
      ],
      ["previousTarget"],
    )
    || !["connect", "takeover", "disconnect"].includes(String(record.operation))
    || !boundedString(record.target, 2_048)
    || (record.previousTarget !== undefined && !boundedString(record.previousTarget, 2_048))
    || typeof record.beforeFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.beforeFingerprint)
    || typeof record.preservedFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.preservedFingerprint)
    || typeof record.normalizeListenerScaffolding !== "boolean"
    || !safeTimestamp(record.createdAt)
  ) {
    throw new Error("Aiden Remote state has an invalid pending Tailscale outcome.");
  }
  return record as unknown as AidenTailscalePendingRouteOutcome;
}

export function createDefaultAidenRemoteState(
  random: (size: number) => Buffer = randomBytes,
  displayName = FALLBACK_AIDEN_REMOTE_DISPLAY_NAME,
): AidenRemoteStateDocument {
  return {
    version: STATE_VERSION,
    instanceId: `instance_${random(24).toString("base64url")}`,
    displayName: normalizeAidenRemoteDisplayName(displayName),
    enabled: false,
    connectionMode: "lan",
    lanPort: DEFAULT_LAN_PORT,
    lanPortCommitted: false,
    devices: [],
    approvedRoots: [],
  };
}

export function parseAidenRemoteStateDocument(
  value: unknown,
  legacyDisplayName = FALLBACK_AIDEN_REMOTE_DISPLAY_NAME,
): AidenRemoteStateDocument {
  const record = ownRecord(value);
  if (
    !record ||
    !exactKeys(
      record,
      ["version", "instanceId", "enabled", "connectionMode", "lanPort", "devices", "approvedRoots"],
      ["displayName", "lanPortCommitted", "tailscaleOwnership", "tailscalePendingOutcome"],
    ) ||
    record.version !== STATE_VERSION ||
    !boundedString(record.instanceId, 128) ||
    typeof record.enabled !== "boolean" ||
    !["lan", "tailscale", "both"].includes(String(record.connectionMode)) ||
    !Number.isInteger(record.lanPort) ||
    Number(record.lanPort) < 1 ||
    Number(record.lanPort) > 65_535 ||
    (record.lanPortCommitted !== undefined && typeof record.lanPortCommitted !== "boolean") ||
    !Array.isArray(record.devices) ||
    record.devices.length > MAX_RETAINED_DEVICES ||
    !Array.isArray(record.approvedRoots) ||
    record.approvedRoots.length > MAX_APPROVED_ROOTS
  ) {
    throw new Error("Aiden Remote state is invalid.");
  }
  const devices = record.devices.map(parseDevice);
  const approvedRoots = record.approvedRoots.map(parseApprovedRoot);
  if (devices.some((device) => device === null)) {
    throw new Error("Aiden Remote state contains an invalid device.");
  }
  if (approvedRoots.some((root) => root === null)) {
    throw new Error("Aiden Remote state contains an invalid approved root.");
  }
  const deviceIds = new Set(devices.map((device) => device!.id));
  const lookupDigests = new Set(devices.map((device) => device!.lookupDigest));
  const rootIds = new Set(approvedRoots.map((root) => root!.id));
  if (deviceIds.size !== devices.length || lookupDigests.size !== devices.length) {
    throw new Error("Aiden Remote state contains duplicate device identity.");
  }
  if (rootIds.size !== approvedRoots.length) {
    throw new Error("Aiden Remote state contains duplicate approved-root identity.");
  }
  const tailscaleOwnership = parseOwnership(record.tailscaleOwnership);
  const tailscalePendingOutcome = parsePendingOutcome(record.tailscalePendingOutcome);
  return {
    version: STATE_VERSION,
    instanceId: record.instanceId,
    displayName: record.displayName === undefined
      ? defaultAidenRemoteDisplayName(legacyDisplayName)
      : normalizeAidenRemoteDisplayName(record.displayName),
    enabled: record.enabled,
    connectionMode: record.connectionMode as AidenRemoteConnectionMode,
    lanPort: Number(record.lanPort),
    lanPortCommitted: record.lanPortCommitted === undefined
      ? Boolean(record.enabled || devices.length > 0 || tailscaleOwnership)
      : record.lanPortCommitted,
    devices: devices as StoredAidenRemoteDevice[],
    approvedRoots: approvedRoots as AidenRemoteApprovedRoot[],
    ...(tailscaleOwnership ? { tailscaleOwnership } : {}),
    ...(tailscalePendingOutcome ? { tailscalePendingOutcome } : {}),
  };
}

function fastLookupDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("base64url");
}

function decodeDigest(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function safeEqual(left: Buffer | null, right: Buffer): boolean {
  return Boolean(left && left.length === right.length && timingSafeEqual(left, right));
}

function projectDevice(device: StoredAidenRemoteDevice): AidenRemoteDeviceProjection {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    clientVersion: device.clientVersion,
    capabilities: [...device.capabilities],
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  };
}

export function defaultAidenRemoteStateDependencies(): AidenRemoteStateDependencies {
  return {
    now: Date.now,
    randomBytes,
    deriveCredentialDigest: (credential, salt) =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          credential,
          salt,
          32,
          { N: 32_768, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024 },
          (error, derived) => {
            if (error) reject(error);
            else resolve(derived as Buffer);
          },
        );
      }),
  };
}

export class AidenRemoteStateRegistry {
  private document: AidenRemoteStateDocument | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly blockedDeviceAuthorizations = new Set<string>();
  private readonly activeDeviceAuthorizations = new Map<string, number>();
  private readonly authorizationWaiters = new Map<string, Set<() => void>>();
  private readonly pendingRevocations = new Map<string, Promise<boolean>>();

  constructor(
    private readonly storage: AidenRemoteStateStorage,
    private readonly dependencies: AidenRemoteStateDependencies =
      defaultAidenRemoteStateDependencies(),
  ) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initialize(): Promise<AidenRemoteStateDocument> {
    return this.serialized(async () => {
      if (this.document) return structuredClone(this.document);
      const raw = await this.storage.load();
      const loaded = parseAidenRemoteStateDocument(raw);
      const rawRecord = ownRecord(raw);
      const storageNeedsSave = this.storage.needsSaveAfterLoad
        ? await this.storage.needsSaveAfterLoad()
        : rawRecord?.displayName === undefined || rawRecord?.lanPortCommitted === undefined;
      const devicesNeedVocabularyMigration = Array.isArray(rawRecord?.devices)
        && rawRecord.devices.some((device) => {
          const record = ownRecord(device);
          return record !== null
            && (
              !Object.prototype.hasOwnProperty.call(record, "acceptsBotCapabilities") ||
              (
                record.acceptsBotCapabilities !== true &&
                Array.isArray(record.capabilities) &&
                record.capabilities.some(isBotCapability)
              )
            );
        });
      if (storageNeedsSave || devicesNeedVocabularyMigration) {
        await this.storage.save(loaded);
      }
      this.document = loaded;
      return structuredClone(loaded);
    });
  }

  private async current(): Promise<AidenRemoteStateDocument> {
    if (!this.document) await this.initialize();
    return this.document!;
  }

  private async mutate<T>(
    operation: (draft: AidenRemoteStateDocument) => Promise<T> | T,
  ): Promise<T> {
    // Initialize before joining the mutation queue. Calling initialize from
    // inside a queued mutation would enqueue behind itself and deadlock.
    if (!this.document) await this.initialize();
    return this.serialized(async () => {
      const draft = structuredClone(await this.current());
      const result = await operation(draft);
      const validated = parseAidenRemoteStateDocument(draft);
      await this.storage.save(validated);
      this.document = validated;
      return result;
    });
  }

  private async mutateIfChanged<T>(
    operation: (
      draft: AidenRemoteStateDocument,
    ) => Promise<{ changed: boolean; value: T }> | { changed: boolean; value: T },
  ): Promise<T> {
    if (!this.document) await this.initialize();
    return this.serialized(async () => {
      const draft = structuredClone(await this.current());
      const result = await operation(draft);
      if (!result.changed) return result.value;
      const validated = parseAidenRemoteStateDocument(draft);
      await this.storage.save(validated);
      this.document = validated;
      return result.value;
    });
  }

  async snapshot(): Promise<AidenRemoteStateDocument> {
    await this.mutationTail;
    return structuredClone(await this.current());
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.mutate((draft) => {
      draft.enabled = enabled;
    });
  }

  async setConnectionMode(connectionMode: AidenRemoteConnectionMode): Promise<void> {
    if (!["lan", "tailscale", "both"].includes(connectionMode)) {
      throw new Error("Invalid Aiden Remote connection mode.");
    }
    await this.mutate((draft) => {
      draft.connectionMode = connectionMode;
    });
  }

  async setDisplayName(displayName: string): Promise<void> {
    const normalized = normalizeAidenRemoteDisplayName(displayName);
    await this.mutateIfChanged((draft) => {
      if (draft.displayName === normalized) {
        return { changed: false, value: undefined };
      }
      draft.displayName = normalized;
      return { changed: true, value: undefined };
    });
  }

  async commitLanPort(lanPort: number): Promise<void> {
    if (!Number.isInteger(lanPort) || lanPort < 1 || lanPort >= 65_535 || lanPort % 2 !== 0) {
      throw new Error("Invalid Aiden Remote listener port.");
    }
    await this.mutateIfChanged((draft) => {
      if (draft.lanPort === lanPort && draft.lanPortCommitted) {
        return { changed: false, value: undefined };
      }
      draft.lanPort = lanPort;
      draft.lanPortCommitted = true;
      return { changed: true, value: undefined };
    });
  }

  async listDevices(): Promise<AidenRemoteDeviceProjection[]> {
    const document = await this.snapshot();
    return document.devices.map(projectDevice);
  }

  async updateDeviceName(
    deviceId: string,
    name: string,
  ): Promise<AidenRemoteDeviceProjection | null> {
    if (!boundedString(deviceId, 128)) return null;
    const normalizedName = normalizeAidenRemoteDisplayName(name);
    return this.mutateIfChanged((draft) => {
      const device = draft.devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.revokedAt !== undefined) {
        return { changed: false, value: null };
      }
      if (device.name === normalizedName) {
        return { changed: false, value: projectDevice(device) };
      }
      device.name = normalizedName;
      return { changed: true, value: projectDevice(device) };
    });
  }

  async issueDevice(input: {
    name: string;
    type: AidenRemoteDeviceType;
    clientVersion: string;
    capabilities?: readonly AidenRemoteCapability[];
    acceptsBotCapabilities?: boolean;
    authorizeCommit?: () => boolean;
  }): Promise<AidenRemoteIssuedCredential> {
    if (
      !boundedString(input.name, 80) ||
      (input.type !== "iphone" && input.type !== "ipad") ||
      !boundedString(input.clientVersion, 40) ||
      (input.acceptsBotCapabilities !== undefined &&
        typeof input.acceptsBotCapabilities !== "boolean")
    ) {
      throw new Error("Invalid pairing device metadata.");
    }
    const capabilities = parseCapabilities(
      input.capabilities ?? AIDEN_REMOTE_LEGACY_CAPABILITIES,
    );
    if (
      !capabilities ||
      (input.acceptsBotCapabilities !== true && capabilities.some(isBotCapability))
    ) {
      throw new Error("Invalid device capabilities.");
    }
    const credential = this.dependencies.randomBytes(32).toString("base64url");
    const salt = this.dependencies.randomBytes(32);
    const credentialDigest = await this.dependencies.deriveCredentialDigest(
      credential,
      salt,
    );
    if (credentialDigest.length !== 32) {
      throw new Error("Aiden Remote credential derivation failed.");
    }
    const now = this.dependencies.now();
    const device: StoredAidenRemoteDevice = {
      id: `device_${this.dependencies.randomBytes(24).toString("base64url")}`,
      name: input.name,
      type: input.type,
      clientVersion: input.clientVersion,
      lookupDigest: fastLookupDigest(credential),
      credentialSalt: salt.toString("base64url"),
      credentialDigest: credentialDigest.toString("base64url"),
      capabilities,
      acceptsBotCapabilities: input.acceptsBotCapabilities === true,
      createdAt: now,
      // Credential issuance is not proof that the client persisted the
      // credential and successfully authenticated back to this Mac.
      lastSeenAt: 0,
    };
    await this.mutate((draft) => {
      if (input.authorizeCommit && !input.authorizeCommit()) {
        throw new AidenRemoteServiceError(
          "pairing_closed",
          "This pairing window was closed before the device was created.",
          403,
        );
      }
      if (draft.devices.filter((entry) => entry.revokedAt === undefined).length >= MAX_DEVICES) {
        throw new Error("Aiden Remote device capacity reached.");
      }
      if (draft.devices.length >= MAX_RETAINED_DEVICES) {
        const revokedIndex = draft.devices.findIndex(
          (entry) => entry.revokedAt !== undefined,
        );
        if (revokedIndex < 0) throw new Error("Aiden Remote device capacity reached.");
        draft.devices.splice(revokedIndex, 1);
      }
      draft.devices.push(device);
    });
    return { credential, device: projectDevice(device) };
  }

  async authenticate(credential: string): Promise<AidenRemoteAuthenticatedDevice | null> {
    if (!digestString(credential)) return null;
    await this.mutationTail;
    const document = await this.current();
    const lookupDigest = fastLookupDigest(credential);
    const device = document.devices.find(
      (candidate) => candidate.lookupDigest === lookupDigest,
    );
    if (!device) return null;
    const salt = decodeDigest(device.credentialSalt);
    const stored = decodeDigest(device.credentialDigest);
    if (!salt || !stored) return null;
    const actual = await this.dependencies.deriveCredentialDigest(credential, salt);
    if (!safeEqual(stored, actual)) return null;

    const now = this.dependencies.now();
    return this.mutateIfChanged((draft) => {
      // Re-resolve inside the mutation queue. Revocation or retention may have
      // changed while the expensive credential digest was being derived.
      const current = draft.devices.find((candidate) => candidate.id === device.id);
      if (!current) return { changed: false, value: null };
      const capabilities = parsePersistedCapabilities(
        current.capabilities,
        current.acceptsBotCapabilities === true,
      );
      if (!capabilities) return { changed: false, value: null };
      const authenticated: AidenRemoteAuthenticatedDevice = {
        id: current.id,
        name: current.name,
        capabilities: new Set(capabilities),
        acceptsBotCapabilities: current.acceptsBotCapabilities === true,
        revoked: current.revokedAt !== undefined,
      };
      const shouldPersistLastSeen =
        !authenticated.revoked &&
        (current.lastSeenAt === 0 || now - current.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS);
      if (shouldPersistLastSeen) current.lastSeenAt = now;
      return { changed: shouldPersistLastSeen, value: authenticated };
    });
  }

  acquireDeviceAuthorization(deviceId: string, tracksMutationDrain = true): () => void {
    if (this.blockedDeviceAuthorizations.has(deviceId)) {
      throw new AidenRemoteServiceError(
        "credential_revoked",
        "This device was revoked in Aiden Settings.",
        403,
      );
    }
    if (tracksMutationDrain) {
      this.activeDeviceAuthorizations.set(
        deviceId,
        (this.activeDeviceAuthorizations.get(deviceId) ?? 0) + 1,
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!tracksMutationDrain) return;
      const remaining = (this.activeDeviceAuthorizations.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.activeDeviceAuthorizations.set(deviceId, remaining);
        return;
      }
      this.activeDeviceAuthorizations.delete(deviceId);
      const waiters = this.authorizationWaiters.get(deviceId);
      this.authorizationWaiters.delete(deviceId);
      for (const resolve of waiters ?? []) resolve();
    };
  }

  private waitForDeviceAuthorizations(deviceId: string): Promise<void> {
    if ((this.activeDeviceAuthorizations.get(deviceId) ?? 0) === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.authorizationWaiters.get(deviceId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.authorizationWaiters.set(deviceId, waiters);
    });
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    if (!boundedString(deviceId, 128)) return false;
    const inFlight = this.pendingRevocations.get(deviceId);
    if (inFlight) return inFlight;
    const pending = (async () => {
      this.blockedDeviceAuthorizations.add(deviceId);
      let status: "revoked" | "already_revoked" | "missing";
      try {
        status = await this.mutate((draft) => {
          const device = draft.devices.find((candidate) => candidate.id === deviceId);
          if (!device) return "missing" as const;
          if (device.revokedAt !== undefined) return "already_revoked" as const;
          device.revokedAt = this.dependencies.now();
          return "revoked" as const;
        });
      } catch (error) {
        this.blockedDeviceAuthorizations.delete(deviceId);
        throw error;
      }
      if (status === "missing") this.blockedDeviceAuthorizations.delete(deviceId);
      // Revocation is durable before waiting for already-admitted mutations.
      // A stalled application operation may delay cleanup, but it can never
      // make the credential valid again after a restart.
      if (status !== "missing") await this.waitForDeviceAuthorizations(deviceId);
      return status === "revoked";
    })();
    this.pendingRevocations.set(deviceId, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingRevocations.get(deviceId) === pending) {
        this.pendingRevocations.delete(deviceId);
      }
    }
  }

  async setTailscaleOwnership(
    ownership: AidenTailscaleOwnership | undefined,
  ): Promise<void> {
    await this.mutate((draft) => {
      if (ownership) draft.tailscaleOwnership = ownership;
      else delete draft.tailscaleOwnership;
    });
  }

  async beginTailscalePendingOutcome(
    outcome: AidenTailscalePendingRouteOutcome,
  ): Promise<void> {
    const validated = parsePendingOutcome(outcome);
    if (!validated) throw new Error("Invalid pending Tailscale outcome.");
    await this.mutate((draft) => {
      if (draft.tailscalePendingOutcome) {
        throw new Error("tailscale_reconciliation_required");
      }
      draft.tailscalePendingOutcome = validated;
    });
  }

  async clearTailscalePendingOutcome(): Promise<void> {
    await this.mutate((draft) => {
      delete draft.tailscalePendingOutcome;
    });
  }

  async commitTailscaleOutcome(
    ownership: AidenTailscaleOwnership | undefined,
  ): Promise<void> {
    await this.mutate((draft) => {
      if (ownership) draft.tailscaleOwnership = ownership;
      else delete draft.tailscaleOwnership;
      delete draft.tailscalePendingOutcome;
    });
  }

  async addApprovedRoot(root: AidenRemoteApprovedRoot): Promise<void> {
    if (!parseApprovedRoot(root)) throw new Error("Invalid approved root.");
    await this.mutate((draft) => {
      if (draft.approvedRoots.length >= MAX_APPROVED_ROOTS) {
        throw new Error("Aiden Remote approved-root capacity reached.");
      }
      if (draft.approvedRoots.some((candidate) => candidate.id === root.id)) {
        throw new Error("This approved root already exists.");
      }
      draft.approvedRoots.push(root);
    });
  }

  async removeApprovedRoot(rootId: string): Promise<boolean> {
    if (!boundedString(rootId, 128)) return false;
    return this.mutate((draft) => {
      const index = draft.approvedRoots.findIndex((root) => root.id === rootId);
      if (index < 0) return false;
      draft.approvedRoots.splice(index, 1);
      return true;
    });
  }
}

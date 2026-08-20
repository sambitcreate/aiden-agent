import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { AIDEN_REMOTE_CAPABILITIES } from "./aiden-remote-protocol.js";
import type { AidenTailscaleOwnership } from "./aiden-remote-tailscale-route.js";

const STATE_VERSION = 1 as const;
const DEFAULT_LAN_PORT = 49_220;
const MAX_DEVICES = 32;
const MAX_RETAINED_DEVICES = 128;
const MAX_APPROVED_ROOTS = 32;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

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
  enabled: boolean;
  connectionMode: AidenRemoteConnectionMode;
  lanPort: number;
  devices: StoredAidenRemoteDevice[];
  approvedRoots: AidenRemoteApprovedRoot[];
  tailscaleOwnership?: AidenTailscaleOwnership;
}

export interface AidenRemoteStateStorage {
  load(): Promise<unknown>;
  save(document: AidenRemoteStateDocument): Promise<void>;
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
  capabilities: ReadonlySet<AidenRemoteCapability>;
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
  return [...capabilities];
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
  if (!record || !exactKeys(record, required, ["revokedAt"])) return null;
  const capabilities = parseCapabilities(record.capabilities);
  if (
    !boundedString(record.id, 128) ||
    !boundedString(record.name, 80) ||
    (record.type !== "iphone" && record.type !== "ipad") ||
    !boundedString(record.clientVersion, 40) ||
    !digestString(record.lookupDigest) ||
    !digestString(record.credentialSalt) ||
    !digestString(record.credentialDigest) ||
    !capabilities ||
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

export function createDefaultAidenRemoteState(
  random: (size: number) => Buffer = randomBytes,
): AidenRemoteStateDocument {
  return {
    version: STATE_VERSION,
    instanceId: `instance_${random(24).toString("base64url")}`,
    enabled: false,
    connectionMode: "lan",
    lanPort: DEFAULT_LAN_PORT,
    devices: [],
    approvedRoots: [],
  };
}

export function parseAidenRemoteStateDocument(value: unknown): AidenRemoteStateDocument {
  const record = ownRecord(value);
  if (
    !record ||
    !exactKeys(
      record,
      ["version", "instanceId", "enabled", "connectionMode", "lanPort", "devices", "approvedRoots"],
      ["tailscaleOwnership"],
    ) ||
    record.version !== STATE_VERSION ||
    !boundedString(record.instanceId, 128) ||
    typeof record.enabled !== "boolean" ||
    !["lan", "tailscale", "both"].includes(String(record.connectionMode)) ||
    !Number.isInteger(record.lanPort) ||
    Number(record.lanPort) < 1 ||
    Number(record.lanPort) > 65_535 ||
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
  return {
    version: STATE_VERSION,
    instanceId: record.instanceId,
    enabled: record.enabled,
    connectionMode: record.connectionMode as AidenRemoteConnectionMode,
    lanPort: Number(record.lanPort),
    devices: devices as StoredAidenRemoteDevice[],
    approvedRoots: approvedRoots as AidenRemoteApprovedRoot[],
    ...(tailscaleOwnership ? { tailscaleOwnership } : {}),
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
      const loaded = parseAidenRemoteStateDocument(await this.storage.load());
      await this.storage.save(loaded);
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

  async listDevices(): Promise<AidenRemoteDeviceProjection[]> {
    const document = await this.snapshot();
    return document.devices.map(projectDevice);
  }

  async issueDevice(input: {
    name: string;
    type: AidenRemoteDeviceType;
    clientVersion: string;
    capabilities?: readonly AidenRemoteCapability[];
  }): Promise<AidenRemoteIssuedCredential> {
    if (
      !boundedString(input.name, 80) ||
      (input.type !== "iphone" && input.type !== "ipad") ||
      !boundedString(input.clientVersion, 40)
    ) {
      throw new Error("Invalid pairing device metadata.");
    }
    const capabilities = parseCapabilities(
      input.capabilities ?? AIDEN_REMOTE_CAPABILITIES,
    );
    if (!capabilities) throw new Error("Invalid device capabilities.");
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
      createdAt: now,
      lastSeenAt: now,
    };
    await this.mutate((draft) => {
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

    const authenticated: AidenRemoteAuthenticatedDevice = {
      id: device.id,
      capabilities: new Set(device.capabilities),
      revoked: device.revokedAt !== undefined,
    };
    const now = this.dependencies.now();
    if (
      !authenticated.revoked &&
      now - device.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS
    ) {
      await this.mutate((draft) => {
        const current = draft.devices.find((candidate) => candidate.id === device.id);
        if (current && current.revokedAt === undefined) current.lastSeenAt = now;
      });
    }
    return authenticated;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    if (!boundedString(deviceId, 128)) return false;
    return this.mutate((draft) => {
      const device = draft.devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.revokedAt !== undefined) return false;
      device.revokedAt = this.dependencies.now();
      return true;
    });
  }

  async setTailscaleOwnership(
    ownership: AidenTailscaleOwnership | undefined,
  ): Promise<void> {
    await this.mutate((draft) => {
      if (ownership) draft.tailscaleOwnership = ownership;
      else delete draft.tailscaleOwnership;
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

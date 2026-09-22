import { createHash, randomUUID } from "node:crypto";
import type { AidenRemoteBotAvatarAsset } from "./aiden-remote-protocol.js";

export const BOT_AVATAR_STORE_VERSION = 1 as const;
export const BOT_AVATAR_SOURCE_MAX_BYTES = 4 * 1_048_576;
export const BOT_AVATAR_CANONICAL_EDGE = 512;
export const BOT_AVATAR_CANONICAL_MAX_BYTES = 4 * 1_048_576;
export const BOT_AVATAR_MAX_SOURCE_EDGE = 4_096;
export const BOT_AVATAR_MAX_SOURCE_PIXELS = 16_000_000;
export const BOT_AVATAR_MAX_RECORDS = 256;
export const BOT_AVATAR_MAX_RECEIPTS = 1_024;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ASSET_REVISION = /^avatar_revision_[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export type BotAvatarSourceMimeType = "image/png" | "image/jpeg";

export interface BotAvatarSource {
  mimeType: BotAvatarSourceMimeType;
  bytes: Buffer;
}

export interface BotAvatarDimensions {
  width: number;
  height: number;
}

export interface BotAvatarAssetIncarnation {
  device: string;
  inode: string;
}

export interface BotAvatarStoredAsset {
  assetId: string;
  byteSize: number;
  digest: string;
  incarnation: BotAvatarAssetIncarnation;
}

export interface BotAvatarStorage {
  readManifest(): Promise<unknown | null>;
  writeManifest(document: BotAvatarStoreDocument): Promise<void>;
  writeAsset(assetId: string, bytes: Buffer): Promise<BotAvatarStoredAsset>;
  readAsset(asset: BotAvatarStoredAsset): Promise<Buffer | null>;
  removeAsset(asset: BotAvatarStoredAsset): Promise<boolean>;
  /** Removes only a path-safe, store-owned unreferenced filename during restart reconciliation. */
  removeOrphanAsset(assetId: string): Promise<boolean>;
  listAssetIds(): Promise<readonly string[]>;
}

export interface BotAvatarNormalizer {
  normalize(source: BotAvatarSource, dimensions: BotAvatarDimensions): Promise<Buffer>;
}

interface BotAvatarRecord {
  ownerId: string;
  botId: string;
  assetRevision: string;
  asset: BotAvatarStoredAsset;
  updatedAt: number;
}

type BotAvatarMutationKind = "put" | "delete";

interface BotAvatarMutationReceipt {
  operationId: string;
  ownerId: string;
  botId: string;
  kind: BotAvatarMutationKind;
  expectedAssetRevision: string | null;
  inputDigest: string;
  resultAssetRevision: string | null;
  completedAt: number;
}

export interface BotAvatarStoreDocument {
  version: typeof BOT_AVATAR_STORE_VERSION;
  records: BotAvatarRecord[];
  receipts: BotAvatarMutationReceipt[];
}

export interface BotAvatarMutationScope {
  /** Stable local Aiden-instance/profile owner, never the requesting paired-device id. */
  ownerId: string;
  botId: string;
  /** Null means the caller observed the semantic-avatar fallback. */
  expectedAssetRevision: string | null;
  /** Main-owned, device-scoped idempotency identity. */
  operationId: string;
}

export interface PutBotAvatarInput extends BotAvatarMutationScope {
  source: BotAvatarSource;
}

export interface DeleteBotAvatarInput extends BotAvatarMutationScope {}

export interface BotAvatarContent {
  metadata: AidenRemoteBotAvatarAsset;
  bytes: Buffer;
}

export interface BotAvatarStoreOptions {
  storage: BotAvatarStorage;
  normalizer: BotAvatarNormalizer;
  now?: () => number;
  mintAssetId?: () => string;
  mintAssetRevision?: () => string;
}

export class BotAvatarStateError extends Error {
  readonly name = "BotAvatarStateError";
}

export class BotAvatarInputError extends Error {
  readonly name = "BotAvatarInputError";
}

export class BotAvatarUnavailableError extends Error {
  readonly name = "BotAvatarUnavailableError";
}

export class BotAvatarRevisionConflictError extends Error {
  readonly name = "BotAvatarRevisionConflictError";

  constructor(readonly currentAssetRevision: string | null) {
    super("The Bot avatar changed. Refresh and try again.");
  }
}

export class BotAvatarReplayError extends Error {
  readonly name = "BotAvatarReplayError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeIdentifier(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.normalize("NFKC") === value && value !== "." && value !== ".." && SAFE_IDENTIFIER.test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIncarnation(value: unknown): value is BotAvatarAssetIncarnation {
  return isRecord(value) && exactKeys(value, ["device", "inode"]) &&
    typeof value.device === "string" && DECIMAL.test(value.device) &&
    typeof value.inode === "string" && /^[1-9][0-9]*$/u.test(value.inode);
}

function parseAsset(value: unknown): BotAvatarStoredAsset {
  if (!isRecord(value) || !exactKeys(value, ["assetId", "byteSize", "digest", "incarnation"]) ||
      typeof value.assetId !== "string" || !ASSET_ID.test(value.assetId) ||
      !Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 1 ||
      (value.byteSize as number) > BOT_AVATAR_CANONICAL_MAX_BYTES ||
      typeof value.digest !== "string" || !SHA256.test(value.digest) ||
      !isIncarnation(value.incarnation)) {
    throw new BotAvatarStateError("Bot avatar asset metadata is corrupt.");
  }
  return {
    assetId: value.assetId,
    byteSize: value.byteSize as number,
    digest: value.digest,
    incarnation: { ...value.incarnation },
  };
}

function parseRecord(value: unknown): BotAvatarRecord {
  if (!isRecord(value) || !exactKeys(value, ["ownerId", "botId", "assetRevision", "asset", "updatedAt"]) ||
      !isSafeIdentifier(value.ownerId, 160) || !isSafeIdentifier(value.botId, 160) ||
      typeof value.assetRevision !== "string" || !ASSET_REVISION.test(value.assetRevision) ||
      !isTimestamp(value.updatedAt)) {
    throw new BotAvatarStateError("Bot avatar metadata is corrupt.");
  }
  return {
    ownerId: value.ownerId,
    botId: value.botId,
    assetRevision: value.assetRevision,
    asset: parseAsset(value.asset),
    updatedAt: value.updatedAt,
  };
}

function parseReceipt(value: unknown): BotAvatarMutationReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "operationId", "ownerId", "botId", "kind", "expectedAssetRevision", "inputDigest",
    "resultAssetRevision", "completedAt",
  ]) || !isSafeIdentifier(value.operationId, 128) || !isSafeIdentifier(value.ownerId, 160) ||
      !isSafeIdentifier(value.botId, 160) || (value.kind !== "put" && value.kind !== "delete") ||
      !(value.expectedAssetRevision === null || (typeof value.expectedAssetRevision === "string" &&
        ASSET_REVISION.test(value.expectedAssetRevision))) ||
      typeof value.inputDigest !== "string" || !SHA256.test(value.inputDigest) ||
      !(value.resultAssetRevision === null || (typeof value.resultAssetRevision === "string" &&
        ASSET_REVISION.test(value.resultAssetRevision))) || !isTimestamp(value.completedAt)) {
    throw new BotAvatarStateError("Bot avatar mutation receipt is corrupt.");
  }
  return value as unknown as BotAvatarMutationReceipt;
}

export function parseBotAvatarStoreDocument(value: unknown): BotAvatarStoreDocument {
  if (!isRecord(value) || !exactKeys(value, ["version", "records", "receipts"]) ||
      value.version !== BOT_AVATAR_STORE_VERSION || !Array.isArray(value.records) ||
      value.records.length > BOT_AVATAR_MAX_RECORDS || !Array.isArray(value.receipts) ||
      value.receipts.length > BOT_AVATAR_MAX_RECEIPTS) {
    throw new BotAvatarStateError("Bot avatar store metadata is corrupt.");
  }
  const records = value.records.map(parseRecord);
  const receipts = value.receipts.map(parseReceipt);
  const keys = records.map((record) => `${record.ownerId}\u0000${record.botId}`);
  if (new Set(keys).size !== keys.length ||
      new Set(records.map(({ assetRevision }) => assetRevision)).size !== records.length ||
      new Set(records.map(({ asset }) => asset.assetId)).size !== records.length ||
      new Set(receipts.map(({ operationId }) => operationId)).size !== receipts.length) {
    throw new BotAvatarStateError("Bot avatar store metadata contains duplicate identities.");
  }
  return { version: BOT_AVATAR_STORE_VERSION, records, receipts };
}

function uint32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset);
}

export function inspectBotAvatarSource(source: BotAvatarSource): BotAvatarDimensions {
  if ((source.mimeType !== "image/png" && source.mimeType !== "image/jpeg") ||
      !Buffer.isBuffer(source.bytes) || source.bytes.length === 0 ||
      source.bytes.length > BOT_AVATAR_SOURCE_MAX_BYTES) {
    throw new BotAvatarInputError("The Bot photo must be a bounded PNG or JPEG.");
  }
  let dimensions: BotAvatarDimensions | null = null;
  if (source.mimeType === "image/png") {
    const bytes = source.bytes;
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        uint32(bytes, 8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
      throw new BotAvatarInputError("The Bot photo does not match its PNG type.");
    }
    dimensions = { width: uint32(bytes, 16), height: uint32(bytes, 20) };
  } else {
    const bytes = source.bytes;
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new BotAvatarInputError("The Bot photo does not match its JPEG type.");
    }
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new BotAvatarInputError("The JPEG structure is invalid.");
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
        break;
      }
      offset += length;
    }
    if (!dimensions) throw new BotAvatarInputError("The JPEG dimensions are unavailable.");
  }
  if (dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width > BOT_AVATAR_MAX_SOURCE_EDGE || dimensions.height > BOT_AVATAR_MAX_SOURCE_EDGE ||
      dimensions.width * dimensions.height > BOT_AVATAR_MAX_SOURCE_PIXELS) {
    throw new BotAvatarInputError("The Bot photo dimensions are outside the safe limit.");
  }
  return dimensions;
}

export function inspectCanonicalBotAvatarPng(bytes: Buffer): void {
  const dimensions = inspectBotAvatarSource({ mimeType: "image/png", bytes });
  if (dimensions.width !== BOT_AVATAR_CANONICAL_EDGE || dimensions.height !== BOT_AVATAR_CANONICAL_EDGE ||
      bytes.length > BOT_AVATAR_CANONICAL_MAX_BYTES) {
    throw new BotAvatarInputError("The normalized Bot photo is invalid.");
  }
}

function metadata(record: BotAvatarRecord): AidenRemoteBotAvatarAsset {
  return {
    assetRevision: record.assetRevision,
    mimeType: "image/png",
    width: BOT_AVATAR_CANONICAL_EDGE,
    height: BOT_AVATAR_CANONICAL_EDGE,
    byteSize: record.asset.byteSize,
  };
}

function recordKey(ownerId: string, botId: string): string {
  return `${ownerId}\u0000${botId}`;
}

function validateScope(scope: BotAvatarMutationScope): void {
  if (!isSafeIdentifier(scope.ownerId, 160) || !isSafeIdentifier(scope.botId, 160) ||
      !isSafeIdentifier(scope.operationId, 128) ||
      !(scope.expectedAssetRevision === null || ASSET_REVISION.test(scope.expectedAssetRevision))) {
    throw new BotAvatarInputError("The Bot avatar mutation scope is invalid.");
  }
}

export function createBotAvatarStore(options: BotAvatarStoreOptions) {
  const now = options.now ?? Date.now;
  const mintAssetId = options.mintAssetId ?? randomUUID;
  const mintAssetRevision = options.mintAssetRevision ?? (() =>
    `avatar_revision_${randomUUID().replace(/-/gu, "")}`);
  let document: BotAvatarStoreDocument | null = null;
  let initialization: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const initialize = (): Promise<void> => {
    initialization ??= (async () => {
      const raw = await options.storage.readManifest();
      document = raw === null
        ? { version: BOT_AVATAR_STORE_VERSION, records: [], receipts: [] }
        : parseBotAvatarStoreDocument(raw);
      const referenced = new Set(document.records.map(({ asset }) => asset.assetId));
      for (const assetId of await options.storage.listAssetIds()) {
        if (ASSET_ID.test(assetId) && !referenced.has(assetId)) {
          await options.storage.removeOrphanAsset(assetId);
        }
      }
      for (const record of document.records) {
        const bytes = await options.storage.readAsset(record.asset);
        if (!bytes || bytes.length !== record.asset.byteSize ||
            createHash("sha256").update(bytes).digest("hex") !== record.asset.digest) {
          throw new BotAvatarStateError("A canonical Bot avatar asset is missing or changed.");
        }
        inspectCanonicalBotAvatarPng(bytes);
      }
    })();
    return initialization;
  };

  const findRecord = (ownerId: string, botId: string): BotAvatarRecord | undefined =>
    document!.records.find((record) => recordKey(record.ownerId, record.botId) === recordKey(ownerId, botId));

  const verifyExpected = (scope: BotAvatarMutationScope): BotAvatarRecord | undefined => {
    const current = findRecord(scope.ownerId, scope.botId);
    if ((current?.assetRevision ?? null) !== scope.expectedAssetRevision) {
      throw new BotAvatarRevisionConflictError(current?.assetRevision ?? null);
    }
    return current;
  };

  const checkReplay = (
    scope: BotAvatarMutationScope,
    kind: BotAvatarMutationKind,
    inputDigest: string,
  ): BotAvatarMutationReceipt | null => {
    const receipt = document!.receipts.find(({ operationId }) => operationId === scope.operationId);
    if (!receipt) return null;
    if (receipt.ownerId !== scope.ownerId || receipt.botId !== scope.botId || receipt.kind !== kind ||
        receipt.expectedAssetRevision !== scope.expectedAssetRevision || receipt.inputDigest !== inputDigest) {
      throw new BotAvatarReplayError("The Bot avatar operation identity was reused.");
    }
    const current = findRecord(scope.ownerId, scope.botId)?.assetRevision ?? null;
    if (current !== receipt.resultAssetRevision) {
      throw new BotAvatarReplayError("The Bot avatar operation is no longer current.");
    }
    return receipt;
  };

  const withReceipt = (
    next: BotAvatarStoreDocument,
    scope: BotAvatarMutationScope,
    kind: BotAvatarMutationKind,
    inputDigest: string,
    resultAssetRevision: string | null,
  ): BotAvatarStoreDocument => ({
    ...next,
    receipts: [...next.receipts, {
      operationId: scope.operationId,
      ownerId: scope.ownerId,
      botId: scope.botId,
      kind,
      expectedAssetRevision: scope.expectedAssetRevision,
      inputDigest,
      resultAssetRevision,
      completedAt: now(),
    }].slice(-BOT_AVATAR_MAX_RECEIPTS),
  });

  return {
    initialize,

    async metadata(ownerId: string, botId: string): Promise<AidenRemoteBotAvatarAsset | null> {
      if (!isSafeIdentifier(ownerId, 160) || !isSafeIdentifier(botId, 160)) {
        throw new BotAvatarUnavailableError("Bot avatar unavailable.");
      }
      await initialize();
      const record = findRecord(ownerId, botId);
      return record ? metadata(record) : null;
    },

    async read(ownerId: string, botId: string, assetRevision: string): Promise<BotAvatarContent> {
      if (!isSafeIdentifier(ownerId, 160) || !isSafeIdentifier(botId, 160) || !ASSET_REVISION.test(assetRevision)) {
        throw new BotAvatarUnavailableError("Bot avatar unavailable.");
      }
      await initialize();
      const record = findRecord(ownerId, botId);
      if (!record || record.assetRevision !== assetRevision) {
        throw new BotAvatarUnavailableError("Bot avatar unavailable.");
      }
      let bytes: Buffer | null;
      try {
        bytes = await options.storage.readAsset(record.asset);
      } catch {
        throw new BotAvatarUnavailableError("Bot avatar unavailable.");
      }
      if (!bytes || bytes.length !== record.asset.byteSize ||
          createHash("sha256").update(bytes).digest("hex") !== record.asset.digest) {
        throw new BotAvatarUnavailableError("Bot avatar unavailable.");
      }
      inspectCanonicalBotAvatarPng(bytes);
      return { metadata: metadata(record), bytes: Buffer.from(bytes) };
    },

    put(input: PutBotAvatarInput): Promise<AidenRemoteBotAvatarAsset> {
      return serialized(async () => {
        validateScope(input);
        await initialize();
        const dimensions = inspectBotAvatarSource(input.source);
        const sourceDigest = createHash("sha256").update(input.source.mimeType).update(input.source.bytes).digest("hex");
        const replay = checkReplay(input, "put", sourceDigest);
        if (replay) return metadata(findRecord(input.ownerId, input.botId)!);
        const current = verifyExpected(input);
        if (!current && document!.records.length >= BOT_AVATAR_MAX_RECORDS) {
          throw new BotAvatarStateError("The Bot avatar store is full.");
        }
        const canonical = await options.normalizer.normalize(
          { mimeType: input.source.mimeType, bytes: Buffer.from(input.source.bytes) },
          dimensions,
        );
        inspectCanonicalBotAvatarPng(canonical);
        const assetId = mintAssetId();
        const assetRevision = mintAssetRevision();
        if (!ASSET_ID.test(assetId) || !ASSET_REVISION.test(assetRevision)) {
          throw new BotAvatarStateError("The Bot avatar identity generator is invalid.");
        }
        const asset = await options.storage.writeAsset(assetId, canonical);
        if (asset.assetId !== assetId || asset.byteSize !== canonical.length ||
            asset.digest !== createHash("sha256").update(canonical).digest("hex") || !isIncarnation(asset.incarnation)) {
          throw new BotAvatarStateError("The Bot avatar storage receipt is invalid.");
        }
        const record: BotAvatarRecord = {
          ownerId: input.ownerId,
          botId: input.botId,
          assetRevision,
          asset,
          updatedAt: now(),
        };
        const next = withReceipt({
          ...document!,
          records: [...document!.records.filter((candidate) =>
            recordKey(candidate.ownerId, candidate.botId) !== recordKey(input.ownerId, input.botId)), record],
        }, input, "put", sourceDigest, assetRevision);
        try {
          await options.storage.writeManifest(next);
        } catch (error) {
          await options.storage.removeAsset(asset).catch(() => false);
          throw error;
        }
        document = next;
        if (current) await options.storage.removeAsset(current.asset).catch(() => false);
        return metadata(record);
      });
    },

    delete(input: DeleteBotAvatarInput): Promise<void> {
      return serialized(async () => {
        validateScope(input);
        await initialize();
        const inputDigest = createHash("sha256").update("delete").digest("hex");
        if (checkReplay(input, "delete", inputDigest)) return;
        const current = verifyExpected(input);
        if (!current) throw new BotAvatarUnavailableError("Bot avatar unavailable.");
        const next = withReceipt({
          ...document!,
          records: document!.records.filter((candidate) =>
            recordKey(candidate.ownerId, candidate.botId) !== recordKey(input.ownerId, input.botId)),
        }, input, "delete", inputDigest, null);
        await options.storage.writeManifest(next);
        document = next;
        await options.storage.removeAsset(current.asset).catch(() => false);
      });
    },
  };
}

export type BotAvatarStore = ReturnType<typeof createBotAvatarStore>;

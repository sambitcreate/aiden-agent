import { createHash, randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";

export const MAX_DURABLE_OPERATION_ENTRIES = 10_000;
export const MAX_DURABLE_JSON_DEPTH = 128;
export const MAX_DURABLE_JSON_NODES = 100_000;
export const MAX_DURABLE_JSON_KEYS = 16_384;
export const MAX_DURABLE_JSON_ARRAY_LENGTH = 16_384;
export const MAX_DURABLE_JSON_STRING_LENGTH = 1_048_576;
export const MAX_DURABLE_JSON_RESULT_BYTES = 1_048_576;
export const MAX_DURABLE_LEDGER_SNAPSHOT_BYTES = 16 * 1_048_576;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type AidenOperationContractErrorCode =
  | "idempotency_conflict"
  | "idempotency_capacity"
  | "idempotency_in_flight"
  | "revision_conflict"
  | "capability_denied"
  | "internal_error";

export class AidenOperationContractError extends Error {
  constructor(readonly code: AidenOperationContractErrorCode) {
    super(code);
  }
}

/** The external mutation may have committed, so its idempotency admission must never expire into a retry. */
export class AidenOperationUnknownOutcomeError extends Error {
  constructor() {
    super("The operation outcome requires authoritative reconciliation.");
    this.name = "AidenOperationUnknownOutcomeError";
  }
}

export interface AidenIdempotencySnapshotEntry {
  scopeDigest: string;
  requestDigest: string;
  operationId: string;
  state: "in_flight" | "fulfilled" | "rejected";
  result?: unknown;
  errorCode?: AidenOperationContractErrorCode;
  createdAt: number;
  expiresAt: number | null;
}

export interface AidenIdempotencySnapshot {
  version: 1;
  lastObservedAt: number;
  entries: AidenIdempotencySnapshotEntry[];
}

// A fresh ledger has no snapshot. The versioned envelope is the only format
// that carries the wall-clock high-water mark required for safe restoration.
type AidenIdempotencySnapshotInput = AidenIdempotencySnapshot | undefined;

export interface AidenIdempotencyOperationReference {
  operationId: string;
}

export type AidenIdempotencyOutcome<T = unknown> =
  | { state: "fulfilled"; result: T }
  | { state: "rejected"; errorCode: AidenOperationContractErrorCode };

interface AidenIdempotencyEntry {
  requestDigest: string;
  result?: Promise<unknown>;
  operationId: string;
  createdAt: number;
  expiresAt: number | null;
  settled: boolean;
  settledResult?: unknown;
  rejectionCode?: AidenOperationContractErrorCode;
}

function operationId(): string {
  return `op_${randomBytes(24).toString("base64url")}`;
}

function assertOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new AidenOperationContractError("internal_error");
  }
}

function boundedPositiveIntegerOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new AidenOperationContractError("internal_error");
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

type DurableJsonValue = null | boolean | number | string | DurableJsonValue[] | { [key: string]: DurableJsonValue };

interface DurableJsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxKeys: number;
  maxArrayLength: number;
  maxStringLength: number;
}

const DURABLE_JSON_LIMITS: DurableJsonLimits = {
  maxDepth: MAX_DURABLE_JSON_DEPTH,
  maxNodes: MAX_DURABLE_JSON_NODES,
  maxKeys: MAX_DURABLE_JSON_KEYS,
  maxArrayLength: MAX_DURABLE_JSON_ARRAY_LENGTH,
  maxStringLength: MAX_DURABLE_JSON_STRING_LENGTH,
};

// A snapshot envelope contains one small object per entry. Its structural
// limits are intentionally larger than a replay result's limits so that the
// hard 10,000-entry ledger bound remains usable; the aggregate UTF-8 budget
// below is the final memory/disk bound for the complete envelope.
const DURABLE_SNAPSHOT_JSON_LIMITS: DurableJsonLimits = {
  maxDepth: MAX_DURABLE_JSON_DEPTH,
  maxNodes: MAX_DURABLE_JSON_NODES + MAX_DURABLE_OPERATION_ENTRIES,
  maxKeys: MAX_DURABLE_JSON_KEYS + MAX_DURABLE_OPERATION_ENTRIES * 8,
  maxArrayLength: MAX_DURABLE_OPERATION_ENTRIES,
  maxStringLength: MAX_DURABLE_JSON_STRING_LENGTH,
};

interface DurableJsonValidationState {
  readonly seen: Set<object>;
  nodes: number;
  keys: number;
}

function isDenseArrayIndexKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertExactOwnEnumerableDataKeys(value: object, expectedKeys: readonly string[]): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))
  ) {
    throw new AidenOperationContractError("internal_error");
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      throw new AidenOperationContractError("internal_error");
    }
  }
}

function durableStringLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (Number.isNaN(nextCodeUnit) || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new AidenOperationContractError("internal_error");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new AidenOperationContractError("internal_error");
    }
    length += 1;
  }
  return length;
}

function assertDurableString(value: string, maxLength: number): void {
  if (durableStringLength(value) > maxLength) throw new AidenOperationContractError("internal_error");
}

/**
 * Clone only values whose shape and values survive JSON.stringify/parse
 * unchanged. A structured clone is deliberately not sufficient here: it
 * accepts values (for example Date, undefined, and non-finite numbers) that
 * either disappear or change when the idempotency snapshot is persisted.
 */
function cloneDurableJson(value: unknown, limits: DurableJsonLimits = DURABLE_JSON_LIMITS): DurableJsonValue {
  const state: DurableJsonValidationState = { seen: new Set<object>(), nodes: 0, keys: 0 };

  const visit = (candidate: unknown, depth: number): DurableJsonValue => {
    if (depth > limits.maxDepth) throw new AidenOperationContractError("internal_error");
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) throw new AidenOperationContractError("internal_error");
    if (candidate === null) return null;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      assertDurableString(candidate, limits.maxStringLength);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new AidenOperationContractError("internal_error");
      }
      return candidate;
    }
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate)) {
      throw new AidenOperationContractError("internal_error");
    }
    if (state.seen.has(candidate)) throw new AidenOperationContractError("internal_error");
    state.seen.add(candidate);

    if (Array.isArray(candidate)) {
      if (candidate.length > limits.maxArrayLength) throw new AidenOperationContractError("internal_error");
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      const length = lengthDescriptor?.value;
      if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !isDenseArrayIndexKey(key, length as number)),
        ) || Object.getPrototypeOf(candidate) !== Array.prototype
      ) {
        throw new AidenOperationContractError("internal_error");
      }
      if (
        !lengthDescriptor ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        lengthDescriptor.enumerable ||
        !("value" in lengthDescriptor) ||
        "get" in lengthDescriptor ||
        "set" in lengthDescriptor
      ) {
        throw new AidenOperationContractError("internal_error");
      }
      const result: DurableJsonValue[] = [];
      result.length = length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !("value" in descriptor) ||
          "get" in descriptor ||
          "set" in descriptor
        ) {
          throw new AidenOperationContractError("internal_error");
        }
        result[index] = visit(descriptor.value, depth + 1);
      }
      return result;
    }

    if (Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new AidenOperationContractError("internal_error");
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const result: { [key: string]: DurableJsonValue } = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new AidenOperationContractError("internal_error");
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        "get" in descriptor ||
        "set" in descriptor
      ) {
        throw new AidenOperationContractError("internal_error");
      }
      assertDurableString(key, limits.maxStringLength);
      state.keys += 1;
      if (state.keys > limits.maxKeys) throw new AidenOperationContractError("internal_error");
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };

  try {
    return visit(value, 0);
  } catch (error) {
    if (error instanceof AidenOperationContractError) throw error;
    throw new AidenOperationContractError("internal_error");
  }
}

function durableJsonUtf8Bytes(value: DurableJsonValue): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AidenOperationContractError("internal_error");
  }
  if (typeof serialized !== "string") throw new AidenOperationContractError("internal_error");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_DURABLE_JSON_RESULT_BYTES) throw new AidenOperationContractError("internal_error");
  return bytes;
}

function cloneDurableResult(value: unknown): DurableJsonValue {
  const clone = cloneDurableJson(value);
  durableJsonUtf8Bytes(clone);
  return clone;
}

function serializedSnapshotBytes(snapshot: AidenIdempotencySnapshot): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new AidenOperationContractError("internal_error");
  }
  if (typeof serialized !== "string") throw new AidenOperationContractError("internal_error");
  return Buffer.byteLength(serialized, "utf8");
}

const operationContractErrorCodes = new Set<AidenOperationContractErrorCode>([
  "idempotency_conflict",
  "idempotency_capacity",
  "idempotency_in_flight",
  "revision_conflict",
  "capability_denied",
  "internal_error",
]);

function assertSnapshotString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AidenOperationContractError("internal_error");
  }
  assertDurableString(value, MAX_DURABLE_JSON_STRING_LENGTH);
}

function assertFiniteTimestamp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AidenOperationContractError("internal_error");
  }
}

function assertSnapshotErrorCode(value: unknown): asserts value is AidenOperationContractErrorCode | undefined {
  if (value !== undefined && (typeof value !== "string" || !operationContractErrorCodes.has(value as AidenOperationContractErrorCode))) {
    throw new AidenOperationContractError("internal_error");
  }
}

function assertSnapshotEntry(value: unknown): asserts value is AidenIdempotencySnapshotEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AidenOperationContractError("internal_error");
  }
  cloneDurableJson(value);
  const entry = value as Partial<AidenIdempotencySnapshotEntry>;
  const state = entry.state;
  const expectedKeys = state === "in_flight"
    ? ["scopeDigest", "requestDigest", "operationId", "state", "createdAt", "expiresAt"]
    : state === "fulfilled"
      ? ["scopeDigest", "requestDigest", "operationId", "state", "result", "createdAt", "expiresAt"]
      : state === "rejected"
        ? ["scopeDigest", "requestDigest", "operationId", "state", "errorCode", "createdAt", "expiresAt"]
        : [];
  if (expectedKeys.length === 0) throw new AidenOperationContractError("internal_error");
  assertExactOwnEnumerableDataKeys(value, expectedKeys);
  const hasResult = Object.prototype.hasOwnProperty.call(entry, "result");
  const hasErrorCode = Object.prototype.hasOwnProperty.call(entry, "errorCode");
  assertSnapshotString(entry.scopeDigest);
  assertSnapshotString(entry.requestDigest);
  assertOperationId(entry.operationId);
  if (entry.state !== "in_flight" && entry.state !== "fulfilled" && entry.state !== "rejected") {
    throw new AidenOperationContractError("internal_error");
  }
  assertFiniteTimestamp(entry.createdAt);
  if (entry.expiresAt !== null) assertFiniteTimestamp(entry.expiresAt);
  if (entry.state === "in_flight") {
    if (entry.expiresAt !== null || hasResult || hasErrorCode) {
      throw new AidenOperationContractError("internal_error");
    }
    return;
  }
  if (typeof entry.expiresAt !== "number" || entry.createdAt > entry.expiresAt) {
    throw new AidenOperationContractError("internal_error");
  }
  if (entry.state === "fulfilled") {
    // Undefined is not a durable result: JSON.stringify omits it, so an
    // explicitly undefined result would become indistinguishable from a
    // missing result after restart.
    if (!hasResult || entry.result === undefined || hasErrorCode) {
      throw new AidenOperationContractError("internal_error");
    }
    cloneDurableResult(entry.result);
    return;
  }
  if (!hasErrorCode || hasResult) {
    throw new AidenOperationContractError("internal_error");
  }
  assertSnapshotErrorCode(entry.errorCode);
  if (entry.errorCode === undefined) {
    throw new AidenOperationContractError("internal_error");
  }
}

function assertSnapshot(value: unknown): asserts value is AidenIdempotencySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AidenOperationContractError("internal_error");
  }
  cloneDurableJson(value, DURABLE_SNAPSHOT_JSON_LIMITS);
  assertExactOwnEnumerableDataKeys(value, ["version", "lastObservedAt", "entries"]);
  const snapshot = value as Partial<AidenIdempotencySnapshot>;
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length > MAX_DURABLE_OPERATION_ENTRIES
  ) {
    throw new AidenOperationContractError("internal_error");
  }
  assertFiniteTimestamp(snapshot.lastObservedAt);
  for (const entry of snapshot.entries) assertSnapshotEntry(entry);
  if (serializedSnapshotBytes(snapshot as AidenIdempotencySnapshot) > MAX_DURABLE_LEDGER_SNAPSHOT_BYTES) {
    throw new AidenOperationContractError("internal_error");
  }
}

export class AidenIdempotencyLedger {
  private readonly entries = new Map<string, AidenIdempotencyEntry>();
  private lastObservedAt: number;
  private clockRollbackDetected = false;

  constructor(
    snapshot: AidenIdempotencySnapshotInput = undefined,
    private readonly options: {
      maxEntries?: number;
      ttlMs?: number;
      now?: () => number;
      maxSnapshotBytes?: number;
    } = {},
  ) {
    const now = this.readWallClock();
    // Do not accept the pre-envelope array shape here. A legacy array has no
    // persisted lastObservedAt value, so restoring it could reopen a key after
    // a forward clock jump followed by a rollback. Fresh initialization is
    // represented by an omitted/undefined snapshot instead.
    const restoredSnapshot = snapshot === undefined ? undefined : (assertSnapshot(snapshot), snapshot);
    if (
      restoredSnapshot &&
      serializedSnapshotBytes(restoredSnapshot) > this.maxSnapshotBytes
    ) {
      throw new AidenOperationContractError("internal_error");
    }
    this.lastObservedAt = restoredSnapshot?.lastObservedAt ?? now;
    if (now < this.lastObservedAt) this.clockRollbackDetected = true;
    else this.lastObservedAt = now;
    const snapshotEntries: readonly AidenIdempotencySnapshotEntry[] = restoredSnapshot?.entries ?? [];
    const retained: AidenIdempotencySnapshotEntry[] = [];
    for (const candidate of snapshotEntries) {
      // In-flight work has no local expiration. A clock rollback or a writer
      // whose clock is ahead must never turn an unresolved operation into a
      // fresh execution opportunity.
      if (
        candidate.state === "in_flight"
        || this.clockRollbackDetected
        || (typeof candidate.expiresAt === "number" && candidate.expiresAt > now)
      ) retained.push(candidate);
    }
    if (retained.length > this.maxEntries) {
      throw new AidenOperationContractError("idempotency_capacity");
    }
    for (const entry of retained) {
      const settled = entry.state !== "in_flight";
      const result = entry.state === "fulfilled" ? cloneDurableResult(entry.result) : undefined;
      const restoredOperationId = entry.operationId;
      assertOperationId(restoredOperationId);
      if ([...this.entries.values()].some((existing) => existing.operationId === restoredOperationId)) {
        throw new AidenOperationContractError("idempotency_conflict");
      }
      if (this.entries.has(entry.scopeDigest)) {
        throw new AidenOperationContractError("idempotency_conflict");
      }
      this.entries.set(entry.scopeDigest, {
        requestDigest: entry.requestDigest,
        operationId: restoredOperationId,
        result: entry.state === "fulfilled" ? Promise.resolve().then(() => cloneDurableResult(result)) : undefined,
        createdAt: entry.createdAt,
        expiresAt: settled ? entry.expiresAt : null,
        settled,
        settledResult: entry.state === "fulfilled" ? result : undefined,
        rejectionCode: entry.state === "rejected" ? entry.errorCode ?? "internal_error" : undefined,
      });
    }
    this.assertSnapshotBudget(this.buildSnapshot());
  }

  private get maxEntries(): number {
    return boundedPositiveIntegerOption(
      this.options.maxEntries,
      MAX_DURABLE_OPERATION_ENTRIES,
      MAX_DURABLE_OPERATION_ENTRIES,
    );
  }

  private get maxSnapshotBytes(): number {
    return boundedPositiveIntegerOption(
      this.options.maxSnapshotBytes,
      MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
      MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
    );
  }

  private get ttlMs(): number {
    return Math.max(1, this.options.ttlMs ?? 24 * 60 * 60 * 1_000);
  }

  private now(): number {
    const now = this.readWallClock();
    if (now < this.lastObservedAt) this.clockRollbackDetected = true;
    else if (now > this.lastObservedAt) {
      this.lastObservedAt = now;
      this.clockRollbackDetected = false;
    }
    return now;
  }

  private readWallClock(): number {
    const now = this.options.now?.() ?? Date.now();
    assertFiniteTimestamp(now);
    return now;
  }

  private effectiveNow(now: number): number {
    return Math.max(now, this.lastObservedAt);
  }

  private prune(now: number): void {
    if (this.clockRollbackDetected) return;
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private snapshotEntry(scopeDigest: string, entry: AidenIdempotencyEntry): AidenIdempotencySnapshotEntry {
    return {
      scopeDigest,
      requestDigest: entry.requestDigest,
      operationId: entry.operationId,
      state: !entry.settled
        ? "in_flight"
        : entry.rejectionCode
          ? "rejected"
          : "fulfilled",
      ...(entry.rejectionCode
        ? { errorCode: entry.rejectionCode }
        : entry.settled
          ? { result: cloneDurableResult(entry.settledResult) }
          : {}),
      createdAt: entry.createdAt,
      expiresAt: entry.settled ? entry.expiresAt : null,
    };
  }

  private buildSnapshot(candidate?: { scopeDigest: string; entry: AidenIdempotencyEntry }): AidenIdempotencySnapshot {
    let candidateIncluded = false;
    const entries = [...this.entries].map(([scopeDigest, entry]) => {
      if (candidate && scopeDigest === candidate.scopeDigest) {
        candidateIncluded = true;
        return this.snapshotEntry(scopeDigest, candidate.entry);
      }
      return this.snapshotEntry(scopeDigest, entry);
    });
    if (candidate && !candidateIncluded) {
      entries.push(this.snapshotEntry(candidate.scopeDigest, candidate.entry));
    }
    return {
      version: 1,
      lastObservedAt: this.lastObservedAt,
      entries,
    };
  }

  private assertSnapshotBudget(snapshot: AidenIdempotencySnapshot): void {
    if (serializedSnapshotBytes(snapshot) > this.maxSnapshotBytes) {
      throw new AidenOperationContractError("internal_error");
    }
  }

  private assertPersistableSnapshot(snapshot: AidenIdempotencySnapshot): void {
    assertSnapshot(snapshot);
    this.assertSnapshotBudget(snapshot);
  }

  private retainUnknownOutcome(entry: AidenIdempotencyEntry): void {
    entry.result = undefined;
    entry.settledResult = undefined;
    entry.rejectionCode = undefined;
    entry.settled = false;
    entry.expiresAt = null;
  }

  private rejectionCode(error: unknown): AidenOperationContractErrorCode {
    try {
      if (error instanceof AidenOperationContractError) {
        const code = error.code;
        if (operationContractErrorCodes.has(code)) return code;
      }
    } catch {
      // Hostile or malformed error objects never gain durable code authority.
    }
    return "internal_error";
  }

  private settleRejected(
    scopeDigest: string,
    entry: AidenIdempotencyEntry,
    error: unknown,
  ): boolean {
    if (entry.settled) return true;
    const rejectedEntry: AidenIdempotencyEntry = {
      ...entry,
      result: undefined,
      settledResult: undefined,
      rejectionCode: this.rejectionCode(error),
      settled: true,
      expiresAt: this.effectiveNow(this.now()) + this.ttlMs,
    };
    try {
      this.assertPersistableSnapshot(
        this.buildSnapshot({ scopeDigest, entry: rejectedEntry }),
      );
    } catch {
      this.retainUnknownOutcome(entry);
      return false;
    }
    entry.result = undefined;
    entry.settledResult = undefined;
    entry.rejectionCode = rejectedEntry.rejectionCode;
    entry.settled = true;
    entry.expiresAt = rejectedEntry.expiresAt;
    return true;
  }

  private admit(): void {
    if (this.entries.size < this.maxEntries) return;
    throw new AidenOperationContractError("idempotency_capacity");
  }

  execute<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
    reference?: AidenIdempotencyOperationReference,
  ): Promise<T> {
    const now = this.now();
    this.prune(now);
    const ledgerKey = createHash("sha256").update(canonical(scope)).digest("base64url");
    const requestDigest = createHash("sha256").update(canonical(input)).digest("base64url");
    const existing = this.entries.get(ledgerKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new AidenOperationContractError("idempotency_conflict");
      if (existing.rejectionCode) throw new AidenOperationContractError(existing.rejectionCode);
      if (!existing.result) throw new AidenOperationContractError("idempotency_in_flight");
      if (existing.settled) {
        return Promise.resolve().then(() => cloneDurableResult(existing.settledResult)) as Promise<T>;
      }
      return existing.result as Promise<T>;
    }
    if (this.clockRollbackDetected) throw new AidenOperationContractError("idempotency_in_flight");
    this.admit();
    const restoredOperationId = reference?.operationId ?? operationId();
    assertOperationId(restoredOperationId);
    if ([...this.entries.values()].some((entry) => entry.operationId === restoredOperationId)) {
      throw new AidenOperationContractError("idempotency_conflict");
    }
    const entry: AidenIdempotencyEntry = {
      requestDigest,
      operationId: restoredOperationId,
      createdAt: this.effectiveNow(now),
      expiresAt: null,
      settled: false,
    };
    this.assertSnapshotBudget(this.buildSnapshot({ scopeDigest: ledgerKey, entry }));
    this.entries.set(ledgerKey, entry);
    const result = Promise.resolve()
      .then(action)
      .then(
        (value) => {
          let durableValue: DurableJsonValue;
          let settledAt: number;
          try {
            durableValue = cloneDurableResult(value);
            settledAt = this.effectiveNow(this.now()) + this.ttlMs;
            const settledEntry: AidenIdempotencyEntry = {
              ...entry,
              expiresAt: settledAt,
              settled: true,
              settledResult: durableValue,
              rejectionCode: undefined,
            };
            this.assertPersistableSnapshot(
              this.buildSnapshot({ scopeDigest: ledgerKey, entry: settledEntry }),
            );
          } catch (error) {
            // The action may already have committed an external mutation. If
            // its result cannot be durably represented, retain the stable
            // operation reference as an indefinite unknown outcome. Expiring
            // it into a retry would risk executing the mutation twice.
            this.retainUnknownOutcome(entry);
            throw error instanceof AidenOperationContractError
              ? error
              : new AidenOperationContractError("internal_error");
          }
          entry.settledResult = durableValue;
          entry.settled = true;
          entry.expiresAt = settledAt;
          entry.rejectionCode = undefined;
          // Keep the stored value isolated from callers that mutate a result
          // after fulfillment. The snapshot owns its separate durable clone.
          return cloneDurableResult(durableValue);
        },
        (error) => {
          if (error instanceof AidenOperationUnknownOutcomeError) {
            this.retainUnknownOutcome(entry);
            throw new AidenOperationContractError("idempotency_in_flight");
          }
          this.settleRejected(ledgerKey, entry, error);
          throw error;
        },
      );
    entry.result = result;
    return result as Promise<T>;
  }

  reconcile<T>(operationIdToFinalize: string, outcome: AidenIdempotencyOutcome<T>): void {
    assertOperationId(operationIdToFinalize);
    this.prune(this.now());
    const entryRecord = [...this.entries].find(([, candidate]) => candidate.operationId === operationIdToFinalize);
    if (!entryRecord) throw new AidenOperationContractError("idempotency_in_flight");
    const [ledgerKey, entry] = entryRecord;
    if (entry.settled) {
      const durableOutcomeResult = outcome.state === "fulfilled" ? cloneDurableResult(outcome.result) : undefined;
      if (outcome.state === "rejected") assertSnapshotErrorCode(outcome.errorCode);
      const sameOutcome = outcome.state === "fulfilled"
        ? !entry.rejectionCode && canonical(entry.settledResult) === canonical(durableOutcomeResult)
        : entry.rejectionCode === outcome.errorCode;
      if (!sameOutcome) throw new AidenOperationContractError("idempotency_conflict");
      return;
    }
    if (entry.result) throw new AidenOperationContractError("idempotency_in_flight");
    if (outcome.state === "fulfilled") {
      let durableResult: DurableJsonValue;
      let settledAt: number;
      try {
        durableResult = cloneDurableResult(outcome.result);
        settledAt = this.effectiveNow(this.now()) + this.ttlMs;
        const settledEntry: AidenIdempotencyEntry = {
          ...entry,
          expiresAt: settledAt,
          settled: true,
          settledResult: durableResult,
          rejectionCode: undefined,
        };
        this.assertPersistableSnapshot(
          this.buildSnapshot({ scopeDigest: ledgerKey, entry: settledEntry }),
        );
      } catch (error) {
        this.retainUnknownOutcome(entry);
        throw error instanceof AidenOperationContractError
          ? error
          : new AidenOperationContractError("internal_error");
      }
      entry.settledResult = durableResult;
      entry.result = Promise.resolve().then(() => cloneDurableResult(entry.settledResult));
      entry.rejectionCode = undefined;
      entry.settled = true;
      entry.expiresAt = settledAt;
    } else {
      assertSnapshotErrorCode(outcome.errorCode);
      if (outcome.errorCode === undefined) {
        throw new AidenOperationContractError("internal_error");
      }
      if (!this.settleRejected(
        ledgerKey,
        entry,
        new AidenOperationContractError(outcome.errorCode),
      )) {
        throw new AidenOperationContractError("internal_error");
      }
    }
  }

  finalize<T>(operationIdToFinalize: string, outcome: AidenIdempotencyOutcome<T>): void {
    this.reconcile(operationIdToFinalize, outcome);
  }

  snapshot(): AidenIdempotencySnapshot {
    this.prune(this.now());
    const snapshot = this.buildSnapshot();
    this.assertSnapshotBudget(snapshot);
    return snapshot;
  }

  sizeForTesting(): number {
    this.prune(this.now());
    return this.entries.size;
  }
}

export function assertRevision(expected: string, current: string): void {
  if (expected !== current) throw new AidenOperationContractError("revision_conflict");
}

export class AidenDurableOperationRegistry {
  private readonly owners = new Map<string, string>();

  constructor(entries: readonly { operationId: string; deviceId: string }[] = []) {
    assertDurableOperationEntries(entries);
    for (const entry of entries) {
      if (this.owners.has(entry.operationId)) {
        throw new AidenOperationContractError("internal_error");
      }
      this.owners.set(entry.operationId, entry.deviceId);
    }
  }

  start(operationId: string, deviceId: string): void {
    assertOperationId(operationId);
    assertOperationId(deviceId);
    const existing = this.owners.get(operationId);
    if (existing && existing !== deviceId) throw new AidenOperationContractError("capability_denied");
    if (existing) return;
    if (this.owners.size >= MAX_DURABLE_OPERATION_ENTRIES) {
      throw new AidenOperationContractError("idempotency_capacity");
    }
    this.owners.set(operationId, deviceId);
  }

  complete(operationId: string, deviceId: string): void {
    assertOperationId(operationId);
    assertOperationId(deviceId);
    if (this.owners.get(operationId) !== deviceId) {
      throw new AidenOperationContractError("capability_denied");
    }
    this.owners.delete(operationId);
  }

  remove(operationId: string, deviceId: string): void {
    this.complete(operationId, deviceId);
  }

  assertOwner(operationId: string, deviceId: string): void {
    assertOperationId(operationId);
    assertOperationId(deviceId);
    if (this.owners.get(operationId) !== deviceId) {
      throw new AidenOperationContractError("capability_denied");
    }
  }

  snapshot(): { operationId: string; deviceId: string }[] {
    return [...this.owners].map(([operationId, deviceId]) => ({ operationId, deviceId }));
  }
}

function assertDurableOperationEntries(
  value: unknown,
): asserts value is readonly { operationId: string; deviceId: string }[] {
  try {
    if (
      !Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_DURABLE_OPERATION_ENTRIES
    ) {
      throw new AidenOperationContractError("internal_error");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      lengthDescriptor.enumerable ||
      !("value" in lengthDescriptor) ||
      "get" in lengthDescriptor ||
      "set" in lengthDescriptor ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !isDenseArrayIndexKey(key, value.length)),
      )
    ) {
      throw new AidenOperationContractError("internal_error");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        "get" in descriptor ||
        "set" in descriptor
      ) {
        throw new AidenOperationContractError("internal_error");
      }
      assertDurableOperationEntry(descriptor.value);
    }
  } catch (error) {
    if (error instanceof AidenOperationContractError) throw error;
    throw new AidenOperationContractError("internal_error");
  }
}

function assertDurableOperationEntry(value: unknown): asserts value is { operationId: string; deviceId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new AidenOperationContractError("internal_error");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    !keys.every((key) => key === "operationId" || key === "deviceId")
  ) {
    throw new AidenOperationContractError("internal_error");
  }
  for (const key of ["operationId", "deviceId"] as const) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      throw new AidenOperationContractError("internal_error");
    }
    assertOperationId(descriptor.value);
  }
}

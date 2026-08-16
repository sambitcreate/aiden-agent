import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { PiRuntimeReplayPolicy } from "./pi-runtime-tool.js";

export type { PiRuntimeReplayPolicy } from "./pi-runtime-tool.js";

export const MAX_PI_RUNTIME_OPERATIONS = 256;
export const MAX_PI_RUNTIME_EFFECTS = 2_048;
export const MAX_PI_RUNTIME_SAFE_ARGUMENT_BYTES = 64 * 1024;
export const MAX_PI_RUNTIME_JSON_NODES = 8_192;
export const MAX_PI_RUNTIME_JSON_DEPTH = 32;

const DIGEST = /^[a-f0-9]{64}$/u;

export type PiRuntimeJson =
  | null
  | boolean
  | number
  | string
  | PiRuntimeJson[]
  | { [key: string]: PiRuntimeJson };

export type DurablePiRuntimeOperationState =
  | "running"
  | "completed"
  | "app_cancelled"
  | "provider_failed"
  | "host_failed"
  | "interrupted";

export type DurablePiRuntimeEffectState =
  | "prepared"
  | "dispatch_started"
  | "completed"
  | "remote_error"
  | "cancelled_before_dispatch"
  | "unknown"
  | "interrupted";

export interface DurablePiRuntimeOperation {
  version: 1;
  operationId: string;
  runId: string;
  sessionId: string;
  chatId: string;
  lane: "foreground" | "child";
  contributionRevision: number;
  state: DurablePiRuntimeOperationState;
  startedAt: number;
  updatedAt: number;
}

export interface DurablePiRuntimeEffect {
  version: 1;
  effectId: string;
  operationId: string;
  runId: string;
  sessionId: string;
  chatId: string;
  lane: "foreground" | "child";
  turnId: string;
  toolCallId: string;
  toolName: string;
  replay: PiRuntimeReplayPolicy;
  state: DurablePiRuntimeEffectState;
  argumentDigest: string;
  /** Exact bounded arguments exist only for explicitly replay-safe tools. */
  arguments?: PiRuntimeJson;
  preparedAt: number;
  updatedAt: number;
  terminalDigest?: string;
}

export interface DurablePiRuntimeEffectOwner {
  effectId: string;
  operationId: string;
  runId: string;
  chatId: string;
}

export interface StartPiRuntimeOperationInput {
  operationId: string;
  runId: string;
  sessionId: string;
  chatId: string;
  lane: "foreground" | "child";
  contributionRevision: number;
}

export interface PreparePiRuntimeEffectInput extends StartPiRuntimeOperationInput {
  effectId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  replay?: PiRuntimeReplayPolicy;
  arguments: unknown;
}

export interface FinishPiRuntimeEffectInput extends DurablePiRuntimeEffectOwner {
  state: "completed" | "remote_error" | "unknown" | "interrupted";
  terminalDigest: string;
}

export interface DurablePiRuntimeEffectDatabase {
  version: 1;
  revision: number;
  operations: DurablePiRuntimeOperation[];
  effects: DurablePiRuntimeEffect[];
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return undefined;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    keys.length <= required.length + optional.length &&
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

export function isSafePiRuntimeIdentity(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function operationState(value: unknown): value is DurablePiRuntimeOperationState {
  return (
    value === "running" ||
    value === "completed" ||
    value === "app_cancelled" ||
    value === "provider_failed" ||
    value === "host_failed" ||
    value === "interrupted"
  );
}

function effectState(value: unknown): value is DurablePiRuntimeEffectState {
  return (
    value === "prepared" ||
    value === "dispatch_started" ||
    value === "completed" ||
    value === "remote_error" ||
    value === "cancelled_before_dispatch" ||
    value === "unknown" ||
    value === "interrupted"
  );
}

export function isPiRuntimeOperationTerminal(state: DurablePiRuntimeOperationState): boolean {
  return state !== "running";
}

export function isPiRuntimeEffectTerminal(state: DurablePiRuntimeEffectState): boolean {
  return state !== "prepared" && state !== "dispatch_started";
}

function snapshotJson(
  value: unknown,
  state: { nodes: number; seen: Set<object> },
  depth = 0,
): PiRuntimeJson {
  if (depth > MAX_PI_RUNTIME_JSON_DEPTH) {
    throw new Error("Pi runtime effect arguments are too deeply nested.");
  }
  state.nodes += 1;
  if (state.nodes > MAX_PI_RUNTIME_JSON_NODES) {
    throw new Error("Pi runtime effect arguments contain too many values.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Pi runtime effect arguments are not JSON-safe.");
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new Error("Pi runtime effect arguments are not plain JSON.");
  }
  if (state.seen.has(value)) throw new Error("Pi runtime effect arguments are cyclic.");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).some(
          (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        throw new Error("Pi runtime effect arguments contain an invalid array.");
      }
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error("Pi runtime effect arguments contain an invalid array.");
      }
      return Array.from({ length }, (_item, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new Error("Pi runtime effect arguments contain a sparse or accessor array.");
        }
        return snapshotJson(descriptor.value, state, depth + 1);
      });
    }
    const record = plainRecord(value);
    if (!record) throw new Error("Pi runtime effect arguments are not a plain object.");
    const result: Record<string, PiRuntimeJson> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = snapshotJson(record[key], state, depth + 1);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

export function snapshotPiRuntimeEffectArguments(value: unknown): {
  value: PiRuntimeJson;
  canonical: string;
  digest: string;
} {
  const snapshot = snapshotJson(value, { nodes: 0, seen: new Set() });
  const canonical = JSON.stringify(snapshot);
  if (Buffer.byteLength(canonical, "utf8") > MAX_PI_RUNTIME_SAFE_ARGUMENT_BYTES) {
    throw new Error("Pi runtime effect arguments exceed the durable replay limit.");
  }
  return {
    value: snapshot,
    canonical,
    digest: createHash("sha256")
      .update("aiden-pi-runtime-effect-arguments-v1\0", "utf8")
      .update(canonical, "utf8")
      .digest("hex"),
  };
}

export function piRuntimeTerminalDigest(label: string): string {
  return createHash("sha256")
    .update("aiden-pi-runtime-effect-terminal-v1\0", "utf8")
    .update(label, "utf8")
    .digest("hex");
}

export function parseStartPiRuntimeOperationInput(
  value: unknown,
): StartPiRuntimeOperationInput | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "operationId",
      "runId",
      "sessionId",
      "chatId",
      "lane",
      "contributionRevision",
    ]) ||
    ![record.operationId, record.runId, record.sessionId, record.chatId].every(
      isSafePiRuntimeIdentity,
    ) ||
    (record.lane !== "foreground" && record.lane !== "child") ||
    !nonnegativeInteger(record.contributionRevision)
  ) {
    return undefined;
  }
  return structuredClone(record) as unknown as StartPiRuntimeOperationInput;
}

export function parseDurablePiRuntimeEffectOwner(
  value: unknown,
): DurablePiRuntimeEffectOwner | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["effectId", "operationId", "runId", "chatId"]) ||
    ![record.effectId, record.operationId, record.runId, record.chatId].every(
      isSafePiRuntimeIdentity,
    )
  ) {
    return undefined;
  }
  return structuredClone(record) as unknown as DurablePiRuntimeEffectOwner;
}

export function parseDurablePiRuntimeOperation(
  value: unknown,
): DurablePiRuntimeOperation | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, [
      "version",
      "operationId",
      "runId",
      "sessionId",
      "chatId",
      "lane",
      "contributionRevision",
      "state",
      "startedAt",
      "updatedAt",
    ]) ||
    record.version !== 1 ||
    ![record.operationId, record.runId, record.sessionId, record.chatId].every(
      isSafePiRuntimeIdentity,
    ) ||
    (record.lane !== "foreground" && record.lane !== "child") ||
    !nonnegativeInteger(record.contributionRevision) ||
    !operationState(record.state) ||
    !timestamp(record.startedAt) ||
    !timestamp(record.updatedAt) ||
    record.updatedAt < record.startedAt
  ) {
    return undefined;
  }
  return structuredClone(record) as unknown as DurablePiRuntimeOperation;
}

export function parseDurablePiRuntimeEffect(value: unknown): DurablePiRuntimeEffect | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(
      record,
      [
        "version",
        "effectId",
        "operationId",
        "runId",
        "sessionId",
        "chatId",
        "lane",
        "turnId",
        "toolCallId",
        "toolName",
        "replay",
        "state",
        "argumentDigest",
        "preparedAt",
        "updatedAt",
      ],
      ["arguments", "terminalDigest"],
    ) ||
    record.version !== 1 ||
    ![
      record.effectId,
      record.operationId,
      record.runId,
      record.sessionId,
      record.chatId,
      record.turnId,
      record.toolCallId,
      record.toolName,
    ].every(isSafePiRuntimeIdentity) ||
    (record.lane !== "foreground" && record.lane !== "child") ||
    (record.replay !== "safe" && record.replay !== "never") ||
    !effectState(record.state) ||
    !digest(record.argumentDigest) ||
    !timestamp(record.preparedAt) ||
    !timestamp(record.updatedAt) ||
    record.updatedAt < record.preparedAt
  ) {
    return undefined;
  }
  const terminal = isPiRuntimeEffectTerminal(record.state);
  if (
    (terminal && !digest(record.terminalDigest)) ||
    (!terminal && record.terminalDigest !== undefined) ||
    (record.replay === "never" && record.arguments !== undefined) ||
    (record.replay === "safe" && record.arguments === undefined)
  ) {
    return undefined;
  }
  if (record.replay === "safe") {
    try {
      const snapshot = snapshotPiRuntimeEffectArguments(record.arguments);
      if (snapshot.digest !== record.argumentDigest) return undefined;
      record.arguments = snapshot.value;
    } catch {
      return undefined;
    }
  }
  return structuredClone(record) as unknown as DurablePiRuntimeEffect;
}

export function parseDurablePiRuntimeEffectDatabase(
  value: unknown,
): DurablePiRuntimeEffectDatabase | undefined {
  const record = plainRecord(value);
  if (
    !record ||
    !exactKeys(record, ["version", "revision", "operations", "effects"]) ||
    record.version !== 1 ||
    !nonnegativeInteger(record.revision) ||
    !Array.isArray(record.operations) ||
    !Array.isArray(record.effects) ||
    record.operations.length > MAX_PI_RUNTIME_OPERATIONS ||
    record.effects.length > MAX_PI_RUNTIME_EFFECTS
  ) {
    return undefined;
  }
  const operations = record.operations.map(parseDurablePiRuntimeOperation);
  const effects = record.effects.map(parseDurablePiRuntimeEffect);
  if (operations.some((operation) => !operation) || effects.some((effect) => !effect)) {
    return undefined;
  }
  const parsedOperations = operations as DurablePiRuntimeOperation[];
  const parsedEffects = effects as DurablePiRuntimeEffect[];
  const operationIds = new Set(parsedOperations.map(({ operationId }) => operationId));
  const effectIds = new Set(parsedEffects.map(({ effectId }) => effectId));
  if (operationIds.size !== parsedOperations.length || effectIds.size !== parsedEffects.length) {
    return undefined;
  }
  const operationsById = new Map(
    parsedOperations.map((operation) => [operation.operationId, operation]),
  );
  const toolCalls = new Set<string>();
  for (const effect of parsedEffects) {
    const operation = operationsById.get(effect.operationId);
    if (
      !operation ||
      operation.runId !== effect.runId ||
      operation.sessionId !== effect.sessionId ||
      operation.chatId !== effect.chatId ||
      operation.lane !== effect.lane
    ) {
      return undefined;
    }
    const toolCallKey = `${effect.operationId}\0${effect.toolCallId}`;
    if (toolCalls.has(toolCallKey)) return undefined;
    toolCalls.add(toolCallKey);
  }
  return {
    version: 1,
    revision: record.revision as number,
    operations: parsedOperations,
    effects: parsedEffects,
  };
}

export function emptyPiRuntimeEffectDatabase(): DurablePiRuntimeEffectDatabase {
  return { version: 1, revision: 0, operations: [], effects: [] };
}

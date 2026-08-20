import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type {
  CoordinatorAttemptResult,
  CoordinatorClock,
  CoordinatorNodeExecutionContext,
  CoordinatorRetrySafety,
} from "./scheduler-core.js";

export const MOCK_IMAGE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MOCK_IMAGE_MAX_DIMENSION = 1_024;
export const MOCK_IMAGE_MAX_PIXELS = 1_048_576;
const MOCK_MAX_SCRIPTED_NODES = 500;
const MOCK_MAX_ATTEMPTS_PER_NODE = 6;
const MOCK_MAX_DELAY_MS = 5 * 60_000;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,191}$/u;
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface MockImageOutput {
  bytes: Uint8Array;
  metadata: {
    source: "deterministic-local-mock";
    seed: number;
    mimeType: "image/png";
    width: number;
    height: number;
    byteLength: number;
  };
}

export interface MockImageOutputBatch {
  images: readonly MockImageOutput[];
  metadata: {
    source: "deterministic-local-mock";
    count: 1 | 2 | 3 | 4;
    totalByteLength: number;
  };
}

export type MockProviderOutcome =
  | "success"
  | "failure"
  | "rate-limit"
  | "crash-before-send"
  | "accepted-before-response"
  | "crash-after-send"
  /** @deprecated Use an explicit crash boundary. This aliases crash-after-send. */
  | "crash"
  | "ambiguous-submit";

export interface MockProviderAttemptScript {
  outcome: MockProviderOutcome;
  delayMs?: number;
  error?: string;
  retrySafety?: CoordinatorRetrySafety;
  retryAfterMs?: number;
  idempotencyKey?: string;
  remoteJobId?: string;
  /** Whether the provider returned an accepted, durable job ID to Aiden. */
  durableRemoteJob?: boolean;
  /** Strict ceiling for the generated PNG, not padding or claimed media length. */
  outputByteLimit?: number;
  width?: number;
  height?: number;
  seed?: number;
  duplicateSubmittedEvent?: boolean;
  outOfOrderCompletionEvent?: boolean;
  lateCompletionAfterCancel?: boolean;
}

export interface MockImageProviderScript {
  nodes: Readonly<Record<string, readonly MockProviderAttemptScript[]>>;
}

export type MockProviderEventKind =
  "submitted" | "progress" | "completed" | "failed" | "cancelled";

export interface MockProviderEvent {
  runId: string;
  nodeId: string;
  remoteJobId: string;
  attempt: number;
  sequence: number;
  kind: MockProviderEventKind;
  output?: MockImageOutputBatch;
  error?: string;
}

export interface MockProviderEventCursor {
  runId: string;
  nodeId: string;
  remoteJobId: string;
  attempt: number;
  lastSequence: number;
  terminal: boolean;
}

export type MockProviderEventRejectionReason =
  "wrong-job" | "duplicate-or-stale" | "out-of-order" | "late-after-terminal";

export type MockProviderEventReduction =
  | { accepted: true; cursor: MockProviderEventCursor }
  | {
      accepted: false;
      cursor: MockProviderEventCursor;
      reason: MockProviderEventRejectionReason;
    };

export function reduceMockProviderEvent(
  cursor: MockProviderEventCursor,
  event: MockProviderEvent,
): MockProviderEventReduction {
  if (
    cursor.runId !== event.runId ||
    cursor.nodeId !== event.nodeId ||
    cursor.remoteJobId !== event.remoteJobId ||
    cursor.attempt !== event.attempt
  ) {
    return { accepted: false, cursor, reason: "wrong-job" };
  }
  if (event.sequence <= cursor.lastSequence) {
    return { accepted: false, cursor, reason: "duplicate-or-stale" };
  }
  if (event.sequence !== cursor.lastSequence + 1) {
    return { accepted: false, cursor, reason: "out-of-order" };
  }
  if (cursor.terminal)
    return { accepted: false, cursor, reason: "late-after-terminal" };
  return {
    accepted: true,
    cursor: Object.freeze({
      ...cursor,
      lastSequence: event.sequence,
      terminal: ["completed", "failed", "cancelled"].includes(event.kind),
    }),
  };
}

export interface MockProviderEventAttemptIdentity {
  runId: string;
  nodeId: string;
  attempt: number;
}

interface MockProviderEventState {
  cursor: MockProviderEventCursor;
  terminalKind?: Extract<
    MockProviderEventKind,
    "completed" | "failed" | "cancelled"
  >;
  rejectionReasons: MockProviderEventRejectionReason[];
}

function eventAttemptKey(identity: MockProviderEventAttemptIdentity): string {
  return `${identity.runId}\0${identity.nodeId}\0${identity.attempt}`;
}

/** Product-facing reducer for mock provider notifications; provider callback order is never trusted. */
export class MockProviderEventCoordinator {
  readonly #states = new Map<string, MockProviderEventState>();

  observe(event: MockProviderEvent): MockProviderEventReduction {
    const key = eventAttemptKey(event);
    let state = this.#states.get(key);
    if (!state) {
      state = {
        cursor: {
          runId: event.runId,
          nodeId: event.nodeId,
          remoteJobId: event.remoteJobId,
          attempt: event.attempt,
          lastSequence: 0,
          terminal: false,
        },
        rejectionReasons: [],
      };
      this.#states.set(key, state);
    }
    const reduction = reduceMockProviderEvent(state.cursor, event);
    if (reduction.accepted) {
      state.cursor = reduction.cursor;
      if (["completed", "failed", "cancelled"].includes(event.kind)) {
        state.terminalKind =
          event.kind as MockProviderEventState["terminalKind"];
      }
    } else {
      state.rejectionReasons.push(reduction.reason);
    }
    return reduction;
  }

  acceptedTerminalKind(
    identity: MockProviderEventAttemptIdentity,
  ): MockProviderEventState["terminalKind"] {
    return this.#states.get(eventAttemptKey(identity))?.terminalKind;
  }

  rejectionReasons(
    identity: MockProviderEventAttemptIdentity,
  ): readonly string[] {
    return [
      ...(this.#states.get(eventAttemptKey(identity))?.rejectionReasons ?? []),
    ];
  }
}

export interface DeterministicMockImageProviderOptions {
  clock: CoordinatorClock;
  script: MockImageProviderScript;
  onProviderEvent?(event: MockProviderEvent): void;
}

export class MockProviderCrashError extends Error {
  readonly code = "MOCK_PROVIDER_CRASH";

  constructor(
    readonly nodeId: string,
    readonly attempt: number,
    readonly boundary: "accepted-before-response" | "after-send",
  ) {
    super(
      `The deterministic mock crashed at ${nodeId} attempt ${attempt} (${boundary}).`,
    );
    this.name = "MockProviderCrashError";
  }
}

function assertInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function validateAttempt(
  nodeId: string,
  attempt: MockProviderAttemptScript,
): void {
  const delayMs = attempt.delayMs ?? 0;
  assertInteger(delayMs, 0, MOCK_MAX_DELAY_MS, "Mock delay");
  if (
    attempt.error !== undefined &&
    (attempt.error.length === 0 || attempt.error.length > 1_000)
  ) {
    throw new Error("Mock errors must contain between 1 and 1000 characters.");
  }
  if (attempt.retryAfterMs !== undefined) {
    assertInteger(
      attempt.retryAfterMs,
      0,
      MOCK_MAX_DELAY_MS,
      "Mock retry-after delay",
    );
  }
  if (
    attempt.remoteJobId !== undefined &&
    !PROVIDER_JOB_ID_PATTERN.test(attempt.remoteJobId)
  ) {
    throw new Error(
      "Mock remote job ID must be a bounded provider identifier.",
    );
  }
  if (
    attempt.idempotencyKey !== undefined &&
    !IDEMPOTENCY_KEY_PATTERN.test(attempt.idempotencyKey)
  ) {
    throw new Error(
      "Mock idempotency key must match the run journal contract.",
    );
  }
  const durableRemoteJob =
    attempt.durableRemoteJob ??
    (attempt.remoteJobId !== undefined ||
      attempt.outcome === "success" ||
      attempt.outcome === "crash-after-send" ||
      attempt.outcome === "crash");
  if (attempt.remoteJobId !== undefined && durableRemoteJob !== true) {
    throw new Error("A scripted remote job ID must be marked durable.");
  }
  if (
    durableRemoteJob &&
    (attempt.outcome === "ambiguous-submit" ||
      attempt.outcome === "crash-before-send" ||
      attempt.outcome === "accepted-before-response" ||
      attempt.retrySafety === "confirmed-not-submitted")
  ) {
    throw new Error(
      "Ambiguous or confirmed-not-submitted outcomes cannot have a durable remote job.",
    );
  }
  if (
    (attempt.outcome === "crash-after-send" || attempt.outcome === "crash") &&
    !durableRemoteJob
  ) {
    throw new Error(
      "A crash-after-send outcome requires a durable remote job.",
    );
  }
  const byteLimit = attempt.outputByteLimit ?? MOCK_IMAGE_MAX_OUTPUT_BYTES;
  assertInteger(
    byteLimit,
    64,
    MOCK_IMAGE_MAX_OUTPUT_BYTES,
    "Mock output byte limit",
  );
  const width = attempt.width ?? 16;
  const height = attempt.height ?? 16;
  assertInteger(width, 1, MOCK_IMAGE_MAX_DIMENSION, "Mock output width");
  assertInteger(height, 1, MOCK_IMAGE_MAX_DIMENSION, "Mock output height");
  if (width * height > MOCK_IMAGE_MAX_PIXELS)
    throw new Error("Mock output exceeds the pixel limit.");
  const seed = attempt.seed ?? 1;
  assertInteger(seed, 0, 0xffff_ffff, "Mock seed");
  if (
    (attempt.outcome === "rate-limit" || attempt.outcome === "failure") &&
    attempt.retrySafety === "local-safe"
  ) {
    throw new Error(
      `Remote mock node "${nodeId}" cannot use local-safe retry classification.`,
    );
  }
}

function validateScript(
  script: MockImageProviderScript,
): MockImageProviderScript {
  const entries = Object.entries(script.nodes);
  if (entries.length > MOCK_MAX_SCRIPTED_NODES)
    throw new Error("The mock provider script has too many nodes.");
  const copy: Record<string, readonly MockProviderAttemptScript[]> =
    Object.create(null);
  for (const [nodeId, attempts] of entries) {
    if (!OPAQUE_ID_PATTERN.test(nodeId))
      throw new Error("Mock scripts require opaque node IDs.");
    if (
      !Array.isArray(attempts) ||
      attempts.length === 0 ||
      attempts.length > MOCK_MAX_ATTEMPTS_PER_NODE
    ) {
      throw new Error(
        `Mock node "${nodeId}" requires 1 through ${MOCK_MAX_ATTEMPTS_PER_NODE} attempts.`,
      );
    }
    copy[nodeId] = Object.freeze(
      attempts.map((attempt) => {
        validateAttempt(nodeId, attempt);
        return Object.freeze({ ...attempt });
      }),
    );
  }
  return Object.freeze({ nodes: Object.freeze(copy) });
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
});

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function pngChunk(
  type: "IHDR" | "IDAT" | "IEND",
  data: Uint8Array,
): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = concatenate([typeBytes, data]);
  let crc = 0xffff_ffff;
  for (const byte of crcInput)
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return concatenate([
    u32(data.byteLength),
    typeBytes,
    data,
    u32((crc ^ 0xffff_ffff) >>> 0),
  ]);
}

function deterministicPng(
  width: number,
  height: number,
  seed: number,
): Uint8Array {
  const rowBytes = width * 4 + 1;
  const raw = new Uint8Array(rowBytes * height);
  const red = seed & 0xff;
  const green = (seed >>> 8) & 0xff;
  const blue = (seed >>> 16) & 0xff;
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = (red + x) & 0xff;
      raw[pixel + 1] = (green + y) & 0xff;
      raw[pixel + 2] = (blue + x + y) & 0xff;
      raw[pixel + 3] = 0xff;
    }
  }
  const header = concatenate([
    u32(width),
    u32(height),
    Uint8Array.from([8, 6, 0, 0, 0]),
  ]);
  const compressed = new Uint8Array(deflateSync(raw, { level: 9 }));
  return concatenate([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function outputFrom(
  attempt: MockProviderAttemptScript,
  seed: number,
): MockImageOutput {
  const width = attempt.width ?? 16;
  const height = attempt.height ?? 16;
  const bytes = deterministicPng(width, height, seed);
  return Object.freeze({
    bytes,
    metadata: Object.freeze({
      source: "deterministic-local-mock" as const,
      seed,
      mimeType: "image/png" as const,
      width,
      height,
      byteLength: bytes.byteLength,
    }),
  });
}

function outputBatchFrom(
  attempt: MockProviderAttemptScript,
  count: 1 | 2 | 3 | 4,
): MockImageOutputBatch {
  const seed = attempt.seed ?? 1;
  const images = Object.freeze(
    Array.from({ length: count }, (_, index) =>
      outputFrom(attempt, (seed + index) >>> 0),
    ),
  );
  const totalByteLength = images.reduce(
    (total, image) => total + image.bytes.byteLength,
    0,
  );
  const byteLimit = attempt.outputByteLimit ?? MOCK_IMAGE_MAX_OUTPUT_BYTES;
  if (
    totalByteLength > byteLimit ||
    totalByteLength > MOCK_IMAGE_MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      "The deterministic PNG batch exceeds the configured mock output byte limit.",
    );
  }
  return Object.freeze({
    images,
    metadata: Object.freeze({
      source: "deterministic-local-mock" as const,
      count,
      totalByteLength,
    }),
  });
}

function derivedIdentifier(
  prefix: "mock-job" | "mock-idempotency",
  context: Pick<
    CoordinatorNodeExecutionContext,
    "runId" | "attempt" | "idempotencyKey"
  > & {
    node: Pick<CoordinatorNodeExecutionContext["node"], "id">;
  },
): string {
  const digest = createHash("sha256")
    .update(context.runId)
    .update("\0")
    .update(context.node.id)
    .update("\0")
    .update(context.idempotencyKey ?? String(context.attempt))
    .digest("hex");
  return `${prefix}-${digest}`;
}

export interface MockAcceptedJobReconciliationContext {
  runId: string;
  node: CoordinatorNodeExecutionContext["node"];
  attempt: number;
  idempotencyKey: string;
  remoteJobId: string;
}

export class DeterministicMockImageProvider {
  readonly providerId = "local-mock";
  readonly #clock: CoordinatorClock;
  readonly #script: MockImageProviderScript;
  readonly #onProviderEvent?: (event: MockProviderEvent) => void;

  constructor(options: DeterministicMockImageProviderOptions) {
    this.#clock = options.clock;
    this.#script = validateScript(options.script);
    this.#onProviderEvent = options.onProviderEvent;
  }

  reconcileAccepted(
    context: MockAcceptedJobReconciliationContext,
  ): CoordinatorAttemptResult {
    if (context.node.type !== "generate-image") {
      return {
        kind: "failure",
        error: "Only Generate Image mock jobs can be reconciled.",
        retrySafety: "never",
      };
    }
    const script = this.#script.nodes[context.node.id]?.[context.attempt - 1];
    if (!script) {
      return {
        kind: "ambiguous-submit",
        error:
          "The accepted mock job has no deterministic reconciliation outcome.",
      };
    }
    const expectedJobId =
      script.remoteJobId ?? derivedIdentifier("mock-job", context);
    if (context.remoteJobId !== expectedJobId) {
      return {
        kind: "ambiguous-submit",
        error:
          "The durable mock job ID does not match its deterministic reconciliation record.",
      };
    }
    const durableRemoteJob =
      script.durableRemoteJob ??
      (script.remoteJobId !== undefined ||
        script.outcome === "success" ||
        script.outcome === "crash-after-send" ||
        script.outcome === "crash");
    if (!durableRemoteJob) {
      return {
        kind: "ambiguous-submit",
        error: "The mock outcome does not prove a durable accepted job.",
      };
    }
    if (
      script.outcome === "success" ||
      script.outcome === "crash-after-send" ||
      script.outcome === "crash"
    ) {
      return {
        kind: "success",
        output: outputBatchFrom(script, context.node.data.count),
      };
    }
    if (script.outcome === "rate-limit") {
      return {
        kind: "rate-limited",
        error: script.error ?? "Mock rate limit.",
        retrySafety: "never",
      };
    }
    return {
      kind: "failure",
      error: script.error ?? "The accepted mock job failed.",
      retrySafety: "never",
    };
  }

  async execute(
    context: CoordinatorNodeExecutionContext,
  ): Promise<CoordinatorAttemptResult> {
    if (context.lane !== "remote" || context.node.type !== "generate-image") {
      return {
        kind: "failure",
        error:
          "The local image mock only executes remote Generate Image nodes.",
        retrySafety: "never",
      };
    }
    const attempts = this.#script.nodes[context.node.id];
    const script = attempts?.[context.attempt - 1];
    if (!script) {
      return {
        kind: "failure",
        error: `No deterministic mock outcome exists for attempt ${context.attempt}.`,
        retrySafety: "never",
      };
    }
    const remoteJobId =
      script.remoteJobId ?? derivedIdentifier("mock-job", context);
    const durableRemoteJob =
      script.durableRemoteJob ??
      (script.remoteJobId !== undefined ||
        script.outcome === "success" ||
        script.outcome === "crash-after-send" ||
        script.outcome === "crash");
    if (script.outcome === "crash-before-send") {
      return {
        kind: "failure",
        error: script.error ?? "Mock crashed before submission.",
        retrySafety: "confirmed-not-submitted",
      };
    }
    if (durableRemoteJob) await context.recordRemoteJobId(remoteJobId);
    let providerSequence = 1;
    const emit = (
      event: Omit<
        MockProviderEvent,
        "runId" | "nodeId" | "remoteJobId" | "attempt"
      >,
    ): void => {
      this.#onProviderEvent?.({
        runId: context.runId,
        nodeId: context.node.id,
        remoteJobId,
        attempt: context.attempt,
        ...event,
      });
    };
    emit({ kind: "submitted", sequence: providerSequence });
    if (script.duplicateSubmittedEvent)
      emit({ kind: "submitted", sequence: providerSequence });

    if (script.outcome === "accepted-before-response") {
      throw new MockProviderCrashError(
        context.node.id,
        context.attempt,
        "accepted-before-response",
      );
    }

    try {
      await this.#clock.sleep(script.delayMs ?? 0, context.signal);
    } catch (error) {
      if (!context.signal.aborted) throw error;
      providerSequence += 1;
      emit({
        kind: "cancelled",
        sequence: providerSequence,
        error: "Mock execution was cancelled.",
      });
      if (script.lateCompletionAfterCancel) {
        providerSequence += 1;
        emit({
          kind: "completed",
          sequence: providerSequence,
          output: outputBatchFrom(script, context.node.data.count),
        });
      }
      return { kind: "cancelled", error: "Mock execution was cancelled." };
    }

    if (script.outcome === "crash" || script.outcome === "crash-after-send") {
      throw new MockProviderCrashError(
        context.node.id,
        context.attempt,
        "after-send",
      );
    }
    if (script.outcome === "ambiguous-submit") {
      return {
        kind: "ambiguous-submit",
        error: script.error ?? "Mock submission outcome is ambiguous.",
      };
    }
    if (script.outcome === "rate-limit") {
      providerSequence += 1;
      emit({
        kind: "failed",
        sequence: providerSequence,
        error: script.error ?? "Mock rate limit.",
      });
      return {
        kind: "rate-limited",
        error: script.error ?? "Mock rate limit.",
        retrySafety: script.retrySafety ?? "confirmed-not-submitted",
        ...(script.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: script.retryAfterMs }),
        ...(script.retrySafety === "same-idempotency-key"
          ? {
              idempotencyKey:
                script.idempotencyKey ??
                context.idempotencyKey ??
                derivedIdentifier("mock-idempotency", context),
            }
          : script.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: script.idempotencyKey }),
      };
    }
    if (script.outcome === "failure") {
      providerSequence += 1;
      emit({
        kind: "failed",
        sequence: providerSequence,
        error: script.error ?? "Mock provider failure.",
      });
      return {
        kind: "failure",
        error: script.error ?? "Mock provider failure.",
        retrySafety: script.retrySafety ?? "never",
        ...(script.retrySafety === "same-idempotency-key"
          ? {
              idempotencyKey:
                script.idempotencyKey ??
                context.idempotencyKey ??
                derivedIdentifier("mock-idempotency", context),
            }
          : script.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: script.idempotencyKey }),
      };
    }
    const output = outputBatchFrom(script, context.node.data.count);
    if (script.outOfOrderCompletionEvent) {
      emit({ kind: "completed", sequence: providerSequence + 2, output });
      providerSequence += 1;
      emit({ kind: "progress", sequence: providerSequence });
    } else {
      providerSequence += 1;
      emit({ kind: "completed", sequence: providerSequence, output });
    }
    return { kind: "success", output };
  }
}

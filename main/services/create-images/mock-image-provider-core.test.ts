import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateImageBytes } from "./asset-image-validation-core.js";
import {
  DeterministicMockImageProvider,
  MOCK_IMAGE_MAX_OUTPUT_BYTES,
  MockProviderEventCoordinator,
  MockProviderCrashError,
  reduceMockProviderEvent,
  type MockImageOutputBatch,
  type MockProviderEvent,
} from "./mock-image-provider-core.js";
import type {
  CoordinatorClock,
  CoordinatorNodeExecutionContext,
} from "./scheduler-core.js";

class ImmediateClock implements CoordinatorClock {
  readonly delays: number[] = [];

  now(): number {
    return 1;
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    this.delays.push(delayMs);
    if (signal.aborted) throw signal.reason ?? new Error("cancelled");
  }
}

function context(
  overrides: Partial<CoordinatorNodeExecutionContext> = {},
): CoordinatorNodeExecutionContext {
  return {
    workflowId: "workflow-1",
    workflowRevision: 1,
    runId: "run-1",
    node: {
      id: "generate-1",
      type: "generate-image",
      position: { x: 0, y: 0 },
      data: {
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "1:1",
        imageSize: "1K",
        outputMime: "image/png",
        count: 1,
      },
    },
    lane: "remote",
    attempt: 1,
    signal: new AbortController().signal,
    dependencyOutputs: new Map(),
    async recordRemoteJobId() {},
    ...overrides,
  };
}

function successfulOutput(
  result: Awaited<ReturnType<DeterministicMockImageProvider["execute"]>>,
): MockImageOutputBatch {
  assert.equal(result.kind, "success");
  if (result.kind !== "success") throw new Error("Expected mock success.");
  return result.output as MockImageOutputBatch;
}

test("mock success is deterministic, bounded, static-PNG-valid, and asset-ingest-compatible", async () => {
  const clock = new ImmediateClock();
  const script = {
    nodes: {
      "generate-1": [
        {
          outcome: "success" as const,
          delayMs: 25,
          width: 37,
          height: 19,
          seed: 0x1234_5678,
          outputByteLimit: 64 * 1024,
        },
      ],
    },
  };
  const first = successfulOutput(
    await new DeterministicMockImageProvider({ clock, script }).execute(
      context(),
    ),
  );
  const second = successfulOutput(
    await new DeterministicMockImageProvider({ clock, script }).execute(
      context(),
    ),
  );
  assert.deepEqual(first, second);
  assert.equal(first.images.length, 1);
  const image = first.images[0]!;
  assert.equal(image.metadata.byteLength, image.bytes.byteLength);
  assert.equal(first.metadata.totalByteLength, image.bytes.byteLength);
  assert.ok(image.bytes.byteLength > 64);
  assert.ok(image.bytes.byteLength <= 64 * 1024);
  assert.ok(image.bytes.byteLength <= MOCK_IMAGE_MAX_OUTPUT_BYTES);
  assert.deepEqual(
    validateImageBytes(image.bytes, "image/png", "mock.png", {
      maxWidth: 1_024,
      maxHeight: 1_024,
      maxPixels: 1_048_576,
    }),
    {
      mediaType: "image/png",
      extension: "png",
      width: 37,
      height: 19,
      pixels: 703,
    },
  );
  assert.deepEqual(clock.delays, [25, 25]);
  const serializedMetadata = JSON.stringify({
    batch: first.metadata,
    image: image.metadata,
  });
  assert.doesNotMatch(serializedMetadata, /(?:file:|https?:|path|url)/iu);
});

test("mock returns exactly the requested count as distinct valid PNGs under one aggregate bound", async () => {
  const base = context();
  assert.equal(base.node.type, "generate-image");
  if (base.node.type !== "generate-image") return;
  const batch = successfulOutput(
    await new DeterministicMockImageProvider({
      clock: new ImmediateClock(),
      script: {
        nodes: {
          "generate-1": [
            {
              outcome: "success",
              width: 24,
              height: 24,
              seed: 99,
              outputByteLimit: 128 * 1024,
            },
          ],
        },
      },
    }).execute({
      ...base,
      node: { ...base.node, data: { ...base.node.data, count: 4 } },
    }),
  );
  assert.equal(batch.images.length, 4);
  assert.equal(batch.metadata.count, 4);
  assert.equal(
    batch.metadata.totalByteLength,
    batch.images.reduce((total, image) => total + image.bytes.byteLength, 0),
  );
  assert.ok(batch.metadata.totalByteLength <= 128 * 1024);
  const digests = batch.images.map((image) => {
    assert.deepEqual(
      validateImageBytes(image.bytes, "image/png", "mock.png", {
        maxWidth: 1_024,
        maxHeight: 1_024,
        maxPixels: 1_048_576,
      }),
      {
        mediaType: "image/png",
        extension: "png",
        width: 24,
        height: 24,
        pixels: 576,
      },
    );
    return createHash("sha256").update(image.bytes).digest("hex");
  });
  assert.equal(new Set(digests).size, 4);
});

test("mock exposes deterministic failure, rate limit, ambiguity, and exact crash boundaries", async () => {
  const clock = new ImmediateClock();
  const provider = new DeterministicMockImageProvider({
    clock,
    script: {
      nodes: {
        "generate-1": [
          { outcome: "failure", error: "refused", retrySafety: "never" },
          {
            outcome: "rate-limit",
            error: "limited",
            retrySafety: "same-idempotency-key",
            retryAfterMs: 321,
            idempotencyKey: "idempotency-key-1",
            durableRemoteJob: true,
          },
          { outcome: "ambiguous-submit", error: "unknown acceptance" },
          { outcome: "crash-before-send", error: "before send" },
          { outcome: "accepted-before-response" },
          { outcome: "crash-after-send" },
        ],
      },
    },
  });
  const recordedAttempts: number[] = [];
  const executionContext = (attempt: number) =>
    context({
      attempt,
      recordRemoteJobId: async () => {
        recordedAttempts.push(attempt);
      },
    });
  assert.deepEqual(await provider.execute(executionContext(1)), {
    kind: "failure",
    error: "refused",
    retrySafety: "never",
  });
  assert.deepEqual(await provider.execute(executionContext(2)), {
    kind: "rate-limited",
    error: "limited",
    retrySafety: "same-idempotency-key",
    retryAfterMs: 321,
    idempotencyKey: "idempotency-key-1",
  });
  assert.deepEqual(await provider.execute(executionContext(3)), {
    kind: "ambiguous-submit",
    error: "unknown acceptance",
  });
  assert.deepEqual(await provider.execute(executionContext(4)), {
    kind: "failure",
    error: "before send",
    retrySafety: "confirmed-not-submitted",
  });
  await assert.rejects(
    provider.execute(executionContext(5)),
    (error: unknown) => {
      return (
        error instanceof MockProviderCrashError &&
        error.boundary === "accepted-before-response"
      );
    },
  );
  await assert.rejects(
    provider.execute(executionContext(6)),
    (error: unknown) => {
      return (
        error instanceof MockProviderCrashError &&
        error.boundary === "after-send"
      );
    },
  );
  assert.deepEqual(recordedAttempts, [2, 6]);
});

test("mock event stream can deterministically duplicate and reorder provider notifications", async () => {
  const events: MockProviderEvent[] = [];
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            duplicateSubmittedEvent: true,
            outOfOrderCompletionEvent: true,
          },
        ],
      },
    },
    onProviderEvent: (event) => events.push(event),
  });
  await provider.execute(context());
  assert.deepEqual(
    events.map((event) => [event.kind, event.sequence]),
    [
      ["submitted", 1],
      ["submitted", 1],
      ["completed", 3],
      ["progress", 2],
    ],
  );
  let cursor = {
    runId: "run-1",
    nodeId: "generate-1",
    remoteJobId: events[0]!.remoteJobId,
    attempt: 1,
    lastSequence: 0,
    terminal: false,
  };
  const reasons: string[] = [];
  for (const event of events) {
    const reduced = reduceMockProviderEvent(cursor, event);
    if (reduced.accepted) cursor = reduced.cursor;
    else reasons.push(reduced.reason);
  }
  assert.deepEqual(reasons, ["duplicate-or-stale", "out-of-order"]);
  assert.equal(cursor.lastSequence, 2);
  assert.equal(cursor.terminal, false);
});

test("product event coordinator accepts only ordered provider terminal notifications", async () => {
  const coordinator = new MockProviderEventCoordinator();
  const events: MockProviderEvent[] = [];
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "success",
            duplicateSubmittedEvent: true,
            outOfOrderCompletionEvent: true,
          },
        ],
      },
    },
    onProviderEvent: (event) => {
      events.push(event);
      coordinator.observe(event);
    },
  });
  await provider.execute(context());
  const identity = { runId: "run-1", nodeId: "generate-1", attempt: 1 };
  assert.equal(coordinator.acceptedTerminalKind(identity), undefined);
  assert.deepEqual(coordinator.rejectionReasons(identity), [
    "duplicate-or-stale",
    "out-of-order",
  ]);
  coordinator.observe({
    ...events[events.length - 1]!,
    kind: "completed",
    sequence: 3,
  });
  assert.equal(coordinator.acceptedTerminalKind(identity), "completed");
});

test("accepted mock jobs reconcile deterministically without a second submission", async () => {
  const submitted: MockProviderEvent[] = [];
  const recorded: string[] = [];
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        "generate-1": [
          { outcome: "crash-after-send", width: 8, height: 8, seed: 91 },
        ],
      },
    },
    onProviderEvent: (event) => submitted.push(event),
  });
  const executionContext = context({
    idempotencyKey:
      "aiden-ci-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    recordRemoteJobId: async (remoteJobId) => {
      recorded.push(remoteJobId);
    },
  });
  await assert.rejects(
    provider.execute(executionContext),
    MockProviderCrashError,
  );
  assert.equal(recorded.length, 1);
  const reconciled = provider.reconcileAccepted({
    runId: executionContext.runId,
    node: executionContext.node,
    attempt: executionContext.attempt,
    idempotencyKey: executionContext.idempotencyKey!,
    remoteJobId: recorded[0]!,
  });
  assert.equal(reconciled.kind, "success");
  assert.deepEqual(
    submitted.map((event) => event.kind),
    ["submitted"],
  );
});

test("late mock completion after cancellation is emitted but rejected by the event reducer", async () => {
  const events: MockProviderEvent[] = [];
  const controller = new AbortController();
  controller.abort(new Error("cancel now"));
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        "generate-1": [{ outcome: "success", lateCompletionAfterCancel: true }],
      },
    },
    onProviderEvent: (event) => events.push(event),
  });
  const result = await provider.execute(context({ signal: controller.signal }));
  assert.equal(result.kind, "cancelled");
  assert.deepEqual(
    events.map((event) => [event.kind, event.sequence]),
    [
      ["submitted", 1],
      ["cancelled", 2],
      ["completed", 3],
    ],
  );
  let cursor = {
    runId: "run-1",
    nodeId: "generate-1",
    remoteJobId: events[0]!.remoteJobId,
    attempt: 1,
    lastSequence: 0,
    terminal: false,
  };
  const first = reduceMockProviderEvent(cursor, events[0]!);
  assert.equal(first.accepted, true);
  if (first.accepted) cursor = first.cursor;
  const cancelled = reduceMockProviderEvent(cursor, events[1]!);
  assert.equal(cancelled.accepted, true);
  if (cancelled.accepted) cursor = cancelled.cursor;
  const late = reduceMockProviderEvent(cursor, events[2]!);
  assert.equal(late.accepted, false);
  if (!late.accepted) assert.equal(late.reason, "late-after-terminal");
});

test("mock validates script size, output dimensions, output byte ceilings, and identifiers", () => {
  assert.throws(
    () =>
      new DeterministicMockImageProvider({
        clock: new ImmediateClock(),
        script: {
          nodes: { "generate-1": [{ outcome: "success", width: 1_025 }] },
        },
      }),
    /width/u,
  );
  assert.throws(
    () =>
      new DeterministicMockImageProvider({
        clock: new ImmediateClock(),
        script: { nodes: { "bad/id": [{ outcome: "success" }] } },
      }),
    /opaque node IDs/u,
  );
  assert.throws(
    () =>
      new DeterministicMockImageProvider({
        clock: new ImmediateClock(),
        script: {
          nodes: {
            "generate-1": [{ outcome: "success", outputByteLimit: 63 }],
          },
        },
      }),
    /byte limit/u,
  );
});

test("max-length node IDs derive bounded journal-compatible provider and idempotency IDs", async () => {
  const nodeId = `n${"x".repeat(127)}`;
  const recordedJobIds: string[] = [];
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        [nodeId]: [
          {
            outcome: "rate-limit",
            retrySafety: "same-idempotency-key",
            durableRemoteJob: true,
          },
        ],
      },
    },
  });
  const base = context();
  const result = await provider.execute({
    ...base,
    node: { ...base.node, id: nodeId },
    recordRemoteJobId: async (remoteJobId) => {
      recordedJobIds.push(remoteJobId);
    },
  });
  assert.equal(recordedJobIds.length, 1);
  assert.match(recordedJobIds[0]!, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
  assert.ok(recordedJobIds[0]!.length <= 256);
  assert.equal(result.kind, "rate-limited");
  if (result.kind !== "rate-limited") return;
  assert.match(
    result.idempotencyKey ?? "",
    /^[A-Za-z0-9][A-Za-z0-9._:-]{15,191}$/u,
  );
  assert.ok((result.idempotencyKey?.length ?? 0) <= 192);
});

test("same idempotency key derives the same mock job across retry attempts", async () => {
  const recorded: string[] = [];
  const provider = new DeterministicMockImageProvider({
    clock: new ImmediateClock(),
    script: {
      nodes: {
        "generate-1": [
          {
            outcome: "failure",
            retrySafety: "same-idempotency-key",
            durableRemoteJob: true,
          },
          { outcome: "success" },
        ],
      },
    },
  });
  const stableKey =
    "aiden-ci-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  for (const attempt of [1, 2]) {
    await provider.execute(
      context({
        attempt,
        idempotencyKey: stableKey,
        recordRemoteJobId: async (remoteJobId) => {
          recorded.push(remoteJobId);
        },
      }),
    );
  }
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0], recorded[1]);
});

test("ambiguous and confirmed-not-submitted outcomes never record a durable provider job", async () => {
  for (const attemptScript of [
    { outcome: "ambiguous-submit" as const },
    {
      outcome: "rate-limit" as const,
      retrySafety: "confirmed-not-submitted" as const,
    },
  ]) {
    let durableJobs = 0;
    const provider = new DeterministicMockImageProvider({
      clock: new ImmediateClock(),
      script: { nodes: { "generate-1": [attemptScript] } },
    });
    await provider.execute(
      context({
        recordRemoteJobId: async () => {
          durableJobs += 1;
        },
      }),
    );
    assert.equal(durableJobs, 0);
  }
});

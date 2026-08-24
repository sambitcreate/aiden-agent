import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AidenDurableOperationRegistry,
  AidenIdempotencyLedger,
  AidenOperationContractError,
  AidenOperationUnknownOutcomeError,
  assertRevision,
  MAX_DURABLE_JSON_ARRAY_LENGTH,
  MAX_DURABLE_JSON_DEPTH,
  MAX_DURABLE_JSON_KEYS,
  MAX_DURABLE_JSON_NODES,
  MAX_DURABLE_JSON_RESULT_BYTES,
  MAX_DURABLE_JSON_STRING_LENGTH,
  MAX_DURABLE_LEDGER_SNAPSHOT_BYTES,
  MAX_DURABLE_OPERATION_ENTRIES,
  type AidenIdempotencySnapshotEntry,
} from "./aiden-remote-operation-contract.js";
import { parseAidenRemoteContractFixture } from "./aiden-remote-protocol.js";

function fixtureRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

async function readBotContractFixture(): Promise<Record<string, unknown>> {
  const serialized = await readFile(
    path.resolve(process.cwd(), "protocol/aiden-remote/v1/fixtures/contract.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(serialized);
  return fixtureRecord(parsed, "canonical Aiden Remote fixture must be an object");
}

function assertBotFixtureMutationFails(
  source: Record<string, unknown>,
  mutate: (fixture: Record<string, unknown>) => void,
  expected: RegExp,
): void {
  const candidate = structuredClone(source);
  mutate(candidate);
  assert.throws(() => parseAidenRemoteContractFixture(candidate), expected);
}

test("idempotency is scoped and replays the original result while rejecting key reuse", async () => {
  const ledger = new AidenIdempotencyLedger();
  const scope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-0123456789abcdef" };
  let calls = 0;
  const first = ledger.execute(scope, { branch: "main", nested: { a: 1, b: 2 } }, async () => ({ operationId: `op-${++calls}` }));
  const replay = ledger.execute(scope, { nested: { b: 2, a: 1 }, branch: "main" }, async () => ({ operationId: `op-${++calls}` }));
  assert.strictEqual(first, replay);
  assert.deepEqual(await replay, { operationId: "op-1" });
  assert.throws(() => ledger.execute(scope, { branch: "other" }, async () => ({})), (error) => error instanceof AidenOperationContractError && error.code === "idempotency_conflict");
  assert.equal(calls, 1);
});

test("an explicitly unknown external outcome remains in-flight indefinitely", async () => {
  let now = 1_000;
  const scope = {
    deviceId: "device-1",
    route: "/chats/chat-1/turns",
    resourceId: "chat-1",
    key: "unknown-turn-key-001",
  };
  const ledger = new AidenIdempotencyLedger(undefined, { now: () => now, ttlMs: 10 });
  await assert.rejects(
    ledger.execute(scope, { text: "hello" }, async () => {
      throw new AidenOperationUnknownOutcomeError();
    }),
    (error: unknown) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  assert.equal(ledger.snapshot().entries[0]?.state, "in_flight");
  now = 1_000_000;
  assert.throws(
    () => new AidenIdempotencyLedger(ledger.snapshot(), { now: () => now }).execute(
      scope,
      { text: "hello" },
      async () => ({ duplicated: true }),
    ),
    (error: unknown) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
});

test("idempotency snapshots survive restart without retaining raw keys and stay TTL/capacity bounded", async () => {
  let now = 1_000;
  const options = { maxEntries: 2, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/scheduled-tasks/task-1/run", resourceId: "task-1", key: "secret-idempotency-key" };
  const ledger = new AidenIdempotencyLedger(undefined, options);
  await ledger.execute(scope, { action: "run" }, async () => ({ runId: "run-1" }));
  const snapshot = ledger.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(scope.key), false);

  const restarted = new AidenIdempotencyLedger(snapshot, options);
  let replayCalls = 0;
  assert.deepEqual(
    await restarted.execute(scope, { action: "run" }, async () => ({ runId: `run-${++replayCalls + 1}` })),
    { runId: "run-1" },
  );
  assert.equal(replayCalls, 0);

  await restarted.execute({ ...scope, key: "key-2" }, { action: "run" }, async () => ({ runId: "run-2" }));
  assert.throws(
    () => restarted.execute({ ...scope, key: "key-3" }, { action: "run" }, async () => ({ runId: "run-3" })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );
  assert.equal(restarted.sizeForTesting(), 2);
  now = 1_101;
  assert.equal(restarted.sizeForTesting(), 0);
  assert.deepEqual(
    await restarted.execute({ ...scope, key: "key-3" }, { action: "run" }, async () => ({ runId: "run-3" })),
    { runId: "run-3" },
  );
});

test("fulfilled idempotency results replay exactly after a JSON snapshot round trip", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-json-round-trip" };
  const original = {
    operationId: "op-1",
    accepted: true,
    count: 3,
    nested: {
      message: "preserved",
      values: [null, false, 0, "text", { key: "value" }],
    },
  };
  const ledger = new AidenIdempotencyLedger(undefined, options);
  assert.deepEqual(await ledger.execute(scope, { action: "push" }, async () => original), original);

  const snapshot = ledger.snapshot();
  const persisted = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  assert.deepEqual(persisted, snapshot);

  const restarted = new AidenIdempotencyLedger(persisted, options);
  assert.deepEqual(
    await restarted.execute(scope, { action: "push" }, async () => ({ operationId: "must-not-run" })),
    original,
  );
  const replay = await restarted.execute(scope, { action: "push" }, async () => ({ operationId: "must-not-run" }));
  (replay as typeof original).nested.values[4] = { key: "caller-mutated" };
  assert.deepEqual(
    await restarted.execute(scope, { action: "push" }, async () => ({ operationId: "must-not-run" })),
    original,
  );
  assert.deepEqual(restarted.snapshot(), persisted);
  now = 1_001;
});

test("non-durable fulfilled results retain an unknown operation instead of becoming retryable", async () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const shared = { value: 1 };
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = "present";
  const extraArrayProperty = ["value"] as unknown[] & { extra?: unknown };
  extraArrayProperty.extra = "omitted";
  const hiddenProperty: Record<string, unknown> = { visible: true };
  Object.defineProperty(hiddenProperty, "hidden", { enumerable: false, value: true });
  const symbolKey = { visible: true };
  Object.defineProperty(symbolKey, Symbol("omitted"), { enumerable: true, value: true });
  class UnsupportedResult {
    value = 1;
  }
  const unsafeResults: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    1n,
    Symbol("unsupported"),
    () => "unsupported",
    { nested: undefined },
    { nested: Number.NaN },
    { nested: 1n },
    { nested: Symbol("unsupported") },
    accessor,
    cycle,
    new Date("2026-01-01T00:00:00.000Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    /unsupported/u,
    new UnsupportedResult(),
    Object.create(null),
    sparse,
    extraArrayProperty,
    hiddenProperty,
    symbolKey,
    { left: shared, right: shared },
    new Proxy({ value: 1 }, {}),
  ];

  for (const [index, value] of unsafeResults.entries()) {
    const ledger = new AidenIdempotencyLedger(undefined, { maxEntries: 1, now: () => 1_000 });
    const scope = {
      deviceId: "device-1",
      route: "/git/push",
      resourceId: "workspace-1",
      key: `key-unsafe-${index}`,
    };
    await assert.rejects(
      ledger.execute(scope, { action: "push" }, async () => value),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.entries[0]?.state, "in_flight");
    assert.equal("result" in (snapshot.entries[0] ?? {}), false);
    assert.throws(
      () => ledger.execute(scope, { action: "push" }, async () => "must-not-run"),
      (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
    );
  }
  assert.equal(getterCalls, 0);
});

test("durable replay results enforce depth, node, key, array, and string bounds", async () => {
  const deepResult: Record<string, unknown> = { leaf: true };
  for (let index = 0; index <= MAX_DURABLE_JSON_DEPTH; index += 1) {
    Object.assign(deepResult, { child: { ...deepResult } });
  }
  const nodeResult: unknown[] = [];
  const makeBinaryTree = (depth: number): unknown => {
    if (depth === 0) return true;
    return [makeBinaryTree(depth - 1), makeBinaryTree(depth - 1)];
  };
  nodeResult.push(makeBinaryTree(Math.ceil(Math.log2(MAX_DURABLE_JSON_NODES + 1))));
  const keyResult = Object.fromEntries(
    Array.from({ length: MAX_DURABLE_JSON_KEYS + 1 }, (_, index) => [`key-${index}`, true]),
  );
  const arrayResult = Array.from({ length: MAX_DURABLE_JSON_ARRAY_LENGTH + 1 }, () => true);
  const stringResult = "x".repeat(MAX_DURABLE_JSON_STRING_LENGTH + 1);
  const results: unknown[] = [deepResult, nodeResult, keyResult, arrayResult, stringResult];

  for (const [index, value] of results.entries()) {
    const ledger = new AidenIdempotencyLedger(undefined, { maxEntries: 1, now: () => 1_000 });
    const scope = {
      deviceId: "device-1",
      route: "/git/push",
      resourceId: "workspace-1",
      key: `key-bounded-result-${index}`,
    };
    await assert.rejects(
      ledger.execute(scope, { action: "push" }, async () => value),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
    assert.deepEqual(ledger.snapshot().entries.map(({ state, errorCode }) => ({ state, errorCode })), [
      { state: "in_flight", errorCode: undefined },
    ]);
  }
});

test("an oversized replay result stays unknown across TTL and restart until reconciled", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 10, now: () => now };
  const ledger = new AidenIdempotencyLedger(undefined, options);
  const scope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-10mb-result" };
  const oversized = "x".repeat(Math.max(10 * 1_048_576, MAX_DURABLE_JSON_RESULT_BYTES + 1));
  let calls = 0;
  await assert.rejects(
    ledger.execute(scope, { action: "push" }, async () => {
      calls += 1;
      return oversized;
    }, { operationId: "operation-oversized-result" }),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.entries[0]?.state, "in_flight");
  now = 2_000;
  const restarted = new AidenIdempotencyLedger(JSON.parse(JSON.stringify(snapshot)), options);
  assert.throws(
    () => restarted.execute(scope, { action: "push" }, async () => {
      calls += 1;
      return "must-not-run";
    }),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  assert.equal(calls, 1);
  assert.throws(
    () => restarted.reconcile("operation-oversized-result", {
      state: "fulfilled",
      result: oversized,
    }),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
  assert.equal(restarted.snapshot().entries[0]?.state, "in_flight");
  restarted.reconcile("operation-oversized-result", {
    state: "fulfilled",
    result: { operationId: "operation-oversized-result", state: "done" },
  });
  assert.deepEqual(
    await restarted.execute(scope, { action: "push" }, async () => "must-not-run"),
    { operationId: "operation-oversized-result", state: "done" },
  );
  assert.equal(calls, 1);
});

test("an aggregate snapshot overflow retains an unknown operation for reconciliation", async () => {
  let now = 1_000;
  const options = { maxEntries: 3, maxSnapshotBytes: 1_500, now: () => now };
  const firstScope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-aggregate-1" };
  const secondScope = { ...firstScope, key: "key-aggregate-2" };
  const result = "x".repeat(700);
  const ledger = new AidenIdempotencyLedger(undefined, options);
  assert.equal(await ledger.execute(firstScope, { action: "push" }, async () => result), result);
  await assert.rejects(
    ledger.execute(secondScope, { action: "push" }, async () => result),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.entries.map(({ state, errorCode }) => ({ state, errorCode })), [
    { state: "fulfilled", errorCode: undefined },
    { state: "in_flight", errorCode: undefined },
  ]);
  now = 1_001;
  const restarted = new AidenIdempotencyLedger(JSON.parse(JSON.stringify(snapshot)), options);
  assert.equal(await restarted.execute(firstScope, { action: "push" }, async () => "must-not-run"), result);
  assert.throws(
    () => restarted.execute(secondScope, { action: "push" }, async () => "must-not-run"),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
});

test("bounded replay snapshots survive an exact JSON round trip", async () => {
  assert.ok(MAX_DURABLE_LEDGER_SNAPSHOT_BYTES > MAX_DURABLE_JSON_RESULT_BYTES);
  const ledger = new AidenIdempotencyLedger(undefined, { maxEntries: 1, now: () => 1_000 });
  const scope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-bounded-round-trip" };
  const result = { unicode: "😀é", values: [null, false, 0, "text"], nested: { accepted: true } };
  assert.deepEqual(await ledger.execute(scope, { action: "push" }, async () => result), result);
  const snapshot = ledger.snapshot();
  const persisted = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(persisted, snapshot);
  const restarted = new AidenIdempotencyLedger(persisted, { maxEntries: 1, now: () => 1_000 });
  assert.deepEqual(await restarted.execute(scope, { action: "push" }, async () => ({ changed: true })), result);
});

test("persisted high-water time prevents a pruned key from reopening after clock rollback", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/scheduled-tasks/task-1/run", resourceId: "task-1", key: "key-clock-rollback" };
  let calls = 0;
  const ledger = new AidenIdempotencyLedger(undefined, options);

  assert.deepEqual(
    await ledger.execute(scope, { action: "run" }, async () => ({ runId: `run-${++calls}` })),
    { runId: "run-1" },
  );

  now = 1_101;
  const prunedSnapshot = ledger.snapshot();
  assert.deepEqual(prunedSnapshot.entries, []);
  assert.equal(prunedSnapshot.lastObservedAt, 1_101);
  const persistedSnapshot = JSON.parse(JSON.stringify(prunedSnapshot)) as typeof prunedSnapshot;

  now = 1_050;
  const restarted = new AidenIdempotencyLedger(persistedSnapshot, options);
  assert.equal(restarted.sizeForTesting(), 0);
  assert.throws(
    () => restarted.execute(scope, { action: "run" }, async () => ({ runId: `duplicate-${++calls}` })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  assert.equal(calls, 1);

  now = 1_101;
  assert.throws(
    () => restarted.execute(scope, { action: "run" }, async () => ({ runId: `duplicate-${++calls}` })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  now = 1_102;
  assert.deepEqual(
    await restarted.execute(scope, { action: "run" }, async () => ({ runId: `run-${++calls}` })),
    { runId: "run-2" },
  );
  assert.equal(calls, 2);
});

test("legacy array snapshots are rejected while an omitted snapshot remains fresh initialization", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/scheduled-tasks/task-1/run", resourceId: "task-1", key: "key-legacy-array" };
  const ledger = new AidenIdempotencyLedger(undefined, options);
  await ledger.execute(scope, { action: "run" }, async () => ({ runId: "run-1" }));

  now = 1_101;
  const legacyArray = ledger.snapshot().entries;
  assert.deepEqual(legacyArray, []);
  assert.throws(
    () => new AidenIdempotencyLedger(legacyArray as never, options),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );

  const fresh = new AidenIdempotencyLedger(undefined, options);
  assert.deepEqual(
    await fresh.execute(scope, { action: "run" }, async () => ({ runId: "fresh-run" })),
    { runId: "fresh-run" },
  );
});

test("rejected idempotent actions persist a bounded safe failure instead of remaining in flight", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/workspaces", resourceId: "registry", key: "key-rejected" };
  const ledger = new AidenIdempotencyLedger(undefined, options);
  await assert.rejects(
    ledger.execute(scope, { mode: "scratch" }, async () => { throw new AidenOperationContractError("revision_conflict"); }),
    (error) => error instanceof AidenOperationContractError && error.code === "revision_conflict",
  );
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.entries.map(({ state, errorCode }) => ({ state, errorCode })), [
    { state: "rejected", errorCode: "revision_conflict" },
  ]);
  const restarted = new AidenIdempotencyLedger(snapshot, options);
  assert.throws(
    () => restarted.execute(scope, { mode: "scratch" }, async () => ({ workspaceId: "duplicate" })),
    (error) => error instanceof AidenOperationContractError && error.code === "revision_conflict",
  );
  assert.throws(
    () => restarted.execute({ ...scope, key: "other-key" }, { mode: "scratch" }, async () => ({ workspaceId: "other" })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );
  now = 1_101;
  assert.deepEqual(
    await restarted.execute({ ...scope, key: "other-key" }, { mode: "scratch" }, async () => ({ workspaceId: "other" })),
    { workspaceId: "other" },
  );
});

test("a rejection that cannot fit the snapshot budget remains durably in flight", async () => {
  const scope = {
    deviceId: "device-1",
    route: "/workspaces",
    resourceId: "registry",
    key: "key-tight-rejection-budget",
  };
  const input = { mode: "scratch" };
  let releaseProbe: (() => void) | undefined;
  const probe = new AidenIdempotencyLedger(undefined, { maxEntries: 1, now: () => 1_000 });
  const pendingProbe = probe.execute(
    scope,
    input,
    () => new Promise<boolean>((resolve) => { releaseProbe = () => resolve(true); }),
    { operationId: "operation-tight-budget" },
  );
  await Promise.resolve();
  const inFlightBytes = Buffer.byteLength(JSON.stringify(probe.snapshot()), "utf8");
  releaseProbe?.();
  await pendingProbe;

  const ledger = new AidenIdempotencyLedger(undefined, {
    maxEntries: 1,
    maxSnapshotBytes: inFlightBytes,
    now: () => 1_000,
  });
  await assert.rejects(
    ledger.execute(
      scope,
      input,
      async () => { throw new AidenOperationContractError("revision_conflict"); },
      { operationId: "operation-tight-budget" },
    ),
    (error) => error instanceof AidenOperationContractError && error.code === "revision_conflict",
  );
  const snapshot = ledger.snapshot();
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot), "utf8"), inFlightBytes);
  assert.deepEqual(snapshot.entries.map(({ state, errorCode }) => ({ state, errorCode })), [
    { state: "in_flight", errorCode: undefined },
  ]);
  assert.throws(
    () => ledger.reconcile("operation-tight-budget", {
      state: "rejected",
      errorCode: "revision_conflict",
    }),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
  assert.equal(ledger.snapshot().entries[0]?.state, "in_flight");
  assert.throws(
    () => ledger.execute(scope, input, async () => "must-not-run"),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
});

test("invalid runtime error codes are canonicalized before durable rejection storage", async () => {
  const ledger = new AidenIdempotencyLedger(undefined, { maxEntries: 1, now: () => 1_000 });
  const scope = {
    deviceId: "device-1",
    route: "/workspaces",
    resourceId: "registry",
    key: "key-invalid-error-code",
  };
  const malformed = new AidenOperationContractError("internal_error");
  Object.defineProperty(malformed, "code", { value: "not_a_contract_code" });
  await assert.rejects(
    ledger.execute(scope, { mode: "scratch" }, async () => { throw malformed; }),
    (error) => error === malformed,
  );
  assert.deepEqual(ledger.snapshot().entries.map(({ state, errorCode }) => ({ state, errorCode })), [
    { state: "rejected", errorCode: "internal_error" },
  ]);
});

test("idempotency rejects overflow while every bounded entry is still in flight", async () => {
  let now = 1_000;
  const ledger = new AidenIdempotencyLedger(undefined, { maxEntries: 1, ttlMs: 10, now: () => now });
  let resolveFirst: ((value: string) => void) | undefined;
  const firstScope = { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-1" };
  const first = ledger.execute(
    firstScope,
    { branch: "main" },
    () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
  );
  await Promise.resolve();
  now = 1_100;
  assert.strictEqual(ledger.execute(firstScope, { branch: "main" }, async () => "duplicate"), first);
  const restarted = new AidenIdempotencyLedger(ledger.snapshot(), { maxEntries: 1, ttlMs: 10, now: () => now });
  assert.throws(
    () => restarted.execute(firstScope, { branch: "main" }, async () => "duplicate-after-restart"),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  assert.throws(
    () => restarted.execute(firstScope, { branch: "other" }, async () => "conflict-after-restart"),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_conflict",
  );
  assert.throws(
    () => ledger.execute(
      { deviceId: "device-1", route: "/git/push", resourceId: "workspace-1", key: "key-2" },
      { branch: "main" },
      async () => "second",
    ),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );
  resolveFirst?.("first");
  assert.equal(await first, "first");
  assert.equal(ledger.sizeForTesting(), 1);
  now = 1_111;
  assert.equal(ledger.sizeForTesting(), 0);
});

test("restarted in-flight entries retain a safe operation reference until authoritative reconciliation", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/scheduled-tasks/task-1/run", resourceId: "task-1", key: "raw-idempotency-secret" };
  let release: ((value: { runId: string }) => void) | undefined;
  const ledger = new AidenIdempotencyLedger(undefined, options);
  const pending = ledger.execute(
    scope,
    { action: "run" },
    () => new Promise<{ runId: string }>((resolve) => { release = resolve; }),
    { operationId: "op_run_authoritative_1" },
  );
  await Promise.resolve();
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.entries[0]?.operationId, "op_run_authoritative_1");
  assert.equal(snapshot.entries[0]?.expiresAt, null);
  assert.equal(JSON.stringify(snapshot).includes(scope.key), false);
  assert.throws(
    () => ledger.reconcile("op_run_authoritative_1", { state: "fulfilled", result: { runId: "must-not-race-live-promise" } }),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );

  now = 10_000;
  const restarted = new AidenIdempotencyLedger(snapshot, options);
  assert.equal(restarted.sizeForTesting(), 1);
  assert.throws(
    () => restarted.execute(scope, { action: "run" }, async () => ({ runId: "duplicate" })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  assert.throws(
    () => restarted.execute({ ...scope, key: "other-key" }, { action: "run" }, async () => ({ runId: "duplicate" })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );

  restarted.finalize("op_run_authoritative_1", { state: "fulfilled", result: { runId: "run-authoritative" } });
  assert.deepEqual(
    await restarted.execute(scope, { action: "run" }, async () => ({ runId: "duplicate-after-reconcile" })),
    { runId: "run-authoritative" },
  );
  assert.doesNotThrow(() => restarted.reconcile("op_run_authoritative_1", { state: "fulfilled", result: { runId: "run-authoritative" } }));
  assert.throws(
    () => restarted.reconcile("op_run_authoritative_1", { state: "fulfilled", result: { runId: "different" } }),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_conflict",
  );

  release?.({ runId: "run-original" });
  assert.deepEqual(await pending, { runId: "run-original" });
});

test("restarted in-flight entries survive a clock rollback when created in the future", async () => {
  let now = 1_000;
  const options = { maxEntries: 1, ttlMs: 100, now: () => now };
  const scope = { deviceId: "device-1", route: "/scheduled-tasks/task-1/run", resourceId: "task-1", key: "raw-idempotency-secret" };
  let release: ((value: { runId: string }) => void) | undefined;
  const ledger = new AidenIdempotencyLedger(undefined, options);
  const pending = ledger.execute(
    scope,
    { action: "run" },
    () => new Promise<{ runId: string }>((resolve) => { release = resolve; }),
    { operationId: "op_run_clock_rollback_1" },
  );
  await Promise.resolve();
  const snapshot = ledger.snapshot();

  now = 500;
  const restarted = new AidenIdempotencyLedger(snapshot, options);
  assert.equal(restarted.sizeForTesting(), 1);
  assert.throws(
    () => restarted.execute(scope, { action: "run" }, async () => ({ runId: "duplicate" })),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_in_flight",
  );
  restarted.reconcile("op_run_clock_rollback_1", { state: "fulfilled", result: { runId: "authoritative" } });
  assert.deepEqual(
    await restarted.execute(scope, { action: "run" }, async () => ({ runId: "duplicate-after-reconcile" })),
    { runId: "authoritative" },
  );

  release?.({ runId: "run-original" });
  assert.deepEqual(await pending, { runId: "run-original" });
});

test("restart rejects malformed timestamps instead of silently reopening idempotency scopes", () => {
  const common = { scopeDigest: "scope-1", requestDigest: "request-1", operationId: "op-1" };
  const snapshots: AidenIdempotencySnapshotEntry[] = [
    { ...common, state: "in_flight", createdAt: Number.NaN, expiresAt: null },
    { ...common, state: "in_flight", createdAt: Number.POSITIVE_INFINITY, expiresAt: null },
    { ...common, state: "fulfilled", createdAt: 2, expiresAt: Number.NaN, result: "result" },
    { ...common, state: "fulfilled", createdAt: 2, expiresAt: 1, result: "result" },
  ];
  for (const entry of snapshots) {
    assert.throws(
      () => new AidenIdempotencyLedger({ version: 1, lastObservedAt: 1, entries: [entry] }, { now: () => 1 }),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }

  const malformedSnapshots = [
    { version: 1, lastObservedAt: Number.NaN, entries: [] },
    { version: 1, lastObservedAt: 1, entries: {} },
    { version: 2, lastObservedAt: 1, entries: [] },
    { version: 1, lastObservedAt: 1, entries: [{ ...common, state: "invalid", createdAt: 1, expiresAt: null }] },
  ];
  for (const snapshot of malformedSnapshots) {
    assert.throws(
      () => new AidenIdempotencyLedger(snapshot as never, { now: () => 1 }),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }
});

test("restart rejects idempotency entries with state-incompatible or non-durable terminal fields", () => {
  const common = { scopeDigest: "scope-1", requestDigest: "request-1", operationId: "op-1", createdAt: 1, expiresAt: 2 };
  const malformedEntries = [
    { ...common, state: "fulfilled" as const },
    { ...common, state: "fulfilled" as const, result: undefined },
    { ...common, state: "fulfilled" as const, result: "result", errorCode: "internal_error" as const },
    { ...common, state: "rejected" as const },
    { ...common, state: "rejected" as const, errorCode: "internal_error" as const, result: "incompatible" },
    { ...common, state: "rejected" as const, errorCode: undefined },
    { ...common, state: "in_flight" as const, expiresAt: null, result: "incompatible" },
    { ...common, state: "in_flight" as const, expiresAt: null, errorCode: "internal_error" as const },
    { ...common, state: "in_flight" as const, expiresAt: 2 },
  ];
  for (const entry of malformedEntries) {
    assert.throws(
      () => new AidenIdempotencyLedger({ version: 1, lastObservedAt: 1, entries: [entry] }, { now: () => 1 }),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }

  const validResultValues = [null, false, 0, ""];
  for (const result of validResultValues) {
    assert.doesNotThrow(() => new AidenIdempotencyLedger({
      version: 1,
      lastObservedAt: 1,
      entries: [{ ...common, state: "fulfilled" as const, result }],
    }, { now: () => 1 }));
  }
});

test("restart enforces exact snapshot and state-specific entry allowlists", () => {
  const common = { scopeDigest: "scope-1", requestDigest: "request-1", operationId: "op-1", createdAt: 1, expiresAt: null };
  const validEntry = { ...common, state: "in_flight" as const };
  const snapshotFor = (entry: unknown): unknown => ({ version: 1, lastObservedAt: 1, entries: [entry] });
  let envelopeGetterCalls = 0;
  let entryGetterCalls = 0;

  const envelopeExtra = { version: 1, lastObservedAt: 1, entries: [], extra: true };
  const envelopeSymbol = { version: 1, lastObservedAt: 1, entries: [] };
  Object.defineProperty(envelopeSymbol, Symbol("extra"), { enumerable: true, value: true });
  const envelopeHidden = { version: 1, lastObservedAt: 1, entries: [] };
  Object.defineProperty(envelopeHidden, "extra", { enumerable: false, value: true });
  const envelopeAccessor = { version: 1, lastObservedAt: 1, entries: [] };
  Object.defineProperty(envelopeAccessor, "extra", {
    enumerable: true,
    get: () => {
      envelopeGetterCalls += 1;
      return true;
    },
  });

  const entryExtra = { ...validEntry, extra: true };
  const entrySymbol = { ...validEntry };
  Object.defineProperty(entrySymbol, Symbol("extra"), { enumerable: true, value: true });
  const entryHidden = { ...validEntry };
  Object.defineProperty(entryHidden, "extra", { enumerable: false, value: true });
  const entryAccessor = { ...validEntry };
  Object.defineProperty(entryAccessor, "extra", {
    enumerable: true,
    get: () => {
      entryGetterCalls += 1;
      return true;
    },
  });

  const malformedSnapshots = [
    envelopeExtra,
    envelopeSymbol,
    envelopeHidden,
    envelopeAccessor,
    snapshotFor(entryExtra),
    snapshotFor(entrySymbol),
    snapshotFor(entryHidden),
    snapshotFor(entryAccessor),
  ];
  for (const snapshot of malformedSnapshots) {
    assert.throws(
      () => new AidenIdempotencyLedger(snapshot as never, { now: () => 1 }),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }
  assert.equal(envelopeGetterCalls, 0);
  assert.equal(entryGetterCalls, 0);

  assert.doesNotThrow(() => new AidenIdempotencyLedger({
    version: 1,
    lastObservedAt: 1,
    entries: [{ ...common, state: "in_flight" as const }],
  }, { now: () => 1 }));
  assert.doesNotThrow(() => new AidenIdempotencyLedger({
    version: 1,
    lastObservedAt: 1,
    entries: [{ ...common, state: "fulfilled" as const, expiresAt: 2, result: null }],
  }, { now: () => 1 }));
  assert.doesNotThrow(() => new AidenIdempotencyLedger({
    version: 1,
    lastObservedAt: 1,
    entries: [{ ...common, state: "rejected" as const, expiresAt: 2, errorCode: "internal_error" as const }],
  }, { now: () => 1 }));
});

test("restart refuses to evict active idempotency entries when a snapshot exceeds capacity", () => {
  const snapshot = {
    version: 1 as const,
    lastObservedAt: 1_000,
    entries: [
      { scopeDigest: "scope-1", requestDigest: "request-1", operationId: "op-1", state: "in_flight" as const, createdAt: 1, expiresAt: null },
      { scopeDigest: "scope-2", requestDigest: "request-2", operationId: "op-2", state: "in_flight" as const, createdAt: 1, expiresAt: null },
    ],
  };
  assert.throws(
    () => new AidenIdempotencyLedger(snapshot, { maxEntries: 1, now: () => 1_000 }),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );
});

test("revision checks and durable operation ownership fail closed", () => {
  assert.doesNotThrow(() => assertRevision("revision-2", "revision-2"));
  assert.throws(() => assertRevision("revision-1", "revision-2"), (error) => error instanceof AidenOperationContractError && error.code === "revision_conflict");
  const operations = new AidenDurableOperationRegistry();
  operations.start("operation-1", "device-1");
  operations.start("operation-1", "device-1");
  assert.throws(() => operations.start("operation-1", "device-2"), (error) => error instanceof AidenOperationContractError && error.code === "capability_denied");
  operations.assertOwner("operation-1", "device-1");
  assert.throws(() => operations.assertOwner("operation-1", "device-2"), (error) => error instanceof AidenOperationContractError && error.code === "capability_denied");
  operations.assertOwner("operation-1", "device-1");
  const restarted = new AidenDurableOperationRegistry(operations.snapshot());
  restarted.assertOwner("operation-1", "device-1");
  assert.throws(() => restarted.assertOwner("operation-1", "device-2"), (error) => error instanceof AidenOperationContractError && error.code === "capability_denied");
});

test("durable operation starts enforce the live 10,000-entry bound and owner completion frees capacity", () => {
  const operations = new AidenDurableOperationRegistry();
  for (let index = 0; index < MAX_DURABLE_OPERATION_ENTRIES; index += 1) {
    operations.start(`operation-${index}`, `device-${index}`);
  }
  operations.start("operation-0", "device-0");
  assert.throws(
    () => operations.start("operation-over-capacity", "device-over-capacity"),
    (error) => error instanceof AidenOperationContractError && error.code === "idempotency_capacity",
  );

  assert.throws(
    () => operations.complete("operation-0", "wrong-device"),
    (error) => error instanceof AidenOperationContractError && error.code === "capability_denied",
  );
  operations.assertOwner("operation-0", "device-0");
  operations.complete("operation-0", "device-0");
  assert.throws(
    () => operations.assertOwner("operation-0", "device-0"),
    (error) => error instanceof AidenOperationContractError && error.code === "capability_denied",
  );
  operations.start("operation-after-completion", "device-after-completion");
  assert.equal(operations.snapshot().length, MAX_DURABLE_OPERATION_ENTRIES);
});

test("a full durable operation snapshot remains JSON-round-trip restorable", () => {
  const entries = Array.from({ length: MAX_DURABLE_OPERATION_ENTRIES }, (_, index) => ({
    operationId: `operation-${index}`,
    deviceId: `device-${index}`,
  }));
  const operations = new AidenDurableOperationRegistry(entries);
  const persisted = JSON.parse(JSON.stringify(operations.snapshot())) as typeof entries;
  const restarted = new AidenDurableOperationRegistry(persisted);
  restarted.assertOwner("operation-0", "device-0");
  restarted.assertOwner(`operation-${MAX_DURABLE_OPERATION_ENTRIES - 1}`, `device-${MAX_DURABLE_OPERATION_ENTRIES - 1}`);
  assert.equal(restarted.snapshot().length, MAX_DURABLE_OPERATION_ENTRIES);
});

test("durable operation registry restores only exact bounded identities and rejects duplicate IDs", () => {
  const accessorEntry: Record<string, unknown> = { deviceId: "device-1" };
  Object.defineProperty(accessorEntry, "operationId", {
    enumerable: true,
    get: () => "operation-1",
  });
  const sparseEntries: unknown[] = [];
  sparseEntries.length = 1;
  const outOfRangeNumericEntries = [{ operationId: "operation-1", deviceId: "device-1" }] as unknown[];
  Object.defineProperty(outOfRangeNumericEntries, "4294967295", { enumerable: true, value: true });
  const extraEntry = { operationId: "operation-1", deviceId: "device-1", extra: true };
  const symbolEntries = [{ operationId: "operation-1", deviceId: "device-1" }];
  Object.defineProperty(symbolEntries, Symbol("extra"), { enumerable: true, value: true });
  const malformedEntries: unknown[] = [
    null,
    {},
    sparseEntries,
    outOfRangeNumericEntries,
    [{ operationId: "", deviceId: "device-1" }],
    [{ operationId: "operation-1", deviceId: "" }],
    [{ operationId: "o".repeat(129), deviceId: "device-1" }],
    [{ operationId: "operation-1", deviceId: "d".repeat(129) }],
    [extraEntry],
    [accessorEntry],
    [Object.create(null)],
    symbolEntries,
  ];
  for (const entries of malformedEntries) {
    assert.throws(
      () => new AidenDurableOperationRegistry(entries as never),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }

  const duplicateEntries = [
    [
      { operationId: "operation-1", deviceId: "device-1" },
      { operationId: "operation-1", deviceId: "device-1" },
    ],
    [
      { operationId: "operation-1", deviceId: "device-1" },
      { operationId: "operation-1", deviceId: "device-2" },
    ],
  ];
  for (const entries of duplicateEntries) {
    assert.throws(
      () => new AidenDurableOperationRegistry(entries),
      (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
    );
  }

  const valid = new AidenDurableOperationRegistry([
    { operationId: "operation-1", deviceId: "device-1" },
    { operationId: "operation-2", deviceId: "device-1" },
  ]);
  valid.assertOwner("operation-1", "device-1");
  valid.assertOwner("operation-2", "device-1");
  assert.throws(
    () => valid.start("", "device-1"),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
  assert.throws(
    () => valid.start("operation-3", ""),
    (error) => error instanceof AidenOperationContractError && error.code === "internal_error",
  );
});

test("canonical revision-9 Bot fixtures parse into explicit bounded contract views", async () => {
  const source = await readBotContractFixture();
  const fixture = parseAidenRemoteContractFixture(source);

  assert.equal(fixture.contractRevision, 9);
  assert.equal(fixture.botList.maxBots, 256);
  assert.deepEqual(fixture.botList.favorites, fixture.botFavorites);
  assert.equal(fixture.botSummary.health, "ready");
  assert.equal(fixture.botDetail.access.botId, fixture.botDetail.id);
  assert.equal(fixture.botPolicy.accessMode, "full");
  assert.equal(Object.prototype.hasOwnProperty.call(fixture.botPolicy, "custom"), false);
  assert.equal(fixture.botIdentity.request.openingGreeting, "");
  assert.equal(fixture.botCreate.request.access.accessMode, "full");
  assert.equal(
    fixture.botCreate.request.access.catalogRevision,
    fixture.botCapabilityCatalog.revision,
  );
  assert.equal(fixture.botChatCreate.response.botId, fixture.botSummary.id);
  assert.equal(fixture.botChatSubset.chatId, fixture.botConversation.chatId);
  assert.equal(fixture.botChatSubset.botId, fixture.botConversation.botId);
  assert.equal(fixture.botConversation.activityState, "waiting_for_approval");
  assert.equal(fixture.botConversation.canRespondToApproval, true);
  assert.equal(fixture.botAvatarMetadata.mimeType, "image/png");
  assert.equal(fixture.botAvatarMetadata.width, 512);
  assert.equal(fixture.botAvatarMetadata.height, 512);

  assert.equal(fixture.botPolicyUpdate.request.accessMode, "custom");
  assert.equal(
    fixture.botPolicyUpdate.request.catalogRevision,
    fixture.botCapabilityCatalog.revision,
  );
  if (fixture.botPolicyUpdate.request.accessMode === "custom") {
    assert.equal(fixture.botPolicyUpdate.request.custom.providerId, "provider_fixture");
    assert.equal(fixture.botPolicyUpdate.request.custom.modelId, "model_fixture");
  }
  assert.equal(
    fixture.botChatSubsetUpdate.request.expectedBotPolicyRevision,
    fixture.botChatSubsetUpdate.response.botPolicyRevision,
  );
  assert.equal(fixture.botNotice.requiresAcknowledgement, true);
  assert.equal(fixture.botNoticeAcknowledgement.response.requiresAcknowledgement, false);
  if (!fixture.botNoticeAcknowledgement.response.requiresAcknowledgement) {
    assert.equal(
      fixture.botNoticeAcknowledgement.response.acceptedDecision,
      "continue_full",
    );
  }
  const legacyCapabilities: readonly string[] =
    fixture.legacyNonNegotiating.server.capabilities;
  assert.equal(legacyCapabilities.includes("bot:read"), false);
  assert.equal(legacyCapabilities.includes("bot:write"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      fixture.legacyNonNegotiating.server,
      "serverCapabilities",
    ),
    false,
  );
});

test("Bot fixture parsing tolerates response additions and rejects authority-shaping ambiguity", async () => {
  const source = await readBotContractFixture();

  const additiveResponse = structuredClone(source);
  fixtureRecord(additiveResponse.botDetail, "botDetail").futureDisplayHint = "future-safe-value";
  const additiveParsed = parseAidenRemoteContractFixture(additiveResponse);
  assert.equal(
    Object.prototype.hasOwnProperty.call(additiveParsed.botDetail, "futureDisplayHint"),
    false,
  );
  const additiveNotice = structuredClone(source);
  fixtureRecord(additiveNotice.botNotice, "botNotice").futurePresentationHint = true;
  const additiveNoticeParsed = parseAidenRemoteContractFixture(additiveNotice);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      additiveNoticeParsed.botNotice,
      "futurePresentationHint",
    ),
    false,
  );
  for (const privateKey of [
    "managedHomePath",
    "managedWorkspacePath",
    "workspacePath",
    "botHomePath",
    "systemPrompt",
    "skillContent",
    "skillContents",
    "skillPath",
    "skillPaths",
    "providerCredential",
    "mcpCredential",
    "connectionCredential",
    "authorizationHeader",
    "providerHeaders",
    "mcpHeaders",
    "connectionHeaders",
    "providerApiKey",
    "mcpApiKey",
    "connectionApiKey",
    "credentialMaterial",
    "assetFilename",
    "avatarAssetFilename",
    "temporaryAssetURL",
    "temporaryURL",
    "credential",
    "secret",
    "apiKey",
    "token",
    "headers",
    "endpoint",
    "path",
    "toolArgs",
    "toolResult",
    "reasoning",
    "provider_api_key",
    "authorization-header",
    "skill.path",
    "temporary asset url",
    "avatar_asset_filename",
  ]) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        fixtureRecord(fixture.botDetail, "botDetail")[privateKey] = "private";
      },
      /Forbidden (?:Aiden Remote|private Bot) wire key/u,
    );
  }

  for (const [fixtureKey, privateKey] of [
    ["botSummary", "instructions"],
    ["botSummary", "openingGreeting"],
    ["botConversation", "reasoning"],
  ] as const) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        fixtureRecord(fixture[fixtureKey], fixtureKey)[privateKey] = "private";
      },
      /Forbidden private Bot wire key/u,
    );
  }

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botCreate, "botCreate");
      fixtureRecord(operation.request, "botCreate.request").unexpectedAuthority = true;
    },
    /Bot create request contains unsupported field/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botIdentity, "botIdentity");
      fixtureRecord(operation.request, "botIdentity.request").openingGreeting = null;
    },
    /openingGreeting/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatCreate, "botChatCreate");
      fixtureRecord(operation.response, "botChatCreate.response").botId = "bot_other";
    },
    /conversation identities do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botPolicyUpdate, "botPolicyUpdate");
      const request = fixtureRecord(operation.request, "botPolicyUpdate.request");
      fixtureRecord(request.custom, "botPolicyUpdate.request.custom").fileScopeIds = [
        "../private",
      ];
    },
    /path-safe opaque identifiers/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botPolicyUpdate, "botPolicyUpdate");
      const request = fixtureRecord(operation.request, "botPolicyUpdate.request");
      delete fixtureRecord(request.custom, "botPolicyUpdate.request.custom").modelId;
    },
    /modelId/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const policy = fixtureRecord(fixture.botPolicy, "botPolicy");
      const update = fixtureRecord(fixture.botPolicyUpdate, "botPolicyUpdate");
      const request = fixtureRecord(update.request, "botPolicyUpdate.request");
      policy.custom = structuredClone(request.custom);
    },
    /access and custom selection must agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botNotice, "botNotice").acceptedAt =
        "2026-08-18T19:03:00.000Z";
    },
    /pending Bot access notice/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botArchive, "botArchive").health = "ready";
    },
    /archived health and archivedAt must agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botAvatarMetadata, "botAvatarMetadata").mimeType = "image/jpeg";
    },
    /avatar MIME type/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const conversation = fixtureRecord(fixture.botConversation, "botConversation");
      conversation.activityState = "idle";
      conversation.canRespondToApproval = true;
    },
    /approval responses require waiting_for_approval/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const legacy = fixtureRecord(fixture.legacyNonNegotiating, "legacyNonNegotiating");
      fixtureRecord(legacy.server, "legacyNonNegotiating.server").serverCapabilities = [];
    },
    /Legacy server projection contains unsupported field/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatCreate, "botChatCreate");
      delete fixtureRecord(operation.request, "botChatCreate.request").modelId;
    },
    /providerId and modelId must be supplied together/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatCreate, "botChatCreate");
      delete fixtureRecord(operation.response, "botChatCreate.response").modelId;
    },
    /providerId and modelId must be supplied together/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatCreate, "botChatCreate");
      operation.request = {};
      const catalog = fixtureRecord(fixture.botCapabilityCatalog, "botCapabilityCatalog");
      const providers = catalog.providers;
      assert.ok(Array.isArray(providers));
      fixtureRecord(providers[0], "provider").available = false;
    },
    /Bot chat create response contains an unknown or unavailable provider/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const chat = fixtureRecord(fixture.chat, "chat");
      chat.providerId = "provider_missing";
      chat.modelId = "model_missing";
    },
    /Canonical Bot Chat contains an unknown or unavailable provider/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botPolicy, "botPolicy").summary = "Contradictory access";
    },
    /Canonical Bot policy identities do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const avatar = fixtureRecord(fixture.botAvatar, "botAvatar");
      const semantic = fixtureRecord(avatar.semantic, "botAvatar.semantic");
      semantic.color = "mint";
    },
    /Canonical Bot avatar and detail projections do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const list = fixtureRecord(fixture.botList, "botList");
      const bots = list.bots;
      assert.ok(Array.isArray(bots));
      const summary = fixtureRecord(bots[0], "botList.bots[0]");
      summary.health = "archived";
      summary.archivedAt = "2026-08-18T18:45:00.000Z";
    },
    /Archived Bots cannot remain in favorites/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botSummary, "botSummary").updatedAt =
        "2026-08-18T16:59:59.000Z";
    },
    /Bot updatedAt must not precede createdAt/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botConversation, "botConversation").updatedAt =
        "2026-08-18T18:49:59.000Z";
    },
    /Bot conversation updatedAt must not precede createdAt/u,
  );
  for (const fixtureKey of ["botSummary", "botConversation", "chat"] as const) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        const projection = fixtureRecord(fixture[fixtureKey], fixtureKey);
        projection.createdAt = "2026-08-18T19:00:00.1239Z";
        projection.updatedAt = "2026-08-18T19:00:00.1230Z";
      },
      /updatedAt must not precede createdAt/u,
    );
  }
  const offsetEquivalent = structuredClone(source);
  const offsetEquivalentChat = fixtureRecord(offsetEquivalent.chat, "chat");
  offsetEquivalentChat.createdAt = "2026-08-18T20:00:00.1239+01:00";
  offsetEquivalentChat.updatedAt = "2026-08-18T19:00:00.123900Z";
  assert.doesNotThrow(() => parseAidenRemoteContractFixture(offsetEquivalent));
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const projection = fixtureRecord(fixture.chat, "chat");
      projection.createdAt = "2026-08-18T20:00:00.1239+01:00";
      projection.updatedAt = "2026-08-18T19:00:00.1238Z";
    },
    /updatedAt must not precede createdAt/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.botNotice, "botNotice").version = "bot-full-access-v2";
    },
    /notice version is unsupported/u,
  );
});

test("Bot capability catalogs allow the documented per-provider model bound", async () => {
  const source = await readBotContractFixture();
  const catalog = fixtureRecord(source.botCapabilityCatalog, "botCapabilityCatalog");
  const providers = catalog.providers;
  assert.ok(Array.isArray(providers));
  const originalProvider = fixtureRecord(providers[0], "botCapabilityCatalog.providers[0]");
  const firstProvider = structuredClone(originalProvider);
  firstProvider.models = Array.from({ length: 256 }, (_, index) => ({
    id: index === 0 ? "model_fixture" : `model_fixture_${index}`,
    label: `Model ${index}`,
    available: true,
    supportsImages: index === 0,
  }));
  const secondProvider = structuredClone(originalProvider);
  secondProvider.id = "provider_fixture_two";
  secondProvider.models = Array.from({ length: 256 }, (_, index) => ({
    id: `model_fixture_two_${index}`,
    label: `Second model ${index}`,
    available: true,
    supportsImages: false,
  }));
  catalog.providers = [firstProvider, secondProvider];

  const fixture = parseAidenRemoteContractFixture(source);
  assert.equal(fixture.botCapabilityCatalog.providers.length, 2);
  assert.equal(fixture.botCapabilityCatalog.providers[0]?.models.length, 256);
  assert.equal(fixture.botCapabilityCatalog.providers[1]?.models.length, 256);

  catalog.providers = [
    firstProvider,
    secondProvider,
    {
      ...structuredClone(originalProvider),
      id: "provider_fixture_three",
      models: [{
        id: "model_fixture_three",
        label: "Overflow model",
        available: true,
        supportsImages: false,
      }],
    },
  ];
  assert.throws(
    () => parseAidenRemoteContractFixture(source),
    /exceeds 512 total provider models/u,
  );
});

test("Bot policy mutations bind catalog and Bot-policy revisions without hiding drift", async () => {
  const source = await readBotContractFixture();

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botCreate, "botCreate");
      delete fixtureRecord(operation.request, "botCreate.request").access;
    },
    /Bot access update request must be an object/u,
  );
  for (const operationName of ["botCreate", "botPolicyUpdate"] as const) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        const operation = fixtureRecord(fixture[operationName], operationName);
        const request = fixtureRecord(operation.request, `${operationName}.request`);
        const access = operationName === "botCreate"
          ? fixtureRecord(request.access, "botCreate.request.access")
          : request;
        access.catalogRevision = "stale_catalog_revision";
      },
      /does not target the canonical catalog revision/u,
    );
  }
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatSubsetUpdate, "botChatSubsetUpdate");
      fixtureRecord(operation.request, "botChatSubsetUpdate.request").catalogRevision =
        "stale_catalog_revision";
    },
    /does not target the canonical catalog revision/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const operation = fixtureRecord(fixture.botChatSubsetUpdate, "botChatSubsetUpdate");
      fixtureRecord(operation.request, "botChatSubsetUpdate.request").expectedBotPolicyRevision =
        "stale_bot_policy_revision";
    },
    /Bot policy revisions do not agree/u,
  );

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const catalog = fixtureRecord(fixture.botCapabilityCatalog, "botCapabilityCatalog");
      const connections = catalog.connections;
      assert.ok(Array.isArray(connections));
      fixtureRecord(connections[0], "connection").available = false;
    },
    /contains an unavailable connection/u,
  );

  const tombstoneResponse = structuredClone(source);
  const tombstoneCatalog = fixtureRecord(
    tombstoneResponse.botCapabilityCatalog,
    "botCapabilityCatalog",
  );
  const tombstoneConnections = tombstoneCatalog.connections;
  assert.ok(Array.isArray(tombstoneConnections));
  tombstoneConnections.push({
    id: "connection.removed",
    label: "Removed connection",
    available: false,
  });
  const detail = fixtureRecord(tombstoneResponse.botDetail, "botDetail");
  const policyUpdate = fixtureRecord(tombstoneResponse.botPolicyUpdate, "botPolicyUpdate");
  const policyRequest = fixtureRecord(policyUpdate.request, "botPolicyUpdate.request");
  const custom = structuredClone(
    fixtureRecord(policyRequest.custom, "botPolicyUpdate.request.custom"),
  );
  custom.connectionIds = ["connection.removed"];
  detail.access = {
    botId: detail.id,
    accessMode: "custom",
    revision: "bot_policy_revision_drift",
    policyEpoch: "bot_policy_epoch_drift",
    summary: "A selected connection is unavailable.",
    custom,
  };
  const driftFixture = parseAidenRemoteContractFixture(tombstoneResponse);
  assert.equal(driftFixture.botDetail.access.accessMode, "custom");
  if (driftFixture.botDetail.access.accessMode === "custom") {
    assert.deepEqual(driftFixture.botDetail.access.custom.connectionIds, [
      "connection.removed",
    ]);
  }

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const catalog = fixtureRecord(fixture.botCapabilityCatalog, "botCapabilityCatalog");
      const scopes = catalog.fileScopes;
      assert.ok(Array.isArray(scopes));
      scopes.push({
        id: "scope.extra",
        label: "Extra scope",
        available: true,
        kind: "approved_location",
      });
      const operation = fixtureRecord(fixture.botChatSubsetUpdate, "botChatSubsetUpdate");
      for (const key of ["request", "response"] as const) {
        const view = fixtureRecord(operation[key], `botChatSubsetUpdate.${key}`);
        fixtureRecord(view.custom, `botChatSubsetUpdate.${key}.custom`).fileScopeIds = [
          "scope.extra",
        ];
      }
    },
    /exceeds the authoritative Bot access ceiling/u,
  );
});

test("canonical Bot operation fixtures preserve exact identities and applied mutations", async () => {
  const source = await readBotContractFixture();

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const list = fixtureRecord(fixture.botList, "botList");
      const bots = list.bots;
      assert.ok(Array.isArray(bots));
      fixtureRecord(bots[0], "botList.bots[0]").name = "Divergent Scout";
    },
    /Same-revision Bot summary, list, and detail projections do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const page = fixtureRecord(fixture.botConversations, "botConversations");
      const conversations = page.conversations;
      assert.ok(Array.isArray(conversations));
      fixtureRecord(conversations[0], "botConversations.conversations[0]").preview =
        "Divergent preview";
    },
    /Same-revision Bot conversation and page projections do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const archive = fixtureRecord(fixture.botArchive, "botArchive");
      fixtureRecord(archive.avatar, "botArchive.avatar").semantic = "orbit";
    },
    /identity and avatar must survive archive and restore unchanged/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const create = fixtureRecord(fixture.botCreate, "botCreate");
      fixtureRecord(create.response, "botCreate.response").purpose = "Different purpose";
    },
    /does not apply the exact requested identity/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const identity = fixtureRecord(fixture.botIdentity, "botIdentity");
      fixtureRecord(identity.response, "botIdentity.response").openingGreeting =
        "The clear did not apply";
    },
    /does not apply the exact requested patch/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const favorites = fixtureRecord(fixture.botFavoritesUpdate, "botFavoritesUpdate");
      fixtureRecord(favorites.request, "botFavoritesUpdate.request").botIds = [];
    },
    /favorites fixtures do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const update = fixtureRecord(fixture.botPolicyUpdate, "botPolicyUpdate");
      const response = fixtureRecord(update.response, "botPolicyUpdate.response");
      fixtureRecord(response.custom, "botPolicyUpdate.response.custom").skillIds = [];
    },
    /request and response Custom selections do not agree/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const update = fixtureRecord(fixture.botChatSubsetUpdate, "botChatSubsetUpdate");
      const response = fixtureRecord(update.response, "botChatSubsetUpdate.response");
      fixtureRecord(response.custom, "botChatSubsetUpdate.response.custom").skillIds = [];
    },
    /request and response Custom selections do not agree/u,
  );
});

test("canonical Chat fixtures validate bounded classification and every known Message field", async () => {
  const source = await readBotContractFixture();

  const knownFields = structuredClone(source);
  const chat = fixtureRecord(knownFields.chat, "chat");
  const messages = chat.messages;
  assert.ok(Array.isArray(messages));
  const message = fixtureRecord(messages[0], "chat.messages[0]");
  message.attachments = [
    {
      id: "attachment.fixture",
      name: "brief.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 42,
    },
  ];
  message.outcome = {
    status: "failed",
    category: "timeout",
    attempts: 2,
    retryExhausted: true,
  };
  message.timeline = {
    version: 3,
    generationId: "generation.fixture",
    status: "completed",
    startedAt: 0,
    finishedAt: 1,
    steps: [],
  };
  chat.futureDisplayHint = true;
  const knownParsed = parseAidenRemoteContractFixture(knownFields);
  assert.equal(knownParsed.chat.messages[0]?.attachments?.[0]?.name, "brief.txt");
  assert.equal(knownParsed.chat.messages[0]?.outcome?.category, "timeout");
  assert.equal(knownParsed.chat.messages[0]?.timeline?.generationId, "generation.fixture");
  assert.equal(Object.prototype.hasOwnProperty.call(knownParsed.chat, "futureDisplayHint"), false);

  const regularChat = structuredClone(source);
  delete fixtureRecord(regularChat.chat, "chat").botId;
  assert.throws(
    () => parseAidenRemoteContractFixture(regularChat),
    /Chat response selections or Bot identity do not agree/u,
  );

  for (const [field, value, expected] of [
    ["id", "i".repeat(129), /Chat response id/u],
    ["workspaceId", "w".repeat(129), /workspaceId/u],
    ["revision", "r".repeat(129), /revision/u],
    ["title", "t".repeat(1_025), /title/u],
    ["providerId", "p".repeat(257), /providerId/u],
    ["modelId", "m".repeat(513), /modelId/u],
    ["botId", "../private", /canonical Bot identifier grammar/u],
    ["title", 42, /title/u],
  ] as const) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        fixtureRecord(fixture.chat, "chat")[field] = value;
      },
      expected,
    );
  }
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const malformedChat = fixtureRecord(fixture.chat, "chat");
      malformedChat.updatedAt = "2026-08-18T18:00:00.000Z";
    },
    /updatedAt must not precede createdAt/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      const malformedChat = fixtureRecord(fixture.chat, "chat");
      const malformedMessages = malformedChat.messages;
      assert.ok(Array.isArray(malformedMessages));
      fixtureRecord(malformedMessages[0], "chat.messages[0]").id = "";
    },
    /message 0 id/u,
  );
  for (const [field, value, expected] of [
    ["attachments", {}, /attachments must contain at most 20 items/u],
    ["outcome", { status: "completed" }, /outcome status is invalid/u],
    ["timeline", {}, /timeline is invalid/u],
  ] as const) {
    assertBotFixtureMutationFails(
      source,
      (fixture) => {
        const malformedChat = fixtureRecord(fixture.chat, "chat");
        const malformedMessages = malformedChat.messages;
        assert.ok(Array.isArray(malformedMessages));
        fixtureRecord(malformedMessages[0], "chat.messages[0]")[field] = value;
      },
      expected,
    );
  }

  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.chat, "chat").messages = Array.from(
        { length: 10_001 },
        () => ({
          id: "m",
          role: "user",
          text: "",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      );
    },
    /messages must contain at most 10000 items/u,
  );
  assertBotFixtureMutationFails(
    source,
    (fixture) => {
      fixtureRecord(fixture.chat, "chat").messages = Array.from(
        { length: 6 },
        (_, index) => ({
          id: `message_${index}`,
          role: "user",
          text: "x".repeat(200_000),
          createdAt: "2026-01-01T00:00:00Z",
        }),
      );
    },
    /exceeds the 1 MiB JSON response ceiling/u,
  );
});

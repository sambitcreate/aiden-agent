import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import {
  PiCompactionSessionStore,
  recordPiEffectRecoveryBoundary,
} from "./pi-compaction-session-store.js";
import {
  MAX_PI_RUNTIME_OPERATIONS,
  digestPiRuntimeEffectArguments,
  emptyPiRuntimeEffectDatabase,
  parseDurablePiRuntimeEffect,
  parseDurablePiRuntimeEffectDatabase,
  parseDurablePiRuntimeEffectOwner,
  piRuntimeTerminalDigest,
  snapshotPiRuntimeEffectArguments,
  type DurablePiRuntimeEffect,
  type DurablePiRuntimeEffectDatabase,
  type DurablePiRuntimeOperation,
  type PreparePiRuntimeEffectInput,
  type StartPiRuntimeOperationInput,
} from "./pi-runtime-effect-core.js";
import { PiRuntimeEffectStore } from "./pi-runtime-effect-store.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

const STORE_NAME = "pi-runtime-effects.json";

function operation(operationId = "operation-1", chatId = "chat-1"): StartPiRuntimeOperationInput {
  return {
    operationId,
    runId: `run-${operationId}`,
    sessionId: `session-${chatId}`,
    chatId,
    lane: "foreground",
    contributionRevision: 0,
  };
}

function effect(
  owner: StartPiRuntimeOperationInput,
  effectId = "effect-1",
  overrides: Partial<PreparePiRuntimeEffectInput> = {},
): PreparePiRuntimeEffectInput {
  return {
    ...owner,
    effectId,
    turnId: `turn-${effectId}`,
    toolCallId: `call-${effectId}`,
    toolName: "read",
    arguments: { path: "/tmp/example", nested: [true, 2] },
    ...overrides,
  };
}

function effectOwner(input: PreparePiRuntimeEffectInput) {
  return {
    effectId: input.effectId,
    operationId: input.operationId,
    runId: input.runId,
    chatId: input.chatId,
  };
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-effect-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeStore(directory: string, startAt = 1_000): PiRuntimeEffectStore {
  let clock = startAt;
  return new PiRuntimeEffectStore({ root: () => directory, now: () => clock++ });
}

test("replay metadata is closed and defaults every non-safe declaration to never", () => {
  assert.equal(piRuntimeReplayPolicy({}), "never");
  assert.equal(piRuntimeReplayPolicy({ replay: "never" }), "never");
  assert.equal(piRuntimeReplayPolicy({ replay: "later" }), "never");
  assert.equal(piRuntimeReplayPolicy({ replay: "safe" }), "safe");
});

test("argument snapshots are canonical, bounded, and reject hostile non-JSON input", () => {
  const left = snapshotPiRuntimeEffectArguments({ z: 1, a: { y: 2, x: 3 } });
  const right = snapshotPiRuntimeEffectArguments({ a: { x: 3, y: 2 }, z: 1 });
  assert.equal(left.canonical, '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(left.digest, right.digest);

  const reserved = JSON.parse('{"__proto__":{"sentinel":"retained"}}') as unknown;
  const reservedSnapshot = snapshotPiRuntimeEffectArguments(reserved);
  assert.equal(reservedSnapshot.canonical, '{"__proto__":{"sentinel":"retained"}}');
  assert.notEqual(reservedSnapshot.digest, snapshotPiRuntimeEffectArguments({}).digest);
  assert.notEqual(digestPiRuntimeEffectArguments(reserved), digestPiRuntimeEffectArguments({}));
  assert.notEqual(
    digestPiRuntimeEffectArguments("\ud800"),
    digestPiRuntimeEffectArguments("\ud801"),
  );
  assert.notEqual(
    digestPiRuntimeEffectArguments({ "\ud800": true }),
    digestPiRuntimeEffectArguments({ "\ud801": true }),
  );

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "no";
    },
  });
  assert.throws(() => snapshotPiRuntimeEffectArguments(accessor), /plain object/u);
  assert.equal(getterCalls, 0);
  assert.throws(() => snapshotPiRuntimeEffectArguments(new Proxy({ value: 1 }, {})), /plain JSON/u);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => snapshotPiRuntimeEffectArguments(cyclic), /cyclic/u);
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[1] = 1;
  assert.throws(() => snapshotPiRuntimeEffectArguments(sparse), /sparse/u);
  assert.throws(() => snapshotPiRuntimeEffectArguments(Number.POSITIVE_INFINITY), /JSON-safe/u);
  assert.throws(
    () => snapshotPiRuntimeEffectArguments("x".repeat(65 * 1024)),
    /durable replay limit/u,
  );
});

test("strict parsers enforce exact schemas and replay argument invariants", () => {
  const argument = snapshotPiRuntimeEffectArguments({ value: 1 });
  const base: DurablePiRuntimeEffect = {
    version: 1,
    effectId: "effect",
    operationId: "operation",
    runId: "run",
    sessionId: "session",
    chatId: "chat",
    lane: "child",
    turnId: "turn",
    toolCallId: "call",
    toolName: "read",
    replay: "safe",
    state: "prepared",
    argumentDigest: argument.digest,
    arguments: argument.value,
    preparedAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(parseDurablePiRuntimeEffect(base), base);
  assert.equal(parseDurablePiRuntimeEffect({ ...base, extra: true }), undefined);
  assert.equal(parseDurablePiRuntimeEffect({ ...base, arguments: undefined }), undefined);
  assert.equal(parseDurablePiRuntimeEffect({ ...base, argumentDigest: "0".repeat(64) }), undefined);
  assert.equal(
    parseDurablePiRuntimeEffect({ ...base, replay: "never", arguments: argument.value }),
    undefined,
  );
  assert.equal(
    parseDurablePiRuntimeEffect({
      ...base,
      state: "completed",
      terminalDigest: undefined,
    }),
    undefined,
  );
  assert.equal(
    parseDurablePiRuntimeEffectOwner({
      effectId: "effect",
      operationId: "operation",
      runId: "run",
      chatId: "chat",
      extra: true,
    }),
    undefined,
  );
});

test("restart recovery installs one durable no-repeat boundary before releasing evidence", async () => {
  await withTempDirectory(async (directory) => {
    const effectRoot = path.join(directory, "effects");
    const piRoot = path.join(directory, "pi");
    await mkdir(piRoot, { recursive: true });
    const first = makeStore(effectRoot);
    await first.initialize();
    const neverOperation = operation("operation-never", "chat-recovery");
    await first.startOperation(neverOperation);
    const neverEffect = effect(neverOperation, "effect-never", {
      toolName: "write_file",
      replay: "never",
      arguments: { path: "/private/workspace/file", content: "PRIVATE_ARGUMENT" },
    });
    await first.prepareEffect(neverEffect);
    await first.markEffectDispatchStarted(effectOwner(neverEffect));

    const safeOperation = operation("operation-safe", "chat-recovery");
    await first.startOperation(safeOperation);
    const safeEffect = effect(safeOperation, "effect-safe", {
      toolName: "read_file",
      replay: "safe",
    });
    await first.prepareEffect(safeEffect);
    await first.markEffectDispatchStarted(effectOwner(safeEffect));
    await first.finishEffect({
      ...effectOwner(safeEffect),
      state: "completed",
      terminalDigest: piRuntimeTerminalDigest("read complete"),
    });
    await first.finishOperation(safeOperation.operationId, "completed");

    const restarted = makeStore(effectRoot, 2_000);
    await restarted.initialize();
    const pending = await restarted.listEffectsNeedingRecoveryByChat("chat-recovery");
    assert.deepEqual(pending.map(({ effectId }) => effectId).sort(), [
      "effect-never",
      "effect-safe",
    ]);

    const sessions = new PiCompactionSessionStore({ root: async () => piRoot });
    const session = await sessions.openChat("chat-recovery");
    await session.appendMessage({ role: "user", content: "older request", timestamp: 1 });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "older answer" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    await recordPiEffectRecoveryBoundary(session, pending);
    for (const recovered of pending) {
      await restarted.markRecoveryRecorded({
        effectId: recovered.effectId,
        operationId: recovered.operationId,
        runId: recovered.runId,
        chatId: recovered.chatId,
      });
    }
    await recordPiEffectRecoveryBoundary(session, pending);
    await session.appendMessage({ role: "user", content: "current request", timestamp: 3 });

    const context = await session.buildContext();
    assert.equal(context.messages.length, 4);
    assert.deepEqual(
      context.messages.map(({ role }) => role),
      ["user", "assistant", "assistant", "user"],
    );
    const boundary = context.messages[2];
    assert.equal(boundary?.role, "assistant");
    const serialized = JSON.stringify(boundary);
    assert.match(serialized, /Do not repeat/u);
    assert.doesNotMatch(serialized, /PRIVATE_ARGUMENT|private\/workspace/u);
    assert.equal((await restarted.listEffectsNeedingRecoveryByChat("chat-recovery")).length, 0);
    const recoveredEffects = await restarted.listEffectsByChat("chat-recovery");
    assert.equal(
      recoveredEffects.every(({ recoveryRecordedAt }) => recoveryRecordedAt !== undefined),
      true,
    );

    const committedOperation = operation("operation-committed", "chat-recovery");
    await restarted.startOperation(committedOperation);
    const committedEffect = effect(committedOperation, "effect-committed", {
      toolName: "write_file",
      replay: "never",
    });
    await restarted.prepareEffect(committedEffect);
    await restarted.markEffectDispatchStarted(effectOwner(committedEffect));
    await restarted.finishEffect({
      ...effectOwner(committedEffect),
      state: "completed",
      terminalDigest: piRuntimeTerminalDigest("write complete"),
    });
    await restarted.finishOperation(committedOperation.operationId, "completed");
    await restarted.acknowledgeChatEffectsDurable("chat-recovery");
    assert.equal((await restarted.listEffectsNeedingRecoveryByChat("chat-recovery")).length, 0);
  });
});

test("prepare, dispatch, and terminal writes are durable, minimal, and idempotent", async () => {
  await withTempDirectory(async (directory) => {
    const store = makeStore(directory);
    await assert.rejects(() => store.startOperation(operation()), /not initialized/u);
    await store.initialize();
    const operationInput = operation();
    const started = await store.startOperation(operationInput);
    assert.deepEqual(await store.startOperation(operationInput), started);

    const input = effect(operationInput);
    const prepared = await store.prepareEffect(input);
    assert.equal(prepared.replay, "never");
    assert.equal(prepared.arguments, undefined);
    assert.match(prepared.argumentDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await store.prepareEffect(input), prepared);

    const dispatching = await store.markEffectDispatchStarted(effectOwner(input));
    assert.equal(dispatching.state, "dispatch_started");
    assert.deepEqual(await store.markEffectDispatchStarted(effectOwner(input)), dispatching);
    assert.deepEqual(await store.prepareEffect(input), dispatching);

    const terminalDigest = piRuntimeTerminalDigest("tool-result");
    const [completed, concurrentDuplicate] = await Promise.all([
      store.finishEffect({
        ...effectOwner(input),
        state: "completed",
        terminalDigest,
      }),
      store.finishEffect({
        ...effectOwner(input),
        state: "completed",
        terminalDigest,
      }),
    ]);
    assert.equal(completed.state, "completed");
    assert.deepEqual(concurrentDuplicate, completed);
    assert.deepEqual(
      await store.finishEffect({
        ...effectOwner(input),
        state: "completed",
        terminalDigest,
      }),
      completed,
    );
    await assert.rejects(
      () =>
        store.finishEffect({
          ...effectOwner(input),
          state: "remote_error",
          terminalDigest: piRuntimeTerminalDigest("conflict"),
        }),
      /not dispatch-started/u,
    );
    assert.equal((await store.getEffect(effectOwner(input)))?.state, "completed");
    const finished = await store.finishOperation(operationInput.operationId, "completed");
    assert.equal(finished.state, "completed");
    assert.deepEqual(
      await store.finishOperation(operationInput.operationId, "completed"),
      finished,
    );

    const disk = JSON.parse(
      await readFile(path.join(directory, STORE_NAME), "utf8"),
    ) as DurablePiRuntimeEffectDatabase;
    assert.equal(disk.effects[0]?.arguments, undefined);
    assert.ok(parseDurablePiRuntimeEffectDatabase(disk));
    assert.equal((await stat(path.join(directory, STORE_NAME))).mode & 0o777, 0o600);
  });
});

test("never-replay effects accept large arguments without retaining them", async () => {
  await withTempDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.initialize();
    const operationInput = operation();
    await store.startOperation(operationInput);
    const input = effect(operationInput, "large-never", {
      replay: "never",
      toolName: "write_file",
      arguments: { path: "large.txt", content: "x".repeat(70 * 1024) },
    });
    const prepared = await store.prepareEffect(input);
    assert.equal(prepared.arguments, undefined);
    assert.match(prepared.argumentDigest, /^[a-f0-9]{64}$/u);
  });
});

test("identity reuse, ownership mismatch, and invalid transitions fail closed", async () => {
  await withTempDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.initialize();
    const operationInput = operation();
    await store.startOperation(operationInput);
    await assert.rejects(
      () => store.startOperation({ ...operationInput, runId: "different" }),
      /identity was reused/u,
    );
    const input = effect(operationInput);
    await store.prepareEffect(input);
    await assert.rejects(
      () => store.prepareEffect({ ...input, arguments: { different: true } }),
      /identity was reused/u,
    );
    await store.prepareEffect({
      ...input,
      effectId: "different-effect",
      turnId: "later-turn",
    });
    await assert.rejects(
      () => store.prepareEffect({ ...input, effectId: "same-turn-effect" }),
      /tool-call identity was reused/u,
    );
    await assert.rejects(
      () =>
        store.markEffectDispatchStarted({
          ...effectOwner(input),
          runId: "wrong-run",
        }),
      /ownership mismatch/u,
    );
    await assert.rejects(
      () => store.finishOperation(operationInput.operationId, "completed"),
      /unsettled effect/u,
    );
    const cancelled = await store.cancelEffectBeforeDispatch(effectOwner(input));
    assert.equal(cancelled.state, "cancelled_before_dispatch");
    assert.deepEqual(await store.cancelEffectBeforeDispatch(effectOwner(input)), cancelled);
    await assert.rejects(
      () =>
        store.finishEffect({
          ...effectOwner(input),
          state: "completed",
          terminalDigest: piRuntimeTerminalDigest("impossible"),
        }),
      /not dispatch-started/u,
    );
  });
});

test("byte pressure prunes terminal history before it can block a new run", async () => {
  await withTempDirectory(async (directory) => {
    const operations: DurablePiRuntimeOperation[] = [];
    const effects: DurablePiRuntimeEffect[] = [];
    for (let index = 0; ; index += 1) {
      const operationId = `operation-${index}`;
      const runId = `run-${index}`;
      const chatId = `chat-${index}`;
      const argument = snapshotPiRuntimeEffectArguments({ value: "x".repeat(60 * 1024) });
      operations.push({
        version: 1,
        operationId,
        runId,
        sessionId: `session-${index}`,
        chatId,
        lane: "foreground",
        contributionRevision: 0,
        state: "completed",
        startedAt: index + 1,
        updatedAt: index + 1,
      });
      effects.push({
        version: 1,
        effectId: `effect-${index}`,
        operationId,
        runId,
        sessionId: `session-${index}`,
        chatId,
        lane: "foreground",
        turnId: `turn-${index}`,
        toolCallId: `call-${index}`,
        toolName: "read_file",
        replay: "safe",
        state: "completed",
        argumentDigest: argument.digest,
        arguments: argument.value,
        preparedAt: index + 1,
        updatedAt: index + 1,
        terminalDigest: piRuntimeTerminalDigest("completed"),
        recoveryRecordedAt: index + 1,
      });
      const candidate: DurablePiRuntimeEffectDatabase = {
        version: 1,
        revision: 1,
        operations,
        effects,
      };
      if (
        Buffer.byteLength(`${JSON.stringify(candidate, null, 2)}\n`) >
        8 * 1024 * 1024 - 32 * 1024
      ) {
        operations.pop();
        effects.pop();
        break;
      }
    }
    const seeded: DurablePiRuntimeEffectDatabase = {
      version: 1,
      revision: 1,
      operations,
      effects,
    };
    assert.ok(parseDurablePiRuntimeEffectDatabase(seeded));
    await writeFile(path.join(directory, STORE_NAME), `${JSON.stringify(seeded, null, 2)}\n`, {
      mode: 0o600,
    });
    const store = makeStore(directory, 10_000);
    await store.initialize();
    await store.startOperation(operation("new-operation", "new-chat"));
    assert.equal((await store.listOperationsByChat("new-chat")).length, 1);
    assert.ok(
      (await store.listOperationsByChat(operations[0]!.chatId)).length === 0,
      "oldest terminal history should be pruned under byte pressure",
    );
  });
});

test("startup reconciliation distinguishes prepared, never-replay, and safe effects", async () => {
  await withTempDirectory(async (directory) => {
    const first = makeStore(directory, 10);
    await first.initialize();
    const operationInput = operation();
    await first.startOperation(operationInput);

    const preparedInput = effect(operationInput, "prepared");
    await first.prepareEffect(preparedInput);
    const neverInput = effect(operationInput, "never");
    await first.prepareEffect(neverInput);
    await first.markEffectDispatchStarted(effectOwner(neverInput));
    const safeInput = effect(operationInput, "safe", {
      replay: "safe",
      arguments: { exact: ["bounded", 1] },
    });
    await first.prepareEffect(safeInput);
    await first.markEffectDispatchStarted(effectOwner(safeInput));

    const restarted = makeStore(directory, 1_000);
    await restarted.initialize();
    const effects = new Map(
      (await restarted.listEffectsByChat(operationInput.chatId)).map((entry) => [
        entry.effectId,
        entry,
      ]),
    );
    assert.equal(effects.get("prepared")?.state, "cancelled_before_dispatch");
    assert.equal(effects.get("never")?.state, "unknown");
    assert.equal(effects.get("never")?.arguments, undefined);
    assert.equal(effects.get("safe")?.state, "interrupted");
    assert.deepEqual(effects.get("safe")?.arguments, { exact: ["bounded", 1] });
    assert.equal(
      (await restarted.listOperationsByChat(operationInput.chatId))[0]?.state,
      "interrupted",
    );
  });
});

test("a terminal persistence failure exposes local unknown evidence and restart preserves uncertainty", async () => {
  await withTempDirectory(async (directory) => {
    let failWrites = false;
    const dataStore = new DataStore(STORE_NAME, emptyPiRuntimeEffectDatabase(), () => directory, {
      maxBytes: 8 * 1024 * 1024,
      normalize: (value) =>
        parseDurablePiRuntimeEffectDatabase(value) ?? emptyPiRuntimeEffectDatabase(),
      isSafe: (value) => parseDurablePiRuntimeEffectDatabase(value) !== undefined,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      beforeWritePublish: () => {
        if (failWrites) throw new Error("simulated terminal write failure");
      },
    });
    let clock = 1;
    const store = new PiRuntimeEffectStore({
      root: () => directory,
      dataStore,
      now: () => clock++,
    });
    await store.initialize();
    const operationInput = operation();
    await store.startOperation(operationInput);
    const input = effect(operationInput);
    await store.prepareEffect(input);
    await store.markEffectDispatchStarted(effectOwner(input));
    failWrites = true;
    await assert.rejects(
      () =>
        store.finishEffect({
          ...effectOwner(input),
          state: "completed",
          terminalDigest: piRuntimeTerminalDigest("result"),
        }),
      /simulated terminal write failure/u,
    );
    assert.equal((await store.getEffect(effectOwner(input)))?.state, "unknown");

    const restarted = makeStore(directory, 100);
    await restarted.initialize();
    assert.equal((await restarted.getEffect(effectOwner(input)))?.state, "unknown");
  });
});

test("unknown effects are never evicted under pressure but explicit chat deletion removes them", async () => {
  await withTempDirectory(async (directory) => {
    const argumentDigest = snapshotPiRuntimeEffectArguments({ value: 1 }).digest;
    const operations: DurablePiRuntimeOperation[] = [];
    const effects: DurablePiRuntimeEffect[] = [];
    for (let index = 0; index < MAX_PI_RUNTIME_OPERATIONS; index += 1) {
      const operationId = `operation-${index}`;
      const runId = `run-${index}`;
      const chatId = `chat-${index}`;
      operations.push({
        version: 1,
        operationId,
        runId,
        sessionId: `session-${index}`,
        chatId,
        lane: "child",
        contributionRevision: index,
        state: "interrupted",
        startedAt: 1,
        updatedAt: 2,
      });
      effects.push({
        version: 1,
        effectId: `effect-${index}`,
        operationId,
        runId,
        sessionId: `session-${index}`,
        chatId,
        lane: "child",
        turnId: `turn-${index}`,
        toolCallId: `call-${index}`,
        toolName: "write",
        replay: "never",
        state: "unknown",
        argumentDigest,
        preparedAt: 1,
        updatedAt: 2,
        terminalDigest: piRuntimeTerminalDigest(`unknown-${index}`),
      });
    }
    const database: DurablePiRuntimeEffectDatabase = {
      version: 1,
      revision: 1,
      operations,
      effects,
    };
    assert.ok(parseDurablePiRuntimeEffectDatabase(database));
    await writeFile(path.join(directory, STORE_NAME), JSON.stringify(database));

    const store = makeStore(directory, 10);
    await store.initialize();
    await assert.rejects(
      () => store.startOperation(operation("overflow", "overflow-chat")),
      /history is at capacity/u,
    );
    assert.equal((await store.listEffectsByChat("chat-0"))[0]?.state, "unknown");
    await store.deleteChat("chat-0");
    assert.deepEqual(await store.listEffectsByChat("chat-0"), []);
    assert.deepEqual(await store.listOperationsByChat("chat-0"), []);
    await store.startOperation(operation("replacement", "replacement-chat"));
  });
});

test("chat deletion rejects live work and then explicitly deletes terminal unknown records", async () => {
  await withTempDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.initialize();
    const operationInput = operation();
    await store.startOperation(operationInput);
    const input = effect(operationInput);
    await store.prepareEffect(input);
    await store.markEffectDispatchStarted(effectOwner(input));
    await assert.rejects(() => store.deleteChat(operationInput.chatId), /active durable effects/u);
    await store.finishEffect({
      ...effectOwner(input),
      state: "unknown",
      terminalDigest: piRuntimeTerminalDigest("host-lost-result"),
    });
    await store.finishOperation(operationInput.operationId, "interrupted");
    await store.deleteChat(operationInput.chatId);
    assert.deepEqual(await store.listEffectsByChat(operationInput.chatId), []);
    assert.deepEqual(await store.listOperationsByChat(operationInput.chatId), []);
  });
});

test("startup reconciliation removes orphan effect history but retains visible chats", async () => {
  await withTempDirectory(async (directory) => {
    const store = makeStore(directory);
    await store.initialize();
    for (const [operationId, chatId] of [
      ["kept-operation", "kept-chat"],
      ["orphan-operation", "orphan-chat"],
    ] as const) {
      const input = operation(operationId, chatId);
      await store.startOperation(input);
      await store.finishOperation(operationId, "completed");
    }

    await store.reconcileChats(new Set(["kept-chat"]));
    assert.equal((await store.listOperationsByChat("kept-chat")).length, 1);
    assert.deepEqual(await store.listOperationsByChat("orphan-chat"), []);
  });
});

test("corrupt and unsupported stores are rejected without overwriting their bytes", async () => {
  await withTempDirectory(async (directory) => {
    const filename = path.join(directory, STORE_NAME);
    const corrupt = "{not-json";
    await writeFile(filename, corrupt);
    await assert.rejects(() => makeStore(directory).initialize(), /unreadable/u);
    assert.equal(await readFile(filename, "utf8"), corrupt);

    await rm(filename);
    const unsupported = JSON.stringify({ version: 2, revision: 0, operations: [], effects: [] });
    await writeFile(filename, unsupported);
    await assert.rejects(() => makeStore(directory).initialize(), /unsupported shape/u);
    assert.equal(await readFile(filename, "utf8"), unsupported);
  });
});

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  executeAidenDurableOperation,
  type AidenDurableOperationOwner,
} from "./aiden-remote-durable-operation.js";
import {
  AidenIdempotencyLedger,
  AidenOperationContractError,
  AidenOperationNotExecutedError,
  AidenOperationUnknownOutcomeError,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";
import {
  advanceAidenOperation,
  type AidenOperationEvent,
  type AidenOperationPhase,
} from "./aiden-remote-operation-state.js";
import {
  aidenRemoteOperationStoreOptions,
  openAidenRemoteOperationLedger,
} from "./aiden-remote-operation-store.js";

const SCOPE = { deviceId: "device-1", route: "POST /things", resourceId: "thing-1", key: "operation-key-0001" };
const MESSAGES = { notPreparedMessage: "not prepared", outcomeUnrecordedMessage: "outcome unrecorded" };

function code(expected: string) {
  return (error: unknown) => (error as { code?: string }).code === expected;
}

async function operationStore(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-durable-operation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const open = () =>
    new DataStore<AidenIdempotencySnapshot>(
      "operations.json",
      new AidenIdempotencyLedger().snapshot(),
      () => directory,
      aidenRemoteOperationStoreOptions(),
    );
  return { directory, open };
}

function owner(
  ledger: AidenIdempotencyLedger,
  persist: (snapshot: AidenIdempotencySnapshot) => Promise<void>,
): AidenDurableOperationOwner {
  return { ledger, persist, ...MESSAGES };
}

test("a lost response replays the stored result from disk without running the effect again", async (t) => {
  const { open } = await operationStore(t);
  const firstStore = open();
  const first = await openAidenRemoteOperationLedger(firstStore);
  let effects = 0;
  const action = async () => ({ effect: (effects += 1) });

  const original = await executeAidenDurableOperation(
    owner(first, (snapshot) => firstStore.save(snapshot)),
    SCOPE,
    { name: "same" },
    action,
  );

  const restartedStore = open();
  const restarted = await openAidenRemoteOperationLedger(restartedStore);
  const replay = await executeAidenDurableOperation(
    owner(restarted, (snapshot) => restartedStore.save(snapshot)),
    SCOPE,
    { name: "same" },
    action,
  );
  assert.deepEqual(replay, original);
  assert.equal(effects, 1);
});

test("the same key with a changed body is refused before and after a restart", async (t) => {
  const { open } = await operationStore(t);
  const store = open();
  const ledger = await openAidenRemoteOperationLedger(store);
  let effects = 0;
  const action = async () => (effects += 1);
  await executeAidenDurableOperation(owner(ledger, (snapshot) => store.save(snapshot)), SCOPE, { name: "a" }, action);

  await assert.rejects(
    executeAidenDurableOperation(owner(ledger, (snapshot) => store.save(snapshot)), SCOPE, { name: "b" }, action),
    code("idempotency_conflict"),
  );
  const restartedStore = open();
  const restarted = await openAidenRemoteOperationLedger(restartedStore);
  await assert.rejects(
    executeAidenDurableOperation(owner(restarted, (snapshot) => restartedStore.save(snapshot)), SCOPE, { name: "b" }, action),
    code("idempotency_conflict"),
  );
  assert.equal(effects, 1);
});

test("a crash between the admission write and the outcome write leaves an unknown that never re-runs", async (t) => {
  const { open } = await operationStore(t);
  const store = open();
  const ledger = await openAidenRemoteOperationLedger(store);
  let effects = 0;
  let crash!: () => void;
  const effectRan = new Promise<void>((resolve) => {
    crash = resolve;
  });
  // The process dies with the action in progress: only the admission reached disk.
  void executeAidenDurableOperation(owner(ledger, (snapshot) => store.save(snapshot)), SCOPE, {}, async () => {
    effects += 1;
    crash();
    return new Promise<never>(() => undefined);
  });
  await effectRan;

  const restartedStore = open();
  const restarted = await openAidenRemoteOperationLedger(restartedStore);
  assert.equal(restarted.snapshot().entries[0]?.state, "in_flight");
  await assert.rejects(
    executeAidenDurableOperation(owner(restarted, (snapshot) => restartedStore.save(snapshot)), SCOPE, {}, async () => {
      effects += 1;
    }),
    code("idempotency_in_flight"),
  );
  assert.equal(effects, 1);
});

test("an outcome that could not be written reports unknown, and the crash after it stays unknown", async (t) => {
  const { open } = await operationStore(t);
  const store = open();
  const ledger = await openAidenRemoteOperationLedger(store);
  let saves = 0;
  let effects = 0;
  await assert.rejects(
    executeAidenDurableOperation(
      owner(ledger, async (snapshot) => {
        saves += 1;
        if (saves === 2) throw new Error("disk lost");
        await store.save(snapshot);
      }),
      SCOPE,
      {},
      async () => (effects += 1),
    ),
    code("idempotency_in_flight"),
  );

  const restartedStore = open();
  const restarted = await openAidenRemoteOperationLedger(restartedStore);
  await assert.rejects(
    executeAidenDurableOperation(owner(restarted, (snapshot) => restartedStore.save(snapshot)), SCOPE, {}, async () => {
      effects += 1;
    }),
    code("idempotency_in_flight"),
  );
  assert.equal(effects, 1);
});

test("a failed admission write runs nothing, keeps no record, and frees the key", async (t) => {
  const { open } = await operationStore(t);
  const store = open();
  const ledger = await openAidenRemoteOperationLedger(store);
  let saves = 0;
  let effects = 0;
  const durable = owner(ledger, async (snapshot) => {
    saves += 1;
    if (saves === 1) throw new Error("disk full");
    await store.save(snapshot);
  });
  await assert.rejects(
    executeAidenDurableOperation(durable, SCOPE, {}, async () => (effects += 1)),
    (error: unknown) => (error as Error).message === MESSAGES.notPreparedMessage && code("internal_error")(error),
  );
  assert.equal(effects, 0);
  assert.equal(ledger.snapshot().entries.length, 0);

  assert.equal(await executeAidenDurableOperation(durable, SCOPE, {}, async () => (effects += 1)), 1);
  assert.equal(effects, 1);
});

test("requests joined to a refused admission fail with it, and the next one runs once", async () => {
  const ledger = new AidenIdempotencyLedger();
  let effects = 0;
  let releaseSave!: (error: Error) => void;
  const saveGate = new Promise<void>((_resolve, reject) => {
    releaseSave = reject;
  });
  let saves = 0;
  const durable = owner(ledger, async () => {
    saves += 1;
    if (saves === 1) await saveGate;
  });
  const action = async () => (effects += 1);

  const first = executeAidenDurableOperation(durable, SCOPE, {}, action);
  const joined = executeAidenDurableOperation(durable, SCOPE, {}, action);
  releaseSave(new Error("disk full"));
  await assert.rejects(first, code("internal_error"));
  await assert.rejects(joined, code("internal_error"));
  assert.equal(effects, 0);

  assert.equal(await executeAidenDurableOperation(durable, SCOPE, {}, action), 1);
  assert.equal(effects, 1);
});

test("a request joined to a running action reports that action's result, whatever its own disk does", async () => {
  const ledger = new AidenIdempotencyLedger();
  let finish!: (value: string) => void;
  let effects = 0;
  let announceStart!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const running = executeAidenDurableOperation(owner(ledger, async () => undefined), SCOPE, {}, () => {
    effects += 1;
    announceStart();
    return new Promise<string>((done) => {
      finish = done;
    });
  });
  await started;
  const brokenDisk = owner(ledger, async () => {
    throw new Error("disk full");
  });
  const joined = executeAidenDurableOperation(brokenDisk, SCOPE, {}, async () => {
    effects += 1;
    return "must not run";
  });
  finish("committed");
  assert.equal(await running, "committed");
  assert.equal(await joined, "committed");
  assert.equal(effects, 1);
});

test("a join or replay during the outcome write learns what the owner learns", async () => {
  const ledger = new AidenIdempotencyLedger();
  let saves = 0;
  let failOutcome!: (error: Error) => void;
  let outcomeWriteStarted!: () => void;
  const writing = new Promise<void>((resolve) => {
    outcomeWriteStarted = resolve;
  });
  const durable = owner(ledger, async () => {
    saves += 1;
    if (saves === 2) {
      outcomeWriteStarted();
      await new Promise<void>((_resolve, reject) => {
        failOutcome = reject;
      });
    }
  });
  let effects = 0;
  let finish!: (value: string) => void;
  let announceStart!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const action = () => {
    effects += 1;
    announceStart();
    return new Promise<string>((done) => {
      finish = done;
    });
  };
  const first = executeAidenDurableOperation(durable, SCOPE, {}, action);
  await started;
  const joined = executeAidenDurableOperation(durable, SCOPE, {}, action);
  finish("committed");
  await writing;
  const replay = executeAidenDurableOperation(durable, SCOPE, {}, action);
  failOutcome(new Error("disk lost"));

  await assert.rejects(first, code("idempotency_in_flight"));
  await assert.rejects(joined, code("idempotency_in_flight"));
  await assert.rejects(replay, code("idempotency_in_flight"));
  assert.equal(effects, 1);
});

/** A disk whose numbered writes can be held open and then released or failed. */
function heldWrites(...numbers: number[]) {
  const held = new Map(
    numbers.map((number) => {
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      let fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      return [number, { reached, arrived, release, fail, finished }] as const;
    }),
  );
  let saves = 0;
  return {
    write: (number: number) => held.get(number)!,
    persist: async () => {
      saves += 1;
      const write = held.get(saves);
      if (!write) return;
      write.reached();
      await write.finished;
    },
  };
}

test("a replay of a rejection waits for the owner to record it", async () => {
  const ledger = new AidenIdempotencyLedger();
  const disk = heldWrites(2);
  const durable = owner(ledger, disk.persist);
  const refused = new AidenRemoteServiceError("not_found", "refused", 403);

  const first = executeAidenDurableOperation(durable, SCOPE, {}, async () => {
    throw refused;
  });
  const firstAnswer = assert.rejects(first, code("idempotency_in_flight"));
  await disk.write(2).arrived;
  const replay = executeAidenDurableOperation(durable, SCOPE, {}, async () => "unused");
  const replayAnswer = assert.rejects(replay, code("idempotency_in_flight"));
  disk.write(2).fail(new Error("disk lost"));

  await firstAnswer;
  await replayAnswer;
});

test("a request with other input still conflicts while a rejection is being recorded", async () => {
  const ledger = new AidenIdempotencyLedger();
  const disk = heldWrites(2);
  const durable = owner(ledger, disk.persist);

  const first = executeAidenDurableOperation(durable, SCOPE, { value: 1 }, async () => {
    throw new AidenRemoteServiceError("not_found", "refused", 403);
  });
  const firstAnswer = assert.rejects(first, code("not_found"));
  await disk.write(2).arrived;
  await assert.rejects(
    executeAidenDurableOperation(durable, SCOPE, { value: 2 }, async () => "unused"),
    code("idempotency_conflict"),
  );
  disk.write(2).release();
  await firstAnswer;
});

test("an earlier owner finishing cannot expose a later owner's unrecorded outcome", async () => {
  const ledger = new AidenIdempotencyLedger();
  const disk = heldWrites(2, 4);
  const durable = owner(ledger, disk.persist);
  const unavailable = new AidenRemoteServiceError("not_found", "not run", 403);

  const earlier = executeAidenDurableOperation(durable, SCOPE, {}, async () => {
    throw new AidenOperationNotExecutedError(unavailable);
  });
  const earlierAnswer = assert.rejects(earlier, code("not_found"));
  await disk.write(2).arrived;

  let effects = 0;
  const later = executeAidenDurableOperation(durable, SCOPE, {}, async () => {
    effects += 1;
    return "committed";
  });
  const laterAnswer = assert.rejects(later, code("idempotency_in_flight"));
  disk.write(2).release();
  await earlierAnswer;
  await disk.write(4).arrived;

  const replay = executeAidenDurableOperation(durable, SCOPE, {}, async () => "unused");
  const replayAnswer = assert.rejects(replay, code("idempotency_in_flight"));
  disk.write(4).fail(new Error("disk lost"));

  await laterAnswer;
  await replayAnswer;
  assert.equal(effects, 1);
});

test("a replay reports the settled outcome and writes nothing", async () => {
  const ledger = new AidenIdempotencyLedger();
  let failing = false;
  let saves = 0;
  let effects = 0;
  const durable = owner(ledger, async () => {
    saves += 1;
    if (failing) throw new Error("disk full");
  });
  const action = async () => ({ effect: (effects += 1) });
  const original = await executeAidenDurableOperation(durable, SCOPE, {}, action);
  const written = saves;

  failing = true;
  assert.deepEqual(await executeAidenDurableOperation(durable, SCOPE, {}, action), original);
  assert.equal(saves, written);
  assert.equal(effects, 1);
});

test("an outcome that could not be written stays unknown past the replay window in the same process", async () => {
  let now = 1_000;
  const ledger = new AidenIdempotencyLedger(undefined, { ttlMs: 100, now: () => now });
  let saves = 0;
  let effects = 0;
  const durable = owner(ledger, async () => {
    saves += 1;
    if (saves === 2) throw new Error("disk lost");
  });
  const action = async () => (effects += 1);
  await assert.rejects(executeAidenDurableOperation(durable, SCOPE, {}, action), code("idempotency_in_flight"));
  // What the caller was told holds immediately, and after the window.
  await assert.rejects(executeAidenDurableOperation(durable, SCOPE, {}, action), code("idempotency_in_flight"));
  now += 1_000;
  await assert.rejects(executeAidenDurableOperation(durable, SCOPE, {}, action), code("idempotency_in_flight"));
  assert.equal(effects, 1);
});

test("a falsy action failure still reaches the caller after its outcome is written", async () => {
  const ledger = new AidenIdempotencyLedger();
  const failure = await executeAidenDurableOperation(owner(ledger, async () => undefined), SCOPE, {}, async () => {
    throw 0;
  }).then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.equal(failure, 0);
});

/** Deterministic Mulberry32: a failing seed reproduces the exact event order. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Ending = "fulfil" | "reject" | "unknown" | "not_executed";

test("generated request, failure and restart orders never run a key twice or forget an unknown", async () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = seededRandom(seed);
    let snapshotOnDisk = new AidenIdempotencyLedger().snapshot();
    let ledger = new AidenIdempotencyLedger(snapshotOnDisk);
    let committedEffects = 0;
    let unknownSeen = false;
    let settled: "fulfilled" | "rejected" | undefined;
    const label = `seed ${seed}`;

    for (let step = 0; step < 12; step += 1) {
      if (random() < 0.25) {
        // A restart keeps only what reached the disk.
        ledger = new AidenIdempotencyLedger(snapshotOnDisk);
        continue;
      }
      const failAdmission = random() < 0.2;
      const failOutcome = random() < 0.2;
      const endings: Ending[] = ["fulfil", "reject", "unknown", "not_executed"];
      const ending = endings[Math.floor(random() * endings.length)]!;
      let saves = 0;
      const durable = owner(ledger, async (snapshot) => {
        saves += 1;
        if ((saves === 1 && failAdmission) || (saves === 2 && failOutcome)) throw new Error("disk");
        snapshotOnDisk = structuredClone(snapshot);
      });
      let ranNow = false;
      const outcome = await executeAidenDurableOperation(durable, SCOPE, {}, async () => {
        ranNow = true;
        if (ending === "not_executed") throw new AidenOperationNotExecutedError(new Error("refused"));
        committedEffects += 1;
        if (ending === "reject") throw new AidenOperationContractError("revision_conflict");
        if (ending === "unknown") throw new AidenOperationUnknownOutcomeError();
        return "done";
      }).then(
        () => "ok" as const,
        () => "failed" as const,
      );

      if (ranNow) {
        // Only a fresh key may run, so nothing durable or live may have preceded it.
        assert.equal(unknownSeen, false, `${label}: an unknown outcome was re-executed`);
        assert.equal(settled, undefined, `${label}: a settled outcome was re-executed`);
      }
      if (ranNow && ending !== "not_executed") {
        // The effect happened. Whatever the record says, this key may never run again.
        if (ending === "unknown" || failOutcome) unknownSeen = true;
        else settled = ending === "fulfil" ? "fulfilled" : "rejected";
      }
      if (settled === "fulfilled" && !unknownSeen && !failAdmission && !failOutcome) {
        assert.equal(outcome, "ok", `${label}: a settled result stopped replaying`);
      }
      assert.ok(committedEffects <= 1, `${label}: the effect ran ${committedEffects} times`);
    }
  }
});

test("only reconciliation leaves unknown, and only a failed write unsettles an outcome", () => {
  const events: AidenOperationEvent<string>[] = [
    { type: "action_fulfilled", value: "late", expiresAt: 9 },
    { type: "action_rejected", errorCode: "internal_error", expiresAt: 9 },
    { type: "outcome_lost" },
    { type: "reconciled_fulfilled", value: "late", expiresAt: 9 },
    { type: "reconciled_rejected", errorCode: "internal_error", expiresAt: 9 },
  ];
  const settled: AidenOperationPhase<string>[] = [
    { kind: "fulfilled", value: "first", expiresAt: 1 },
    { kind: "rejected", errorCode: "revision_conflict", expiresAt: 1 },
  ];
  for (const phase of settled) {
    for (const event of events) assert.deepEqual(advanceAidenOperation(phase, event), phase, event.type);
  }
  for (const phase of settled) {
    assert.equal(advanceAidenOperation(phase, { type: "outcome_unrecorded" }).kind, "unknown");
  }
  const unknown: AidenOperationPhase<string> = { kind: "unknown" };
  assert.deepEqual(
    events.map((event) => advanceAidenOperation(unknown, event).kind),
    ["unknown", "unknown", "unknown", "fulfilled", "rejected"],
  );
  const executing: AidenOperationPhase<string> = { kind: "executing", result: Promise.resolve() };
  assert.deepEqual(
    events.map((event) => advanceAidenOperation(executing, event).kind),
    ["fulfilled", "rejected", "unknown", "executing", "executing"],
  );
});

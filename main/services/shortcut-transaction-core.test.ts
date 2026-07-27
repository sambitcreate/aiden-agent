import assert from "node:assert/strict";
import test from "node:test";
import {
  createShortcutTransactionQueue,
  ShortcutPersistenceRollbackError,
} from "./shortcut-transaction-core";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("serializes read, apply, and persistence so concurrent mutations cannot lose updates", async () => {
  const queue = createShortcutTransactionQueue<Record<string, number>, string>();
  let disk: Record<string, number> = {};
  let runtime: Record<string, number> = {};
  const firstWrite = deferred();
  const startedFirstWrite = deferred();

  const mutate = (key: string, value: number, wait?: Promise<void>) =>
    queue.transact({
      read: async () => ({ ...disk }),
      prepare: (previous) => {
        const next = { ...previous, [key]: value };
        return {
          next,
          value: key,
          persist: async () => {
            if (wait) {
              startedFirstWrite.resolve();
              await wait;
            }
            disk = { ...next };
          },
        };
      },
      apply: async (next) => {
        runtime = { ...next };
        return JSON.stringify(next);
      },
    });

  const first = mutate("focus", 1, firstWrite.promise);
  await startedFirstWrite.promise;
  const second = mutate("assistant", 2);
  firstWrite.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(disk, { focus: 1, assistant: 2 });
  assert.deepEqual(runtime, disk);
});

test("a failed persistence rollback completes before the next successful transaction", async () => {
  const queue = createShortcutTransactionQueue<Record<string, number>, void>();
  let disk: Record<string, number> = { original: 1 };
  let runtime: Record<string, number> = { ...disk };
  const operations: string[] = [];

  const failed = queue.transact({
    read: async () => ({ ...disk }),
    prepare: (previous) => ({
      next: { ...previous, failed: 1 },
      value: undefined,
      persist: async () => {
        operations.push("persist failed");
        throw new Error("disk full");
      },
    }),
    apply: async (next) => {
      runtime = { ...next };
      operations.push(`apply ${Object.keys(next).join(",")}`);
    },
  });
  const successful = queue.transact({
    read: async () => ({ ...disk }),
    prepare: (previous) => {
      const next = { ...previous, successful: 1 };
      return {
        next,
        value: undefined,
        persist: async () => {
          disk = { ...next };
          operations.push("persist successful");
        },
      };
    },
    apply: async (next) => {
      runtime = { ...next };
      operations.push(`apply ${Object.keys(next).join(",")}`);
    },
  });

  await assert.rejects(failed, /disk full/);
  await successful;
  assert.deepEqual(runtime, { original: 1, successful: 1 });
  assert.deepEqual(runtime, disk);
  assert.deepEqual(operations, [
    "apply original,failed",
    "persist failed",
    "apply original",
    "apply original,successful",
    "persist successful",
  ]);
});

test("reports both persistence and rollback failures when runtime cannot be restored", async () => {
  const queue = createShortcutTransactionQueue<number, void>();
  let applyCount = 0;
  const transaction = queue.transact({
    read: async () => 1,
    prepare: () => ({
      next: 2,
      value: undefined,
      persist: async () => {
        throw new Error("disk full");
      },
    }),
    apply: async () => {
      applyCount += 1;
      if (applyCount === 2) throw new Error("accelerator unavailable");
    },
  });

  await assert.rejects(
    transaction,
    (error) =>
      error instanceof ShortcutPersistenceRollbackError &&
      error.message.includes("disk full") &&
      error.message.includes("accelerator unavailable"),
  );
});

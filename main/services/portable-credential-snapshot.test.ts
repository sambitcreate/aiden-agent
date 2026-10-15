import assert from "node:assert/strict";
import test from "node:test";
import {
  mutatePortableConfigAndSync,
  setPortableCredentialSnapshotListener,
} from "./portable-credential-snapshot.js";

// Ordering and self-deadlock behavior live in portable-config-watch-core.test.ts;
// these cover cross-mutation serialization and failure handling.

test("concurrent portable mutations run one at a time, each bracketed by its own sync", async () => {
  const events: string[] = [];
  setPortableCredentialSnapshotListener(async () => {
    events.push("sync");
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const first = mutatePortableConfigAndSync(async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
    return 1;
  });
  const second = mutatePortableConfigAndSync(async () => {
    events.push("second");
    return 2;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("second"), false, "the second mutation waits for the first");

  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["sync", "first:start", "first:end", "sync", "sync", "second", "sync"]);
});

test("a failed mutation rejects to its caller without wedging the queue", async () => {
  let syncs = 0;
  setPortableCredentialSnapshotListener(async () => {
    syncs += 1;
  });

  await assert.rejects(
    mutatePortableConfigAndSync(async () => {
      throw new Error("save failed");
    }),
    /save failed/,
  );
  // The pre-mutation baseline ran; reconciliation is skipped for a write that never landed.
  assert.equal(syncs, 1);

  assert.equal(await mutatePortableConfigAndSync(async () => "next"), "next");
  assert.equal(syncs, 3);
});

test("a failing snapshot sync fails the mutation and the next mutation still runs", async () => {
  let failNext = true;
  let mutations = 0;
  setPortableCredentialSnapshotListener(async () => {
    if (failNext) {
      failNext = false;
      throw new Error("snapshot unreadable");
    }
  });

  await assert.rejects(
    mutatePortableConfigAndSync(async () => {
      mutations += 1;
    }),
    /snapshot unreadable/,
  );
  // The baseline sync failed first, so the mutation must not have run on an unknown baseline.
  assert.equal(mutations, 0);

  await mutatePortableConfigAndSync(async () => {
    mutations += 1;
  });
  assert.equal(mutations, 1);
});

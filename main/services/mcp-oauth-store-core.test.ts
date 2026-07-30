import assert from "node:assert/strict";
import test from "node:test";
import { commitOwnedMutation } from "./mcp-oauth-store-core.js";

test("an OAuth mutation whose owner is already stale never publishes", async () => {
  let published = false;
  await assert.rejects(
    commitOwnedMutation({
      isCurrent: () => false,
      publish: async () => {
        published = true;
      },
      rollback: async () => undefined,
    }),
    /changed while this operation/u,
  );
  assert.equal(published, false);
});

test("an OAuth owner invalidated during publication rolls the durable state back", async () => {
  let current = true;
  const events: string[] = [];
  await assert.rejects(
    commitOwnedMutation({
      isCurrent: () => current,
      publish: async () => {
        events.push("publish");
        current = false;
      },
      rollback: async () => {
        events.push("rollback");
      },
    }),
    /changed while this operation/u,
  );
  assert.deepEqual(events, ["publish", "rollback"]);
});

test("a current OAuth owner commits without rollback", async () => {
  const events: string[] = [];
  await commitOwnedMutation({
    isCurrent: () => true,
    publish: async () => {
      events.push("publish");
    },
    rollback: async () => {
      events.push("rollback");
    },
  });
  assert.deepEqual(events, ["publish"]);
});

test("a partially failed OAuth publication restores its predecessor", async () => {
  const failure = new Error("directory sync failed");
  const events: string[] = [];
  await assert.rejects(
    commitOwnedMutation({
      isCurrent: () => true,
      publish: async () => {
        events.push("publish");
        throw failure;
      },
      rollback: async () => {
        events.push("rollback");
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["publish", "rollback"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteChatGenerationOwner } from "./chat-generation-owner.js";

test("remote generation ownership survives delivery disconnects until explicit invalidation", () => {
  const delivered: Array<[string, unknown]> = [];
  let transportAvailable = true;
  const remote = createRemoteChatGenerationOwner({
    deviceId: "paired-device-secret-shaped-id",
    streamId: "stream-1",
    publish: (channel, payload) => {
      if (!transportAvailable) throw new Error("subscriber disconnected");
      delivered.push([channel, payload]);
    },
  });

  assert.equal(remote.owner.id, 0);
  assert.equal(remote.owner.documentId.includes("paired-device-secret-shaped-id"), false);
  remote.owner.send("chat:delta", { delta: "hello" });
  assert.deepEqual(delivered, [["chat:delta", { delta: "hello" }]]);

  transportAvailable = false;
  assert.throws(() => remote.owner.send("chat:delta", { delta: "offline" }), /disconnected/u);
  assert.equal(remote.owner.isDestroyed(), false);

  let invalidations = 0;
  const remove = remote.owner.onInvalidated(() => { invalidations += 1; });
  remote.invalidate();
  remote.invalidate();
  remove();
  assert.equal(invalidations, 1);
  assert.equal(remote.owner.isDestroyed(), true);
  assert.throws(
    () => remote.owner.send("chat:done", { streamId: "stream-1" }),
    /no longer active/u,
  );
});

test("remote generation owners reject unbounded identities", () => {
  assert.throws(
    () => createRemoteChatGenerationOwner({ deviceId: "", streamId: "stream", publish: () => undefined }),
    /device identity/u,
  );
  assert.throws(
    () => createRemoteChatGenerationOwner({
      deviceId: "device",
      streamId: "s".repeat(129),
      publish: () => undefined,
    }),
    /stream identity/u,
  );
});

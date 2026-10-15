import assert from "node:assert/strict";
import test from "node:test";
import { AidenAppNavigation } from "./aiden-app-navigation.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";

test("navigation acknowledges only its requesting live document and closed destination", async () => {
  const navigation = new AidenAppNavigation();
  let payload: { requestId: string; path: string } | undefined;
  const owner: ChatGenerationOwner = {
    id: 7,
    documentId: "doc",
    isDestroyed: () => false,
    onInvalidated: () => () => {},
    send: (_channel, value) => {
      payload = value as typeof payload;
    },
  };
  const result = navigation.open("web-search", owner);
  assert.equal(payload?.path, "/settings?section=websearch");
  assert.equal(
    navigation.acknowledge(payload?.requestId, "opened", { ...owner, documentId: "other" }),
    false,
  );
  assert.equal(navigation.acknowledge(payload?.requestId, "opened", owner), true);
  assert.deepEqual(await result, { status: "opened", destination: "web-search" });
  assert.equal(navigation.acknowledge(payload?.requestId, "opened", owner), false);
  await assert.rejects(navigation.open("https://example.test", owner), /Unknown/);
  assert.equal(
    (await navigation.open("memory", { ...owner, kind: "remote" })).status,
    "unavailable",
  );
});
test("document invalidation cannot be reported as successful navigation", async () => {
  const navigation = new AidenAppNavigation();
  let invalidate = () => {};
  const result = navigation.open("appearance", {
    id: 1,
    documentId: "doc",
    isDestroyed: () => false,
    send() {},
    onInvalidated: (listener) => {
      invalidate = listener;
      return () => {};
    },
  });
  invalidate();
  assert.equal((await result).status, "unavailable");
});

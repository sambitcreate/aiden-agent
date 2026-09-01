import assert from "node:assert/strict";
import test from "node:test";
import { BtwOperationRegistry } from "./operation-registry.js";

test("BTW registry enforces per-chat/global admission and owner-fenced cancellation", async () => {
  const registry = new BtwOperationRegistry(2);
  const first = new AbortController();
  const second = new AbortController();
  const releaseFirst = registry.reserve("chat-a", "request-a", "document-a", first);
  const releaseSecond = registry.reserve("chat-b", "request-b", "document-b", second);
  assert.ok(releaseFirst);
  assert.ok(releaseSecond);
  assert.equal(registry.reserve("chat-a", "other", "document-a", new AbortController()), null);
  assert.equal(registry.reserve("chat-c", "request-c", "document-c", new AbortController()), null);
  assert.equal(registry.cancel("chat-a", "request-a", "wrong-document"), false);
  assert.equal(first.signal.aborted, false);
  assert.equal(registry.cancel("chat-a", "request-a", "document-a"), true);
  assert.equal(first.signal.aborted, true);
  releaseFirst?.();
  const third = registry.reserve("chat-c", "request-c", "document-c", new AbortController());
  assert.ok(third);
  releaseSecond?.();
  third?.();
});

test("foreground transition aborts only the matching side request", () => {
  const registry = new BtwOperationRegistry(2);
  const first = new AbortController();
  const second = new AbortController();
  const releaseFirst = registry.reserve("chat-a", "request-a", "document-a", first)!;
  const releaseSecond = registry.reserve("chat-b", "request-b", "document-b", second)!;
  assert.equal(registry.abortForForeground("chat-a"), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  releaseFirst();
  releaseSecond();
});

test("chat deletion detaches a provider that ignores abort after a bounded grace", async () => {
  const registry = new BtwOperationRegistry(1);
  const controller = new AbortController();
  const releaseLate = registry.reserve("chat-a", "request-a", "document-a", controller)!;

  assert.equal(await registry.cancelAndSettle("chat-a", 5), false);
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.has("chat-a"), false);
  assert.equal(registry.isCurrent("chat-a", "request-a"), false);

  const next = new AbortController();
  const releaseNext = registry.reserve("chat-a", "request-b", "document-b", next);
  assert.ok(releaseNext);
  releaseLate();
  assert.equal(registry.isCurrent("chat-a", "request-b"), true);
  releaseNext();
});

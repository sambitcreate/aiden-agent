import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAnnotation } from "../shared/browser.js";
import { BrowserAnnotationDeliveryRegistry } from "./browser-annotation-delivery.js";

const annotation: BrowserAnnotation = { url: "http://localhost/", comment: "Please update this", elements: [], regions: [], strokes: [] };

test("an absent composer, including a question replacing it, cannot acknowledge delivery", () => {
  const registry = new BrowserAnnotationDeliveryRegistry();
  assert.equal(registry.capture("workspace"), null);
  registry.register({ workspaceId: "workspace", chatId: "chat", available: () => false, receive: () => { assert.fail("hidden composer received context"); } });
  assert.equal(registry.capture("workspace"), null);
});

test("a selected visible composer acknowledges exactly one draft write", () => {
  const registry = new BrowserAnnotationDeliveryRegistry();
  const received: BrowserAnnotation[] = [];
  registry.register({ workspaceId: "workspace", chatId: "chat", available: () => true, receive: (value) => { received.push(value); return true; } });
  assert.equal(registry.capture("other-workspace"), null);
  const recipient = registry.capture("workspace")!;
  assert.equal(recipient.chatId, "chat");
  assert.equal(recipient.deliver(annotation), true);
  assert.equal(recipient.deliver(annotation), false);
  assert.deepEqual(received, [annotation]);
});

test("composer replacement during async preparation retains the selection instead of rerouting it", async () => {
  const registry = new BrowserAnnotationDeliveryRegistry();
  let writes = 0;
  const unregister = registry.register({ workspaceId: "workspace", chatId: "first", available: () => true, receive: () => { writes += 1; return true; } });
  const recipient = registry.capture("workspace")!;
  const prepared = Promise.resolve(annotation);
  unregister();
  registry.register({ workspaceId: "workspace", chatId: "second", available: () => true, receive: () => { writes += 1; return true; } });
  assert.equal(recipient.deliver(await prepared), false);
  assert.equal(writes, 0);
  // A new, explicit user attempt can select the newly mounted composer.
  assert.equal(registry.capture("workspace")!.deliver(annotation), true);
  assert.equal(writes, 1);
});

test("an in-flight recipient must still be visible and writable when main returns", () => {
  const registry = new BrowserAnnotationDeliveryRegistry();
  let available = true;
  let writes = 0;
  registry.register({ workspaceId: "workspace", chatId: "chat", available: () => available, receive: () => { writes += 1; return true; } });
  const recipient = registry.capture("workspace")!;
  available = false;
  assert.equal(recipient.deliver(annotation), false);
  assert.equal(writes, 0);
});

test("multiple eligible composers fail closed and a declined receipt is not success", () => {
  const registry = new BrowserAnnotationDeliveryRegistry();
  registry.register({ workspaceId: "workspace", chatId: "one", available: () => true, receive: () => false });
  const removeSecond = registry.register({ workspaceId: "workspace", chatId: "two", available: () => true, receive: () => true });
  assert.equal(registry.capture("workspace"), null);
  removeSecond();
  assert.equal(registry.capture("workspace")!.deliver(annotation), false);
});

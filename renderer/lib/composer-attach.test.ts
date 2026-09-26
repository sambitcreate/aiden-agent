import assert from "node:assert/strict";
import test from "node:test";
import { ComposerImageAttachRegistry } from "./composer-attach.js";

const png = () => new File([new Uint8Array([0x89, 0x50])], "screenshot.png", { type: "image/png" });

test("images reach the single available composer for that chat", () => {
  const registry = new ComposerImageAttachRegistry();
  const received: string[] = [];
  registry.register({ chatId: "a", available: () => true, receive: () => received.push("a") });
  registry.register({ chatId: "b", available: () => true, receive: () => received.push("b") });
  assert.equal(registry.deliver("b", [png()]), true);
  assert.deepEqual(received, ["b"]);
});

test("delivery refuses missing, hidden, duplicate, or empty targets", () => {
  const registry = new ComposerImageAttachRegistry();
  let received = 0;
  const receive = () => {
    received += 1;
  };
  assert.equal(registry.deliver("a", [png()]), false);
  const hidden = registry.register({ chatId: "a", available: () => false, receive });
  assert.equal(registry.deliver("a", [png()]), false);
  hidden();
  registry.register({ chatId: "a", available: () => true, receive });
  assert.equal(registry.deliver("a", []), false);
  const duplicate = registry.register({ chatId: "a", available: () => true, receive });
  assert.equal(registry.deliver("a", [png()]), false);
  duplicate();
  assert.equal(registry.deliver("a", [png()]), true);
  assert.equal(received, 1);
});

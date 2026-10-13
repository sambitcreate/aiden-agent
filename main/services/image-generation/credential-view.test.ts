import assert from "node:assert/strict";
import test from "node:test";
import { createImageCredentialView } from "./credential-view.js";
import { MemoryCredentialStore } from "./test-support.js";

test("the image view cannot see or change the chat OpenRouter credential", async () => {
  const base = new MemoryCredentialStore({
    openrouter: { type: "api_key", key: "sk-or-chat-key" },
    replicate: { type: "api_key", key: "r8-chat-namespace" },
    "aiden-internal:tts-api-key": { type: "api_key", key: "tts" },
  });
  const view = createImageCredentialView(base);

  assert.equal(await view.read("openrouter"), undefined);
  assert.equal(await view.read("replicate"), undefined);
  assert.deepEqual(await view.list(), []);

  await view.modify("openrouter", async () => ({ type: "api_key", key: "sk-or-image-key" }));
  assert.deepEqual(base.entries.get("openrouter"), { type: "api_key", key: "sk-or-chat-key" });
  assert.deepEqual(await view.read("openrouter"), { type: "api_key", key: "sk-or-image-key" });
  assert.deepEqual(await view.list(), [{ providerId: "openrouter", type: "api_key" }]);

  await view.delete("openrouter");
  assert.equal(await view.read("openrouter"), undefined);
  assert.deepEqual(base.entries.get("openrouter"), { type: "api_key", key: "sk-or-chat-key" });
  assert.ok(base.touched.every((id) => id.startsWith("aiden-internal:image-gen:")));
});

test("the view has no slot for ids outside the three image providers", async () => {
  const base = new MemoryCredentialStore({
    "aiden-internal:image-gen:anthropic": { type: "api_key", key: "planted" },
  });
  const view = createImageCredentialView(base);

  assert.equal(await view.read("anthropic"), undefined);
  assert.equal(await view.read("../openrouter"), undefined);
  assert.deepEqual(await view.list(), []);
  await assert.rejects(view.modify("anthropic", async () => ({ type: "api_key", key: "x" })), /no credential slot/u);
  await assert.rejects(view.delete("tts"), /no credential slot/u);
  assert.equal(base.entries.size, 1);
});

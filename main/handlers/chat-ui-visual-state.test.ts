import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createChatStore } from "../services/chat-store-core.js";
import { parseUiVisualStateUpdate } from "./chat-ui-visual-state.js";

const VISUAL = {
  version: 1 as const,
  kind: "ui" as const,
  id: "ui-abc",
  title: "Board",
  catalogVersion: 1,
  tree: { t: "Visual", k: "0", c: [{ t: "Text", k: "0.0", c: [{ t: "#text", k: "0.0.0", s: "Hi" }] }] },
  state: { tab: "a" },
  fallbackText: "Hi",
};

test("a visual's local state update is parsed strictly", () => {
  assert.deepEqual(
    parseUiVisualStateUpdate({ chatId: "c", messageId: "m", visualId: "ui-abc", state: { tab: "b", seats: 5 } }),
    { chatId: "c", messageId: "m", visualId: "ui-abc", state: { tab: "b", seats: 5 } },
  );
  for (const bad of [
    null,
    { chatId: "c", messageId: "m", visualId: "ui-abc" },
    { chatId: "c", messageId: "m", visualId: "ui-abc", state: [] },
    { chatId: "c", messageId: "m", visualId: "", state: {} },
    { chatId: "c", messageId: "m", visualId: "ui-abc", state: { prompt: "x" } },
    { chatId: "c", messageId: "m", visualId: "ui-abc", state: { note: "x".repeat(5000) } },
  ]) {
    assert.throws(() => parseUiVisualStateUpdate(bad), JSON.stringify(bad)?.slice(0, 60));
  }
});

test("the store keeps a visual's latest local state and refuses everything else", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-ui-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "State", workspaceId: "w", providerId: "p", model: "m" });
  await store.appendMessage(chat.id, { role: "user", content: "Show it" });
  const withVisual = await store.appendMessage(chat.id, { role: "assistant", content: "Here", uiVisuals: [VISUAL] });
  const [user, assistant] = withVisual.messages;
  assert.equal(await store.updateUiVisualState(chat.id, assistant!.id, "ui-abc", { tab: "b" }), true);
  const reread = await createChatStore(async () => directory).get(chat.id);
  assert.deepEqual(reread?.messages[1]?.uiVisuals?.[0]?.state, { tab: "b" });
  assert.equal(await store.updateUiVisualState(chat.id, assistant!.id, "ui-missing", { tab: "c" }), false);
  assert.equal(await store.updateUiVisualState(chat.id, user!.id, "ui-abc", { tab: "c" }), false);
  assert.equal(await store.updateUiVisualState("no-chat", assistant!.id, "ui-abc", { tab: "c" }), false);
});

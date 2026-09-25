import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the todo snapshot handler shares durable admission and preserves the owner fence", () => {
  const handlers = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  const snapshot = handlers.slice(
    handlers.indexOf('ipcMain.handle("chats:todoSnapshot"'),
    handlers.indexOf('ipcMain.handle("chats:waitUntilIdle"'),
  );
  assert.ok(snapshot.includes('ipcMain.handle("chats:todoSnapshot"'));
  assert.match(snapshot, /openChatIfEligible/u);
  assert.doesNotMatch(snapshot, /openChat\(/u);
  assert.match(snapshot, /loadDurableTodoSnapshot\(chatId, opened\.session\)/u);
  assert.match(snapshot, /await loadDurableTodoSnapshot[\s\S]*owner\.isDestroyed\(\)[\s\S]*return snapshot/u);
});

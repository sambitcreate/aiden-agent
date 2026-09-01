import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialog = readFileSync(new URL("./memory-dialog.tsx", import.meta.url), "utf8");
const chatPane = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
const ipc = readFileSync(new URL("../lib/ipc.ts", import.meta.url), "utf8");

test("memory manager uses exact chat-owned IPC for add, replacement, delete, and export", () => {
  assert.match(dialog, /chatsApi\.memoryList\(chatId\)/u);
  assert.match(dialog, /chatsApi\.memoryPut\(chatId/u);
  assert.match(dialog, /\.\.\.\(supersedesId \? \{ supersedesId \} : \{\}\)/u);
  assert.match(dialog, /chatsApi\.memoryRemove\(chatId, deleting\.id\)/u);
  assert.match(dialog, /chatsApi\.memoryExport\(chatId\)/u);
  assert.match(ipc, /"chats:memoryExport"/u);
});

test("memory manager preserves accessible destructive and text-entry behavior", () => {
  assert.match(dialog, /<Textarea[\s\S]*?maxLength=\{512\}/u);
  assert.match(dialog, /<Switch[\s\S]*?aria-label="Always include this fact"/u);
  assert.match(dialog, /<AlertDialog[\s\S]*?title="Delete this memory\?"/u);
  assert.match(dialog, /role="alert"/u);
  assert.doesNotMatch(dialog, /focus:(?:border|ring|outline)/u);
});

test("the active chat toolbar exposes the scoped memory manager", () => {
  assert.match(chatPane, /aria-label="Manage memory"/u);
  assert.match(chatPane, /<MemoryDialog[\s\S]*?chatId=\{chatId\}/u);
});

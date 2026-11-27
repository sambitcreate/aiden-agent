import assert from "node:assert/strict";
import test from "node:test";
import { applyChatMetaListUpdate, applyChatMetadataUpdate } from "./chat-metadata-update.js";

const chat = { id: "c1", title: "Draft", workspaceId: "w1", updatedAt: 10, thinkingLevel: "high" as const };

test("a reconciled level sets, clears or leaves the open chat's level", () => {
  const base = { chatId: "c1", title: "Draft", workspaceId: "w1", updatedAt: 20 };
  assert.equal(applyChatMetadataUpdate(chat, { ...base, thinkingLevel: "medium" }).thinkingLevel, "medium");
  assert.equal("thinkingLevel" in applyChatMetadataUpdate(chat, { ...base, thinkingLevel: null }), false);
  assert.equal(applyChatMetadataUpdate(chat, base).thinkingLevel, "high");
  assert.equal(chat.thinkingLevel, "high", "the cached chat is not mutated");
});

test("the chat list applies the update to its row only and stays newest first", () => {
  const other = { id: "c2", title: "Other", workspaceId: "w1", updatedAt: 15, thinkingLevel: "low" as const };
  const rows = [other, chat];

  const lowered = applyChatMetaListUpdate(rows, {
    chatId: "c1",
    title: "Renamed",
    workspaceId: "w1",
    updatedAt: 30,
    thinkingLevel: "medium",
  });
  assert.deepEqual(lowered, [{ ...chat, title: "Renamed", updatedAt: 30, thinkingLevel: "medium" }, other]);
  assert.equal(lowered[1], other, "an unrelated row is the same object");

  const cleared = applyChatMetaListUpdate(rows, { chatId: "c1", title: "Draft", workspaceId: "w1", updatedAt: 30, thinkingLevel: null });
  assert.equal("thinkingLevel" in cleared[0]!, false);

  const titleOnly = applyChatMetaListUpdate(rows, { chatId: "c1", title: "Draft", workspaceId: "w1", updatedAt: 12 });
  assert.deepEqual(titleOnly.map((row) => [row.id, row.thinkingLevel]), [["c2", "low"], ["c1", "high"]]);
});

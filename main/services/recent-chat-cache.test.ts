import assert from "node:assert/strict";
import test from "node:test";
import { RecentChatCache } from "./recent-chat-cache.js";

test("opening many chats keeps only the most recently used ones", () => {
  const cache = new RecentChatCache<string>(3);
  for (let index = 1; index <= 200; index += 1) cache.set(`chat-${index}`, `profile-${index}`);

  assert.equal(cache.size, 3);
  assert.equal(cache.get("chat-1"), undefined);
  assert.equal(cache.get("chat-197"), undefined);
  assert.deepEqual(
    ["chat-198", "chat-199", "chat-200"].map((chatId) => cache.get(chatId)),
    ["profile-198", "profile-199", "profile-200"],
  );
});

test("a chat that is read or re-registered survives newer chats", () => {
  const cache = new RecentChatCache<number>(2);
  cache.set("open", 1);
  cache.set("background", 2);
  assert.equal(cache.get("open"), 1);
  cache.set("new", 3);

  assert.equal(cache.get("background"), undefined);
  assert.equal(cache.get("open"), 1);

  cache.set("open", 4);
  cache.set("newer", 5);
  assert.equal(cache.get("new"), undefined);
  assert.equal(cache.get("open"), 4);
});

test("deleting a chat frees its slot and falsy values are still cached", () => {
  const cache = new RecentChatCache<number>(2);
  cache.set("zero", 0);
  cache.set("deleted", 1);
  cache.delete("deleted");
  cache.set("kept", 2);

  assert.equal(cache.size, 2);
  assert.equal(cache.get("zero"), 0);
  assert.equal(cache.get("deleted"), undefined);
});

test("a cache without room for a chat is rejected", () => {
  assert.throws(() => new RecentChatCache(0), RangeError);
});

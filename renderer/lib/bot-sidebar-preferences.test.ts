import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_LAST_VIEWED_LIMIT,
  isBotUnread,
  lastViewedBotId,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotViewed,
  withoutMissingBots,
  withPinnedBot,
} from "./bot-sidebar-preferences";

const NOW = 1_800_000_000_000;

test("a stored record that is missing, malformed or from a newer build reads as no pin and nothing viewed", () => {
  for (const raw of [null, "", "not json", "[]", "42", JSON.stringify({ version: 2, pinnedBotId: "b1" })]) {
    assert.deepEqual(parseBotSidebarPreferences(raw, NOW), { since: NOW, pinnedBotId: null, lastViewed: {} }, String(raw));
  }
  const odd = parseBotSidebarPreferences(
    JSON.stringify({ version: 1, since: -5, pinnedBotId: 7, lastViewed: { b1: 10, b2: "soon", b3: Number.NaN, "": 4, b4: -1 } }),
    NOW,
  );
  assert.deepEqual(odd, { since: NOW, pinnedBotId: null, lastViewed: { b1: 10 } });
});

test("a record round-trips, and only the most recent views are kept", () => {
  const stored = { since: 5, pinnedBotId: "b1", lastViewed: { b1: 10, b2: 20 } };
  assert.deepEqual(parseBotSidebarPreferences(serializeBotSidebarPreferences(stored), NOW), stored);
  const many = Object.fromEntries(Array.from({ length: BOT_LAST_VIEWED_LIMIT + 50 }, (_, index) => [`b${index}`, index + 1]));
  const trimmed = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 1, pinnedBotId: null, lastViewed: many }), NOW);
  assert.equal(Object.keys(trimmed.lastViewed).length, BOT_LAST_VIEWED_LIMIT);
  assert.equal(trimmed.lastViewed[`b${BOT_LAST_VIEWED_LIMIT + 49}`], BOT_LAST_VIEWED_LIMIT + 50, "the newest view survives");
  assert.equal(trimmed.lastViewed.b0, undefined, "the oldest view goes");
});

test("a Bot is unread only for a reply after it was last viewed, or after the record began when it never was", () => {
  const preferences = { since: 1_000, pinnedBotId: null, lastViewed: { seen: 5_000 } };
  assert.equal(isBotUnread(preferences, "seen", 6_000), true);
  assert.equal(isBotUnread(preferences, "seen", 4_000), false);
  assert.equal(isBotUnread(preferences, "never", 500), false, "an old reply from before the update is not news");
  assert.equal(isBotUnread(preferences, "never", 1_500), true);
  assert.equal(isBotUnread(preferences, "seen", null), false);
});

test("viewing only moves forward, pinning replaces the one pin, and pruning drops deleted Bots", () => {
  const start = { since: 1, pinnedBotId: null, lastViewed: { b1: 50 } };
  assert.equal(withBotViewed(start, "b1", 40), start, "an older view changes nothing");
  assert.equal(withBotViewed(start, "b1", 60).lastViewed.b1, 60);
  const pinned = withPinnedBot(withPinnedBot(start, "b1"), "b2");
  assert.equal(pinned.pinnedBotId, "b2");
  assert.equal(withPinnedBot(pinned, "b2"), pinned);
  const live = new Set(["b1"]);
  const pruned = withoutMissingBots({ ...pinned, lastViewed: { b1: 50, gone: 70 } }, live);
  assert.deepEqual(pruned, { since: 1, pinnedBotId: null, lastViewed: { b1: 50 } });
  assert.equal(withoutMissingBots(pruned, live), pruned, "nothing to prune keeps the same record");
});

test("the last viewed Bot is the newest view among Bots that still exist", () => {
  const preferences = { since: 1, pinnedBotId: null, lastViewed: { b1: 10, gone: 99, b2: 30 } };
  assert.equal(lastViewedBotId(preferences, new Set(["b1", "b2"])), "b2");
  assert.equal(lastViewedBotId(preferences, new Set(["b3"])), null);
});

test("an empty live set never prunes, since it means the list is not loaded", () => {
  const preferences = { since: 1, pinnedBotId: "b1", lastViewed: { b1: 50 } };
  assert.equal(withoutMissingBots(preferences, new Set()), preferences);
});

test("a valid start time survives a lastViewed that is an array or a string", () => {
  for (const lastViewed of [[1, 2], "oops", 7, null]) {
    const parsed = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 900, pinnedBotId: "b1", lastViewed }), NOW);
    assert.deepEqual(parsed, { since: 900, pinnedBotId: "b1", lastViewed: {} });
  }
});

test("times in the future are clamped so they cannot hide later replies", () => {
  const parsed = parseBotSidebarPreferences(
    JSON.stringify({ version: 1, since: NOW + 9_000, pinnedBotId: null, lastViewed: { b1: NOW + 5_000, b2: NOW - 5 } }),
    NOW,
  );
  assert.deepEqual(parsed, { since: NOW, pinnedBotId: null, lastViewed: { b1: NOW, b2: NOW - 5 } });
  assert.equal(isBotUnread(parsed, "b1", NOW + 1), true);
});

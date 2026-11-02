import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_LAST_VIEWED_LIMIT,
  isBotUnread,
  lastViewedBotId,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotReplySeen,
  withBotViewed,
  withoutMissingBots,
  withPinnedBot,
} from "./bot-sidebar-preferences";

const NOW = 1_800_000_000_000;

test("a stored record that is missing, malformed or from a newer build reads as no pin and nothing viewed", () => {
  for (const raw of [null, "", "not json", "[]", "42", JSON.stringify({ version: 2, pinnedBotId: "b1" })]) {
    assert.deepEqual(
      parseBotSidebarPreferences(raw, NOW),
      { since: NOW, pinnedBotId: null, lastViewed: {}, seenReplyAt: {} },
      String(raw),
    );
  }
  const odd = parseBotSidebarPreferences(
    JSON.stringify({
      version: 1,
      since: -5,
      pinnedBotId: 7,
      lastViewed: { b1: 10, b2: "soon", b3: Number.NaN, "": 4, b4: -1 },
      seenReplyAt: { b1: 8, b2: null },
    }),
    NOW,
  );
  assert.deepEqual(odd, { since: NOW, pinnedBotId: null, lastViewed: { b1: 10 }, seenReplyAt: { b1: 8 } });
});

test("a record round-trips, and only the most recent views are kept", () => {
  const stored = { since: 5, pinnedBotId: "b1", lastViewed: { b1: 10, b2: 20 }, seenReplyAt: { b1: 9 } };
  assert.deepEqual(parseBotSidebarPreferences(serializeBotSidebarPreferences(stored), NOW), stored);
  const many = Object.fromEntries(Array.from({ length: BOT_LAST_VIEWED_LIMIT + 50 }, (_, index) => [`b${index}`, index + 1]));
  const trimmed = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 1, pinnedBotId: null, lastViewed: many }), NOW);
  assert.equal(Object.keys(trimmed.lastViewed).length, BOT_LAST_VIEWED_LIMIT);
  assert.equal(trimmed.lastViewed[`b${BOT_LAST_VIEWED_LIMIT + 49}`], BOT_LAST_VIEWED_LIMIT + 50, "the newest view survives");
  assert.equal(trimmed.lastViewed.b0, undefined, "the oldest view goes");
});

test("a Bot is unread only for a reply newer than the newest one its chat showed, or than the record's start when it never showed one", () => {
  const preferences = { since: 1_000, pinnedBotId: null, lastViewed: { seen: 9_000 }, seenReplyAt: { seen: 5_000 } };
  assert.equal(isBotUnread(preferences, "seen", 6_000), true, "a reply that started before the chat was left, but finished after");
  assert.equal(isBotUnread(preferences, "seen", 5_000), false);
  assert.equal(isBotUnread(preferences, "never", 500), false, "an old reply from before the update is not news");
  assert.equal(isBotUnread(preferences, "never", 1_500), true);
  assert.equal(isBotUnread(preferences, "seen", null), false);
  // A record written before the watermark existed: its view times are just numbers, and nothing counts as seen yet.
  const old = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 1_000, pinnedBotId: null, lastViewed: { b1: 9_000 } }), NOW);
  assert.deepEqual(old.seenReplyAt, {});
  assert.equal(isBotUnread(old, "b1", 900), false);
});

test("viewing and the seen reply only move forward, pinning replaces the one pin, and pruning drops deleted Bots", () => {
  const start = { since: 1, pinnedBotId: null, lastViewed: { b1: 50 }, seenReplyAt: { b1: 30 } };
  assert.equal(withBotViewed(start, "b1", 40, 20), start, "an older view and reply change nothing");
  assert.equal(withBotViewed(start, "b1", 60).lastViewed.b1, 60);
  assert.equal(withBotViewed(start, "b1", 60).seenReplyAt.b1, 30, "a chat with no reply leaves the seen reply alone");
  const later = withBotViewed(start, "b1", 40, 45);
  assert.deepEqual([later.lastViewed.b1, later.seenReplyAt.b1], [50, 45]);
  const pinned = withPinnedBot(withPinnedBot(start, "b1"), "b2");
  assert.equal(pinned.pinnedBotId, "b2");
  assert.equal(withPinnedBot(pinned, "b2"), pinned);
  const live = new Set(["b1"]);
  const pruned = withoutMissingBots({ ...pinned, lastViewed: { b1: 50, gone: 70 }, seenReplyAt: { gone: 60 } }, live);
  assert.deepEqual(pruned, { since: 1, pinnedBotId: null, lastViewed: { b1: 50 }, seenReplyAt: {} });
  assert.equal(withoutMissingBots(pruned, live), pruned, "nothing to prune keeps the same record");
});

test("marking a reply read clears unread without changing which Bot was last viewed", () => {
  const start = { since: 1, pinnedBotId: null, lastViewed: { b1: 90, b2: 50 }, seenReplyAt: { b2: 30 } };
  const live = new Set(["b1", "b2"]);
  assert.equal(isBotUnread(start, "b2", 70), true);
  const seen = withBotReplySeen(start, "b2", 70);
  assert.equal(isBotUnread(seen, "b2", 70), false);
  assert.equal(lastViewedBotId(seen, live), "b1", "`/bots` still opens the Bot the person last viewed");
  assert.deepEqual(seen.lastViewed, start.lastViewed);
  assert.equal(isBotUnread(seen, "b2", 80), true, "a reply newer than the one marked read is news");
  assert.equal(withBotReplySeen(seen, "b2", 60), seen, "an older reply changes nothing");
  assert.equal(withBotReplySeen(seen, "b2", null), seen, "no reply changes nothing");
});

test("the last viewed Bot is the newest view among Bots that still exist", () => {
  const preferences = { since: 1, pinnedBotId: null, lastViewed: { b1: 10, gone: 99, b2: 30 }, seenReplyAt: { b1: 80 } };
  assert.equal(lastViewedBotId(preferences, new Set(["b1", "b2"])), "b2");
  assert.equal(lastViewedBotId(preferences, new Set(["b3"])), null);
});

test("an empty live set never prunes, since it means the list is not loaded", () => {
  const preferences = { since: 1, pinnedBotId: "b1", lastViewed: { b1: 50 }, seenReplyAt: {} };
  assert.equal(withoutMissingBots(preferences, new Set()), preferences);
});

test("a valid start time survives a lastViewed that is an array or a string", () => {
  for (const lastViewed of [[1, 2], "oops", 7, null]) {
    const parsed = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 900, pinnedBotId: "b1", lastViewed }), NOW);
    assert.deepEqual(parsed, { since: 900, pinnedBotId: "b1", lastViewed: {}, seenReplyAt: {} });
  }
});

test("times in the future are clamped so they cannot hide later replies", () => {
  const parsed = parseBotSidebarPreferences(
    JSON.stringify({
      version: 1,
      since: NOW + 9_000,
      pinnedBotId: null,
      lastViewed: { b1: NOW + 5_000, b2: NOW - 5 },
      seenReplyAt: { b1: NOW + 7_000 },
    }),
    NOW,
  );
  assert.deepEqual(parsed, { since: NOW, pinnedBotId: null, lastViewed: { b1: NOW, b2: NOW - 5 }, seenReplyAt: { b1: NOW } });
  assert.equal(isBotUnread(parsed, "b1", NOW + 1), true);
});

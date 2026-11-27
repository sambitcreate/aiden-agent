import assert from "node:assert/strict";
import test from "node:test";
import { BOT_BUBBLE_LIMIT, BOT_BUBBLE_RECENT_LIMIT } from "../../../renderer/shared/bot-bubbles.js";
import {
  EMPTY_BOT_BUBBLE_LIST,
  botBubbleSettingsFrom,
  botBubbleStateFrom,
  bubbleBot,
  closeBubble,
  forgetRecentBubble,
  moveBubble,
  moveBubblesOffMissingDisplays,
  openBubble,
  parseBotBubbleFile,
  pruneBubbles,
  resolveBotBubbleHost,
  serializeBotBubbleFile,
  type BotBubbleList,
} from "./bot-bubbles-core.js";

const ids = (list: BotBubbleList) => list.bubbles.map((bubble) => bubble.botId);
const bubbleAll = (botIds: string[], start: BotBubbleList = EMPTY_BOT_BUBBLE_LIST) =>
  botIds.reduce((list, id) => bubbleBot(list, id), start);

test("a sixth head pushes the oldest to the front of recents", () => {
  const five = bubbleAll(["a", "b", "c", "d", "e"]);
  assert.equal(five.bubbles.length, BOT_BUBBLE_LIMIT);
  const six = bubbleBot(five, "f");
  assert.deepEqual(ids(six), ["b", "c", "d", "e", "f"]);
  assert.deepEqual(six.recents, ["a"]);
});

test("bubbling a Bot that is already out changes nothing", () => {
  const list = bubbleAll(["a", "b"]);
  assert.equal(bubbleBot(list, "a", { side: "left" }), list);
});

test("bubbling a recent Bot takes it out of recents", () => {
  const closed = closeBubble(bubbleAll(["a", "b"]), "a");
  assert.deepEqual(closed.recents, ["a"]);
  const again = bubbleBot(closed, "a");
  assert.deepEqual(again.recents, []);
  assert.deepEqual(ids(again), ["b", "a"]);
});

test("new heads stack below the lowest head on their side and start fresh on the other side", () => {
  const list = bubbleAll(["a", "b"]);
  const [a, b] = list.bubbles;
  assert.equal(a!.placement.side, "right");
  assert.ok(b!.placement.y > a!.placement.y, "the second head sits below the first");
  const left = bubbleBot(list, "c", { side: "left" });
  assert.equal(left.bubbles[2]!.placement.side, "left");
  assert.equal(left.bubbles[2]!.placement.y, a!.placement.y, "an empty side starts at the same height");
});

test("a side that is full to the bottom wraps the new head to a free gap", () => {
  let list = bubbleAll(["a", "b"]);
  list = moveBubble(list, "a", { side: "right", y: 0.5, displayId: null });
  list = moveBubble(list, "b", { side: "right", y: 1, displayId: null });
  const placed = bubbleBot(list, "c").bubbles[2]!.placement;
  for (const other of [0.5, 1]) assert.ok(Math.abs(placed.y - other) >= 0.06, `${placed.y} sits on ${other}`);
  assert.ok(placed.y >= 0 && placed.y <= 1);
});

test("heads on another display don't count when finding a free height", () => {
  const list = bubbleBot(bubbleBot(EMPTY_BOT_BUBBLE_LIST, "a", { displayId: 2 }), "b", { displayId: 3 });
  assert.equal(list.bubbles[0]!.placement.y, list.bubbles[1]!.placement.y);
  assert.equal(list.bubbles[1]!.placement.displayId, 3);
});

test("closing a head clears its open mini chat and makes it the most recent", () => {
  let list = openBubble(bubbleAll(["a", "b"]), "a");
  assert.equal(list.openBotId, "a");
  list = closeBubble(list, "b");
  assert.equal(list.openBotId, "a", "closing another head leaves the open chat");
  list = closeBubble(list, "a");
  assert.equal(list.openBotId, null);
  assert.deepEqual(list.recents, ["a", "b"]);
});

test("only a bubbled Bot can open, and null tucks the chat away", () => {
  const list = bubbleAll(["a"]);
  assert.equal(openBubble(list, "ghost"), list);
  assert.equal(openBubble(openBubble(list, "a"), null).openBotId, null);
});

test("a change made only if a given chat is open does nothing once another one is", () => {
  const list = openBubble(bubbleAll(["a", "b"]), "b");
  assert.equal(openBubble(list, null, "a"), list);
  assert.equal(openBubble(list, null, "b").openBotId, null);
  assert.equal(openBubble(list, "a", "b").openBotId, "a");
});

test("a pushed-out head that was open closes its chat", () => {
  const list = openBubble(bubbleAll(["a", "b", "c", "d", "e"]), "a");
  assert.equal(bubbleBot(list, "f").openBotId, null);
});

test("recents stay deduplicated and bounded", () => {
  let list = EMPTY_BOT_BUBBLE_LIST;
  for (let index = 0; index < BOT_BUBBLE_RECENT_LIMIT + 3; index += 1) {
    list = closeBubble(bubbleBot(list, `bot-${index}`), `bot-${index}`);
  }
  list = closeBubble(bubbleBot(list, "bot-12"), "bot-12");
  assert.equal(list.recents.length, BOT_BUBBLE_RECENT_LIMIT);
  assert.equal(list.recents[0], "bot-12");
  assert.equal(new Set(list.recents).size, list.recents.length);
  assert.deepEqual(forgetRecentBubble(list, "bot-12").recents.includes("bot-12"), false);
});

test("moving a head that isn't out does nothing", () => {
  const list = bubbleAll(["a"]);
  assert.equal(moveBubble(list, "b", { side: "left", y: 0.4, displayId: null }), list);
  assert.deepEqual(moveBubble(list, "a", { side: "left", y: 0.4, displayId: 7 }).bubbles[0]!.placement, {
    side: "left",
    y: 0.4,
    displayId: 7,
  });
});

test("pruning drops heads, recents and the open chat of deleted Bots", () => {
  let list = openBubble(bubbleAll(["a", "b", "c"]), "b");
  list = closeBubble(list, "c");
  const pruned = pruneBubbles(list, new Set(["a"]));
  assert.deepEqual(ids(pruned), ["a"]);
  assert.deepEqual(pruned.recents, []);
  assert.equal(pruned.openBotId, null);
  assert.equal(pruneBubbles(pruned, new Set(["a", "z"])), pruned, "nothing to drop keeps the same list");
});

test("heads on a removed or unknown display move to the primary display with the same side and height", () => {
  let list = bubbleBot(EMPTY_BOT_BUBBLE_LIST, "a", { displayId: 2, side: "left" });
  list = bubbleBot(list, "b", { displayId: 1 });
  list = bubbleBot(list, "c");
  const moved = moveBubblesOffMissingDisplays(list, new Set([1]), 1);
  assert.deepEqual(moved.bubbles[0]!.placement, { ...list.bubbles[0]!.placement, displayId: 1 });
  assert.deepEqual(moved.bubbles[1], list.bubbles[1]);
  assert.equal(moved.bubbles[2]!.placement.displayId, 1, "a head with no display yet lands on the primary");
  assert.equal(moveBubblesOffMissingDisplays(moved, new Set([1]), 1), moved);
});

test("host follows the two switches and the platform", () => {
  const on = botBubbleSettingsFrom({});
  assert.deepEqual(on, { enabled: true, floatOverApps: true });
  assert.equal(resolveBotBubbleHost(on, "darwin"), "overlay");
  assert.equal(resolveBotBubbleHost(on, "linux"), "window");
  assert.equal(resolveBotBubbleHost(botBubbleSettingsFrom({ botBubblesFloatOverApps: false }), "darwin"), "window");
  assert.equal(resolveBotBubbleHost(botBubbleSettingsFrom({ botBubblesEnabled: false }), "darwin"), "off");
  assert.equal(botBubbleStateFrom(EMPTY_BOT_BUBBLE_LIST, on, "linux").floatOverAppsAvailable, false);
  assert.equal(botBubbleStateFrom(EMPTY_BOT_BUBBLE_LIST, on, "darwin").floatOverAppsAvailable, true);
});

test("the saved file round-trips order, side, height and display but not the open chat", () => {
  let list = bubbleBot(EMPTY_BOT_BUBBLE_LIST, "a", { side: "left", displayId: 4 });
  list = bubbleBot(list, "b");
  list = closeBubble(bubbleBot(list, "c"), "c");
  list = openBubble(list, "a");
  const restored = parseBotBubbleFile(JSON.parse(JSON.stringify(serializeBotBubbleFile(list))));
  assert.deepEqual(restored.bubbles, list.bubbles);
  assert.deepEqual(restored.recents, ["c"]);
  assert.equal(restored.openBotId, null);
});

test("a damaged or unknown saved file starts empty", () => {
  const good = serializeBotBubbleFile(bubbleAll(["a", "b"]));
  const cases: unknown[] = [
    null,
    "text",
    [],
    { ...good, version: 2 },
    { ...good, bubbles: "nope" },
    { ...good, bubbles: [...good.bubbles, good.bubbles[0]] },
    { ...good, bubbles: [{ botId: "a", side: "top", y: 0.2, displayId: null }] },
    { ...good, bubbles: [{ botId: "a", side: "left", y: 4, displayId: null }] },
    { ...good, bubbles: [{ botId: "../x", side: "left", y: 0.2, displayId: null }] },
    { ...good, recents: ["a"] },
    { ...good, recents: ["z", "z"] },
    { ...good, bubbles: Array.from({ length: 6 }, (_, i) => ({ botId: `b${i}`, side: "left", y: 0, displayId: null })) },
  ];
  for (const raw of cases) assert.deepEqual(parseBotBubbleFile(raw), EMPTY_BOT_BUBBLE_LIST, JSON.stringify(raw));
});

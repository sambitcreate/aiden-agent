import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { BotBubbleState } from "../../../renderer/shared/bot-bubbles.js";
import type { BotBubbleAppSettings } from "./bot-bubbles-core.js";
import { createBotBubbleService } from "./bot-bubbles-service.js";

async function harness(
  options: {
    bots?: string[];
    settings?: BotBubbleAppSettings;
    platform?: NodeJS.Platform;
    dir?: string;
  } = {},
) {
  const dir = options.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-bubbles-")));
  const filePath = path.join(dir, "bot-bubbles.json");
  const bots = new Set(options.bots ?? ["a", "b", "c", "d", "e", "f"]);
  const broadcasts: BotBubbleState[] = [];
  const warnings: string[] = [];
  let settings = options.settings ?? {};
  const service = createBotBubbleService({
    filePath,
    platform: options.platform ?? "darwin",
    readSettings: async () => settings,
    botExists: async (id) => bots.has(id),
    listBotIds: async () => [...bots],
    broadcast: (state) => broadcasts.push(state),
    onWarning: (message) => warnings.push(message),
  });
  return {
    dir,
    filePath,
    bots,
    broadcasts,
    warnings,
    service,
    setSettings: (next: BotBubbleAppSettings) => (settings = next),
    saved: async () => JSON.parse(await fs.readFile(filePath, "utf8")) as unknown,
  };
}

const heads = (state: BotBubbleState) => state.bubbles.map((bubble) => bubble.botId);

test("bubbling past the limit pushes the oldest to recents, saves, and broadcasts each change", async () => {
  const h = await harness();
  for (const id of ["a", "b", "c", "d", "e", "f"]) await h.service.bubble(id);
  const state = await h.service.state();
  assert.deepEqual(heads(state), ["b", "c", "d", "e", "f"]);
  assert.deepEqual(state.recents, ["a"]);
  assert.equal(state.host, "overlay");
  assert.deepEqual(heads(h.broadcasts[h.broadcasts.length - 1]!), ["b", "c", "d", "e", "f"]);
  const saved = (await h.saved()) as {
    version: number;
    bubbles: Array<{ botId: string }>;
    recents: string[];
  };
  assert.equal(saved.version, 1);
  assert.deepEqual(
    saved.bubbles.map((bubble) => bubble.botId),
    ["b", "c", "d", "e", "f"],
  );
  assert.deepEqual(saved.recents, ["a"]);
});

test("a Bot that doesn't exist can't be bubbled, and nothing can while bubbles are off", async () => {
  const h = await harness({ bots: ["a"] });
  await assert.rejects(h.service.bubble("ghost"), /no longer exists/);
  await h.service.syncSettings({ botBubblesEnabled: false });
  await assert.rejects(h.service.bubble("a"), /turned off/);
  assert.equal((await h.service.state()).host, "off");
});

test("a restart restores the same heads in order with their side and height", async () => {
  const first = await harness();
  await first.service.bubble("c", { side: "left", displayId: 9 });
  await first.service.bubble("a");
  await first.service.move("a", { side: "left", y: 0.75, displayId: null });
  await first.service.open("a");
  const before = await first.service.state();

  const second = await harness({ dir: first.dir });
  const after = await second.service.state();
  assert.deepEqual(after.bubbles, before.bubbles);
  assert.equal(after.openBotId, null, "the open mini chat is not saved");
});

test("deleted Bots are dropped on load and when Bots change", async () => {
  const first = await harness();
  await first.service.bubble("a");
  await first.service.bubble("b");
  await first.service.close("b");
  await first.service.bubble("c");

  const second = await harness({ dir: first.dir, bots: ["a", "c"] });
  const loaded = await second.service.state();
  assert.deepEqual(heads(loaded), ["a", "c"]);
  assert.deepEqual(loaded.recents, []);
  const saved = (await second.saved()) as { recents: string[] };
  assert.deepEqual(saved.recents, [], "the pruned list is written back");

  await second.service.open("c");
  second.bots.delete("c");
  const afterDelete = await second.service.botsChanged("c");
  assert.deepEqual(heads(afterDelete), ["a"]);
  assert.equal(afterDelete.openBotId, null);

  second.bots.delete("a");
  assert.deepEqual(heads(await second.service.botsChanged()), []);
});

test("a change to a Bot that still exists leaves the list alone", async () => {
  const h = await harness();
  await h.service.bubble("a");
  const count = h.broadcasts.length;
  await h.service.botsChanged("a");
  await h.service.botsChanged("unrelated");
  assert.equal(h.broadcasts.length, count);
});

test("a damaged saved file starts empty and is replaced on the next change", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-bubbles-"));
  await fs.writeFile(path.join(dir, "bot-bubbles.json"), "{not json");
  const h = await harness({ dir });
  assert.deepEqual(heads(await h.service.state()), []);
  assert.equal(h.warnings.length, 1);
  await h.service.bubble("a");
  assert.deepEqual(
    ((await h.saved()) as { bubbles: Array<{ botId: string }> }).bubbles.map((b) => b.botId),
    ["a"],
  );

  await fs.writeFile(h.filePath, JSON.stringify({ version: 7, bubbles: [], recents: [] }));
  const other = await harness({ dir });
  assert.deepEqual(heads(await other.service.state()), []);
});

test("closing the open head clears the open chat", async () => {
  const h = await harness();
  await h.service.bubble("a");
  await h.service.open("a");
  assert.equal(h.service.openBotId(), "a");
  const closed = await h.service.close("a");
  assert.equal(closed.openBotId, null);
  assert.deepEqual(closed.recents, ["a"]);
});

test("settings change the host, and turning bubbles off tucks the open chat away", async () => {
  const h = await harness({ platform: "darwin" });
  await h.service.bubble("a");
  await h.service.open("a");
  assert.equal((await h.service.syncSettings({ botBubblesFloatOverApps: false })).host, "window");
  const off = await h.service.syncSettings({ botBubblesEnabled: false });
  assert.equal(off.host, "off");
  assert.equal(off.openBotId, null);
  assert.deepEqual(heads(off), ["a"], "heads come back when bubbles are turned on again");
  assert.equal((await h.service.syncSettings({})).host, "overlay");

  const linux = await harness({ platform: "linux" });
  assert.equal((await linux.service.state()).host, "window");
});

test("change listeners see the previous and next state", async () => {
  const h = await harness();
  const seen: Array<[string | null, string | null]> = [];
  h.service.onChange((next, previous) => seen.push([previous.openBotId, next.openBotId]));
  await h.service.bubble("a");
  await h.service.open("a");
  await h.service.open(null);
  assert.deepEqual(seen, [
    [null, null],
    [null, "a"],
    ["a", null],
  ]);
});

test("heads on a removed display move to the primary display", async () => {
  const h = await harness();
  await h.service.bubble("a", { displayId: 5, side: "left" });
  const moved = await h.service.displaysChanged(new Set([1]), 1);
  assert.deepEqual(moved.bubbles[0]!.placement, { side: "left", y: 0.2, displayId: 1 });
});

test("a damaged or unknown saved file is replaced on load, so the warning doesn't repeat", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-bubbles-"));
  const filePath = path.join(dir, "bot-bubbles.json");
  for (const damaged of ["{not json", JSON.stringify({ version: 9, bubbles: [], recents: [] })]) {
    await fs.writeFile(filePath, damaged);
    const first = await harness({ dir });
    await first.service.ready();
    assert.equal(first.warnings.length, 1, damaged);
    assert.deepEqual(await first.saved(), { version: 1, bubbles: [], recents: [] });
    const second = await harness({ dir });
    await second.service.ready();
    assert.deepEqual(second.warnings, [], "the next launch reads a clean file");
  }
});

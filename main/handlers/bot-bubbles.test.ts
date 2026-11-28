import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { BOT_BUBBLE_CHANNELS, type BotBubbleState } from "../../renderer/shared/bot-bubbles.js";
import { createBotBubbleService } from "../services/bot-bubbles/bot-bubbles-service.js";
import { parseBotId } from "./bot-params.js";
import { registerBotBubbleHandlers, type BotBubbleWindowPort } from "./bot-bubbles.js";

type FakeEvent = { sender: { id: number } };

async function harness(
  platform: NodeJS.Platform = "darwin",
  options: { overlayListens?: boolean } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-bubble-ipc-"));
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  const mainEvent: FakeEvent = { sender: { id: 1 } };
  const overlayEvent: FakeEvent = { sender: { id: 2 } };
  const strangerEvent: FakeEvent = { sender: { id: 99 } };
  const log: string[] = [];
  const service = createBotBubbleService({
    filePath: path.join(dir, "bot-bubbles.json"),
    platform,
    readSettings: async () => ({}),
    botExists: async (id) => id.startsWith("bot-"),
    listBotIds: async () => ["bot-a", "bot-b"],
    broadcast: () => undefined,
  });
  const windows: BotBubbleWindowPort<FakeEvent> = {
    capture: async (_event, rect) => {
      log.push(`capture:${rect.width}x${rect.height}`);
      return "data:image/png;base64,AAAA";
    },
    coverChat: async (_event, botId) => {
      // What the Aiden window shows while the picture goes up: its chat, so no head yet.
      log.push(`cover:${botId}:${service.current().bubbles.length} heads`);
      return options.overlayListens === true;
    },
    transitionShown: (_event, cover) => log.push(`shown:${cover}`),
    playShrink: (_event, botId, _rect, image) =>
      log.push(`shrink:${botId}:${image ? "image" : "none"}`),
    bringBack: async (botId, close) => {
      log.push(`grow:${botId}`);
      const state = await close();
      log.push(`showChat:${botId}`);
      return state;
    },
    displayIdFor: () => 3,
    setInteractive: (_event, interactive) => log.push(`interactive:${interactive}`),
    setDragging: (_event, dragging) => log.push(`dragging:${dragging}`),
    overlayInfo: () => ({ displayId: 3, width: 1440, height: 875 }),
  };
  registerBotBubbleHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    isMainWindow: (event) => event === mainEvent,
    isBubbleOverlayEvent: (event) => event === overlayEvent,
    service,
    windows,
    parseBotId,
  });
  const call = (channel: string, event: FakeEvent, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...args)) as Promise<BotBubbleState>;
  return { handlers, call, mainEvent, overlayEvent, strangerEvent, log };
}

test("bubbling from the main window captures the chat, adds the head on the window's display and plays the shrink", async () => {
  const { call, mainEvent, log } = await harness();
  const state = await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, {
    botId: "bot-a",
    side: "left",
    sourceRect: { x: 0, y: 0, width: 400, height: 600 },
  });
  assert.deepEqual(state.bubbles, [
    { botId: "bot-a", placement: { side: "left", y: 0.2, displayId: 3 } },
  ]);
  assert.deepEqual(log, ["capture:400x600", "cover:bot-a:0 heads", "shrink:bot-a:image"]);
});

test("with an overlay listening, the chat's picture covers the chat before the head exists and the shrink is not sent again", async () => {
  const { call, mainEvent, log } = await harness("darwin", { overlayListens: true });
  const state = await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, {
    botId: "bot-a",
    sourceRect: { x: 0, y: 0, width: 400, height: 600 },
  });
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.botId),
    ["bot-a"],
  );
  assert.deepEqual(log, ["capture:400x600", "cover:bot-a:0 heads"]);
});

test("only an overlay may say a shrink's picture is on screen", async () => {
  const { call, mainEvent, overlayEvent, strangerEvent, log } = await harness();
  await call(BOT_BUBBLE_CHANNELS.transitionShown, overlayEvent, { cover: 7 });
  assert.deepEqual(log, ["shown:7"]);
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.transitionShown, mainEvent, { cover: 7 }),
    /Untrusted/,
  );
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.transitionShown, strangerEvent, { cover: 7 }),
    /Untrusted/,
  );
  for (const bad of [{}, { cover: "7" }, { cover: 1.5 }, { cover: 7, extra: true }]) {
    await assert.rejects(call(BOT_BUBBLE_CHANNELS.transitionShown, overlayEvent, bad), /Invalid/);
  }
  assert.deepEqual(log, ["shown:7"]);
});

test("without a float-over-apps host there is no capture or shrink", async () => {
  const { call, mainEvent, log } = await harness("linux");
  const state = await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, {
    botId: "bot-a",
    sourceRect: { x: 0, y: 0, width: 400, height: 600 },
  });
  assert.equal(state.host, "window");
  assert.deepEqual(log, []);
});

test("only the main window may bubble a Bot", async () => {
  const { call, overlayEvent, strangerEvent } = await harness();
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.bubble, overlayEvent, { botId: "bot-a" }),
    /Untrusted/,
  );
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.bubble, strangerEvent, { botId: "bot-a" }),
    /Untrusted/,
  );
});

test("the main window and the overlay share close, open, move, bring back and recents; strangers get nothing", async () => {
  const { call, mainEvent, overlayEvent, strangerEvent, log } = await harness();
  await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, { botId: "bot-a" });
  await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, { botId: "bot-b" });

  assert.equal(
    (await call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: "bot-a" })).openBotId,
    "bot-a",
  );
  const moved = await call(BOT_BUBBLE_CHANNELS.move, overlayEvent, {
    botId: "bot-a",
    placement: { side: "left", y: 0.6, displayId: 3 },
  });
  assert.deepEqual(moved.bubbles[0]!.placement, { side: "left", y: 0.6, displayId: 3 });
  assert.equal((await call(BOT_BUBBLE_CHANNELS.open, mainEvent, { botId: null })).openBotId, null);

  const back = await call(BOT_BUBBLE_CHANNELS.bringBack, overlayEvent, { botId: "bot-a" });
  assert.deepEqual(
    back.bubbles.map((bubble) => bubble.botId),
    ["bot-b"],
  );
  assert.deepEqual(log.slice(-2), ["grow:bot-a", "showChat:bot-a"]);

  const closed = await call(BOT_BUBBLE_CHANNELS.close, mainEvent, { botId: "bot-b" });
  assert.deepEqual(closed.recents, ["bot-b", "bot-a"]);
  assert.deepEqual(
    (await call(BOT_BUBBLE_CHANNELS.forgetRecent, overlayEvent, { botId: "bot-a" })).recents,
    ["bot-b"],
  );
  assert.deepEqual((await call(BOT_BUBBLE_CHANNELS.state, overlayEvent)).recents, ["bot-b"]);

  for (const [channel, payload] of [
    [BOT_BUBBLE_CHANNELS.state, undefined],
    [BOT_BUBBLE_CHANNELS.close, { botId: "bot-b" }],
    [BOT_BUBBLE_CHANNELS.open, { botId: null }],
    [
      BOT_BUBBLE_CHANNELS.move,
      { botId: "bot-b", placement: { side: "left", y: 0, displayId: null } },
    ],
    [BOT_BUBBLE_CHANNELS.bringBack, { botId: "bot-b" }],
    [BOT_BUBBLE_CHANNELS.forgetRecent, { botId: "bot-b" }],
  ] as const) {
    await assert.rejects(
      call(channel, strangerEvent, ...(payload === undefined ? [] : [payload])),
      /Untrusted/,
      channel,
    );
  }
});

test("pointer, drag and overlay size calls come only from an overlay", async () => {
  const { call, mainEvent, overlayEvent, log } = await harness();
  await call(BOT_BUBBLE_CHANNELS.setInteractive, overlayEvent, { interactive: true });
  await call(BOT_BUBBLE_CHANNELS.setDragging, overlayEvent, { dragging: false });
  assert.deepEqual(await call(BOT_BUBBLE_CHANNELS.overlayInfo, overlayEvent), {
    displayId: 3,
    width: 1440,
    height: 875,
  });
  assert.deepEqual(log, ["interactive:true", "dragging:false"]);
  for (const channel of [
    BOT_BUBBLE_CHANNELS.setInteractive,
    BOT_BUBBLE_CHANNELS.setDragging,
    BOT_BUBBLE_CHANNELS.overlayInfo,
  ]) {
    await assert.rejects(call(channel, mainEvent, { interactive: true }), /Untrusted/, channel);
  }
});

test("a tuck that names the chat it closes leaves a chat opened since alone", async () => {
  const { call, mainEvent, overlayEvent } = await harness();
  await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, { botId: "bot-a" });
  await call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, { botId: "bot-b" });
  // One overlay had bot-a open; another display opened bot-b before its blur tuck landed.
  await call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: "bot-a" });
  await call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: "bot-b" });
  const late = await call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: null, ifOpen: "bot-a" });
  assert.equal(late.openBotId, "bot-b");
  const own = await call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: null, ifOpen: "bot-b" });
  assert.equal(own.openBotId, null);
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.open, overlayEvent, { botId: null, ifOpen: "../x" }),
    /Invalid|Bot/,
  );
});

test("malformed requests are refused before anything changes", async () => {
  const { call, mainEvent, overlayEvent, log } = await harness();
  const bad: Array<[string, unknown]> = [
    [BOT_BUBBLE_CHANNELS.bubble, "bot-a"],
    [BOT_BUBBLE_CHANNELS.bubble, { botId: "../escape" }],
    [BOT_BUBBLE_CHANNELS.bubble, { botId: "bot-a", side: "top" }],
    [
      BOT_BUBBLE_CHANNELS.bubble,
      { botId: "bot-a", sourceRect: { x: 0, y: 0, width: -1, height: 5 } },
    ],
    [BOT_BUBBLE_CHANNELS.bubble, { botId: "bot-a", extra: true }],
    [
      BOT_BUBBLE_CHANNELS.move,
      { botId: "bot-a", placement: { side: "left", y: "high", displayId: null } },
    ],
    [BOT_BUBBLE_CHANNELS.open, { botId: 4 }],
    [BOT_BUBBLE_CHANNELS.close, null],
  ];
  for (const [channel, payload] of bad) {
    await assert.rejects(
      call(channel, mainEvent, payload),
      /Invalid/,
      `${channel} ${JSON.stringify(payload)}`,
    );
  }
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.setInteractive, overlayEvent, { interactive: "yes" }),
    /Invalid/,
  );
  await assert.rejects(
    call(BOT_BUBBLE_CHANNELS.bubble, mainEvent, { botId: "someone-else" }),
    /no longer exists/,
  );
  assert.deepEqual(log, []);
  assert.deepEqual((await call(BOT_BUBBLE_CHANNELS.state, mainEvent)).bubbles, []);
});

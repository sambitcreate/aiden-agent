// bots:pause / bots:unpause against a real Bot session service: the pause
// file on disk is the oracle for what the handler did.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BOT_PAUSES_FILE, createBotPauseStore } from "../services/bot-pause-store.js";
import { createBotSessionService, type BotSessionRuntime } from "../services/bot-runtime/bot-session-service.js";
import { recordingDeps } from "../services/bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF } from "../services/bot-runtime/test-support/faux.js";
import { BOT_PAUSE_CHANNEL, BOT_UNPAUSE_CHANNEL, registerBotPauseHandlers } from "./bot-pause.js";

const BOT = "bot:a";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function setup(now = () => 1_000) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-pause-ipc-"));
  roots.push(profile);
  const storeRoot = path.join(profile, "bot-service");
  const fauxModels = createFauxModels();
  const service: BotSessionRuntime = await createBotSessionService({
    profileDir: profile,
    models: fauxModels.models,
    extension: recordingDeps(),
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set([BOT]),
    pauses: createBotPauseStore({ root: () => storeRoot, now }),
  });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotPauseHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    runtime: async () => service,
    botExists: async (botId) => botId === BOT,
  });
  const invoke = (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({}, ...args));
  const onDisk = () => createBotPauseStore({ root: () => storeRoot }).get(BOT);
  return { service, invoke, onDisk, fauxModels, pausesFile: path.join(storeRoot, BOT_PAUSES_FILE) };
}

test("bots:pause pauses the Bot as the Mac and bots:unpause lifts it", async () => {
  let clock = 1_000;
  const { service, invoke, onDisk, fauxModels } = await setup(() => clock);
  try {
    assert.deepEqual(await invoke(BOT_PAUSE_CHANNEL, BOT), { kind: "paused", since: 1_000, by: "mac" });
    assert.deepEqual(await onDisk(), { since: 1_000, by: "mac" }, "the pause outlives the window");

    clock = 9_000;
    assert.deepEqual(
      await invoke(BOT_PAUSE_CHANNEL, BOT),
      { kind: "paused", since: 1_000, by: "mac" },
      "pausing twice keeps the first time",
    );

    assert.deepEqual(await invoke(BOT_UNPAUSE_CHANNEL, BOT), { kind: "idle" });
    assert.equal(await onDisk(), undefined);
    assert.deepEqual(await invoke(BOT_UNPAUSE_CHANNEL, BOT), { kind: "idle" }, "unpausing a running Bot is a no-op");
    assert.equal(fauxModels.calls(), 0);
  } finally {
    await service.shutdown();
  }
});

test("the renderer cannot choose who paused the Bot", async () => {
  const { service, invoke, onDisk } = await setup();
  try {
    await invoke(BOT_PAUSE_CHANNEL, BOT, "phone");
    assert.deepEqual(await onDisk(), { since: 1_000, by: "mac" });
  } finally {
    await service.shutdown();
  }
});

test("pausing a Bot that does not exist is refused and leaves nothing behind", async () => {
  const { service, invoke, pausesFile } = await setup();
  try {
    await assert.rejects(invoke(BOT_PAUSE_CHANNEL, "bot:gone"), /no longer exists/u);
    assert.deepEqual(await invoke(BOT_UNPAUSE_CHANNEL, "bot:gone"), { kind: "idle" });
    assert.equal(existsSync(pausesFile), false);
  } finally {
    await service.shutdown();
  }
});

test("a malformed Bot id is refused before anything is written", async () => {
  const { service, invoke, pausesFile } = await setup();
  try {
    for (const channel of [BOT_PAUSE_CHANNEL, BOT_UNPAUSE_CHANNEL]) {
      for (const value of [undefined, null, 42, "", " bot:a", "../bot", "x".repeat(500), { botId: BOT }, [BOT]]) {
        await assert.rejects(invoke(channel, value), /Invalid bot/u, `${channel} ${JSON.stringify(value)}`);
      }
    }
    assert.equal(existsSync(pausesFile), false);
  } finally {
    await service.shutdown();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_CHANNELS,
  BOT_COMPUTERS_CHANGED_CHANNEL,
  DEFAULT_BOT_COMPUTERS_SETTINGS,
  parseBotComputersStatus,
  type BotComputersSettings,
  type BotComputersStatus,
  type BotComputerSetupState,
  type BotComputerStatus,
} from "../../renderer/shared/bot-computers.js";
import { registerBotComputerHandlers, type BotComputerHandlerDependencies } from "./bot-computers.js";

const BOT = "bot:ada";

/** A host that runs setup in steps the test releases, and records what reached it. */
function fakeHost() {
  const listeners = new Set<(botId: string | undefined) => void>();
  const reached: string[] = [];
  let setup: BotComputerSetupState = { kind: "not_set_up" };
  let settings: BotComputersSettings = { ...DEFAULT_BOT_COMPUTERS_SETTINGS };
  const computers = new Map<string, BotComputerStatus>();
  let finishSetup: (() => void) | undefined;
  const emit = (botId?: string) => {
    for (const listener of listeners) listener(botId);
  };
  const host: BotComputerHandlerDependencies["host"] = {
    status: async (): Promise<BotComputersStatus> => ({
      setup,
      settings,
      diskUsedBytes: 0,
      computers: [...computers.values()],
      requirements: { downloadBytes: 19_772_231_540, baseDiskBytes: 60 * 1024 ** 3, memoryPerComputerBytes: 8 * 1024 ** 3, baseVersion: "26.6.2" },
    }),
    setUp: () =>
      new Promise<void>((resolve) => {
        reached.push("setUp");
        for (let received = 0; received <= 10; received += 1) {
          setup = { kind: "downloading", receivedBytes: received, totalBytes: 10 };
          emit();
        }
        finishSetup = () => {
          setup = { kind: "ready", baseVersion: "26.6.2", baseBuild: "25G83", updateAvailable: false };
          emit();
          resolve();
        };
      }),
    cancelSetUp: () => void reached.push("cancelSetUp"),
    updateBase: async () => void reached.push("updateBase"),
    removeEverything: async () => {
      reached.push("removeEverything");
      computers.clear();
      setup = { kind: "not_set_up" };
    },
    updateSettings: async (patch) => {
      reached.push("updateSettings");
      settings = { ...settings, ...patch };
      return settings;
    },
    give: async (botId) => {
      reached.push(`give:${botId}`);
      const computer: BotComputerStatus = { botId, vmName: "aiden-bot-0123456789abcdef", state: "stopped", baseBuild: "25G83", outdated: false, controller: "bot" };
      computers.set(botId, computer);
      emit(botId);
      return computer;
    },
    reset: async (botId) => {
      reached.push(`reset:${botId}`);
      return computers.get(botId)!;
    },
    deleteForBot: async (botId) => {
      reached.push(`delete:${botId}`);
      computers.delete(botId);
    },
    stop: async (botId, options) => void reached.push(`stop:${botId}:${options?.reason ?? ""}`),
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { host, reached, finish: () => finishSetup?.() };
}

function setup() {
  const fake = fakeHost();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const broadcasts: { channel: string; payload: unknown }[] = [];
  registerBotComputerHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    host: fake.host,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    botExists: async (botId) => botId === BOT,
    coalesceMs: 20,
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler({}, ...args));
  };
  return { ...fake, handlers, broadcasts, invoke };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test("every channel is registered under the botComputers: prefix", () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), Object.values(BOT_COMPUTER_CHANNELS).sort());
  for (const channel of handlers.keys()) assert.ok(channel.startsWith("botComputers:"));
});

test("Set up returns at once and its progress arrives as coalesced status broadcasts", async () => {
  const { invoke, broadcasts, finish } = setup();
  const first = parseBotComputersStatus(await invoke(BOT_COMPUTER_CHANNELS.setUp));
  assert.equal(first?.setup.kind, "downloading", "the reply does not wait for the 20 GB download");
  await settle();
  assert.equal(broadcasts.length, 1, "eleven progress changes became one broadcast");
  assert.equal(broadcasts[0]?.channel, BOT_COMPUTERS_CHANGED_CHANNEL);
  assert.deepEqual(parseBotComputersStatus(broadcasts[0]?.payload)?.setup, { kind: "downloading", receivedBytes: 10, totalBytes: 10 });
  finish();
  await settle();
  assert.equal(parseBotComputersStatus(broadcasts[broadcasts.length - 1]?.payload)?.setup.kind, "ready");
});

test("a computer is given only to a Bot that exists, with a well-formed id", async () => {
  const { invoke, reached } = setup();
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.give, "bot:ghost"), /no longer exists/u);
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.give, "../escape"), /Invalid bot id/u);
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.reset, 42), /Invalid bot id/u);
  assert.deepEqual(reached, []);
  const given = (await invoke(BOT_COMPUTER_CHANNELS.give, BOT)) as BotComputerStatus;
  assert.equal(given.botId, BOT);
  // Removing is cleanup, so it works for a Bot that is already gone.
  await invoke(BOT_COMPUTER_CHANNELS.remove, "bot:ghost");
  await invoke(BOT_COMPUTER_CHANNELS.stop, BOT);
  assert.deepEqual(reached, [`give:${BOT}`, "delete:bot:ghost", `stop:${BOT}:person`]);
});

test("settings outside the offered choices are refused before they reach the host", async () => {
  const { invoke, reached } = setup();
  for (const patch of [{ maxRunning: 3 }, { idleStopMinutes: 7 }, { idleStopMinutes: "10" }, { other: true }, null, []]) {
    await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.updateSettings, patch));
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(await invoke(BOT_COMPUTER_CHANNELS.updateSettings, { maxRunning: 1, idleStopMinutes: 30 }), {
    maxRunning: 1,
    idleStopMinutes: 30,
  });
});

test("Remove everything replies with the emptied status", async () => {
  const { invoke } = setup();
  await invoke(BOT_COMPUTER_CHANNELS.give, BOT);
  const status = parseBotComputersStatus(await invoke(BOT_COMPUTER_CHANNELS.removeEverything));
  assert.equal(status?.setup.kind, "not_set_up");
  assert.deepEqual(status?.computers, []);
});

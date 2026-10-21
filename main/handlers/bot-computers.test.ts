import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  type BotComputerViewerGrant,
} from "../../renderer/shared/bot-computers.js";
import { createBotComputerControl } from "../services/bot-computers/control.js";
import { BotComputerTakenOverError, type BotComputerPointer } from "../services/bot-computers/types.js";
import { registerBotComputerHandlers, type BotComputerHandlerDependencies } from "./bot-computers.js";

const BOT = "bot:ada";

/** A host that runs setup in steps the test releases, and records what reached it. */
function fakeHost(control: ReturnType<typeof createBotComputerControl>) {
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
      requirements: { downloadBytes: 19_772_231_540, baseDiskBytes: 50e9, setupFreeBytes: 84_196_731_252, memoryPerComputerBytes: 8 * 1024 ** 3, baseVersion: "26.6.2" },
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
    // Like the real host, the status says who drives the computer.
    computer: async (botId) => {
      const computer = computers.get(botId);
      return computer ? { ...computer, controller: control.controller(botId) } : undefined;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return { host, reached, computers, finish: () => finishSetup?.() };
}

/** A viewer whose grants wait until the test settles them, so cancellation can be seen. */
function fakeViewer() {
  const grants: { botId: string; start: boolean; signal?: AbortSignal; settle(): void }[] = [];
  const viewer: BotComputerHandlerDependencies["viewer"] = {
    grant: (botId, { start, signal }) =>
      new Promise<BotComputerViewerGrant>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        grants.push({
          botId,
          start,
          signal,
          settle: () =>
            resolve({
              hostId: "bot-computers",
              deviceId: "aiden-bot-0123456789abcdef",
              grant: { origin: "http://127.0.0.1:4100", token: "t".repeat(43), expiresAt: Date.now() + 60_000 },
            }),
        });
      }),
  };
  return { viewer, grants };
}

function setup() {
  const control = createBotComputerControl();
  const fake = fakeHost(control);
  const { viewer, grants } = fakeViewer();
  const pointers = new Map<string, BotComputerPointer>();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const broadcasts: { channel: string; payload: unknown }[] = [];
  registerBotComputerHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    host: fake.host,
    viewer,
    control,
    sessions: { lastPointer: (botId) => pointers.get(botId) },
    // The event's sender stands in for Electron's WebContents.
    onSenderGone: (event, listener) => {
      const sender = (event as { sender?: EventEmitter }).sender;
      sender?.once("destroyed", listener);
      return () => void sender?.off("destroyed", listener);
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    botExists: async (botId) => botId === BOT,
    coalesceMs: 20,
  });
  const invokeFrom = (event: unknown, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler(event, ...args));
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom({}, channel, ...args);
  return { ...fake, control, grants, pointers, handlers, broadcasts, invoke, invokeFrom };
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

test("the Computer tab's grant starts the computer only when asked, and only for a Bot that exists", async () => {
  const { invoke, grants } = setup();
  const started = invoke(BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: true });
  const restored = invoke(BOT_COMPUTER_CHANNELS.viewerGrant, BOT);
  await settle(10);
  assert.deepEqual(
    grants.map(({ botId, start }) => [botId, start]),
    [
      [BOT, true],
      [BOT, false],
    ],
  );
  for (const grant of grants) grant.settle();
  assert.equal(((await started) as BotComputerViewerGrant).deviceId, "aiden-bot-0123456789abcdef");
  await restored;
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.viewerGrant, "bot:ghost", { start: true }), /no longer exists/u);
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: "yes" }), /start: boolean/u);
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: true, vm: "other" }), /start: boolean/u);
  assert.equal(grants.length, 2);
});

test("a grant whose window goes away is cancelled, and a finished one leaves no listener behind", async () => {
  const { invokeFrom, grants } = setup();
  const sender = new EventEmitter();
  const leaving = invokeFrom({ sender }, BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: true });
  await settle(10);
  assert.equal(sender.listenerCount("destroyed"), 1);
  sender.emit("destroyed");
  await assert.rejects(leaving, /cancelled/u);
  assert.equal(grants[0].signal?.aborted, true);

  const staying = invokeFrom({ sender }, BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: true });
  await settle(10);
  grants[1].settle();
  await staying;
  assert.equal(sender.listenerCount("destroyed"), 0);
  assert.equal(grants[1].signal?.aborted, false);
});

test("Take over interrupts the Bot's action and Give back returns the computer, each replying with who drives it", async () => {
  const { invoke, control, computers } = setup();
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.takeOver, BOT), /doesn't have a computer/u);
  await invoke(BOT_COMPUTER_CHANNELS.give, BOT);
  // A stopped computer can't be taken over, so the Bot is never left waiting on one nobody can give back.
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.takeOver, BOT), /isn't running/u);
  assert.equal(control.controller(BOT), "bot");
  computers.set(BOT, { ...computers.get(BOT)!, state: "running" });
  const action = control.run(BOT, undefined, (signal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  const taken = (await invoke(BOT_COMPUTER_CHANNELS.takeOver, BOT)) as BotComputerStatus;
  assert.equal(taken.controller, "person");
  assert.equal(control.takenOverBy(BOT), "viewer");
  await assert.rejects(action, BotComputerTakenOverError);
  const back = (await invoke(BOT_COMPUTER_CHANNELS.giveBack, BOT)) as BotComputerStatus;
  assert.equal(back.controller, "bot");
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.takeOver, "bot:ghost"), /no longer exists/u);
});

test("the pointer is the Bot's last action point, or null before it acted", async () => {
  const { invoke, pointers } = setup();
  assert.equal(await invoke(BOT_COMPUTER_CHANNELS.pointer, BOT), null);
  pointers.set(BOT, { x: 512, y: 300, width: 1024, height: 768 });
  assert.deepEqual(await invoke(BOT_COMPUTER_CHANNELS.pointer, BOT), { x: 512, y: 300, width: 1024, height: 768 });
  await assert.rejects(invoke(BOT_COMPUTER_CHANNELS.pointer, "../escape"), /Invalid bot id/u);
});

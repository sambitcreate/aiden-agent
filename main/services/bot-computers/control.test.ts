import assert from "node:assert/strict";
import test from "node:test";

import { createBotComputerControl } from "./control.js";
import { createBotComputerActivity, createBotComputerSessions } from "./sessions.js";
import {
  BotComputerError,
  BotComputerTakenOverError,
  type BotComputerConnection,
  type BotComputerScreen,
  type BotComputerStatus,
} from "./types.js";

const abortable = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("Take over aborts the Bot's in-flight action and refuses new ones until Give back", async () => {
  const control = createBotComputerControl();
  const changes: string[] = [];
  control.onChange((botId) => changes.push(`${botId}:${control.controller(botId)}`));
  const inflight = control.run("ada", undefined, abortable);
  control.takeOver("ada", "viewer");
  await assert.rejects(inflight, BotComputerTakenOverError);
  await assert.rejects(control.run("ada", undefined, async () => "capture"), BotComputerTakenOverError);
  assert.equal(control.controller("ada"), "person");
  assert.equal(control.controller("ben"), "bot", "other Bots keep their computers");
  assert.equal(await control.run("ben", undefined, async () => "ok"), "ok");

  let resumed = false;
  const waiting = control.waitForBot("ada", undefined).then(() => {
    resumed = true;
  });
  await Promise.resolve();
  assert.equal(resumed, false);
  control.giveBack("ada");
  await waiting;
  assert.equal(resumed, true);
  assert.equal(await control.run("ada", undefined, async () => "after"), "after");
  assert.deepEqual(changes, ["ada:person", "ada:bot"]);
});

test("the caller's own cancellation is not mistaken for Take over", async () => {
  const control = createBotComputerControl();
  const controller = new AbortController();
  const pending = control.run("ada", controller.signal, abortable);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => !(error instanceof BotComputerTakenOverError));
  const waitController = new AbortController();
  control.takeOver("ada", "sign_in");
  const waiting = control.waitForBot("ada", waitController.signal);
  waitController.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof BotComputerError && error.code === "cancelled");
  assert.equal(control.activeActions("ada"), 0);
});

function fakeHost(state: { running: boolean; port: number }) {
  const listeners = new Set<(botId: string | undefined) => void>();
  let starts = 0;
  return {
    starts: () => starts,
    changed(botId: string) {
      for (const listener of listeners) listener(botId);
    },
    host: {
      ensureRunning: async (): Promise<BotComputerConnection> => {
        starts += 1;
        state.running = true;
        return { vmName: "aiden-bot-0123456789abcdef", ip: "192.168.64.7", vnc: { host: "127.0.0.1", port: state.port, password: "pw" }, ssh: { host: "192.168.64.7", user: "lume" } };
      },
      computer: async (botId: string): Promise<BotComputerStatus> => ({
        botId,
        vmName: "aiden-bot-0123456789abcdef",
        state: state.running ? "running" : "stopped",
        baseBuild: "25G83",
        outdated: false,
        controller: "bot",
      }),
      onChange(listener: (botId: string | undefined) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  };
}

function screen(closed: string[], id: string): BotComputerScreen {
  return {
    capture: async () => ({ image: Buffer.alloc(0), mimeType: "image/png", width: 1, height: 1, framebufferWidth: 1, framebufferHeight: 1 }),
    pointer: async () => undefined,
    key: async () => undefined,
    close: async () => void closed.push(id),
  };
}

test("without P9's screen factory the screen says so, naming the Bot, and starts nothing", async () => {
  const fake = fakeHost({ running: false, port: 5900 });
  const sessions = createBotComputerSessions({ host: fake.host, control: createBotComputerControl(), botName: () => "Ada" });
  await assert.rejects(sessions.screen("ada"), (error: unknown) => String(error).includes("Ada's computer screen isn't available in this build."));
  assert.equal(fake.starts(), 0);
});

test("one screen is cached per run and dropped when the computer stops or restarts", async () => {
  const state = { running: false, port: 5900 };
  const fake = fakeHost(state);
  const closed: string[] = [];
  let opened = 0;
  const sessions = createBotComputerSessions({ host: fake.host, control: createBotComputerControl() });
  sessions.setScreenFactory(async () => screen(closed, `screen-${(opened += 1)}`));
  const first = await sessions.screen("ada");
  assert.equal(await sessions.screen("ada"), first);
  assert.equal(opened, 1);
  state.port = 5901;
  await sessions.screen("ada");
  assert.equal(opened, 2, "a new VNC endpoint is a new run");
  assert.deepEqual(closed, ["screen-1"]);
  state.running = false;
  fake.changed("ada");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(closed, ["screen-1", "screen-2"]);
});

test("the pointer registry keeps the last valid action point and activity reaches listeners", () => {
  const fake = fakeHost({ running: true, port: 5900 });
  const activity = createBotComputerActivity();
  const heard: string[] = [];
  activity.onChange((botId) => heard.push(`${botId}:${activity.get(botId) ?? ""}`));
  const sessions = createBotComputerSessions({ host: fake.host, control: createBotComputerControl(), activity });
  sessions.recordPointer("ada", { x: 10, y: 20, width: 1024, height: 768 });
  sessions.recordPointer("ada", { x: Number.NaN, y: 0, width: 1024, height: 768 });
  assert.deepEqual(sessions.lastPointer("ada"), { x: 10, y: 20, width: 1024, height: 768 });
  assert.equal(sessions.lastPointer("ben"), undefined);
  sessions.setActivity("ada", "Ada is using Safari");
  sessions.setActivity("ada", "Ada is using Safari");
  sessions.setActivity("ada", undefined);
  assert.deepEqual(heard, ["ada:Ada is using Safari", "ada:"]);
});

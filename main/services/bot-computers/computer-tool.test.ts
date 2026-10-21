import assert from "node:assert/strict";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "./control.js";
import type { BotComputerArgs } from "./computer-schema.js";
import {
  BOT_COMPUTER_CAPTURE_MAX_EDGE,
  createBotComputerTool,
  createBotComputerToolState,
  type BotComputerResultDetails,
} from "./computer-tool.js";
import {
  BotComputerError,
  type BotComputerConnection,
  type BotComputerPointer,
  type BotComputerScreen,
  type BotComputerStartReason,
} from "./types.js";

const XK_SHIFT = 0xffe1;
const XK_SUPER = 0xffeb;

type ScreenEvent =
  | { kind: "pointer"; x: number; y: number; buttons: number }
  | { kind: "key"; keysym: number; down: boolean };

interface CaptureCall {
  format: string;
  maxWidth: number;
  quality?: number;
}

/** A screen of `width`×`height` framebuffer pixels that scales captures to `maxWidth`. */
function fakeScreen(width: number, height: number, options: { blockKeysAfter?: number; oversize?: boolean } = {}) {
  const events: ScreenEvent[] = [];
  const captures: CaptureCall[] = [];
  let keys = 0;
  const screen: BotComputerScreen = {
    async capture({ format, maxWidth, quality }) {
      captures.push({ format, maxWidth, ...(quality === undefined ? {} : { quality }) });
      const scale = options.oversize ? 1 : Math.min(1, maxWidth / width);
      return {
        image: Buffer.from(`jpeg ${captures.length}`),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        framebufferWidth: width,
        framebufferHeight: height,
      };
    },
    async pointer(event) {
      events.push({ kind: "pointer", ...event });
    },
    async key(event, signal) {
      keys += 1;
      if (options.blockKeysAfter !== undefined && keys > options.blockKeysAfter && signal) {
        await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      events.push({ kind: "key", ...event });
    },
    async close() {},
  };
  return { screen, events, captures };
}

function connection(port = 5901): BotComputerConnection {
  return {
    vmName: "aiden-bot-ada",
    ip: "192.168.64.5",
    vnc: { host: "127.0.0.1", port, password: "vnc-secret-1234" },
    ssh: { host: "192.168.64.5", user: "lume" },
  };
}

function harness(options: { width?: number; height?: number; screen?: ReturnType<typeof fakeScreen>; routine?: boolean } = {}) {
  const control = createBotComputerControl();
  const state = createBotComputerToolState(control);
  const fake = options.screen ?? fakeScreen(options.width ?? 2560, options.height ?? 1600);
  const reasons: BotComputerStartReason[] = [];
  const pointers: BotComputerPointer[] = [];
  const activity: Array<string | undefined> = [];
  let touches = 0;
  let current = connection();
  let screenFailure: Error | undefined;
  const deps = {
    host: {
      async ensureRunning(_botId: string, opts: { reason: BotComputerStartReason; onProgress?(text: string): void }) {
        reasons.push(opts.reason);
        opts.onProgress?.("Starting Ada's computer…");
        return current;
      },
      touch() {
        touches += 1;
      },
    },
    sessions: {
      async screen() {
        if (screenFailure) throw screenFailure;
        return fake.screen;
      },
      recordPointer: (_botId: string, pointer: BotComputerPointer) => void pointers.push(pointer),
      setActivity: (_botId: string, text: string | undefined) => void activity.push(text),
    },
    control,
    state,
    botName: async () => "Ada",
    sleep: async () => undefined,
  };
  const tool = createBotComputerTool("ada", deps, { routine: options.routine === true });
  const call = (args: Record<string, unknown> & { action: string }, signal?: AbortSignal) =>
    tool.execute("call", args as unknown as BotComputerArgs, signal) as Promise<AgentToolResult<BotComputerResultDetails>>;
  return {
    control,
    fake,
    reasons,
    pointers,
    activity,
    touches: () => touches,
    call,
    restart: () => {
      current = connection(current.vnc.port + 1);
    },
    failScreen: (error: Error) => {
      screenFailure = error;
    },
  };
}

function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function images(result: AgentToolResult<unknown>) {
  return result.content.filter((part) => part.type === "image");
}

test("every action that changes the computer needs an intent; looking doesn't", async () => {
  const h = harness();
  const missing = await h.call({ action: "click", coordinate: [10, 10] });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /needs an intent/u);
  for (const action of ["double_click", "right_click", "scroll", "type", "key", "drag"]) {
    const result = await h.call({ action, coordinate: [1, 1], from_coordinate: [1, 1], to_coordinate: [2, 2], direction: "down", text: "x", keys: "return", intent: "   " });
    assert.equal(result.isError, true, `${action} without a real intent`);
  }
  assert.equal(h.fake.events.length, 0, "nothing reached the screen");
  const capture = await h.call({ action: "capture" });
  assert.equal(capture.isError, undefined);
  assert.equal(images(capture).length, 1);
});

test("coordinates are pixels of the newest capture, scaled to the framebuffer", async () => {
  const h = harness({ width: 2560, height: 1600 });
  const early = await h.call({ action: "click", coordinate: [100, 100], intent: "Open the Downloads folder" });
  assert.equal(early.isError, true);
  assert.match(textOf(early), /Take a capture first/u);
  assert.equal(h.fake.events.length, 0);

  const shot = await h.call({ action: "capture" });
  assert.deepEqual([shot.details.width, shot.details.height], [1280, 800]);
  assert.match(textOf(shot), /1280×800 pixels/u);

  const clicked = await h.call({ action: "click", coordinate: [640, 400], intent: "Click Place order" });
  assert.equal(clicked.isError, undefined);
  assert.deepEqual(h.fake.events, [
    { kind: "pointer", x: 1280, y: 800, buttons: 0 },
    { kind: "pointer", x: 1280, y: 800, buttons: 1 },
    { kind: "pointer", x: 1280, y: 800, buttons: 0 },
  ]);
  assert.deepEqual(last(h.pointers), { x: 1280, y: 800, width: 2560, height: 1600 }, "the viewer draws the avatar there");
  assert.equal(last(h.activity), "Ada is using the computer: Click Place order");

  h.fake.events.length = 0;
  await h.call({ action: "right_click", coordinate: [1280, 800], intent: "Open the context menu" });
  assert.deepEqual(
    h.fake.events.filter((event) => event.kind === "pointer" && event.buttons !== 0),
    [{ kind: "pointer", x: 2559, y: 1599, buttons: 4 }],
    "the far edge stays on screen, and a right click presses the right button",
  );

  const outside = await h.call({ action: "click", coordinate: [1400, 10], intent: "Click the menu" });
  assert.equal(outside.isError, true);
  assert.match(textOf(outside), /outside the newest capture/u);

  h.fake.events.length = 0;
  await h.call({ action: "drag", from_coordinate: [0, 0], to_coordinate: [100, 50], intent: "Drag the file to the folder" });
  const pressed = h.fake.events.filter((event) => event.kind === "pointer" && event.buttons === 1);
  assert.deepEqual(pressed[0], { kind: "pointer", x: 0, y: 0, buttons: 1 });
  assert.deepEqual(last(pressed), { kind: "pointer", x: 200, y: 100, buttons: 1 });
  assert.deepEqual(last(h.fake.events), { kind: "pointer", x: 200, y: 100, buttons: 0 }, "the drag ends released at its target");
});

test("a capture is a JPEG at most 1280 px on its long side, at quality 70", async () => {
  const wide = harness({ width: 3840, height: 2160 });
  const shot = await wide.call({ action: "capture" });
  assert.deepEqual(wide.fake.captures, [{ format: "jpeg", maxWidth: BOT_COMPUTER_CAPTURE_MAX_EDGE, quality: 70 }]);
  const [image] = images(shot);
  assert.equal(image?.type === "image" ? image.mimeType : undefined, "image/jpeg");
  assert.ok(Math.max(shot.details.width!, shot.details.height!) <= BOT_COMPUTER_CAPTURE_MAX_EDGE);

  const portrait = harness({ width: 1600, height: 2560 });
  const tall = await portrait.call({ action: "capture" });
  assert.ok(tall.details.height! <= BOT_COMPUTER_CAPTURE_MAX_EDGE, `height ${tall.details.height}`);
  assert.equal(portrait.fake.captures.length, 2, "a portrait screen is captured again, bounded by its height");
  assert.ok(portrait.fake.captures[1]!.maxWidth < BOT_COMPUTER_CAPTURE_MAX_EDGE);

  const oversize = harness({ screen: fakeScreen(2560, 1600, { oversize: true }) });
  const refused = await oversize.call({ action: "capture" });
  assert.equal(refused.isError, true);
  assert.equal(images(refused).length, 0, "an unbounded image never reaches the model");
});

test("while the person has the computer nothing is captured; the call waits for Give back", async () => {
  const h = harness();
  h.control.takeOver("ada", "viewer");
  let settled = false;
  const pending = h.call({ action: "capture" }).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the call waits");
  assert.equal(h.fake.captures.length, 0, "the model never sees the screen while the person has it");
  h.control.giveBack("ada");
  const result = await pending;
  assert.equal(textOf(result), BOT_COMPUTER_GIVE_BACK_NOTE);
  assert.equal(images(result).length, 0);
  assert.equal(h.fake.captures.length, 0);
  assert.equal(h.touches(), 1, "Give back restarts the idle timer, as any finished call does");
});

test("Take over interrupts the action, nothing stays held, and Give back returns the note", async () => {
  const h = harness({ screen: fakeScreen(2560, 1600, { blockKeysAfter: 1 }) });
  await h.call({ action: "capture" });
  // "A" is Shift + a: the second key event (a down) never completes.
  const typing = h.call({ action: "type", text: "Ab", intent: "Type the search terms" });
  await new Promise((resolve) => setImmediate(resolve));
  h.control.takeOver("ada", "input");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    last(h.fake.events.filter((event) => event.kind === "key")),
    { kind: "key", keysym: XK_SHIFT, down: false },
    "Shift is released after the interruption",
  );
  const touchesWhileHeld = h.touches();
  h.control.giveBack("ada");
  const result = await typing;
  assert.equal(textOf(result), BOT_COMPUTER_GIVE_BACK_NOTE);
  assert.ok(h.touches() > touchesWhileHeld, "the idle timer restarts when the call ends, after Give back");

  // The capture from before the person held the computer no longer places a click.
  const before = h.fake.events.length;
  const click = await h.call({ action: "click", coordinate: [10, 10], intent: "Click Search" });
  assert.equal(click.isError, true);
  assert.equal(textOf(click), BOT_COMPUTER_GIVE_BACK_NOTE);
  assert.equal(h.fake.events.length, before);
  await h.call({ action: "capture" });
  assert.equal((await h.call({ action: "click", coordinate: [10, 10], intent: "Click Search" })).isError, undefined);
});

test("a capture from an earlier run of the computer doesn't place a click", async () => {
  const h = harness();
  await h.call({ action: "capture" });
  h.restart();
  const click = await h.call({ action: "click", coordinate: [10, 10], intent: "Click Search" });
  assert.equal(click.isError, true);
  assert.match(textOf(click), /restarted/u);
  assert.equal(h.fake.events.length, 0);
});

test("a routine starts the computer for the routine; a person's turn for the tool", async () => {
  const routine = harness({ routine: true });
  await routine.call({ action: "capture" });
  assert.deepEqual(routine.reasons, ["routine"]);
  const attended = harness();
  await attended.call({ action: "capture" });
  assert.deepEqual(attended.reasons, ["tool"]);
  assert.equal(attended.touches(), 1, "the idle timer restarts after each call");
});

test("typing sends US-keyboard keys and never echoes the text; line breaks are refused", async () => {
  const h = harness();
  const typed = await h.call({ action: "type", text: "Hi!", intent: "Type the greeting" });
  assert.equal(typed.isError, undefined);
  assert.doesNotMatch(textOf(typed), /Hi!/u);
  assert.match(textOf(typed), /3 characters/u);
  assert.deepEqual(h.fake.events, [
    { kind: "key", keysym: XK_SHIFT, down: true },
    { kind: "key", keysym: 0x68, down: true },
    { kind: "key", keysym: 0x68, down: false },
    { kind: "key", keysym: XK_SHIFT, down: false },
    { kind: "key", keysym: 0x69, down: true },
    { kind: "key", keysym: 0x69, down: false },
    { kind: "key", keysym: XK_SHIFT, down: true },
    { kind: "key", keysym: 0x31, down: true },
    { kind: "key", keysym: 0x31, down: false },
    { kind: "key", keysym: XK_SHIFT, down: false },
  ]);
  h.fake.events.length = 0;
  const multiline = await h.call({ action: "type", text: "line one\nline two", intent: "Type the note" });
  assert.equal(multiline.isError, true);
  assert.equal(h.fake.events.length, 0, "a line break could submit a form: nothing is typed");
});

test("key chords hold their modifiers around the key; destructive shortcuts are refused", async () => {
  const h = harness();
  await h.call({ action: "key", keys: "cmd+s", intent: "Save the document" });
  assert.deepEqual(h.fake.events, [
    { kind: "key", keysym: XK_SUPER, down: true },
    { kind: "key", keysym: 0x73, down: true },
    { kind: "key", keysym: 0x73, down: false },
    { kind: "key", keysym: XK_SUPER, down: false },
  ]);
  h.fake.events.length = 0;
  const quit = await h.call({ action: "key", keys: "cmd+q", intent: "Quit the app" });
  assert.equal(quit.isError, true);
  assert.equal(h.fake.events.length, 0);
});

test("the model never sees the VNC password in an error", async () => {
  const h = harness();
  h.failScreen(new Error("RFB handshake failed for vnc://:vnc-secret-1234@127.0.0.1:5901"));
  const failed = await h.call({ action: "capture" });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(textOf(failed), /vnc-secret-1234|5901/u);
  h.failScreen(new BotComputerError("stale", "Ada's computer is missing or incomplete. Reset it in the Bot's profile."));
  const stale = await h.call({ action: "capture" });
  assert.equal(textOf(stale), "Ada's computer is missing or incomplete. Reset it in the Bot's profile.");
});

test("stopping the reply stops the call instead of reporting a failure", async () => {
  const h = harness();
  h.control.takeOver("ada", "viewer");
  const controller = new AbortController();
  const pending = h.call({ action: "capture" }, controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "../bot-computers/control.js";
import type { BotComputerArgs } from "../bot-computers/computer-schema.js";
import { createBotComputerTool, createBotComputerToolState } from "../bot-computers/computer-tool.js";
import { guestDriverSuspendScript } from "../bot-computers/guest-driver-install.js";
import type { BotComputerConnection, BotComputerGuestCommandResult, BotComputerScreen } from "../bot-computers/types.js";
import { botComputerSignInOpenScript, createBotComputerHandoffOpener } from "./bot-computer-handoff.js";
import { createBotHandoffs } from "./bot-handoffs.js";

const BOT = "bot:ada";
const ORIGIN = "https://github.com";

const CONNECTION: BotComputerConnection = {
  vmName: "aiden-bot-ada",
  ip: "192.168.64.5",
  vnc: { host: "127.0.0.1", port: 5901, password: "vnc-secret-1234" },
  ssh: { host: "192.168.64.5", user: "lume" },
};

function ok(): BotComputerGuestCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };
}

function setup(options: { enabled?: boolean; hasComputer?: boolean; failOn?: "suspend" | "open" } = {}) {
  const control = createBotComputerControl();
  const handoffs = createBotHandoffs();
  const commands: string[] = [];
  const starts: string[] = [];
  const errors: unknown[] = [];
  /** Who held the computer when each guest command ran. */
  const heldDuring: string[] = [];
  let beforeOpen: (() => void) | undefined;
  const open = createBotComputerHandoffOpener({
    host: {
      computer: async () => (options.hasComputer === false ? undefined : ({ state: "stopped" } as never)),
      ensureRunning: async (_botId, { reason }) => {
        starts.push(reason);
        return CONNECTION;
      },
      runGuestCommand: async (_botId, command) => {
        commands.push(command);
        heldDuring.push(control.controller(BOT));
        if (command === guestDriverSuspendScript()) return options.failOn === "suspend" ? { ...ok(), exitCode: 255 } : ok();
        beforeOpen?.();
        return options.failOn === "open" ? { ...ok(), exitCode: 1 } : ok();
      },
    },
    control,
    handoffs,
    enabled: () => options.enabled ?? true,
    onError: (error) => errors.push(error),
  });
  const ask = (waitId: string) => {
    const controller = new AbortController();
    const answer = handoffs
      .request({
        botId: BOT,
        waitId,
        toolCallId: `call-${waitId}`,
        kind: "sign_in",
        action: "Sign in to github.com",
        open: { url: ORIGIN },
        origin: ORIGIN,
        target: "computer",
        source: "tool",
        signal: controller.signal,
      })
      .catch(() => null);
    return { controller, answer };
  };
  return {
    control,
    handoffs,
    open,
    ask,
    commands,
    starts,
    errors,
    heldDuring,
    whileOpening: (fn: () => void) => {
      beforeOpen = fn;
    },
  };
}

test("Open takes the computer over, stops the screen helper, then opens the site in Safari", async () => {
  const h = setup();
  h.ask("wait-1");
  assert.equal(await h.open(BOT, "wait-1", ORIGIN), true);
  assert.deepEqual(h.starts, ["viewer"], "the person's Open starts the computer, as opening its Computer tab does");
  assert.deepEqual(h.commands, [guestDriverSuspendScript(), botComputerSignInOpenScript(ORIGIN)]);
  assert.deepEqual(h.heldDuring, ["person", "person"], "the person holds the computer before anything opens on it");
  assert.equal(h.control.controller(BOT), "person");
  assert.equal(h.control.takenOverBy(BOT), "sign_in");
});

test("the computer is given back once the card is answered or withdrawn", async () => {
  const h = setup();
  const card = h.ask("wait-1");
  await h.open(BOT, "wait-1", ORIGIN);
  h.handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  assert.equal(h.control.controller(BOT), "bot");

  const stopped = h.ask("wait-2");
  await h.open(BOT, "wait-2", ORIGIN);
  assert.equal(h.control.controller(BOT), "person");
  stopped.controller.abort(new Error("Stopped"));
  await stopped.answer;
  assert.equal(h.control.controller(BOT), "bot");
});

test("a person who gave the computer back and took it again from the viewer keeps it", async () => {
  const h = setup();
  const card = h.ask("wait-1");
  await h.open(BOT, "wait-1", ORIGIN);
  h.control.giveBack(BOT);
  h.control.takeOver(BOT, "viewer");
  h.handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  assert.equal(h.control.controller(BOT), "person");
  assert.equal(h.control.takenOverBy(BOT), "viewer");
});

test("if the helper can't be stopped or the page can't open, nothing opens and the Bot gets its computer back", async () => {
  for (const failOn of ["suspend", "open"] as const) {
    const h = setup({ failOn });
    h.ask("wait-1");
    assert.equal(await h.open(BOT, "wait-1", ORIGIN), false, failOn);
    assert.equal(h.control.controller(BOT), "bot", failOn);
    assert.equal(h.errors.length, 1);
    if (failOn === "suspend") assert.deepEqual(h.commands, [guestDriverSuspendScript()], "the page never opens on a computer whose helper still runs");
  }
});

test("a card answered while the page opened doesn't leave the computer with the person", async () => {
  const h = setup();
  const card = h.ask("wait-1");
  h.whileOpening(() => h.handoffs.answer(BOT, "wait-1", { outcome: "skipped" }));
  assert.equal(await h.open(BOT, "wait-1", ORIGIN), true);
  await card.answer;
  assert.equal(h.control.controller(BOT), "bot");
});

test("nothing opens without Bot computers, without the Bot's computer, or for a card no longer waiting", async () => {
  for (const options of [{ enabled: false }, { hasComputer: false }]) {
    const h = setup(options);
    h.ask("wait-1");
    assert.equal(await h.open(BOT, "wait-1", ORIGIN), false);
    assert.deepEqual([h.starts, h.commands], [[], []]);
    assert.equal(h.control.controller(BOT), "bot");
  }
  const h = setup();
  assert.equal(await h.open(BOT, "wait-gone", ORIGIN), false);
  assert.deepEqual(h.starts, []);
});

test("while the person signs in, the Bot's computer call waits and sees nothing; it resumes after the card is answered", async () => {
  const h = setup();
  const state = createBotComputerToolState(h.control);
  let captures = 0;
  const screen: BotComputerScreen = {
    capture: async ({ maxWidth }) => {
      captures += 1;
      return { image: Buffer.from("jpeg"), mimeType: "image/jpeg", width: maxWidth, height: 800, framebufferWidth: 2560, framebufferHeight: 1600 };
    },
    pointer: async () => undefined,
    key: async () => undefined,
    close: async () => undefined,
  };
  const tool = createBotComputerTool(
    BOT,
    {
      host: { ensureRunning: async () => CONNECTION, touch: () => undefined },
      sessions: { screen: async () => screen, recordPointer: () => undefined, setActivity: () => undefined },
      control: h.control,
      state,
      botName: async () => "Ada",
      sleep: async () => undefined,
    },
    { routine: false },
  );
  const card = h.ask("wait-1");
  await h.open(BOT, "wait-1", ORIGIN);
  const call = tool.execute("c1", { action: "capture" } as unknown as BotComputerArgs) as Promise<AgentToolResult<unknown>>;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captures, 0, "no capture while the person signs in");
  h.handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await card.answer;
  const result = await call;
  assert.deepEqual(result.content, [{ type: "text", text: BOT_COMPUTER_GIVE_BACK_NOTE }]);
  assert.equal(captures, 0);
});

test("the open command passes the site to Safari as one argument", () => {
  const url = "https://example.com/$(touch pwned)'x";
  const script = botComputerSignInOpenScript(url).replace(/^\/usr\/bin\/open /u, "printf '%s\\n' ");
  const argv = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(argv, ["-b", "com.apple.Safari", url]);
});

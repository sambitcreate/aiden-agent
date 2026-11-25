import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "../bot-computers/control.js";
import type { BotComputerArgs } from "../bot-computers/computer-schema.js";
import { createBotComputerTool, createBotComputerToolState } from "../bot-computers/computer-tool.js";
import { guestDriverSuspendScript } from "../bot-computers/guest-driver-install.js";
import type { BotComputerConnection, BotComputerGuestCommandResult, BotComputerScreen } from "../bot-computers/types.js";
import {
  botComputerSignInOpenScript,
  botComputerStopShellUserScript,
  createBotComputerHandoffOpener,
} from "./bot-computer-handoff.js";
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

function setup(
  options: { enabled?: boolean; hasComputer?: boolean; failOn?: "suspend" | "stopShellUser" | "open" } = {},
) {
  const control = createBotComputerControl();
  const handoffs = createBotHandoffs();
  const commands: string[] = [];
  const starts: string[] = [];
  const errors: unknown[] = [];
  /** Who held the computer when each guest command ran. */
  const heldDuring: string[] = [];
  let beforeOpen: (() => void) | undefined;
  const suspendScript = guestDriverSuspendScript();
  const stopShellScript = botComputerStopShellUserScript();
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
        if (command === suspendScript) return options.failOn === "suspend" ? { ...ok(), exitCode: 255 } : ok();
        if (command === stopShellScript) return options.failOn === "stopShellUser" ? { ...ok(), exitCode: 76 } : ok();
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

test("Open takes the computer over, stops the screen helper and aiden-bot processes, then opens Chromium", async () => {
  const h = setup();
  h.ask("wait-1");
  assert.equal(await h.open(BOT, "wait-1", ORIGIN), true);
  assert.deepEqual(h.starts, ["viewer"], "the person's Open starts the computer, as opening its Computer tab does");
  assert.deepEqual(h.commands, [
    guestDriverSuspendScript(),
    botComputerStopShellUserScript(),
    botComputerSignInOpenScript(ORIGIN),
  ]);
  assert.deepEqual(h.heldDuring, ["person", "person", "person"], "the person holds the computer before anything opens on it");
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

test("a card asked again under the same wait id leaves the computer with the person signing in", async () => {
  const h = setup();
  h.ask("wait-1");
  await h.open(BOT, "wait-1", ORIGIN);
  // The same call asks again (its stale invocation is withdrawn): it is the same card.
  const again = h.ask("wait-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.control.controller(BOT), "person", "the person is still signing in");
  assert.equal(h.control.takenOverBy(BOT), "sign_in");

  h.handoffs.answer(BOT, "wait-1", { outcome: "done" });
  await again.answer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.control.controller(BOT), "bot", "answered, the computer goes back to the Bot");
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

test("if stopping aiden-bot processes fails, Chromium never opens and control returns to the Bot", async () => {
  const failed = setup({ failOn: "stopShellUser" });
  failed.ask("wait-2");
  assert.equal(await failed.open(BOT, "wait-2", ORIGIN), false);
  assert.deepEqual(failed.commands, [guestDriverSuspendScript(), botComputerStopShellUserScript()]);
  assert.equal(failed.control.controller(BOT), "bot");
  assert.equal(failed.errors.length, 1);
});

test("Linux open script launches Chromium detached on DISPLAY=:0 with quoted URL and fails closed when missing", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const out = path.join(dir, "chromium.args");
  const fakeChromium = path.join(bin, "chromium");
  spawnSync("/bin/mkdir", ["-p", bin]);
  writeFileSync(
    fakeChromium,
    `#!/bin/sh\nprintf 'DISPLAY=%s\\n' "$DISPLAY" > ${JSON.stringify(out)}\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(out)}; done\n`,
  );
  chmodSync(fakeChromium, 0o755);

  const url = "https://example.com/$(touch pwned)'x";
  const ran = spawnSync("/bin/sh", ["-c", botComputerSignInOpenScript(url)], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(ran.status, 0, ran.stderr);
  // Wait briefly for the detached background child to finish writing its marker.
  for (let tries = 0; !existsSync(out) && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(out), true, "fake chromium ran");
  const lines = readFileSync(out, "utf8").trimEnd().split("\n");
  assert.deepEqual(lines, ["DISPLAY=:0", "--new-window", url]);

  // Without chromium on PATH, the script fails closed with exit 127.
  const missing = spawnSync("/bin/sh", ["-c", botComputerSignInOpenScript(url)], {
    env: { PATH: path.join(dir, "empty-bin") },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(missing.status, 127);

  // Stop-shell-user script fails closed (exit 76) if the target user doesn't exist, and rejects invalid names.
  const nonexistent = spawnSync("/bin/sh", ["-c", botComputerStopShellUserScript("aiden-nonexistent-user-xyz")], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(nonexistent.status, 76);
  assert.throws(() => botComputerStopShellUserScript("bad;user"), /Invalid Linux shell user/u);
});

test("two Bots sharing one VM keep person sign-in control until both sign-in cards settle", async () => {
  const control = createBotComputerControl();
  control.setScopeResolver(
    (botId) => (botId === "bot:ada" || botId === "bot:ben" ? "shared" : botId),
    (scope) => (scope === "shared" ? ["bot:ada", "bot:ben"] : []),
  );
  const handoffs = createBotHandoffs();
  const open = createBotComputerHandoffOpener({
    host: {
      computer: async (botId) =>
        ({
          botId,
          vmName: "aiden-vm-shared",
          computerId: "shared",
          computerName: "Shared computer",
          shared: true,
          state: "running",
          baseBuild: "20261123-2671",
          outdated: false,
          controller: control.controller(botId),
        }),
      ensureRunning: async () => CONNECTION,
      runGuestCommand: async () => ok(),
    },
    control,
    handoffs,
    enabled: () => true,
  });
  const askFor = (botId: string, waitId: string) => {
    const controller = new AbortController();
    const answer = handoffs
      .request({
        botId,
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

  const adaCard = askFor("bot:ada", "wait-ada");
  const benCard = askFor("bot:ben", "wait-ben");
  assert.equal(await open("bot:ada", "wait-ada", ORIGIN), true);
  assert.equal(await open("bot:ben", "wait-ben", ORIGIN), true);
  assert.equal(control.controller("bot:ada"), "person");
  assert.equal(control.controller("bot:ben"), "person");

  // Settling Ada's sign-in card must NOT give back the shared VM while Ben's card is still open.
  handoffs.answer("bot:ada", "wait-ada", { outcome: "done" });
  await adaCard.answer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.controller("bot:ada"), "person");
  assert.equal(control.controller("bot:ben"), "person");
  assert.equal(control.takenOverBy("bot:ben"), "sign_in");

  // Settling Ben's card releases the shared VM back to both Bots.
  handoffs.answer("bot:ben", "wait-ben", { outcome: "done" });
  await benCard.answer;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.controller("bot:ada"), "bot");
  assert.equal(control.controller("bot:ben"), "bot");
});

test("reassigning a Bot off a shared VM while its sign-in card is open still releases the original VM when the card settles", async () => {
  const assignments = new Map<string, string>([
    ["bot:ada", "shared"],
    ["bot:ben", "shared"],
  ]);
  const control = createBotComputerControl();
  control.setScopeResolver(
    (botId) => assignments.get(botId) ?? botId,
    (scope) => [...assignments.entries()].filter(([, id]) => id === scope).map(([botId]) => botId),
  );
  const handoffs = createBotHandoffs();
  const open = createBotComputerHandoffOpener({
    host: {
      computer: async (botId) => {
        const computerId = assignments.get(botId) ?? "shared";
        return {
          botId,
          vmName: computerId === "shared" ? "aiden-vm-shared" : "aiden-vm-dedicated",
          computerId,
          computerName: computerId === "shared" ? "Shared computer" : "Dedicated",
          shared: computerId === "shared",
          state: "running",
          baseBuild: "20261123-2671",
          outdated: false,
          controller: control.controller(botId),
        };
      },
      ensureRunning: async () => CONNECTION,
      runGuestCommand: async () => ok(),
    },
    control,
    handoffs,
    enabled: () => true,
  });

  const controller = new AbortController();
  const card = handoffs
    .request({
      botId: "bot:ada",
      waitId: "wait-reassign",
      toolCallId: "call-reassign",
      kind: "sign_in",
      action: "Sign in to github.com",
      open: { url: ORIGIN },
      origin: ORIGIN,
      target: "computer",
      source: "tool",
      signal: controller.signal,
    })
    .catch(() => null);

  assert.equal(await open("bot:ada", "wait-reassign", ORIGIN), true);
  assert.equal(control.controllerForScope("shared"), "person");
  assert.equal(control.controller("bot:ben"), "person");

  // Reassign Ada to a dedicated VM before answering the sign-in card.
  assignments.set("bot:ada", "vm-dedicated");
  assert.equal(control.controllerForScope("shared"), "person");
  assert.equal(control.controller("bot:ben"), "person");

  // Settling Ada's sign-in card must release the original "shared" scope, not leave Ben locked out.
  handoffs.answer("bot:ada", "wait-reassign", { outcome: "done" });
  await card;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.controllerForScope("shared"), "bot");
  assert.equal(control.controller("bot:ben"), "bot");
});

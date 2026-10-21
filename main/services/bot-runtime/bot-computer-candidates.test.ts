import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotComputerControl } from "../bot-computers/control.js";
import { createBotComputerToolState } from "../bot-computers/computer-tool.js";
import type { BotComputerStatus } from "../bot-computers/types.js";
import type { CuaDriverHostFactory } from "../computer-use/controller.js";
import { botComputerCandidates, botHasComputer, type BotComputerCandidateInput, type BotComputerToolServices } from "./bot-computer-candidates.js";

const BOT = "bot-1";

function services(options: { guestDriver?: boolean | "unreadable" } = {}) {
  let loads = 0;
  const control = createBotComputerControl();
  const host: BotComputerToolServices["host"] = {
    computer: async () => ({ botId: BOT, state: "stopped" }) as unknown as BotComputerStatus,
    ensureRunning: async () => {
      throw new Error("no computer is started while the tools are built");
    },
    touch: () => {},
    runGuestCommand: async () => {
      throw new Error("no command runs while the tools are built");
    },
    guestDriver: async () => {
      if (options.guestDriver === "unreadable") throw new Error("the base can't be read");
      return options.guestDriver ? ({} as CuaDriverHostFactory) : undefined;
    },
  };
  const sessions = {
    screen: async () => {
      throw new Error("no screen opens while the tools are built");
    },
  } as unknown as BotComputerToolServices["sessions"];
  return {
    loads: () => loads,
    computers: () => {
      loads += 1;
      return { host, sessions, control };
    },
  };
}

function turn(overrides: Partial<BotComputerCandidateInput> & { computers: BotComputerCandidateInput["computers"] }): BotComputerCandidateInput {
  return {
    granted: true,
    hasComputer: true,
    supportsImages: true,
    routine: false,
    telegram: false,
    state: (control) => createBotComputerToolState(control),
    botName: async () => "Ada",
    ...overrides,
  };
}

const names = (candidates: Awaited<ReturnType<typeof botComputerCandidates>>) => candidates.map((candidate) => candidate.tool.name);

test("a turn gets the computer tools only when the Bot's access grants the computer and it has one", async () => {
  for (const [granted, hasComputer] of [
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const fake = services();
    assert.deepEqual(await botComputerCandidates(BOT, turn({ granted, hasComputer, computers: fake.computers })), []);
    assert.equal(fake.loads(), 0, "the Bot computer services are never loaded for a turn without the tools");
  }
  const fake = services();
  const candidates = await botComputerCandidates(BOT, turn({ computers: fake.computers }));
  assert.deepEqual(names(candidates), ["computer", "computer_shell"]);
  assert.ok(
    candidates.every((candidate) => candidate.replay === "unsafe"),
    "a click or a command that already ran must never be replayed",
  );
});

test("a model that can't take images gets the shell alone", async () => {
  const fake = services();
  assert.deepEqual(names(await botComputerCandidates(BOT, turn({ supportsImages: false, computers: fake.computers }))), ["computer_shell"]);
});

test("hand_off is offered only on turns a person can answer", async () => {
  const description = async (overrides: Partial<BotComputerCandidateInput>) => {
    const fake = services();
    const candidates = await botComputerCandidates(BOT, turn({ ...overrides, computers: fake.computers }));
    return candidates.find((candidate) => candidate.tool.name === "computer")?.tool.description ?? "";
  };
  assert.match(await description({}), /hand_off/u);
  assert.doesNotMatch(await description({ routine: true }), /hand_off/u);
  assert.doesNotMatch(await description({ telegram: true }), /hand_off/u);
});

test("the element lane is described only for a computer whose base passed its probe", async () => {
  const description = async (guestDriver: boolean | "unreadable") => {
    const fake = services({ guestDriver });
    const [computer] = await botComputerCandidates(BOT, turn({ computers: fake.computers }));
    return computer.tool.description;
  };
  assert.match(await description(true), /has element control/u);
  assert.doesNotMatch(await description(false), /has element control/u);
  assert.doesNotMatch(await description("unreadable"), /has element control/u, "an unreadable base counts as no element control");
});

test("a Bot has a computer only where Bot computers exist and its state reads as one", async () => {
  let loaded = 0;
  const reading = (computer: () => Promise<BotComputerStatus | undefined>) => () => {
    loaded += 1;
    return { host: { ...services().computers().host, computer } };
  };
  const one = async () => ({ botId: BOT, state: "running" }) as unknown as BotComputerStatus;

  assert.equal(await botHasComputer(BOT, { enabled: () => false, computers: reading(one) }), false);
  assert.equal(loaded, 0, "where Bot computers don't exist, their services are never built");

  assert.equal(await botHasComputer(BOT, { enabled: () => true, computers: reading(one) }), true);
  assert.equal(await botHasComputer(BOT, { enabled: () => true, computers: reading(async () => undefined) }), false);
  assert.equal(
    await botHasComputer(BOT, {
      enabled: () => true,
      computers: reading(async () => {
        throw new Error("the computer's state can't be read");
      }),
    }),
    false,
    "an unreadable state counts as no computer",
  );
});

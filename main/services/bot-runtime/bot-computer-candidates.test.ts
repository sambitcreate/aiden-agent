import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "../bot-computers/control.js";
import { createBotComputerToolState } from "../bot-computers/computer-tool.js";
import type { BotComputerStatus } from "../bot-computers/types.js";
import type { CuaDriverHostFactory } from "../computer-use/controller.js";
import { botComputerCandidates, botHasComputer, type BotComputerCandidateInput, type BotComputerToolServices } from "./bot-computer-candidates.js";
import type { BotToolCall } from "./tool-adapter.js";

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

/** A call as the registry binds it, serving a run whose inputs have these request ids. */
function callServing(...requestIds: string[]): BotToolCall {
  return { callId: "call", signal: new AbortController().signal, runRequestIds: async () => requestIds } as unknown as BotToolCall;
}

/** The call's result, or "still waiting" if it hasn't settled within `ms`. */
async function within<T>(call: Promise<T>, ms: number): Promise<T | "still waiting"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"still waiting">((resolve) => {
    timer = setTimeout(() => resolve("still waiting"), ms);
  });
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

const resultText = (result: AgentToolResult<unknown>) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

test("the run a call serves decides how long it waits for Give back, and a routine or Telegram run waits once across both tools", async () => {
  for (const requestId of ["routine:task-1:2026-10-07T09:00:00.000Z", "tg:bot:1:0:5"]) {
    const fake = services();
    // Built as the registry builds them: for an attended turn.
    const [computer, shell] = await botComputerCandidates(BOT, turn({ computers: fake.computers, unattendedWaitMs: 300 }));
    const { control } = fake.computers();
    control.takeOver(BOT, "viewer");
    const run = callServing(requestId);
    const first = await within(computer.bind!(run).execute("look", { action: "capture" } as never), 5_000);
    assert.notEqual(first, "still waiting", requestId);
    if (first === "still waiting") continue;
    assert.match(resultText(first), /still using Ada's computer/u);
    // The run's wait is used up: the shell doesn't wait the whole time over.
    const second = await within(shell.bind!(run).execute("ls", { command: "ls", description: "List" } as never), 150);
    assert.notEqual(second, "still waiting", `${requestId}: the shell gives up at once`);
    if (second !== "still waiting") assert.match(resultText(second), /still using Ada's computer/u);
    assert.equal(control.controller(BOT), "person", "the person keeps the computer");
  }

  // A run someone attends keeps waiting until they give it back.
  const fake = services();
  const [computer] = await botComputerCandidates(BOT, turn({ computers: fake.computers, unattendedWaitMs: 50 }));
  const { control } = fake.computers();
  control.takeOver(BOT, "viewer");
  const waiting = computer.bind!(callServing("desk-1")).execute("look", { action: "capture" } as never);
  assert.equal(await within(waiting, 200), "still waiting");
  control.giveBack(BOT);
  assert.equal(resultText(await waiting), BOT_COMPUTER_GIVE_BACK_NOTE);
});

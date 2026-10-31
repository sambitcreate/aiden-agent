import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { botRuleLabel, defaultBotRules } from "../../../renderer/shared/bot-rules.js";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "../bot-computers/control.js";
import { createBotComputerShellTool } from "../bot-computers/computer-shell-tool.js";
import type { BotComputerDriverFacts } from "../bot-computers/computer-elements.js";
import type { BotComputerArgs } from "../bot-computers/computer-schema.js";
import { createGuestCuaDriverHostFactory } from "../bot-computers/guest-driver.js";
import { classifyBotAction } from "../bot-rules/classify.js";
import { createBotComputerTool, createBotComputerToolState } from "../bot-computers/computer-tool.js";
import type { BotComputerConnection, BotComputerScreen } from "../bot-computers/types.js";
import type { BotOrdinaryCapabilityKind } from "../bot-capability-catalog-core.js";
import { botComputerAction } from "./bot-computer-approval.js";
import { botComputerCandidates } from "./bot-computer-candidates.js";
import { createBotRegistry, type BotExtensionDeps } from "./bot-extension.js";
import { createBotHandoffs, ruleHandoffRequest } from "./bot-handoffs.js";
import { ruleAskUnattendedBlock } from "./bot-handoff-text.js";
import { BOT_OLDER_COMPUTER_CAPTURE_NOTE } from "./bot-images.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { botIngressAllowsTool, botToolApprovalSummary, botToolVerdict, type BotToolFacts } from "./bot-tool-policy.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority, type AssemblyDepsOptions } from "./test-support/assembly-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";
const ROUTINE = "routine:task-1:2026-10-07T09:00:00.000Z";
const TELEGRAM = "tg:bot:1:0:5";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-computer-"));
  roots.push(home);
  return home;
}

/* ------------------------------------------------------------------------- */
/* Policy                                                                     */
/* ------------------------------------------------------------------------- */

function facts(kinds: string[], hasComputer: boolean, supportsImages = true): BotToolFacts {
  return {
    authority: { otherCapabilities: kinds.map((kind) => ({ kind })) },
    supportsImages,
    fileLocations: 0,
    hasComputer,
    mcpTools: async () => new Map(),
    skillToolNames: async () => new Set(),
  } as unknown as BotToolFacts;
}

test("the computer needs the Bot computer capability and the Bot's own computer, and routines may use it", async () => {
  for (const name of ["computer", "computer_shell"]) {
    assert.deepEqual(await botToolVerdict(name, facts(["computer"], true)), { allowed: true }, name);
    assert.deepEqual(await botToolVerdict(name, facts(["computer"], false)), {
      allowed: false,
      reason: "This Bot doesn't have a computer yet.",
    });
    assert.deepEqual(await botToolVerdict(name, facts(["computer_use", "browser"], true)), {
      allowed: false,
      reason: "The computer is off for this Bot.",
    });
    // Unlike Computer Use and the browser, the Bot's own computer works unattended (§8.7).
    assert.deepEqual(await botToolVerdict(name, facts(["computer"], true), { routine: true }), { allowed: true });
    assert.deepEqual(await botToolVerdict(name, facts(["computer"], true), { telegram: true }), { allowed: true });
    assert.equal(botIngressAllowsTool(name, [ROUTINE]), true);
    assert.equal(botIngressAllowsTool(name, [TELEGRAM]), true);
    // The baseline inside its own computer never asks.
    assert.equal(await botToolApprovalSummary(name, { action: "click", intent: "Click Buy" }, facts(["computer"], true)), undefined);
  }
  // The screen is vision only: a model without image input keeps the shell.
  assert.equal((await botToolVerdict("computer", facts(["computer"], true, false))).allowed, false);
  assert.deepEqual(await botToolVerdict("computer_shell", facts(["computer"], true, false)), { allowed: true });
  // Computer Use on the person's Mac is a different capability.
  assert.equal((await botToolVerdict("computer_use", facts(["computer"], true))).allowed, false);
});

test("the computer's guidance sends secrets to hand_off only on turns that have hand_off", async () => {
  const control = createBotComputerControl();
  const state = createBotComputerToolState(control);
  const unused = async (): Promise<never> => {
    throw new Error("not called");
  };
  for (const turn of [{}, { routine: true }, { telegram: true }] as const) {
    const routine = "routine" in turn;
    const unattended = routine || "telegram" in turn;
    // As production's sources build it for that turn.
    const tool = createBotComputerTool(
      BOT,
      {
        host: { ensureRunning: unused, touch: () => undefined },
        sessions: { screen: unused, recordPointer: () => undefined, setActivity: () => undefined },
        control,
        state,
        botName: async () => "Ada",
      },
      { routine, unattended },
    );
    const handOffOffered = (await botToolVerdict("hand_off", facts(["computer"], true), turn)).allowed;
    assert.equal(tool.description.includes("hand_off"), handOffOffered, `${JSON.stringify(turn)}: never a tool the turn lacks`);
    // Either way the Bot is kept away from passwords, codes and payments.
    assert.match(tool.description, /passwords, codes/u);
  }
});

test("the rules read a computer step's stated intent; looking and invalid calls classify nothing", () => {
  assert.deepEqual(botComputerAction({ args: { action: "click", coordinate: [1, 2], intent: "  Click‮ Place order " } }), {
    approval: null,
    action: { surface: "computer", action: "click", intent: "Click Place order" },
    summary: "Click Place order",
  });
  // Typed text never reaches the classifier.
  const typed = botComputerAction({ args: { action: "type", text: "hunter2", intent: "Type the password" } });
  assert.equal(JSON.stringify(typed).includes("hunter2"), false);
  // A chord that presses something reads like a click; one that types a letter is typing.
  assert.deepEqual(botComputerAction({ args: { action: "key", keys: "return", intent: "Send the message" } }).action, {
    surface: "computer",
    action: "press",
    intent: "Send the message",
  });
  assert.deepEqual(botComputerAction({ args: { action: "key", keys: "shift+a", intent: "Type A" } }).action, {
    surface: "computer",
    action: "key",
    intent: "Type A",
  });
  const classesOf = (args: Record<string, unknown>, driverFacts?: BotComputerDriverFacts) => [
    ...classifyBotAction(botComputerAction({ args }, driverFacts).action!, []).classes,
  ];
  const inField = { run: "run-1", epoch: 1, app: "Notes", focused: { role: "AXTextArea", label: "Note body" } };
  // In a text field the Bot clicked, Backspace or Delete erases a character it typed: editing text, not deleting something.
  for (const keys of ["backspace", "Delete", "forwarddelete", "shift+backspace"]) {
    assert.deepEqual(classesOf({ action: "key", keys, intent: "Delete the extra letter" }, inField), [], keys);
  }
  assert.deepEqual(
    classesOf({ action: "key", keys: "backspace", intent: "Delete the old password" }, { ...inField, focused: { role: "AXSecureTextField" } }),
    ["credentials"],
  );
  // Anywhere else the same key deletes what is selected: a message in Mail, or whatever the VNC lane can't see.
  const inList = { run: "run-1", epoch: 1, app: "Mail", focused: { role: "AXRow", label: "Ada Lovelace, Lunch on Friday" } };
  assert.deepEqual(classesOf({ action: "key", keys: "backspace", intent: "Delete the email from Ada" }, inList), ["delete"]);
  assert.deepEqual(classesOf({ action: "key", keys: "Delete", intent: "Delete the email from Ada" }), ["delete"]);
  // With Command, Delete is a command (Finder's Move to Trash), and a click that deletes still deletes.
  assert.deepEqual(classesOf({ action: "key", keys: "cmd+backspace", intent: "Delete the file" }, inField), ["delete"]);
  assert.deepEqual(classesOf({ action: "click", coordinate: [1, 2], intent: "Delete the file" }), ["delete"]);
  assert.deepEqual(botComputerAction({ args: { action: "capture" } }), { approval: null });
  assert.deepEqual(botComputerAction({ args: { action: "click", coordinate: [1, 2] } }), { approval: null });
  assert.deepEqual(botComputerAction({ args: { action: "format_disk", intent: "Erase it" } }), { approval: null });
});

test("on the guest driver lane the rules read the clicked element, its app and window; typing into a clicked password field is credentials", async () => {
  const dir = tempHome();
  const elements = path.join(dir, "elements.json");
  writeFileSync(
    elements,
    JSON.stringify([
      { role: "AXSecureTextField", label: "Password", frame: { x: 110, y: 60, w: 80, h: 20 }, depth: 1 },
      { role: "AXButton", label: "Delete account", frame: { x: 110, y: 100, w: 80, h: 20 }, depth: 1 },
    ]),
  );
  const fixture = fileURLToPath(new URL("../bot-computers/fixtures/guest-cua-driver.mjs", import.meta.url));
  const control = createBotComputerControl();
  const state = createBotComputerToolState(control);
  const screen: BotComputerScreen = {
    capture: async ({ maxWidth }) => ({
      image: Buffer.from("jpeg"),
      mimeType: "image/jpeg",
      width: maxWidth,
      height: Math.round(maxWidth / 1.6),
      framebufferWidth: 2560,
      framebufferHeight: 1600,
    }),
    pointer: async () => undefined,
    key: async () => undefined,
    close: async () => undefined,
  };
  const connection: BotComputerConnection = {
    vmName: "aiden-bot-1",
    ip: "192.168.64.9",
    vnc: { host: "127.0.0.1", port: 5905, password: "vnc-password-abcd" },
    ssh: { host: "192.168.64.9", user: "lume" },
  };
  const factory = createGuestCuaDriverHostFactory({
    bridge: () => ({ command: process.execPath, args: [fixture, "--elements", elements], env: { PATH: "/usr/bin:/bin" } }),
  });
  const tool = createBotComputerTool(
    BOT,
    {
      host: { ensureRunning: async () => connection, touch: () => undefined, guestDriver: async () => factory },
      sessions: { screen: async () => screen, recordPointer: () => undefined, setActivity: () => undefined },
      control,
      state,
      botName: async () => "Ada",
      sleep: async () => undefined,
    },
    { routine: false, elementControl: true },
  );
  try {
    const run = (id: string, args: Record<string, unknown>) => tool.execute(id, args as unknown as BotComputerArgs);
    await run("c1", { action: "capture", app: "Safari" });
    const click = { args: { action: "click", element: 1, intent: "Click the red button" } };
    assert.deepEqual(botComputerAction(click, state.driverFacts(BOT)).action, {
      surface: "computer",
      action: "click",
      intent: "Click the red button",
      app: "Safari",
      windowTitle: "Example",
      element: { role: "AXButton", label: "Delete account" },
    });
    // The element's label carries what the Bot's intent left out.
    const withElement = botComputerAction(click, state.driverFacts(BOT)).action!;
    assert.equal(classifyBotAction(withElement, []).classes.has("delete"), true);
    assert.equal(classifyBotAction(botComputerAction(click).action!, []).classes.has("delete"), false, "the VNC lane has only the intent");

    assert.equal((await run("c2", { action: "click", element: 0, intent: "Click the field" })).isError, undefined);
    // Clearing the field first keeps it focused, so what's typed next still reads as going into a password field.
    assert.equal((await run("c3", { action: "key", keys: "backspace", intent: "Clear the field" })).isError, undefined);
    const typing = botComputerAction({ args: { action: "type", text: "hunter2", intent: "Type it in" } }, state.driverFacts(BOT));
    assert.deepEqual(typing.action && "element" in typing.action ? typing.action.element : undefined, {
      role: "AXSecureTextField",
      label: "Password",
    });
    assert.equal(classifyBotAction(typing.action!, []).classes.has("credentials"), true);
    assert.equal(JSON.stringify(typing).includes("hunter2"), false, "typed text never reaches the classifier");

    // Once the person has held the computer, nothing Aiden saw before describes the screen.
    control.takeOver(BOT, "viewer");
    control.giveBack(BOT);
    assert.equal(state.driverFacts(BOT), undefined);
  } finally {
    await state.shutdown();
  }
});

/* ------------------------------------------------------------------------- */
/* Through a real Bot turn                                                    */
/* ------------------------------------------------------------------------- */

/** A Bot computer with a 2560×1600 screen; captures are half size. */
function fakeComputer() {
  const control = createBotComputerControl();
  const state = createBotComputerToolState(control);
  const events: string[] = [];
  let captures = 0;
  const screen: BotComputerScreen = {
    async capture({ maxWidth }) {
      captures += 1;
      const scale = Math.min(1, maxWidth / 2560);
      return {
        image: Buffer.from(`capture-${captures}`),
        mimeType: "image/jpeg",
        width: Math.round(2560 * scale),
        height: Math.round(1600 * scale),
        framebufferWidth: 2560,
        framebufferHeight: 1600,
      };
    },
    async pointer({ x, y, buttons }) {
      events.push(`pointer ${x},${y} ${buttons}`);
    },
    async key({ keysym, down }) {
      events.push(`key ${keysym.toString(16)} ${down ? "down" : "up"}`);
    },
    async close() {},
  };
  const connection: BotComputerConnection = {
    vmName: "aiden-bot-1",
    ip: "192.168.64.9",
    vnc: { host: "127.0.0.1", port: 5905, password: "vnc-password-abcd" },
    ssh: { host: "192.168.64.9", user: "lume" },
  };
  const reasons: string[] = [];
  const host = {
    async ensureRunning(_botId: string, options: { reason: string }) {
      reasons.push(options.reason);
      return connection;
    },
    touch() {},
    async runGuestCommand() {
      return { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false };
    },
  };
  const candidates = (routine: boolean): BotToolCandidate[] => [
    {
      tool: createBotComputerTool(
        BOT,
        {
          host,
          sessions: { screen: async () => screen, recordPointer: () => undefined, setActivity: () => undefined },
          control,
          state,
          botName: async () => "Ada",
          sleep: async () => undefined,
        },
        { routine },
      ),
      replay: "unsafe",
    },
    { tool: createBotComputerShellTool(BOT, { host, control, botName: async () => "Ada" }, { routine }), replay: "unsafe" },
  ];
  // As the Bot computer services hand them to `botComputerCandidates` (no guest driver lane).
  const services = {
    host: { ...host, computer: async () => undefined, guestDriver: async () => undefined },
    sessions: { screen: async () => screen, recordPointer: () => undefined, setActivity: () => undefined },
    control,
  };
  return { events, reasons, captures: () => captures, candidates, control, services, state };
}

function computerDeps(
  computer: ReturnType<typeof fakeComputer>,
  options: Partial<AssemblyDepsOptions> & { hasComputer?: boolean; other?: BotOrdinaryCapabilityKind[]; routine?: boolean } = {},
) {
  const { hasComputer = true, other = [...FULL_GRANTS.other, "computer"], routine = false, ...rest } = options;
  const state = assemblyState(testAuthority({ mode: "full", home: tempHome(), ...FULL_GRANTS, other }));
  state.hasComputer = hasComputer;
  return assemblyDeps(state, {
    candidates: () => computer.candidates(routine),
    // As production's sources: the computer's live action, the shell defers to policy.
    approvalFor: async (toolName, call) => (toolName === "computer" ? botComputerAction(call) : undefined),
    botName: "Ada",
    rules: () => defaultBotRules(),
    ...rest,
  });
}

async function botTurn(deps: BotExtensionDeps, fauxModels: FauxModels) {
  const registry = createBotRegistry(BOT, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ type?: string; text?: string }> };

async function toolResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
}

const textOf = (result: ToolResultModel | undefined) => (result?.content ?? []).map((part) => part.text ?? "").join("");

const capture = (id: string) => fauxAssistantMessage([fauxToolCall("computer", { action: "capture" }, { id })], { stopReason: "toolUse" });
const placeOrder = fauxAssistantMessage(
  [fauxToolCall("computer", { action: "click", coordinate: [640, 400], intent: "Click Place order" }, { id: "order" })],
  { stopReason: "toolUse" },
);

test("a Bot is offered its computer only when it has one, and a routine run is offered it too", async () => {
  for (const [hasComputer, requestId, offered] of [
    [true, "desk-1", true],
    [false, "desk-1", false],
    [true, ROUTINE, true],
  ] as const) {
    const computer = fakeComputer();
    const seen: string[][] = [];
    const fauxModels = createFauxModels([
      (context: { messages: readonly Message[] }) => {
        seen.push(getCurrentTools(context.messages as Message[]).map((tool) => tool.name));
        return fauxAssistantMessage("done");
      },
    ]);
    const deps = computerDeps(computer, { hasComputer, routine: requestId === ROUTINE });
    const { harness, root } = await botTurn(deps, fauxModels);
    try {
      await (await root.submit({ type: "input", content: "check the screen", requestId }, ctx)).wait(ctx);
      assert.equal(seen[0]!.includes("computer"), offered, `${requestId} with a computer: ${hasComputer}`);
      assert.equal(seen[0]!.includes("computer_shell"), offered);
    } finally {
      await harness.close(ctx);
    }
  }
});

test("Click Place order asks the person on an attended turn, and a routine blocks instead of waiting (G8)", async () => {
  const purchase = defaultBotRules().find((rule) => rule.actionClass === "purchase")!;
  const label = botRuleLabel(purchase);

  // Attended: the rule-made card names the stated intent; the click runs once allowed.
  const attended = fakeComputer();
  const attendedDeps = computerDeps(attended);
  const allowed = await botTurn(attendedDeps, createFauxModels([capture("look"), placeOrder, fauxAssistantMessage("ordered")]));
  try {
    await (await allowed.root.submit({ type: "input", content: "order it", requestId: "desk-1" }, ctx)).wait(ctx);
    assert.deepEqual(attendedDeps.approvals.map((request) => request.summary), [`Rule · ${label} — Click Place order`]);
    assert.ok(attended.events.includes("pointer 1280,800 1"), "the click ran at the scaled point");
    assert.deepEqual(attended.reasons, ["tool", "tool"]);
  } finally {
    await allowed.harness.close(ctx);
  }

  // Denied: nothing is clicked.
  const denied = fakeComputer();
  const deniedDeps = computerDeps(denied, { approve: async () => "deny" });
  const refused = await botTurn(deniedDeps, createFauxModels([capture("look"), placeOrder, fauxAssistantMessage("not ordered")]));
  try {
    await (await refused.root.submit({ type: "input", content: "order it", requestId: "desk-1" }, ctx)).wait(ctx);
    assert.equal(deniedDeps.approvals.length, 1);
    assert.equal(denied.events.length, 0);
  } finally {
    await refused.harness.close(ctx);
  }

  // A routine: no card, no click; the result says what the person needs to do.
  const routine = fakeComputer();
  const routineDeps = computerDeps(routine, { routine: true });
  const unattended = await botTurn(routineDeps, createFauxModels([capture("look"), placeOrder, fauxAssistantMessage("told them")]));
  try {
    await (await unattended.root.submit({ type: "input", content: "order it", requestId: ROUTINE }, ctx)).wait(ctx);
    assert.deepEqual(routineDeps.approvals, []);
    assert.equal(routine.events.length, 0);
    assert.equal(routine.captures(), 1, "the routine still looked at its computer");
    assert.deepEqual(routine.reasons, ["routine"], "the computer started for the routine");
    const results = await toolResults(unattended.root);
    const order = results.filter((result) => result.toolName === "computer")[1];
    assert.equal(order?.isError, true);
    assert.ok(textOf(order).includes(ruleAskUnattendedBlock(label)), textOf(order));
  } finally {
    await unattended.harness.close(ctx);
  }
});

test("on a routine or Telegram run, a computer the person keeps is given up after one bounded wait, though the tools are built for an attended turn", async () => {
  const shell = fauxAssistantMessage(
    [fauxToolCall("computer_shell", { command: "ls ~/Shared", description: "List the shared folder" }, { id: "ls" })],
    { stopReason: "toolUse" },
  );
  for (const requestId of [ROUTINE, TELEGRAM, "desk-1"]) {
    const computer = fakeComputer();
    // As production builds them: the registry holds the attended tool set (`refresh()` has no turn),
    // so the run the call serves decides.
    const candidates = await botComputerCandidates(BOT, {
      granted: true,
      hasComputer: true,
      supportsImages: true,
      routine: false,
      telegram: false,
      computers: () => computer.services,
      state: () => computer.state,
      botName: async () => "Ada",
      unattendedWaitMs: 50,
    });
    computer.control.takeOver(BOT, "viewer");
    const turn = await botTurn(
      computerDeps(computer, { candidates: () => candidates }),
      createFauxModels([capture("look"), shell, fauxAssistantMessage("told them")]),
    );
    try {
      const running = (await turn.root.submit({ type: "input", content: "check the computer", requestId }, ctx)).wait(ctx);
      let ended = false;
      void running.then(() => (ended = true));
      if (requestId === "desk-1") {
        // Someone is there to give it back: the call waits for them.
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(ended, false, "an attended run keeps waiting for Give back");
        computer.control.giveBack(BOT);
        await running;
        const [look] = await toolResults(turn.root);
        assert.equal(textOf(look), BOT_COMPUTER_GIVE_BACK_NOTE);
        continue;
      }
      await waitFor(() => ended, { timeoutMs: 5_000, what: `the ${requestId} run to stop waiting` }).finally(() => computer.control.giveBack(BOT));
      const results = await toolResults(turn.root);
      assert.deepEqual(
        results.map((result) => [result.toolName, result.isError]),
        [
          ["computer", true],
          ["computer_shell", true],
        ],
      );
      for (const result of results) assert.match(textOf(result), /still using Ada's computer.*say in your reply/u, requestId);
      assert.equal(computer.captures(), 0, "nothing is captured while the person has it");
      assert.deepEqual(computer.reasons, [], "and nothing starts or runs");
    } finally {
      await turn.harness.close(ctx);
    }
  }
});

test("typing a password in its computer hands the step to the person, and the card never shows the text", async () => {
  const computer = fakeComputer();
  const handoffs = createBotHandoffs();
  const deps = computerDeps(computer, { requestHandoff: (request) => handoffs.request(ruleHandoffRequest(request)) });
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [fauxToolCall("computer", { action: "type", text: "hunter2", intent: "Type the account password" }, { id: "type" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("handed off"),
  ]);
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    const run = await root.submit({ type: "input", content: "sign in", requestId: "desk-1" }, ctx);
    await waitFor(() => handoffs.pending(BOT).length === 1, { what: "the hand-off card" });
    const card = handoffs.pending(BOT)[0]!;
    assert.equal(card.rule?.id, "locked.credentials");
    assert.equal(JSON.stringify(card).includes("hunter2"), false);
    assert.equal(card.open, undefined, "the VNC lane has no page to open");
    handoffs.answer(BOT, card.waitId, { outcome: "done" });
    await run.wait(ctx);
    assert.equal(computer.events.length, 0, "the Bot never typed it");
  } finally {
    await harness.close(ctx);
  }
});

test("an everyday step in its own computer runs without a card", async () => {
  const computer = fakeComputer();
  const deps = computerDeps(computer);
  const fauxModels = createFauxModels([
    capture("look"),
    fauxAssistantMessage(
      [fauxToolCall("computer", { action: "double_click", coordinate: [100, 50], intent: "Open the Downloads folder" }, { id: "open" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("computer_shell", { command: "ls ~/Shared", description: "List the shared folder" }, { id: "ls" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("opened"),
  ]);
  const { harness, root } = await botTurn(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "open downloads", requestId: "desk-1" }, ctx)).wait(ctx);
    assert.deepEqual(deps.approvals, []);
    assert.equal(computer.events.filter((event) => event === "pointer 200,100 1").length, 2, "a double click");
    const results = await toolResults(root);
    assert.equal(textOf(results.find((result) => result.toolName === "computer_shell")), "ok");
  } finally {
    await harness.close(ctx);
  }
});

test("a Bot's request carries only its newest three captures, and its transcript keeps every one", async () => {
  const computer = fakeComputer();
  const seen: Array<{ images: number; notes: number }> = [];
  const step = (reply: () => ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly Message[] }) => {
    let images = 0;
    let notes = 0;
    for (const message of context.messages) {
      if (message.role !== "toolResult" || message.toolName !== "computer") continue;
      for (const part of message.content) {
        if (part.type === "image") images += 1;
        else if (part.text === BOT_OLDER_COMPUTER_CAPTURE_NOTE) notes += 1;
      }
    }
    seen.push({ images, notes });
    return reply();
  };
  const fauxModels = createFauxModels([
    ...["one", "two", "three", "four", "five"].map((id) => step(() => capture(id))),
    step(() => fauxAssistantMessage("looked")),
  ]);
  const { harness, root } = await botTurn(computerDeps(computer), fauxModels);
  try {
    await (await root.submit({ type: "input", content: "watch the screen", requestId: "desk-1" }, ctx)).wait(ctx);
    assert.deepEqual(seen.map(({ images }) => images), [0, 1, 2, 3, 3, 3]);
    assert.deepEqual(seen[seen.length - 1], { images: 3, notes: 2 }, "the two oldest captures became notes");
    const kept = (await toolResults(root)).filter((result) => result.toolName === "computer");
    assert.equal(kept.length, 5);
    for (const result of kept) assert.ok(result.content.some((part) => part.type === "image"), "the transcript keeps every capture");
  } finally {
    await harness.close(ctx);
  }
});

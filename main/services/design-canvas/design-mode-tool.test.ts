import assert from "node:assert/strict";
import test from "node:test";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { designModeToolAllowed } from "./canvas-tools.js";
import { createDesignModeTool, DesignModeConsent } from "./design-mode-tool.js";

type Sent = { channel: string; payload: Record<string, unknown> };

function windowOwner(id = 7, documentId = "doc-a") {
  const sent: Sent[] = [];
  const invalidated = new Set<() => void>();
  let destroyed = false;
  const owner: ChatGenerationOwner = {
    id,
    documentId,
    isDestroyed: () => destroyed,
    send: (channel, payload) => sent.push({ channel, payload: payload as Record<string, unknown> }),
    onInvalidated: (listener) => {
      invalidated.add(listener);
      return () => invalidated.delete(listener);
    },
  };
  return {
    owner,
    sent,
    close: () => {
      destroyed = true;
      for (const listener of invalidated) listener();
    },
  };
}

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
const requestIdOf = (sent: Sent[]) => sent.find((entry) => entry.channel === "designCanvas:consent")!.payload.requestId as string;

test("Enter on the card turns design mode on before Aiden hears entered, and closes the card", async () => {
  const consent = new DesignModeConsent();
  const window = windowOwner();
  const pending = consent.request({ chatId: "chat-1", reason: "Side by side is easier.", owner: window.owner });
  assert.deepEqual(window.sent[0]?.payload, { requestId: requestIdOf(window.sent), chatId: "chat-1", reason: "Side by side is easier." });

  const order: string[] = [];
  const accepted = await consent.answer(requestIdOf(window.sent), "enter", window.owner, async (chatId) => {
    order.push(`entered ${chatId}`);
  });
  pending.then(() => order.push("tool heard"));
  assert.equal(accepted, true);
  assert.equal(await pending, "entered");
  assert.deepEqual(order, ["entered chat-1", "tool heard"]);
  assert.deepEqual(last(window.sent), { channel: "designCanvas:consentClosed", payload: { requestId: requestIdOf(window.sent) } });
});

test("Not now declines without touching design mode; another window cannot answer", async () => {
  const consent = new DesignModeConsent();
  const window = windowOwner();
  const pending = consent.request({ chatId: "chat-1", reason: "Compare three directions.", owner: window.owner });
  const id = requestIdOf(window.sent);
  let entered = false;
  const enter = async () => {
    entered = true;
  };
  assert.equal(await consent.answer(id, "enter", windowOwner(8).owner, enter), false, "a different window");
  assert.equal(await consent.answer(id, "enter", windowOwner(7, "doc-b").owner, enter), false, "the same window after a reload");
  assert.equal(await consent.answer(id, "maybe", window.owner, enter), false);
  assert.equal(await consent.answer(id, "decline", window.owner, enter), true);
  assert.equal(await pending, "declined");
  assert.equal(entered, false);
  assert.equal(await consent.answer(id, "enter", window.owner, enter), false, "a closed card takes no second answer");
});

test("a card stops waiting when the reply stops, the window closes, or a newer card replaces it", async () => {
  const consent = new DesignModeConsent();
  const stopped = new AbortController();
  const a = windowOwner();
  const first = consent.request({ chatId: "chat-1", reason: "One.", owner: a.owner, signal: stopped.signal });
  stopped.abort();
  assert.equal(await first, "unavailable");
  assert.equal(last(a.sent)?.channel, "designCanvas:consentClosed");

  const b = windowOwner();
  const second = consent.request({ chatId: "chat-1", reason: "Two.", owner: b.owner });
  b.close();
  assert.equal(await second, "unavailable");

  const c = windowOwner();
  const older = consent.request({ chatId: "chat-1", reason: "Old.", owner: c.owner });
  const newer = consent.request({ chatId: "chat-1", reason: "New.", owner: c.owner });
  assert.equal(await older, "unavailable");
  const newerId = c.sent.filter((entry) => entry.channel === "designCanvas:consent").slice(-1)[0]!.payload.requestId;
  assert.equal(await consent.answer(newerId, "decline", c.owner, async () => undefined), true);
  assert.equal(await newer, "declined");
});

test("a card nobody answers times out, and a failed enter tells Aiden it is unavailable", async () => {
  const consent = new DesignModeConsent(10);
  const window = windowOwner();
  assert.equal(await consent.request({ chatId: "chat-1", reason: "Wait.", owner: window.owner }), "unavailable");

  const again = consent.request({ chatId: "chat-1", reason: "Try.", owner: window.owner });
  const id = window.sent.filter((entry) => entry.channel === "designCanvas:consent").slice(-1)[0]!.payload.requestId;
  await assert.rejects(
    consent.answer(id, "enter", window.owner, async () => {
      throw new Error("Design mode needs a project chat.");
    }),
    /project chat/u,
  );
  assert.equal(await again, "unavailable");
});

test("no card is shown to a phone, a paired Mac or a background reply", async () => {
  const consent = new DesignModeConsent();
  const remote = { ...windowOwner().owner, kind: "remote" as const };
  const headless = { ...windowOwner().owner, id: 0 };
  assert.equal(await consent.request({ chatId: "c", reason: "r", owner: remote }), "unavailable");
  assert.equal(await consent.request({ chatId: "c", reason: "r", owner: headless }), "unavailable");
  assert.equal(await consent.request({ chatId: "c", reason: "r" }), "unavailable");
});

async function run(tool: ReturnType<typeof createDesignModeTool>, args: Record<string, unknown>) {
  const output = await tool.execute("call-1", args as never);
  const first = output.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

test("design_mode asks only when design mode is off, and leaves without asking", async () => {
  let on = false;
  const asked: string[] = [];
  const tool = createDesignModeTool({
    isOn: async () => on,
    requestEnter: async (reason) => {
      asked.push(reason);
      on = true;
      return "entered";
    },
    exit: async () => {
      on = false;
    },
  });
  assert.equal((await run(tool, { action: "exit", reason: "done" })).status, "already");
  assert.equal((await run(tool, { action: "enter", reason: "  " })).status, "error");
  const entered = await run(tool, { action: "enter", reason: "Compare the three directions side by side." });
  assert.equal(entered.status, "entered");
  assert.match(String(entered.next), /canvas_place_frame/u);
  assert.equal((await run(tool, { action: "enter", reason: "again" })).status, "already");
  assert.deepEqual(asked, ["Compare the three directions side by side."]);
  assert.equal((await run(tool, { action: "exit", reason: "done" })).status, "exited");
  assert.equal(on, false);
});

test("design_mode is offered only in a desktop project chat while inline visuals are automatic", () => {
  const turn = {
    flagEnabled: true,
    localRenderer: true,
    assistant: false,
    telegram: false,
    hasWorkspaceFolder: true,
    regularChat: true,
    inlineVisuals: undefined as string | undefined,
  };
  assert.equal(designModeToolAllowed(turn), true, "automatic is the default");
  assert.equal(designModeToolAllowed({ ...turn, inlineVisuals: "automatic" }), true);
  assert.equal(designModeToolAllowed({ ...turn, inlineVisuals: "on_request" }), false);
  assert.equal(designModeToolAllowed({ ...turn, inlineVisuals: "off" }), false);
  assert.equal(designModeToolAllowed({ ...turn, regularChat: false }), false, "a feature's own chat");
  assert.equal(designModeToolAllowed({ ...turn, localRenderer: false }), false, "a phone or paired Mac");
  assert.equal(designModeToolAllowed({ ...turn, botId: "bot-1" }), false);
  assert.equal(designModeToolAllowed({ ...turn, flagEnabled: false }), false);
});

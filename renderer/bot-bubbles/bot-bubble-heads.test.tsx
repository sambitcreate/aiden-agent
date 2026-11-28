import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { botFixture } from "../main/bots/test-fixtures";
import { invalidateBotCanonicalPhotos } from "../lib/bot-canonical-photo-cache";
import { BOT_SIDEBAR_PREFERENCES_KEY } from "../lib/bot-sidebar-preferences";
import { EMPTY_BOT_BUBBLE_STATE, type BotBubble, type BotBubbleState } from "../shared/bot-bubbles";
import type { BotLiveSnapshot, BotLiveSummary } from "../shared/bot-live";
import { BotBubbleHeads } from "./bot-bubble-heads";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const AREA = { width: 1000, height: 800 };
const PENNY: BotBubble = { botId: "bot-1", placement: { side: "right", y: 0.5, displayId: null } };

function snapshot(overrides: Partial<BotLiveSnapshot> = {}): BotLiveSnapshot {
  return {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 0,
    entries: [],
    partial: null,
    state: { kind: "idle" },
    question: null,
    activity: null,
    queued: [],
    ...overrides,
  };
}

function summary(overrides: Partial<BotLiveSummary> = {}): BotLiveSummary {
  return {
    botId: "bot-1",
    preview: null,
    updatedAt: null,
    state: { kind: "idle" },
    needsYou: false,
    lastReplyAt: null,
    ...overrides,
  };
}

const stateWith = (overrides: Partial<BotBubbleState>): BotBubbleState => ({
  ...EMPTY_BOT_BUBBLE_STATE,
  host: "overlay",
  bubbles: [PENNY],
  ...overrides,
});

/** Penny saw replies up to t=100 on this Mac. */
function seenUpTo(at: number) {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    JSON.stringify({
      version: 1,
      since: 1,
      pinnedBotId: null,
      lastViewed: {},
      seenReplyAt: { "bot-1": at },
    }),
  );
}

function mount(
  handlers: Record<string, (...args: unknown[]) => unknown>,
  props: Partial<React.ComponentProps<typeof BotBubbleHeads>> = {},
) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture({ name: "Penny" }),
    "bots:live:summary": () => summary(),
    "bots:live:subscribe": () => snapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
    "bots:bubbles:state": () => stateWith({}),
    ...handlers,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <BotBubbleHeads bubbles={[PENNY]} openBotId={null} area={AREA} host="overlay" {...props} />
    </QueryClientProvider>,
  );
  return calls;
}

const head = (name: RegExp) => screen.findByRole("button", { name });

test("a closed head says how many replies are unread and that the Bot needs you", async () => {
  seenUpTo(100);
  mount({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          {
            id: "a1",
            type: "assistant",
            text: "Seen already.",
            toolCalls: [],
            stopReason: "stop",
            at: 90,
          },
          { id: "u1", type: "user", text: "Anything new?", imageCount: 0, at: 110 },
          {
            id: "a2",
            type: "assistant",
            text: "Two flights found.",
            toolCalls: [],
            stopReason: "stop",
            at: 120,
          },
          {
            id: "a3",
            type: "assistant",
            text: "Which one should I book?",
            toolCalls: [],
            stopReason: "stop",
            at: 130,
          },
        ],
      }),
    "bots:live:summary": () => summary({ needsYou: true, lastReplyAt: 130 }),
  });
  assert.ok(await head(/^Penny, 2 unread, needs you\. Enter opens, Delete closes\.$/u));
});

test("a working head's drawn face is a live avatar in the thinking pose", async () => {
  mount({
    "bots:live:summary": () => summary({ state: { kind: "running" } as BotLiveSummary["state"] }),
    "bots:live:subscribe": () =>
      snapshot({ state: { kind: "running" } as BotLiveSnapshot["state"] }),
  });
  const working = await head(/^Penny, working\./u);
  await waitFor(() => {
    const sprite = working.querySelector(".bot-sprite");
    assert.equal(sprite?.getAttribute("data-state"), "thinking");
    assert.ok(
      sprite?.closest(".bot-avatar[data-live]"),
      "the sprite motion only runs inside a live .bot-avatar",
    );
  });
});

test("an idle head's drawn face is a still idle sprite", async () => {
  mount({});
  const idle = await head(/^Penny\. Enter opens/u);
  await waitFor(() =>
    assert.equal(idle.querySelector(".bot-sprite")?.getAttribute("data-state"), "idle"),
  );
  assert.equal(idle.querySelector(".bot-avatar[data-live]"), null);
});

test("a head inside the Aiden window counts unread replies from the summary without subscribing to the chat", async () => {
  seenUpTo(100);
  const calls = mount(
    {
      "bots:live:summary": () => summary({ lastReplyAt: 130, recentReplyAt: [130, 120, 90] }),
      "bots:bubbles:state": () => stateWith({ host: "window" }),
    },
    { host: "window" },
  );
  assert.ok(await head(/^Penny, 2 unread\. Enter opens, Delete closes\.$/u));
  assert.equal(
    calls.filter((call) => call.channel === "bots:live:subscribe").length,
    0,
    "the Aiden window never marks the chat as on screen",
  );
});

test("a floating head counts a delegated turn as one reply, as the in-window head does", async () => {
  seenUpTo(5);
  const entries: BotLiveSnapshot["entries"] = [
    { id: "person", type: "user", text: "Please check the calendar", imageCount: 0, at: 10 },
    {
      id: "ack",
      type: "assistant",
      text: "I will ask the calendar Bot",
      toolCalls: [],
      stopReason: "toolUse",
      at: 20,
    },
    {
      id: "sent",
      type: "peer",
      exchangeId: "exchange",
      direction: "sent",
      peerBotId: "B",
      peerName: "Calendar",
      messageKind: "request",
      at: 25,
    },
    {
      id: "waiting",
      type: "assistant",
      text: "Waiting for Calendar",
      toolCalls: [],
      stopReason: "stop",
      at: 30,
    },
    {
      id: "received",
      type: "peer",
      exchangeId: "exchange",
      direction: "received",
      peerBotId: "B",
      peerName: "Calendar",
      messageKind: "result",
      at: 40,
    },
    {
      id: "answer",
      type: "assistant",
      text: "Your meeting starts at 3pm",
      toolCalls: [],
      stopReason: "stop",
      at: 50,
    },
    {
      id: "sealed",
      type: "peer",
      exchangeId: "exchange",
      direction: "received",
      peerBotId: "B",
      peerName: "Calendar",
      messageKind: "result",
      final: true,
      at: 60,
    },
  ];
  mount({
    "bots:live:subscribe": () => snapshot({ entries }),
    "bots:live:summary": () => summary({ lastReplyAt: 60, recentReplyAt: [60] }),
  });
  assert.ok(await head(/^Penny, 1 unread\. Enter opens, Delete closes\.$/u));
});

test("Delete on a focused head closes its bubble", async () => {
  const calls = mount({ "bots:bubbles:close": () => stateWith({ bubbles: [] }) });
  const button = await head(/^Penny/u);
  button.focus();
  fireEvent.keyDown(button, { key: "Delete" });
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:close")?.args, [
      { botId: "bot-1" },
    ]),
  );
});

test("dropping a dragged head on the × closes its bubble instead of moving it", async () => {
  const calls = mount({
    "bots:bubbles:close": () => stateWith({ bubbles: [] }),
    "bots:bubbles:move": () => stateWith({}),
  });
  const button = await head(/^Penny/u);
  // The head starts at (934, 374); the × waits centred at (500, 708).
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 900, clientY: 450 });
  assert.ok(
    document.querySelector("[data-bubble-close-target]"),
    "the × target rises while dragging",
  );
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 526, clientY: 734 });
  fireEvent.pointerUp(button, { pointerId: 1, clientX: 526, clientY: 734 });
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:close")?.args, [
      { botId: "bot-1" },
    ]),
  );
  assert.equal(
    calls.some((call) => call.channel === "bots:bubbles:move"),
    false,
  );
});

test("a head dropped on the left half snaps to the left side", async () => {
  const calls = mount({ "bots:bubbles:move": () => stateWith({}) });
  const button = await head(/^Penny/u);
  fireEvent.pointerDown(button, { button: 0, pointerId: 2, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 2, clientX: 600, clientY: 300 });
  fireEvent.pointerMove(button, { pointerId: 2, clientX: 200, clientY: 300 });
  fireEvent.pointerUp(button, { pointerId: 2, clientX: 200, clientY: 300 });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:bubbles:move")));
  const moved = calls.find((call) => call.channel === "bots:bubbles:move")!.args[0] as {
    botId: string;
    placement: { side: string; displayId: number | null };
  };
  assert.equal(moved.botId, "bot-1");
  assert.equal(moved.placement.side, "left");
  assert.equal(moved.placement.displayId, null);
});

test("an approval answered in the mini chat reaches the Bot by its wait id", async () => {
  const calls = mount(
    {
      "bots:pendingApprovals": () => [
        {
          botId: "bot-1",
          waitId: "wait-9",
          toolCallId: "call-9",
          toolName: "send_email",
          summary: "Email the itinerary to Sam.",
        },
      ],
      "bots:approve": () => ({ decided: true }),
    },
    { openBotId: "bot-1" },
  );
  const chat = await screen.findByRole("region", { name: "Penny chat" });
  const card = await within(chat).findByRole("region", {
    name: "Request from Penny: Review before Send email",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:approve")?.args, [
      { waitId: "wait-9", decision: "allow" },
    ]),
  );
});

test("sending from the mini chat sends the words to the Bot under a fresh request id", async () => {
  const calls = mount(
    { "bots:send": () => ({ submissionId: "s-1", deduped: false }) },
    { openBotId: "bot-1" },
  );
  const box = await screen.findByRole("textbox", { name: "Message Penny" });
  await waitFor(() => assert.equal((box as HTMLTextAreaElement).disabled, false));
  fireEvent.change(box, { target: { value: "Book the 9am one" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:send")));
  const sent = calls.find((call) => call.channel === "bots:send")!.args[0] as {
    botId: string;
    text: string;
    requestId: string;
  };
  assert.equal(sent.botId, "bot-1");
  assert.equal(sent.text, "Book the 9am one");
  assert.match(sent.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal((box as HTMLTextAreaElement).value, "", "the composer empties once sent");
});

test("opening the mini chat marks the Bot's replies seen, and Shrink tucks it away", async () => {
  seenUpTo(100);
  const calls = mount(
    {
      "bots:live:subscribe": () =>
        snapshot({
          entries: [
            {
              id: "a2",
              type: "assistant",
              text: "Done.",
              toolCalls: [],
              stopReason: "stop",
              at: 150,
            },
          ],
        }),
      "bots:bubbles:open": () => stateWith({ openBotId: null }),
    },
    { openBotId: "bot-1" },
  );
  const chat = await screen.findByRole("region", { name: "Penny chat" });
  await within(chat).findByText("Done.");
  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY) ?? "{}") as {
      seenReplyAt?: Record<string, number>;
    };
    assert.equal(stored.seenReplyAt?.["bot-1"], 150);
  });
  assert.ok(await head(/^Penny\. Enter opens/u), "the open Bot's head shows nothing unread");
  act(() => {
    fireEvent.click(within(chat).getByRole("button", { name: "Shrink" }));
  });
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:open")?.args, [
      { botId: null },
    ]),
  );
});

function renderLayer(props: Partial<React.ComponentProps<typeof BotBubbleHeads>>) {
  const client = createBotTestQueryClient();
  const element = (next: Partial<React.ComponentProps<typeof BotBubbleHeads>>) => (
    <QueryClientProvider client={client}>
      <BotBubbleHeads
        bubbles={[PENNY]}
        openBotId={null}
        area={AREA}
        host="overlay"
        {...props}
        {...next}
      />
    </QueryClientProvider>
  );
  const view = render(element({}));
  return {
    ...view,
    update: (next: Partial<React.ComponentProps<typeof BotBubbleHeads>>) =>
      view.rerender(element(next)),
  };
}

test("the layer tells its host it is not interactive when it mounts, and not interactive or dragging when it goes", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture({ name: "Penny" }),
    "bots:live:summary": () => summary(),
    "bots:live:subscribe": () => snapshot(),
    "bots:live:unsubscribe": () => undefined,
  });
  const interactive: boolean[] = [];
  const dragging: boolean[] = [];
  const view = renderLayer({
    onInteractiveChange: (value) => interactive.push(value),
    onDraggingChange: (value) => dragging.push(value),
  });
  await head(/^Penny/u);
  assert.deepEqual(interactive, [false]);
  view.unmount();
  assert.equal(interactive[interactive.length - 1], false);
  assert.equal(dragging[dragging.length - 1], false);
});

test("opening a mini chat puts the cursor in its message box, and closing it gives focus back to the head", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture({ name: "Penny" }),
    "bots:live:summary": () => summary(),
    "bots:live:subscribe": () => snapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
  });
  const view = renderLayer({ openBotId: "bot-1" });
  const box = await screen.findByRole("textbox", { name: "Message Penny" });
  await waitFor(() => assert.equal(document.activeElement, box));
  view.update({ openBotId: null });
  assert.equal(document.activeElement, screen.getByRole("button", { name: /^Penny/u }));
});

test("a click in a dialog opened from the chat (an image's full view) doesn't tuck the chat away", async () => {
  const calls = mount(
    { "bots:bubbles:open": () => stateWith({ openBotId: null }) },
    { openBotId: "bot-1" },
  );
  await screen.findByRole("region", { name: "Penny chat" });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.appendChild(dialog);
  fireEvent.pointerDown(dialog);
  dialog.remove();
  assert.equal(
    calls.some((call) => call.channel === "bots:bubbles:open"),
    false,
  );
  fireEvent.pointerDown(document.body);
  // The tuck names the chat it closes, so it can't close one another display opened meanwhile.
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:bubbles:open")?.args, [
      { botId: null, ifOpen: "bot-1" },
    ]),
  );
});

const LAYER_IPC = {
  "bots:get": () => botFixture({ name: "Penny" }),
  "bots:live:summary": () => summary(),
  "bots:live:subscribe": () => snapshot(),
  "bots:live:unsubscribe": () => undefined,
  "bots:pendingApprovals": () => [],
};

test("a head closed elsewhere mid-drag ends the drag: the × goes and the overlay passes clicks through again", async () => {
  installBotTestIpc(LAYER_IPC);
  const interactive: boolean[] = [];
  const dragging: boolean[] = [];
  const view = renderLayer({
    onInteractiveChange: (value) => interactive.push(value),
    onDraggingChange: (value) => dragging.push(value),
  });
  const button = await head(/^Penny/u);
  fireEvent.pointerDown(button, { button: 0, pointerId: 5, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 5, clientX: 900, clientY: 450 });
  assert.ok(document.querySelector("[data-bubble-close-target]"));
  assert.equal(dragging[dragging.length - 1], true);
  // Main drops the head (closed from the Aiden window) before any pointerup.
  view.update({ bubbles: [] });
  await waitFor(() => assert.equal(document.querySelector("[data-bubble-close-target]"), null));
  assert.equal(dragging[dragging.length - 1], false);
  assert.equal(interactive[interactive.length - 1], false);
  fireEvent.mouseMove(document.body);
  assert.equal(
    interactive[interactive.length - 1],
    false,
    "moving over empty overlay keeps it click-through",
  );
});

test("losing pointer capture mid-drag ends the drag without moving the head", async () => {
  const calls = mount({ "bots:bubbles:move": () => stateWith({}) });
  const button = await head(/^Penny/u);
  fireEvent.pointerDown(button, { button: 0, pointerId: 6, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 6, clientX: 700, clientY: 300 });
  assert.ok(document.querySelector("[data-bubble-close-target]"));
  fireEvent.lostPointerCapture(button, { pointerId: 6 });
  await waitFor(() => assert.equal(document.querySelector("[data-bubble-close-target]"), null));
  assert.equal(
    calls.some((call) => call.channel === "bots:bubbles:move"),
    false,
  );
});

test("dragging the head of an open chat keeps a half-written message", async () => {
  const calls = mount({ "bots:bubbles:move": () => stateWith({}) }, { openBotId: "bot-1" });
  const box = await screen.findByRole("textbox", { name: "Message Penny" });
  fireEvent.change(box, { target: { value: "Half a thought" } });
  const button = await head(/^Penny/u);
  fireEvent.pointerDown(button, { button: 0, pointerId: 7, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 7, clientX: 940, clientY: 300 });
  assert.equal(
    screen.queryByRole("region", { name: "Penny chat" }),
    null,
    "the chat steps aside while its head moves",
  );
  fireEvent.pointerMove(button, { pointerId: 7, clientX: 950, clientY: 250 });
  fireEvent.pointerUp(button, { pointerId: 7, clientX: 950, clientY: 250 });
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:bubbles:move")));
  const chat = await screen.findByRole("region", { name: "Penny chat" });
  assert.equal(
    (within(chat).getByRole("textbox", { name: "Message Penny" }) as HTMLTextAreaElement).value,
    "Half a thought",
  );
});

// Compared as booleans: a failed assertion that prints a DOM node stalls the run.
const chatElement = () => document.querySelector<HTMLElement>('[data-bubble-chat="bot-1"]');

test("a tucked chat stays where it was, out of reach, until its exit has played; the head is never redrawn", async () => {
  installBotTestIpc(LAYER_IPC);
  const view = renderLayer({ openBotId: "bot-1" });
  await screen.findByRole("textbox", { name: "Message Penny" });
  const chat = chatElement();
  const button = screen.getByRole("button", { name: /^Penny/u });
  assert.ok(chat);

  view.update({ openBotId: null });
  assert.ok(chatElement() === chat, "the same chat is still on the page while it leaves");
  assert.equal(
    screen.queryByRole("region", { name: "Penny chat" }),
    null,
    "it is no longer offered as a chat",
  );
  assert.equal(screen.queryByRole("textbox", { name: "Message Penny" }), null);
  assert.ok(
    screen.getByRole("button", { name: /^Penny/u }) === button,
    "the head is the same element",
  );

  // A message's own animation ending inside the chat is not the chat's exit.
  fireEvent.animationEnd(chat.querySelector("header")!);
  assert.ok(chatElement() === chat);
  fireEvent.animationEnd(chat);
  await waitFor(() => assert.ok(chatElement() === null));
});

test("a chat opened again while it leaves is the same chat, with its half-written message", async () => {
  installBotTestIpc(LAYER_IPC);
  const view = renderLayer({ openBotId: "bot-1" });
  const box = await screen.findByRole("textbox", { name: "Message Penny" });
  fireEvent.change(box, { target: { value: "Half a thought" } });
  view.update({ openBotId: null });
  view.update({ openBotId: "bot-1" });
  const again = await screen.findByRole("textbox", { name: "Message Penny" });
  assert.ok(again === box);
  assert.equal((again as HTMLTextAreaElement).value, "Half a thought");
  await waitFor(() =>
    assert.ok(document.activeElement === again, "the cursor is back in the message box"),
  );
  // The exit it had started must not take the open chat away later.
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(screen.getByRole("region", { name: "Penny chat" }));
});

test("a tucked chat leaves by itself where no exit animation runs", async () => {
  installBotTestIpc(LAYER_IPC);
  const view = renderLayer({ openBotId: "bot-1" });
  await screen.findByRole("textbox", { name: "Message Penny" });
  view.update({ openBotId: null });
  assert.ok(chatElement());
  await waitFor(() => assert.ok(chatElement() === null), { timeout: 2_000 });
});

test("a chat whose head closes goes with it at once, and doesn't come back with a later head", async () => {
  installBotTestIpc(LAYER_IPC);
  const view = renderLayer({ openBotId: "bot-1" });
  await screen.findByRole("textbox", { name: "Message Penny" });
  view.update({ openBotId: null, bubbles: [] });
  assert.ok(chatElement() === null);
  view.update({ openBotId: null, bubbles: [PENNY] });
  await head(/^Penny/u);
  assert.ok(chatElement() === null);
});

test("a head dropped on the × waits there until its bubble is gone, with clicks passing through again", async () => {
  installBotTestIpc({ ...LAYER_IPC, "bots:bubbles:close": () => stateWith({ bubbles: [] }) });
  const dragging: boolean[] = [];
  const view = renderLayer({ onDraggingChange: (value) => dragging.push(value) });
  const button = await head(/^Penny/u);
  const atSide = button.style.translate;
  fireEvent.pointerDown(button, { button: 0, pointerId: 8, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 8, clientX: 900, clientY: 450 });
  fireEvent.pointerMove(button, { pointerId: 8, clientX: 526, clientY: 734 });
  const onTarget = button.style.translate;
  assert.notEqual(onTarget, atSide);
  fireEvent.pointerUp(button, { pointerId: 8, clientX: 526, clientY: 734 });
  assert.equal(
    button.style.translate,
    onTarget,
    "it doesn't spring back to its side before it closes",
  );
  assert.ok(document.querySelector("[data-bubble-close-target]"));
  assert.equal(dragging[dragging.length - 1], false, "the drag itself is over");
  view.update({ bubbles: [] });
  await waitFor(() => assert.ok(document.querySelector("[data-bubble-close-target]") === null));
});

test("a head dropped on the × goes back to its side when the bubble couldn't be closed", async () => {
  mount({
    "bots:bubbles:close": () => {
      throw new Error("The list couldn't be saved.");
    },
  });
  const button = await head(/^Penny/u);
  const atSide = button.style.translate;
  fireEvent.pointerDown(button, { button: 0, pointerId: 9, clientX: 960, clientY: 400 });
  fireEvent.pointerMove(button, { pointerId: 9, clientX: 900, clientY: 450 });
  fireEvent.pointerMove(button, { pointerId: 9, clientX: 526, clientY: 734 });
  fireEvent.pointerUp(button, { pointerId: 9, clientX: 526, clientY: 734 });
  await waitFor(() => assert.ok(document.querySelector("[data-bubble-close-target]") === null));
  assert.equal(screen.getByRole("button", { name: /^Penny/u }).style.translate, atSide);
});

test("a head keeps its photo while the photo cache reloads for a new head", async () => {
  let reads = 0;
  let finishReload: (() => void) | undefined;
  const photo = { assetRevision: "r1", dataUrl: "data:image/png;base64,AAAA" };
  mount({
    "bots:getCanonicalPhoto": () => {
      reads += 1;
      if (reads === 1) return photo;
      return new Promise((resolve) => {
        finishReload = () => resolve(photo);
      });
    },
  });
  const button = await head(/^Penny/u);
  await waitFor(() => assert.ok(button.querySelector("img")));
  act(() => invalidateBotCanonicalPhotos());
  await waitFor(() => assert.equal(reads, 2));
  assert.ok(button.querySelector("img"), "the photo stays on the head while it is read again");
  await act(async () => finishReload?.());
  assert.ok(button.querySelector("img"));
});

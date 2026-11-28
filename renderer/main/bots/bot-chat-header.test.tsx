import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { botBubbleStore } from "../../lib/bot-bubbles-api";
import { EMPTY_BOT_BUBBLE_STATE, type BotBubbleState } from "../../shared/bot-bubbles";
import { BotChatActions, BotChatNamePill } from "./bot-chat-header";

afterEach(() => {
  cleanup();
  botBubbleStore.accept(EMPTY_BOT_BUBBLE_STATE);
});

/** Main's bubble state as this window last heard it. */
function bubbles(patch: Partial<BotBubbleState>) {
  act(() => botBubbleStore.accept({ ...EMPTY_BOT_BUBBLE_STATE, host: "window", ...patch }));
}
const HEAD = { botId: "b1", placement: { side: "right" as const, y: 0.3, displayId: null } };

const bot = { id: "b1", name: "SLMob", avatar: { ...DEFAULT_BOT_AVATAR } };

/** Renders inside an async act, so the avatar's photo read settles before the test goes on. */
async function renderHeader(pinned = false, paused = false) {
  const calls: string[] = [];
  await act(async () => {
    render(
      <>
        <BotChatNamePill bot={bot} onOpenProfile={() => calls.push("profile")} />
        <BotChatActions
          bot={bot}
          pinned={pinned}
          paused={paused}
          onAction={(action) => calls.push(action)}
        />
      </>,
    );
  });
  return calls;
}

const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More for SLMob" }), { key: "Enter" });
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
};

test("the name pill opens the Bot's settings", async () => {
  const calls = await renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob settings" }));
  assert.deepEqual(calls, ["profile"]);
});

test("the ••• menu offers only Pin to top, Pause Bot and Delete Bot, in that order", async () => {
  const calls = await renderHeader();
  assert.deepEqual(await openMenu(), ["Pin to top", "Pause Bot", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Pause Bot" }));
  assert.deepEqual(calls, ["pause"]);
});

test("a pinned Bot's menu offers Unpin instead", async () => {
  const calls = await renderHeader(true);
  const items = await openMenu();
  assert.equal(items.includes("Unpin"), true);
  assert.equal(items.includes("Pin to top"), false);
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  assert.deepEqual(calls, ["pin"]);
});

test("a paused Bot's menu offers Resume Bot instead of Pause Bot", async () => {
  const calls = await renderHeader(false, true);
  const items = await openMenu();
  assert.equal(items.includes("Pause Bot"), false);
  fireEvent.click(screen.getByRole("menuitem", { name: "Resume Bot" }));
  assert.deepEqual(calls, ["unpause"]);
});

test("the ••• menu opens from the keyboard, moves with arrows and runs the highlighted item on Enter", async () => {
  const calls = await renderHeader();
  const more = screen.getByRole("button", { name: "More for SLMob" });
  more.focus();
  fireEvent.keyDown(more, { key: "ArrowDown" });
  const items = await screen.findAllByRole("menuitem");
  await waitFor(() => assert.equal(document.activeElement === items[0], true), { timeout: 2000 });
  fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
  await waitFor(() => assert.equal(document.activeElement === items[1], true));
  fireEvent.keyDown(items[1]!, { key: "Enter" });
  assert.deepEqual(calls, ["pause"]);
});

test("Delete Bot is the last item, set apart from the others by a separator", async () => {
  await renderHeader();
  await openMenu();
  const separator = screen.getByRole("separator");
  const deleteItem = screen.getByRole("menuitem", { name: "Delete Bot" });
  const pin = screen.getByRole("menuitem", { name: "Pin to top" });
  assert.equal(
    Boolean(pin.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING),
    true,
  );
  assert.equal(
    Boolean(separator.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING),
    true,
  );
});

test("closing the menu by Pin to top or Escape gives focus back to •••", async () => {
  await renderHeader();
  const more = screen.getByRole("button", { name: "More for SLMob" });
  more.focus();
  fireEvent.keyDown(more, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  await waitFor(() => assert.equal(document.activeElement === more, true));

  fireEvent.keyDown(more, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("menu") === null, true));
  await waitFor(() => assert.equal(document.activeElement === more, true));
});

test("a menu whose action fails still gives focus back to •••", async () => {
  render(
    <BotChatActions
      bot={bot}
      pinned={false}
      onAction={() => {
        throw new Error("The Bot is not available.");
      }}
    />,
  );
  const more = screen.getByRole("button", { name: "More for SLMob" });
  more.focus();
  fireEvent.keyDown(more, { key: "Enter" });
  const pin = await screen.findByRole("menuitem", { name: "Pin to top" });
  const reported: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    reported.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    fireEvent.click(pin);
  } catch (error) {
    reported.push(error);
  } finally {
    window.removeEventListener("error", onError);
  }
  await waitFor(() => assert.equal(screen.queryByRole("menu") === null, true));
  await waitFor(() => assert.equal(document.activeElement === more, true));
});

test("with bubbles off there is no bubble button and the menu offers no bubble items", async () => {
  await renderHeader();
  // Heads hidden by the setting stay in the list; nothing here offers them.
  bubbles({ host: "off", bubbles: [HEAD] });
  assert.equal(screen.queryByRole("button", { name: "Bubble SLMob" }), null);
  assert.deepEqual(await openMenu(), ["Pin to top", "Pause Bot", "Delete Bot"]);
});

test("the bubble button shrinks this Bot's chat into a head and hides once it is bubbled", async () => {
  const calls = installBotTestIpc({
    "bots:bubbles:bubble": () => ({ ...EMPTY_BOT_BUBBLE_STATE, host: "window", bubbles: [HEAD] }),
  });
  await renderHeader();
  bubbles({});
  const button = screen.getByRole("button", { name: "Bubble SLMob" });
  await act(async () => fireEvent.click(button));
  assert.deepEqual(
    calls.filter((call) => call.channel === "bots:bubbles:bubble").map((call) => call.args),
    [[{ botId: "b1" }]],
  );
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Bubble SLMob" }), null));
});

test("the menu offers Bubble, and for a bubbled Bot Open bubble and Bring back to window", async () => {
  const calls = await renderHeader();
  bubbles({});
  assert.deepEqual(await openMenu(), ["Pin to top", "Pause Bot", "Bubble", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Bubble" }));
  assert.deepEqual(calls, ["bubble"]);

  bubbles({ bubbles: [HEAD] });
  assert.deepEqual(await openMenu(), [
    "Pin to top",
    "Pause Bot",
    "Open bubble",
    "Bring back to window",
    "Delete Bot",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Bring back to window" }));
  await waitFor(() => assert.equal(screen.queryByRole("menu"), null));
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Open bubble" }));
  assert.deepEqual(calls, ["bubble", "bringBack", "openBubble"]);
});

test("a Bot in the recent list is offered Bubble again", async () => {
  const calls = await renderHeader();
  bubbles({ recents: ["b1"] });
  assert.deepEqual(await openMenu(), ["Pin to top", "Pause Bot", "Bubble again", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Bubble again" }));
  assert.deepEqual(calls, ["bubble"]);
});

import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { BotChatActions, BotChatNamePill } from "./bot-chat-header";

afterEach(cleanup);

const bot = { id: "b1", name: "SLMob", avatar: { ...DEFAULT_BOT_AVATAR } };

/** Renders inside an async act, so the avatar's photo read settles before the test goes on. */
async function renderHeader(pinned = false) {
  const calls: string[] = [];
  await act(async () => {
    render(
    <>
      <BotChatNamePill bot={bot} onOpenProfile={() => calls.push("profile")} />
      <BotChatActions bot={bot} pinned={pinned} onAction={(action) => calls.push(action)} />
    </>,
    );
  });
  return calls;
}

const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More for SLMob" }), { key: "Enter" });
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
};

test("the name pill opens the Bot's profile", async () => {
  const calls = await renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob profile" }));
  assert.deepEqual(calls, ["profile"]);
});

test("the ••• menu offers Profile, Files, Memory, Routines, Advanced, Pin to top and Delete Bot, in that order", async () => {
  const calls = await renderHeader();
  assert.deepEqual(await openMenu(), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Routines" }));
  assert.deepEqual(calls, ["routines"]);
});

test("a pinned Bot's menu offers Unpin instead", async () => {
  const calls = await renderHeader(true);
  const items = await openMenu();
  assert.equal(items.includes("Unpin"), true);
  assert.equal(items.includes("Pin to top"), false);
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  assert.deepEqual(calls, ["pin"]);
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
  assert.deepEqual(calls, ["files"]);
});

test("Delete Bot is the last item, set apart from the others by a separator", async () => {
  await renderHeader();
  await openMenu();
  const separator = screen.getByRole("separator");
  const deleteItem = screen.getByRole("menuitem", { name: "Delete Bot" });
  const pin = screen.getByRole("menuitem", { name: "Pin to top" });
  assert.equal(Boolean(pin.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING), true);
  assert.equal(Boolean(separator.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING), true);
});

test("after Files hands focus to the panel, the next close by Pin to top or Escape gives focus back to •••", async () => {
  await renderHeader();
  const more = screen.getByRole("button", { name: "More for SLMob" });
  more.focus();
  fireEvent.keyDown(more, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  await waitFor(() => assert.equal(screen.queryByRole("menu") === null, true));
  // Files left focus to the panel (absent here), so the menu did not take it back.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.activeElement === more, false);

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

test("a menu whose action fails to open the panel still gives focus back to •••", async () => {
  render(
    <BotChatActions
      bot={bot}
      pinned={false}
      onAction={() => {
        throw new Error("The panel is not available.");
      }}
    />,
  );
  const more = screen.getByRole("button", { name: "More for SLMob" });
  more.focus();
  fireEvent.keyDown(more, { key: "Enter" });
  const files = await screen.findByRole("menuitem", { name: "Files" });
  const reported: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    reported.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    fireEvent.click(files);
  } catch (error) {
    reported.push(error);
  } finally {
    window.removeEventListener("error", onError);
  }
  await waitFor(() => assert.equal(screen.queryByRole("menu") === null, true));
  await waitFor(() => assert.equal(document.activeElement === more, true));
});

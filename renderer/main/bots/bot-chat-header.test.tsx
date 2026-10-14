import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { BotChatActions, BotChatBackButton, BotChatNamePill } from "./bot-chat-header";

afterEach(cleanup);

const bot = { id: "b1", name: "SLMob", avatar: { ...DEFAULT_BOT_AVATAR } };

function renderHeader(pinned = false) {
  const calls: string[] = [];
  render(
    <>
      <BotChatBackButton onBack={() => calls.push("back")} />
      <BotChatNamePill bot={bot} onOpenProfile={() => calls.push("profile")} />
      <BotChatActions bot={bot} pinned={pinned} onAction={(action) => calls.push(action)} />
    </>,
  );
  return calls;
}

const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More for SLMob" }), { key: "Enter" });
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
};

test("the name pill opens the Bot's profile and back returns to all Bots", () => {
  const calls = renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob profile" }));
  fireEvent.click(screen.getByRole("button", { name: "All Bots" }));
  assert.deepEqual(calls, ["profile", "back"]);
});

test("the ••• menu offers Profile, Files, Memory, Routines, Advanced, Pin to top and Delete Bot, in that order", async () => {
  const calls = renderHeader();
  assert.deepEqual(await openMenu(), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Routines" }));
  assert.deepEqual(calls, ["routines"]);
});

test("a pinned Bot's menu offers Unpin instead", async () => {
  const calls = renderHeader(true);
  const items = await openMenu();
  assert.equal(items.includes("Unpin"), true);
  assert.equal(items.includes("Pin to top"), false);
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  assert.deepEqual(calls, ["pin"]);
});

test("the ••• menu opens from the keyboard, moves with arrows and runs the highlighted item on Enter", async () => {
  const calls = renderHeader();
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
  renderHeader();
  await openMenu();
  const separator = screen.getByRole("separator");
  const deleteItem = screen.getByRole("menuitem", { name: "Delete Bot" });
  const advanced = screen.getByRole("menuitem", { name: "Pin to top" });
  assert.equal(Boolean(advanced.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING), true);
  assert.equal(Boolean(separator.compareDocumentPosition(deleteItem) & Node.DOCUMENT_POSITION_FOLLOWING), true);
});

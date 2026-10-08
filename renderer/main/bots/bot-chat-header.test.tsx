import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { BotChatActions, BotChatTitle } from "./bot-chat-header";

afterEach(cleanup);

const bot = { id: "b1", name: "SLMob", avatar: { ...DEFAULT_BOT_AVATAR } };

function renderHeader() {
  const calls: string[] = [];
  render(
    <>
      <BotChatTitle
        bot={bot}
        onBack={() => calls.push("back")}
        onOpenProfile={() => calls.push("profile")}
      />
      <BotChatActions
        bot={bot}
        onOpenProfile={() => calls.push("menu-profile")}
        onOpenFiles={() => calls.push("files")}
        onDelete={() => calls.push("delete")}
      />
    </>,
  );
  return calls;
}

test("the name pill opens the Bot's profile and back returns to all Bots", () => {
  const calls = renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob profile" }));
  fireEvent.click(screen.getByRole("button", { name: "All Bots" }));
  assert.deepEqual(calls, ["profile", "back"]);
});

test("the ••• menu offers exactly Profile, Files, and Delete", async () => {
  const calls = renderHeader();
  const more = screen.getByRole("button", { name: "More for SLMob" });
  fireEvent.keyDown(more, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Files", "Delete"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
  assert.deepEqual(calls, ["files"]);
});

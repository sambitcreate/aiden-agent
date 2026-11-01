import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botChatPath,
  botChatRouteBotId,
  botListRequestedSinceEnteringBots,
  botRouteBotId,
  environmentToggleTarget,
  isBotsPath,
  lastNonBotRoute,
  rememberRoute,
} from "./bot-routes";

test("Bots pages are /bots and everything under it, and nothing that only starts with the same letters", () => {
  for (const path of ["/bots", "/bots/", "/bots/b1", "/bots/b1/chat", "/host/h1/bots/b1/chat"]) assert.equal(isBotsPath(path), true, path);
  for (const path of ["/", "/botsy", "/chat/c1", "/host/h1/chat/c1", "/host/bots/chat/c1", "/settings"]) assert.equal(isBotsPath(path), false, path);
});

test("a Bot page names its Bot, and only the chat route counts as the Bot's chat", () => {
  assert.equal(botRouteBotId("/bots/9f0c/chat"), "9f0c");
  assert.equal(botRouteBotId("/bots/9f0c"), "9f0c");
  assert.equal(botRouteBotId("/bots"), null);
  assert.equal(botChatRouteBotId("/bots/9f0c/chat"), "9f0c");
  assert.equal(botChatRouteBotId("/bots/9f0c"), null);
  assert.equal(botChatRouteBotId("/bots/%E0%A4%A/chat"), null, "a malformed segment is no Bot");
  assert.deepEqual(botChatPath("9f0c"), { to: "/bots/$botId/chat", params: { botId: "9f0c" } });
});

test("the toggle shortcut acts on the Bot panel in a Bot chat, on nothing elsewhere in Bots, and on the workspace panel outside Bots", () => {
  assert.equal(environmentToggleTarget("/bots/9f0c/chat"), "bot-panel");
  assert.equal(environmentToggleTarget("/bots"), "none");
  assert.equal(environmentToggleTarget("/bots/9f0c"), "none");
  assert.equal(environmentToggleTarget("/chat/c1"), "workspace");
  assert.equal(environmentToggleTarget("/scheduled"), "workspace");
});

test("‹ goes back to the last page outside Bots, never to a Bots page", () => {
  assert.equal(lastNonBotRoute(), "/");
  rememberRoute("/chat/c1?draft=1");
  rememberRoute("/bots/9f0c/chat");
  rememberRoute("/bots");
  assert.equal(lastNonBotRoute(), "/chat/c1?draft=1");
  rememberRoute("/scheduled#top");
  assert.equal(lastNonBotRoute(), "/scheduled#top");
});

test("asking for /bots shows the Bot list until the person leaves Bots; opening a Bot directly does not", () => {
  rememberRoute("/chat/c1");
  // A Bot opened from the Inbox or a notification keeps the Inbox.
  rememberRoute("/bots/9f0c/chat");
  assert.equal(botListRequestedSinceEnteringBots(), false);

  // The Bots entry lands on /bots, which then opens the last Bot: the list stays.
  rememberRoute("/bots");
  rememberRoute("/bots/9f0c/chat");
  rememberRoute("/bots/a71e");
  assert.equal(botListRequestedSinceEnteringBots(), true);

  // Leaving Bots ends the ask, so the next Bot opened directly keeps the Inbox again.
  rememberRoute("/scheduled");
  rememberRoute("/bots/9f0c/chat");
  assert.equal(botListRequestedSinceEnteringBots(), false);
});

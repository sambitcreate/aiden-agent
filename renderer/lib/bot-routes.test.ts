import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  botChatPath,
  botChatRouteBotId,
  botListLocation,
  botRouteBotId,
  carryBotListRequest,
  environmentToggleTarget,
  isBotsPath,
  lastNonBotRoute,
  rememberRoute,
  sidebarShowsBotList,
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

test("with the Inbox as the view, only an entry that asked for the Bot list shows it; other views always do on Bots pages", () => {
  const asked = { aidenBotList: true };
  assert.equal(sidebarShowsBotList({ pathname: "/bots/9f0c/chat", state: {} }, true), false, "a Bot opened from the Inbox keeps the Inbox");
  assert.equal(sidebarShowsBotList({ pathname: "/bots", state: {} }, true), false, "a plain /bots, as after deleting a Bot, keeps the Inbox");
  assert.equal(sidebarShowsBotList({ pathname: "/bots/9f0c/chat", state: asked }, true), true);
  assert.equal(sidebarShowsBotList({ pathname: "/chat/c1", state: asked }, true), false, "outside Bots it's the workspace sidebar");
  assert.equal(sidebarShowsBotList({ pathname: "/bots/9f0c/chat", state: {} }, false), true);
  assert.equal(sidebarShowsBotList({ pathname: "/scheduled", state: {} }, false), false);
});

test("an ask for the Bot list follows the person through Bots, ends when they leave, and comes back with Back", () => {
  const history = carryBotListRequest(createMemoryHistory({ initialEntries: ["/chat/c1"] }));
  const showsList = () => sidebarShowsBotList(history.location, true);

  // A Bot opened directly (the Inbox, a notification) is no ask.
  history.push("/bots/9f0c/chat", {});
  assert.equal(showsList(), false);

  // The Bots entry asks; /bots then replaces itself with the last Bot, and other Bots open from the list.
  const { to, state } = botListLocation();
  history.push(to, state);
  assert.equal(showsList(), true);
  history.replace("/bots/9f0c/chat", {});
  assert.equal(showsList(), true, "the redirect to the last Bot keeps the ask");
  history.push("/bots/a71e/chat?draft=1", {});
  assert.equal(showsList(), true);

  // Leaving Bots ends it, so the next Bot opened directly keeps the Inbox.
  history.push("/scheduled", {});
  assert.equal(history.location.state.aidenBotList, undefined);
  history.push("/bots/9f0c/chat", {});
  assert.equal(showsList(), false);

  // Back returns to the entries that asked; Forward to the one that didn't.
  history.back();
  history.back();
  assert.equal(history.location.pathname, "/bots/a71e/chat");
  assert.equal(showsList(), true);
  history.back();
  history.back();
  assert.equal(history.location.pathname, "/bots/9f0c/chat");
  assert.equal(showsList(), false, "the Bot opened before the ask still keeps the Inbox");
  history.forward();
  assert.equal(showsList(), true);
});

test("an entry that says it isn't an ask for the list stays that way inside Bots", () => {
  const history = carryBotListRequest(createMemoryHistory({ initialEntries: ["/bots"] }));
  history.replace("/bots", { aidenBotList: true });
  history.push("/bots/9f0c/chat", { aidenBotList: false });
  assert.equal(sidebarShowsBotList(history.location, true), false);
});

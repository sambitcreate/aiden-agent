import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryHistory, createRootRoute, createRoute } from "@tanstack/react-router";
import { createAppRouter } from "./app-router";
import {
  botChatPath,
  botChatRouteBotId,
  botListLocation,
  botRouteBotId,
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

// The app's router wiring with a small route tree, and a history subscriber
// that loads each entry (RouterProvider's job in the app).
async function botsRouter(initialEntry: string) {
  const root = createRootRoute();
  const route = (path: string) => createRoute({ getParentRoute: () => root, path });
  const router = createAppRouter({
    routeTree: root.addChildren([route("/bots"), route("/bots/$botId/chat"), route("/chat/$chatId"), route("/scheduled")]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  router.history.subscribe(() => void router.load());
  await router.load();
  const go = (options: { to: string; params?: Record<string, string>; search?: Record<string, string>; state?: object; replace?: boolean }) =>
    router.navigate(options as never);
  const showsList = () => sidebarShowsBotList(router.state.location, true);
  return { router, history: router.history, go, showsList };
}

test("an ask for the Bot list follows the person through Bots, ends when they leave, and comes back with Back", async () => {
  const { history, go, showsList } = await botsRouter("/chat/c1");

  // A Bot opened directly (the Inbox, a notification) is no ask.
  await go(botChatPath("9f0c"));
  assert.equal(showsList(), false);

  // The Bots entry asks; /bots then replaces itself with the last Bot, and other Bots open from the list.
  await go(botListLocation());
  assert.equal(showsList(), true);
  await go({ ...botChatPath("9f0c"), replace: true });
  assert.equal(showsList(), true, "the redirect to the last Bot keeps the ask");
  await go({ ...botChatPath("a71e"), search: { draft: "1" } });
  assert.equal(showsList(), true);

  // Leaving Bots ends it, so the next Bot opened directly keeps the Inbox.
  await go({ to: "/scheduled" });
  assert.equal(history.location.state.aidenBotList, undefined);
  await go(botChatPath("9f0c"));
  assert.equal(showsList(), false);

  // Back returns to the entries that asked; Forward to the one that didn't.
  history.back();
  history.back();
  assert.equal(history.location.pathname, "/bots/a71e/chat");
  assert.equal(sidebarShowsBotList(history.location, true), true);
  history.back();
  history.back();
  assert.equal(history.location.pathname, "/bots/9f0c/chat");
  assert.equal(sidebarShowsBotList(history.location, true), false, "the Bot opened before the ask still keeps the Inbox");
  history.forward();
  assert.equal(sidebarShowsBotList(history.location, true), true);
});

test("opening the Bot that's already open adds no history entry, whether or not its entry asked for the list", async () => {
  const { history, go, showsList } = await botsRouter("/chat/c1");
  await go(botChatPath("9f0c"));
  const plainLength = history.length;
  await go(botChatPath("9f0c"));
  assert.equal(history.length, plainLength);

  await go(botListLocation());
  await go({ ...botChatPath("9f0c"), replace: true });
  const askedLength = history.length;
  await go(botChatPath("9f0c"));
  await go(botChatPath("9f0c"));
  assert.equal(history.length, askedLength, "a row click or ⌘N on the open Bot is a no-op");
  assert.equal(showsList(), true);

  // One Back still leaves the asked entry for the Bot opened before it.
  history.back();
  assert.equal(history.location.pathname, "/bots/9f0c/chat");
  assert.equal(sidebarShowsBotList(history.location, true), false);
});

test("an entry that says it isn't an ask for the list stays that way inside Bots", async () => {
  const { go, showsList } = await botsRouter("/chat/c1");
  await go(botListLocation());
  await go({ ...botChatPath("9f0c"), state: { aidenBotList: false } });
  assert.equal(showsList(), false);
});

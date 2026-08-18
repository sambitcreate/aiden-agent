import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("bots have dedicated roster, detail, and Pi chat routes", () => {
  const router = source("./router.tsx");
  const guard = source("./bot-chat-route.tsx");
  assert.match(router, /path: "\/bots"[\s\S]*component: BotsView/u);
  assert.match(router, /path: "\/bots\/\$botId"[\s\S]*component: BotsView/u);
  assert.match(router, /path: "\/bots\/\$botId\/chat\/\$chatId"[\s\S]*<BotChatRouteView botId=\{botId\} chatId=\{chatId\}/u);
  assert.match(guard, /<ChatPane chatId=\{chatId\}/u);
  assert.match(guard, /actualBotId === botId/u);
  assert.match(guard, /Opening the correct conversation/u);
});

test("bots UI reports query failures and offers an in-place retry", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /bots\.isError[\s\S]*Aiden could not load your bots/u);
  assert.match(view, /chats\.isError[\s\S]*Aiden could not load this bot’s conversations/u);
  assert.match(view, /bots\.refetch\(\)/u);
  assert.match(view, /chats\.refetch\(\)/u);
});

test("bot detail owns one-to-one Telegram bind and unbind controls", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /botsApi\.bindTelegram/u);
  assert.match(view, /botsApi\.unbindTelegram/u);
  assert.match(view, /Tokens, owner pairing, model, and workspace stay managed/u);
  assert.match(view, /A target can belong to only one bot/u);
});

test("bots UI edits definitions and creates conversations through dedicated IPC", () => {
  const view = source("./bots-view.tsx");
  assert.match(view, /botsApi\.create\(input\)/u);
  assert.match(view, /botsApi\.update\(\{ id: bot\.id, \.\.\.input \}\)/u);
  assert.match(view, /botsApi\.createChat\(\{ botId: selected\.id, workspaceId: activeId \}\)/u);
  assert.match(view, /botsApi\.archive\(selected\.id\)/u);
  assert.match(view, /botsApi\.restore\(selected\.id\)/u);
  assert.match(view, /maxLength=\{32_000\}/u);
});

test("bot avatars use Aiden face badges while preserving durable avatar ids", () => {
  const avatar = source("../components/bot-avatar.tsx");
  const contract = source("../shared/bots.ts");
  assert.match(contract, /\["spark", "orbit", "leaf", "prism", "wave", "ember"\]/u);
  assert.match(contract, /spark: "Wisp"[\s\S]*orbit: "Orb"[\s\S]*prism: "Hex"/u);
  assert.match(avatar, /spark:[\s\S]*orbit:[\s\S]*leaf:[\s\S]*prism:[\s\S]*wave:[\s\S]*ember:/u);
  assert.match(avatar, /<ellipse cx="15\.3"[\s\S]*<ellipse cx="24\.7"/u);
  assert.match(avatar, /fill="var\(--bot-avatar-face\)"/u);
  assert.match(avatar, /fill="var\(--bot-avatar-marker\)" stroke="var\(--bot-avatar-eye-highlight\)"/u);
  assert.match(avatar, /BotSidebarIcon[\s\S]*className="size-5"/u);
  assert.doesNotMatch(avatar, /body\.eyeY \+ 5/u);
  assert.doesNotMatch(avatar, /lucide-react/u);
});

test("bot chats show authoritative bot identity and fence archived conversations", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /const bot = useBot\(chat\.data\?\.botId\)/u);
  assert.match(pane, /Restore this bot before continuing the conversation/u);
  assert.match(pane, /<BotAvatar avatar=\{bot\.data\.avatar\}/u);
  assert.match(pane, /!botReadinessMessage/u);
  assert.match(pane, /chat\.data\?\.title \?\? "New conversation"/u);
});

test("Bots is a stable sidebar destination and bot rosters do not open the terminal", () => {
  const sidebar = source("../components/chat-sidebar.tsx");
  const layout = source("./chat-layout.tsx");
  assert.match(sidebar, /title="Bots"[\s\S]*selected=\{pathname\.startsWith\("\/bots"\)\}/u);
  assert.match(sidebar, /icon=\{<BotSidebarIcon \/>\}/u);
  assert.match(sidebar, /navigate\(\{ to: "\/bots" \}\)/u);
  assert.match(layout, /pathname\.startsWith\("\/bots"\) && !params\.chatId/u);
});

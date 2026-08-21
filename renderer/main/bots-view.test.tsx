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
  assert.match(
    router,
    /path: "\/bots\/\$botId\/chat\/\$chatId"[\s\S]*<BotChatRouteView botId=\{botId\} chatId=\{chatId\}/u,
  );
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

test("bot avatars migrate durable ids into layered mouthless face recipes", () => {
  const avatar = source("../components/bot-avatar.tsx");
  const contract = source("../shared/bots.ts");
  const styles = source("../styles.css");
  assert.match(contract, /\["spark", "orbit", "leaf", "prism", "wave", "ember"\]/u);
  assert.match(contract, /LEGACY_BOT_AVATAR_APPEARANCES/u);
  assert.match(contract, /shape: "squircle"|"squircle"/u);
  assert.match(contract, /isBotAvatarAppearance/u);
  assert.match(avatar, /const avatarBodies: Record<BotAvatarShape/u);
  assert.match(avatar, /function EyePair/u);
  assert.match(avatar, /resolveBotAvatar\(avatar\)/u);
  assert.match(avatar, /var\(--bot-avatar-face\)/u);
  assert.match(avatar, /BotSidebarIcon[\s\S]*className="size-5"/u);
  assert.doesNotMatch(avatar, /Mouth|mouth/u);
  assert.doesNotMatch(avatar, /lucide-react/u);
  assert.equal(styles.match(/--bot-avatar-face: #292735/gu)?.length, 2);
  for (const color of ["lilac", "sky", "mint", "sun", "periwinkle", "coral", "peach", "aqua"]) {
    assert.equal(styles.match(new RegExp(`--bot-avatar-${color}:`, "gu"))?.length, 2, color);
  }
});

test("bot editor provides live manual controls and configured Pi model design", () => {
  const view = source("./bots-view.tsx");
  const studio = source("../components/bot-face-studio.tsx");
  assert.match(view, /<BotFaceStudio/u);
  assert.match(view, /editorOpen \? <BotEditor/u);
  assert.match(studio, /Bot face/u);
  assert.match(studio, /BOT_AVATAR_SHAPES\.map/u);
  assert.match(studio, /BOT_AVATAR_COLORS\.map/u);
  assert.match(studio, /BOT_AVATAR_EYES\.map/u);
  assert.match(studio, /BOT_AVATAR_DETAILS\.map/u);
  assert.match(studio, /botsApi\.suggestAvatar/u);
  assert.match(studio, /botsApi\.cancelAvatarSuggestion/u);
  assert.match(studio, /globalThis\.crypto\.randomUUID\(\)/u);
  assert.match(studio, /createChatModelProviders/u);
  assert.match(studio, /useProvidersModelInfo/u);
  assert.match(studio, /resolveExplicitModelSelection/u);
  assert.match(studio, /useProviders\(\)/u);
  assert.match(studio, /Bot face provider/u);
  assert.match(studio, /Bot face model/u);
  assert.match(studio, /No Gemini key or avatar\s+image\s+upload/u);
  assert.doesNotMatch(studio, /gemini_api_key|Google Gemini API Key/u);
});

test("bot editor fences in-flight saves and exposes keyboard-operable face tabs", () => {
  const view = source("./bots-view.tsx");
  const studio = source("../components/bot-face-studio.tsx");
  assert.match(view, /if \(savingRef\.current\) return;/u);
  assert.match(view, /<BotFaceStudio[\s\S]*disabled=\{saving\}/u);
  assert.match(view, /value=\{draft\.name\}[\s\S]{0,100}disabled=\{saving\}/u);
  assert.match(view, /value=\{draft\.instructions\}[\s\S]{0,100}disabled=\{saving\}/u);
  assert.match(studio, /role="tablist"/u);
  assert.match(studio, /role="tab"/u);
  assert.match(studio, /role="tabpanel"/u);
  assert.match(studio, /event\.key === "ArrowRight"/u);
  assert.match(studio, /event\.key === "ArrowLeft"/u);
  assert.match(studio, /aria-selected=\{state\.tab === value\}/u);
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

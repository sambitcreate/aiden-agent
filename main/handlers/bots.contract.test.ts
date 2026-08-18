import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bot identity has a dedicated main-owned creation path", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const chats = readFileSync(new URL("./chat-create-params.ts", import.meta.url), "utf8");
  const generation = readFileSync(new URL("./chat-params.ts", import.meta.url), "utf8");
  assert.match(bots, /botStore\.get\(parsed\.botId\)/u);
  assert.match(bots, /chatStore\.create\(\{ \.\.\.parsed, assertCurrent \}\)/u);
  assert.doesNotMatch(chats, /botId|instructions|systemPrompt/u);
  assert.doesNotMatch(generation, /botId|instructions|systemPrompt/u);
  assert.doesNotMatch(generation, /interactionSurface/u);
});

test("generation resolves persisted bot identity and leaves ordinary prompts unchanged", () => {
  const client = readFileSync(new URL("../services/llm-client.ts", import.meta.url), "utf8");
  assert.match(client, /resolveBotForGeneration\([\s\S]{0,140}\(botId\) => botStore\.get\(botId\)/u);
  assert.match(
    client,
    /const botSystemPrompt = authoritativeBot[\s\S]{0,180}\? withBotPersona\(baseSystemPrompt, authoritativeBot\)[\s\S]{0,80}: baseSystemPrompt/u,
  );
  assert.match(
    client,
    /resolvePiAgentRuntimeContributionSnapshot\(\s*botSystemPrompt,/u,
  );
});

test("copy and fork serialize against bot archive and fail closed", () => {
  const chats = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  assert.match(chats, /const bot = await botStore\.get\(source\.botId\)/u);
  assert.match(chats, /Archived bot conversations cannot be copied or forked/u);
  assert.match(chats, /botMutationGate\.run\(source\.botId, runCopy\)/u);
});

test("Telegram binding is main-owned, owner-fenced, and creates a bot-tagged backing chat", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  assert.match(bots, /profile\.settings\.allowedUserId === undefined/u);
  assert.match(bots, /candidate\.chatId === profile\.settings\.allowedUserId/u);
  assert.match(bots, /telegramBotBindings\.bind/u);
  assert.match(bots, /id: binding\.backingChatId[\s\S]*botId,/u);
  assert.match(bots, /telegramBotBindings\.unbind/u);
  assert.match(bots, /if \(await telegramBotBindings\.get\(botId\)\)/u);
});

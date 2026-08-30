import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Bot IPC registration is narrowed by the main-owned host policy", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(hostPlatformCapabilities\(\)\.bots\) registerBotHandlers\(\);\s+registerBtwHandlers\(\)/u,
  );
});

test("ordinary chat paths cannot activate Bot services on unsupported hosts", () => {
  const chatHandlers = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  const llmClient = readFileSync(
    new URL("../services/llm-client.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    chatHandlers,
    /if \(source\.botId\) \{\s+if \(!hostPlatformCapabilities\(\)\.bots\)/u,
  );
  assert.match(
    chatHandlers,
    /if \(chat\?\.botId\) \{\s+if \(!hostPlatformCapabilities\(\)\.bots\) \{\s+return chatApplicationService\.remove\(chatId\)/u,
  );
  assert.match(
    llmClient,
    /if \(chat\.botId && !hostPlatformCapabilities\(\)\.bots\) \{\s+throw new Error\("Bot chats are not available on this platform\."\)/u,
  );
});

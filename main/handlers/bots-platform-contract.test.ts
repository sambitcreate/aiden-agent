import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startBotApplication } from "../services/bot-startup-core.js";

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
    /copyBotChat: async \(source\) => \{\s+if \(!hostPlatformCapabilities\(\)\.bots\)/u,
  );
  const rendererChatMutations = readFileSync(new URL("./chat-renderer-mutations.ts", import.meta.url), "utf8");
  assert.match(
    rendererChatMutations,
    /const result = chat\?\.botId && hostPlatformCapabilities\(\)\.bots\s+\? await botApplicationService\.deleteChat\(\{ botId: chat\.botId, chatId \}\)\s+: await chatApplicationService\.remove\(chatId\b/u,
  );
  assert.match(
    llmClient,
    /if \(chat\.botId && !hostPlatformCapabilities\(\)\.bots\) \{\s+throw new Error\("Bot chats are not available on this platform\."\)/u,
  );
});

test("Bot keyring initialization failure leaves ordinary application startup available", async () => {
  const logged: string[] = [];
  let focusTracked = false;
  const outcome = await startBotApplication({
    supported: true,
    initialize: async () => {
      throw new Error("keyring locked");
    },
    trackConnectionSetupFocus: () => {
      focusTracked = true;
    },
    logError: (message) => logged.push(message),
  });
  assert.equal(outcome, "failed");
  assert.deepEqual(logged, [
    "Bot storage could not be restored safely; the rest of Aiden will remain available for repair.",
  ]);
  assert.equal(focusTracked, true);

  const started = await startBotApplication({
    supported: true,
    initialize: async () => {},
    trackConnectionSetupFocus: () => {},
    logError: (message) => logged.push(message),
  });
  assert.equal(started, "started");
  assert.equal(logged.length, 1);

  // Launch goes through that never-throwing path, gated by the host policy.
  const launch = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(launch, /await startBotApplication\(\{\s+supported: hostPlatformCapabilities\(\)\.bots,/u);
});

test("hosts without Bots never initialize Bot storage at startup", async () => {
  let touched = false;
  const outcome = await startBotApplication({
    supported: false,
    initialize: async () => {
      touched = true;
    },
    trackConnectionSetupFocus: () => {
      touched = true;
    },
    logError: () => {
      touched = true;
    },
  });
  assert.equal(outcome, "unsupported");
  assert.equal(touched, false);
});

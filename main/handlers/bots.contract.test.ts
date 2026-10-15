// Remaining production-wiring guards for module singletons that cannot yet be
// constructed in a test (llm-client, telegram-service, Remote main, startup).
// Bot IPC ownership is covered behaviorally by bot-access.test.ts and
// bot-telegram.test.ts, and channel parity by ipc-contract.test.ts. Do not add
// new assertions here; replace these with behavioral tests when the owning
// modules gain injectable factories.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop canonical Bot photos cross IPC only through the renderer projection", () => {
  const handlers = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  assert.match(handlers, /projectBotAvatarForRenderer/u);
});

test("generation resolves persisted bot identity and leaves ordinary prompts unchanged", () => {
  const client = readFileSync(new URL("../services/llm-client.ts", import.meta.url), "utf8");
  assert.match(
    client,
    /resolveBotForGeneration\([\s\S]{0,140}\(botId\) =>\s*botStore\.get\(botId\)/u,
  );
  assert.match(client, /const botSystemPrompt = authoritativeBot/u);
  assert.match(client, /\? withBotRuntimeInstructions\(/u);
  assert.match(client, /: baseSystemPrompt;/u);
  assert.match(client, /botRuntimeAuthority\.admit\(\{/u);
  assert.match(client, /prepareBotGeneration\(\{/u);
  assert.match(client, /selectCanonicalBotChat\([\s\S]{0,100}chatStore\.listByBot/u);
  assert.match(client, /revalidateBeforeEffect\(\)/u);
  assert.match(client, /resolvePiAgentRuntimeContributionSnapshot\(\s*botSystemPrompt,/u);
});

test("copy, fork, and delete route Bot chats through the transaction-owned service", () => {
  const chats = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  assert.match(chats, /botApplicationService\.copyChat/u);
  assert.match(chats, /botApplicationService\.deleteChat/u);
  assert.doesNotMatch(chats, /botMutationGate\.run\(source\.botId, runCopy\)/u);
});

test("Telegram profile reset and deletion share the binding incarnation fence", () => {
  const service = readFileSync(
    new URL("../services/telegram/telegram-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    service,
    /deleteProfile[\s\S]*telegramProfileMutationFence\.runDestructive\(profile/u,
  );
  assert.match(
    service,
    /resetPairing[\s\S]*telegramProfileMutationFence\.runDestructive\(profile/u,
  );
  assert.match(
    service,
    /deleteProfile[\s\S]*telegramBotBindingAuthority\.disableProfile\(profile\)/u,
  );
  assert.match(
    service,
    /resetPairing[\s\S]*telegramBotBindingAuthority\.disableProfile\(profile\)/u,
  );
  assert.match(service, /deleteProfile[\s\S]*revokeTelegramBotNoticeForCurrentOwner\(profile\)/u);
  assert.match(service, /resetPairing[\s\S]*revokeTelegramBotNoticeForCurrentOwner\(profile\)/u);
  assert.match(
    service,
    /async start\(\): Promise<void> \{\s*await telegramBotBindings\.assertHealthy\(\)/u,
  );
});

test("Remote production wires Bot notice and retained-chat policy authority", () => {
  const remote = readFileSync(
    new URL("../services/aiden-remote-service-main.ts", import.meta.url),
    "utf8",
  );
  assert.match(remote, /retainedBotChatAuthorizer: authorizeRemoteRetainedBotChat/u);
  assert.match(remote, /botApplicationService\.authorizeRetainedChat\(\{/u);
  assert.match(remote, /botSessions,/u);
  assert.match(remote, /revokeNoticeAudience\(deviceId\)/u);
  assert.match(
    remote,
    /const revoked = await revokeAidenRemoteRuntimeDevice[\s\S]*if \(hostPlatformCapabilities\(\)\.bots\) \{\s*await botApplicationService\.revokeNoticeAudience\(deviceId\);\s*\}\s*return revoked;/u,
  );
});

test("Telegram authority reduction stays independent from Bot mutation health", () => {
  const botMain = readFileSync(
    new URL("../services/bot-application-service-main.ts", import.meta.url),
    "utf8",
  );
  const bindings = readFileSync(
    new URL("../services/telegram/telegram-bot-bindings.ts", import.meta.url),
    "utf8",
  );
  assert.match(bindings, /createBotAuthorities\(\{ account \}\)/u);
  assert.match(bindings, /authority:\s*\{\s*head: authorities!\.telegramAnchor,\s*bootstrap: authorities!\.telegramBootstrapMarker/u);
  assert.match(bindings, /createTelegramBotBindingAuthorityNarrower\(telegramBotBindings\)/u);
  assert.match(botMain, /disableBinding: \(botId\)[\s\S]*telegramBotBindingAuthority\.disableBot/u);
  assert.doesNotMatch(botMain, /disableBinding:[\s\S]{0,120}botApplicationService/u);
});

test("Bot startup migration precedes chat reconciliation projection and deletion preserves runtime cleanup", () => {
  const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const botMain = readFileSync(
    new URL("../services/bot-application-service-main.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    index.indexOf("await initializeBotApplicationService()") <
      index.indexOf("await reconcileChatScopedStores("),
  );
  assert.match(
    botMain,
    /chatApplicationService\.remove\(chatId, \{ assertCurrent, onDeletionRollForward \}\)/u,
  );
});

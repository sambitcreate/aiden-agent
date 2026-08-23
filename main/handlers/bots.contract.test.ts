import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bot identity and managed-home chats use the transaction-owned application service", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const chats = readFileSync(new URL("./chat-create-params.ts", import.meta.url), "utf8");
  const generation = readFileSync(new URL("./chat-params.ts", import.meta.url), "utf8");
  assert.match(bots, /botApplicationService\.createBot/u);
  assert.match(bots, /botApplicationService\.createChat/u);
  assert.match(bots, /audienceId: desktopAudienceId/u);
  assert.doesNotMatch(bots, /chatStore\.create\(\{ \.\.\.parsed, assertCurrent \}\)/u);
  assert.doesNotMatch(chats, /botId|instructions|systemPrompt/u);
  assert.doesNotMatch(generation, /botId|instructions|systemPrompt/u);
  assert.doesNotMatch(generation, /interactionSurface/u);
});

test("desktop and paired Telegram principals have explicit one-time notice IPC paths", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const ipc = readFileSync(
    new URL("../../renderer/lib/ipc.ts", import.meta.url),
    "utf8",
  );
  for (const channel of [
    "bots:getAccessNotice",
    "bots:acknowledgeAccessNotice",
    "bots:getTelegramAccessNotice",
    "bots:acknowledgeTelegramAccessNotice",
  ]) {
    assert.match(bots, new RegExp(channel, "u"));
    assert.match(ipc, new RegExp(channel, "u"));
  }
  assert.match(bots, /parseBotNoticeAcknowledgement/u);
  assert.match(bots, /telegramBotNoticeAudienceId\(\s*profileName,/u);
});

test("bot face generation is main-owned and uses only the bounded Pi recipe", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const params = readFileSync(new URL("./bot-params.ts", import.meta.url), "utf8");
  const generator = readFileSync(
    new URL("../services/bot-avatar-generator.ts", import.meta.url),
    "utf8",
  );
  assert.match(bots, /bots:suggestAvatar/u);
  assert.match(bots, /bots:cancelAvatarSuggestion/u);
  assert.match(bots, /botAvatarOperations\.admit\(\s*owner\.documentId,\s*parsed\.requestId/u);
  assert.match(bots, /botAvatarOperations\.cancel\(\s*owner\.documentId/u);
  assert.match(bots, /rendererDocumentOwner/u);
  assert.match(params, /AVATAR_SUGGESTION_KEYS/u);
  assert.match(generator, /resolveModelRuntime\(input\.providerId, input\.model/u);
  assert.match(generator, /modelsCatalog\.bundledInfo\(runtime\.provider, input\.model\)/u);
  assert.equal(generator.match(/waitForBotAvatarBoundary\(/gu)?.length, 2);
  assert.match(generator, /isNonChatModel/u);
  assert.match(generator, /controller\.signal\.throwIfAborted\(\)/u);
  assert.match(generator, /consumeBoundedBotAvatarResult/u);
  assert.equal(generator.match(/finishBotAvatarAccounting\(/gu)?.length, 2);
  assert.match(generator, /systemPrompt: BOT_AVATAR_SYSTEM_PROMPT/u);
  assert.match(generator, /cacheRetention: "none"/u);
  assert.doesNotMatch(generator, /gemini|api\.google/u);
  assert.doesNotMatch(generator, /result\.errorMessage/u);
});

test("desktop canonical Bot photos cross IPC as bounded content with semantic fallback", () => {
  const handlers = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const projection = readFileSync(
    new URL("../services/bot-avatar-renderer-projection.ts", import.meta.url),
    "utf8",
  );
  const ipc = readFileSync(new URL("../../renderer/lib/ipc.ts", import.meta.url), "utf8");
  assert.match(handlers, /bots:getCanonicalPhoto/u);
  assert.match(handlers, /projectBotAvatarForRenderer/u);
  assert.match(ipc, /bots:getCanonicalPhoto/u);
  assert.match(projection, /data:image\/png;base64/u);
  assert.match(projection, /catch \{\s*return null;/u);
  assert.doesNotMatch(projection, /filename|filePath|assetPath/u);
});

test("generation resolves persisted bot identity and leaves ordinary prompts unchanged", () => {
  const client = readFileSync(new URL("../services/llm-client.ts", import.meta.url), "utf8");
  assert.match(
    client,
    /resolveBotForGeneration\([\s\S]{0,140}\(botId\) => botStore\.get\(botId\)/u,
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

test("Telegram binding is main-owned, owner-fenced, and creates a bot-tagged backing chat", () => {
  const bots = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  assert.match(bots, /profile\.settings\.allowedUserId === undefined/u);
  assert.match(bots, /candidate\.chatId === profile\.settings\.allowedUserId/u);
  assert.match(bots, /telegramBotBindings\.bind/u);
  assert.match(bots, /botApplicationService\.withBotMutation\(\s*botId/u);
  assert.match(bots, /operations\.createChat\(\{[\s\S]*chatId: binding\.backingChatId/u);
  assert.match(bots, /botApplicationService\.getChatAccess\(\s*binding\.backingChatId/u);
  assert.doesNotMatch(bots, /chatStore\.create\(\{[\s\S]*chatId: binding\.backingChatId/u);
  assert.match(bots, /telegramBotBindingAuthority[\s\S]*\.disableBot\(botId\)/u);
  assert.match(bots, /telegramProfileMutationFence\.runBinding\(\s*profileName/u);
  assert.match(bots, /profileAdmission\.assertCurrent\(\)/u);
});

test("Telegram profile reset and deletion share the binding incarnation fence", () => {
  const service = readFileSync(
    new URL("../services/telegram/telegram-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /deleteProfile[\s\S]*telegramProfileMutationFence\.runDestructive\(profile/u);
  assert.match(service, /resetPairing[\s\S]*telegramProfileMutationFence\.runDestructive\(profile/u);
  assert.match(service, /deleteProfile[\s\S]*telegramBotBindingAuthority\.disableProfile\(profile\)/u);
  assert.match(service, /resetPairing[\s\S]*telegramBotBindingAuthority\.disableProfile\(profile\)/u);
  assert.match(service, /deleteProfile[\s\S]*revokeTelegramBotNoticeForCurrentOwner\(profile\)/u);
  assert.match(service, /resetPairing[\s\S]*revokeTelegramBotNoticeForCurrentOwner\(profile\)/u);
  assert.match(service, /async start\(\): Promise<void> \{\s*await telegramBotBindings\.assertHealthy\(\)/u);
});

test("Remote production wires Bot notice and retained-chat policy authority", () => {
  const remote = readFileSync(
    new URL("../services/aiden-remote-service-main.ts", import.meta.url),
    "utf8",
  );
  assert.match(remote, /retainedBotChatAuthorizer: authorizeRemoteRetainedBotChat/u);
  assert.match(remote, /botApplicationService\.authorizeRetainedChat\(\{/u);
  assert.match(remote, /botNotice:\s*\{/u);
  assert.match(remote, /botApplicationService\.acknowledgeNotice/u);
  assert.match(remote, /revokeNoticeAudience\(deviceId\)/u);
  assert.match(
    remote,
    /const revoked = await revokeAidenRemoteRuntimeDevice[\s\S]*await botApplicationService\.revokeNoticeAudience\(deviceId\);\s*return revoked;/u,
  );
});

test("Telegram authority reduction stays independent from Bot mutation health", () => {
  const handlers = readFileSync(new URL("./bots.ts", import.meta.url), "utf8");
  const botMain = readFileSync(
    new URL("../services/bot-application-service-main.ts", import.meta.url),
    "utf8",
  );
  const bindings = readFileSync(
    new URL("../services/telegram/telegram-bot-bindings.ts", import.meta.url),
    "utf8",
  );
  assert.match(bindings, /authority:\s*\{[\s\S]*createTelegramBotBindingKeychainAnchor/u);
  assert.match(bindings, /createTelegramBotBindingAuthorityNarrower\(telegramBotBindings\)/u);
  assert.match(handlers, /bots:unbindTelegram[\s\S]*telegramBotBindingAuthority\.disableBot/u);
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
      index.indexOf("const visibleChatIds = new Set"),
  );
  assert.match(
    botMain,
    /chatApplicationService\.remove\(chatId, \{ assertCurrent, onDeletionRollForward \}\)/u,
  );
});

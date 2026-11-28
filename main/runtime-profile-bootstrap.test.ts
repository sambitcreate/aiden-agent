import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createChatTitleService } from "./services/chat-title-core.js";

test("runtime identity is configured before the main module can take its lock", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const graphicsFlags = bootstrap.indexOf("applyLinuxGraphicsFlags()");
  const configure = bootstrap.indexOf("configureRuntimeProfile()");
  const loadMain = bootstrap.indexOf('await import("./index.js")');

  assert.ok(graphicsFlags >= 0 && configure > graphicsFlags && loadMain > configure);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/u);
  assert.doesNotMatch(main, /app\.setName\(/u);
});

test("Linux Wayland launches disable Chromium Vulkan before the main module loads", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const flags = readFileSync(new URL("./linux-graphics-flags.ts", import.meta.url), "utf8");
  assert.match(bootstrap, /applyLinuxGraphicsFlags\(\)/u);
  assert.match(flags, /appendSwitch\("disable-features", disableVulkanFeature\(app\.commandLine\.getSwitchValue\("disable-features"\)\)\)/u);
  assert.doesNotMatch(flags, /disableHardwareAcceleration/u);
});

test("the Electron build enters through the profile bootstrap", () => {
  const buildScript = readFileSync(
    new URL("../scripts/build-electron.mjs", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /entryPoints: \["main\/bootstrap\.ts"\]/u);
});

test("crash capture is off at bootstrap and only the explicit diagnostics handler can enable it", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const diagnostics = readFileSync(new URL("./handlers/diagnostics.ts", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../tests/e2e/fixtures.ts", import.meta.url), "utf8");
  assert.doesNotMatch(bootstrap, /crashReporter\.start/u);
  assert.match(diagnostics, /"diagnostics:mode-enable"[\s\S]*?crashReporter\.start/u);
  assert.match(diagnostics, /uploadToServer:\s*false/u);
  assert.match(fixture, /"--disable-gpu"/u);
  assert.match(fixture, /"--force-prefers-reduced-motion=reduce"/u);
  assert.match(fixture, /testInfo\.attach\("aiden-dev-log"/u);
});

test("development shortcut registration is gated without removing in-app menu accelerators", () => {
  const shortcut = readFileSync(
    new URL("./services/shortcut.ts", import.meta.url),
    "utf8",
  );
  assert.match(shortcut, /currentRuntimeProfile\(\)\.globalShortcutsEnabled/u);
  assert.match(
    shortcut,
    /currentRuntimeProfile\(\)\.globalShortcutsEnabled\s*&&\s*!recordingSuspended/u,
  );
  assert.match(shortcut, /onBindingsChanged\?\.\(canonicalSettings, !recordingSuspended\)/u);
});

test("visible main-process branding derives from the configured app name", () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(main, /title: app\.getName\(\)/u);
  assert.match(main, /appName: app\.getName\(\)/u);
  assert.match(main, /app\.dock\?\.setBadge\("DEV"\)/u);
});

test("optional background services cannot close an already visible desktop window", () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const mainWindow = main.indexOf("await createMainWindow()");
  const scheduleStart = main.indexOf("await scheduleService.start()", mainWindow);
  const telegramStart = main.indexOf("await telegramService.start()", scheduleStart);
  const updaterStart = main.indexOf("appUpdateService.start()", telegramStart);

  assert.ok(mainWindow >= 0 && scheduleStart > mainWindow);
  assert.ok(telegramStart > scheduleStart && updaterStart > telegramStart);
  assert.match(
    main.slice(mainWindow, updaterStart),
    /try \{[\s\S]*?await scheduleService\.start\(\)[\s\S]*?catch \(error\)[\s\S]*?desktop app will remain available for repair/u,
  );
  assert.match(
    main.slice(scheduleStart, updaterStart),
    /try \{[\s\S]*?await telegramService\.start\(\)[\s\S]*?catch \(error\)[\s\S]*?desktop app will remain available for repair/u,
  );
});

test("Apple Foundation Models status probes remain behind the host capability policy", async () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const titleProviders = readFileSync(
    new URL("./handlers/title-providers.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    main,
    /function refreshFoundationModelsStatus[\s\S]*?if \(!hostPlatformCapabilities\(\)\.appleFoundationModels\) return;[\s\S]*?foundationModelsConnection\.status/u,
  );
  assert.doesNotMatch(
    main,
    /app\.on\("activate", \(\) => \{\s*void foundationModelsConnection\.status/u,
  );
  assert.equal(
    titleProviders.match(
      /if \(!hostPlatformCapabilities\(\)\.appleFoundationModels\) return null;/gu,
    )?.length,
    2,
  );

  let statusCalls = 0;
  let generateCalls = 0;
  let chatModelCalls = 0;
  let chatTitleProviderId: "automatic" | "apple-foundation-models" = "automatic";

  const titleService = createChatTitleService({
    chatStore: {
      getWithImageReferences: async (id) => ({
        id,
        title: "New agent",
        workspaceId: "workspace-1",
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Check capability policy before probing Foundation Models",
            createdAt: 1,
          },
        ],
      }),
      readImage: async () => undefined,
      replaceAutoTitle: async (id, _seed, title) => ({
        id,
        title,
        workspaceId: "workspace-1",
        createdAt: 1,
        updatedAt: 2,
        messages: [],
      }),
      replaceTitleIfUnchanged: async () => null,
    },
    configStore: {
      getSettings: async () => ({ chatTitleProviderId }),
    },
    foundationModelsConnection: {
      status: async () => {
        statusCalls += 1;
        return {
          id: "apple-foundation-models",
          label: "Apple Foundation Models",
          state: "ready",
          detail: "Ready",
          local: true,
          titleOnly: true,
          retryable: false,
        };
      },
      generateTitle: async () => {
        generateCalls += 1;
        return "Foundation Models title";
      },
    },
    hostPlatformCapabilities: () => ({ appleFoundationModels: false }),
    resolveModelRuntime: async () =>
      ({
        provider: { id: "anthropic", label: "Anthropic", kind: "apiKey" },
        model: {
          id: "model-title",
          name: "Model Title",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://example.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
        apiKey: "secret",
        headers: undefined,
        streams: {
          streamSimple: () => {
            chatModelCalls += 1;
            return {
              result: async () => ({
                role: "assistant",
                content: [{ type: "text", text: "Chat model fallback title" }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "model-title",
                usage: {
                  input: 8,
                  output: 4,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 12,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: 2,
              }),
            };
          },
        },
      }) as never,
    usageStore: { record: async () => undefined },
    broadcastMetadataUpdated: () => undefined,
    logWarn: () => undefined,
  });

  titleService.startForFirstTurn({
    chatId: "chat-auto",
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn("chat-auto");
  assert.equal(statusCalls, 0);
  assert.equal(generateCalls, 0);
  assert.equal(chatModelCalls, 1);

  chatTitleProviderId = "apple-foundation-models";
  titleService.startForFirstTurn({
    chatId: "chat-afm",
    providerId: "anthropic",
    model: "model-title",
  });
  await titleService.waitForFirstTurn("chat-afm");
  assert.equal(statusCalls, 0);
  assert.equal(generateCalls, 0);
  assert.equal(chatModelCalls, 1);

  await assert.rejects(
    titleService.renameWithFoundationModels("chat-rename"),
    /Apple Foundation Models are not available on this platform/u,
  );
  assert.equal(statusCalls, 0);
  assert.equal(generateCalls, 0);
});

test("packaged test launches retain their explicit private user-data directory", () => {
  const profile = readFileSync(new URL("./runtime-profile.ts", import.meta.url), "utf8");
  const soak = readFileSync(
    new URL("../scripts/subagent-packaged-soak.mjs", import.meta.url),
    "utf8",
  );
  assert.match(soak, /`--user-data-dir=\$\{seeded\.userData\}`/u);
  assert.match(profile, /app\.commandLine\.hasSwitch\("user-data-dir"\)/u);
  assert.match(
    profile,
    /explicitUserDataPath: app\.commandLine\.hasSwitch\("user-data-dir"\)[\s\S]*?app\.commandLine\.getSwitchValue\("user-data-dir"\)/u,
  );
});

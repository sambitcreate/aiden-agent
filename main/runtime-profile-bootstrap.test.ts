import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(flags, /appendSwitch\("disable-features", "Vulkan"\)/u);
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

test("Apple Foundation Models status probes remain behind the host capability policy", () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const chatTitle = readFileSync(
    new URL("./services/chat-title.ts", import.meta.url),
    "utf8",
  );
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
  assert.match(
    chatTitle,
    /!hostPlatformCapabilities\(\)\.appleFoundationModels\s+\? null\s+: await foundationModelsConnection\.status/u,
  );
  assert.match(
    chatTitle,
    /generateFoundationModelsRename[\s\S]*?if \(!hostPlatformCapabilities\(\)\.appleFoundationModels\)/u,
  );
  assert.equal(
    titleProviders.match(
      /if \(!hostPlatformCapabilities\(\)\.appleFoundationModels\) return null;/gu,
    )?.length,
    2,
  );
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

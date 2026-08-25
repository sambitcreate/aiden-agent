import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runtime identity is configured before the main module can take its lock", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const configure = bootstrap.indexOf("configureRuntimeProfile()");
  const loadMain = bootstrap.indexOf('await import("./index.js")');

  assert.ok(configure >= 0 && loadMain > configure);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/u);
  assert.doesNotMatch(main, /app\.setName\(/u);
});

test("the Electron build enters through the profile bootstrap", () => {
  const buildScript = readFileSync(
    new URL("../scripts/build-electron.mjs", import.meta.url),
    "utf8",
  );
  assert.match(buildScript, /entryPoints: \["main\/bootstrap\.ts"\]/u);
});

test("the hermetic Electron E2E launch can disable the development crash helper", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../tests/e2e/fixtures.ts", import.meta.url), "utf8");
  assert.match(
    bootstrap,
    /process\.env\.AIDEN_E2E_DISABLE_CRASH_REPORTER\s*===\s*"1"/u,
  );
  assert.match(bootstrap, /if \(!crashReporterDisabledForE2e\) \{[\s\S]*?crashReporter\.start/u);
  assert.match(fixture, /AIDEN_E2E_DISABLE_CRASH_REPORTER:\s*"1"/u);
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
  assert.match(main, /label: app\.getName\(\)/u);
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

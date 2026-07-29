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

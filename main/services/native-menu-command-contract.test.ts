import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMMANDS } from "../../renderer/shared/keybindings";

test("catalog native-menu ownership exactly matches derived Electron accelerators", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const menuCommandIds = [
    ...main.matchAll(/accelerator:\s*command\("([^"]+)"\)/gu),
  ]
    .map((match) => match[1])
    .sort();
  const catalogCommandIds = COMMANDS.filter((command) => command.nativeMenu)
    .map((command) => command.id)
    .sort();

  assert.deepEqual(menuCommandIds, catalogCommandIds);
});

test("shortcut recording removes the application menu before capture begins", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(!acceleratorsEnabled\) \{\s*Menu\.setApplicationMenu\(null\)/u,
  );
});

test("every window creation path waits for settled startup shortcut state", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const createFunctionIndex = main.indexOf("async function createMainWindow()");
  const barrierIndex = main.indexOf(
    "await shortcutInitializationPromise",
    createFunctionIndex,
  );
  const applyIndex = main.indexOf("await applyShortcutFromSettings()");
  const resolveIndex = main.indexOf("resolveShortcutInitialization?.()", applyIndex);
  const createIndex = main.lastIndexOf("await createMainWindow()");
  assert.ok(createFunctionIndex >= 0 && barrierIndex > createFunctionIndex);
  assert.ok(applyIndex >= 0 && applyIndex < resolveIndex);
  assert.ok(resolveIndex < createIndex);
});

test("same-document recorder starts join one owned suspension request", () => {
  const handler = readFileSync(
    new URL("../handlers/shortcuts.ts", import.meta.url),
    "utf8",
  );
  assert.match(handler, /startPromise: Promise<KeybindingSnapshot> \| null/u);
  assert.match(handler, /if \(owner\.startPromise\) return owner\.startPromise/u);
  assert.match(handler, /if \(suspended\) return startRecorder\(claimRecorder\(event\)\)/u);
});

test("startup persists semantic V1 repair before runtime registration can fail", () => {
  const shortcut = readFileSync(new URL("./shortcut.ts", import.meta.url), "utf8");
  const start = shortcut.indexOf("export async function applyShortcutFromSettings");
  const persist = shortcut.indexOf("await configStore.setSettings({ keybindings })", start);
  const apply = shortcut.indexOf("return applyNow({ ...settings, keybindings })", start);
  assert.ok(start >= 0 && persist > start && apply > persist);
});

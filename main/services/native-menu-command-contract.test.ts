import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMMANDS } from "../../renderer/shared/keybindings";
import { applicationMenuTemplate } from "./application-menu-core";

test("catalog native-menu ownership exactly matches derived Electron accelerators", () => {
  let clicked: string | null = null;
  const menu = applicationMenuTemplate({
    platform: "darwin",
    appName: "Aiden Agent",
    bindings: Object.fromEntries(COMMANDS.map((command) => [command.id, command.defaultBinding])),
    actions: {
      checkForUpdates() {},
      deliverCommand(commandId) {
        clicked = commandId;
      },
      reload() {},
    },
  });
  // Items that only show a key (registerAccelerator: false) leave it to the
  // renderer, so they must not be native-menu commands.
  const owned = new Set<string>();
  const shown = new Set<string>();
  const invokeItems = (items: typeof menu): void => {
    for (const item of items) {
      if (typeof item.click === "function") {
        clicked = null;
        item.click({} as never, {} as never, {} as never);
        if (clicked) (item.registerAccelerator === false ? shown : owned).add(clicked);
      }
      if (Array.isArray(item.submenu)) invokeItems(item.submenu);
    }
  };
  invokeItems(menu);
  const catalogCommandIds = COMMANDS.filter((command) => command.nativeMenu)
    .map((command) => command.id)
    .sort();

  assert.deepEqual([...owned].sort(), catalogCommandIds);
  for (const id of shown) assert.ok(!catalogCommandIds.includes(id as never), id);
});

test("shortcut recording removes the application menu before capture begins", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(!acceleratorsEnabled\) \{\s*Menu\.setApplicationMenu\(null\)/u,
  );
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

test("portal dictation stays owned until a replacement shortcut registers", () => {
  const shortcut = readFileSync(new URL("./shortcut.ts", import.meta.url), "utf8");
  const reconcile = shortcut.indexOf("const result = await reconcileGlobalShortcuts");
  const failure = shortcut.indexOf("if (!result.ok && result.failedCommandId)", reconcile);
  const close = shortcut.indexOf("if (releaseLinuxPortal)", failure);
  assert.ok(reconcile >= 0 && failure > reconcile && close > failure);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { MenuItemConstructorOptions } from "electron";
import {
  applicationMenuTemplate,
  parseMenuCommandIds,
  platformMenuAccelerator,
} from "./application-menu-core.js";

const actions = {
  checkForUpdates() {},
  deliverCommand() {},
  reload() {},
};

test("macOS menu retains application services and update entry", () => {
  const menu = applicationMenuTemplate({
    platform: "darwin",
    appName: "Aiden Agent",
    bindings: {},
    actions,
  });
  assert.equal(menu[0]?.label, "Aiden Agent");
  assert.ok(
    Array.isArray(menu[0]?.submenu) &&
      menu[0].submenu.some((item) => item.role === "services"),
  );
  assert.ok(
    Array.isArray(menu[0]?.submenu) &&
      menu[0].submenu.some((item) => item.label === "Check for Updates…"),
  );
});

test("Linux menu uses conventional File and Help ownership", () => {
  const menu = applicationMenuTemplate({
    platform: "linux",
    appName: "Aiden Agent",
    bindings: {},
    actions,
  });
  assert.deepEqual(
    menu.map((item) => item.label ?? item.role),
    ["File", "editMenu", "View", "Go", "Chat", "windowMenu", "Help"],
  );
  const serialized = JSON.stringify(menu);
  assert.equal(serialized.includes("Check for Updates"), false);
  assert.equal(serialized.includes('"role":"services"'), false);
  const file = menu[0];
  assert.ok(Array.isArray(file.submenu) && file.submenu.some((item) => item.role === "quit"));
});

test("Linux native menus translate canonical Command bindings to Ctrl", () => {
  assert.equal(platformMenuAccelerator("Command+Shift+N", "linux"), "CommandOrControl+Shift+N");
  assert.equal(platformMenuAccelerator("Control+K", "linux"), "Super+K");
  assert.equal(platformMenuAccelerator("Command+Shift+N", "darwin"), "Command+Shift+N");
  assert.equal(platformMenuAccelerator(null, "linux"), undefined);
});

function submenu(menu: MenuItemConstructorOptions[], name: string): MenuItemConstructorOptions[] {
  const item = menu.find((entry) => entry.label === name || entry.role === name);
  assert.ok(item && Array.isArray(item.submenu), `${name} menu`);
  return item.submenu;
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  assert.ok(found, label);
  return found;
}

test("macOS gets View, Go and Chat menus, and Help lists Keyboard Shortcuts", () => {
  const menu = applicationMenuTemplate({
    platform: "darwin",
    appName: "Aiden Agent",
    bindings: { "shortcuts.show": "Command+/", "sidebar.toggle": "Command+B", "chat.find": "Command+F" },
    actions,
  });
  assert.deepEqual(
    menu.map((entry) => entry.label ?? entry.role),
    ["Aiden Agent", "File", "editMenu", "View", "Go", "Chat", "windowMenu", "help"],
  );
  assert.equal(item(submenu(menu, "help"), "Keyboard Shortcuts").accelerator, "Command+/");
  assert.equal(item(submenu(menu, "View"), "Toggle Sidebar").accelerator, "Command+B");
  assert.equal(item(submenu(menu, "Chat"), "Find in Chat").accelerator, "Command+F");
  assert.ok(item(submenu(menu, "Go"), "Back"));
});

test("menu items for in-app keys show the key as set, without taking it from the page", () => {
  const delivered: string[] = [];
  const menu = applicationMenuTemplate({
    platform: "linux",
    appName: "Aiden Agent",
    // A key someone changed in Settings, and one they turned off.
    bindings: { "chat.find": "Command+Shift+G", "chat.stop": null },
    actions: { ...actions, deliverCommand: (commandId) => delivered.push(commandId) },
  });
  const chat = submenu(menu, "Chat");
  const find = item(chat, "Find in Chat");
  assert.equal(find.accelerator, "CommandOrControl+Shift+G");
  assert.equal(find.registerAccelerator, false, "the page keeps the key");
  assert.equal(item(chat, "Stop Reply").accelerator, undefined);
  find.click?.({} as never, undefined, { triggeredByAccelerator: false } as never);
  assert.deepEqual(delivered, ["chat.find"]);
});

test("on a Mac a menu item runs when chosen, by mouse or Return, but not when its key fires it", () => {
  const delivered: string[] = [];
  const menu = applicationMenuTemplate({
    platform: "darwin",
    appName: "Aiden Agent",
    bindings: { "chat.find": "Command+Shift+G", "model.change": null },
    actions: { ...actions, deliverCommand: (commandId) => delivered.push(commandId) },
  });
  const chat = submenu(menu, "Chat");
  const press = (label: string, event: Record<string, boolean>) =>
    item(chat, label).click?.({} as never, undefined, event as never);
  press("Find in Chat", { triggeredByAccelerator: false });
  // Return in the open menu is also reported as not a mouse click.
  press("Find in Chat", { triggeredByAccelerator: true });
  press("Change Model…", { triggeredByAccelerator: true });
  assert.deepEqual(delivered, ["chat.find", "chat.find", "model.change"]);
  // ⇧⌘G that the page left alone (the terminal keeps it) or never saw (an
  // artifact frame) comes back as the item's key, and runs nothing.
  press("Find in Chat", { triggeredByAccelerator: true, metaKey: true, shiftKey: true });
  assert.deepEqual(delivered, ["chat.find", "chat.find", "model.change"]);
});

test("menu items grey out while the app can't run them, once it has said what it can run", () => {
  const build = (available: ReadonlySet<string> | null) =>
    applicationMenuTemplate({ platform: "darwin", appName: "Aiden Agent", bindings: {}, actions, available });
  const before = submenu(build(null), "Chat");
  assert.equal(item(before, "Rename…").enabled, true, "everything works until the app reports");
  const menu = build(new Set(["chat.find", "navigate.back"]));
  assert.equal(item(submenu(menu, "Chat"), "Find in Chat").enabled, true);
  assert.equal(item(submenu(menu, "Chat"), "Rename…").enabled, false);
  assert.equal(item(submenu(menu, "Go"), "Back").enabled, true);
  assert.equal(item(submenu(menu, "Go"), "Forward").enabled, false);
  // Menu-owned commands stay on: their key always works.
  assert.notEqual(item(submenu(menu, "File"), "New Chat").enabled, false);
});

test("the app's list of runnable commands keeps only known command ids", () => {
  assert.deepEqual([...(parseMenuCommandIds(["chat.find", "nope", 3, null, "navigate.back"]) ?? [])], [
    "chat.find",
    "navigate.back",
  ]);
  assert.equal(parseMenuCommandIds("chat.find"), null);
  assert.equal(parseMenuCommandIds(undefined), null);
});

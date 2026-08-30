import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationMenuTemplate,
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
    ["File", "editMenu", "View", "windowMenu", "Help"],
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

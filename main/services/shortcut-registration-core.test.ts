import assert from "node:assert/strict";
import test from "node:test";
import type { CommandId } from "../../renderer/shared/keybindings";
import {
  reconcileGlobalShortcuts,
  type RegisteredGlobalShortcut,
  type ShortcutRegistrationPort,
} from "./shortcut-registration-core";

function fakePort(blocked = new Set<string>()) {
  const active = new Set<string>();
  const port: ShortcutRegistrationPort = {
    register(accelerator) {
      if (blocked.has(accelerator) || active.has(accelerator)) return false;
      active.add(accelerator);
      return true;
    },
    unregister(accelerator) {
      active.delete(accelerator);
    },
  };
  return { active, port };
}

const handler = () => undefined;
const registered = (
  commandId: CommandId,
  accelerator: string,
): RegisteredGlobalShortcut => ({ commandId, accelerator, handler });

test("changes only the affected registration", async () => {
  const { active, port } = fakePort();
  active.add("Command+Alt+Space");
  active.add("Command+Alt+A");
  const current = new Map<CommandId, RegisteredGlobalShortcut>([
    ["composer.focus", registered("composer.focus", "Command+Alt+Space")],
    ["assistant.open", registered("assistant.open", "Command+Alt+A")],
  ]);
  const result = await reconcileGlobalShortcuts(port, current, [
    { commandId: "composer.focus", accelerator: "Command+Shift+Space", handler },
    { commandId: "assistant.open", accelerator: "Command+Alt+A", handler },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual([...active].sort(), ["Command+Alt+A", "Command+Shift+Space"]);
});

test("failed registration rolls back every released shortcut", async () => {
  const { active, port } = fakePort(new Set(["Command+Shift+Space"]));
  active.add("Command+Alt+Space");
  const current = new Map<CommandId, RegisteredGlobalShortcut>([
    ["composer.focus", registered("composer.focus", "Command+Alt+Space")],
  ]);
  const result = await reconcileGlobalShortcuts(port, current, [
    { commandId: "composer.focus", accelerator: "Command+Shift+Space", handler },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual([...active], ["Command+Alt+Space"]);
  assert.equal(result.registered.get("composer.focus")?.accelerator, "Command+Alt+Space");
});

test("supports atomic swaps by releasing both old accelerators first", async () => {
  const { active, port } = fakePort();
  active.add("Command+Alt+Space");
  active.add("Command+Alt+A");
  const current = new Map<CommandId, RegisteredGlobalShortcut>([
    ["composer.focus", registered("composer.focus", "Command+Alt+Space")],
    ["assistant.open", registered("assistant.open", "Command+Alt+A")],
  ]);
  const result = await reconcileGlobalShortcuts(port, current, [
    { commandId: "composer.focus", accelerator: "Command+Alt+A", handler },
    { commandId: "assistant.open", accelerator: "Command+Alt+Space", handler },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual([...active].sort(), ["Command+Alt+A", "Command+Alt+Space"]);
});

test("recorder suspension releases every owned shortcut and restores them afterward", async () => {
  const { active, port } = fakePort();
  active.add("Command+Alt+Space");
  active.add("Command+Alt+A");
  const current = new Map<CommandId, RegisteredGlobalShortcut>([
    ["composer.focus", registered("composer.focus", "Command+Alt+Space")],
    ["assistant.open", registered("assistant.open", "Command+Alt+A")],
  ]);

  const suspended = await reconcileGlobalShortcuts(port, current, [
    { commandId: "composer.focus", accelerator: null, handler },
    { commandId: "assistant.open", accelerator: null, handler },
  ]);
  assert.equal(suspended.ok, true);
  assert.deepEqual([...active], []);

  const restored = await reconcileGlobalShortcuts(port, suspended.registered, [
    { commandId: "composer.focus", accelerator: "Command+Alt+Space", handler },
    { commandId: "assistant.open", accelerator: "Command+Alt+A", handler },
  ]);
  assert.equal(restored.ok, true);
  assert.deepEqual([...active].sort(), ["Command+Alt+A", "Command+Alt+Space"]);
});

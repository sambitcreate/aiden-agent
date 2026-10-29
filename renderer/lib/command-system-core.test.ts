import assert from "node:assert/strict";
import test from "node:test";
import { applyKeybindingMutation, effectiveBindings } from "../shared/keybindings";
import {
  commandExecutionAllowed,
  paletteCommands,
  resolveCommandForKeyEvent,
  workspaceCommandVisibility,
  type CommandDispatchContext,
} from "./command-system-core";

const base: CommandDispatchContext = {
  editable: false,
  fileEditor: false,
  terminal: false,
  modal: false,
  paletteOpen: false,
  composing: false,
  repeat: false,
  defaultPrevented: false,
  recording: false,
};

const event = (key: string, code: string, shiftKey = false) => ({
  key,
  code,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey,
});

test("application-modal state blocks native global commands until it is cleared", () => {
  const modal = {
    applicationModal: true,
    dialogOpen: false,
    foreignDialog: false,
    paletteOpen: false,
  };
  assert.equal(commandExecutionAllowed("assistant.open", modal), false);
  assert.equal(commandExecutionAllowed("commandPalette.toggle", modal), false);
  assert.equal(
    commandExecutionAllowed("assistant.open", {
      ...modal,
      applicationModal: false,
    }),
    true,
  );
});

test("workspace-only commands are unavailable when their surfaces are unmounted", () => {
  assert.deepEqual(workspaceCommandVisibility("/settings"), {
    environment: false,
    terminal: false,
  });
  assert.deepEqual(workspaceCommandVisibility("/profile"), {
    environment: true,
    terminal: false,
  });
  assert.deepEqual(workspaceCommandVisibility("/chat/chat-1"), {
    environment: true,
    terminal: true,
  });
  assert.deepEqual(workspaceCommandVisibility("/bots/bot-1/chat/chat-1"), {
    environment: true,
    terminal: true,
  });
});

test("resolves exact app commands and rejects extra modifiers", () => {
  const bindings = effectiveBindings(undefined);
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, base),
    "commandPalette.toggle",
  );
  assert.equal(
    resolveCommandForKeyEvent({ ...event("k", "KeyK"), altKey: true }, bindings, base),
    null,
  );
});

test("does not steal commands from editable controls except explicit commands", () => {
  const bindings = effectiveBindings(undefined);
  assert.equal(
    resolveCommandForKeyEvent(event("n", "KeyN"), bindings, { ...base, editable: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, editable: true }),
    "commandPalette.toggle",
  );
  assert.equal(
    resolveCommandForKeyEvent(event("b", "KeyB"), bindings, { ...base, editable: true }),
    "sidebar.toggle",
  );
  assert.equal(
    resolveCommandForKeyEvent(event("s", "KeyS"), bindings, {
      ...base,
      editable: true,
      fileEditor: true,
    }),
    "file.save",
  );
});

test("same binding resolves to the command for the active non-overlapping scope", () => {
  const shared = applyKeybindingMutation(undefined, {
    commandId: "terminal.toggle",
    binding: "Command+S",
  });
  const bindings = effectiveBindings(shared);

  assert.equal(resolveCommandForKeyEvent(event("s", "KeyS"), bindings, base), "terminal.toggle");
  assert.equal(
    resolveCommandForKeyEvent(event("s", "KeyS"), bindings, {
      ...base,
      editable: true,
      fileEditor: true,
    }),
    "file.save",
  );
});

test("modal, terminal, repeat, and composition guards are deterministic", () => {
  const bindings = effectiveBindings(undefined);
  assert.equal(
    resolveCommandForKeyEvent(event("n", "KeyN"), bindings, { ...base, modal: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, modal: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, {
      ...base,
      modal: true,
      paletteOpen: true,
    }),
    "commandPalette.toggle",
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, terminal: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, repeat: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, composing: true }),
    null,
  );
  assert.equal(
    resolveCommandForKeyEvent(event("k", "KeyK"), bindings, { ...base, recording: true }),
    null,
  );
});

test("studio surfaces hide the Environment and terminal commands", () => {
  for (const pathname of ["/design", "/design/project-1", "/images", "/images/workflow-1"]) {
    assert.deepEqual(workspaceCommandVisibility(pathname), { environment: false, terminal: false }, pathname);
  }
  assert.deepEqual(workspaceCommandVisibility("/chat/chat-1"), { environment: true, terminal: true });
  assert.deepEqual(workspaceCommandVisibility("/settings"), { environment: false, terminal: false });
  assert.deepEqual(workspaceCommandVisibility("/scheduled"), { environment: true, terminal: false });
});

test("palette omits studio commands while their capability is off", () => {
  const studio = (capabilities: { designStudio: boolean; createImages: boolean }) =>
    paletteCommands(capabilities)
      .map(({ id }) => id)
      .filter((id) => id === "design.open" || id === "images.open");

  assert.deepEqual(studio({ designStudio: false, createImages: false }), []);
  assert.deepEqual(studio({ designStudio: true, createImages: false }), ["design.open"]);
  assert.deepEqual(studio({ designStudio: false, createImages: true }), ["images.open"]);
  assert.deepEqual(studio({ designStudio: true, createImages: true }), ["design.open", "images.open"]);
  // With both flags off, nothing capability-gated remains in the palette.
  assert.ok(
    paletteCommands({ designStudio: false, createImages: false }).every(
      (definition) => definition.requiresCapability === undefined,
    ),
  );
});

test("chat actions show in the palette only while something on screen can run them", () => {
  const capabilities = { designStudio: true, createImages: true };
  const nothingOnScreen = paletteCommands(capabilities, () => false).map(({ id }) => id);
  assert.ok(!nothingOnScreen.includes("chat.rename"));
  assert.ok(!nothingOnScreen.includes("chat.stop"));
  assert.ok(!nothingOnScreen.includes("tools.browser"));
  // App-wide commands stay listed whether or not a handler is mounted yet.
  assert.ok(nothingOnScreen.includes("settings.open"));
  assert.ok(nothingOnScreen.includes("chat.search"));

  const renameOnly = paletteCommands(capabilities, (id) => id === "chat.rename").map(({ id }) => id);
  assert.ok(renameOnly.includes("chat.rename"));
  assert.ok(!renameOnly.includes("chat.delete"));
});

test("studio commands never reserve a shortcut", () => {
  const bindings = effectiveBindings(undefined);
  assert.equal(bindings["design.open"], null);
  assert.equal(bindings["images.open"], null);
});

test("a key that matches no binding never reads the page-dependent context", () => {
  const bindings = effectiveBindings(undefined);
  const reads: string[] = [];
  const context = Object.defineProperties({ ...base }, Object.fromEntries(
    (["editable", "fileEditor", "terminal", "modal"] as const).map((name) => [
      name,
      { get: () => (reads.push(name), false) },
    ]),
  )) as CommandDispatchContext;
  const typed = { key: "a", code: "KeyA", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(resolveCommandForKeyEvent(typed, bindings, context), null);
  assert.equal(reads.length, 0, reads.join(", "));
  // A real shortcut still consults the context before it runs.
  assert.notEqual(resolveCommandForKeyEvent(event("k", "KeyK"), bindings, context), null);
  assert.ok(reads.includes("modal"));
});

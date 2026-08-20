import assert from "node:assert/strict";
import test from "node:test";
import { applyKeybindingMutation, effectiveBindings } from "../shared/keybindings";
import {
  commandExecutionAllowed,
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
  assert.deepEqual(workspaceCommandVisibility("/create-images/workflow-1"), {
    environment: false,
    terminal: false,
  });
  assert.deepEqual(workspaceCommandVisibility("/chat/chat-1"), {
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

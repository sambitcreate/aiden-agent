import assert from "node:assert/strict";
import test from "node:test";
import {
  acceleratorFromKeyboardEvent,
  applyKeybindingMutation,
  effectiveBinding,
  effectiveBindings,
  hasFutureKeybindings,
  KeybindingValidationError,
  migrateLegacyKeybindings,
  normalizeAccelerator,
  normalizeKeybindingOverrides,
  prettyAccelerator,
  repairKeybindingOverrides,
  shouldPersistCanonicalKeybindings,
  validateEffectiveBindings,
} from "./keybindings";

test("future keybinding documents are used defensively without being downgraded", () => {
  const future = { version: 2, commands: { "chat.new": { binding: "Command+J" } } };
  const canonical = migrateLegacyKeybindings(future, {
    shortcutAccelerator: "Command+Shift+Space",
  });

  assert.equal(hasFutureKeybindings(future), true);
  assert.equal(hasFutureKeybindings({ version: 1, commands: {} }), false);
  assert.equal(hasFutureKeybindings({ version: 1.5, commands: {} }), false);
  assert.equal(hasFutureKeybindings({ version: "2", commands: {} }), false);
  assert.equal(shouldPersistCanonicalKeybindings(future, canonical), false);
  assert.equal(shouldPersistCanonicalKeybindings(undefined, canonical), true);
  assert.throws(
    () =>
      applyKeybindingMutation(future, {
        commandId: "chat.new",
        binding: "Command+Shift+N",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "future-version",
  );
});

test("normalizes aliases, modifier order, and punctuation", () => {
  assert.equal(normalizeAccelerator("shift+cmd+["), "Command+Shift+[");
  assert.equal(normalizeAccelerator("option+control+space"), "Control+Alt+Space");
  assert.equal(normalizeAccelerator("K"), null);
  assert.equal(prettyAccelerator("Command+Alt+Space"), "⌘⌥Space");
});

test("records physical letter and exact modifiers", () => {
  assert.equal(
    acceleratorFromKeyboardEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
    "Command+K",
  );
  assert.equal(
    acceleratorFromKeyboardEvent({
      key: "{",
      code: "BracketLeft",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }),
    "Command+Shift+[",
  );
  assert.equal(
    acceleratorFromKeyboardEvent({
      key: "+",
      code: "Equal",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }),
    "Command+Shift+=",
  );
});

test("legacy global settings remain effective until overridden", () => {
  assert.equal(effectiveBinding("composer.focus", undefined, {}), "Command+Alt+Space");
  assert.equal(effectiveBinding("assistant.open", undefined, {}), "Command+Alt+A");
  assert.equal(
    effectiveBinding("composer.focus", undefined, {
      shortcutEnabled: true,
      shortcutAccelerator: "Command+Shift+Space",
    }),
    "Command+Shift+Space",
  );
  assert.equal(effectiveBinding("dictation.toggle", undefined, { dictationEnabled: false }), null);
  assert.equal(effectiveBinding("dictation.toggle", undefined, {}), null);
  assert.equal(
    effectiveBinding("dictation.toggle", undefined, { dictationEnabled: true }),
    "Command+Shift+D",
  );
});

test("rejects conflicts and reserved bindings without mutating the prior value", () => {
  const current = normalizeKeybindingOverrides(undefined);
  assert.throws(
    () =>
      applyKeybindingMutation(current, {
        commandId: "chat.new",
        binding: "Command+K",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "conflict",
  );
  assert.throws(
    () =>
      applyKeybindingMutation(current, {
        commandId: "chat.new",
        binding: "Command+Q",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "reserved",
  );
  assert.throws(
    () =>
      applyKeybindingMutation(current, {
        commandId: "chat.new",
        binding: "Command+C",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "reserved",
  );
  assert.throws(
    () =>
      applyKeybindingMutation(current, {
        commandId: "chat.new",
        binding: "Command+D",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "reserved",
  );
  assert.throws(
    () =>
      applyKeybindingMutation(current, {
        commandId: "chat.new",
        binding: "Command+Shift+=",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "reserved",
  );
  assert.equal(effectiveBindings(current)["chat.new"], "Command+N");
});

test("catalog defaults remain conflict-free and avoid native role accelerators", () => {
  assert.doesNotThrow(() => validateEffectiveBindings(effectiveBindings(undefined)));
  assert.equal(effectiveBinding("sidebar.toggle", undefined), "Command+B");
});

test("reset removes only the selected override", () => {
  const changed = applyKeybindingMutation(undefined, {
    commandId: "chat.new",
    binding: "Command+Shift+N",
  });
  const reset = applyKeybindingMutation(changed, { commandId: "chat.new", reset: true });
  assert.equal(reset.commands["chat.new"], undefined);
  assert.equal(effectiveBinding("chat.new", reset), "Command+N");
});

test("first mutation atomically migrates and preserves legacy global settings", () => {
  const legacy = {
    shortcutEnabled: true,
    shortcutAccelerator: "Command+Shift+Space",
    dictationEnabled: false,
    assistant: {
      hotkeyEnabled: true,
      hotkeyAccelerator: "Command+Shift+A",
    },
  };
  const changed = applyKeybindingMutation(
    undefined,
    { commandId: "terminal.toggle", binding: "Command+Control+T" },
    legacy,
  );

  assert.equal(effectiveBinding("composer.focus", changed), "Command+Shift+Space");
  assert.equal(effectiveBinding("dictation.toggle", changed), null);
  assert.equal(effectiveBinding("assistant.open", changed), "Command+Shift+A");
  assert.equal(effectiveBinding("terminal.toggle", changed), "Command+Control+T");
});

test("reset after migration returns the catalog default instead of the legacy value", () => {
  const legacy = {
    shortcutEnabled: true,
    shortcutAccelerator: "Command+Shift+Space",
  };
  const migrated = migrateLegacyKeybindings(undefined, legacy);
  const changed = applyKeybindingMutation(migrated, {
    commandId: "composer.focus",
    binding: "Command+Control+Space",
  });
  const reset = applyKeybindingMutation(changed, {
    commandId: "composer.focus",
    reset: true,
  });

  assert.equal(effectiveBinding("composer.focus", reset), "Command+Alt+Space");
});

test("migration preserves a legacy global collision by disabling the new local default", () => {
  const migrated = migrateLegacyKeybindings(undefined, {
    shortcutEnabled: true,
    shortcutAccelerator: "Command+N",
  });

  assert.equal(effectiveBinding("composer.focus", migrated), "Command+N");
  assert.equal(effectiveBinding("chat.new", migrated), null);
});

test("normalization tolerates malformed canonical data and preserves future commands", () => {
  assert.equal(effectiveBinding("chat.new", { version: 1 }), "Command+N");

  const normalized = normalizeKeybindingOverrides({
    version: 1,
    commands: {
      "future.command": { binding: "Command+Shift+U", metadata: { source: "future" } },
      "chat.new": {
        binding: "Command+N",
        futurePolicy: { mode: "future" },
      },
    },
  });
  const changed = applyKeybindingMutation(normalized, {
    commandId: "terminal.toggle",
    binding: "Command+Control+T",
  });
  assert.deepEqual((changed.commands as Record<string, unknown>)["future.command"], {
    binding: "Command+Shift+U",
    metadata: { source: "future" },
  });
  assert.deepEqual((changed.commands as Record<string, unknown>)["chat.new"], {
    futurePolicy: { mode: "future" },
    binding: "Command+N",
  });
  const reboundKnown = applyKeybindingMutation(changed, {
    commandId: "chat.new",
    binding: "Command+Shift+N",
  });
  assert.deepEqual((reboundKnown.commands as Record<string, unknown>)["chat.new"], {
    futurePolicy: { mode: "future" },
    binding: "Command+Shift+N",
    disabled: false,
  });
  const resetKnown = applyKeybindingMutation(reboundKnown, {
    commandId: "chat.new",
    reset: true,
  });
  assert.deepEqual((resetKnown.commands as Record<string, unknown>)["chat.new"], {
    futurePolicy: { mode: "future" },
  });
  const prototypeSafe = normalizeKeybindingOverrides(
    JSON.parse(
      '{"version":1,"commands":{"__proto__":{"settings.open":{"binding":"NotAnAccelerator"}}}}',
    ),
  );
  assert.equal(Object.getPrototypeOf(prototypeSafe.commands), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototypeSafe.commands, "__proto__")?.value, {
    "settings.open": { binding: "NotAnAccelerator" },
  });
  assert.equal(effectiveBinding("settings.open", prototypeSafe), "Command+,");
});

test("current keybinding edits, resets, and repairs preserve unknown root fields", () => {
  const source = {
    version: 1 as const,
    futurePolicy: { owner: "newer-build", revision: 3 },
    commands: {
      "chat.new": { binding: "Command+Shift+N" },
    },
  };
  const normalized = normalizeKeybindingOverrides(source);
  const edited = applyKeybindingMutation(normalized, {
    commandId: "terminal.toggle",
    binding: "Command+Control+T",
  });
  const reset = applyKeybindingMutation(edited, {
    commandId: "terminal.toggle",
    reset: true,
  });
  const repaired = repairKeybindingOverrides({
    ...source,
    commands: { "chat.new": { binding: "Command+C" } },
  });

  for (const document of [normalized, edited, reset, repaired]) {
    assert.deepEqual(document.futurePolicy, {
      owner: "newer-build",
      revision: 3,
    });
  }
});

test("an assigned default-unbound command can be disabled and re-enabled", () => {
  const assigned = applyKeybindingMutation(undefined, {
    commandId: "model.change",
    binding: "Command+Shift+M",
  });
  const disabled = applyKeybindingMutation(assigned, {
    commandId: "model.change",
    disabled: true,
  });
  const reenabled = applyKeybindingMutation(disabled, {
    commandId: "model.change",
    disabled: false,
  });

  assert.equal(effectiveBinding("model.change", disabled), null);
  assert.equal(effectiveBinding("model.change", reenabled), "Command+Shift+M");
});

test("explicitly enabling dictation uses its opt-in default binding", () => {
  const enabled = applyKeybindingMutation(undefined, {
    commandId: "dictation.toggle",
    disabled: false,
  });
  assert.equal(effectiveBinding("dictation.toggle", enabled), "Command+Shift+D");
  assert.equal(
    effectiveBinding(
      "dictation.toggle",
      normalizeKeybindingOverrides(JSON.parse(JSON.stringify(enabled))),
    ),
    "Command+Shift+D",
  );
});

test("enabling a persisted null binding restores its catalog default", () => {
  const enabled = applyKeybindingMutation(
    {
      version: 1,
      commands: {
        "chat.new": { binding: null },
      },
    },
    {
      commandId: "chat.new",
      disabled: false,
    },
  );

  assert.equal(effectiveBinding("chat.new", enabled), "Command+N");
  assert.equal(enabled.commands["chat.new"]?.binding, "Command+N");
});

test("disjoint renderer scopes can share a binding safely", () => {
  const shared = applyKeybindingMutation(undefined, {
    commandId: "terminal.toggle",
    binding: "Command+S",
  });

  assert.equal(effectiveBinding("terminal.toggle", shared), "Command+S");
  assert.equal(effectiveBinding("file.save", shared), "Command+S");
});

test("native menu accelerators cannot share a renderer-scoped binding", () => {
  assert.throws(
    () =>
      applyKeybindingMutation(undefined, {
        commandId: "chat.new",
        binding: "Command+S",
      }),
    (error) => error instanceof KeybindingValidationError && error.code === "conflict",
  );
});

test("repairs V1 bindings accepted before native-menu scope and role reservations", () => {
  const scopedConflict = repairKeybindingOverrides({
    version: 1,
    commands: {
      "chat.new": { binding: "Command+S", futurePolicy: { version: 2 } },
    },
  });
  assert.equal(effectiveBinding("chat.new", scopedConflict), "Command+N");
  assert.equal(effectiveBinding("file.save", scopedConflict), "Command+S");
  assert.deepEqual((scopedConflict.commands as Record<string, unknown>)["chat.new"], {
    futurePolicy: { version: 2 },
  });

  const roleConflict = migrateLegacyKeybindings({
    version: 1,
    commands: {
      "chat.new": { binding: "Command+C" },
      "future.command": { binding: "Command+Shift+U" },
    },
  });
  assert.equal(effectiveBinding("chat.new", roleConflict), "Command+N");
  assert.deepEqual((roleConflict.commands as Record<string, unknown>)["future.command"], {
    binding: "Command+Shift+U",
  });
  assert.doesNotThrow(() => validateEffectiveBindings(effectiveBindings(roleConflict)));
});

test("explicit replacement disables the previous owner atomically", () => {
  const replaced = applyKeybindingMutation(undefined, {
    commandId: "terminal.toggle",
    binding: "Command+N",
    replace: true,
  });

  assert.equal(effectiveBinding("terminal.toggle", replaced), "Command+N");
  assert.equal(effectiveBinding("chat.new", replaced), null);
});

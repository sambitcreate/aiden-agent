import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, type KeyboardPlatform } from "../shared/keybindings";
import {
  CANVAS_COMMAND_SHORTCUTS,
  CANVAS_TOOL_SHORTCUTS,
  resolveCanvasKey,
  type CanvasKeyEvent,
} from "./canvas-keymap-core";
import { formatZoomPercent } from "./canvas-viewport-core";

const key = (code: string, overrides: Partial<CanvasKeyEvent> = {}): CanvasKeyEvent => ({
  key: code.replace(/^Key|^Digit/u, "").toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...overrides,
});
const idle = { editable: false };

test("single letters switch tools and Shift digits fit or reset the zoom", () => {
  assert.deepEqual(resolveCanvasKey(key("KeyV"), idle), { type: "tool", tool: "select" });
  assert.deepEqual(resolveCanvasKey(key("KeyH"), idle), { type: "tool", tool: "hand" });
  assert.deepEqual(resolveCanvasKey(key("Digit1", { shiftKey: true, key: "!" }), idle), {
    type: "fitView",
  });
  assert.deepEqual(resolveCanvasKey(key("Digit0", { shiftKey: true, key: ")" }), idle), {
    type: "zoomReset",
  });
  assert.deepEqual(resolveCanvasKey(key("KeyM"), idle), { type: "toggleMinimap" });
});

test("plus and minus zoom, including the shifted plus and held repeats", () => {
  assert.deepEqual(resolveCanvasKey(key("Equal", { key: "=" }), idle), { type: "zoomIn" });
  assert.deepEqual(resolveCanvasKey(key("Equal", { key: "+", shiftKey: true }), idle), {
    type: "zoomIn",
  });
  assert.deepEqual(resolveCanvasKey(key("Minus", { key: "-", repeat: true }), idle), {
    type: "zoomOut",
  });
});

test("text entry, modifiers, IME and repeated tool keys never trigger canvas commands", () => {
  assert.equal(resolveCanvasKey(key("KeyV"), { editable: true }), null);
  // Command+V and Control+V stay paste; Command+= stays app zoom.
  assert.equal(resolveCanvasKey(key("KeyV", { metaKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyV", { ctrlKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("Equal", { key: "=", metaKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { altKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { isComposing: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyH", { repeat: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyV", { shiftKey: true }), idle), null);
  assert.equal(resolveCanvasKey(key("KeyQ"), idle), null);
});

test("no app command binding resolves to a canvas command on macOS or Linux", () => {
  const codeFor = (base: string): { key: string; code: string } => {
    if (/^[A-Z]$/u.test(base)) return { key: base.toLowerCase(), code: `Key${base}` };
    if (/^\d$/u.test(base)) return { key: base, code: `Digit${base}` };
    const named: Record<string, string> = {
      "=": "Equal",
      "-": "Minus",
      "[": "BracketLeft",
      "]": "BracketRight",
      ",": "Comma",
      Space: "Space",
    };
    return { key: base, code: named[base] ?? base };
  };
  const eventFor = (accelerator: string, platform: KeyboardPlatform): CanvasKeyEvent => {
    const parts = accelerator.split("+");
    const base = codeFor(parts[parts.length - 1]);
    const mods = new Set(parts.slice(0, -1));
    const primary = mods.has("Command");
    const secondary = mods.has("Control");
    return key(base.code, {
      key: base.key,
      metaKey: platform === "darwin" ? primary : secondary,
      ctrlKey: platform === "darwin" ? secondary : primary,
      altKey: mods.has("Alt"),
      shiftKey: mods.has("Shift"),
    });
  };
  const bindings = COMMANDS.flatMap((command) =>
    command.defaultBinding ? [command.defaultBinding] : [],
  );
  assert.ok(bindings.length > 5);
  for (const platform of ["darwin", "linux"] as const) {
    for (const accelerator of [...bindings, "Command+V", "Command+=", "Command+0", "Command+-"]) {
      assert.equal(
        resolveCanvasKey(eventFor(accelerator, platform), idle),
        null,
        `${accelerator} on ${platform}`,
      );
    }
  }
});

test("tool shortcut labels match the keys that switch tools", () => {
  for (const [tool, letter] of Object.entries(CANVAS_TOOL_SHORTCUTS)) {
    assert.deepEqual(resolveCanvasKey(key(`Key${letter}`), idle), { type: "tool", tool });
  }
});

test("zoom percentages round to whole numbers", () => {
  assert.equal(formatZoomPercent(1), "100%");
  assert.equal(formatZoomPercent(1.2), "120%");
  assert.equal(formatZoomPercent(0.3333), "33%");
});

const PHYSICAL_CODES: Record<string, string> = { "=": "Equal", "-": "Minus" };

/** Builds the event a keyboard would send for an aria-keyshortcuts string such as "Shift+0". */
function eventForShortcut(shortcut: string): CanvasKeyEvent {
  const parts = shortcut.split("+");
  const base = parts.pop() as string;
  const code =
    PHYSICAL_CODES[base] ?? (/^\d$/u.test(base) ? `Digit${base}` : `Key${base.toUpperCase()}`);
  return key(code, { key: base, shiftKey: parts.includes("Shift") });
}

test("every advertised command shortcut resolves to its own command", () => {
  assert.deepEqual(Object.keys(CANVAS_COMMAND_SHORTCUTS).sort(), [
    "fitView",
    "toggleMinimap",
    "zoomIn",
    "zoomOut",
    "zoomReset",
  ]);
  for (const [name, shortcut] of Object.entries(CANVAS_COMMAND_SHORTCUTS)) {
    assert.deepEqual(
      resolveCanvasKey(eventForShortcut(shortcut), idle),
      { type: name },
      `${name} (${shortcut})`,
    );
  }
});

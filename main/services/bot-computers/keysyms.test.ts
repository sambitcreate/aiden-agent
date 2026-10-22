import assert from "node:assert/strict";
import test from "node:test";

import { hidUsageForCode } from "../../../renderer/lib/device-stream.js";
import { characterKey, chordKeyStrokes, keysymForHidUsage, textKeyStrokes, XK } from "./keysyms.js";

const down = (keysym: number) => ({ keysym, down: true });
const up = (keysym: number) => ({ keysym, down: false });

test("what the viewer sends for each physical key reaches the guest as that key's keysym", () => {
  // The renderer encodes KeyboardEvent.code as a HID usage; main turns it into a keysym.
  const cases: [string, number][] = [
    ["KeyA", 0x61],
    ["KeyZ", 0x7a],
    ["Digit1", 0x31],
    ["Digit9", 0x39],
    ["Digit0", 0x30],
    ["Enter", XK.Return],
    ["Escape", XK.Escape],
    ["Backspace", XK.BackSpace],
    ["Delete", XK.Delete],
    ["Tab", XK.Tab],
    ["Space", 0x20],
    ["Minus", 0x2d],
    ["Equal", 0x3d],
    ["BracketLeft", 0x5b],
    ["Backslash", 0x5c],
    ["Semicolon", 0x3b],
    ["Quote", 0x27],
    ["Backquote", 0x60],
    ["Comma", 0x2c],
    ["Period", 0x2e],
    ["Slash", 0x2f],
    ["ArrowLeft", XK.Left],
    ["ArrowUp", XK.Up],
    ["ShiftLeft", XK.Shift_L],
    ["ControlLeft", XK.Control_L],
    ["AltLeft", XK.Alt_L],
    ["MetaLeft", XK.Super_L],
    ["MetaRight", XK.Super_R],
  ];
  for (const [code, keysym] of cases) {
    const usage = hidUsageForCode(code);
    assert.ok(usage !== null, code);
    assert.equal(keysymForHidUsage(usage), keysym, code);
  }
});

test("function keys and unknown usages", () => {
  assert.equal(keysymForHidUsage(0x3a), 0xffbe, "F1");
  assert.equal(keysymForHidUsage(0x45), 0xffc9, "F12");
  assert.equal(keysymForHidUsage(0x68), 0xffca, "F13");
  assert.equal(keysymForHidUsage(0x00), undefined);
  assert.equal(keysymForHidUsage(0x46), undefined, "Print Screen has no use in a Mac guest");
  assert.equal(keysymForHidUsage(1.5), undefined);
});

test("typing holds Shift for capitals and shifted symbols, pressing the unshifted US key", () => {
  assert.deepEqual(textKeyStrokes("aB!"), [
    down(0x61),
    up(0x61),
    down(XK.Shift_L),
    down(0x62),
    up(0x62),
    up(XK.Shift_L),
    down(XK.Shift_L),
    down(0x31),
    up(0x31),
    up(XK.Shift_L),
  ]);
  assert.deepEqual(characterKey("?"), { keysym: 0x2f, shift: true });
  assert.deepEqual(characterKey("~"), { keysym: 0x60, shift: true });
  assert.deepEqual(characterKey(" "), { keysym: 0x20, shift: false });
});

test("line breaks and tabs are keys, other characters are Unicode keysyms, and control characters are refused", () => {
  assert.deepEqual(characterKey("\n"), { keysym: XK.Return, shift: false });
  assert.deepEqual(characterKey("\t"), { keysym: XK.Tab, shift: false });
  assert.deepEqual(characterKey("é"), { keysym: 0x0100_00e9, shift: false });
  assert.deepEqual(characterKey("😀"), { keysym: 0x0101_f600, shift: false });
  assert.throws(() => characterKey("\u0007"), RangeError);
  assert.throws(() => characterKey("ab"), RangeError);
});

test("a chord presses modifiers in order, the key, then releases in reverse", () => {
  assert.deepEqual(chordKeyStrokes("cmd+shift+t"), [down(XK.Shift_L), down(XK.Super_L), down(0x74), up(0x74), up(XK.Super_L), up(XK.Shift_L)]);
  assert.deepEqual(chordKeyStrokes("Return"), [down(XK.Return), up(XK.Return)]);
  assert.deepEqual(chordKeyStrokes("option+left"), [down(XK.Alt_L), down(XK.Left), up(XK.Left), up(XK.Alt_L)]);
  assert.deepEqual(chordKeyStrokes("f5"), [down(0xffc2), up(0xffc2)]);
});

test("a chord on a shifted symbol adds Shift once", () => {
  assert.deepEqual(chordKeyStrokes("cmd+?"), [down(XK.Super_L), down(XK.Shift_L), down(0x2f), up(0x2f), up(XK.Shift_L), up(XK.Super_L)]);
  assert.deepEqual(chordKeyStrokes("shift+?"), [down(XK.Shift_L), down(0x2f), up(0x2f), up(XK.Shift_L)]);
});

test("Computer Use's blocked shortcuts, fn and unknown keys are refused", () => {
  assert.throws(() => chordKeyStrokes("cmd+q"), /blocked/u);
  assert.throws(() => chordKeyStrokes("cmd+option+backspace"), /blocked/u);
  assert.throws(() => chordKeyStrokes("fn+f1"), /can't be sent/u);
  assert.throws(() => chordKeyStrokes("cmd+warp"), /Unknown key/u);
  assert.throws(() => chordKeyStrokes(""), /non-empty/u);
});

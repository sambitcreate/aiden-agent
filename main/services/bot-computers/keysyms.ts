/**
 * X11 keysyms for a Bot computer's VNC session.
 *
 * Apple's VNC servers map keysyms to physical keys, so input here models a
 * US keyboard by position: a shifted character is Shift plus the unshifted
 * key ('A' is Shift + 'a', '!' is Shift + '1'), never a bare upper-case
 * keysym the server might not shift. Characters a US keyboard has no key for
 * are sent as Unicode keysyms (0x01000000 + code point), which a server may
 * ignore.
 *
 * - The person's keys arrive from the viewer as USB HID usages (the device
 *   stream client's encoding) and become keysyms with `keysymForHidUsage`.
 * - The Bot's `key` chords go through `parseComputerUseKeyChord`, so the
 *   chord grammar and its blocked shortcuts match Computer Use.
 */

import { parseComputerUseKeyChord } from "../computer-use/safety.js";

export const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  F1: 0xffbe,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Caps_Lock: 0xffe5,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  /** The Mac's Command key. */
  Super_L: 0xffeb,
  Super_R: 0xffec,
  space: 0x20,
} as const;

/** The unshifted key under each US shifted character. */
const SHIFTED: Readonly<Record<string, string>> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

/** HID usages (keyboard page) with no printable character, and the modifiers. */
const HID_NAMED: Readonly<Record<number, number>> = {
  0x28: XK.Return,
  0x29: XK.Escape,
  0x2a: XK.BackSpace,
  0x2b: XK.Tab,
  0x2c: XK.space,
  0x39: XK.Caps_Lock,
  0x49: XK.Insert,
  0x4a: XK.Home,
  0x4b: XK.Page_Up,
  0x4c: XK.Delete,
  0x4d: XK.End,
  0x4e: XK.Page_Down,
  0x4f: XK.Right,
  0x50: XK.Left,
  0x51: XK.Down,
  0x52: XK.Up,
  0xe0: XK.Control_L,
  0xe1: XK.Shift_L,
  0xe2: XK.Alt_L,
  0xe3: XK.Super_L,
  0xe4: XK.Control_R,
  0xe5: XK.Shift_R,
  0xe6: XK.Alt_R,
  0xe7: XK.Super_R,
};

/** HID usages for the US punctuation keys, by their unshifted character. */
const HID_PUNCTUATION: Readonly<Record<number, string>> = {
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
};

/** The keysym for a USB HID keyboard usage, or undefined for a key a Mac guest has no use for. */
export function keysymForHidUsage(usage: number): number | undefined {
  if (!Number.isInteger(usage)) return undefined;
  if (usage >= 0x04 && usage <= 0x1d) return 0x61 + (usage - 0x04);
  if (usage >= 0x1e && usage <= 0x26) return 0x31 + (usage - 0x1e);
  if (usage === 0x27) return 0x30;
  if (usage >= 0x3a && usage <= 0x45) return XK.F1 + (usage - 0x3a);
  if (usage >= 0x68 && usage <= 0x73) return XK.F1 + 12 + (usage - 0x68);
  const named = HID_NAMED[usage];
  if (named !== undefined) return named;
  const punctuation = HID_PUNCTUATION[usage];
  return punctuation === undefined ? undefined : punctuation.charCodeAt(0);
}

/** Every modifier keysym, so callers can tell a modifier from a key. */
export const MODIFIER_KEYSYMS: ReadonlySet<number> = new Set([
  XK.Shift_L,
  XK.Shift_R,
  XK.Control_L,
  XK.Control_R,
  XK.Alt_L,
  XK.Alt_R,
  XK.Super_L,
  XK.Super_R,
  XK.Caps_Lock,
]);

const CHORD_MODIFIERS: Readonly<Record<string, number>> = {
  ctrl: XK.Control_L,
  option: XK.Alt_L,
  shift: XK.Shift_L,
  cmd: XK.Super_L,
  win: XK.Super_L,
};

/** Key names `parseComputerUseKeyChord` passes through, and their aliases. */
const KEY_NAMES: Readonly<Record<string, number>> = {
  return: XK.Return,
  enter: XK.Return,
  tab: XK.Tab,
  escape: XK.Escape,
  esc: XK.Escape,
  space: XK.space,
  spacebar: XK.space,
  backspace: XK.BackSpace,
  delete: XK.BackSpace,
  forwarddelete: XK.Delete,
  del: XK.Delete,
  home: XK.Home,
  end: XK.End,
  pageup: XK.Page_Up,
  page_up: XK.Page_Up,
  pagedown: XK.Page_Down,
  page_down: XK.Page_Down,
  left: XK.Left,
  arrowleft: XK.Left,
  right: XK.Right,
  arrowright: XK.Right,
  up: XK.Up,
  arrowup: XK.Up,
  down: XK.Down,
  arrowdown: XK.Down,
  insert: XK.Insert,
  capslock: XK.Caps_Lock,
  plus: 0x3d,
  minus: 0x2d,
};

export interface KeyStroke {
  keysym: number;
  down: boolean;
}

/** One character as a US key and whether Shift is held for it. */
export function characterKey(character: string): { keysym: number; shift: boolean } {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || [...character].length !== 1) throw new RangeError("Pass exactly one character.");
  if (character === "\n" || character === "\r") return { keysym: XK.Return, shift: false };
  if (character === "\t") return { keysym: XK.Tab, shift: false };
  if (character >= "A" && character <= "Z") return { keysym: character.toLowerCase().charCodeAt(0), shift: true };
  const base = SHIFTED[character];
  if (base !== undefined) return { keysym: base.charCodeAt(0), shift: true };
  if (codePoint >= 0x20 && codePoint <= 0x7e) return { keysym: codePoint, shift: false };
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) throw new RangeError("Control characters can't be typed.");
  return { keysym: 0x0100_0000 + codePoint, shift: false };
}

/**
 * Presses and releases for typing `text`: each character down then up,
 * with Shift held around shifted ones. Line breaks become Return and tabs
 * Tab, so callers that must not submit forms refuse them first.
 */
export function textKeyStrokes(text: string): KeyStroke[] {
  const strokes: KeyStroke[] = [];
  for (const character of text) {
    const { keysym, shift } = characterKey(character);
    if (shift) strokes.push({ keysym: XK.Shift_L, down: true });
    strokes.push({ keysym, down: true }, { keysym, down: false });
    if (shift) strokes.push({ keysym: XK.Shift_L, down: false });
  }
  return strokes;
}

function keyNameKeysym(name: string): { keysym: number; shift: boolean } {
  const named = KEY_NAMES[name];
  if (named !== undefined) return { keysym: named, shift: false };
  const fn = /^f([1-9]|1[0-9]|20)$/u.exec(name);
  if (fn) return { keysym: XK.F1 + Number(fn[1]) - 1, shift: false };
  if ([...name].length === 1) return characterKey(name);
  throw new RangeError(`Unknown key: ${name}.`);
}

/**
 * Presses and releases for a chord such as `cmd+shift+t` or `return`:
 * modifiers down in order, the key down and up, modifiers up in reverse.
 * The grammar and the blocked destructive shortcuts are Computer Use's;
 * `fn` has no VNC keysym and is refused.
 */
export function chordKeyStrokes(chord: string): KeyStroke[] {
  const parsed = parseComputerUseKeyChord(chord);
  const modifiers = parsed.modifiers.map((modifier) => {
    const keysym = CHORD_MODIFIERS[modifier];
    if (keysym === undefined) throw new RangeError(`The ${modifier} key can't be sent to a Bot computer.`);
    return keysym;
  });
  const key = keyNameKeysym(parsed.key);
  if (key.shift && !modifiers.includes(XK.Shift_L)) modifiers.push(XK.Shift_L);
  const held = [...new Set(modifiers)];
  return [
    ...held.map((keysym) => ({ keysym, down: true })),
    { keysym: key.keysym, down: true },
    { keysym: key.keysym, down: false },
    ...[...held].reverse().map((keysym) => ({ keysym, down: false })),
  ];
}

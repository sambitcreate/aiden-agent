/**
 * The Bot's `type` text and `key` chords as VNC key events.
 *
 * Apple's VNC servers map keysyms to physical keys, so text is typed as a US
 * keyboard would: a shifted character is Shift plus its unshifted key ('A' is
 * Shift + 'a', '!' is Shift + '1'). A character a US keyboard has no key for
 * is sent as its Unicode keysym (0x01000000 + code point). Chords use
 * `parseComputerUseKeyChord`, so the grammar and the blocked destructive
 * shortcuts are Computer Use's. Command is Super, Option is Alt.
 */

import { parseComputerUseKeyChord } from "../computer-use/safety.js";

export interface BotComputerKeyStroke {
  keysym: number;
  down: boolean;
}

const XK_SHIFT = 0xffe1;
const XK_CONTROL = 0xffe3;
const XK_ALT = 0xffe9;
const XK_SUPER = 0xffeb;
const XK_F1 = 0xffbe;

const MODIFIER_KEYSYMS: Readonly<Record<string, number>> = {
  ctrl: XK_CONTROL,
  option: XK_ALT,
  shift: XK_SHIFT,
  cmd: XK_SUPER,
  win: XK_SUPER,
};

const NAMED_KEYS: Readonly<Record<string, number>> = {
  return: 0xff0d,
  enter: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  space: 0x20,
  spacebar: 0x20,
  backspace: 0xff08,
  delete: 0xff08,
  forwarddelete: 0xffff,
  del: 0xffff,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  page_up: 0xff55,
  pagedown: 0xff56,
  page_down: 0xff56,
  left: 0xff51,
  arrowleft: 0xff51,
  up: 0xff52,
  arrowup: 0xff52,
  right: 0xff53,
  arrowright: 0xff53,
  down: 0xff54,
  arrowdown: 0xff54,
  plus: 0x3d,
  minus: 0x2d,
};

/** US-keyboard shifted characters and the key they are on. */
const SHIFTED_ON: Readonly<Record<string, string>> = {
  "~": "`",
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
};

export class BotComputerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotComputerKeyError";
  }
}

/** One character as a key and whether Shift is held for it. */
function characterKey(character: string): { keysym: number; shift: boolean } {
  const codePoint = character.codePointAt(0)!;
  if (character >= "A" && character <= "Z") return { keysym: character.toLowerCase().charCodeAt(0), shift: true };
  const base = SHIFTED_ON[character];
  if (base !== undefined) return { keysym: base.charCodeAt(0), shift: true };
  if (codePoint >= 0x20 && codePoint <= 0x7e) return { keysym: codePoint, shift: false };
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    throw new BotComputerKeyError("Control characters can't be typed; send Return or Tab with key.");
  }
  return { keysym: 0x0100_0000 + codePoint, shift: false };
}

/** Each character down then up, with Shift held around shifted ones. Refuses line breaks and tabs. */
export function botComputerTextStrokes(text: string): BotComputerKeyStroke[] {
  if (/[\n\r\t]/u.test(text)) {
    throw new BotComputerKeyError("Typed text can't contain line breaks or tabs: type each line, then send Return or Tab with key.");
  }
  const strokes: BotComputerKeyStroke[] = [];
  for (const character of text) {
    const { keysym, shift } = characterKey(character);
    if (shift) strokes.push({ keysym: XK_SHIFT, down: true });
    strokes.push({ keysym, down: true }, { keysym, down: false });
    if (shift) strokes.push({ keysym: XK_SHIFT, down: false });
  }
  return strokes;
}

function keyOf(name: string): { keysym: number; shift: boolean } {
  const named = NAMED_KEYS[name];
  if (named !== undefined) return { keysym: named, shift: false };
  const fn = /^f([1-9]|1[0-9]|20)$/u.exec(name);
  if (fn) return { keysym: XK_F1 + Number(fn[1]) - 1, shift: false };
  if ([...name].length === 1) return characterKey(name);
  throw new BotComputerKeyError(`Unknown key: ${name}.`);
}

const MODIFIER_ALIASES: Readonly<Record<string, string>> = { command: "cmd", control: "ctrl", alt: "option" };
const MODIFIER_ORDER = ["ctrl", "option", "shift", "cmd"];

/** Keysyms to hold for a click or drag's modifiers, in a fixed order. */
export function botComputerModifierKeysyms(modifiers: readonly string[] | undefined): number[] {
  if (!modifiers || modifiers.length === 0) return [];
  const names = [...new Set(modifiers.map((raw) => MODIFIER_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase()))];
  names.sort((left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right));
  return names.map(modifierKeysym);
}

function modifierKeysym(modifier: string): number {
  const keysym = MODIFIER_KEYSYMS[modifier];
  if (keysym === undefined) throw new BotComputerKeyError(`The ${modifier} key can't be sent to a Bot computer.`);
  return keysym;
}

/**
 * A chord such as `cmd+shift+t` or `return`: modifiers down in order, the
 * key down and up, then the modifiers up in reverse.
 */
export function botComputerChordStrokes(chord: string): BotComputerKeyStroke[] {
  let parsed: { key: string; modifiers: string[] };
  try {
    parsed = parseComputerUseKeyChord(chord);
  } catch (error) {
    throw new BotComputerKeyError(error instanceof Error ? error.message : "That key chord isn't valid.");
  }
  const held = parsed.modifiers.map(modifierKeysym);
  const key = keyOf(parsed.key);
  if (key.shift && !held.includes(XK_SHIFT)) held.push(XK_SHIFT);
  const unique = [...new Set(held)];
  return [
    ...unique.map((keysym) => ({ keysym, down: true })),
    { keysym: key.keysym, down: true },
    { keysym: key.keysym, down: false },
    ...[...unique].reverse().map((keysym) => ({ keysym, down: false })),
  ];
}

/** Whether a chord types a character (no modifier but Shift), for the rules classifier. */
export function botComputerChordIsPrintable(chord: string): boolean {
  try {
    const parsed = parseComputerUseKeyChord(chord);
    return [...parsed.key].length === 1 && parsed.modifiers.every((modifier) => modifier === "shift");
  } catch {
    return false;
  }
}

/**
 * The Bot's `type` text and `key` chords as VNC key events, on the same US
 * keyboard model as the viewer (`keysyms.ts`): a shifted character is Shift
 * plus its unshifted key, a character a US keyboard has no key for is its
 * Unicode keysym, and chords use `parseComputerUseKeyChord`, so the grammar
 * and the blocked destructive shortcuts are Computer Use's. Command is Super,
 * Option is Alt. What goes wrong is a `BotComputerKeyError` the model reads.
 */

import { parseComputerUseKeyChord } from "../computer-use/safety.js";
import { chordKeyStrokes, textKeyStrokes, XK, type KeyStroke } from "./keysyms.js";

export type BotComputerKeyStroke = KeyStroke;

const MODIFIER_KEYSYMS: Readonly<Record<string, number>> = {
  ctrl: XK.Control_L,
  option: XK.Alt_L,
  shift: XK.Shift_L,
  cmd: XK.Super_L,
  win: XK.Super_L,
};

export class BotComputerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotComputerKeyError";
  }
}

const CONTROL_CHARACTER = "Control characters can't be typed; send Return or Tab with key.";

function asKeyError(error: unknown, fallback: string): BotComputerKeyError {
  if (error instanceof RangeError && error.message.startsWith("Control characters")) return new BotComputerKeyError(CONTROL_CHARACTER);
  return new BotComputerKeyError(error instanceof Error ? error.message : fallback);
}

/** Each character down then up, with Shift held around shifted ones. Refuses line breaks and tabs. */
export function botComputerTextStrokes(text: string): BotComputerKeyStroke[] {
  // The viewer's model types them as Return and Tab, which could submit a form the Bot meant only to fill.
  if (/[\n\r\t]/u.test(text)) {
    throw new BotComputerKeyError("Typed text can't contain line breaks or tabs: type each line, then send Return or Tab with key.");
  }
  try {
    return textKeyStrokes(text);
  } catch (error) {
    throw asKeyError(error, "That text can't be typed.");
  }
}

const MODIFIER_ALIASES: Readonly<Record<string, string>> = { command: "cmd", control: "ctrl", alt: "option" };
const MODIFIER_ORDER = ["ctrl", "option", "shift", "cmd"];

/** Keysyms to hold for a click or drag's modifiers, in a fixed order. */
export function botComputerModifierKeysyms(modifiers: readonly string[] | undefined): number[] {
  if (!modifiers || modifiers.length === 0) return [];
  const names = [...new Set(modifiers.map((raw) => MODIFIER_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase()))];
  names.sort((left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right));
  return names.map((modifier) => {
    const keysym = MODIFIER_KEYSYMS[modifier];
    if (keysym === undefined) throw new BotComputerKeyError(`The ${modifier} key can't be sent to a Bot computer.`);
    return keysym;
  });
}

/**
 * A chord such as `cmd+shift+t` or `return`: modifiers down in order, the
 * key down and up, then the modifiers up in reverse.
 */
export function botComputerChordStrokes(chord: string): BotComputerKeyStroke[] {
  try {
    return chordKeyStrokes(chord);
  } catch (error) {
    throw asKeyError(error, "That key chord isn't valid.");
  }
}

/** The keys that erase a character at the caret: Backspace (Delete on a Mac) and forward Delete. */
const ERASE_KEYS = new Set(["backspace", "delete", "del", "forwarddelete"]);

/** What a chord with no modifier but Shift does at the caret: types a character, erases one, or neither. */
function caretEdit(chord: string): "types" | "erases" | undefined {
  try {
    const parsed = parseComputerUseKeyChord(chord);
    if (!parsed.modifiers.every((modifier) => modifier === "shift")) return undefined;
    if ([...parsed.key].length === 1) return "types";
    return ERASE_KEYS.has(parsed.key) ? "erases" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a chord only edits text at the caret, with no modifier but Shift:
 * it types a character, or erases one with Backspace or Delete. Any other
 * chord presses something (Return sends; with Command, Delete is Finder's
 * Move to Trash). For keeping the focused field, and with
 * `botComputerChordErases` for the rules classifier.
 */
export function botComputerChordEditsText(chord: string): boolean {
  return caretEdit(chord) !== undefined;
}

/**
 * Whether a chord is a plain Backspace or Delete (Shift aside). In a text
 * field it erases a character; anywhere else it can delete what is selected,
 * such as a message in Mail or an event in Calendar.
 */
export function botComputerChordErases(chord: string): boolean {
  return caretEdit(chord) === "erases";
}

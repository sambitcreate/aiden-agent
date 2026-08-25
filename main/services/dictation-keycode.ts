// macOS virtual key codes for the non-modifier key of an Electron accelerator.
// Used to watch hold-to-talk release without a second global shortcut.

const LETTER_CODES: Record<string, number> = {
  a: 0x00,
  s: 0x01,
  d: 0x02,
  f: 0x03,
  h: 0x04,
  g: 0x05,
  z: 0x06,
  x: 0x07,
  c: 0x08,
  v: 0x09,
  b: 0x0b,
  q: 0x0c,
  w: 0x0d,
  e: 0x0e,
  r: 0x0f,
  y: 0x10,
  t: 0x11,
  o: 0x1f,
  u: 0x20,
  i: 0x22,
  p: 0x23,
  l: 0x25,
  j: 0x26,
  k: 0x28,
  n: 0x2d,
  m: 0x2e,
};

const DIGIT_CODES: Record<string, number> = {
  "1": 0x12,
  "2": 0x13,
  "3": 0x14,
  "4": 0x15,
  "5": 0x17,
  "6": 0x16,
  "7": 0x1a,
  "8": 0x1c,
  "9": 0x19,
  "0": 0x1d,
};

const NAMED_CODES: Record<string, number> = {
  space: 0x31,
  return: 0x24,
  enter: 0x24,
  tab: 0x30,
  escape: 0x35,
};

const MODIFIERS = new Set([
  "command",
  "cmd",
  "meta",
  "control",
  "ctrl",
  "option",
  "alt",
  "altgr",
  "shift",
  "super",
]);

/** Primary (non-modifier) macOS key code for an Electron accelerator, or null. */
export function acceleratorPrimaryMacKeyCode(
  accelerator: string | null | undefined,
): number | null {
  if (!accelerator) return null;
  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = parts.filter((part) => !MODIFIERS.has(part.toLowerCase())).pop();
  if (!key) return null;
  const named = NAMED_CODES[key.toLowerCase()];
  if (named !== undefined) return named;
  if (key.length === 1) {
    const letter = LETTER_CODES[key.toLowerCase()];
    if (letter !== undefined) return letter;
    const digit = DIGIT_CODES[key];
    if (digit !== undefined) return digit;
  }
  return null;
}

// Track complete modifier chords so holding ⌘ (or a customized equivalent)
// can reveal shortcut badges without flashing them during a quick chord.

export interface HeldModifierEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function namedModifierKey(key: string): "Meta" | "Control" | "Alt" | "Shift" | null {
  if (key === "Meta" || key === "OS") return "Meta";
  if (key === "Control") return "Control";
  if (key === "Alt") return "Alt";
  if (key === "Shift") return "Shift";
  return null;
}

export function trackedModifiersFromSets(modifierSets: readonly string[][]): Set<string> {
  return new Set(modifierSets.flat());
}

export function completeHeldModifierSet(
  held: ReadonlySet<string>,
  requiredSets: readonly string[][],
): boolean {
  return requiredSets.some(
    (required) => required.length > 0 && required.every((modifier) => held.has(modifier)),
  );
}

export function heldModifiersAfterKeydown(
  held: ReadonlySet<string>,
  event: HeldModifierEvent,
  tracked: ReadonlySet<string>,
): Set<string> {
  const next = new Set(held);
  const named = namedModifierKey(event.key);
  if (named && tracked.has(named)) next.add(named);
  if (event.metaKey && tracked.has("Meta")) next.add("Meta");
  if (event.ctrlKey && tracked.has("Control")) next.add("Control");
  if (event.altKey && tracked.has("Alt")) next.add("Alt");
  if (event.shiftKey && tracked.has("Shift")) next.add("Shift");
  return next;
}

export function heldModifiersAfterKeyup(
  held: ReadonlySet<string>,
  event: HeldModifierEvent,
  tracked: ReadonlySet<string>,
): Set<string> {
  const next = new Set(held);
  const named = namedModifierKey(event.key);
  if (named) next.delete(named);
  if (!event.metaKey) next.delete("Meta");
  if (!event.ctrlKey) next.delete("Control");
  if (!event.altKey) next.delete("Alt");
  if (!event.shiftKey) next.delete("Shift");
  for (const modifier of [...next]) {
    if (!tracked.has(modifier)) next.delete(modifier);
  }
  return next;
}

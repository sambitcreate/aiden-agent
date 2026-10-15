/**
 * Hidden helper windows (the visual snapshot renderer) that must never be
 * treated as an application window: not focused for the user, not chosen as a
 * target for app UI, and never shown.
 */
const auxiliary = new WeakSet<object>();

export function markAuxiliaryWindow(window: object): void {
  auxiliary.add(window);
}

export function isAuxiliaryWindow(window: object): boolean {
  return auxiliary.has(window);
}

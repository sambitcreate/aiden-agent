/**
 * Helper windows (the hidden visual snapshot renderer and the dictation pill)
 * that must never be treated as an application window: not focused for the
 * user, not chosen as a target for app UI, and never the reason the app stays
 * open after its last real window closes. The pill is shown, but only as an
 * unfocusable overlay while dictation runs.
 */
const auxiliary = new WeakSet<object>();

export function markAuxiliaryWindow(window: object): void {
  auxiliary.add(window);
}

export function isAuxiliaryWindow(window: object): boolean {
  return auxiliary.has(window);
}

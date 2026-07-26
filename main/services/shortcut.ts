// Global shortcut manager. Registers three configurable hotkeys:
//  • focus     (default ⌘⌥Space) — brings the app forward and focuses the composer
//  • dictate   (default ⌘⇧D)     — toggles global dictation into the focused app
//    (floating pill + auto-paste, clipboard fallback)
//  • assistant (default ⌘⌥A)     — opens the Aiden panel docked in the main window

import { globalShortcut, logger } from "../platform.js";
import { configStore } from "./config-store.js";

export const DEFAULT_ACCELERATOR = "Command+Alt+Space";
export const DEFAULT_DICTATION_ACCELERATOR = "Command+Shift+D";
export const DEFAULT_ASSISTANT_ACCELERATOR = "Command+Alt+A";

let onTrigger: (() => void) | null = null;
let onDictate: (() => void) | null = null;
let onAssistant: (() => void) | null = null;
let registered: string | null = null;
let registeredDictation: string | null = null;
let registeredAssistant: string | null = null;

/** Called once at startup with the callback that focuses the app + composer. */
export function initShortcut(trigger: () => void): void {
  onTrigger = trigger;
}

/** Called once at startup with the callback that toggles on-device dictation. */
export function initDictationShortcut(trigger: () => void): void {
  onDictate = trigger;
}

/** Called once at startup with the callback that opens the Aiden window. */
export function initAssistantShortcut(trigger: () => void): void {
  onAssistant = trigger;
}

async function register(accelerator: string, handler: () => void): Promise<boolean> {
  try {
    const ok = await globalShortcut.register(accelerator, handler);
    if (!ok)
      logger.warn("shortcut", `Could not register "${accelerator}" (in use by another app?).`);
    return ok;
  } catch (error) {
    logger.warn(
      "shortcut",
      `Failed to register "${accelerator}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** (Re)register all three shortcuts from current settings. */
export async function applyShortcutFromSettings(): Promise<void> {
  const settings = await configStore.getSettings();

  // Release every accelerator before claiming any. Unregistering lazily, one
  // section at a time, means a shortcut later in this function still holds the
  // accelerator an earlier one is trying to claim, so rebinding focus onto the
  // assistant's key silently fails and the assistant keeps it.
  for (const accelerator of [registered, registeredDictation, registeredAssistant]) {
    if (accelerator) globalShortcut.unregister(accelerator);
  }
  registered = null;
  registeredDictation = null;
  registeredAssistant = null;

  // ── Focus shortcut ──────────────────────────────────────────────────
  const focusEnabled = settings.shortcutEnabled ?? true;
  const focusAccel = settings.shortcutAccelerator || DEFAULT_ACCELERATOR;
  if (focusEnabled && onTrigger) {
    if (await register(focusAccel, onTrigger)) registered = focusAccel;
  }

  // ── Dictation shortcut ──────────────────────────────────────────────
  const dictationEnabled = settings.dictationEnabled ?? false;
  const dictationAccel = settings.dictationAccelerator || DEFAULT_DICTATION_ACCELERATOR;
  // Skip if it collides with the (already-registered) focus shortcut.
  if (dictationEnabled && onDictate && dictationAccel !== registered) {
    if (await register(dictationAccel, onDictate)) registeredDictation = dictationAccel;
  }

  // ── Assistant shortcut ──────────────────────────────────────────────
  const assistantEnabled = settings.assistant?.hotkeyEnabled !== false;
  const assistantAccel = settings.assistant?.hotkeyAccelerator || DEFAULT_ASSISTANT_ACCELERATOR;
  // Skip collisions with the (already-registered) focus and dictation shortcuts.
  if (
    assistantEnabled &&
    onAssistant &&
    assistantAccel !== registered &&
    assistantAccel !== registeredDictation
  ) {
    if (await register(assistantAccel, onAssistant)) registeredAssistant = assistantAccel;
  }
}

export function disposeShortcut(): void {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }
  registered = null;
  registeredDictation = null;
  registeredAssistant = null;
}

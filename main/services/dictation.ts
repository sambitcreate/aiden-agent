// Global dictation coordinator. Serialized state machine (mirrors handy's
// TranscriptionCoordinator) driven by the dictation hotkey: idle → recording →
// transcribing → idle. The pill window records and transcribes; this module
// owns the lifecycle, the paste/clipboard handoff, and pill visibility.

import { clipboard, ipcMain, logger, systemPreferences } from "../platform.js";
import { destroyPill, hidePill, showPill } from "../windows/pill-window.js";
import { pasteTranscript, runAtomicMacPaste, type PasteDeps } from "./dictation-paste.js";
import { DictationCoordinator } from "./dictation-coordinator.js";
// Only nag with the Accessibility prompt once per session; after that the
// clipboard fallback applies silently until the user grants access.
let accessibilityPrompted = false;

function livePasteDeps(): PasteDeps {
  return {
    writeClipboard: (text) => clipboard.writeText(text),
    isAccessibilityTrusted: (prompt) => {
      const effectivePrompt = prompt && !accessibilityPrompted;
      if (effectivePrompt) accessibilityPrompted = true;
      return systemPreferences.isTrustedAccessibilityClient(effectivePrompt);
    },
    pasteWithPreservedClipboard: runAtomicMacPaste,
    log: (message, error) => logger.warn("dictation", message, error),
  };
}

const coordinator = new DictationCoordinator({
  showPill,
  hidePill,
  destroyPill,
  broadcast: (payload) => ipcMain.broadcast("dictation:state", payload),
  paste: (text) => pasteTranscript(text, livePasteDeps()),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  logError: (message, error) => logger.error("dictation", message, error),
});

/** Hotkey callback (fire-and-forget). */
export function toggleDictation(): void {
  void coordinator.toggle();
}

/** Pill finished transcribing. */
export async function handleDictationResult(text: unknown): Promise<void> {
  await coordinator.result(text);
}

/** Pill reports a capture/transcription failure. */
export async function handleDictationError(message: unknown): Promise<void> {
  await coordinator.error(message);
}

/** Pill cancel button. */
export async function cancelDictation(): Promise<void> {
  await coordinator.cancel();
}

/**
 * The pill renderer signals it has subscribed to state broadcasts. When a
 * freshly created pill missed the initial "recording" broadcast, replay it.
 */
export async function handlePillReady(): Promise<void> {
  await coordinator.ready();
}

/** App shutdown: tear down the pill window. */
export function disposeDictation(): void {
  coordinator.dispose();
}

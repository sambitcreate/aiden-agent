// Global dictation coordinator. Serialized state machine driven by the
// dictation hotkey: idle → recording → transcribing → idle. The pill window
// records and transcribes; this module owns the lifecycle, the paste/clipboard
// handoff, and pill visibility.

import { clipboard, ipcMain, logger, systemPreferences } from "../platform.js";
import { destroyPill, hidePill, showPill } from "../windows/pill-window.js";
import { effectiveBindings } from "../../renderer/shared/keybindings.js";
import { configStore } from "./config-store.js";
import { cleanupDictationTranscript } from "./dictation-cleanup.js";
import { shouldAcceptDictationPress } from "./dictation-hotkey.js";
import { watchMacKeyUntilUp } from "./dictation-key-state.js";
import { acceleratorPrimaryMacKeyCode } from "./dictation-keycode.js";
import { pasteTranscript, runAtomicMacPaste, type PasteDeps } from "./dictation-paste.js";
import { DictationCoordinator } from "./dictation-coordinator.js";

let accessibilityPrompted = false;
let lastPressAt = 0;

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
  isHoldToTalk: async () => (await configStore.getSettings()).dictationHoldToTalk === true,
  shouldCleanup: async () => (await configStore.getSettings()).dictationCleanup === true,
  cleanupTranscript: cleanupDictationTranscript,
  getHoldKeyCode: async () => {
    const settings = await configStore.getSettings();
    const binding = effectiveBindings(settings.keybindings, settings)["dictation.toggle"];
    return acceleratorPrimaryMacKeyCode(binding);
  },
  startHoldWatch: (keyCode, onRelease) => watchMacKeyUntilUp(keyCode, onRelease),
});

/** Hotkey callback (fire-and-forget). Debounced against OS key chatter. */
export function toggleDictation(): void {
  const now = Date.now();
  if (!shouldAcceptDictationPress(lastPressAt, now)) return;
  lastPressAt = now;
  void coordinator.press();
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

/** Silence detector asked to end capture. */
export async function stopDictationRecording(): Promise<void> {
  await coordinator.stopRecording();
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

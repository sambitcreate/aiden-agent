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
import { dictationPlatformBehavior } from "./dictation-platform.js";
import { pasteTranscript, runAtomicMacPaste, type PasteDeps } from "./dictation-paste.js";
import { DictationCoordinator } from "./dictation-coordinator.js";

let lastPressAt = 0;

function livePasteDeps(): PasteDeps {
  const behavior = dictationPlatformBehavior();
  return {
    writeClipboard: (text) => clipboard.writeText(text),
    // Delivery must never steal focus with a native permission prompt. Users
    // grant paste access explicitly from Settings; otherwise we copy safely.
    isAccessibilityTrusted: () =>
      behavior.accessibilityPaste &&
      systemPreferences.isTrustedAccessibilityClient(false),
    pasteWithPreservedClipboard: behavior.accessibilityPaste
      ? runAtomicMacPaste
      : async () => false,
    log: (message, error) => logger.warn("dictation", message, error),
  };
}

async function deliverTranscript(text: string) {
  if (!dictationPlatformBehavior().accessibilityPaste) {
    clipboard.writeText(text);
    return {
      outcome: "copied" as const,
      reason: "paste-unavailable" as const,
      message: "Copied — automatic paste is not available on this system.",
    };
  }
  return pasteTranscript(text, livePasteDeps());
}

const coordinator = new DictationCoordinator({
  showPill,
  hidePill,
  destroyPill,
  broadcast: (payload) => ipcMain.broadcast("dictation:state", payload),
  paste: deliverTranscript,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  logError: (message, error) => logger.error("dictation", message, error),
  isHoldToTalk: async () =>
    dictationPlatformBehavior().holdToTalk &&
    (await configStore.getSettings()).dictationHoldToTalk === true,
  shouldCleanup: async () => (await configStore.getSettings()).dictationCleanup === true,
  cleanupTranscript: cleanupDictationTranscript,
  getHoldKeyCode: async () => {
    if (!dictationPlatformBehavior().holdToTalk) return null;
    const settings = await configStore.getSettings();
    const binding = effectiveBindings(settings.keybindings, settings)["dictation.toggle"];
    return acceleratorPrimaryMacKeyCode(binding);
  },
  startHoldWatch: (keyCode, onRelease, onFailed) =>
    dictationPlatformBehavior().holdToTalk
      ? watchMacKeyUntilUp(keyCode, onRelease, { onFailed })
      : null,
});

/** Hotkey callback (fire-and-forget). Debounced against OS key chatter. */
export function toggleDictation(): void {
  const now = Date.now();
  if (!shouldAcceptDictationPress(lastPressAt, now)) return;
  lastPressAt = now;
  void coordinator.press();
}

/** Pill finished transcribing. */
export async function handleDictationResult(text: unknown, operationId: unknown): Promise<void> {
  await coordinator.result(text, operationId);
}

/** Pill reports a capture/transcription failure. */
export async function handleDictationError(message: unknown, operationId: unknown): Promise<void> {
  await coordinator.error(message, operationId);
}

/** Pill reports a non-terminal transcription phase. */
export async function handleDictationProgress(
  progress: unknown,
  operationId: unknown,
): Promise<void> {
  await coordinator.progress(progress, operationId);
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

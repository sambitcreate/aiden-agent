// Global dictation coordinator. Serialized state machine driven by the
// dictation hotkey: idle → recording → transcribing → idle. The pill window
// records and transcribes; this module owns the lifecycle, the paste/clipboard
// handoff, and pill visibility.

import { clipboard, ipcMain, logger, systemPreferences } from "../platform.js";
import { destroyPill, hidePill, preparePill, showPill } from "../windows/pill-window.js";
import { effectiveBindings } from "../../renderer/shared/keybindings.js";
import { configStore } from "./config-store.js";
import { cleanupDictationTranscript } from "./dictation-cleanup.js";
import { shouldAcceptDictationPress } from "./dictation-hotkey.js";
import { watchMacKeyUntilUp } from "./dictation-key-state.js";
import { acceleratorPrimaryMacKeyCode } from "./dictation-keycode.js";
import { dictationPlatformBehavior } from "./dictation-platform.js";
import {
  confirmMacPasteDelivered,
  createSecureInputPrefetch,
  detectMacSecureInput,
  pasteTranscript,
  runAtomicMacPaste,
  type PasteDeps,
} from "./dictation-paste.js";
import { DictationCoordinator } from "./dictation-coordinator.js";
import { applyDictationDictionary, parseDictationDictionary } from "../../renderer/shared/dictation-dictionary.js";
import { resolveDictationActivationMode } from "../../renderer/shared/dictation-preferences.js";
import { createPressVoiceCheck } from "./dictation-voice-check.js";

import { activeLinuxDictationHoldShortcut, initLinuxDictationSessionLost, subscribeLinuxDictationRelease } from "./shortcut.js";

let lastPressAt = 0;
// One resolution per press, shared by the provider check and the warm-up.
const pressVoice = createPressVoiceCheck({
  resolve: async () => (await import("./voice-provider-resolution.js")).resolveVoiceProviderNow(),
  warmLocal: async (modelId) => (await import("./local-speech.js")).warmLocalVoice(modelId),
});

// Probed when capture stops, so the osascript launch overlaps transcription.
const secureInput = createSecureInputPrefetch({
  probe: () => detectMacSecureInput(),
  now: () => performance.now(),
});

function canAutoPaste(): boolean {
  return dictationPlatformBehavior().accessibilityPaste && systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * The clipboard's text, HTML and RTF, saved before an auto-paste so a
 * transaction that dies after ⌘V can put them back once the field shows the
 * transcript. The native transaction restores the full pasteboard record
 * itself; this is only its fallback, and covers text only: images, file URLs
 * and app-specific types are not read (no image decode on every paste) and not
 * restored. A clipboard with none of the three keeps the transcript.
 */
function saveClipboardForPaste(transcript: string): () => void {
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
  return () => {
    if (!saved.text && !saved.html && !saved.rtf) return;
    if (clipboard.readText() !== transcript) return;
    clipboard.write({
      ...(saved.text ? { text: saved.text } : {}),
      ...(saved.html ? { html: saved.html } : {}),
      ...(saved.rtf ? { rtf: saved.rtf } : {}),
    });
  };
}

function livePasteDeps(): PasteDeps {
  const behavior = dictationPlatformBehavior();
  return {
    writeClipboard: (text) => clipboard.writeText(text),
    // Delivery must never steal focus with a native permission prompt. Users
    // grant paste access explicitly from Settings; otherwise we copy safely.
    isAccessibilityTrusted: () =>
      behavior.accessibilityPaste &&
      systemPreferences.isTrustedAccessibilityClient(false),
    isSecureInputActive: behavior.accessibilityPaste
      ? () => secureInput.isSecureInputActive()
      : async () => false,
    pasteWithPreservedClipboard: behavior.accessibilityPaste
      ? (text) => runAtomicMacPaste(text)
      : async () => false,
    saveClipboard: behavior.accessibilityPaste ? saveClipboardForPaste : undefined,
    confirmDelivered: behavior.accessibilityPaste ? (text, target) => confirmMacPasteDelivered(text, target) : undefined,
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
  preparePill,
  hidePill,
  destroyPill,
  broadcast: (payload) => ipcMain.broadcast("dictation:state", payload),
  paste: deliverTranscript,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  logError: (message, error) => logger.error("dictation", message, error),
  isHoldToTalk: async () =>
    activeLinuxDictationHoldShortcut() ||
    (dictationPlatformBehavior().holdToTalk &&
      (await configStore.getSettings()).dictationHoldToTalk === true),
  getActivationMode: async () => {
    const settings = await configStore.getSettings();
    // Linux reports releases only while the portal bound a hold shortcut; macOS
    // watches the physical key when the platform supports it.
    const linuxHold = activeLinuxDictationHoldShortcut();
    const releaseCapable = linuxHold || dictationPlatformBehavior().holdToTalk;
    return resolveDictationActivationMode(
      linuxHold ? { ...settings, dictationHoldToTalk: true } : settings,
      releaseCapable,
    );
  },
  resolveVoice: pressVoice.resolveVoice,
  // Warm only the on-device model this press resolved; cloud needs no preload.
  warmUp: pressVoice.warmUp,
  prepareDelivery: () => {
    if (canAutoPaste()) secureInput.prefetch();
  },
  onTiming: (timing) => logger.info("dictation", "Dictation timing", timing),
  applyDictionary: async (text) =>
    applyDictationDictionary(text, parseDictationDictionary((await configStore.getSettings()).dictationDictionary)),
  shouldCleanup: async () => (await configStore.getSettings()).dictationCleanup === true,
  cleanupTranscript: cleanupDictationTranscript,
  ...(process.platform === "linux" ? { startReleaseWatch: subscribeLinuxDictationRelease } : {}),
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

// A portal can disappear before the queued press has installed its release watcher.
// Queue cancellation behind that press so no recording survives lost ownership.
initLinuxDictationSessionLost(() => { void coordinator.cancel(); });

/** Hotkey callback (fire-and-forget). Debounced against OS key chatter. */
export function toggleDictation(): void {
  const now = Date.now();
  if (!activeLinuxDictationHoldShortcut() && !shouldAcceptDictationPress(lastPressAt, now)) return;
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
  audioSeconds?: unknown,
): Promise<void> {
  await coordinator.progress(progress, operationId, audioSeconds);
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

/** Load the hidden pill after launch, so the first press does not wait for a window. */
export function prepareDictationPill(): Promise<void> {
  return coordinator.prepare();
}

/** App shutdown: tear down the pill window. */
export function disposeDictation(): void {
  coordinator.dispose();
}

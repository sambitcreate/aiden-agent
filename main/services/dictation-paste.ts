// Dictation auto-paste. The macOS transaction captures the complete native
// pasteboard record, validates the exact focused process + element twice, pastes,
// and restores only when the transcript is still on the clipboard.

import { execFile } from "node:child_process";
import type { DictationCopiedReason } from "../../renderer/shared/dictation.js";

export type PasteOutcome = "pasted" | "copied";
export interface PasteDeliveryResult {
  outcome: PasteOutcome;
  reason?: DictationCopiedReason;
  message?: string;
}

export interface PasteDeps {
  writeClipboard: (text: string) => void;
  isAccessibilityTrusted: () => boolean;
  /**
   * macOS Secure Event Input (password fields, a terminal's Secure Keyboard
   * Entry, some password managers) silently drops synthetic keystrokes, so a
   * paste would look successful while nothing arrives. Resolves true while
   * any process in the console session holds it.
   */
  isSecureInputActive: () => Promise<boolean>;
  pasteWithPreservedClipboard: (text: string) => Promise<boolean>;
  /**
   * Saves the clipboard before the paste and returns a restore. It is used only
   * when the paste transaction dies after sending ⌘V (an osascript timeout),
   * before its own restore step ran. The restore must leave a clipboard that no
   * longer holds the transcript untouched.
   */
  saveClipboard?: (text: string) => () => void;
  log?: (message: string, error?: unknown) => void;
}

export const SECURE_INPUT_COPIED_MESSAGE = "Transcript copied — press ⌘V to paste.";

/**
 * Written to stderr (AppleScript `log`, unbuffered) right after ⌘V is sent, so
 * a transaction killed by its timeout says whether the paste may have landed.
 */
export const KEYSTROKE_SENT_MARKER = "aiden-paste:keystroke-sent";

/** The paste transaction failed after it sent ⌘V: the text may already be in the field. */
export class PasteAfterKeystrokeError extends Error {
  constructor(readonly original: unknown) {
    super(`The paste transaction failed after sending the keystroke: ${String(original)}`);
  }
}

export const ATOMIC_PASTE_SCRIPT = `on run argv
	set transcriptText to item 1 of argv
	set previousClipboard to the clipboard as record
	set originalValue to missing value
	tell application "System Events"
		try
			set targetProcess to first process whose frontmost is true
			set targetPid to unix id of targetProcess
			set targetElement to value of attribute "AXFocusedUIElement" of targetProcess
			set targetRole to role of targetElement as text
			try
				set originalValue to value of attribute "AXValue" of targetElement as text
			end try
		on error
			set the clipboard to transcriptText
			return "copied"
		end try
	end tell
	if targetRole is not in {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"} then
		set the clipboard to transcriptText
		return "copied"
	end if
	delay 0.08
	tell application "System Events"
		try
			set currentProcess to first process whose frontmost is true
			set currentElement to value of attribute "AXFocusedUIElement" of currentProcess
			if (unix id of currentProcess) is not targetPid or currentElement is not targetElement then
				set the clipboard to transcriptText
				return "copied"
			end if
			set currentRole to role of currentElement as text
			if currentRole is not in {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"} then
				set the clipboard to transcriptText
				return "copied"
			end if
	set the clipboard to transcriptText
			keystroke "v" using command down
		on error
			set the clipboard to transcriptText
			return "copied"
		end try
	end tell
	log "${KEYSTROKE_SENT_MARKER}"
	set quietWindow to 0.2
	set elapsed to 0
	repeat while elapsed is less than 8
		delay 0.05
		set elapsed to elapsed + 0.05
		try
			if (the clipboard as text) is not transcriptText then return "pasted"
		on error
			return "pasted"
		end try
		if elapsed is greater than or equal to quietWindow then
			if originalValue is missing value then return "copied"
			try
				tell application "System Events"
					set deliveredValue to value of attribute "AXValue" of targetElement as text
				end tell
				if deliveredValue is originalValue or deliveredValue does not contain transcriptText then return "copied"
				on error
				return "copied"
			end try
			try
				if (the clipboard as text) is transcriptText then set the clipboard to previousClipboard
			end try
			return "pasted"
		end if
	end repeat
	return "pasted"
end run`;

/** Query the documented Carbon API rather than an undocumented session key. */
export const SECURE_INPUT_PROBE_SCRIPT = `ObjC.import("Carbon");
ObjC.bindFunction("IsSecureEventInputEnabled", ["bool", []]);
$.IsSecureEventInputEnabled() ? "secure" : "clear";`;

export type RunJxa = (script: string) => Promise<string>;

/** Run a JavaScript for Automation snippet with a short timeout. */
export function runJxa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: 2_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

/** Detect macOS Secure Event Input. Rejects when the probe output is unrecognized. */
export async function detectMacSecureInput(run: RunJxa = runJxa): Promise<boolean> {
  const output = (await run(SECURE_INPUT_PROBE_SCRIPT)).trim();
  if (output === "secure") return true;
  if (output === "clear") return false;
  throw new Error(`Unexpected Secure Input probe output: ${output.slice(0, 80)}`);
}

/** A probe started this long before the paste still describes the focused field. */
export const SECURE_INPUT_PROBE_MAX_AGE_MS = 1_500;

export interface SecureInputPrefetch {
  /** Start a probe now, unless a recent one can still answer. */
  prefetch(): void;
  /** The recent probe's answer, or a fresh probe. Each probe answers one delivery. */
  isSecureInputActive(): Promise<boolean>;
}

/**
 * The Secure Input probe launches osascript (about 200 ms). Starting it when
 * the user stops talking lets it run while the audio is transcribed instead of
 * in front of the paste.
 */
export function createSecureInputPrefetch(deps: {
  probe: () => Promise<boolean>;
  now: () => number;
  maxAgeMs?: number;
}): SecureInputPrefetch {
  const maxAgeMs = deps.maxAgeMs ?? SECURE_INPUT_PROBE_MAX_AGE_MS;
  let latest: { startedAt: number; answer: Promise<boolean> } | null = null;
  const fresh = () => latest !== null && deps.now() - latest.startedAt <= maxAgeMs;
  const start = () => {
    const answer = deps.probe();
    // Read later by the delivery; a rejection is handled there.
    answer.catch(() => {});
    latest = { startedAt: deps.now(), answer };
    return answer;
  };
  return {
    prefetch() {
      if (!fresh()) start();
    },
    isSecureInputActive() {
      const answer = fresh() && latest ? latest.answer : start();
      latest = null;
      return answer;
    },
  };
}

/** Run an AppleScript handler with data passed as argv, never interpolated. */
export function runOsascript(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script, "--", ...args],
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
        else resolve(stdout.trim());
      },
    );
  });
}

export type RunOsascript = (script: string, args: string[]) => Promise<string>;

/**
 * Runs the paste transaction. A failure after ⌘V was sent (the timeout killed
 * osascript before its restore step) becomes PasteAfterKeystrokeError.
 */
export async function runAtomicMacPaste(text: string, run: RunOsascript = runOsascript): Promise<boolean> {
  try {
    return (await run(ATOMIC_PASTE_SCRIPT, [text])) === "pasted";
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    if (typeof stderr === "string" && stderr.includes(KEYSTROKE_SENT_MARKER)) throw new PasteAfterKeystrokeError(error);
    throw error;
  }
}

/**
 * Deliver a finished transcript. Without Accessibility access, while macOS
 * Secure Input would swallow the keystroke, or after any failure, the
 * transcript remains available on the clipboard.
 */
export async function pasteTranscript(text: string, deps: PasteDeps): Promise<PasteDeliveryResult> {
  if (!deps.isAccessibilityTrusted()) {
    deps.writeClipboard(text);
    return {
      outcome: "copied",
      reason: "accessibility-required",
      message: "Copied — allow Accessibility to paste automatically.",
    };
  }
  let secureInput = false;
  try {
    secureInput = await deps.isSecureInputActive();
  } catch (error) {
    deps.log?.("Secure Input detection failed; transcript left on the clipboard.", error);
    deps.writeClipboard(text);
    return { outcome: "copied", reason: "paste-unavailable", message: SECURE_INPUT_COPIED_MESSAGE };
  }
  if (secureInput) {
    deps.writeClipboard(text);
    return {
      outcome: "copied",
      reason: "secure-input",
      message: SECURE_INPUT_COPIED_MESSAGE,
    };
  }
  const restoreClipboard = deps.saveClipboard?.(text);
  try {
    return (await deps.pasteWithPreservedClipboard(text))
      ? { outcome: "pasted" }
      : {
          outcome: "copied",
          reason: "paste-unavailable",
          message: "Check the field — transcript copied.",
        };
  } catch (error) {
    if (error instanceof PasteAfterKeystrokeError) {
      // ⌘V already went to the validated field. Copying the transcript again
      // would overwrite the person's clipboard and invite a second paste, so
      // put their clipboard back instead.
      deps.log?.("Dictation paste timed out after the keystroke; clipboard restored.", error.original);
      try {
        restoreClipboard?.();
      } catch (restoreError) {
        deps.log?.("Could not restore the clipboard after the paste.", restoreError);
      }
      return { outcome: "pasted" };
    }
    deps.writeClipboard(text);
    deps.log?.("Dictation paste failed; transcript left on the clipboard.", error);
    return {
      outcome: "copied",
      reason: "paste-unavailable",
      message: "Check the field — transcript copied.",
    };
  }
}

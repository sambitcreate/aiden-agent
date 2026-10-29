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
   * before its own restore step ran, and only after `confirmDelivered` showed
   * the transcript in the field. The restore must leave a clipboard that no
   * longer holds the transcript untouched.
   */
  saveClipboard?: (text: string) => () => void;
  /**
   * After a transaction died past ⌘V: whether the field the ⌘V targeted now
   * holds one more copy of the transcript than it did before. A ⌘V that was
   * posted but not yet read by a busy app would paste whatever is on the
   * clipboard when it is, so the clipboard is put back only once the paste is
   * seen in that field. Resolves false when that cannot be confirmed; never
   * rejects.
   */
  confirmDelivered?: (text: string, target: PasteTarget) => Promise<boolean>;
  /** Waits before `confirmDelivered`, giving the target app time to read the pasteboard. */
  wait?: (ms: number) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

export const SECURE_INPUT_COPIED_MESSAGE = "Transcript copied — press ⌘V to paste.";

/**
 * Written to stderr (AppleScript `log`, unbuffered) right after ⌘V is sent, so
 * a transaction killed by its timeout says whether the paste may have landed.
 */
export const KEYSTROKE_SENT_MARKER = "aiden-paste:keystroke-sent";

/**
 * What the transaction recorded about the field it pasted into: the owning
 * process and how many times the transcript already appeared in the field's
 * value before ⌘V.
 */
export interface PasteTarget {
  pid: number;
  priorCount: number;
}

/**
 * Reads the target from the marker line in a killed transaction's stderr.
 * Null when the marker is missing or the field's value could not be read
 * before ⌘V (`count=unknown`): such a paste can never be confirmed.
 */
export function parseKeystrokeMarker(stderr: string): PasteTarget | null {
  const match = new RegExp(`${KEYSTROKE_SENT_MARKER} pid=(\\d+) count=(\\d+)\\b`).exec(stderr);
  if (!match) return null;
  const pid = Number(match[1]);
  const priorCount = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(priorCount) ? { pid, priorCount } : null;
}

/** The paste transaction failed after it sent ⌘V: the text may already be in the field. */
export class PasteAfterKeystrokeError extends Error {
  constructor(
    readonly original: unknown,
    /** Null when the transaction could not say where it pasted; the paste is then never confirmed. */
    readonly target: PasteTarget | null = null,
  ) {
    super(`The paste transaction failed after sending the keystroke: ${String(original)}`);
  }
}

/** How long a paste that outlived its transaction gets to land before the field is checked. */
export const PASTE_CONFIRM_DELAY_MS = 1_000;

/** The confirmation read is short and bounded; a busy target that cannot answer counts as unconfirmed. */
export const PASTE_CONFIRM_TIMEOUT_MS = 1_500;

/**
 * AppleScript handlers shared by the paste transaction and its delivery check.
 * `countOccurrences` counts case-sensitive, non-overlapping copies of the
 * transcript in a field value. `deliveryVerdict` confirms a paste only when the
 * field holds more copies than before ⌘V, so text that was already there never
 * counts. `keystrokeMarker` is the stderr line written after ⌘V, which
 * `parseKeystrokeMarker` reads back.
 */
export const PASTE_SCRIPT_HANDLERS = `on countOccurrences(haystack, needle)
	if haystack is "" or needle is "" then return 0
	set savedDelimiters to AppleScript's text item delimiters
	considering case
		set AppleScript's text item delimiters to needle
		set itemCount to count of text items of haystack
	end considering
	set AppleScript's text item delimiters to savedDelimiters
	return itemCount - 1
end countOccurrences

on deliveryVerdict(fieldValue, transcriptText, originalCount)
	if (my countOccurrences(fieldValue, transcriptText)) is greater than originalCount then return "confirmed"
	return "unconfirmed"
end deliveryVerdict

on keystrokeMarker(targetPid, originalCount)
	return "${KEYSTROKE_SENT_MARKER} pid=" & targetPid & " count=" & originalCount
end keystrokeMarker`;

/**
 * Reads the focused element of the process the ⌘V targeted (argv 2), never
 * whichever app is frontmost now, and confirms only when its value holds more
 * copies of the transcript than the transaction saw before ⌘V (argv 3). Text
 * that was already there, another app, or an unreadable field is unconfirmed.
 * Everything arrives as argv, never interpolated.
 */
export const PASTE_CONFIRM_SCRIPT = `${PASTE_SCRIPT_HANDLERS}

on run argv
	if (count of argv) is less than 3 then return "unconfirmed"
	set transcriptText to item 1 of argv
	try
		set targetPid to (item 2 of argv) as integer
		set originalCount to (item 3 of argv) as integer
	on error
		return "unconfirmed"
	end try
	if targetPid is less than 1 or originalCount is less than 0 then return "unconfirmed"
	tell application "System Events"
		try
			set targetProcess to first process whose unix id is targetPid
			set focusedElement to value of attribute "AXFocusedUIElement" of targetProcess
			set fieldValue to value of attribute "AXValue" of focusedElement as text
		on error
			return "unconfirmed"
		end try
	end tell
	return my deliveryVerdict(fieldValue, transcriptText, originalCount)
end run`;

export const ATOMIC_PASTE_SCRIPT = `${PASTE_SCRIPT_HANDLERS}

on run argv
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
	set originalCount to "unknown"
	if originalValue is not missing value then set originalCount to my countOccurrences(originalValue, transcriptText)
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
	log my keystrokeMarker(targetPid, originalCount)
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
				if (my deliveryVerdict(deliveredValue, transcriptText, originalCount)) is not "confirmed" then return "copied"
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
export function runOsascript(script: string, args: string[] = [], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script, "--", ...args],
      { timeout: timeoutMs },
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
    if (typeof stderr === "string" && stderr.includes(KEYSTROKE_SENT_MARKER)) {
      throw new PasteAfterKeystrokeError(error, parseKeystrokeMarker(stderr));
    }
    throw error;
  }
}

/**
 * Whether the target process's focused field gained a copy of the transcript,
 * from a short bounded AX read. Any failure, timeout or other answer is "not
 * confirmed".
 */
export async function confirmMacPasteDelivered(
  text: string,
  target: PasteTarget,
  run: RunOsascript = (script, args) => runOsascript(script, args, PASTE_CONFIRM_TIMEOUT_MS),
): Promise<boolean> {
  try {
    return (await run(PASTE_CONFIRM_SCRIPT, [text, String(target.pid), String(target.priorCount)])) === "confirmed";
  } catch {
    return false;
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
      // ⌘V was posted, but a busy app may not have read the pasteboard yet.
      // Restoring now would let that queued ⌘V paste the person's previous
      // clipboard, so the clipboard comes back only once the targeted field
      // shows a new copy of the transcript.
      const target = error.target;
      if (restoreClipboard && deps.confirmDelivered && target) {
        await (deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(PASTE_CONFIRM_DELAY_MS);
        if (await deps.confirmDelivered(text, target).catch(() => false)) {
          deps.log?.("Dictation paste timed out after the keystroke; the field shows the transcript, clipboard restored.", error.original);
          try {
            restoreClipboard();
          } catch (restoreError) {
            deps.log?.("Could not restore the clipboard after the paste.", restoreError);
          }
          return { outcome: "pasted" };
        }
      }
      // The transaction put the transcript on the clipboard before ⌘V. Writing
      // it again would overwrite anything the person copied while we waited.
      deps.log?.("Dictation paste timed out after the keystroke and could not be confirmed; clipboard left as it is.", error.original);
      return {
        outcome: "copied",
        reason: "paste-unavailable",
        message: "Check the field — transcript copied.",
      };
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

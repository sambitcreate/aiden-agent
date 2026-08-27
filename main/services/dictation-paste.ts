// Dictation auto-paste. The macOS transaction captures the complete native
// pasteboard record, validates the exact focused process + element twice, pastes,
// and restores only when the transcript is still on the clipboard.

import { execFile } from "node:child_process";

export type PasteOutcome = "pasted" | "copied";
export interface PasteDeliveryResult {
  outcome: PasteOutcome;
  reason?: "accessibility-required" | "paste-unavailable";
  message?: string;
}

export interface PasteDeps {
  writeClipboard: (text: string) => void;
  isAccessibilityTrusted: () => boolean;
  pasteWithPreservedClipboard: (text: string) => Promise<boolean>;
  log?: (message: string, error?: unknown) => void;
}

export const ATOMIC_PASTE_SCRIPT = `on run argv
	set transcriptText to item 1 of argv
	set previousClipboard to the clipboard as record
	tell application "System Events"
		try
			set targetProcess to first process whose frontmost is true
			set targetPid to unix id of targetProcess
			set targetElement to value of attribute "AXFocusedUIElement" of targetProcess
			set targetRole to role of targetElement as text
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
			try
				if (the clipboard as text) is transcriptText then set the clipboard to previousClipboard
			end try
			return "pasted"
		end if
	end repeat
	return "pasted"
end run`;

/** Run an AppleScript handler with data passed as argv, never interpolated. */
export function runOsascript(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script, "--", ...args],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

export async function runAtomicMacPaste(text: string): Promise<boolean> {
  return (await runOsascript(ATOMIC_PASTE_SCRIPT, [text])) === "pasted";
}

/**
 * Deliver a finished transcript. Without Accessibility access or after any
 * failure, the transcript remains available on the clipboard.
 */
export async function pasteTranscript(
  text: string,
  deps: PasteDeps,
): Promise<PasteDeliveryResult> {
  if (!deps.isAccessibilityTrusted()) {
    deps.writeClipboard(text);
    return {
      outcome: "copied",
      reason: "accessibility-required",
      message: "Copied — allow Accessibility to paste automatically.",
    };
  }
  try {
    return (await deps.pasteWithPreservedClipboard(text))
      ? { outcome: "pasted" }
      : {
          outcome: "copied",
          reason: "paste-unavailable",
          message: "Copied — the original text field was no longer focused.",
        };
  } catch (error) {
    deps.writeClipboard(text);
    deps.log?.("Dictation paste failed; transcript left on the clipboard.", error);
    return {
      outcome: "copied",
      reason: "paste-unavailable",
      message: "Copied — Aiden couldn’t paste into the focused app.",
    };
  }
}

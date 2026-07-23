// Dictation auto-paste. The macOS transaction captures the complete native
// pasteboard record, validates the exact focused process + element twice, pastes,
// and restores only when the transcript is still on the clipboard.

import { execFile } from "node:child_process";

export type PasteOutcome = "pasted" | "copied";

export interface PasteDeps {
  writeClipboard: (text: string) => void;
  isAccessibilityTrusted: (prompt: boolean) => boolean;
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
	delay 0.12
	try
		if (the clipboard as text) is transcriptText then set the clipboard to previousClipboard
	end try
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
export async function pasteTranscript(text: string, deps: PasteDeps): Promise<PasteOutcome> {
  if (!deps.isAccessibilityTrusted(true)) {
    deps.writeClipboard(text);
    return "copied";
  }
  try {
    return (await deps.pasteWithPreservedClipboard(text)) ? "pasted" : "copied";
  } catch (error) {
    deps.writeClipboard(text);
    deps.log?.("Dictation paste failed; transcript left on the clipboard.", error);
    return "copied";
  }
}

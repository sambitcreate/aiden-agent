//! Dictation auto-paste — port of `main/services/dictation-paste.ts`.
//!
//! The macOS path runs one AppleScript transaction (`ATOMIC_PASTE_SCRIPT`)
//! through `/usr/bin/osascript` with the transcript passed as argv (never
//! interpolated). The script captures the complete native pasteboard record,
//! validates the focused process + element twice, pastes, and restores the
//! previous clipboard only when the transcript is still on it. Without
//! Accessibility access (or after any failure) the transcript is left on the
//! clipboard and the outcome is `Copied`.

use futures::future::BoxFuture;
use futures::FutureExt;

/// `ATOMIC_PASTE_SCRIPT` — verbatim from dictation-paste.ts.
pub const ATOMIC_PASTE_SCRIPT: &str = r#"on run argv
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
end run"#;

/// `PasteOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    Pasted,
    Copied,
}

/// The injected paste façade (`PasteDeps`).
pub trait PasteDeps: Send + Sync {
    fn write_clipboard(&self, text: &str);
    fn is_accessibility_trusted(&self, prompt: bool) -> bool;
    /// `Ok(true)` pasted; `Ok(false)` fell back to clipboard inside the script;
    /// `Err` = the AppleScript invocation failed.
    fn paste_with_preserved_clipboard(
        &self,
        text: &str,
    ) -> BoxFuture<'static, Result<bool, String>>;
    fn log(&self, message: &str, error: Option<&str>);
}

/// `pasteTranscript` — deliver a finished transcript with clipboard fallback.
pub async fn paste_transcript(text: &str, deps: &dyn PasteDeps) -> PasteOutcome {
    if !deps.is_accessibility_trusted(true) {
        deps.write_clipboard(text);
        return PasteOutcome::Copied;
    }
    match deps.paste_with_preserved_clipboard(text).await {
        Ok(true) => PasteOutcome::Pasted,
        Ok(false) => PasteOutcome::Copied,
        Err(error) => {
            deps.write_clipboard(text);
            deps.log(
                "Dictation paste failed; transcript left on the clipboard.",
                Some(&error),
            );
            PasteOutcome::Copied
        }
    }
}

// ===========================================================================
// macOS runtime
// ===========================================================================

#[derive(Debug, thiserror::Error)]
pub enum PasteIoError {
    #[error("osascript failed: {0}")]
    Osascript(String),
    #[error("Paste via AppleScript is unsupported on this platform.")]
    UnsupportedPlatform,
}

/// `runOsascript` — run an AppleScript handler with data passed as argv, never
/// interpolated. macOS only; the non-macOS stub always fails cleanly.
pub async fn run_osascript(script: &str, args: &[&str]) -> Result<String, PasteIoError> {
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("/usr/bin/osascript")
            .args(["-e", script, "--"])
            .args(args)
            .output()
            .await
            .map_err(|error| PasteIoError::Osascript(error.to_string()))?;
        if !output.status.success() {
            return Err(PasteIoError::Osascript(format!(
                "exit {}: {}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (script, args);
        Err(PasteIoError::UnsupportedPlatform)
    }
}

/// `runAtomicMacPaste` — pasted only when the script reports `"pasted"`.
pub async fn run_atomic_mac_paste(text: &str) -> Result<bool, PasteIoError> {
    Ok(run_osascript(ATOMIC_PASTE_SCRIPT, &[text]).await? == "pasted")
}

/// The default deps for a real macOS app.
///
/// `is_accessibility_trusted` probes System Events (which requires the
/// Accessibility permission); with `prompt` it also opens the Accessibility
/// pane so the user can grant access.
pub struct MacPasteDeps;

impl MacPasteDeps {
    fn probe_trusted(prompt: bool) -> bool {
        #[cfg(target_os = "macos")]
        {
            let trusted = probe_accessibility();
            if !trusted && prompt {
                let _ = std::process::Command::new("open")
                    .args([
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                    ])
                    .spawn();
            }
            trusted
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = prompt;
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn probe_accessibility() -> bool {
    // `osascript -e 'tell application "System Events" to count processes'`
    // fails when the calling app lacks Accessibility trust, so success is a
    // reliable probe without extra frameworks.
    std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "tell application \"System Events\" to count processes",
        ])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

impl PasteDeps for MacPasteDeps {
    fn write_clipboard(&self, text: &str) {
        // `pbcopy` is the macOS pasteboard write (no NSPasteboard dependency).
        if let Ok(mut child) = std::process::Command::new("/usr/bin/pbcopy")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
        {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }
    fn is_accessibility_trusted(&self, prompt: bool) -> bool {
        Self::probe_trusted(prompt)
    }
    fn paste_with_preserved_clipboard(
        &self,
        text: &str,
    ) -> BoxFuture<'static, Result<bool, String>> {
        let text = text.to_string();
        async move {
            run_atomic_mac_paste(&text)
                .await
                .map_err(|error| error.to_string())
        }
        .boxed()
    }
    fn log(&self, message: &str, error: Option<&str>) {
        match error {
            Some(error) => tracing::warn!("{message}: {error}"),
            None => tracing::warn!("{message}"),
        }
    }
}

/// A deps stub for non-macOS hosts (clipboard-fallback always).
pub struct UnsupportedPasteDeps;

impl PasteDeps for UnsupportedPasteDeps {
    fn write_clipboard(&self, _text: &str) {}
    fn is_accessibility_trusted(&self, _prompt: bool) -> bool {
        false
    }
    fn paste_with_preserved_clipboard(
        &self,
        _text: &str,
    ) -> BoxFuture<'static, Result<bool, String>> {
        async { Err(PasteIoError::UnsupportedPlatform.to_string()) }.boxed()
    }
    fn log(&self, _message: &str, _error: Option<&str>) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct FakeDeps {
        clipboard: Mutex<Vec<String>>,
        trusted: bool,
        paste_result: Option<Result<bool, String>>,
        logs: Mutex<Vec<String>>,
        trust_prompt: AtomicUsize,
    }

    impl FakeDeps {
        fn new(trusted: bool, paste_result: Option<Result<bool, String>>) -> Self {
            Self {
                clipboard: Mutex::new(Vec::new()),
                trusted,
                paste_result,
                logs: Mutex::new(Vec::new()),
                trust_prompt: AtomicUsize::new(0),
            }
        }
    }

    impl PasteDeps for FakeDeps {
        fn write_clipboard(&self, text: &str) {
            self.clipboard.lock().unwrap().push(text.to_string());
        }
        fn is_accessibility_trusted(&self, prompt: bool) -> bool {
            if prompt {
                self.trust_prompt.fetch_add(1, Ordering::SeqCst);
            }
            self.trusted
        }
        fn paste_with_preserved_clipboard(
            &self,
            _text: &str,
        ) -> BoxFuture<'static, Result<bool, String>> {
            let result = self.paste_result.clone().unwrap_or(Ok(true));
            async move { result }.boxed()
        }
        fn log(&self, message: &str, error: Option<&str>) {
            self.logs
                .lock()
                .unwrap()
                .push(format!("{message}:{error:?}"));
        }
    }

    #[tokio::test]
    async fn without_accessibility_the_transcript_stays_on_the_clipboard() {
        let deps = FakeDeps::new(false, Some(Ok(true)));
        let outcome = paste_transcript("hello", &deps).await;
        assert_eq!(outcome, PasteOutcome::Copied);
        assert_eq!(*deps.clipboard.lock().unwrap(), vec!["hello".to_string()]);
        assert!(deps.logs.lock().unwrap().is_empty());
        assert_eq!(deps.trust_prompt.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_successful_paste_reports_pasted() {
        let deps = FakeDeps::new(true, Some(Ok(true)));
        let outcome = paste_transcript("hello", &deps).await;
        assert_eq!(outcome, PasteOutcome::Pasted);
        assert!(deps.clipboard.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_script_fallback_reports_copied_without_logging() {
        let deps = FakeDeps::new(true, Some(Ok(false)));
        let outcome = paste_transcript("hello", &deps).await;
        assert_eq!(outcome, PasteOutcome::Copied);
        assert!(deps.clipboard.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_osascript_invocation_leaves_the_transcript_and_logs() {
        let deps = FakeDeps::new(true, Some(Err("boom".into())));
        let outcome = paste_transcript("hello", &deps).await;
        assert_eq!(outcome, PasteOutcome::Copied);
        assert_eq!(*deps.clipboard.lock().unwrap(), vec!["hello".to_string()]);
        assert_eq!(deps.logs.lock().unwrap().len(), 1);
    }

    #[test]
    fn atomic_paste_script_uses_only_argv_passing() {
        // The script must read the transcript from argv — never interpolated.
        assert!(ATOMIC_PASTE_SCRIPT.contains("item 1 of argv"));
        assert!(ATOMIC_PASTE_SCRIPT.contains("keystroke \"v\" using command down"));
        assert!(!ATOMIC_PASTE_SCRIPT.contains("{transcriptText}"));
    }
}

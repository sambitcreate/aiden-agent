//! Development file logger — port of `main/services/dev-log.ts`.
//!
//! Kept Electron-free so it stays unit-testable, exactly like the TS side:
//! - writes are serialized (TS queues them behind one promise chain; here a
//!   `Mutex` makes them synchronous and atomic);
//! - every failure is swallowed — logging must never break the app;
//! - oversized previous logs rotate aside to `.prev.log` on init (2 MB cap);
//! - single lines are capped at 4096 bytes;
//! - credentials are redacted before they reach disk
//!   ([`redact_dev_log_secrets`]).
//!
//! The TS module is a process-global singleton; this crate exposes a
//! [`DevLog`] struct (tests construct their own) plus a [`DEV_LOG`]
//! process-global for app wiring. `flush()` is a no-op because writes are
//! synchronous — the TS `flushDevLog()` exists only to settle its write queue.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use regex::Regex;
use serde::Serialize;

/// Rotate the current log aside once it grows past ~2 MB.
pub const DEV_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Cap a single rendered line so a huge object cannot flood the file.
pub const DEV_LOG_MAX_LINE: usize = 4096;

/// `level` in `writeDevLog`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl DevLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            DevLogLevel::Debug => "debug",
            DevLogLevel::Info => "info",
            DevLogLevel::Warn => "warn",
            DevLogLevel::Error => "error",
        }
    }
}

/// One value to render into a log line. Mirrors the TS `format(value)` switch:
/// strings pass through, `Error` renders as `Error: {message}`, everything
/// else JSON-stringifies.
#[derive(Debug, Clone)]
pub enum DevLogPart {
    Text(String),
    /// Rendered as `Error: {message}` (the TS renders `error.stack ?? error.message`).
    Error(String),
    Json(serde_json::Value),
}

impl DevLogPart {
    pub fn text(value: impl Into<String>) -> Self {
        DevLogPart::Text(value.into())
    }

    pub fn json<T: Serialize>(value: &T) -> Self {
        DevLogPart::Json(serde_json::to_value(value).unwrap_or(serde_json::Value::Null))
    }
}

fn render_part(part: &DevLogPart) -> String {
    match part {
        DevLogPart::Text(text) => text.clone(),
        DevLogPart::Error(message) => format!("Error: {message}"),
        DevLogPart::Json(value) => {
            serde_json::to_string(value).unwrap_or_else(|_| "[unserializable]".to_string())
        }
    }
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn redaction_patterns() -> Vec<Regex> {
    // 1. `\b(Bearer\s+)[^\s"',;]+` → `$1[REDACTED]`
    // 2. `(["']?(?:access_token|refresh_token|client_secret|api[_-]?key|x-consumer-api-key)["']?\s*[:=]\s*["']?)[^"',}\s]+`
    // 3. `\bsk-[A-Za-z0-9_-]{12,}\b`
    vec![
        Regex::new(r#"(?i)\b(Bearer\s+)[^\s"',;]+"#).expect("static bearer pattern"),
        Regex::new(
            r#"(?i)(["']?(?:access_token|refresh_token|client_secret|api[_-]?key|x-consumer-api-key)["']?\s*[:=]\s*["']?)[^"',}\s]+"#,
        )
        .expect("static credential pattern"),
        Regex::new(r#"\bsk-[A-Za-z0-9_-]{12,}\b"#).expect("static sk- pattern"),
    ]
}

/// Replace high-confidence credential patterns before a line reaches disk
/// (`redactDevLogSecrets`). Byte-faithful to the TS replacement chain.
pub fn redact_dev_log_secrets(value: &str) -> String {
    let patterns = redaction_patterns();
    // Order matters: Bearer first, then key-style assignments, then sk- tokens.
    let mut redacted = patterns[0].replace_all(value, "$1[REDACTED]").into_owned();
    redacted = patterns[1]
        .replace_all(&redacted, "$1[REDACTED]")
        .into_owned();
    redacted = patterns[2]
        .replace_all(&redacted, "[REDACTED]")
        .into_owned();
    redacted
}

/// The dev-mode file logger.
pub struct DevLog {
    target: Mutex<Option<PathBuf>>,
}

impl Default for DevLog {
    fn default() -> Self {
        Self::new()
    }
}

impl DevLog {
    pub fn new() -> Self {
        Self {
            target: Mutex::new(None),
        }
    }

    /// The current target path (`devLogPath()`), or `None` before init.
    pub fn path(&self) -> Option<PathBuf> {
        self.target.lock().unwrap().clone()
    }

    /// Start writing to `target_path`, rotating an oversized previous log
    /// aside and appending a session header. All failures are swallowed.
    pub fn init(&self, target_path: impl AsRef<Path>) {
        let target_path = target_path.as_ref().to_path_buf();
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let oversized = fs::metadata(&target_path)
                .map(|metadata| metadata.len() > DEV_LOG_MAX_BYTES)
                .unwrap_or(false);
            if oversized {
                let rotated = target_path.with_extension("prev.log");
                let _ = fs::rename(&target_path, &rotated);
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&target_path)?;
            writeln!(file, "\n── session {iso} ──", iso = iso_now())?;
            Ok(())
        })();
        if let Err(error) = result {
            tracing::debug!(%error, "dev log init failed; logging disabled");
        }
        *self.target.lock().unwrap() = Some(target_path);
    }

    /// Append one line; a no-op until [`DevLog::init`] has run. Never throws.
    pub fn write(&self, level: DevLogLevel, scope: &str, values: &[DevLogPart]) {
        let Some(target) = self.target.lock().unwrap().clone() else {
            return;
        };
        let rendered =
            redact_dev_log_secrets(&values.iter().map(render_part).collect::<Vec<_>>().join(" "));
        // `level.toUpperCase().padEnd(5)` → `INFO ` / `ERROR`.
        let line = format!(
            "{iso} {level:<5} [{scope}] {rendered}",
            iso = iso_now(),
            level = level.as_str().to_uppercase(),
        );
        let line = line.chars().take(DEV_LOG_MAX_LINE).collect::<String>() + "\n";
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .and_then(|mut file| file.write_all(line.as_bytes()));
    }

    /// Resolve once every queued write has landed. Writes are synchronous, so
    /// this is a no-op kept for TS parity.
    pub fn flush(&self) {
        // Writes are synchronous; nothing to drain.
    }
}

/// The process-global dev log used by app wiring (mirrors the TS module
/// singleton). Tests construct their own `DevLog` instances instead.
pub static DEV_LOG: std::sync::OnceLock<DevLog> = std::sync::OnceLock::new();

/// Convenience for the global instance: `initDevLog(targetPath)`.
pub fn init_dev_log(target_path: impl AsRef<Path>) {
    let log = DEV_LOG.get_or_init(DevLog::new);
    log.init(target_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_is_a_no_op_before_init() {
        let log = DevLog::new();
        log.write(DevLogLevel::Info, "scope", &[DevLogPart::text("hello")]);
        log.flush();
    }

    #[test]
    fn init_creates_the_file_with_a_session_header_and_writes_formatted_lines() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("nested").join("aiden-dev.log");
        let log = DevLog::new();
        log.init(&target);
        assert_eq!(log.path(), Some(target.clone()));
        log.write(
            DevLogLevel::Info,
            "main",
            &[
                DevLogPart::text("hello"),
                DevLogPart::Json(serde_json::json!(42)),
            ],
        );
        log.write(
            DevLogLevel::Error,
            "renderer",
            &[DevLogPart::Error("boom".to_string())],
        );
        log.write(
            DevLogLevel::Warn,
            "main",
            &[DevLogPart::Json(serde_json::json!({"a": 1}))],
        );
        log.flush();

        let text = fs::read_to_string(&target).unwrap();
        assert!(text.contains("── session "), "missing session header");
        assert!(text.contains("──\n"), "missing session header terminator");
        assert!(text.contains("INFO  [main] hello 42\n"));
        assert!(text.contains("ERROR [renderer] Error: boom"));
        assert!(text.contains("WARN  [main] {\"a\":1}\n"));
    }

    #[test]
    fn long_lines_are_truncated_to_the_cap() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("aiden-dev.log");
        let log = DevLog::new();
        log.init(&target);
        log.write(
            DevLogLevel::Info,
            "main",
            &[DevLogPart::text("x".repeat(10_000))],
        );
        log.flush();
        let content = fs::read_to_string(&target).unwrap();
        let lines: Vec<&str> = content.trim().split('\n').collect();
        let data = lines.iter().find(|line| line.contains("xxx")).unwrap();
        assert!(data.len() <= DEV_LOG_MAX_LINE + 1, "cap + newline");
    }

    #[test]
    fn credentials_are_redacted_before_they_reach_disk() {
        let redacted = redact_dev_log_secrets(
            "Authorization: Bearer live-token access_token=\"oauth-token\" client_secret=secret api_key: sk-abcdefghijklmnop",
        );
        for credential in [
            "live-token",
            "oauth-token",
            "=secret",
            "sk-abcdefghijklmnop",
        ] {
            assert!(
                !redacted.contains(credential),
                "credential {credential:?} leaked: {redacted:?}"
            );
        }
        assert!(redacted.contains("Bearer [REDACTED]"));
        assert!(redacted.contains("access_token=\"[REDACTED]\""));
    }

    #[test]
    fn an_oversized_existing_log_is_rotated_aside_on_init() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("aiden-dev.log");
        fs::write(&target, "y".repeat(3 * 1024 * 1024)).unwrap();
        let log = DevLog::new();
        log.init(&target);
        log.write(DevLogLevel::Info, "main", &[DevLogPart::text("fresh")]);
        log.flush();

        let prev = fs::read(directory.path().join("aiden-dev.prev.log")).unwrap();
        assert_eq!(prev.len(), 3 * 1024 * 1024);
        let current = fs::read_to_string(&target).unwrap();
        assert!(current.contains("fresh"));
        assert!(current.len() < 1024);
    }

    #[test]
    fn logging_never_throws_even_when_the_path_is_unusable() {
        let directory = tempfile::tempdir().unwrap();
        let blocker = directory.path().join("blocker");
        fs::write(&blocker, "file").unwrap();
        let log = DevLog::new();
        log.init(blocker.join("aiden-dev.log")); // parent is a file
        log.write(DevLogLevel::Info, "main", &[DevLogPart::text("ignored")]);
        log.flush();
    }

    #[test]
    fn rotation_keeps_the_session_header_after_rename() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("aiden-dev.log");
        let log = DevLog::new();
        log.init(&target);
        log.write(DevLogLevel::Info, "main", &[DevLogPart::text("one")]);
        log.flush();
        // Force a rotation by re-initing a fresh DevLog over an oversized file.
        fs::write(&target, "z".repeat(3 * 1024 * 1024)).unwrap();
        log.init(&target);
        log.write(DevLogLevel::Info, "main", &[DevLogPart::text("two")]);
        log.flush();
        let current = fs::read_to_string(&target).unwrap();
        assert!(current.contains("two"));
        assert!(current.contains("── session "));
    }
}

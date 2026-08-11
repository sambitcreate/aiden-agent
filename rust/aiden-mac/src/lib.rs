//! Aiden macOS integration — port of the Electron `main/platform.ts` surfaces
//! that GPUI does not ship, plus the pure `-core` logic they depend on.
//!
//! Modules:
//!
//! - **`hotkey`** — global hotkey registration with the transactional model from
//!   `shortcut-registration-core.ts` / `shortcut-transaction-core.ts` (atomic
//!   swaps, conflict rollback, serialized read→apply→persist with rollback),
//!   wired to the `global-hotkey` crate on macOS. Accelerator parsing and
//!   validation reuse `aiden-core::keybindings`.
//! - **`notify`** — macOS notifications via `mac-notification-sys`
//!   (UNUserNotificationCenter), with a permission preflight helper.
//! - **`tray`** — menu-bar status item via `tray-icon` + `muda` (Open Aiden /
//!   Quit); returns a handle the GPUI app owns. macOS requires building the
//!   tray on the main thread with a live event loop.
//! - **`paste`** — dictation paste-into-frontmost-app via AppleScript / System
//!   Events exactly as `dictation-paste.ts` does, with the pure
//!   `paste_transcript` decision behind an injectable deps trait.
//! - **`updater`** — pure port of `app-updater-core.ts` (enablement decision),
//!   electron-updater's semver-ish version comparison + channel policy, and the
//!   `UpdateProvider` trait (with the `NoopUpdateProvider` fallback).
//! - **`updater_feed`** — the real update feed core: strict Electron Builder
//!   `latest-mac.yml` YAML parsing (plus bounded JSON compatibility), artifact
//!   selection, and SHA-512/SHA-256 download verification (the pure logic
//!   electron-updater's generic provider codifies). Always compiled and
//!   unit-tested; no network.
//! - **`feed_update_provider`** (feature `update-feed`) — `FeedUpdateProvider`,
//!   a real `UpdateProvider` that fetches the feed, applies channel policy,
//!   downloads + verifies + stages the artifact, and delegates the explicit
//!   user-action installer-opening step to an [`UpdateInstaller`] owned by the
//!   GPUI app. Automatic quit-and-restart replacement is deliberately absent
//!   until a signed external updater contract exists.
//! - **`menu`** — the native-menu command contract (`native-menu-command-contract`):
//!   which commands the app menu owns and the accelerator ownership assertion.
//! - **`audio`** — microphone capture (AVAudioEngine input tap → mono 16 kHz
//!   Float32) with an injectable [`audio::AudioCapture`] trait.
//! - **`dictation_coordinator`** — the serialized dictation state machine
//!   (idle/starting/recording/transcribing/delivering) ported from
//!   `dictation-coordinator.ts`.
//! - **`sherpa`** / **`local_models`** / **`local_runtime_status`** — the
//!   on-device speech pipeline (`dictation` feature): Parakeet recognizer
//!   wrapper, the model catalog + GitHub release download manager, and the
//!   Ollama/LM Studio load-state probe.
//!
//! macOS-only APIs are behind `#[cfg(target_os = "macos")]`; the rest of the
//! crate provides graceful stubs so `cargo test` passes on any host.

pub mod accessibility;
pub mod appearance;
pub mod audio;
pub mod dictation_coordinator;
pub mod hotkey;
pub mod local_runtime_status;
pub mod menu;
pub mod notify;
pub mod paste;
pub mod pill_display;
pub mod profile_share;
pub mod quit_barrier;
pub mod readiness;
pub mod tray;
pub mod updater;
pub mod updater_feed;

#[cfg(feature = "update-feed")]
pub mod feed_update_provider;

/// On-device dictation engine + model management (behind the `dictation`
/// cargo feature; see the workspace features in `Cargo.toml`).
#[cfg(feature = "dictation")]
pub mod local_models;
#[cfg(feature = "dictation")]
pub mod sherpa;

/// The Keychain service name for provider credentials (was Electron
/// safeStorage's backing service on macOS).
pub const KEYCHAIN_SERVICE: &str = "com.sambitcreate.aiden-agent";

/// The reverse-DNS application id used for window/app identification.
pub const APP_BUNDLE_ID: &str = "com.sambitcreate.aiden-agent";

/// Whether the app is running inside a bundled `.app` (production) vs a bare
/// binary (development). Production bundles need signed helpers and a
/// Sparkle feed.
pub fn is_bundled_app() -> bool {
    std::env::args()
        .next()
        .map(|argv0| argv0.contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Resolve the generic update feed embedded in a signed `.app` bundle.
///
/// Electron-builder writes a small `app-update.yml` beside the packaged
/// resources. We intentionally parse only the bounded `provider: generic`
/// and HTTPS `url:` fields we need; no YAML engine or caller-controlled path
/// is introduced. Development/unpacked binaries return `None`, so ordinary
/// runs never contact an update feed.
pub fn packaged_update_feed_url() -> Option<String> {
    if !is_bundled_app() || aiden_data::is_dev_mode() {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let resources = executable.parent()?.parent()?.join("Resources");
    let marker = resources.join("app-update.yml");
    let bytes = std::fs::read(marker).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    parse_packaged_update_feed_url(text)
}

fn parse_packaged_update_feed_url(text: &str) -> Option<String> {
    let mut generic = false;
    let mut base_url = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("provider:") {
            generic = value.trim() == "generic";
        } else if let Some(value) = line.strip_prefix("url:") {
            let value = value.trim();
            if value.starts_with("https://")
                && value.len() <= 2_048
                && !value.chars().any(|character| character.is_control())
            {
                base_url = Some(value.trim_end_matches('/').to_string());
            }
        }
    }
    if !generic {
        return None;
    }
    let base_url = base_url?;
    Some(format!("{base_url}/latest-mac.yml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_matches_app_id() {
        assert_eq!(KEYCHAIN_SERVICE, APP_BUNDLE_ID);
    }

    #[test]
    fn packaged_update_marker_accepts_only_generic_https_feeds() {
        assert_eq!(
            parse_packaged_update_feed_url(
                "provider: generic\nurl: https://updates.example.test/aiden\n"
            )
            .as_deref(),
            Some("https://updates.example.test/aiden/latest-mac.yml")
        );
        assert_eq!(
            parse_packaged_update_feed_url(
                "provider: github\nurl: https://updates.example.test/aiden\n"
            ),
            None
        );
        assert_eq!(
            parse_packaged_update_feed_url("provider: generic\nurl: http://localhost\n"),
            None
        );
    }
}

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
//! - **`updater_feed`** — the real update feed core: strict JSON feed
//!   parsing, artifact selection, and sha-256 download verification (the pure
//!   logic electron-updater's generic provider codifies). Always compiled and
//!   unit-tested; no network.
//! - **`feed_update_provider`** (feature `update-feed`) — `FeedUpdateProvider`,
//!   a real `UpdateProvider` that fetches the feed, applies channel policy,
//!   downloads + verifies + stages the artifact, and delegates the
//!   quit-and-install step to an [`UpdateInstaller`] the GPUI app wires later
//!   (the TS `autoUpdater.quitAndInstall`).
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

pub mod audio;
pub mod accessibility;
pub mod dictation_coordinator;
pub mod hotkey;
pub mod local_runtime_status;
pub mod menu;
pub mod notify;
pub mod paste;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_matches_app_id() {
        assert_eq!(KEYCHAIN_SERVICE, APP_BUNDLE_ID);
    }
}

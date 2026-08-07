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
//!   a minimal semver-ish version comparison, and the `UpdateProvider` trait
//!   with a no-op stub (no Sparkle/electron-updater replacement yet).
//! - **`menu`** — the native-menu command contract (`native-menu-command-contract`):
//!   which commands the app menu owns and the accelerator ownership assertion.
//!
//! macOS-only APIs are behind `#[cfg(target_os = "macos")]`; the rest of the
//! crate provides graceful stubs so `cargo test` passes on any host.

pub mod hotkey;
pub mod menu;
pub mod notify;
pub mod paste;
pub mod quit_barrier;
pub mod readiness;
pub mod tray;
pub mod updater;

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

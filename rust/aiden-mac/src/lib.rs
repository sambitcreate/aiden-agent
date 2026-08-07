//! Aiden macOS integration — scaffold.
//!
//! Phase 3 placeholder. This crate will port `main/platform.ts` and the macOS
//! surfaces GPUI does not ship:
//!
//! - **Secrets** — `keyring` (apple-native) replacing Electron `safeStorage`
//!   (Keychain Services); the credential/binding policy from
//!   `provider-key-policy.ts` (exact id + kind + baseUrl + needsKey match
//!   before a stored key may be used, quarantine slots for externally rotated
//!   keys).
//! - **Global hotkeys** — `global-hotkey` (Accessibility permission flow),
//!   channel-polling from a GPUI foreground task; the assistant dock hotkey.
//! - **Notifications** — `objc2-user-notifications` (UNUserNotificationCenter)
//!   with click-to-open-chat deep links; in-app toasts via
//!   gpui-component `push_notification` while focused.
//! - **Tray / dock / activation policy** — `tray-icon` for menu-bar status
//!   item; activation policy via objc2 (hide Dock icon in menu-bar-only mode).
//! - **Auto-update** — Sparkle 2 bundle plumbing (framework copy, rpath,
//!   appcast, EdDSA keys, signing/notarization).
//! - **Vibrancy** — the Electron window used `hiddenInset` vibrancy; GPUI
//!   offers `WindowBackgroundAppearance::Blurred` window background plus
//!   in-content translucency painting.
//!
//! The default service name for Keychain entries is part of the port contract
//! and defined here so both the secret store and providers agree.

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

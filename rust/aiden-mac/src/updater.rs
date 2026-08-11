//! App updates — port of `main/services/app-updater-core.ts` plus the
//! `UpdateProvider` seam. Unpackaged builds use the inert
//! [`NoopUpdateProvider`]; packaged macOS builds may provide the generic-feed
//! implementation from `feed_update_provider`.

use std::cmp::Ordering;

use aiden_core::app_update::{AppUpdateSnapshot, IDLE_APP_UPDATE_SNAPSHOT};
use futures::future::BoxFuture;
use futures::FutureExt;

/// `NodeJS.Platform`-equivalent, narrowed to what Aiden ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppPlatform {
    Darwin,
    Other,
}

impl AppPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Other
        }
    }
}

/// `RuntimeProfile`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeProfile {
    Production,
    Development,
}

/// `AppUpdaterEnvironment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppUpdaterEnvironment {
    pub is_packaged: bool,
    pub platform: AppPlatform,
    pub runtime_profile: RuntimeProfile,
    pub update_config_exists: bool,
}

/// `shouldEnableAppUpdates` — updates only in packaged production macOS builds
/// that embed feed metadata.
pub fn should_enable_app_updates(environment: &AppUpdaterEnvironment) -> bool {
    environment.platform == AppPlatform::Darwin
        && environment.is_packaged
        && environment.runtime_profile == RuntimeProfile::Production
        && environment.update_config_exists
}

// ===========================================================================
// Version comparison (electron-updater's `isVersionHigher` semantics)
// ===========================================================================

/// Split a version into numeric dotted parts, ignoring prerelease/build
/// suffixes (semver `core`).
fn numeric_parts(value: &str) -> Option<Vec<u64>> {
    let core = value.trim().split(['-', '+']).next()?;
    let parts: Vec<u64> = core
        .split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

/// Compare two dotted version strings component-wise (`a > b` means `a` is
/// higher). Returns `None` when either side is unparseable.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let a = numeric_parts(a)?;
    let b = numeric_parts(b)?;
    let max = a.len().max(b.len());
    for index in 0..max {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        match left.cmp(&right) {
            Ordering::Equal => continue,
            ordering => return Some(ordering),
        }
    }
    Some(Ordering::Equal)
}

/// `isVersionHigher(latest, current)`.
pub fn is_version_higher(latest: &str, current: &str) -> Option<bool> {
    compare_versions(latest, current).map(|ordering| ordering == Ordering::Greater)
}

/// Channel policy: prerelease versions are never auto-installed
/// (`allowPrerelease = false`).
pub fn is_prerelease(version: &str) -> bool {
    version.contains('-')
}

/// `allowDowngrade = false` — an equal or older candidate is not an update.
pub fn should_offer_update(latest: &str, current: &str) -> Option<bool> {
    is_version_higher(latest, current).map(|higher| higher && !is_prerelease(latest))
}

// ===========================================================================
// UpdateProvider seam
// ===========================================================================

/// The outcome of a manual check (the parts of the TS dialog decisions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheckOutcome {
    pub is_update_available: bool,
    pub latest_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UpdateCheckError {
    #[error("Updates are not configured in this build.")]
    Unavailable,
    #[error("The update feed could not be reached: {0}")]
    Network(String),
}

/// The seam a real updater (Sparkle etc.) implements. The GPUI app owns one
/// provider and subscribes to its snapshots via `aiden-core`'s
/// `AppUpdateSnapshot`.
pub trait UpdateProvider: Send + Sync {
    /// The current downloadable-update state (`app:update-state` broadcast).
    fn snapshot(&self) -> AppUpdateSnapshot;
    /// Check for updates. `manual` distinguishes the user-initiated path (the
    /// TS dialogs) from the scheduled check.
    fn check_now(
        &self,
        manual: bool,
    ) -> BoxFuture<'static, Result<UpdateCheckOutcome, UpdateCheckError>>;
    /// Open a previously verified downloaded installer after an explicit user
    /// action (`false` when none is ready).
    ///
    /// This seam is deliberately manual-only. The standalone GPUI process has
    /// no signed external updater/Squirrel.Mac handoff that can replace its
    /// running `.app` and relaunch it safely on quit, so callers must not treat
    /// this as an automatic install-on-quit operation.
    fn open_downloaded_installer(&self) -> bool;
    /// Start the background check schedule (15s initial delay + 6h interval).
    fn start(&self);
}

/// The stub provider: never contacts the network, always idle.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopUpdateProvider;

impl UpdateProvider for NoopUpdateProvider {
    fn snapshot(&self) -> AppUpdateSnapshot {
        IDLE_APP_UPDATE_SNAPSHOT
    }
    fn check_now(
        &self,
        _manual: bool,
    ) -> BoxFuture<'static, Result<UpdateCheckOutcome, UpdateCheckError>> {
        async { Err(UpdateCheckError::Unavailable) }.boxed()
    }
    fn open_downloaded_installer(&self) -> bool {
        false
    }
    fn start(&self) {}
}

/// Convenience for tests: adapt a closure into a provider.
pub struct FnUpdateProvider<F> {
    snapshot: F,
}

impl<F> FnUpdateProvider<F>
where
    F: Fn() -> AppUpdateSnapshot + Send + Sync + 'static,
{
    pub fn new(snapshot: F) -> Self {
        Self { snapshot }
    }
}

impl<F> UpdateProvider for FnUpdateProvider<F>
where
    F: Fn() -> AppUpdateSnapshot + Send + Sync + 'static,
{
    fn snapshot(&self) -> AppUpdateSnapshot {
        (self.snapshot)()
    }
    fn check_now(
        &self,
        _manual: bool,
    ) -> BoxFuture<'static, Result<UpdateCheckOutcome, UpdateCheckError>> {
        async { Err(UpdateCheckError::Unavailable) }.boxed()
    }
    fn open_downloaded_installer(&self) -> bool {
        false
    }
    fn start(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(
        is_packaged: bool,
        platform: AppPlatform,
        runtime_profile: RuntimeProfile,
        update_config_exists: bool,
    ) -> AppUpdaterEnvironment {
        AppUpdaterEnvironment {
            is_packaged,
            platform,
            runtime_profile,
            update_config_exists,
        }
    }

    #[test]
    fn auto_updates_require_a_packaged_macos_app_with_embedded_feed_metadata() {
        assert!(should_enable_app_updates(&env(
            true,
            AppPlatform::Darwin,
            RuntimeProfile::Production,
            true
        )));
        assert!(!should_enable_app_updates(&env(
            false,
            AppPlatform::Darwin,
            RuntimeProfile::Production,
            true
        )));
        assert!(!should_enable_app_updates(&env(
            true,
            AppPlatform::Darwin,
            RuntimeProfile::Production,
            false
        )));
        assert!(!should_enable_app_updates(&env(
            true,
            AppPlatform::Other,
            RuntimeProfile::Production,
            true
        )));
    }

    #[test]
    fn development_profiles_never_contact_the_production_update_feed() {
        assert!(!should_enable_app_updates(&env(
            true,
            AppPlatform::Darwin,
            RuntimeProfile::Development,
            true
        )));
    }

    #[test]
    fn version_comparison_matches_semver_core_ordering() {
        assert_eq!(is_version_higher("0.27.25", "0.27.24"), Some(true));
        assert_eq!(is_version_higher("0.27.24", "0.27.25"), Some(false));
        assert_eq!(is_version_higher("0.28.0", "0.27.99"), Some(true));
        assert_eq!(is_version_higher("1.0.0", "0.9.9"), Some(true));
        assert_eq!(is_version_higher("0.27.25", "0.27.25"), Some(false));
        // Short vs long components zero-pad.
        assert_eq!(is_version_higher("0.28", "0.27.9"), Some(true));
        assert_eq!(is_version_higher("0.28.0", "0.28"), Some(false));
        // Prerelease/build suffixes are ignored for the comparison.
        assert_eq!(is_version_higher("0.27.25-beta.1", "0.27.24"), Some(true));
        // Unparseable input fails closed.
        assert_eq!(is_version_higher("latest", "0.27.25"), None);
    }

    #[test]
    fn channel_policy_never_offers_prerelease_or_downgrades() {
        assert_eq!(should_offer_update("0.27.25", "0.27.24"), Some(true));
        assert_eq!(
            should_offer_update("0.27.25-beta.1", "0.27.24"),
            Some(false)
        );
        assert_eq!(should_offer_update("0.27.24", "0.27.25"), Some(false));
        assert!(is_prerelease("0.27.25-beta.1"));
        assert!(!is_prerelease("0.27.25"));
    }

    #[test]
    fn noop_provider_never_contacts_a_feed() {
        let provider = NoopUpdateProvider;
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
        assert!(!provider.open_downloaded_installer());
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(provider.check_now(false));
        assert!(matches!(result, Err(UpdateCheckError::Unavailable)));
    }
}

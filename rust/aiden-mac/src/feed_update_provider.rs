//! Real update provider — port of the `electron-updater` generic-feed flow
//! wired by `main/services/app-updater.ts`, behind the `update-feed` cargo
//! feature (off by default so ordinary builds never touch a feed).
//!
//! [`FeedUpdateProvider`] implements the existing [`UpdateProvider`] seam from
//! `crate::updater`:
//!
//! 1. Fetch the feed manifest (JSON, see `crate::updater_feed`), strict-parse.
//! 2. Apply channel policy (`should_offer_update`: semver compare, prerelease
//!    rejection, no-downgrade).
//! 3. Download the artifact, verify its exact bytes against the feed's
//!    sha-256, and stage it to a temp file.
//! 4. The **install step is a trait method** ([`UpdateInstaller`]) the GPUI
//!    binary wires later — replacing a running `.app` and relaunching is
//!    inherently distribution glue (the TS `autoUpdater.quitAndInstall`).
//!
//! The network surface is injectable ([`FeedClient`]); tests never touch the
//! network.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures::{future::BoxFuture, FutureExt};

use crate::updater::{should_offer_update, UpdateCheckError, UpdateCheckOutcome, UpdateProvider};
use crate::updater_feed::{
    choose_update_file, parse_update_feed, verify_download_sha256, MAX_FEED_BYTES, MAX_UPDATE_BYTES,
};
use aiden_core::app_update::{AppUpdateSnapshot, IDLE_APP_UPDATE_SNAPSHOT};

const INITIAL_CHECK_DELAY_MS: u64 = 15_000;
const CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1_000;

/// The staged download directory prefix (kept in the system temp dir).
const STAGED_UPDATE_PREFIX: &str = "aiden-update-";

/// Injectable byte-fetch surface. Production uses [`ReqwestFeedClient`];
/// tests inject fixtures.
#[async_trait::async_trait]
pub trait FeedClient: Send + Sync {
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// The production transport (reqwest + rustls).
pub struct ReqwestFeedClient {
    client: reqwest::Client,
    timeout: Duration,
}

impl Default for ReqwestFeedClient {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder().build().unwrap_or_else(|error| {
                tracing::warn!(%error, "could not build the update feed HTTP client");
                reqwest::Client::new()
            }),
            timeout: Duration::from_secs(30),
        }
    }
}

#[async_trait::async_trait]
impl FeedClient for ReqwestFeedClient {
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let response = tokio::time::timeout(self.timeout, self.client.get(url).send())
            .await
            .map_err(|_| "request timed out".to_string())?
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "update server returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok(bytes.to_vec())
    }
}

/// The install step the binary wires later: quit-and-replace the running app
/// with the staged update. `false` when the app cannot restart right now.
pub trait UpdateInstaller: Send + Sync {
    fn install_and_restart(&self, downloaded: &Path) -> bool;
}

/// A no-op installer used until the GPUI app wires the real one.
pub struct NoopUpdateInstaller;

impl UpdateInstaller for NoopUpdateInstaller {
    fn install_and_restart(&self, _downloaded: &Path) -> bool {
        false
    }
}

struct ProviderState {
    snapshot: AppUpdateSnapshot,
    downloaded_path: Option<PathBuf>,
    downloaded_version: Option<String>,
    started: bool,
}

impl Default for ProviderState {
    fn default() -> Self {
        Self {
            snapshot: IDLE_APP_UPDATE_SNAPSHOT,
            downloaded_path: None,
            downloaded_version: None,
            started: false,
        }
    }
}

struct ProviderShared {
    feed_url: String,
    current_version: String,
    client: std::sync::Arc<dyn FeedClient>,
    installer: std::sync::Arc<dyn UpdateInstaller>,
    state: Mutex<ProviderState>,
}

/// A real `UpdateProvider` driven by a JSON feed (electron-updater generic
/// provider equivalent).
#[derive(Clone)]
pub struct FeedUpdateProvider {
    shared: std::sync::Arc<ProviderShared>,
}

impl FeedUpdateProvider {
    pub fn new(feed_url: impl Into<String>, current_version: impl Into<String>) -> Self {
        Self::with_client_and_installer(
            feed_url,
            current_version,
            std::sync::Arc::new(ReqwestFeedClient::default()),
            std::sync::Arc::new(NoopUpdateInstaller),
        )
    }

    pub fn with_client_and_installer(
        feed_url: impl Into<String>,
        current_version: impl Into<String>,
        client: std::sync::Arc<dyn FeedClient>,
        installer: std::sync::Arc<dyn UpdateInstaller>,
    ) -> Self {
        Self {
            shared: std::sync::Arc::new(ProviderShared {
                feed_url: feed_url.into(),
                current_version: current_version.into(),
                client,
                installer,
                state: Mutex::new(ProviderState::default()),
            }),
        }
    }

    async fn check_inner(&self, manual: bool) -> Result<UpdateCheckOutcome, UpdateCheckError> {
        let _ = manual;
        let feed_bytes = self
            .shared
            .client
            .get_bytes(&self.shared.feed_url)
            .await
            .map_err(UpdateCheckError::Network)?;
        if feed_bytes.len() as u64 > MAX_FEED_BYTES {
            return Err(UpdateCheckError::Network(
                "update feed exceeded its size limit".to_string(),
            ));
        }
        let feed_value = serde_json::from_slice(&feed_bytes).map_err(|error| {
            UpdateCheckError::Network(format!("malformed update feed: {error}"))
        })?;
        let Some(manifest) = parse_update_feed(&feed_value) else {
            return Err(UpdateCheckError::Network(
                "update feed failed its integrity validation".to_string(),
            ));
        };
        let latest = manifest.version.clone();
        match should_offer_update(&latest, &self.shared.current_version) {
            Some(true) => {
                let Some(file) = choose_update_file(&manifest) else {
                    return Err(UpdateCheckError::Network(
                        "update feed declared no downloadable artifact".to_string(),
                    ));
                };
                let bytes = self
                    .shared
                    .client
                    .get_bytes(&file.url)
                    .await
                    .map_err(UpdateCheckError::Network)?;
                if bytes.len() as u64 > MAX_UPDATE_BYTES {
                    return Err(UpdateCheckError::Network(
                        "update artifact exceeded its size limit".to_string(),
                    ));
                }
                if !verify_download_sha256(&bytes, &file.sha256) {
                    return Err(UpdateCheckError::Network(
                        "downloaded update failed its SHA-256 integrity check".to_string(),
                    ));
                }
                let staged = stage_download(&latest, &bytes)?;
                let mut state = self.shared.state.lock().unwrap();
                state.downloaded_path = Some(staged);
                state.downloaded_version = Some(latest.clone());
                state.snapshot = AppUpdateSnapshot::Ready {
                    version: latest.clone(),
                };
                Ok(UpdateCheckOutcome {
                    is_update_available: true,
                    latest_version: Some(latest),
                })
            }
            Some(false) => Ok(UpdateCheckOutcome {
                is_update_available: false,
                latest_version: Some(latest),
            }),
            // Unparseable versions fail closed: never offer an update.
            None => Ok(UpdateCheckOutcome {
                is_update_available: false,
                latest_version: None,
            }),
        }
    }
}

impl UpdateProvider for FeedUpdateProvider {
    fn snapshot(&self) -> AppUpdateSnapshot {
        self.shared.state.lock().unwrap().snapshot.clone()
    }

    fn check_now(
        &self,
        manual: bool,
    ) -> BoxFuture<'static, Result<UpdateCheckOutcome, UpdateCheckError>> {
        let this = self.clone();
        async move { this.check_inner(manual).await }.boxed()
    }

    fn install_downloaded(&self) -> bool {
        let path = self.shared.state.lock().unwrap().downloaded_path.clone();
        let Some(path) = path else {
            return false;
        };
        self.shared.installer.install_and_restart(&path)
    }

    fn start(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if state.started {
            return;
        }
        state.started = true;
        drop(state);
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(INITIAL_CHECK_DELAY_MS)).await;
            let _ = this.check_now(false).await;
        });
        let interval_this = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(CHECK_INTERVAL_MS)).await;
                let _ = interval_this.check_now(false).await;
            }
        });
    }
}

fn stage_download(version: &str, bytes: &[u8]) -> Result<PathBuf, UpdateCheckError> {
    let directory = tempfile::Builder::new()
        .prefix(STAGED_UPDATE_PREFIX)
        .tempdir()
        .map_err(|error| UpdateCheckError::Network(format!("could not stage update: {error}")))?;
    let path = directory.path().join(format!("Aiden-{version}.update"));
    // Write synchronously to a private temp dir, then leak the directory so
    // the staged file survives until the installer consumes it (the install
    // step owns cleanup of the staged payload).
    std::fs::write(&path, bytes)
        .map_err(|error| UpdateCheckError::Network(format!("could not stage update: {error}")))?;
    let _ = std::mem::ManuallyDrop::new(directory);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::UpdateProvider;
    use sha2::Digest;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    fn sha256_of(bytes: &[u8]) -> String {
        let mut hasher = sha2::Sha256::new();
        hasher.update(bytes);
        let digest = hasher.finalize();
        let mut encoded = String::with_capacity(64);
        for byte in digest {
            encoded.push_str(&format!("{byte:02x}"));
        }
        encoded
    }

    fn feed_json(version: &str, sha256: &str) -> String {
        serde_json::json!({
            "version": version,
            "files": [{
                "url": "https://cdn.example.com/Aiden-Agent.dmg",
                "sha256": sha256,
                "size": 4,
            }],
        })
        .to_string()
    }

    struct FakeClient {
        feed_url: String,
        feed: String,
        artifact: Vec<u8>,
        requests: std::sync::Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl FeedClient for FakeClient {
        async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
            self.requests.fetch_add(1, AtomicOrdering::SeqCst);
            if url == self.feed_url {
                Ok(self.feed.as_bytes().to_vec())
            } else {
                Ok(self.artifact.clone())
            }
        }
    }

    fn fake_client(
        feed: String,
        artifact: Vec<u8>,
    ) -> (std::sync::Arc<FakeClient>, std::sync::Arc<AtomicUsize>) {
        fake_client_with_feed_url("feed", feed, artifact)
    }

    fn fake_client_with_feed_url(
        feed_url: &str,
        feed: String,
        artifact: Vec<u8>,
    ) -> (std::sync::Arc<FakeClient>, std::sync::Arc<AtomicUsize>) {
        let requests = std::sync::Arc::new(AtomicUsize::new(0));
        let client = std::sync::Arc::new(FakeClient {
            feed_url: feed_url.to_string(),
            feed,
            artifact,
            requests: requests.clone(),
        });
        (client, requests)
    }

    #[tokio::test]
    async fn downloads_verifies_and_stages_an_offered_update() {
        let artifact = b"the exact artifact bytes".to_vec();
        let digest = sha256_of(&artifact);
        let (client, requests) = fake_client_with_feed_url(
            "https://cdn.example.com/feed.json",
            feed_json("0.28.0", &digest),
            artifact,
        );
        let provider = FeedUpdateProvider::with_client_and_installer(
            "https://cdn.example.com/feed.json",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        let outcome = provider.check_now(false).await.unwrap();
        assert!(outcome.is_update_available);
        assert_eq!(outcome.latest_version.as_deref(), Some("0.28.0"));
        assert_eq!(requests.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(
            provider.snapshot(),
            AppUpdateSnapshot::Ready {
                version: "0.28.0".to_string()
            }
        );
        // The install step delegates to the installer (no-op by default).
        assert!(!provider.install_downloaded());
    }

    #[tokio::test]
    async fn an_equal_or_older_version_is_never_offered_or_staged() {
        let artifact = b"bytes".to_vec();
        let digest = sha256_of(&artifact);
        let (client, requests) = fake_client(feed_json("0.27.25", &digest), artifact);
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.28.0",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        let outcome = provider.check_now(false).await.unwrap();
        assert!(!outcome.is_update_available);
        assert_eq!(outcome.latest_version.as_deref(), Some("0.27.25"));
        // Only the feed was fetched; no artifact download.
        assert_eq!(requests.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }

    #[tokio::test]
    async fn prerelease_candidates_are_rejected_by_channel_policy() {
        let artifact = b"bytes".to_vec();
        let digest = sha256_of(&artifact);
        let (client, _requests) = fake_client(feed_json("0.28.0-beta.1", &digest), artifact);
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        let outcome = provider.check_now(false).await.unwrap();
        assert!(!outcome.is_update_available);
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }

    #[tokio::test]
    async fn an_integrity_mismatch_never_stages_the_download() {
        let (client, _requests) = fake_client(
            feed_json("0.28.0", &"a".repeat(64)),
            b"tampered bytes".to_vec(),
        );
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        let error = provider.check_now(false).await.unwrap_err();
        assert!(matches!(error, UpdateCheckError::Network(message) if message.contains("SHA-256")));
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }

    #[tokio::test]
    async fn a_malformed_feed_fails_closed() {
        let (client, _requests) = fake_client("{ not json".to_string(), Vec::new());
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        let error = provider.check_now(true).await.unwrap_err();
        assert!(matches!(error, UpdateCheckError::Network(_)));
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }

    #[tokio::test]
    async fn start_runs_the_scheduled_check_loop_once() {
        let artifact = b"bytes".to_vec();
        let digest = sha256_of(&artifact);
        let (client, requests) = fake_client(feed_json("0.28.0", &digest), artifact);
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        provider.start();
        provider.start();
        // `start` is idempotent; the scheduled checks fire after a delay, so
        // nothing was fetched synchronously.
        assert_eq!(requests.load(AtomicOrdering::SeqCst), 0);
    }

    struct RecordInstaller {
        called: std::sync::Arc<AtomicUsize>,
    }

    impl UpdateInstaller for RecordInstaller {
        fn install_and_restart(&self, _downloaded: &Path) -> bool {
            self.called.fetch_add(1, AtomicOrdering::SeqCst);
            true
        }
    }

    #[tokio::test]
    async fn install_downloaded_hands_the_staged_path_to_the_installer() {
        let artifact = b"the exact artifact bytes".to_vec();
        let digest = sha256_of(&artifact);
        let (client, _requests) = fake_client(feed_json("0.28.0", &digest), artifact);
        let called = std::sync::Arc::new(AtomicUsize::new(0));
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(RecordInstaller {
                called: called.clone(),
            }),
        );
        provider.check_now(false).await.unwrap();
        assert!(provider.install_downloaded());
        assert_eq!(called.load(AtomicOrdering::SeqCst), 1);
        // Without a staged update, the installer is never invoked.
        let (client2, _) = fake_client(feed_json("0.27.24", &digest), b"bytes".to_vec());
        let provider2 = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client2,
            std::sync::Arc::new(RecordInstaller {
                called: called.clone(),
            }),
        );
        assert!(!provider2.install_downloaded());
        assert_eq!(called.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn snapshot_starts_idle() {
        let (client, _) = fake_client(String::new(), Vec::new());
        let provider = FeedUpdateProvider::with_client_and_installer(
            "feed",
            "0.27.25",
            client,
            std::sync::Arc::new(NoopUpdateInstaller),
        );
        assert_eq!(provider.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }
}

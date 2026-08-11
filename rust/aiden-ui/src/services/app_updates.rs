//! App-lifetime update authority.
//!
//! The authority owns the one native update provider for the process and
//! republishes its bounded [`aiden_core::app_update::AppUpdateSnapshot`] over
//! a watch channel. The GPUI shell never performs network work directly:
//! checks and the background schedule run on the tokio bridge, while the
//! renderer-facing state remains a local immutable snapshot.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aiden_core::app_update::{AppUpdateSnapshot, IDLE_APP_UPDATE_SNAPSHOT};
use aiden_mac::updater::{UpdateCheckError, UpdateCheckOutcome, UpdateProvider};

#[derive(Clone)]
pub struct AppUpdateAuthority {
    provider: Arc<dyn UpdateProvider>,
    snapshot: Arc<Mutex<AppUpdateSnapshot>>,
    updates: tokio::sync::watch::Sender<AppUpdateSnapshot>,
    started: Arc<AtomicBool>,
}

impl AppUpdateAuthority {
    pub fn new(provider: Arc<dyn UpdateProvider>) -> Arc<Self> {
        let (updates, _) = tokio::sync::watch::channel(IDLE_APP_UPDATE_SNAPSHOT);
        Arc::new(Self {
            provider,
            snapshot: Arc::new(Mutex::new(IDLE_APP_UPDATE_SNAPSHOT)),
            updates,
            started: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Construct the production provider without contacting the network.
    /// `packaged_update_feed_url` only returns a URL for a signed bundled
    /// release with an embedded generic-feed marker; all other builds use the
    /// inert provider.
    pub fn production() -> Arc<Self> {
        #[cfg(feature = "update-feed")]
        {
            if let Some(feed_url) = aiden_mac::packaged_update_feed_url() {
                return Self::new(Arc::new(
                    aiden_mac::feed_update_provider::FeedUpdateProvider::new(
                        feed_url,
                        env!("CARGO_PKG_VERSION"),
                    ),
                ));
            }
        }
        Self::new(Arc::new(aiden_mac::updater::NoopUpdateProvider))
    }

    pub fn snapshot(&self) -> AppUpdateSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or(IDLE_APP_UPDATE_SNAPSHOT)
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<AppUpdateSnapshot> {
        self.updates.subscribe()
    }

    /// Start the provider's 15-second/6-hour schedule. This method must be
    /// called from the tokio bridge because a real feed provider owns tokio
    /// timers; the GPUI caller is responsible for that boundary.
    pub fn start(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.provider.start();
    }

    fn publish_provider_snapshot(&self) {
        let snapshot = self.provider.snapshot();
        if let Ok(mut current) = self.snapshot.lock() {
            *current = snapshot.clone();
        }
        let _ = self.updates.send(snapshot);
    }

    pub async fn check_now(&self, manual: bool) -> Result<UpdateCheckOutcome, UpdateCheckError> {
        let result = self.provider.check_now(manual).await;
        self.publish_provider_snapshot();
        result
    }

    /// Open the exact, digest-verified artifact after an explicit user action.
    /// Automatic install-on-quit is intentionally not exposed: the standalone
    /// GPUI process has no signed external updater handoff to replace and
    /// relaunch its running `.app` safely.
    pub fn open_downloaded_installer(&self) -> bool {
        self.provider.open_downloaded_installer()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_mac::updater::{UpdateCheckOutcome, UpdateProvider};
    use futures::future::BoxFuture;

    struct ReadyProvider;

    impl UpdateProvider for ReadyProvider {
        fn snapshot(&self) -> AppUpdateSnapshot {
            AppUpdateSnapshot::Ready {
                version: "9.9.9".into(),
            }
        }

        fn check_now(
            &self,
            _manual: bool,
        ) -> BoxFuture<'static, Result<UpdateCheckOutcome, UpdateCheckError>> {
            Box::pin(async {
                Ok(UpdateCheckOutcome {
                    is_update_available: true,
                    latest_version: Some("9.9.9".into()),
                })
            })
        }

        fn open_downloaded_installer(&self) -> bool {
            true
        }

        fn start(&self) {}
    }

    #[tokio::test]
    async fn check_publishes_provider_snapshot_and_install_delegates() {
        let authority = AppUpdateAuthority::new(Arc::new(ReadyProvider));
        let mut receiver = authority.subscribe();
        let outcome = authority.check_now(true).await.unwrap();
        assert!(outcome.is_update_available);
        receiver.changed().await.unwrap();
        assert_eq!(
            *receiver.borrow(),
            AppUpdateSnapshot::Ready {
                version: "9.9.9".into()
            }
        );
        assert!(authority.open_downloaded_installer());
    }

    #[test]
    fn production_authority_is_idle_without_a_bundled_feed() {
        let authority = AppUpdateAuthority::production();
        assert_eq!(authority.snapshot(), IDLE_APP_UPDATE_SNAPSHOT);
    }
}

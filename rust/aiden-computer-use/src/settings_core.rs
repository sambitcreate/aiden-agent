//! Durable Computer Use beta-gate coordinator (port of
//! `main/services/computer-use/settings-core.ts`).
//!
//! Serializes persisted enable/disable transitions while closing the live gate
//! eagerly. Disabling is a kill switch: it must not wait for the filesystem or
//! an older queued transition, and a persistence failure never reopens the
//! process.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use futures::future::BoxFuture;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

/// Error taxonomy for the settings coordinator. Messages mirror the TypeScript
/// `Error` texts so callers and tests can match on them.
#[derive(Debug, thiserror::Error)]
pub enum ComputerUseSettingsError {
    #[error("The renderer document is no longer active.")]
    StaleDocument,
    #[error("Computer Use settings are shutting down.")]
    ShuttingDown,
    #[error("Computer Use could not persist its disabled state before quit.")]
    NotDurable,
    #[error(transparent)]
    Persist(#[from] anyhow::Error),
}

pub type SettingsPersistenceResult = Result<(), ComputerUseSettingsError>;

/// The persistence/gate seam the coordinator drives.
pub trait ComputerUseSettingsDependencies: Send + Sync + 'static {
    /// The persisted gate state (`computerUseEnabled === true`).
    fn read_persisted(&self) -> BoxFuture<'static, bool>;
    /// Persist the gate state. `is_current` reports whether the owning
    /// renderer document is still current (like `configStore.setSettings`).
    fn persist(
        &self,
        enabled: bool,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BoxFuture<'static, SettingsPersistenceResult>;
    /// Apply the live gate immediately (never awaits persistence).
    fn set_runtime_enabled(&self, enabled: bool);
    /// Cancel every generation that holds a Computer Use controller.
    fn cancel_computer_use_generations(&self);
}

/// A default wiring for `settings.ts` backed by Aiden's `ConfigStore` (the Rust
/// port of `configStore.setSettings`): reads and writes the `computerUseEnabled`
/// key in the machine-local settings JSON.
pub fn computer_use_settings_dependencies_from_store(
    store: Arc<aiden_data::config_store::ConfigStore>,
) -> impl ComputerUseSettingsDependencies {
    struct StoreDependencies {
        store: Arc<aiden_data::config_store::ConfigStore>,
    }
    impl ComputerUseSettingsDependencies for StoreDependencies {
        fn read_persisted(&self) -> BoxFuture<'static, bool> {
            let store = Arc::clone(&self.store);
            Box::pin(async move {
                let settings = store.get_settings().unwrap_or_default();
                settings
                    .get("computerUseEnabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            })
        }

        fn persist(
            &self,
            enabled: bool,
            is_current: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> BoxFuture<'static, SettingsPersistenceResult> {
            let store = Arc::clone(&self.store);
            Box::pin(async move {
                let mut patch = serde_json::Map::new();
                patch.insert(
                    "computerUseEnabled".into(),
                    serde_json::Value::Bool(enabled),
                );
                store
                    .set_settings(&patch, &move || is_current())
                    .map(|_| ())
                    .map_err(|error| ComputerUseSettingsError::Persist(anyhow::anyhow!(error)))
            })
        }

        fn set_runtime_enabled(&self, _enabled: bool) {}

        fn cancel_computer_use_generations(&self) {}
    }
    StoreDependencies { store }
}

#[derive(Default)]
struct CoordinatorShared {
    latest_request: AtomicU64,
    desired_enabled: StdMutex<Option<bool>>,
    disable_required: StdMutex<bool>,
    closed: StdMutex<bool>,
}

fn stale_document_error() -> ComputerUseSettingsError {
    ComputerUseSettingsError::StaleDocument
}

fn always_current() -> Arc<dyn Fn() -> bool + Send + Sync> {
    Arc::new(|| true)
}

/// Coordinates persisted gate changes with the live gate.
pub struct ComputerUseSettingsCoordinator {
    tail: Mutex<Option<JoinHandle<()>>>,
    shutdown_promise: StdMutex<Option<BoxFuture<'static, Result<(), ComputerUseSettingsError>>>>,
    shared: Arc<CoordinatorShared>,
    dependencies: Arc<dyn ComputerUseSettingsDependencies>,
}

impl ComputerUseSettingsCoordinator {
    pub fn new(dependencies: Arc<dyn ComputerUseSettingsDependencies>) -> Self {
        Self {
            tail: Mutex::new(None),
            shutdown_promise: StdMutex::new(None),
            shared: Arc::new(CoordinatorShared::default()),
            dependencies,
        }
    }

    /// Seal new mutations and drain every admitted persistence transaction
    /// before quit. A required disable that cannot become durable is an error.
    pub async fn shutdown(&self) -> Result<(), ComputerUseSettingsError> {
        {
            let existing = self.shutdown_promise.lock().unwrap().take();
            if let Some(existing) = existing {
                return existing.await;
            }
        }
        *self.shared.closed.lock().unwrap() = true;
        let tail = self.tail.lock().await.take();
        let dependencies = Arc::clone(&self.dependencies);
        let shared = Arc::clone(&self.shared);
        let promise: BoxFuture<'static, Result<(), ComputerUseSettingsError>> =
            Box::pin(async move {
                if let Some(tail) = tail {
                    let _ = tail.await;
                }
                if !*shared.disable_required.lock().unwrap() {
                    return Ok(());
                }
                if !dependencies.read_persisted().await {
                    return Ok(());
                }
                dependencies.persist(false, always_current()).await?;
                if dependencies.read_persisted().await {
                    return Err(ComputerUseSettingsError::NotDurable);
                }
                Ok(())
            });
        let existing = self.shutdown_promise.lock().unwrap().take();
        if let Some(existing) = existing {
            return existing.await;
        }
        {
            let mut slot = self.shutdown_promise.lock().unwrap();
            *slot = Some(promise);
        }
        let promise = self
            .shutdown_promise
            .lock()
            .unwrap()
            .take()
            .expect("stored");
        promise.await
    }

    /// Reopen only when quit was cancelled before irreversible service shutdown.
    pub fn resume_after_cancelled_shutdown(&self) {
        *self.shared.closed.lock().unwrap() = false;
        *self.shutdown_promise.lock().unwrap() = None;
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), ComputerUseSettingsError> {
        if *self.shared.closed.lock().unwrap() {
            return Err(ComputerUseSettingsError::ShuttingDown);
        }
        if !is_current() {
            return Err(stale_document_error());
        }
        let request = self.shared.latest_request.fetch_add(1, Ordering::SeqCst) + 1;
        *self.shared.desired_enabled.lock().unwrap() = Some(enabled);

        // Closing is a kill switch, so it must not wait for the filesystem or
        // an older queued transition. Persistence failure never reopens this
        // process.
        if !enabled {
            *self.shared.disable_required.lock().unwrap() = true;
            self.dependencies.set_runtime_enabled(false);
            self.dependencies.cancel_computer_use_generations();
        }

        let dependencies = Arc::clone(&self.dependencies);
        let shared = Arc::clone(&self.shared);
        let (sender, receiver) = oneshot::channel();
        let mut tail_guard = self.tail.lock().await;
        let previous = tail_guard.take();
        let operation = tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let result = apply(
                dependencies.as_ref(),
                &shared,
                request,
                enabled,
                &is_current,
            )
            .await;
            let _ = sender.send(result);
        });
        *tail_guard = Some(operation);
        drop(tail_guard);
        receiver
            .await
            .unwrap_or(Err(ComputerUseSettingsError::ShuttingDown))
    }
}

async fn apply(
    dependencies: &dyn ComputerUseSettingsDependencies,
    shared: &CoordinatorShared,
    request: u64,
    enabled: bool,
    is_current: &Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<(), ComputerUseSettingsError> {
    if !enabled {
        // Disabling is a kill switch admitted while the owner was current. It
        // remains safe and must become durable even if that document exits.
        dependencies.persist(false, always_current()).await?;
        return Ok(());
    }

    if !is_current() {
        return Err(stale_document_error());
    }

    let previous = dependencies.read_persisted().await;
    if !is_current()
        || request != shared.latest_request.load(Ordering::SeqCst)
        || *shared.desired_enabled.lock().unwrap() != Some(true)
    {
        return Err(stale_document_error());
    }

    if let Err(error) = dependencies.persist(true, Arc::clone(is_current)).await {
        let rollback = if *shared.disable_required.lock().unwrap()
            || *shared.desired_enabled.lock().unwrap() == Some(false)
        {
            false
        } else {
            previous
        };
        dependencies.set_runtime_enabled(rollback);
        return Err(error);
    }

    let desired_after = *shared.desired_enabled.lock().unwrap();
    if !is_current()
        || request != shared.latest_request.load(Ordering::SeqCst)
        || desired_after != Some(true)
    {
        let rollback = if *shared.disable_required.lock().unwrap() || desired_after == Some(false) {
            false
        } else {
            previous
        };
        dependencies.set_runtime_enabled(rollback);
        dependencies.persist(rollback, always_current()).await?;
        return Err(stale_document_error());
    }

    *shared.disable_required.lock().unwrap() = false;
    dependencies.set_runtime_enabled(true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use tokio::time::Duration;

    struct FakeDependencies {
        durable: Arc<StdMutex<bool>>,
        events: Arc<StdMutex<Vec<String>>>,
        runtime: Arc<StdMutex<Vec<bool>>>,
        // Optional blockers for persistence writes.
        block_persist: Arc<StdMutex<Option<tokio::sync::oneshot::Receiver<()>>>>,
        reject_disable_once: Arc<StdMutex<bool>>,
        reject_disable_always: Arc<StdMutex<bool>>,
    }

    impl FakeDependencies {
        fn new(durable: bool) -> Self {
            Self {
                durable: Arc::new(StdMutex::new(durable)),
                events: Arc::new(StdMutex::new(Vec::new())),
                runtime: Arc::new(StdMutex::new(Vec::new())),
                block_persist: Arc::new(StdMutex::new(None)),
                reject_disable_once: Arc::new(StdMutex::new(false)),
                reject_disable_always: Arc::new(StdMutex::new(false)),
            }
        }

        fn with_blocker(&self, blocker: tokio::sync::oneshot::Receiver<()>) {
            *self.block_persist.lock().unwrap() = Some(blocker);
        }

        /// Reject exactly the next disable write (the `a_stale_enable` shape).
        fn reject_disable_write_once(&self) {
            *self.reject_disable_once.lock().unwrap() = true;
        }

        /// Reject every disable write (the `shutdown_fails_closed` shape).
        fn reject_disable_writes(&self) {
            *self.reject_disable_always.lock().unwrap() = true;
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn runtime(&self) -> Vec<bool> {
            self.runtime.lock().unwrap().clone()
        }
    }

    impl ComputerUseSettingsDependencies for FakeDependencies {
        fn read_persisted(&self) -> BoxFuture<'static, bool> {
            let durable = Arc::clone(&self.durable);
            Box::pin(async move { *durable.lock().unwrap() })
        }

        fn persist(
            &self,
            enabled: bool,
            _is_current: Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> BoxFuture<'static, SettingsPersistenceResult> {
            let durable = Arc::clone(&self.durable);
            let events = Arc::clone(&self.events);
            let block = Arc::clone(&self.block_persist);
            let reject_once = Arc::clone(&self.reject_disable_once);
            let reject_always = Arc::clone(&self.reject_disable_always);
            Box::pin(async move {
                events.lock().unwrap().push(format!("persist:{enabled}"));
                if !enabled {
                    let reject = *reject_always.lock().unwrap() || *reject_once.lock().unwrap();
                    if reject {
                        if *reject_once.lock().unwrap() {
                            *reject_once.lock().unwrap() = false;
                        }
                        return Err(ComputerUseSettingsError::Persist(anyhow::anyhow!(
                            "disk full"
                        )));
                    }
                }
                let blocker = block.lock().unwrap().take();
                if let Some(blocker) = blocker {
                    let _ = blocker.await;
                }
                *durable.lock().unwrap() = enabled;
                Ok(())
            })
        }

        fn set_runtime_enabled(&self, enabled: bool) {
            self.runtime.lock().unwrap().push(enabled);
        }

        fn cancel_computer_use_generations(&self) {
            self.events.lock().unwrap().push("cancel".into());
        }
    }

    fn coordinator(fake: Arc<FakeDependencies>) -> Arc<ComputerUseSettingsCoordinator> {
        Arc::new(ComputerUseSettingsCoordinator::new(fake))
    }

    fn current(value: Arc<AtomicBool>) -> Arc<dyn Fn() -> bool + Send + Sync> {
        Arc::new(move || value.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn disable_closes_and_cancels_the_live_gate_before_persistence_settles() {
        let fake = Arc::new(FakeDependencies::new(true));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let coordinator = coordinator(fake.clone());
        let spawned_coordinator = Arc::clone(&coordinator);
        let change = tokio::spawn(async move {
            spawned_coordinator
                .set_enabled(false, current(Arc::new(AtomicBool::new(true))))
                .await
        });
        // The kill switch ran synchronously before persistence settles.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(
            fake.events()
                .iter()
                .filter(|event| !event.starts_with("persist"))
                .cloned()
                .collect::<Vec<_>>(),
            vec!["cancel".to_string()]
        );
        assert_eq!(fake.runtime(), vec![false]);
        assert_eq!(
            fake.events()
                .iter()
                .filter(|event| event.starts_with("persist"))
                .count(),
            1
        );
        sender.send(()).unwrap();
        change.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_rejected_disable_write_remains_fail_closed_in_memory() {
        let fake = Arc::new(FakeDependencies::new(true));
        fake.reject_disable_writes();
        let coordinator = coordinator(fake.clone());
        let error = coordinator
            .set_enabled(false, current(Arc::new(AtomicBool::new(true))))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disk full"));
        assert_eq!(
            fake.events()
                .iter()
                .filter(|event| !event.starts_with("persist"))
                .cloned()
                .collect::<Vec<_>>(),
            vec!["cancel".to_string()]
        );
        assert_eq!(fake.runtime(), vec![false]);
    }

    #[tokio::test]
    async fn enable_does_not_open_the_live_gate_until_persistence_succeeds() {
        let fake = Arc::new(FakeDependencies::new(false));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let coordinator = coordinator(fake.clone());
        let change = coordinator.set_enabled(true, current(Arc::new(AtomicBool::new(true))));
        // Give the tail a chance to reach the blocked persist.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(fake.runtime(), Vec::<bool>::new());
        sender.send(()).unwrap();
        change.await.unwrap();
        assert_eq!(fake.runtime(), vec![true]);
    }

    #[tokio::test]
    async fn a_document_replaced_during_enable_is_rolled_back_and_never_opens_the_gate() {
        let fake = Arc::new(FakeDependencies::new(false));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let coordinator = coordinator(fake.clone());
        let current_flag = Arc::new(AtomicBool::new(true));
        let flag_for_spawn = Arc::clone(&current_flag);
        let spawned_coordinator = Arc::clone(&coordinator);
        let change = tokio::spawn(async move {
            spawned_coordinator
                .set_enabled(true, current(flag_for_spawn))
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        current_flag.store(false, Ordering::SeqCst);
        sender.send(()).unwrap();
        let error = change.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("no longer active"));
        // Persisted [true, false]; runtime rolled back to false.
        let persisted: Vec<String> = fake
            .events()
            .into_iter()
            .filter(|event| event.starts_with("persist"))
            .collect();
        assert_eq!(
            persisted,
            vec!["persist:true".to_string(), "persist:false".to_string()]
        );
        assert_eq!(fake.runtime(), vec![false]);
    }

    #[tokio::test]
    async fn shutdown_drains_a_pending_disable_persistence_transaction() {
        let fake = Arc::new(FakeDependencies::new(true));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let coordinator = coordinator(fake.clone());
        let disabling = coordinator.set_enabled(false, current(Arc::new(AtomicBool::new(true))));
        let shutdown = coordinator.shutdown();
        tokio::time::sleep(Duration::from_millis(10)).await;
        sender.send(()).unwrap();
        disabling.await.unwrap();
        shutdown.await.unwrap();
        assert!(!*fake.durable.lock().unwrap());
    }

    #[tokio::test]
    async fn shutdown_seals_the_coordinator_before_draining_and_rejects_later_enables() {
        let fake = Arc::new(FakeDependencies::new(false));
        let coordinator = coordinator(fake.clone());
        coordinator.shutdown().await.unwrap();
        let error = coordinator
            .set_enabled(true, current(Arc::new(AtomicBool::new(true))))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("shutting down"));
        assert!(fake.events().is_empty());
        assert!(fake.runtime().is_empty());
    }

    #[tokio::test]
    async fn an_admitted_disable_remains_durable_after_its_renderer_document_exits() {
        let fake = Arc::new(FakeDependencies::new(true));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let coordinator = coordinator(fake.clone());
        let current_flag = Arc::new(AtomicBool::new(true));
        let flag_for_spawn = Arc::clone(&current_flag);
        let spawned_coordinator = Arc::clone(&coordinator);
        let disable = tokio::spawn(async move {
            spawned_coordinator
                .set_enabled(false, current(flag_for_spawn))
                .await
        });
        // Let the kill switch admit the disable before the document exits.
        tokio::time::sleep(Duration::from_millis(10)).await;
        current_flag.store(false, Ordering::SeqCst);
        let shutdown = coordinator.shutdown();
        sender.send(()).unwrap();
        disable.await.unwrap().unwrap();
        shutdown.await.unwrap();
        assert!(!*fake.durable.lock().unwrap());
    }

    #[tokio::test]
    async fn shutdown_fails_closed_when_an_admitted_disable_cannot_become_durable() {
        let fake = Arc::new(FakeDependencies::new(true));
        fake.reject_disable_writes();
        let coordinator = coordinator(fake.clone());
        let error = coordinator
            .set_enabled(false, current(Arc::new(AtomicBool::new(true))))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disk full"));
        let shutdown_error = coordinator.shutdown().await.unwrap_err();
        assert!(shutdown_error.to_string().contains("disk full"));
        assert!(*fake.durable.lock().unwrap());
    }

    #[tokio::test]
    async fn a_cancelled_quit_can_reopen_the_sealed_settings_coordinator() {
        let fake = Arc::new(FakeDependencies::new(false));
        let coordinator = coordinator(fake.clone());
        coordinator.shutdown().await.unwrap();
        coordinator.resume_after_cancelled_shutdown();
        coordinator
            .set_enabled(true, current(Arc::new(AtomicBool::new(true))))
            .await
            .unwrap();
        assert!(*fake.durable.lock().unwrap());
    }

    #[tokio::test]
    async fn a_stale_enable_cannot_reopen_runtime_or_cancel_durability_after_a_failed_disable() {
        let fake = Arc::new(FakeDependencies::new(true));
        fake.reject_disable_write_once();
        let coordinator = coordinator(fake.clone());
        coordinator
            .set_enabled(false, current(Arc::new(AtomicBool::new(true))))
            .await
            .unwrap_err();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        fake.with_blocker(receiver);
        let current_flag = Arc::new(AtomicBool::new(true));
        let flag_for_spawn = Arc::clone(&current_flag);
        let spawned_coordinator = Arc::clone(&coordinator);
        let enable = tokio::spawn(async move {
            spawned_coordinator
                .set_enabled(true, current(flag_for_spawn))
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        current_flag.store(false, Ordering::SeqCst);
        sender.send(()).unwrap();
        let error = enable.await.unwrap().unwrap_err();
        assert!(
            error.to_string().contains("no longer active"),
            "unexpected error: {error}"
        );
        assert!(!*fake.durable.lock().unwrap());
        assert_eq!(fake.runtime(), vec![false, false]);
        coordinator.shutdown().await.unwrap();
        assert!(!*fake.durable.lock().unwrap());
    }

    #[allow(dead_code)]
    fn _unused_counter() {
        let _ = AtomicU64::new(0);
    }
}

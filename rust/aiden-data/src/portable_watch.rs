//! Portable config change coalescing (port of
//! `main/services/portable-config-watch-core.ts` +
//! `portable-credential-snapshot.ts`).
//!
//! The app re-reads `~/.aiden/config.json` on every window focus and on wake
//! from sleep, so the common case must not touch the renderer: the watcher
//! re-reads the (small) file, compares contents, and only a real change is
//! announced. The last-safe-snapshot tracker guarantees that an unsafe
//! projection (corrupt file, malformed schema) never replaces the last
//! successfully reconciled snapshot as the credential-reconciliation baseline,
//! and that a repair stays pending until a full reconcile commits.

use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PortableWatchError {
    #[error("{0}")]
    Message(String),
    #[error("Portable credential reconciliation did not reach a stable snapshot.")]
    Unstable,
}

// ===========================================================================
// LastSafeSnapshotTracker<T>
// ===========================================================================

/// Tracks the last successfully reconciled snapshot (`createLastSafeSnapshotTracker`).
pub struct LastSafeSnapshotTracker<T> {
    last_safe: Option<T>,
    reconciliation_pending: bool,
}

impl<T: Clone + PartialEq> Default for LastSafeSnapshotTracker<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone + PartialEq> LastSafeSnapshotTracker<T> {
    pub fn new() -> Self {
        Self {
            last_safe: None,
            reconciliation_pending: false,
        }
    }

    /// Seed the tracker from the cache before the first disk reload.
    pub fn seed(&mut self, current: Option<T>, safe: bool) {
        if !safe {
            self.reconciliation_pending = true;
            return;
        }
        if self.last_safe.is_none() && current.is_some() {
            self.last_safe = current;
        }
    }

    /// Observe the post-reload cache. Unsafe projections never replace the
    /// last authoritative snapshot; a later repair remains pending until
    /// committed.
    pub fn after_reload(
        &mut self,
        current: Option<T>,
        safe: bool,
        content_changed: bool,
    ) -> (Option<(T, T)>, bool) {
        if !safe || current.is_none() {
            self.reconciliation_pending = true;
            return (None, false);
        }
        let current = current.unwrap();
        let should_notify = content_changed || self.reconciliation_pending;
        if self.last_safe.is_none() {
            self.last_safe = Some(current);
            self.reconciliation_pending = false;
            return (None, should_notify);
        }
        if !should_notify {
            return (None, false);
        }
        self.reconciliation_pending = true;
        (Some((self.last_safe.clone().unwrap(), current)), true)
    }

    /// Commit only after every reconciliation side effect succeeds.
    pub fn commit(&mut self, current: T) {
        self.last_safe = Some(current);
        self.reconciliation_pending = false;
    }
}

// ===========================================================================
// LastSafeSnapshotReload
// ===========================================================================

const MAX_STABILITY_PASSES: usize = 8;

/// The composed reload: reconcile the cached before-state with each disk
/// change, retrying until the exact transition commits
/// (`createLastSafeSnapshotReload`).
pub struct LastSafeSnapshotReload<T> {
    cached_safe: Box<dyn Fn() -> bool + Send + Sync>,
    read_snapshot: Box<dyn Fn() -> T + Send + Sync>,
    reload: Box<dyn Fn() -> bool + Send + Sync>,
    reconcile: Box<dyn Fn(&T, &T) -> Result<(), PortableWatchError> + Send + Sync>,
    tracker: StdMutex<LastSafeSnapshotTracker<T>>,
    tail: StdMutex<()>,
}

impl<T: Clone + PartialEq + 'static> LastSafeSnapshotReload<T> {
    fn serialized<R>(
        &self,
        operation: impl FnOnce(&LastSafeSnapshotReload<T>) -> Result<R, PortableWatchError>,
    ) -> Result<R, PortableWatchError> {
        let _guard = self.tail.lock().unwrap();
        operation(self)
    }

    fn reconcile_until_stable(
        &self,
        previous: &T,
        current: &T,
    ) -> Result<bool, PortableWatchError> {
        let mut before = previous.clone();
        let mut target = current.clone();
        for _ in 0..MAX_STABILITY_PASSES {
            (self.reconcile)(&before, &target)?;
            let safe = (self.cached_safe)();
            if !safe {
                self.tracker.lock().unwrap().seed(None, false);
                return Ok(false);
            }
            let latest = (self.read_snapshot)();
            if latest == target {
                self.tracker.lock().unwrap().commit(target);
                return Ok(true);
            }
            // Journal recovery or another reconciliation side effect may update
            // the cached projection. Reconcile that exact follow-up transition
            // before advancing the last-safe baseline.
            before = target;
            target = latest;
        }
        Err(PortableWatchError::Unstable)
    }

    /// Re-read now, reconciling any real change. `Ok(true)` when a change
    /// should be announced to the renderer.
    pub fn run(&self) -> Result<bool, PortableWatchError> {
        self.serialized(|this| {
            let safe_before = (this.cached_safe)();
            let seeded = if safe_before {
                Some((this.read_snapshot)())
            } else {
                None
            };
            this.tracker.lock().unwrap().seed(seeded, safe_before);

            let changed = (this.reload)();
            let safe_after = (this.cached_safe)();
            let current = if safe_after {
                Some((this.read_snapshot)())
            } else {
                None
            };
            let (transition, should_notify) = this
                .tracker
                .lock()
                .unwrap()
                .after_reload(current, safe_after, changed);
            if let Some((previous, current)) = transition {
                if !this.reconcile_until_stable(&previous, &current)? {
                    return Ok(false);
                }
            }
            Ok(should_notify)
        })
    }

    /// Advance the baseline after a fully reconciled app-authored mutation.
    pub fn sync_current(&self) -> Result<(), PortableWatchError> {
        self.serialized(|this| {
            let safe = (this.cached_safe)();
            if !safe {
                this.tracker.lock().unwrap().seed(None, false);
                return Ok(());
            }
            let current = (this.read_snapshot)();
            // The config mutation that requested this sync may have reloaded an
            // unrelated external edit before publishing its own field.
            // Reconcile from the prior last-safe baseline before advancing it.
            let (transition, _) =
                this.tracker
                    .lock()
                    .unwrap()
                    .after_reload(Some(current), true, true);
            if let Some((previous, current)) = transition {
                this.reconcile_until_stable(&previous, &current)?;
            }
            Ok(())
        })
    }
}

pub fn create_last_safe_snapshot_reload<T: Clone + PartialEq + 'static>(
    cached_safe: Box<dyn Fn() -> bool + Send + Sync>,
    read_snapshot: Box<dyn Fn() -> T + Send + Sync>,
    reload: Box<dyn Fn() -> bool + Send + Sync>,
    reconcile: Box<dyn Fn(&T, &T) -> Result<(), PortableWatchError> + Send + Sync>,
) -> LastSafeSnapshotReload<T> {
    LastSafeSnapshotReload {
        cached_safe,
        read_snapshot,
        reload,
        reconcile,
        tracker: StdMutex::new(LastSafeSnapshotTracker::new()),
        tail: StdMutex::new(()),
    }
}

// ===========================================================================
// PortableConfigWatcher
// ===========================================================================

/// Coalesces the "re-read ~/.aiden/config.json" trigger. In the synchronous
/// port each `refresh()` is a fresh re-read (there is no async overlap to
/// coalesce); failures are reported through `on_error` and never reject the
/// caller.
pub struct PortableConfigWatcher {
    reload: Box<dyn Fn() -> Result<bool, PortableWatchError> + Send + Sync>,
    on_changed: Box<dyn Fn() + Send + Sync>,
    on_error: Box<dyn Fn(&str) + Send + Sync>,
}

impl PortableConfigWatcher {
    pub fn refresh(&self) {
        match (self.reload)() {
            Ok(true) => (self.on_changed)(),
            Ok(false) => {}
            Err(error) => (self.on_error)(&error.to_string()),
        }
    }
}

pub fn create_portable_config_watcher(
    reload: Box<dyn Fn() -> Result<bool, PortableWatchError> + Send + Sync>,
    on_changed: Box<dyn Fn() + Send + Sync>,
    on_error: Box<dyn Fn(&str) + Send + Sync>,
) -> PortableConfigWatcher {
    PortableConfigWatcher {
        reload,
        on_changed,
        on_error,
    }
}

// ===========================================================================
// Portable credential snapshot listener (portable-credential-snapshot.ts)
// ===========================================================================

type SnapshotListener = Box<dyn Fn() + Send + Sync>;

fn listener_slot() -> &'static StdMutex<Option<SnapshotListener>> {
    static SLOT: OnceLock<StdMutex<Option<SnapshotListener>>> = OnceLock::new();
    SLOT.get_or_init(|| StdMutex::new(None))
}

pub fn set_portable_credential_snapshot_listener(listener: Option<SnapshotListener>) {
    *listener_slot().lock().unwrap() = listener;
}

pub fn sync_portable_credential_snapshot() {
    if let Some(listener) = listener_slot().lock().unwrap().as_ref() {
        listener();
    }
}

/// Complete the config mutation's own credential queue before reconciling the
/// shared portable snapshot (mirrors `mutatePortableConfigAndSync`).
pub fn mutate_portable_config_and_sync<R>(mutation: impl FnOnce() -> R) -> R {
    sync_portable_credential_snapshot();
    let value = mutation();
    sync_portable_credential_snapshot();
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    fn cell<T>(value: T) -> Arc<StdMutex<T>> {
        Arc::new(StdMutex::new(value))
    }

    #[test]
    fn unsafe_reloads_cannot_replace_the_last_successfully_reconciled_snapshot() {
        let mut tracker = LastSafeSnapshotTracker::<String>::new();
        tracker.seed(Some("endpoint-a".into()), true);
        assert_eq!(
            tracker.after_reload(Some("defaults".into()), false, true),
            (None, false)
        );
        assert_eq!(
            tracker.after_reload(Some("endpoint-b".into()), true, true),
            (
                Some(("endpoint-a".to_string(), "endpoint-b".to_string())),
                true
            )
        );
    }

    #[test]
    fn a_repaired_file_retries_reconciliation_until_its_exact_transition_commits() {
        let mut tracker = LastSafeSnapshotTracker::<String>::new();
        tracker.seed(Some("endpoint-a".into()), true);
        tracker.after_reload(None, false, true);
        assert_eq!(
            tracker.after_reload(Some("defaults".into()), true, false),
            (
                Some(("endpoint-a".to_string(), "defaults".to_string())),
                true
            ),
            "a repair equal to the unsafe projection still reconciles"
        );
        assert_eq!(
            tracker.after_reload(Some("defaults".into()), true, false),
            (
                Some(("endpoint-a".to_string(), "defaults".to_string())),
                true
            ),
            "a failed side effect remains pending"
        );
        tracker.commit("defaults".into());
        assert_eq!(
            tracker.after_reload(Some("defaults".into()), true, false),
            (None, false)
        );
    }

    #[test]
    fn the_composed_reload_reconciles_the_cached_before_state_with_one_disk_change() {
        let cache = cell("endpoint-a".to_string());
        let disk = cell("endpoint-a".to_string());
        let safe = cell(true);
        let reconciled: Arc<StdMutex<Vec<(String, String)>>> = cell(Vec::new());

        let reload = create_last_safe_snapshot_reload(
            {
                let safe = safe.clone();
                Box::new(move || *safe.lock().unwrap())
            },
            {
                let cache = cache.clone();
                Box::new(move || cache.lock().unwrap().clone())
            },
            {
                let cache = cache.clone();
                let disk = disk.clone();
                Box::new(move || {
                    let changed = *cache.lock().unwrap() != *disk.lock().unwrap();
                    *cache.lock().unwrap() = disk.lock().unwrap().clone();
                    changed
                })
            },
            {
                let reconciled = reconciled.clone();
                Box::new(move |previous, current| {
                    reconciled
                        .lock()
                        .unwrap()
                        .push((previous.clone(), current.clone()));
                    Ok(())
                })
            },
        );

        *disk.lock().unwrap() = "endpoint-b".to_string();
        assert!(reload.run().unwrap());
        assert_eq!(
            *reconciled.lock().unwrap(),
            vec![("endpoint-a".to_string(), "endpoint-b".to_string())]
        );
        assert!(!reload.run().unwrap());
        assert_eq!(reconciled.lock().unwrap().len(), 1);

        *safe.lock().unwrap() = false;
        *disk.lock().unwrap() = "unsafe-defaults".to_string();
        assert!(!reload.run().unwrap());
        *safe.lock().unwrap() = true;
        *disk.lock().unwrap() = "endpoint-c".to_string();
        assert!(reload.run().unwrap());
        assert_eq!(
            reconciled.lock().unwrap().last().unwrap(),
            &("endpoint-b".to_string(), "endpoint-c".to_string())
        );
    }

    #[test]
    fn an_app_authored_mutation_reconciles_before_advancing_the_baseline() {
        let cache: Arc<StdMutex<Vec<String>>> = cell(Vec::new());
        let disk: Arc<StdMutex<Vec<String>>> = cell(Vec::new());
        let reconciled: Arc<StdMutex<Vec<(Vec<String>, Vec<String>)>>> = cell(Vec::new());

        let reload = create_last_safe_snapshot_reload(
            Box::new(|| true),
            {
                let cache = cache.clone();
                Box::new(move || cache.lock().unwrap().clone())
            },
            {
                let cache = cache.clone();
                let disk = disk.clone();
                Box::new(move || {
                    let changed = *cache.lock().unwrap() != *disk.lock().unwrap();
                    *cache.lock().unwrap() = disk.lock().unwrap().clone();
                    changed
                })
            },
            {
                let reconciled = reconciled.clone();
                Box::new(move |previous, current| {
                    reconciled
                        .lock()
                        .unwrap()
                        .push((previous.clone(), current.clone()));
                    Ok(())
                })
            },
        );

        assert!(!reload.run().unwrap());
        *cache.lock().unwrap() = vec!["added-in-settings".to_string()];
        *disk.lock().unwrap() = cache.lock().unwrap().clone();
        reload.sync_current().unwrap();
        assert_eq!(
            *reconciled.lock().unwrap(),
            vec![(Vec::<String>::new(), vec!["added-in-settings".to_string()])]
        );

        *disk.lock().unwrap() = Vec::new();
        assert!(reload.run().unwrap());
        assert_eq!(reconciled.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_snapshot_absorbed_during_reconciliation_is_reconciled_before_the_baseline_advances() {
        let cache: Arc<StdMutex<Vec<String>>> = cell(vec!["A".to_string()]);
        let disk: Arc<StdMutex<Vec<String>>> = cell(vec!["A".to_string()]);
        let transitions: Arc<StdMutex<Vec<(Vec<String>, Vec<String>)>>> = cell(Vec::new());
        let disconnected: Arc<StdMutex<Vec<String>>> = cell(Vec::new());
        let absorb_late_edit = cell(true);

        let reload = create_last_safe_snapshot_reload(
            Box::new(|| true),
            {
                let cache = cache.clone();
                Box::new(move || cache.lock().unwrap().clone())
            },
            {
                let cache = cache.clone();
                let disk = disk.clone();
                Box::new(move || {
                    let changed = *cache.lock().unwrap() != *disk.lock().unwrap();
                    *cache.lock().unwrap() = disk.lock().unwrap().clone();
                    changed
                })
            },
            {
                let transitions = transitions.clone();
                let disconnected = disconnected.clone();
                let absorb_late_edit = absorb_late_edit.clone();
                let cache = cache.clone();
                let disk = disk.clone();
                Box::new(move |previous, current| {
                    transitions
                        .lock()
                        .unwrap()
                        .push((previous.clone(), current.clone()));
                    for server in previous {
                        if !current.contains(server) {
                            disconnected.lock().unwrap().push(server.clone());
                        }
                    }
                    if *absorb_late_edit.lock().unwrap() {
                        *absorb_late_edit.lock().unwrap() = false;
                        // Model pending-journal recovery reloading a later MCP
                        // edit while the watcher is reconciling the snapshot.
                        *cache.lock().unwrap() = vec!["C".to_string()];
                        *disk.lock().unwrap() = cache.lock().unwrap().clone();
                    }
                    Ok(())
                })
            },
        );

        assert!(!reload.run().unwrap());
        *disk.lock().unwrap() = vec!["B".to_string()];
        assert!(reload.run().unwrap());
        assert_eq!(
            *transitions.lock().unwrap(),
            vec![
                (vec!["A".to_string()], vec!["B".to_string()]),
                (vec!["B".to_string()], vec!["C".to_string()]),
            ]
        );
        assert_eq!(
            *disconnected.lock().unwrap(),
            vec!["A".to_string(), "B".to_string()]
        );

        assert!(
            !reload.run().unwrap(),
            "the absorbed late edit becomes the committed baseline"
        );
        assert_eq!(transitions.lock().unwrap().len(), 2);
        *disk.lock().unwrap() = Vec::new();
        assert!(reload.run().unwrap());
        assert_eq!(
            *disconnected.lock().unwrap(),
            vec!["A".to_string(), "B".to_string(), "C".to_string()]
        );
    }

    #[test]
    fn a_changed_file_notifies_the_renderer_exactly_once() {
        let changes = cell(0);
        let watcher = create_portable_config_watcher(
            Box::new(|| Ok(true)),
            {
                let changes = changes.clone();
                Box::new(move || *changes.lock().unwrap() += 1)
            },
            Box::new(|error| panic!("{error}")),
        );
        watcher.refresh();
        assert_eq!(*changes.lock().unwrap(), 1);
    }

    #[test]
    fn an_unchanged_file_does_not_notify_the_renderer() {
        let changes = cell(0);
        let watcher = create_portable_config_watcher(
            Box::new(|| Ok(false)),
            {
                let changes = changes.clone();
                Box::new(move || *changes.lock().unwrap() += 1)
            },
            Box::new(|error| panic!("{error}")),
        );
        watcher.refresh();
        watcher.refresh();
        assert_eq!(*changes.lock().unwrap(), 0);
    }

    #[test]
    fn a_failed_re_read_is_reported_and_does_not_reject_the_caller() {
        let seen: Arc<StdMutex<Vec<String>>> = cell(Vec::new());
        let watcher = create_portable_config_watcher(
            Box::new(|| Err(PortableWatchError::Message("EACCES".into()))),
            Box::new(|| panic!("must not announce a change it never observed")),
            {
                let seen = seen.clone();
                Box::new(move |error| seen.lock().unwrap().push(error.to_string()))
            },
        );
        watcher.refresh();
        assert_eq!(seen.lock().unwrap().len(), 1);
        // A failure does not wedge later refreshes.
        let changes = cell(0);
        let attempt = cell(0);
        let watcher = create_portable_config_watcher(
            {
                let attempt = attempt.clone();
                Box::new(move || {
                    *attempt.lock().unwrap() += 1;
                    if *attempt.lock().unwrap() == 1 {
                        Err(PortableWatchError::Message("transient".into()))
                    } else {
                        Ok(true)
                    }
                })
            },
            {
                let changes = changes.clone();
                Box::new(move || *changes.lock().unwrap() += 1)
            },
            Box::new(|_| {}),
        );
        watcher.refresh();
        watcher.refresh();
        assert_eq!(*changes.lock().unwrap(), 1);
    }

    #[test]
    fn the_first_portable_mutation_seeds_its_baseline_before_absorbing_an_external_edit() {
        let cache = cell("https://a.example".to_string());
        let transitions: Arc<StdMutex<Vec<(String, String)>>> = cell(Vec::new());
        let reload = std::sync::Arc::new(create_last_safe_snapshot_reload(
            Box::new(|| true),
            {
                let cache = cache.clone();
                Box::new(move || cache.lock().unwrap().clone())
            },
            Box::new(|| false),
            {
                let transitions = transitions.clone();
                Box::new(move |previous, current| {
                    transitions
                        .lock()
                        .unwrap()
                        .push((previous.clone(), current.clone()));
                    Ok(())
                })
            },
        ));
        {
            let reload = reload.clone();
            set_portable_credential_snapshot_listener(Some(Box::new(move || {
                let _ = reload.sync_current();
            })));
        }

        mutate_portable_config_and_sync(|| {
            // Model the first Settings write reloading an external endpoint edit
            // before publishing its own field.
            *cache.lock().unwrap() = "https://b.example".to_string();
        });
        assert_eq!(
            *transitions.lock().unwrap(),
            vec![(
                "https://a.example".to_string(),
                "https://b.example".to_string()
            )]
        );
    }
}

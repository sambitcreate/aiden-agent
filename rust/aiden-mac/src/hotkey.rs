//! Global shortcut registration — port of
//! `main/services/shortcut-registration-core.ts` and
//! `main/services/shortcut-transaction-core.ts`.
//!
//! The reconcile algorithm atomically replaces only the changed registrations
//! (unchanged shortcuts stay claimed) and restores every released registration
//! when a new claim fails. The transaction queue serializes runtime-backed
//! settings transactions from their first read through persistence and any
//! rollback, so a failed older write can never overwrite newer runtime state.
//!
//! Accelerator parsing/validation comes from `aiden-core::keybindings`
//! (`normalize_accelerator`, reserved/conflict checks); this module wires the
//! actual macOS registration through the `global-hotkey` crate.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;

use aiden_core::keybindings::CommandId;
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

// ===========================================================================
// Reconcile (shortcut-registration-core.ts)
// ===========================================================================

/// A shortcut currently registered with the OS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisteredGlobalShortcut {
    pub command_id: CommandId,
    pub accelerator: String,
}

/// A shortcut the caller wants active (`accelerator: None` = release).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesiredGlobalShortcut {
    pub command_id: CommandId,
    pub accelerator: Option<String>,
}

/// `ShortcutReconcileResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShortcutReconcileResult {
    pub ok: bool,
    pub registered: BTreeMap<CommandId, RegisteredGlobalShortcut>,
    pub failed_command_id: Option<CommandId>,
    pub failed_accelerator: Option<String>,
    pub rollback_failed: Option<bool>,
}

/// The OS registration seam (`ShortcutRegistrationPort`). The handler that
/// fires on activation is a port concern; the reconcile logic only needs the
/// claim/release calls.
pub trait ShortcutRegistrationPort: Send + Sync {
    fn register(&self, accelerator: &str) -> bool;
    fn unregister(&self, accelerator: &str);
}

/// `reconcileGlobalShortcuts` — atomically replace only changed registrations.
pub fn reconcile_global_shortcuts(
    port: &dyn ShortcutRegistrationPort,
    current: &BTreeMap<CommandId, RegisteredGlobalShortcut>,
    desired: &[DesiredGlobalShortcut],
) -> ShortcutReconcileResult {
    let desired_by_id: HashMap<CommandId, &DesiredGlobalShortcut> =
        desired.iter().map(|item| (item.command_id, item)).collect();
    let mut changed_ids = HashSet::new();
    for item in desired {
        if current
            .get(&item.command_id)
            .map(|registered| registered.accelerator.as_str())
            != item.accelerator.as_deref()
        {
            changed_ids.insert(item.command_id);
        }
    }
    for id in current.keys() {
        if !desired_by_id.contains_key(id) {
            changed_ids.insert(*id);
        }
    }
    if changed_ids.is_empty() {
        return ShortcutReconcileResult {
            ok: true,
            registered: current.clone(),
            ..ShortcutReconcileResult::default()
        };
    }

    let mut next = current.clone();
    let mut released: Vec<RegisteredGlobalShortcut> = Vec::new();
    for id in &changed_ids {
        if let Some(existing) = current.get(id) {
            port.unregister(&existing.accelerator);
            released.push(existing.clone());
            next.remove(id);
        }
    }

    let mut newly_registered: Vec<RegisteredGlobalShortcut> = Vec::new();
    for item in desired {
        if !changed_ids.contains(&item.command_id) {
            continue;
        }
        let Some(accelerator) = item.accelerator.as_deref() else {
            continue;
        };
        if port.register(accelerator) {
            let registered = RegisteredGlobalShortcut {
                command_id: item.command_id,
                accelerator: accelerator.to_string(),
            };
            newly_registered.push(registered.clone());
            next.insert(item.command_id, registered);
            continue;
        }

        // A claim failed: roll back everything we just registered.
        for registered in &newly_registered {
            port.unregister(&registered.accelerator);
            next.remove(&registered.command_id);
        }
        let mut rollback_failed = false;
        for previous in &released {
            if port.register(&previous.accelerator) {
                next.insert(previous.command_id, previous.clone());
            } else {
                rollback_failed = true;
            }
        }
        return ShortcutReconcileResult {
            ok: false,
            registered: next,
            failed_command_id: Some(item.command_id),
            failed_accelerator: Some(accelerator.to_string()),
            rollback_failed: Some(rollback_failed),
        };
    }

    ShortcutReconcileResult {
        ok: true,
        registered: next,
        ..ShortcutReconcileResult::default()
    }
}

// ===========================================================================
// Transaction queue (shortcut-transaction-core.ts)
// ===========================================================================

/// `ShortcutPersistenceRollbackError` — both persistence and the rollback
/// failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "Settings could not be saved ({persistence}), and the previous shortcuts could not be restored ({rollback}). Restart Aiden before changing shortcuts again."
)]
pub struct ShortcutPersistenceRollbackError {
    pub persistence: String,
    pub rollback: String,
}

/// A transaction-level failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShortcutTransactionError {
    #[error("{0}")]
    Persistence(String),
    #[error(transparent)]
    PersistenceRollback(#[from] ShortcutPersistenceRollbackError),
}

/// The prepared result of a transaction (`prepare` returns this).
pub struct Prepared<State, Value> {
    pub next: State,
    /// Persist `next`; `Err(message)` on failure.
    pub persist: BoxFuture<'static, Result<(), String>>,
    pub value: Value,
}

/// `createShortcutTransactionQueue` — serializes every transaction in the
/// queue, including rollback, so runtime state and disk stay consistent.
#[derive(Default)]
pub struct ShortcutTransactionQueue {
    tail: Mutex<Option<Shared<BoxFuture<'static, ()>>>>,
}

impl ShortcutTransactionQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// `run` — execute `operation` after every previously queued task (and its
    /// rollback) has settled.
    pub async fn run<F, Fut, R>(&self, operation: F) -> R
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = R> + Send + 'static,
        R: Send + 'static,
    {
        let previous = { self.tail.lock().await.take() };
        if let Some(previous) = previous {
            let _ = previous.await;
        }
        let (deliver, received) = tokio::sync::oneshot::channel();
        let task: BoxFuture<'static, ()> = async move {
            let result = operation().await;
            let _ = deliver.send(result);
        }
        .boxed();
        let shared = task.shared();
        *self.tail.lock().await = Some(shared.clone());
        let _ = shared.await;
        received
            .await
            .expect("a queued shortcut transaction always delivers its result")
    }

    /// `transact` — read → prepare → apply → persist, with rollback of the
    /// runtime state when persistence fails.
    pub async fn transact<State, Value, Applied, FRead, FPrep, FApply>(
        &self,
        read: FRead,
        prepare: FPrep,
        apply: FApply,
    ) -> Result<(Applied, Value), ShortcutTransactionError>
    where
        State: Clone + Send + 'static,
        Value: Send + 'static,
        Applied: Send + 'static,
        FRead: FnOnce() -> BoxFuture<'static, State> + Send + 'static,
        FPrep: FnOnce(State) -> BoxFuture<'static, Prepared<State, Value>> + Send + 'static,
        FApply: Fn(&State) -> BoxFuture<'static, Result<Applied, String>> + Send + 'static,
    {
        self.run(async move || {
            let previous = read().await;
            let prepared = prepare(previous.clone()).await;
            let applied = apply(&prepared.next)
                .await
                .map_err(ShortcutTransactionError::Persistence)?;
            match prepared.persist.await {
                Ok(()) => Ok((applied, prepared.value)),
                Err(persistence) => match apply(&previous).await {
                    Ok(_) => Err(ShortcutTransactionError::Persistence(persistence)),
                    Err(rollback) => Err(ShortcutTransactionError::PersistenceRollback(
                        ShortcutPersistenceRollbackError {
                            persistence,
                            rollback,
                        },
                    )),
                },
            }
        })
        .await
    }
}

// ===========================================================================
// macOS runtime (global-hotkey)
// ===========================================================================

/// Errors from the OS hotkey manager.
#[derive(Debug, thiserror::Error)]
pub enum HotkeyManagerError {
    #[error("Global hotkeys are unavailable on this platform.")]
    UnsupportedPlatform,
    #[error("Could not initialize the global hotkey manager: {0}")]
    Manager(String),
    #[error("Could not register {0}: {1}")]
    Register(String, String),
    #[error("Could not unregister {0}: {1}")]
    Unregister(String, String),
    #[error("Invalid accelerator \"{0}\".")]
    InvalidAccelerator(String),
}

/// A registered OS hotkey: keeps the `global-hotkey` claim alive and releases
/// it on drop.
#[cfg(target_os = "macos")]
pub struct OsHotkey {
    hotkey: global_hotkey::hotkey::HotKey,
}

#[cfg(target_os = "macos")]
impl Drop for OsHotkey {
    fn drop(&mut self) {
        if let Ok(manager) = GlobalHotkeyManager::manager() {
            let _ = manager.unregister(self.hotkey);
        }
    }
}

/// Process-wide manager wrapper. `global-hotkey` requires the manager to be
/// created on the main thread on macOS; we keep a process-global instance
/// initialized by `GlobalHotkeyManager::initialize` on the main thread.
#[cfg(target_os = "macos")]
pub struct GlobalHotkeyManager {
    manager: std::sync::Arc<global_hotkey::GlobalHotKeyManager>,
}

#[cfg(target_os = "macos")]
impl GlobalHotkeyManager {
    /// Initialize the manager (call on the main thread, once). Idempotent.
    pub fn initialize() -> Result<Self, HotkeyManagerError> {
        let manager = global_hotkey::GlobalHotKeyManager::new()
            .map_err(|error| HotkeyManagerError::Manager(error.to_string()))?;
        Ok(Self {
            manager: std::sync::Arc::new(manager),
        })
    }

    fn manager() -> Result<std::sync::Arc<global_hotkey::GlobalHotKeyManager>, HotkeyManagerError> {
        static MANAGER: std::sync::OnceLock<
            Result<std::sync::Arc<global_hotkey::GlobalHotKeyManager>, String>,
        > = std::sync::OnceLock::new();
        MANAGER
            .get_or_init(|| {
                global_hotkey::GlobalHotKeyManager::new()
                    .map(std::sync::Arc::new)
                    .map_err(|error| error.to_string())
            })
            .clone()
            .map_err(HotkeyManagerError::Manager)
    }

    /// Register a normalized accelerator (e.g. `"Command+Alt+Space"`).
    pub fn register(&self, accelerator: &str) -> Result<OsHotkey, HotkeyManagerError> {
        let hotkey = accelerator
            .parse()
            .map_err(|_| HotkeyManagerError::InvalidAccelerator(accelerator.to_string()))?;
        self.manager.register(hotkey).map_err(|error| {
            HotkeyManagerError::Register(accelerator.to_string(), error.to_string())
        })?;
        Ok(OsHotkey { hotkey })
    }

    /// Unregister by accelerator string (used by the reconcile port).
    pub fn unregister(&self, accelerator: &str) -> Result<(), HotkeyManagerError> {
        let hotkey = accelerator
            .parse()
            .map_err(|_| HotkeyManagerError::InvalidAccelerator(accelerator.to_string()))?;
        self.manager.unregister(hotkey).map_err(|error| {
            HotkeyManagerError::Unregister(accelerator.to_string(), error.to_string())
        })
    }
}

/// The `ShortcutRegistrationPort` over the macOS manager.
#[cfg(target_os = "macos")]
pub struct MacHotkeyPort {
    manager: std::sync::Arc<global_hotkey::GlobalHotKeyManager>,
}

#[cfg(target_os = "macos")]
impl MacHotkeyPort {
    pub fn new(manager: GlobalHotkeyManager) -> Self {
        Self {
            manager: manager.manager,
        }
    }
}

#[cfg(target_os = "macos")]
impl ShortcutRegistrationPort for MacHotkeyPort {
    fn register(&self, accelerator: &str) -> bool {
        match accelerator.parse::<global_hotkey::hotkey::HotKey>() {
            Ok(hotkey) => self.manager.register(hotkey).is_ok(),
            Err(_) => false,
        }
    }
    fn unregister(&self, accelerator: &str) {
        if let Ok(hotkey) = accelerator.parse::<global_hotkey::hotkey::HotKey>() {
            let _ = self.manager.unregister(hotkey);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_port(
        blocked: &HashSet<String>,
    ) -> (FakePort, std::sync::Arc<std::sync::Mutex<HashSet<String>>>) {
        let active = std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));
        (
            FakePort {
                active: active.clone(),
                blocked: blocked.clone(),
            },
            active,
        )
    }

    struct FakePort {
        active: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
        blocked: HashSet<String>,
    }

    impl ShortcutRegistrationPort for FakePort {
        fn register(&self, accelerator: &str) -> bool {
            let mut active = self.active.lock().unwrap();
            if self.blocked.contains(accelerator) || active.contains(accelerator) {
                return false;
            }
            active.insert(accelerator.to_string());
            true
        }
        fn unregister(&self, accelerator: &str) {
            self.active.lock().unwrap().remove(accelerator);
        }
    }

    fn registered(id: CommandId, accelerator: &str) -> RegisteredGlobalShortcut {
        RegisteredGlobalShortcut {
            command_id: id,
            accelerator: accelerator.to_string(),
        }
    }

    fn active_set(active: &std::sync::Arc<std::sync::Mutex<HashSet<String>>>) -> Vec<String> {
        let mut values: Vec<String> = active.lock().unwrap().iter().cloned().collect();
        values.sort();
        values
    }

    #[test]
    fn changes_only_the_affected_registration() {
        let (port, active) = fake_port(&HashSet::new());
        {
            let mut guard = active.lock().unwrap();
            guard.insert("Command+Alt+Space".into());
            guard.insert("Command+Alt+A".into());
        }
        let current = BTreeMap::from([
            (
                CommandId::ComposerFocus,
                registered(CommandId::ComposerFocus, "Command+Alt+Space"),
            ),
            (
                CommandId::AssistantOpen,
                registered(CommandId::AssistantOpen, "Command+Alt+A"),
            ),
        ]);
        let result = reconcile_global_shortcuts(
            &port,
            &current,
            &[
                DesiredGlobalShortcut {
                    command_id: CommandId::ComposerFocus,
                    accelerator: Some("Command+Shift+Space".into()),
                },
                DesiredGlobalShortcut {
                    command_id: CommandId::AssistantOpen,
                    accelerator: Some("Command+Alt+A".into()),
                },
            ],
        );
        assert!(result.ok);
        assert_eq!(
            active_set(&active),
            vec![
                "Command+Alt+A".to_string(),
                "Command+Shift+Space".to_string()
            ]
        );
    }

    #[test]
    fn failed_registration_rolls_back_every_released_shortcut() {
        let (port, active) = fake_port(&HashSet::from(["Command+Shift+Space".to_string()]));
        active.lock().unwrap().insert("Command+Alt+Space".into());
        let current = BTreeMap::from([(
            CommandId::ComposerFocus,
            registered(CommandId::ComposerFocus, "Command+Alt+Space"),
        )]);
        let result = reconcile_global_shortcuts(
            &port,
            &current,
            &[DesiredGlobalShortcut {
                command_id: CommandId::ComposerFocus,
                accelerator: Some("Command+Shift+Space".into()),
            }],
        );
        assert!(!result.ok);
        assert_eq!(active_set(&active), vec!["Command+Alt+Space".to_string()]);
        assert_eq!(
            result
                .registered
                .get(&CommandId::ComposerFocus)
                .unwrap()
                .accelerator,
            "Command+Alt+Space"
        );
        assert_eq!(result.failed_command_id, Some(CommandId::ComposerFocus));
        assert_eq!(
            result.failed_accelerator.as_deref(),
            Some("Command+Shift+Space")
        );
    }

    #[test]
    fn supports_atomic_swaps_by_releasing_both_old_accelerators_first() {
        let (port, active) = fake_port(&HashSet::new());
        {
            let mut guard = active.lock().unwrap();
            guard.insert("Command+Alt+Space".into());
            guard.insert("Command+Alt+A".into());
        }
        let current = BTreeMap::from([
            (
                CommandId::ComposerFocus,
                registered(CommandId::ComposerFocus, "Command+Alt+Space"),
            ),
            (
                CommandId::AssistantOpen,
                registered(CommandId::AssistantOpen, "Command+Alt+A"),
            ),
        ]);
        let result = reconcile_global_shortcuts(
            &port,
            &current,
            &[
                DesiredGlobalShortcut {
                    command_id: CommandId::ComposerFocus,
                    accelerator: Some("Command+Alt+A".into()),
                },
                DesiredGlobalShortcut {
                    command_id: CommandId::AssistantOpen,
                    accelerator: Some("Command+Alt+Space".into()),
                },
            ],
        );
        assert!(result.ok);
        assert_eq!(
            active_set(&active),
            vec!["Command+Alt+A".to_string(), "Command+Alt+Space".to_string()]
        );
    }

    #[test]
    fn recorder_suspension_releases_every_owned_shortcut_and_restores_them() {
        let (port, active) = fake_port(&HashSet::new());
        {
            let mut guard = active.lock().unwrap();
            guard.insert("Command+Alt+Space".into());
            guard.insert("Command+Alt+A".into());
        }
        let current = BTreeMap::from([
            (
                CommandId::ComposerFocus,
                registered(CommandId::ComposerFocus, "Command+Alt+Space"),
            ),
            (
                CommandId::AssistantOpen,
                registered(CommandId::AssistantOpen, "Command+Alt+A"),
            ),
        ]);
        let suspended = reconcile_global_shortcuts(
            &port,
            &current,
            &[
                DesiredGlobalShortcut {
                    command_id: CommandId::ComposerFocus,
                    accelerator: None,
                },
                DesiredGlobalShortcut {
                    command_id: CommandId::AssistantOpen,
                    accelerator: None,
                },
            ],
        );
        assert!(suspended.ok);
        assert!(active_set(&active).is_empty());

        let restored = reconcile_global_shortcuts(
            &port,
            &suspended.registered,
            &[
                DesiredGlobalShortcut {
                    command_id: CommandId::ComposerFocus,
                    accelerator: Some("Command+Alt+Space".into()),
                },
                DesiredGlobalShortcut {
                    command_id: CommandId::AssistantOpen,
                    accelerator: Some("Command+Alt+A".into()),
                },
            ],
        );
        assert!(restored.ok);
        assert_eq!(
            active_set(&active),
            vec!["Command+Alt+A".to_string(), "Command+Alt+Space".to_string()]
        );
    }

    type State = std::collections::BTreeMap<String, i32>;

    #[tokio::test]
    async fn queue_serializes_read_apply_and_persistence() {
        // Port of "serializes read, apply, and persistence so concurrent
        // mutations cannot lose updates".
        let queue = std::sync::Arc::new(ShortcutTransactionQueue::new());
        let disk = std::sync::Arc::new(std::sync::Mutex::new(State::new()));
        let runtime = std::sync::Arc::new(std::sync::Mutex::new(State::new()));
        let (started_first_write_tx, started_first_write_rx) = tokio::sync::oneshot::channel();
        let (release_first_write_tx, release_first_write_rx) = tokio::sync::oneshot::channel();

        let mutate = |key: String,
                      value: i32,
                      wait: Option<tokio::sync::oneshot::Receiver<()>>,
                      started_tx: Option<tokio::sync::oneshot::Sender<()>>| {
            let disk = disk.clone();
            let runtime = runtime.clone();
            let queue = queue.clone();
            async move {
                queue
                    .transact(
                        {
                            let disk = disk.clone();
                            move || async move { disk.lock().unwrap().clone() }.boxed()
                        },
                        move |previous| {
                            let mut next = previous.clone();
                            next.insert(key.clone(), value);
                            let disk = disk.clone();
                            let next_for_persist = next.clone();
                            async move {
                                Prepared {
                                    next,
                                    value: key.clone(),
                                    persist: {
                                        let disk = disk.clone();
                                        async move {
                                            if let Some(started_tx) = started_tx {
                                                let _ = started_tx.send(());
                                            }
                                            if let Some(wait) = wait {
                                                let _ = wait.await;
                                            }
                                            *disk.lock().unwrap() = next_for_persist.clone();
                                            Ok(())
                                        }
                                        .boxed()
                                    },
                                }
                            }
                            .boxed()
                        },
                        {
                            let runtime = runtime.clone();
                            move |next| {
                                let runtime = runtime.clone();
                                let next = next.clone();
                                async move {
                                    *runtime.lock().unwrap() = next.clone();
                                    Ok(serde_json::to_string(&next).unwrap())
                                }
                                .boxed()
                            }
                        },
                    )
                    .await
                    .map(|(applied, _)| applied)
            }
        };

        // Futures are lazy in Rust: spawn so the first persist can signal.
        let first = tokio::spawn(mutate(
            "focus".into(),
            1,
            Some(release_first_write_rx),
            Some(started_first_write_tx),
        ));
        started_first_write_rx.await.unwrap();
        let second = tokio::spawn(mutate("assistant".into(), 2, None, None));
        release_first_write_tx.send(()).unwrap();
        let (first, second) = tokio::join!(first, second);
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(first.is_ok());
        assert!(second.is_ok());

        let expected = State::from([("focus".to_string(), 1), ("assistant".to_string(), 2)]);
        assert_eq!(*disk.lock().unwrap(), expected);
        assert_eq!(*runtime.lock().unwrap(), expected);
    }

    #[tokio::test]
    async fn failed_persistence_rolls_back_runtime_before_the_next_transaction() {
        // Port of "a failed persistence rollback completes before the next
        // successful transaction".
        let queue = ShortcutTransactionQueue::new();
        let disk = std::sync::Arc::new(std::sync::Mutex::new(State::from([(
            "original".to_string(),
            1,
        )])));
        let runtime = std::sync::Arc::new(std::sync::Mutex::new(State::from([(
            "original".to_string(),
            1,
        )])));
        let operations = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

        let failed = queue
            .transact(
                {
                    let disk = disk.clone();
                    move || async move { disk.lock().unwrap().clone() }.boxed()
                },
                {
                    let operations = operations.clone();
                    move |previous| {
                        let mut next = previous.clone();
                        next.insert("failed".into(), 1);
                        let operations = operations.clone();
                        async move {
                            Prepared {
                                next,
                                value: (),
                                persist: {
                                    let operations = operations.clone();
                                    async move {
                                        operations.lock().unwrap().push("persist failed".into());
                                        Err("disk full".into())
                                    }
                                    .boxed()
                                },
                            }
                        }
                        .boxed()
                    }
                },
                {
                    let runtime = runtime.clone();
                    let operations = operations.clone();
                    move |next| {
                        let runtime = runtime.clone();
                        let operations = operations.clone();
                        let next = next.clone();
                        async move {
                            let keys = next.keys().cloned().collect::<Vec<_>>().join(",");
                            operations.lock().unwrap().push(format!("apply {keys}"));
                            *runtime.lock().unwrap() = next.clone();
                            Ok(())
                        }
                        .boxed()
                    }
                },
            )
            .await;
        assert!(matches!(
            failed,
            Err(ShortcutTransactionError::Persistence(_))
        ));

        let successful = queue
            .transact(
                {
                    let disk = disk.clone();
                    move || async move { disk.lock().unwrap().clone() }.boxed()
                },
                {
                    let operations = operations.clone();
                    move |previous| {
                        let mut next = previous.clone();
                        next.insert("successful".into(), 1);
                        let operations = operations.clone();
                        let disk = disk.clone();
                        let next_for_persist = next.clone();
                        async move {
                            Prepared {
                                next,
                                value: (),
                                persist: {
                                    let operations = operations.clone();
                                    let disk = disk.clone();
                                    async move {
                                        *disk.lock().unwrap() = next_for_persist.clone();
                                        operations
                                            .lock()
                                            .unwrap()
                                            .push("persist successful".into());
                                        Ok(())
                                    }
                                    .boxed()
                                },
                            }
                        }
                        .boxed()
                    }
                },
                {
                    let runtime = runtime.clone();
                    let operations = operations.clone();
                    move |next| {
                        let runtime = runtime.clone();
                        let operations = operations.clone();
                        let next = next.clone();
                        async move {
                            let keys = next.keys().cloned().collect::<Vec<_>>().join(",");
                            operations.lock().unwrap().push(format!("apply {keys}"));
                            *runtime.lock().unwrap() = next.clone();
                            Ok(())
                        }
                        .boxed()
                    }
                },
            )
            .await;
        assert!(successful.is_ok());
        assert_eq!(
            *operations.lock().unwrap(),
            vec![
                "apply failed,original".to_string(),
                "persist failed".to_string(),
                "apply original".to_string(),
                "apply original,successful".to_string(),
                "persist successful".to_string(),
            ]
        );
        assert_eq!(
            *runtime.lock().unwrap(),
            State::from([("original".to_string(), 1), ("successful".to_string(), 1)])
        );
    }

    #[tokio::test]
    async fn reports_both_persistence_and_rollback_failures() {
        // Port of "reports both persistence and rollback failures when runtime
        // cannot be restored".
        let queue = ShortcutTransactionQueue::new();
        let apply_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let result = queue
            .transact(
                || async { 1 }.boxed(),
                |_previous| {
                    async move {
                        Prepared {
                            next: 2,
                            value: (),
                            persist: async { Err("disk full".into()) }.boxed(),
                        }
                    }
                    .boxed()
                },
                {
                    let apply_count = apply_count.clone();
                    move |_next| {
                        let apply_count = apply_count.clone();
                        async move {
                            if apply_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                                return Err("accelerator unavailable".into());
                            }
                            Ok(())
                        }
                        .boxed()
                    }
                },
            )
            .await;
        let error = result.unwrap_err();
        let rollback = match error {
            ShortcutTransactionError::PersistenceRollback(rollback) => rollback,
            other => panic!("expected a rollback error, got {other:?}"),
        };
        assert_eq!(rollback.persistence, "disk full");
        assert_eq!(rollback.rollback, "accelerator unavailable");
    }
}

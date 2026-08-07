//! Superseding task gate — port of `main/services/superseding-task-core.ts`.
//!
//! Tracks async work whose newest generation owns the outcome. Waiters follow
//! replacements, while stale failures remain observable to their own callers
//! without being allowed to decide the current generation's fate. In the
//! Electron app this ensures only the latest `loadURL` wins during renderer
//! recovery; the Rust port generalizes it to any keyed in-flight operation.
//!
//! ## Port notes
//!
//! The TS `promise: Promise<void>` rejection carries `unknown`; Rust requires a
//! concrete error type, so the gate is generic over `E` (the error carried by
//! [`SupersedingTaskError::Rejected`]). `E` must be `Clone`: the TS lets every
//! concurrent waiter rethrow the same error, and the gate keeps the rejected
//! task current until it is replaced or cleared.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// A token identifying one tracked generation. Waiters compare against it to
/// detect replacements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupersedingTaskToken {
    id: u64,
}

/// How a tracked task finished, as observed by `wait()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupersedingTaskError<E> {
    /// The future returned `Err(error)`.
    Rejected(E),
}

impl<E: std::fmt::Display> std::fmt::Display for SupersedingTaskError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupersedingTaskError::Rejected(error) => error.fmt(formatter),
        }
    }
}

enum TaskState<E> {
    Pending,
    Fulfilled,
    Rejected(E),
    Superseded,
}

struct TrackedTask<E> {
    token: SupersedingTaskToken,
    state: Mutex<TaskState<E>>,
    changed: Notify,
}

/// `createSupersedingTaskGate` — the latest generation owns the outcome.
#[derive(Clone)]
pub struct SupersedingTaskGate<E> {
    inner: Arc<SupersedingTaskGateInner<E>>,
}

struct SupersedingTaskGateInner<E> {
    current: Mutex<Option<Arc<TrackedTask<E>>>>,
    next_token: AtomicU64,
}

impl<E> Default for SupersedingTaskGate<E> {
    fn default() -> Self {
        Self::new()
    }
}

impl<E> SupersedingTaskGate<E> {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SupersedingTaskGateInner {
                current: Mutex::new(None),
                next_token: AtomicU64::new(0),
            }),
        }
    }

    /// Track `promise` as the newest generation. The previous current task
    /// (if any) is superseded; its waiters follow the new task.
    pub fn replace<F>(&self, promise: F) -> SupersedingTaskToken
    where
        E: Send + 'static,
        F: Future<Output = Result<(), E>> + Send + 'static,
    {
        if let Some(previous) = self.inner.current.lock().unwrap().take() {
            previous.mark_superseded();
        }
        let token = SupersedingTaskToken {
            id: self.inner.next_token.fetch_add(1, Ordering::SeqCst),
        };
        let task = Arc::new(TrackedTask {
            token,
            state: Mutex::new(TaskState::Pending),
            changed: Notify::new(),
        });
        let spawned = task.clone();
        // The spawned task keeps `spawned` alive; the JoinHandle is detached
        // (dropped) so the gate does not need to poll it.
        let _handle = tokio::spawn(async move {
            let outcome = promise.await;
            let state = match outcome {
                Ok(()) => TaskState::Fulfilled,
                Err(error) => TaskState::Rejected(error),
            };
            *spawned.state.lock().unwrap() = state;
            spawned.changed.notify_waiters();
        });
        *self.inner.current.lock().unwrap() = Some(task);
        token
    }

    /// Whether `token` is still the newest generation.
    pub fn is_current(&self, token: SupersedingTaskToken) -> bool {
        self.inner
            .current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|task| task.token == token)
    }

    /// Resolve when the current generation settles, or when the gate is
    /// cleared. Follows replacements: a superseded task releases its waiters
    /// to re-check against the new current task. A stale failure is never
    /// rethrown to waiters of a newer generation; only the current task's own
    /// failure surfaces.
    pub async fn wait(&self) -> Result<(), SupersedingTaskError<E>>
    where
        E: Clone + Send,
    {
        loop {
            let task = self.inner.current.lock().unwrap().clone();
            let Some(task) = task else {
                return Ok(());
            };
            if !self.is_current(task.token) {
                continue;
            }
            match self.observe_state(&task) {
                Observation::Settled(Ok(())) => {
                    // Only the current task may clear the gate.
                    if self.is_current(task.token) {
                        *self.inner.current.lock().unwrap() = None;
                    }
                    return Ok(());
                }
                Observation::Settled(Err(error)) => return Err(error),
                Observation::Pending => {
                    let notified = task.changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    match self.observe_state(&task) {
                        Observation::Pending => notified.as_mut().await,
                        Observation::Settled(_) => continue,
                    }
                }
            }
        }
    }

    /// Release every waiter without settling the current task. The current
    /// generation keeps running; a later `replace` still supersedes it.
    pub fn clear(&self) {
        if let Some(task) = self.inner.current.lock().unwrap().take() {
            task.mark_superseded();
        }
    }

    fn observe_state(&self, task: &TrackedTask<E>) -> Observation<E>
    where
        E: Clone,
    {
        match &*task.state.lock().unwrap() {
            TaskState::Pending => Observation::Pending,
            TaskState::Fulfilled => Observation::Settled(Ok(())),
            TaskState::Rejected(error) => {
                Observation::Settled(Err(SupersedingTaskError::Rejected(error.clone())))
            }
            TaskState::Superseded => {
                // The task was replaced; waiters loop to follow the new one.
                Observation::Pending
            }
        }
    }
}

impl<E> TrackedTask<E> {
    fn mark_superseded(&self) {
        *self.state.lock().unwrap() = TaskState::Superseded;
        self.changed.notify_waiters();
    }
}

enum Observation<E> {
    Pending,
    Settled(Result<(), SupersedingTaskError<E>>),
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A deferred `Result<(), String>` future with manual resolve/reject.
    /// Uses `tokio::sync::oneshot` so resolving from the test never blocks the
    /// current-thread runtime (a blocking std channel would deadlock it).
    struct Deferred {
        tx: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>,
    }

    impl Deferred {
        fn new() -> (Self, impl Future<Output = Result<(), String>>) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let future = async move { rx.await.map_err(|error| error.to_string())? };
            (
                Deferred {
                    tx: std::sync::Mutex::new(Some(tx)),
                },
                future,
            )
        }
        fn resolve(&self) {
            if let Some(tx) = self.tx.lock().unwrap().take() {
                let _ = tx.send(Ok(()));
            }
        }
        fn reject(&self, message: &str) {
            if let Some(tx) = self.tx.lock().unwrap().take() {
                let _ = tx.send(Err(message.to_string()));
            }
        }
    }

    fn never() -> impl Future<Output = Result<(), String>> {
        std::future::pending()
    }

    #[tokio::test]
    async fn concurrent_waiters_follow_a_replacement_without_settling_the_obsolete_task() {
        let gate = SupersedingTaskGate::<String>::new();
        let (second, second_future) = Deferred::new();
        let first_token = gate.replace(never());
        let first_waiter = gate.wait();
        let second_waiter = gate.wait();
        let second_token = gate.replace(second_future);

        assert!(!gate.is_current(first_token));
        assert!(gate.is_current(second_token));

        second.resolve();
        first_waiter.await.unwrap();
        second_waiter.await.unwrap();
    }

    #[tokio::test]
    async fn clearing_the_gate_releases_every_waiter_without_settling_the_current_task() {
        let gate = SupersedingTaskGate::<String>::new();
        gate.replace(never());
        let first_waiter = gate.wait();
        let second_waiter = gate.wait();

        gate.clear();
        first_waiter.await.unwrap();
        second_waiter.await.unwrap();
    }

    #[tokio::test]
    async fn a_stale_rejection_cannot_displace_the_replacement() {
        let gate = SupersedingTaskGate::<String>::new();
        let (first, first_future) = Deferred::new();
        let (second, second_future) = Deferred::new();
        let first_token = gate.replace(first_future);
        let waiting = gate.wait();
        let second_token = gate.replace(second_future);

        first.reject("obsolete renderer failed");
        tokio::task::yield_now().await;
        assert!(!gate.is_current(first_token));
        assert!(gate.is_current(second_token));

        second.resolve();
        waiting.await.unwrap();
    }

    #[tokio::test]
    async fn the_current_task_still_reports_its_own_failure() {
        let gate = SupersedingTaskGate::<String>::new();
        let (task, task_future) = Deferred::new();
        gate.replace(task_future);
        let waiting = gate.wait();
        task.reject("current renderer failed");
        let error = waiting.await.unwrap_err();
        assert!(matches!(
            error,
            SupersedingTaskError::Rejected(message) if message == "current renderer failed"
        ));
    }

    #[tokio::test]
    async fn a_fresh_gate_resolves_waiters_immediately() {
        let gate = SupersedingTaskGate::<String>::new();
        gate.wait().await.unwrap();
    }

    #[tokio::test]
    async fn successful_current_task_clears_the_gate_for_later_waiters() {
        let gate = SupersedingTaskGate::<String>::new();
        let (task, task_future) = Deferred::new();
        gate.replace(task_future);
        let waiting = gate.wait();
        task.resolve();
        waiting.await.unwrap();
        // The gate is now empty; a new waiter resolves immediately.
        gate.wait().await.unwrap();
    }

    #[tokio::test]
    async fn cleared_then_replaced_tasks_keep_working() {
        let gate = SupersedingTaskGate::<String>::new();
        gate.replace(never());
        gate.clear();
        let (task, task_future) = Deferred::new();
        let token = gate.replace(task_future);
        let waiting = gate.wait();
        assert!(gate.is_current(token));
        task.resolve();
        waiting.await.unwrap();
    }
}

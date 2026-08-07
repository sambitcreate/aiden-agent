//! Generation-bound connection caches — port of
//! `main/services/generation-bound-connection-cache.ts`.
//!
//! Two complementary primitives for MCP connections that must never outlive
//! the generation that created them:
//!
//! - [`GenerationBoundConnectionCache`] retains a connected client across
//!   requests within one generation and invalidates it (and any in-flight
//!   connect) when the generation is superseded. Late connects are closed
//!   after they settle so no transport is left half-alive.
//! - [`GenerationBoundConnectionAttempts`] tracks one-shot connection attempts
//!   that must be invalidated as a group; a cancelled connect is closed again
//!   once it becomes ready.
//!
//! Values are shared by `Arc`; mutation visibility across callbacks therefore
//! requires interior mutability (`Arc<AtomicBool>`, `Mutex`, …) exactly like
//! the TS object identity the port preserves.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::FutureExt;
use parking_lot::Mutex;
use tokio::sync::Notify;

/// Failure taxonomy shared by both caches. `Superseded` is the fail-closed
/// outcome when a generation was invalidated mid-flight.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectionCacheError {
    #[error("The MCP connection was superseded.")]
    Superseded,
    #[error("{0}")]
    Connect(String),
}

/// A synchronous "is this connection still current" predicate handed to
/// connect/use callbacks (the TS `isCurrent`).
pub type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;

/// The async connect/use callback shape: `(value, is_current) -> Result`.
pub type ConnectFn<T, E = ConnectionCacheError> = Arc<
    dyn Fn(Arc<T>, IsCurrent) -> futures::future::BoxFuture<'static, Result<(), E>> + Send + Sync,
>;

/// The async close callback shape: `(value) -> ()` (errors are swallowed).
pub type CloseFn<T> = Arc<dyn Fn(Arc<T>) -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

/// A once-settled shared future result with a completion notification — the
/// Rust counterpart of sharing a single `Promise` across waiters.
struct SharedValue<T> {
    state: Mutex<Option<Result<T, ConnectionCacheError>>>,
    notify: Notify,
}

impl<T: Clone> SharedValue<T> {
    fn new() -> Self {
        Self {
            state: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    async fn wait(&self) -> Result<T, ConnectionCacheError> {
        loop {
            if let Some(result) = self.state.lock().clone() {
                return result;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().is_some() {
                continue;
            }
            notified.as_mut().await;
        }
    }

    fn set(&self, result: Result<T, ConnectionCacheError>) {
        *self.state.lock() = Some(result);
        self.notify.notify_waiters();
    }
}

/// `closeAgainAfterSettled` — run a close exactly once after an operation
/// settles, whether it resolved or rejected.
pub fn close_again_after_settled<F, X>(operation: F, close: X)
where
    F: Future<Output = Result<(), ConnectionCacheError>> + Send + 'static,
    X: Fn() -> futures::future::BoxFuture<'static, ()> + Send + 'static,
{
    tokio::spawn(async move {
        let _ = operation.await;
        close().await;
    });
}

// ===========================================================================
// GenerationBoundConnectionCache<T>
// ===========================================================================

struct ConnectedRecord<T> {
    token: u64,
    value: Arc<T>,
    /// Idempotent post-connect close (`closeOnce`).
    close_once: CloseFn<T>,
}

struct AttemptState<T> {
    token: u64,
    generation: u64,
    value: Arc<T>,
    cancelled: Arc<AtomicBool>,
    /// The plain close (`cancel`): best-effort pre-connect close of the value.
    cancel: CloseFn<T>,
    shared: Arc<SharedValue<T>>,
}

struct CacheInner<T> {
    generations: HashMap<String, u64>,
    pending: HashMap<String, Arc<AttemptState<T>>>,
    connected: HashMap<String, ConnectedRecord<T>>,
    next_token: u64,
}

/// A retained per-id connection cache invalidated by generation.
pub struct GenerationBoundConnectionCache<T> {
    inner: Arc<Mutex<CacheInner<T>>>,
}

impl<T> Default for GenerationBoundConnectionCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> GenerationBoundConnectionCache<T> {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheInner {
                generations: HashMap::new(),
                pending: HashMap::new(),
                connected: HashMap::new(),
                next_token: 1,
            })),
        }
    }

    /// Current generation counter for an id (defaults to 0).
    pub fn generation(&self, id: &str) -> u64 {
        self.inner.lock().generations.get(id).copied().unwrap_or(0)
    }

    /// Live ids across both pending and connected state.
    pub fn ids(&self) -> Vec<String> {
        let inner = self.inner.lock();
        let mut ids: Vec<String> = inner
            .pending
            .keys()
            .chain(inner.connected.keys())
            .cloned()
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Return a retained connection for `id`, connecting once and sharing the
    /// in-flight attempt across concurrent callers. Any superseded or failed
    /// attempt is closed and never cached.
    pub async fn get_or_connect<F, C, X>(
        &self,
        id: &str,
        create: F,
        connect: C,
        close: X,
        expected_generation: Option<u64>,
    ) -> Result<T, ConnectionCacheError>
    where
        T: Clone + Send + Sync + 'static,
        F: Fn() -> T + Send + 'static,
        C: Fn(
                Arc<T>,
                IsCurrent,
            ) -> futures::future::BoxFuture<'static, Result<(), ConnectionCacheError>>
            + Send
            + Sync
            + 'static,
        X: Fn(Arc<T>) -> futures::future::BoxFuture<'static, ()> + Send + Sync + 'static,
    {
        let expected = expected_generation.unwrap_or_else(|| self.generation(id));
        if expected != self.generation(id) {
            return Err(ConnectionCacheError::Superseded);
        }

        let connected_value = self
            .inner
            .lock()
            .connected
            .get(id)
            .map(|record| record.value.clone());
        if let Some(value) = connected_value {
            return Ok((*value).clone());
        }
        let shared_pending = {
            let inner = self.inner.lock();
            inner
                .pending
                .get(id)
                .filter(|pending| pending.generation == expected)
                .map(|pending| pending.shared.clone())
        };
        if let Some(shared) = shared_pending {
            return shared.wait().await;
        }

        let value = Arc::new(create());
        let close = Arc::new(close);
        let token = {
            let mut inner = self.inner.lock();
            let token = inner.next_token;
            inner.next_token += 1;
            token
        };
        // The plain close (`close(value)`): called once per invocation; the
        // post-connect path additionally guards with `closeOnce`.
        let plain_close: CloseFn<T> = Arc::new({
            let value = value.clone();
            let close = close.clone();
            move |_value: Arc<T>| {
                let value = value.clone();
                let close = close.clone();
                async move {
                    close(value).await;
                }
                .boxed()
            }
        });
        // The idempotent post-connect closer (`closeOnce`).
        let idempotent_close: CloseFn<T> = Arc::new({
            let value = value.clone();
            let close = close.clone();
            let closed = Arc::new(AtomicBool::new(false));
            move |_value: Arc<T>| {
                let value = value.clone();
                let close = close.clone();
                let closed = closed.clone();
                async move {
                    if closed.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    close(value).await;
                }
                .boxed()
            }
        });
        let attempt = Arc::new(AttemptState {
            token,
            generation: expected,
            value: value.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            cancel: plain_close,
            shared: Arc::new(SharedValue::new()),
        });
        self.inner
            .lock()
            .pending
            .insert(id.to_string(), attempt.clone());

        let is_current: IsCurrent = {
            let inner = self.inner.clone();
            let id = id.to_string();
            let attempt = attempt.clone();
            let cancelled = attempt.cancelled.clone();
            Arc::new(move || {
                if cancelled.load(Ordering::SeqCst) {
                    return false;
                }
                let guard = inner.lock();
                let generation_matches =
                    guard.generations.get(&id).copied().unwrap_or(0) == attempt.generation;
                let entry_matches = guard
                    .pending
                    .get(&id)
                    .map(|pending| pending.token == attempt.token)
                    .unwrap_or(false)
                    || guard
                        .connected
                        .get(&id)
                        .map(|record| record.token == attempt.token)
                        .unwrap_or(false);
                generation_matches && entry_matches
            })
        };

        let result = {
            let connect = Arc::new(connect);
            connect(value.clone(), is_current.clone()).await
        };

        let outcome = match result {
            Ok(()) => {
                if is_current() {
                    self.inner.lock().connected.insert(
                        id.to_string(),
                        ConnectedRecord {
                            token,
                            value: value.clone(),
                            close_once: idempotent_close,
                        },
                    );
                    Ok((*value).clone())
                } else {
                    idempotent_close(value.clone()).await;
                    Err(ConnectionCacheError::Superseded)
                }
            }
            Err(error) => {
                idempotent_close(value.clone()).await;
                Err(error)
            }
        };

        let still_pending = self
            .inner
            .lock()
            .pending
            .get(id)
            .is_some_and(|pending| pending.token == token);
        if still_pending {
            self.inner.lock().pending.remove(id);
        }
        attempt.shared.set(outcome.clone());
        outcome
    }

    /// Invalidate a generation: bump the counter, cancel any in-flight connect,
    /// and close any retained connection.
    pub async fn disconnect(&self, id: &str) {
        let (pending, connected) = {
            let mut inner = self.inner.lock();
            let next = inner.generations.get(id).copied().unwrap_or(0) + 1;
            inner.generations.insert(id.to_string(), next);
            (inner.pending.remove(id), inner.connected.remove(id))
        };
        if let Some(pending) = pending {
            pending.cancelled.store(true, Ordering::SeqCst);
            (pending.cancel)(pending.value.clone()).await;
        }
        if let Some(connected) = connected {
            (connected.close_once)(connected.value.clone()).await;
        }
    }
}

// ===========================================================================
// GenerationBoundConnectionAttempts<T>
// ===========================================================================

struct AttemptEntry<T> {
    token: u64,
    value: Arc<T>,
    cancelled: Arc<AtomicBool>,
    connection: Mutex<Option<Arc<SharedValue<()>>>>,
    close: CloseFn<T>,
}

struct AttemptsInner<T> {
    generations: HashMap<String, u64>,
    attempts: HashMap<String, HashMap<u64, Arc<AttemptEntry<T>>>>,
    next_token: u64,
}

/// Tracks one-shot connection attempts that must be invalidated as a group.
pub struct GenerationBoundConnectionAttempts<T> {
    inner: Arc<Mutex<AttemptsInner<T>>>,
}

impl<T> Default for GenerationBoundConnectionAttempts<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> GenerationBoundConnectionAttempts<T> {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AttemptsInner {
                generations: HashMap::new(),
                attempts: HashMap::new(),
                next_token: 1,
            })),
        }
    }

    pub fn generation(&self, id: &str) -> u64 {
        self.inner.lock().generations.get(id).copied().unwrap_or(0)
    }

    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.inner.lock().attempts.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Run one connection attempt scoped to a generation: connect, use, and
    /// always close the value afterwards.
    #[allow(clippy::too_many_arguments)]
    pub async fn run<R, F, C, U, X>(
        &self,
        id: &str,
        expected_generation: u64,
        create: F,
        connect: C,
        use_: U,
        close: X,
    ) -> Result<R, ConnectionCacheError>
    where
        T: Send + Sync + 'static,
        R: Send + 'static,
        F: Fn() -> T + Send + 'static,
        C: Fn(
                Arc<T>,
                IsCurrent,
            ) -> futures::future::BoxFuture<'static, Result<(), ConnectionCacheError>>
            + Send
            + Sync
            + 'static,
        U: Fn(
                Arc<T>,
                IsCurrent,
            ) -> futures::future::BoxFuture<'static, Result<R, ConnectionCacheError>>
            + Send
            + Sync
            + 'static,
        X: Fn(Arc<T>) -> futures::future::BoxFuture<'static, ()> + Send + Sync + 'static,
    {
        if expected_generation != self.generation(id) {
            return Err(ConnectionCacheError::Superseded);
        }
        let value = Arc::new(create());
        let close = Arc::new(close);
        let entry_close: CloseFn<T> = Arc::new({
            let value = value.clone();
            let close = close.clone();
            move |_value: Arc<T>| {
                let value = value.clone();
                let close = close.clone();
                async move {
                    close(value).await;
                }
                .boxed()
            }
        });
        let entry = Arc::new(AttemptEntry {
            token: {
                let mut inner = self.inner.lock();
                let token = inner.next_token;
                inner.next_token += 1;
                token
            },
            value: value.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            connection: Mutex::new(None),
            close: entry_close,
        });
        let current = {
            let inner = self.inner.clone();
            let id = id.to_string();
            let entry = entry.clone();
            move || {
                if entry.cancelled.load(Ordering::SeqCst) {
                    return false;
                }
                let guard = inner.lock();
                guard.generations.get(&id).copied().unwrap_or(0) == expected_generation
                    && guard
                        .attempts
                        .get(&id)
                        .is_some_and(|records| records.contains_key(&entry.token))
            }
        };

        {
            let mut inner = self.inner.lock();
            let records = inner.attempts.entry(id.to_string()).or_default();
            records.insert(entry.token, entry.clone());
        }

        let result = async {
            if !current() {
                return Err(ConnectionCacheError::Superseded);
            }
            let shared = Arc::new(SharedValue::new());
            *entry.connection.lock() = Some(shared.clone());
            match connect(value.clone(), Arc::new(current.clone())).await {
                Ok(()) => {
                    shared.set(Ok(()));
                }
                Err(error) => {
                    shared.set(Err(error.clone()));
                    return Err(error);
                }
            }
            if !current() {
                return Err(ConnectionCacheError::Superseded);
            }
            let result = use_(value.clone(), Arc::new(current.clone())).await?;
            if !current() {
                return Err(ConnectionCacheError::Superseded);
            }
            Ok(result)
        }
        .await;

        (entry.close)(value.clone()).await;
        let mut inner = self.inner.lock();
        if let Some(records) = inner.attempts.get_mut(id) {
            records.remove(&entry.token);
            if records.is_empty() {
                inner.attempts.remove(id);
            }
        }
        result
    }
    /// Invalidate a generation: every in-flight attempt is cancelled, closed,
    /// and closed again once its connect settles.
    pub async fn disconnect(&self, id: &str)
    where
        T: Send + Sync + 'static,
    {
        let records: Vec<Arc<AttemptEntry<T>>> = {
            let mut inner = self.inner.lock();
            let next = inner.generations.get(id).copied().unwrap_or(0) + 1;
            inner.generations.insert(id.to_string(), next);
            inner
                .attempts
                .remove(id)
                .map_or_else(Vec::new, |records| records.into_values().collect())
        };
        for record in records.iter().cloned() {
            record.cancelled.store(true, Ordering::SeqCst);
            if let Some(connection) = record.connection.lock().clone() {
                let close = record.close.clone();
                let value = record.value.clone();
                close_again_after_settled(async move { connection.wait().await }, move || {
                    let close = close.clone();
                    let value = value.clone();
                    async move {
                        close(value).await;
                    }
                    .boxed()
                });
            }
        }
        for record in records {
            (record.close)(record.value.clone()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Debug, Clone, Default)]
    struct TestClient {
        id: Arc<AtomicUsize>,
        transport_ready: Arc<AtomicBool>,
        closed_after_ready: Arc<AtomicBool>,
    }

    fn client(id: usize) -> TestClient {
        TestClient {
            id: Arc::new(AtomicUsize::new(id)),
            transport_ready: Arc::new(AtomicBool::new(false)),
            closed_after_ready: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn disconnect_invalidates_an_in_flight_connection_before_it_populates_the_cache() {
        let cache = Arc::new(GenerationBoundConnectionCache::new());
        let created = Arc::new(AtomicUsize::new(0));
        let stale_value: Arc<Mutex<Option<TestClient>>> = Arc::new(Mutex::new(None));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        let created_for_task = created.clone();
        let stale_for_task = stale_value.clone();
        let stale = {
            let cache = cache.clone();
            let create = move || {
                let value = client(created_for_task.fetch_add(1, Ordering::SeqCst) + 1);
                if value.id.load(Ordering::SeqCst) == 1 {
                    *stale_for_task.lock() = Some(value.clone());
                }
                value
            };
            let connect = {
                let release_rx = Arc::new(Mutex::new(Some(release_rx)));
                move |value: Arc<TestClient>, _current: IsCurrent| {
                    let release_rx = release_rx.clone();
                    async move {
                        let receiver = { release_rx.lock().take() };
                        if let Some(receiver) = receiver {
                            let _ = receiver.await;
                        }
                        value.transport_ready.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                }
            };
            let close = move |value: Arc<TestClient>| {
                async move {
                    if value.transport_ready.load(Ordering::SeqCst) {
                        value.closed_after_ready.store(true, Ordering::SeqCst);
                    }
                }
                .boxed()
            };
            tokio::spawn(async move {
                cache
                    .get_or_connect("server", create, connect, close, None)
                    .await
            })
        };

        // Give the spawned connect a chance to start (TS promises start eagerly).
        for _ in 0..100 {
            if stale_value.lock().is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
        cache.disconnect("server").await;
        let _ = release_tx.send(());
        let err = stale.await.unwrap().unwrap_err();
        assert!(matches!(err, ConnectionCacheError::Superseded));
        assert_eq!(created.load(Ordering::SeqCst), 1);
        assert!(stale_value
            .lock()
            .as_ref()
            .unwrap()
            .closed_after_ready
            .load(Ordering::SeqCst));

        let current = cache
            .get_or_connect(
                "server",
                {
                    let created = created.clone();
                    move || client(created.fetch_add(1, Ordering::SeqCst) + 1)
                },
                |value, _current| {
                    async move {
                        value.transport_ready.store(true, Ordering::SeqCst);
                        Ok(())
                    }
                    .boxed()
                },
                |value| {
                    async move {
                        if value.transport_ready.load(Ordering::SeqCst) {
                            value.closed_after_ready.store(true, Ordering::SeqCst);
                        }
                    }
                    .boxed()
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(current.id.load(Ordering::SeqCst), 2);
        assert!(!current.closed_after_ready.load(Ordering::SeqCst));
        assert_eq!(cache.ids(), vec!["server"]);
        cache.disconnect("server").await;
        assert!(current.closed_after_ready.load(Ordering::SeqCst));
        assert!(cache.ids().is_empty());
    }

    #[tokio::test]
    async fn a_failed_connection_attempt_cannot_remain_cached_as_a_rejected_promise() {
        let cache = GenerationBoundConnectionCache::new();
        let created = Arc::new(AtomicUsize::new(0));
        let err = cache
            .get_or_connect(
                "server",
                {
                    let created = created.clone();
                    move || client(created.fetch_add(1, Ordering::SeqCst) + 1)
                },
                |_value, _current| {
                    async move { Err(ConnectionCacheError::Connect("connect failed".into())) }
                        .boxed()
                },
                |_value| async move {}.boxed(),
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(err, ConnectionCacheError::Connect("connect failed".into()));

        let retry = cache
            .get_or_connect(
                "server",
                {
                    let created = created.clone();
                    move || client(created.fetch_add(1, Ordering::SeqCst) + 1)
                },
                |_value, _current| async move { Ok(()) }.boxed(),
                |_value| async move {}.boxed(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(retry.id.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_retained_oauth_style_lease_stays_current_after_connect_until_disconnect() {
        let cache = GenerationBoundConnectionCache::new();
        let connection_is_current: Arc<Mutex<Option<IsCurrent>>> = Arc::new(Mutex::new(None));
        let client_value = cache
            .get_or_connect(
                "oauth-server",
                TestClient::default,
                {
                    let slot = connection_is_current.clone();
                    move |_value, is_current| {
                        let slot = slot.clone();
                        async move {
                            *slot.lock() = Some(is_current);
                            Ok(())
                        }
                        .boxed()
                    }
                },
                |_value| async move {}.boxed(),
                None,
            )
            .await
            .unwrap();

        let read_token_after_connect = || {
            let current = connection_is_current.lock().clone().unwrap();
            if !current() {
                return Err("OAuth connection lease expired.");
            }
            Ok(client_value.id.load(Ordering::SeqCst))
        };
        let _ = read_token_after_connect().unwrap();
        cache.disconnect("oauth-server").await;
        assert_eq!(
            read_token_after_connect().unwrap_err(),
            "OAuth connection lease expired."
        );
    }

    #[tokio::test]
    async fn a_queue_admitted_cache_generation_cannot_start_after_invalidation() {
        let cache = GenerationBoundConnectionCache::new();
        let admitted_generation = cache.generation("server");
        cache.disconnect("server").await;
        let created = Arc::new(AtomicBool::new(false));

        let err = cache
            .get_or_connect(
                "server",
                {
                    let created = created.clone();
                    move || {
                        created.store(true, Ordering::SeqCst);
                        TestClient::default()
                    }
                },
                |_value, _current| async move { Ok(()) }.boxed(),
                |_value| async move {}.boxed(),
                Some(admitted_generation),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ConnectionCacheError::Superseded));
        assert!(!created.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn invalidation_during_auth_resolution_prevents_a_late_transport_start() {
        let cache = GenerationBoundConnectionCache::new();
        let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let transport_started = Arc::new(AtomicBool::new(false));
        let cache = Arc::new(cache);
        let transport_started_for_task = transport_started.clone();

        let pending = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get_or_connect(
                        "server",
                        TestClient::default,
                        {
                            let start_tx = Arc::new(Mutex::new(Some(start_tx)));
                            let release_rx = Arc::new(Mutex::new(Some(release_rx)));
                            let transport_started = transport_started_for_task;
                            move |_value, is_current| {
                                let start_tx = start_tx.clone();
                                let release_rx = release_rx.clone();
                                let transport_started = transport_started.clone();
                                async move {
                                    if let Some(sender) = start_tx.lock().take() {
                                        let _ = sender.send(());
                                    }
                                    let receiver = { release_rx.lock().take() };
                                    if let Some(receiver) = receiver {
                                        let _ = receiver.await;
                                    }
                                    if !is_current() {
                                        return Err(ConnectionCacheError::Superseded);
                                    }
                                    transport_started.store(true, Ordering::SeqCst);
                                    Ok(())
                                }
                                .boxed()
                            }
                        },
                        |_value| async move {}.boxed(),
                        None,
                    )
                    .await
            })
        };

        let _ = start_rx.await;
        cache.disconnect("server").await;
        let _ = release_tx.send(());
        assert!(matches!(
            pending.await.unwrap(),
            Err(ConnectionCacheError::Superseded)
        ));
        assert!(!transport_started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn one_shot_attempts_close_again_after_a_cancelled_connect_becomes_ready() {
        let attempts = Arc::new(GenerationBoundConnectionAttempts::new());
        let generation = attempts.generation("server");
        let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let used = Arc::new(AtomicBool::new(false));
        let created_value: Arc<Mutex<Option<TestClient>>> = Arc::new(Mutex::new(None));
        let used_for_task = used.clone();
        let created_value_for_task = created_value.clone();

        let pending = {
            let attempts = attempts.clone();
            tokio::spawn(async move {
                attempts
                    .run(
                        "server",
                        generation,
                        {
                            let slot = created_value_for_task;
                            move || {
                                let value = TestClient::default();
                                *slot.lock() = Some(value.clone());
                                value
                            }
                        },
                        {
                            let start_tx = Arc::new(Mutex::new(Some(start_tx)));
                            let release_rx = Arc::new(Mutex::new(Some(release_rx)));
                            move |value: Arc<TestClient>, _current: IsCurrent| {
                                let start_tx = start_tx.clone();
                                let release_rx = release_rx.clone();
                                async move {
                                    if let Some(sender) = start_tx.lock().take() {
                                        let _ = sender.send(());
                                    }
                                    let receiver = { release_rx.lock().take() };
                                    if let Some(receiver) = receiver {
                                        let _ = receiver.await;
                                    }
                                    value.transport_ready.store(true, Ordering::SeqCst);
                                    Ok(())
                                }
                                .boxed()
                            }
                        },
                        {
                            let used = used_for_task;
                            move |_value: Arc<TestClient>, _current: IsCurrent| {
                                let used = used.clone();
                                async move {
                                    used.store(true, Ordering::SeqCst);
                                    Ok(())
                                }
                                .boxed()
                            }
                        },
                        move |value: Arc<TestClient>| {
                            async move {
                                if value.transport_ready.load(Ordering::SeqCst) {
                                    value.closed_after_ready.store(true, Ordering::SeqCst);
                                }
                            }
                            .boxed()
                        },
                    )
                    .await
            })
        };

        let _ = start_rx.await;
        attempts.disconnect("server").await;
        let _ = release_tx.send(());
        assert!(matches!(
            pending.await.unwrap(),
            Err(ConnectionCacheError::Superseded)
        ));
        assert!(!used.load(Ordering::SeqCst));
        // The close-again-after-settle teardown runs once the connect is ready.
        for _ in 0..100 {
            if created_value
                .lock()
                .as_ref()
                .is_some_and(|value| value.closed_after_ready.load(Ordering::SeqCst))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(created_value
            .lock()
            .as_ref()
            .unwrap()
            .closed_after_ready
            .load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn post_settlement_teardown_runs_after_either_resolve_or_reject() {
        for rejects in [false, true] {
            let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
            let closed = Arc::new(tokio::sync::Notify::new());
            let operation = async move {
                let _ = release_rx.await;
                if rejects {
                    Err(ConnectionCacheError::Connect("failed".into()))
                } else {
                    Ok(())
                }
            };
            close_again_after_settled(operation, {
                let closed = closed.clone();
                move || {
                    let closed = closed.clone();
                    async move {
                        closed.notify_one();
                    }
                    .boxed()
                }
            });
            let _ = release_tx.send(());
            closed.notified().await;
        }
    }
}

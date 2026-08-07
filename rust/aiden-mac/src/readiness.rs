//! Service-warmup readiness gate — port of
//! `main/services/renderer-readiness-core.ts` adapted for the single-process
//! Rust app.
//!
//! ## Adaptation note
//!
//! The TS module gates Electron renderer documents: a reload replaces the
//! document while callers may already be waiting for its command listener.
//! `reset()` wakes those callers, but `wait()` follows the generation change
//! and does not release them until the newest document is ready.
//!
//! In the GPUI single-process port there is no renderer document to reload,
//! but the same **readiness-state contract** applies to service warmup:
//! callers (e.g. a window that must not start work until the provider
//! registry, chat store, or scheduler are initialized) await [`ReadinessGate`];
//! a failed warmup calls [`ReadinessGate::reset`] to start a new generation,
//! and waiters follow it instead of escaping on the stale one. The
//! Electron-specific `webContents` invalidation wiring is dropped; the pure
//! contract (generation counter + ready flag + notify) is preserved 1:1,
//! including the "disposal releases a waiter" guarantee so teardown cannot
//! hang.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// A generation-following readiness gate (`createRendererReadinessGate`).
///
/// State: a monotonically increasing `generation` plus a `ready` flag for the
/// current generation. `wait()` snapshots the generation, waits for a
/// transition (ready/reset/dispose), and loops when the generation changed —
/// exactly the TS `while (true) { const expectedGeneration = generation;
/// await readyPromise; if (expectedGeneration === generation) return; }`.
#[derive(Debug, Clone, Default)]
pub struct ReadinessGate {
    inner: Arc<ReadinessGateInner>,
}

#[derive(Debug, Default)]
struct ReadinessGateInner {
    generation: AtomicU64,
    ready: AtomicBool,
    notify: Notify,
}

impl ReadinessGate {
    pub fn new() -> Self {
        // A fresh gate is immediately ready (TS: `readyPromise =
        // Promise.resolve()`); the first `reset()` opens the gate.
        let inner = ReadinessGateInner {
            generation: AtomicU64::new(0),
            ready: AtomicBool::new(true),
            notify: Notify::new(),
        };
        Self {
            inner: Arc::new(inner),
        }
    }

    /// Open a new generation: release current waiters (they re-check and
    /// follow the new generation), bump the counter, and mark the new
    /// generation not ready.
    pub fn reset(&self) {
        self.inner.ready.store(false, Ordering::SeqCst);
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    /// Mark the current generation ready, releasing its waiters.
    pub fn mark_ready(&self) {
        self.inner.ready.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    /// Release every waiter so teardown cannot hang. Unlike `mark_ready`,
    /// this does not assert readiness on any future generation.
    pub fn dispose(&self) {
        self.inner.ready.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    /// Await the current generation's readiness. Follows reload generations:
    /// a `reset()` wakes the waiter but does not release it until the newest
    /// generation is ready (or the gate is disposed).
    pub async fn wait(&self) {
        loop {
            let generation = self.inner.generation.load(Ordering::SeqCst);
            if self.ready_for(generation) {
                return;
            }
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // Re-check after enabling the notification to avoid a lost wakeup
            // between the check and the await.
            if self.ready_for(generation) {
                return;
            }
            notified.as_mut().await;
        }
    }

    fn ready_for(&self, generation: u64) -> bool {
        self.inner.ready.load(Ordering::SeqCst)
            && self.inner.generation.load(Ordering::SeqCst) == generation
    }

    /// Whether the current generation is ready.
    pub fn is_ready(&self) -> bool {
        self.inner.ready.load(Ordering::SeqCst)
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_waiter_follows_reload_generations_instead_of_escaping_on_the_obsolete_document() {
        let gate = ReadinessGate::new();
        gate.reset(); // generation 1, not ready
        let waiting = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.wait().await;
                true
            })
        };

        gate.reset(); // generation 2; the waiter must NOT escape
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "waiter must follow the generation");

        gate.mark_ready();
        let delivered = waiting.await.unwrap();
        assert!(delivered);
    }

    #[tokio::test]
    async fn disposal_releases_a_waiter_so_teardown_cannot_hang_it() {
        let gate = ReadinessGate::new();
        gate.reset();
        let waiting = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.wait().await })
        };
        gate.dispose();
        waiting.await.unwrap();
    }

    #[tokio::test]
    async fn a_fresh_gate_is_immediately_ready() {
        let gate = ReadinessGate::new();
        assert!(gate.is_ready());
        gate.wait().await; // resolves without reset/mark
    }

    #[tokio::test]
    async fn reset_then_mark_ready_releases_only_the_new_generation() {
        let gate = ReadinessGate::new();
        gate.reset();
        gate.mark_ready();
        let first = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.wait().await })
        };
        // The gate is ready; a waiter resolves immediately.
        tokio::time::timeout(std::time::Duration::from_secs(1), first)
            .await
            .expect("ready gate must release waiters")
            .unwrap();

        // A waiter captured before reset must follow to the new generation.
        gate.reset();
        let second = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.wait().await })
        };
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        gate.mark_ready();
        tokio::time::timeout(std::time::Duration::from_secs(1), second)
            .await
            .expect("marked-ready gate must release waiters")
            .unwrap();
    }
}

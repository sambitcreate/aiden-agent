//! Quit-barrier logic — port of `main/services/quit-barrier.ts` plus the
//! close-guard decision the Electron `main/index.ts` composes around it.
//!
//! The TS module is a thin Electron binding (`closeRendererBeforeShutdown`
//! closes a `BrowserWindow` and resolves `true` only after the renderer can no
//! longer veto or issue IPC). The port splits it exactly like the rest of the
//! `-core` convention:
//!
//! - [`RendererQuitWindow`] abstracts the window surface (destroyed state,
//!   `close()`, and the two terminal events the machine listens for);
//! - [`close_renderer_before_shutdown`] drives that surface with the same
//!   semantics — destroyed windows resolve immediately, an unload veto
//!   (`will-prevent-unload`) resolves `false` and leaves the renderer alive,
//!   and listener cleanup never dereferences a destroyed window;
//! - [`QuitBarrier`] is a tiny state machine holding the app-level quit
//!   decision: **in-flight generations block quit unless forced**, and the
//!   renderer must be closed first.
//!
//! The window-close half is fully unit-tested with a fake window (the same
//! contract as `quit-barrier.test.ts`); nothing here touches Electron.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// The two terminal events a close attempt can produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererQuitEvent {
    /// The window actually closed.
    Closed,
    /// The renderer vetoed the close (`will-prevent-unload`).
    WillPreventUnload,
}

/// The abstracted window surface (Electron `BrowserWindow` in the TS; a GPUI
/// window / entity handle in the Rust app). Implementations must retain the
/// listener handles before closing — the machine only calls
/// [`RendererQuitWindow::remove_listener`] after the close settles, and never
/// touches a destroyed object otherwise.
pub trait RendererQuitWindow {
    fn is_destroyed(&self) -> bool;

    /// Register a one-shot listener for a terminal event. `id` is the token
    /// returned by this call site for later removal.
    fn add_listener(
        &self,
        event: RendererQuitEvent,
        id: u64,
        listener: Box<dyn FnOnce() + Send + 'static>,
    );

    fn remove_listener(&self, event: RendererQuitEvent, id: u64);

    /// Request the close. May fire either terminal event synchronously.
    fn close(&self);
}

/// A no-op window used to keep the trait object-safe in generic-free call
/// sites (tests use a real fake instead).
#[derive(Debug, Clone, Default)]
pub struct NoopRendererQuitWindow;

impl RendererQuitWindow for NoopRendererQuitWindow {
    fn is_destroyed(&self) -> bool {
        true
    }
    fn add_listener(
        &self,
        _event: RendererQuitEvent,
        _id: u64,
        _listener: Box<dyn FnOnce() + Send + 'static>,
    ) {
    }
    fn remove_listener(&self, _event: RendererQuitEvent, _id: u64) {}
    fn close(&self) {}
}

/// Resolve `true` only after the renderer can no longer veto or issue IPC
/// (`closeRendererBeforeShutdown`).
///
/// Semantics, byte-faithful to the TS:
/// - an already-destroyed window resolves `true` without calling `close()`;
/// - the first terminal event wins; the loser is ignored;
/// - both listeners are removed afterward, best-effort (a destroyed window's
///   method access may throw — the trait impl absorbs that);
/// - `close()` may fire either terminal event synchronously; both races are
///   handled.
///
/// The outcome is a shared first-wins slot rather than a pair of oneshot
/// channels: with oneshots, dropping the *losing* listener's sender turns the
/// other receiver into a `Ready(Err)`, which tokio's fair `select!` can pick
/// at random.
pub async fn close_renderer_before_shutdown<W: RendererQuitWindow>(window: &W) -> bool {
    if window.is_destroyed() {
        return true;
    }
    let outcome = Arc::new(CloseOutcome::default());
    // Retain both listener ids before closing: after `closed` fires, the
    // window object is no longer trustworthy (TS: "a real BrowserWindow can
    // reject method access after destruction").
    let closed_id = next_listener_id();
    let veto_id = next_listener_id();
    let closed_slot = outcome.clone();
    window.add_listener(
        RendererQuitEvent::Closed,
        closed_id,
        Box::new(move || closed_slot.settle(true)),
    );
    let veto_slot = outcome.clone();
    window.add_listener(
        RendererQuitEvent::WillPreventUnload,
        veto_id,
        Box::new(move || veto_slot.settle(false)),
    );
    window.close();
    let result = outcome.wait().await;
    window.remove_listener(RendererQuitEvent::Closed, closed_id);
    window.remove_listener(RendererQuitEvent::WillPreventUnload, veto_id);
    result
}

/// A first-wins `bool` slot shared between the two terminal listeners.
#[derive(Debug, Default)]
struct CloseOutcome {
    value: AtomicU8, // 0 unset, 1 closed, 2 vetoed
    notify: Notify,
}

impl CloseOutcome {
    fn settle(&self, closed: bool) {
        let value = if closed { 1 } else { 2 };
        if self
            .value
            .compare_exchange(0, value, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.notify.notify_waiters();
        }
    }

    async fn wait(&self) -> bool {
        loop {
            match self.value.load(Ordering::SeqCst) {
                1 => return true,
                2 => return false,
                _ => {}
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.value.load(Ordering::SeqCst) != 0 {
                continue;
            }
            notified.as_mut().await;
        }
    }
}

fn next_listener_id() -> u64 {
    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    NEXT_ID.fetch_add(1, Ordering::Relaxed) as u64
}

/// The app-level quit-decision state machine.
///
/// `main/index.ts` composes `closeRendererBeforeShutdown` with the in-flight
/// generation count before running `shutdownAndQuit()`. This is that decision
/// as pure logic: **generations block quit unless the quit is forced**, and
/// the renderer must be closed before irreversible service shutdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPhase {
    /// Nothing is running and the renderer is closed — quit may proceed.
    ReadyToQuit,
    /// One or more generations are in flight; blocked unless forced.
    BlockedByGenerations,
    /// The renderer has not confirmed it can no longer veto.
    BlockedByRenderer,
    /// Both gates are still open.
    Blocked,
}

/// The quit-barrier state machine. Cheap to clone; shares one atomic state.
#[derive(Debug, Clone, Default)]
pub struct QuitBarrier {
    state: Arc<QuitBarrierState>,
}

#[derive(Debug, Default)]
struct QuitBarrierState {
    in_flight_generations: AtomicUsize,
    renderer_closed: AtomicBool,
    forced: AtomicBool,
}

impl QuitBarrier {
    pub fn new() -> Self {
        Self::default()
    }

    /// A generation started (blocks quit).
    pub fn note_generation_started(&self) {
        self.state
            .in_flight_generations
            .fetch_add(1, Ordering::SeqCst);
    }

    /// A generation settled.
    pub fn note_generation_finished(&self) {
        self.state
            .in_flight_generations
            .fetch_sub(1, Ordering::SeqCst);
    }

    /// The renderer can no longer veto (its window closed).
    pub fn note_renderer_closed(&self) {
        self.state.renderer_closed.store(true, Ordering::SeqCst);
    }

    /// The renderer vetoed the close; it is still alive.
    pub fn note_renderer_vetoed(&self) {
        self.state.renderer_closed.store(false, Ordering::SeqCst);
    }

    /// Force the quit through the generation gate (the user explicitly chose
    /// to quit / the app is tearing down regardless).
    pub fn force(&self) {
        self.state.forced.store(true, Ordering::SeqCst);
    }

    pub fn forced(&self) -> bool {
        self.state.forced.load(Ordering::SeqCst)
    }

    pub fn in_flight_generations(&self) -> usize {
        self.state.in_flight_generations.load(Ordering::SeqCst)
    }

    pub fn renderer_closed(&self) -> bool {
        self.state.renderer_closed.load(Ordering::SeqCst)
    }

    /// The pure generation gate: in-flight generations block quit unless
    /// forced (`quit_blocked_by_generations`).
    pub fn quit_blocked_by_generations(&self) -> bool {
        quit_blocked_by_generations(self.in_flight_generations(), self.forced())
    }

    /// May irreversible service shutdown begin?
    pub fn may_quit(&self) -> bool {
        self.renderer_closed() && !self.quit_blocked_by_generations()
    }

    pub fn phase(&self) -> QuitPhase {
        let renderer_open = !self.renderer_closed();
        let generations_block = self.quit_blocked_by_generations();
        match (renderer_open, generations_block) {
            (false, false) => QuitPhase::ReadyToQuit,
            (false, true) => QuitPhase::BlockedByGenerations,
            (true, false) => QuitPhase::BlockedByRenderer,
            (true, true) => QuitPhase::Blocked,
        }
    }
}

/// Pure quit-blocking decision: `in_flight_generations > 0 && !forced`.
pub fn quit_blocked_by_generations(in_flight_generations: usize, forced: bool) -> bool {
    in_flight_generations > 0 && !forced
}

/// The full close-guard decision used before `shutdownAndQuit()`: the renderer
/// must be closed and generations must not be blocking (unless forced).
pub fn should_block_quit(
    in_flight_generations: usize,
    renderer_closed: bool,
    forced: bool,
) -> bool {
    !renderer_closed || quit_blocked_by_generations(in_flight_generations, forced)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `FakeQuitWindow` from `quit-barrier.test.ts`: `close()` fires
    /// `will-prevent-unload` when `prevent_unload` is set, else marks itself
    /// destroyed and fires `closed`.
    #[derive(Default)]
    struct FakeQuitWindow {
        destroyed: AtomicBool,
        prevent_unload: AtomicBool,
        // type_complexity is inherent to the FnOnce listener list; the
        // trait keeps the real binding surface simple.
        #[allow(clippy::type_complexity)]
        listeners: std::sync::Mutex<Vec<(RendererQuitEvent, u64, Box<dyn FnOnce() + Send>)>>,
    }

    impl FakeQuitWindow {
        fn prevent_unload(&self) {
            self.prevent_unload.store(true, Ordering::SeqCst);
        }
        fn listener_count(&self) -> usize {
            self.listeners.lock().unwrap().len()
        }
    }

    impl RendererQuitWindow for FakeQuitWindow {
        fn is_destroyed(&self) -> bool {
            self.destroyed.load(Ordering::SeqCst)
        }
        fn add_listener(
            &self,
            event: RendererQuitEvent,
            id: u64,
            listener: Box<dyn FnOnce() + Send + 'static>,
        ) {
            self.listeners.lock().unwrap().push((event, id, listener));
        }
        fn remove_listener(&self, event: RendererQuitEvent, id: u64) {
            self.listeners
                .lock()
                .unwrap()
                .retain(|(kept_event, kept_id, _)| *kept_event != event || *kept_id != id);
        }
        fn close(&self) {
            // Take the listeners out (FnOnce is not Clone); the machine calls
            // close exactly once per barrier.
            let listeners = std::mem::take(&mut *self.listeners.lock().unwrap());
            if self.prevent_unload.load(Ordering::SeqCst) {
                for (event, _, listener) in listeners {
                    if event == RendererQuitEvent::WillPreventUnload {
                        listener();
                    }
                }
                return;
            }
            self.destroyed.store(true, Ordering::SeqCst);
            for (event, _, listener) in listeners {
                if event == RendererQuitEvent::Closed {
                    listener();
                }
            }
        }
    }

    #[tokio::test]
    async fn closes_the_renderer_before_allowing_irreversible_service_shutdown() {
        let window = FakeQuitWindow::default();
        assert!(close_renderer_before_shutdown(&window).await);
        assert!(window.is_destroyed());
        assert_eq!(window.listener_count(), 0);
    }

    #[tokio::test]
    async fn an_unload_veto_blocks_service_shutdown_and_leaves_the_renderer_alive() {
        let window = FakeQuitWindow::default();
        window.prevent_unload();
        assert!(!close_renderer_before_shutdown(&window).await);
        assert!(!window.is_destroyed());
        assert_eq!(window.listener_count(), 0);
    }

    #[tokio::test]
    async fn an_already_destroyed_window_resolves_immediately() {
        let window = FakeQuitWindow::default();
        window.destroyed.store(true, Ordering::SeqCst);
        assert!(close_renderer_before_shutdown(&window).await);
    }

    #[test]
    fn quit_barrier_state_machine() {
        let barrier = QuitBarrier::new();
        // Fresh barrier: renderer open, no generations → blocked by renderer.
        assert_eq!(barrier.phase(), QuitPhase::BlockedByRenderer);
        assert!(!barrier.may_quit());

        barrier.note_renderer_closed();
        assert_eq!(barrier.phase(), QuitPhase::ReadyToQuit);
        assert!(barrier.may_quit());

        // A generation starts → blocks quit.
        barrier.note_generation_started();
        barrier.note_generation_started();
        assert_eq!(barrier.in_flight_generations(), 2);
        assert_eq!(barrier.phase(), QuitPhase::BlockedByGenerations);
        assert!(!barrier.may_quit());

        // Force overrides the generation gate.
        barrier.force();
        assert!(!barrier.quit_blocked_by_generations());
        assert_eq!(barrier.phase(), QuitPhase::ReadyToQuit);
        assert!(barrier.may_quit());

        // A renderer veto re-opens the renderer gate.
        barrier.note_renderer_vetoed();
        assert_eq!(barrier.phase(), QuitPhase::BlockedByRenderer);
        barrier.note_renderer_closed();
        assert!(barrier.may_quit());

        // Settling the in-flight generations under force keeps the gate open.
        barrier.note_generation_finished();
        barrier.note_generation_finished();
        assert_eq!(barrier.in_flight_generations(), 0);
        assert!(barrier.may_quit());
        assert_eq!(barrier.phase(), QuitPhase::ReadyToQuit);
    }

    #[test]
    fn pure_generation_gate() {
        assert!(quit_blocked_by_generations(1, false));
        assert!(quit_blocked_by_generations(3, false));
        assert!(!quit_blocked_by_generations(0, false));
        assert!(!quit_blocked_by_generations(1, true));
        assert!(!quit_blocked_by_generations(0, true));
        assert!(should_block_quit(0, false, false));
        assert!(should_block_quit(2, true, false));
        assert!(!should_block_quit(0, true, false));
        assert!(!should_block_quit(2, true, true));
    }

    #[tokio::test]
    async fn a_real_close_invalidates_window_method_access_during_cleanup() {
        // The TS guards listener cleanup against destroyed-window access. The
        // trait contract moves that guarantee into the implementation: removal
        // after a real close must be a no-op, never a panic.
        struct DestroyingWindow(FakeQuitWindow);
        impl RendererQuitWindow for DestroyingWindow {
            fn is_destroyed(&self) -> bool {
                self.0.is_destroyed()
            }
            fn add_listener(
                &self,
                event: RendererQuitEvent,
                id: u64,
                listener: Box<dyn FnOnce() + Send + 'static>,
            ) {
                self.0.add_listener(event, id, listener)
            }
            fn remove_listener(&self, event: RendererQuitEvent, id: u64) {
                // After destruction the double may "reject method access".
                if !self.is_destroyed() {
                    self.0.remove_listener(event, id);
                }
            }
            fn close(&self) {
                self.0.close()
            }
        }
        let inner = FakeQuitWindow::default();
        let window = DestroyingWindow(inner);
        assert!(close_renderer_before_shutdown(&window).await);
        assert!(window.is_destroyed());
    }
}

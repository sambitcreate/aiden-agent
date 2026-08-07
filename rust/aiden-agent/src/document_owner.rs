//! Renderer document ownership — port of `main/services/renderer-document-owner.ts`
//! (the engine behind `provider-auth-owner.ts`).
//!
//! Binds interactive work (auth flows, approvals, generation) to the exact
//! renderer *document* that invoked it: a `(webContents id, frame identity)`
//! pair with an epoch. Any committed navigation, render-process loss, or
//! destruction invalidates the captured document once; a replacement document
//! in the same WebContents cannot answer or cancel work owned by the old one.
//!
//! The Electron surfaces (`WebContents`, `WebFrameMain`) are injected through
//! the [`RendererWebContents`] trait so tests exercise the real state machine
//! without Electron.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

/// The stable identity of one frame (`processId:routingId:frameToken`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameIdentity {
    pub process_id: u32,
    pub routing_id: u32,
    pub frame_token: String,
}

impl FrameIdentity {
    pub fn document_id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.process_id, self.routing_id, self.frame_token
        )
    }
}

/// The minimal Electron `WebContents` surface the owner reads and subscribes
/// to. Implementations must be `Send + Sync` (the fake in tests is a plain
/// shared structure).
pub trait RendererWebContents: Send + Sync {
    fn id(&self) -> u64;
    fn is_destroyed(&self) -> bool;
    /// The currently committed main frame, or `None` when detached/destroyed.
    fn main_frame(&self) -> Option<FrameIdentity>;
    /// Send a notification to one frame. `Err` when the target is gone.
    #[allow(clippy::result_unit_err)]
    fn send(&self, frame: &FrameIdentity, channel: &str, payload: &Value) -> Result<(), ()>;
    /// did-navigate listener; returns the removal closure.
    fn on_did_navigate(&self, listener: Arc<dyn Fn() + Send + Sync>)
        -> Box<dyn Fn() + Send + Sync>;
    /// render-process-gone listener; returns the removal closure.
    fn on_render_process_gone(
        &self,
        listener: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn Fn() + Send + Sync>;
    /// destroyed listener; returns the removal closure.
    fn on_destroyed(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn Fn() + Send + Sync>;
}

/// A structured failure for invalid owner captures.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct DocumentOwnerError(pub String);

#[derive(Default)]
struct SharedState {
    epoch: AtomicU64,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
}

impl SharedState {
    fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        // Consume the listener list: each callback fires at most once, and a
        // throwing terminal-teardown listener cannot starve later ones.
        let listeners = std::mem::take(&mut *self.listeners.lock().unwrap());
        for listener in listeners {
            let _ = catch_unwind(AssertUnwindSafe(|| listener()));
        }
    }
}

fn is_current_main_frame(webcontents: &dyn RendererWebContents, frame: &FrameIdentity) -> bool {
    if webcontents.is_destroyed() {
        return false;
    }
    match webcontents.main_frame() {
        Some(main) => main == *frame,
        None => false,
    }
}

/// A renderer document captured behind an interactive request.
pub struct RendererDocumentOwnerCore {
    id: u64,
    document_id: String,
    epoch: u64,
    frame: FrameIdentity,
    webcontents: Arc<dyn RendererWebContents>,
    state: Arc<SharedState>,
}

impl RendererDocumentOwnerCore {
    /// `rendererDocumentOwner(event, invalidRequest)` — capture the exact
    /// active main-frame document behind an interactive IPC request.
    pub fn capture(
        webcontents: Arc<dyn RendererWebContents>,
        frame: Option<FrameIdentity>,
    ) -> Result<Self, DocumentOwnerError> {
        let Some(frame) = frame else {
            return Err(DocumentOwnerError(
                "Provider authentication must start from the active application document."
                    .to_string(),
            ));
        };
        if !is_current_main_frame(webcontents.as_ref(), &frame) {
            return Err(DocumentOwnerError(
                "Provider authentication must start from the active application document."
                    .to_string(),
            ));
        }

        let state = Arc::new(SharedState::default());
        let invalidate = {
            let state = state.clone();
            Arc::new(move || state.invalidate())
        };
        let remove_navigate = webcontents.on_did_navigate(invalidate.clone());
        let remove_gone = webcontents.on_render_process_gone(invalidate.clone());
        let on_destroyed = {
            let state = state.clone();
            let remove_navigate = remove_navigate;
            let remove_gone = remove_gone;
            Arc::new(move || {
                state.invalidate();
                remove_navigate();
                remove_gone();
            })
        };
        let _remove_destroyed = webcontents.on_destroyed(on_destroyed);

        Ok(Self {
            id: webcontents.id(),
            document_id: frame.document_id(),
            epoch: state.epoch.load(Ordering::SeqCst),
            frame,
            webcontents,
            state,
        })
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn document_id(&self) -> &str {
        &self.document_id
    }

    /// `isDestroyed()` — the document epoch advanced or the frame was replaced.
    pub fn is_destroyed(&self) -> bool {
        self.state.epoch.load(Ordering::SeqCst) != self.epoch
            || !is_current_main_frame(self.webcontents.as_ref(), &self.frame)
    }

    /// `send(channel, payload)` — throws when the document is no longer active.
    #[allow(clippy::result_unit_err)]
    pub fn send(&self, channel: &str, payload: &Value) -> Result<(), ()> {
        if self.is_destroyed() {
            return Err(());
        }
        self.webcontents.send(&self.frame, channel, payload)
    }

    /// `onInvalidated(listener)` — register an invalidation callback that
    /// fires at most once (the TS removes the wrapper before invoking, so a
    /// later did-navigate/render-process-gone never re-fires it); returns the
    /// removal closure.
    pub fn on_invalidated(
        &self,
        listener: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn Fn() + Send + Sync> {
        if self.is_destroyed() {
            let _ = catch_unwind(AssertUnwindSafe(|| listener()));
            return Box::new(|| {});
        }
        self.state.listeners.lock().unwrap().push(listener.clone());
        let state = self.state.clone();
        Box::new(move || {
            let mut listeners = state.listeners.lock().unwrap();
            listeners.retain(|candidate| !Arc::ptr_eq(candidate, &listener));
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    #[derive(Clone)]
    struct FakeFrame {
        process_id: u32,
        routing_id: u32,
        frame_token: String,
        sent: Arc<Mutex<Vec<(String, Value)>>>,
        detached: Arc<AtomicBool>,
        destroyed: Arc<AtomicBool>,
    }

    impl FakeFrame {
        fn new(process_id: u32, routing_id: u32, frame_token: &str) -> Self {
            Self {
                process_id,
                routing_id,
                frame_token: frame_token.to_string(),
                sent: Arc::new(Mutex::new(Vec::new())),
                detached: Arc::new(AtomicBool::new(false)),
                destroyed: Arc::new(AtomicBool::new(false)),
            }
        }

        fn identity(&self) -> FrameIdentity {
            FrameIdentity {
                process_id: self.process_id,
                routing_id: self.routing_id,
                frame_token: self.frame_token.clone(),
            }
        }
    }

    type ListenerList = Arc<Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>>;

    struct FakeWebContents {
        id: u64,
        main_frame: Mutex<Option<FakeFrame>>,
        navigate_listeners: ListenerList,
        gone_listeners: ListenerList,
        destroyed_listeners: ListenerList,
        destroyed: AtomicBool,
    }

    impl FakeWebContents {
        fn new(id: u64, main_frame: FakeFrame) -> Self {
            Self {
                id,
                main_frame: Mutex::new(Some(main_frame)),
                navigate_listeners: Arc::new(Mutex::new(Vec::new())),
                gone_listeners: Arc::new(Mutex::new(Vec::new())),
                destroyed_listeners: Arc::new(Mutex::new(Vec::new())),
                destroyed: AtomicBool::new(false),
            }
        }

        fn emit(&self, event: &str) {
            let listeners: Vec<Arc<dyn Fn() + Send + Sync>> = match event {
                "did-navigate" => self.navigate_listeners.lock().unwrap().clone(),
                "render-process-gone" => self.gone_listeners.lock().unwrap().clone(),
                "destroyed" => self.destroyed_listeners.lock().unwrap().clone(),
                _ => Vec::new(),
            };
            for listener in listeners {
                listener();
            }
        }

        fn replace_main_frame(&self, frame: FakeFrame) {
            *self.main_frame.lock().unwrap() = Some(frame);
        }
    }

    impl RendererWebContents for FakeWebContents {
        fn id(&self) -> u64 {
            self.id
        }
        fn is_destroyed(&self) -> bool {
            self.destroyed.load(Ordering::SeqCst)
        }
        fn main_frame(&self) -> Option<FrameIdentity> {
            self.main_frame
                .lock()
                .unwrap()
                .as_ref()
                .map(FakeFrame::identity)
        }
        fn send(&self, frame: &FrameIdentity, channel: &str, payload: &Value) -> Result<(), ()> {
            let guard = self.main_frame.lock().unwrap();
            let Some(current) = guard.as_ref() else {
                return Err(());
            };
            if current.identity() != *frame
                || current.destroyed.load(Ordering::SeqCst)
                || current.detached.load(Ordering::SeqCst)
            {
                return Err(());
            }
            current
                .sent
                .lock()
                .unwrap()
                .push((channel.to_string(), payload.clone()));
            Ok(())
        }
        fn on_did_navigate(
            &self,
            listener: Arc<dyn Fn() + Send + Sync>,
        ) -> Box<dyn Fn() + Send + Sync> {
            self.navigate_listeners
                .lock()
                .unwrap()
                .push(listener.clone());
            let listeners = self.navigate_listeners.clone();
            Box::new(move || {
                listeners
                    .lock()
                    .unwrap()
                    .retain(|candidate| !Arc::ptr_eq(candidate, &listener));
            })
        }
        fn on_render_process_gone(
            &self,
            listener: Arc<dyn Fn() + Send + Sync>,
        ) -> Box<dyn Fn() + Send + Sync> {
            self.gone_listeners.lock().unwrap().push(listener.clone());
            let listeners = self.gone_listeners.clone();
            Box::new(move || {
                listeners
                    .lock()
                    .unwrap()
                    .retain(|candidate| !Arc::ptr_eq(candidate, &listener));
            })
        }
        fn on_destroyed(
            &self,
            listener: Arc<dyn Fn() + Send + Sync>,
        ) -> Box<dyn Fn() + Send + Sync> {
            self.destroyed_listeners
                .lock()
                .unwrap()
                .push(listener.clone());
            let listeners = self.destroyed_listeners.clone();
            Box::new(move || {
                listeners
                    .lock()
                    .unwrap()
                    .retain(|candidate| !Arc::ptr_eq(candidate, &listener));
            })
        }
    }

    fn capture(
        sender: &Arc<FakeWebContents>,
        frame: Option<FakeFrame>,
    ) -> Result<RendererDocumentOwnerCore, DocumentOwnerError> {
        RendererDocumentOwnerCore::capture(sender.clone(), frame.map(|frame| frame.identity()))
    }

    #[test]
    fn binds_notifications_to_the_exact_invoking_frame_not_the_mutable_webcontents_target() {
        let original = FakeFrame::new(10, 20, "old-document");
        let sender = Arc::new(FakeWebContents::new(1, original.clone()));
        let owner = capture(&sender, Some(original.clone())).expect("capture");

        owner
            .send("providers:auth:prompt", &Value::from("one"))
            .unwrap();
        assert_eq!(
            *original.sent.lock().unwrap(),
            vec![("providers:auth:prompt".to_string(), Value::from("one"))]
        );

        let replacement = FakeFrame::new(10, 21, "new-document");
        sender.replace_main_frame(replacement.clone());
        assert!(owner.is_destroyed());
        assert!(owner.send("providers:auth:prompt", &Value::Null).is_err());
        assert!(replacement.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_a_capture_queued_from_a_document_that_navigation_already_replaced() {
        let old_frame = FakeFrame::new(10, 20, "old-document");
        let current_frame = FakeFrame::new(10, 21, "new-document");
        let sender = Arc::new(FakeWebContents::new(1, current_frame));

        assert!(capture(&sender, Some(old_frame)).is_err());
        assert!(capture(&sender, None).is_err());
    }

    #[test]
    fn remembers_committed_navigation_without_requiring_an_invalidation_subscriber() {
        let frame = FakeFrame::new(10, 20, "document");
        let sender = Arc::new(FakeWebContents::new(1, frame));
        let owner = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("capture");

        sender.emit("did-navigate");

        assert!(owner.is_destroyed());
        assert!(owner.send("providers:auth:prompt", &Value::Null).is_err());
    }

    #[test]
    fn invalidates_committed_navigation_once_and_ignores_prevented_provisional_links() {
        let frame = FakeFrame::new(10, 20, "document");
        let sender = Arc::new(FakeWebContents::new(1, frame));
        let owner = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("capture");
        let invalidations = Arc::new(AtomicUsize::new(0));
        let invalidations_for_listener = invalidations.clone();
        let remove = owner.on_invalidated(Arc::new(move || {
            invalidations_for_listener.fetch_add(1, Ordering::SeqCst);
        }));

        // A prevented provisional link does not invalidate the committed document.
        assert!(!owner.is_destroyed());

        sender.emit("did-navigate");
        assert_eq!(invalidations.load(Ordering::SeqCst), 1);
        assert!(owner.is_destroyed());
        assert!(owner.send("providers:auth:prompt", &Value::Null).is_err());

        // Subsequent events never re-fire a revoked callback.
        sender.emit("did-navigate");
        sender.emit("render-process-gone");
        assert_eq!(invalidations.load(Ordering::SeqCst), 1);
        remove();
    }

    #[test]
    fn delayed_delivery_cannot_cross_a_committed_same_frame_navigation() {
        let frame = FakeFrame::new(10, 20, "document");
        let sender = Arc::new(FakeWebContents::new(1, frame.clone()));
        let owner = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("capture");
        let remove = owner.on_invalidated(Arc::new(|| {}));

        sender.emit("did-navigate");

        assert!(owner.send("chat:subagents", &Value::Null).is_err());
        assert!(frame.sent.lock().unwrap().is_empty());
        remove();
    }

    #[test]
    fn renderer_process_loss_invalidates_the_captured_document_once() {
        let frame = FakeFrame::new(10, 20, "document");
        let sender = Arc::new(FakeWebContents::new(1, frame));
        let owner = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("capture");
        let invalidations = Arc::new(AtomicUsize::new(0));
        let invalidations_for_listener = invalidations.clone();
        let remove = owner.on_invalidated(Arc::new(move || {
            invalidations_for_listener.fetch_add(1, Ordering::SeqCst);
        }));

        sender.emit("render-process-gone");
        sender.emit("destroyed");
        assert_eq!(invalidations.load(Ordering::SeqCst), 1);
        remove();
    }

    #[test]
    fn one_throwing_document_invalidation_cannot_starve_later_revocation_callbacks() {
        let frame = FakeFrame::new(10, 20, "document");
        let sender = Arc::new(FakeWebContents::new(1, frame));
        let first = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("first");
        let second = capture(&sender, Some(FakeFrame::new(10, 20, "document"))).expect("second");
        let later_invalidations = Arc::new(AtomicUsize::new(0));
        let later_for_listener = later_invalidations.clone();
        let _remove_first =
            first.on_invalidated(Arc::new(|| panic!("simulated terminal teardown failure")));
        let _remove_second = second.on_invalidated(Arc::new(move || {
            later_for_listener.fetch_add(1, Ordering::SeqCst);
        }));

        sender.emit("did-navigate");
        sender.emit("render-process-gone");
        sender.emit("destroyed");

        assert_eq!(later_invalidations.load(Ordering::SeqCst), 1);
        assert!(first.is_destroyed());
        assert!(second.is_destroyed());
    }
}

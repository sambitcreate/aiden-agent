//! Native macOS profile-image sharing with bounded private-file ownership.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiden_data::profile::{
    cleanup_stale_profile_share_directories, create_profile_share_file,
    remove_profile_share_directory, validate_profile_share_png,
};

const SELECTED_FILE_RETENTION: Duration = Duration::from_secs(5 * 60);
const PICKER_MAX_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileShareOutcome {
    Selected,
    Cancelled,
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileShareError {
    #[error("The native profile share sheet is available on macOS.")]
    Unsupported,
    #[error("The profile snapshot is empty or too large.")]
    InvalidSize,
    #[error("Close the current share menu before opening another one.")]
    AlreadyOpen,
    #[error("AppKit must be called from the macOS main thread.")]
    NotMainThread,
    #[error("The profile window is no longer available for sharing.")]
    MissingWindow,
    #[error("Could not open the native profile share menu.")]
    NativePicker,
    #[error(transparent)]
    Profile(#[from] aiden_data::profile::ProfileError),
}

#[derive(Debug)]
struct ActiveShare {
    directory: PathBuf,
    generation: u64,
}

/// Owns the one native profile share picker and its private temporary file.
///
/// The picker receives only a file URL. The generated PNG bytes stay in a
/// private 0600 file and are removed immediately on cancellation, five minutes
/// after a service is selected, or after the one-hour owner deadline.
#[derive(Clone, Default)]
pub struct ProfileShareAuthority {
    state: Arc<Mutex<Option<ActiveShare>>>,
    generation: Arc<std::sync::atomic::AtomicU64>,
}

impl ProfileShareAuthority {
    pub fn new() -> Self {
        Self::default()
    }

    /// Publish a generated 1200×1600 PNG to the native macOS share picker.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid byte bounds, concurrent pickers, private
    /// file failures, missing AppKit window ownership, or off-main-thread use.
    pub fn share_png(&self, image: &[u8]) -> Result<(), ProfileShareError> {
        validate_profile_share_png(image).map_err(|_| ProfileShareError::InvalidSize)?;
        if self
            .state
            .lock()
            .map_err(|_| ProfileShareError::NativePicker)?
            .is_some()
        {
            return Err(ProfileShareError::AlreadyOpen);
        }

        let temporary_root = std::env::temp_dir();
        let _ = cleanup_stale_profile_share_directories(
            &temporary_root,
            &HashSet::new(),
            aiden_data::now_millis(),
        );
        let created = create_profile_share_file(image, &temporary_root)?;
        let receiver = match native::show(&created.file_path) {
            Ok(receiver) => receiver,
            Err(error) => {
                let _ = remove_profile_share_directory(&created.directory);
                return Err(error);
            }
        };

        let generation = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .wrapping_add(1);
        *self
            .state
            .lock()
            .map_err(|_| ProfileShareError::NativePicker)? = Some(ActiveShare {
            directory: created.directory.clone(),
            generation,
        });

        let state = self.state.clone();
        std::thread::spawn(move || {
            let outcome = receiver
                .recv_timeout(PICKER_MAX_AGE)
                .unwrap_or(ProfileShareOutcome::Cancelled);
            let directory = state.lock().ok().and_then(|mut active| {
                let is_current = active
                    .as_ref()
                    .is_some_and(|active| active.generation == generation);
                is_current
                    .then(|| active.take().map(|active| active.directory))
                    .flatten()
            });
            if outcome == ProfileShareOutcome::Selected {
                std::thread::sleep(SELECTED_FILE_RETENTION);
            }
            if let Some(directory) = directory {
                let _ = remove_profile_share_directory(&directory);
            }
        });
        Ok(())
    }

    /// Close any owned native picker and remove its private file.
    pub fn cancel(&self) {
        native::cancel();
        let directory = self
            .state
            .lock()
            .ok()
            .and_then(|mut active| active.take().map(|active| active.directory));
        if let Some(directory) = directory {
            let _ = remove_profile_share_directory(&directory);
        }
    }

    #[cfg(test)]
    fn active_directory(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .ok()
            .and_then(|active| active.as_ref().map(|active| active.directory.clone()))
    }
}

impl Drop for ProfileShareAuthority {
    fn drop(&mut self) {
        if Arc::strong_count(&self.state) == 1 {
            self.cancel();
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::cell::{OnceCell, RefCell};
    use std::path::Path;
    use std::sync::mpsc;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread as _, DefinedClass as _, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSSharingService, NSSharingServicePicker, NSSharingServicePickerDelegate,
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRectEdge, NSSize,
        NSString, NSURL,
    };

    use super::{ProfileShareError, ProfileShareOutcome};

    #[derive(Default)]
    struct PickerDelegateIvars {
        sender: OnceCell<mpsc::Sender<ProfileShareOutcome>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and this class is
        // main-thread-only because AppKit invokes picker delegates on main.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = PickerDelegateIvars]
        struct PickerDelegate;

        // SAFETY: NSObjectProtocol has no additional invariants.
        unsafe impl NSObjectProtocol for PickerDelegate {}

        // SAFETY: The selector and argument types exactly match AppKit's
        // NSSharingServicePickerDelegate declaration.
        unsafe impl NSSharingServicePickerDelegate for PickerDelegate {
            #[unsafe(method(sharingServicePicker:didChooseSharingService:))]
            fn did_choose(
                &self,
                _picker: &NSSharingServicePicker,
                service: Option<&NSSharingService>,
            ) {
                if let Some(sender) = self.ivars().sender.get() {
                    let outcome = if service.is_some() {
                        ProfileShareOutcome::Selected
                    } else {
                        ProfileShareOutcome::Cancelled
                    };
                    let _ = sender.send(outcome);
                }
            }
        }
    );

    impl PickerDelegate {
        fn new(mtm: MainThreadMarker, sender: mpsc::Sender<ProfileShareOutcome>) -> Retained<Self> {
            let ivars = PickerDelegateIvars::default();
            let _ = ivars.sender.set(sender);
            let this = Self::alloc(mtm).set_ivars(ivars);
            // SAFETY: NSObject's init selector has the declared signature.
            unsafe { msg_send![super(this), init] }
        }
    }

    struct NativeSession {
        picker: Retained<NSSharingServicePicker>,
        _delegate: Retained<PickerDelegate>,
    }

    thread_local! {
        static SESSION: RefCell<Option<NativeSession>> = const { RefCell::new(None) };
    }

    pub fn show(
        file_path: &Path,
    ) -> Result<mpsc::Receiver<ProfileShareOutcome>, ProfileShareError> {
        let mtm = MainThreadMarker::new().ok_or(ProfileShareError::NotMainThread)?;
        let app = NSApplication::sharedApplication(mtm);
        let window = app.keyWindow().ok_or(ProfileShareError::MissingWindow)?;
        let view = window
            .contentView()
            .ok_or(ProfileShareError::MissingWindow)?;
        let path = NSString::from_str(&file_path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let typed_items = NSArray::from_retained_slice(&[url]);
        // SAFETY: Objective-C NSArray is covariant for message dispatch and
        // this erases only the Rust generic marker. The retained element is an
        // NSURL, which satisfies the picker's NSPasteboardWriting contract.
        let items: Retained<NSArray> = unsafe { Retained::cast_unchecked(typed_items) };
        let (sender, receiver) = mpsc::channel();
        let delegate = PickerDelegate::new(mtm, sender);
        // SAFETY: NSURL implements NSPasteboardWriting, satisfying the generic
        // item contract documented by AppKit.
        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };
        picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let bounds = view.bounds();
        let anchor = NSRect::new(
            NSPoint::new(bounds.size.width / 2.0, bounds.size.height - 1.0),
            NSSize::new(1.0, 1.0),
        );
        SESSION.with(|slot| {
            *slot.borrow_mut() = Some(NativeSession {
                picker: picker.clone(),
                _delegate: delegate,
            });
        });
        picker.showRelativeToRect_ofView_preferredEdge(anchor, &view, NSRectEdge::MaxY);
        Ok(receiver)
    }

    pub fn cancel() {
        if MainThreadMarker::new().is_none() {
            return;
        }
        SESSION.with(|slot| {
            if let Some(session) = slot.borrow_mut().take() {
                session.picker.close();
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use std::path::Path;
    use std::sync::mpsc;

    use super::{ProfileShareError, ProfileShareOutcome};

    pub fn show(
        _file_path: &Path,
    ) -> Result<mpsc::Receiver<ProfileShareOutcome>, ProfileShareError> {
        Err(ProfileShareError::Unsupported)
    }

    pub fn cancel() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_rejects_empty_png_before_native_or_disk_work() {
        let authority = ProfileShareAuthority::new();
        let error = authority.share_png(&[]).unwrap_err();
        assert!(matches!(error, ProfileShareError::InvalidSize));
    }

    #[test]
    fn share_rejects_non_png_bytes_before_native_or_disk_work() {
        let authority = ProfileShareAuthority::new();
        let error = authority.share_png(&[0; 24]).unwrap_err();
        assert!(matches!(error, ProfileShareError::InvalidSize));
        assert!(authority.active_directory().is_none());
    }

    #[test]
    fn cancelling_an_idle_authority_is_idempotent() {
        let authority = ProfileShareAuthority::new();
        authority.cancel();
        assert!(authority.active_directory().is_none());
    }
}

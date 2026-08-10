//! Native macOS appearance boundary.
//!
//! This module deliberately owns only AppKit-facing appearance state. GPUI
//! coordinators can inject [`NativeAppearanceService`] and subscribe to
//! [`AppearanceEvent`] without coupling their entity lifecycle to AppKit.
//! Dock icon changes only call `setApplicationIconImage`; activation policy,
//! application activation, and window visibility remain owned by app lifecycle.

use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_ICON_BYTES: u64 = 32 * 1024 * 1024;

/// The source used for the application's native appearance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeSource {
    /// Follow the user's current macOS setting.
    System,
    /// Force AppKit's Aqua appearance.
    Light,
    /// Force AppKit's Dark Aqua appearance.
    Dark,
}

/// Dock icon variants packaged with Aiden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockIcon {
    /// The full-color Aiden icon.
    Aiden,
    /// The monochrome Aiden icon.
    Monochrome,
}

/// The effective accessibility and color state provided by macOS.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EffectiveAppearance {
    pub dark: bool,
    pub high_contrast: bool,
    pub reduce_motion: bool,
}

/// Accessibility display options owned by the AppKit notification bridge.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AccessibilityOptions {
    pub high_contrast: bool,
    pub reduce_motion: bool,
}

/// A deduplicated native appearance change for a later GPUI coordinator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppearanceEvent {
    EffectiveChanged(EffectiveAppearance),
    AccessibilityChanged(AccessibilityOptions),
}

/// Result of restoring persisted native preferences at process boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootRestoreResult {
    pub dock_icon: DockIcon,
    pub dock_icon_fell_back: bool,
}

/// Errors returned by the native boundary. Unsupported platforms always fail
/// closed rather than reporting a simulated successful native change.
#[derive(Debug, thiserror::Error)]
pub enum AppearanceError {
    #[error("Native appearance is unsupported on this platform")]
    Unsupported,
    #[error("AppKit must be called from the macOS main thread")]
    NotMainThread,
    #[error("Could not locate packaged icon {icon:?} in the allowed resource roots")]
    MissingResource { icon: DockIcon },
    #[error("Resource path is not a regular readable file: {path}")]
    InvalidResource { path: PathBuf },
    #[error("Native appearance backend failed: {0}")]
    Backend(String),
    #[error("Saved Dock icon failed ({saved}); fallback icon also failed ({fallback})")]
    DockFallbackFailed { saved: String, fallback: String },
}

/// Immutable icon bytes read from a validated resource inode.
///
/// AppKit receives these bytes through `NSData`; it never reopens the path, so
/// replacing a resource after resolution cannot change the decoded image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconResource {
    source_path: PathBuf,
    bytes: Arc<[u8]>,
}

impl IconResource {
    /// The diagnostic path from which the held inode was opened.
    pub fn source_path(&self) -> &Path {
        &self.source_path
    }

    /// Bytes read from the already-opened, bounded regular-file inode.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Resolves icon files only below explicit packaged/development resource roots.
#[derive(Debug, Clone)]
pub struct ResourceRoots {
    roots: Vec<PathBuf>,
}

impl ResourceRoots {
    /// Construct roots from already-known resource directories.
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            roots: roots.into_iter().collect(),
        }
    }

    /// Development and `.app` bundle resource roots for the current process.
    pub fn for_current_process() -> Self {
        let mut roots = Vec::new();
        if let Ok(executable) = std::env::current_exe() {
            if let Some(contents) = executable.parent().and_then(Path::parent) {
                let bundled = contents.join("Resources");
                if bundled.is_dir() {
                    roots.push(bundled);
                }
            }
        }
        if let Ok(workspace) = std::env::current_dir() {
            // Development binaries are commonly launched from either the
            // repository root or `rust/`; accept only each explicit ancestor's
            // `resources` directory, never a caller-provided arbitrary path.
            roots.extend(
                workspace
                    .ancestors()
                    .take(4)
                    .map(|ancestor| ancestor.join("resources")),
            );
        }
        Self::new(roots)
    }

    /// Open and read the requested variant relative to an allowed directory.
    ///
    /// On Unix, the final component is opened with `openat(O_NOFOLLOW)` before
    /// metadata is checked and bytes are read from that same descriptor.
    pub fn icon(&self, icon: DockIcon) -> Result<IconResource, AppearanceError> {
        let file_name = match icon {
            DockIcon::Aiden => "app-icon.png",
            DockIcon::Monochrome => "app-icon-monochrome.png",
        };
        for root in &self.roots {
            let Ok(root) = root.canonicalize() else {
                continue;
            };
            match read_icon_relative(&root, file_name) {
                Ok(resource) => return Ok(resource),
                Err(AppearanceError::MissingResource { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(AppearanceError::MissingResource { icon })
    }
}

#[cfg(unix)]
fn read_icon_relative(root: &Path, file_name: &str) -> Result<IconResource, AppearanceError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    let root_file = File::open(root).map_err(|_| AppearanceError::InvalidResource {
        path: root.to_path_buf(),
    })?;
    let name = CString::new(file_name)
        .map_err(|error| AppearanceError::Backend(format!("invalid icon file name: {error}")))?;
    // SAFETY: `root_file` and `name` remain alive for this call. On success,
    // ownership of the returned descriptor transfers immediately to `File`.
    let descriptor = unsafe {
        libc::openat(
            root_file.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Err(AppearanceError::MissingResource {
                icon: icon_for_file_name(file_name),
            })
        } else {
            Err(AppearanceError::InvalidResource {
                path: root.join(file_name),
            })
        };
    }
    // SAFETY: `descriptor` is a unique successful `openat` result.
    let file = unsafe { File::from_raw_fd(descriptor) };
    read_icon_file(file, root.join(file_name))
}

#[cfg(not(unix))]
fn read_icon_relative(root: &Path, file_name: &str) -> Result<IconResource, AppearanceError> {
    let path = root.join(file_name);
    let file = File::open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppearanceError::MissingResource {
                icon: icon_for_file_name(file_name),
            }
        } else {
            AppearanceError::InvalidResource { path: path.clone() }
        }
    })?;
    read_icon_file(file, path)
}

fn icon_for_file_name(file_name: &str) -> DockIcon {
    if file_name == "app-icon-monochrome.png" {
        DockIcon::Monochrome
    } else {
        DockIcon::Aiden
    }
}

fn read_icon_file(mut file: File, path: PathBuf) -> Result<IconResource, AppearanceError> {
    let metadata = file
        .metadata()
        .map_err(|_| AppearanceError::InvalidResource { path: path.clone() })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ICON_BYTES {
        return Err(AppearanceError::InvalidResource { path });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_ICON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AppearanceError::InvalidResource { path: path.clone() })?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_ICON_BYTES {
        return Err(AppearanceError::InvalidResource { path });
    }
    Ok(IconResource {
        source_path: path,
        bytes: bytes.into(),
    })
}

/// Callback invoked by the native accessibility display-options observer.
pub type AccessibilityEventHandler = Arc<dyn Fn(AccessibilityOptions) + Send + Sync + 'static>;

/// Injectable native implementation. The production implementation is
/// main-thread-bound and owns its accessibility notification token.
pub trait AppearanceBackend {
    /// Apply the requested AppKit appearance source.
    fn set_theme_source(&mut self, source: ThemeSource) -> Result<(), AppearanceError>;
    /// Apply a previously validated app/Dock icon resource.
    fn set_dock_icon(
        &mut self,
        icon: DockIcon,
        resource: &IconResource,
    ) -> Result<(), AppearanceError>;
    /// Read the current effective OS appearance and accessibility settings.
    fn effective_appearance(&mut self) -> Result<EffectiveAppearance, AppearanceError>;
    /// Retain the native accessibility display-options observer until drop.
    fn start_accessibility_observation(
        &mut self,
        handler: AccessibilityEventHandler,
    ) -> Result<(), AppearanceError>;
}

type Observer = Arc<dyn Fn(AppearanceEvent) + Send + Sync + 'static>;

#[derive(Default)]
struct ObserverState {
    observers: BTreeMap<u64, Observer>,
    next_observer: u64,
    last_accessibility: Option<AccessibilityOptions>,
}

/// Single-owner, injectable native appearance service.
///
/// The integration coordinator is the sole revision-ordered executor and must
/// own this value on GPUI's foreground thread. Every mutating operation takes
/// `&mut self`, preventing concurrent calls or reordering inside this boundary.
/// [`Self::restore_at_boot`] holds that exclusive borrow across theme,
/// saved-icon, and fallback-icon application.
pub struct NativeAppearanceService<B: AppearanceBackend> {
    roots: ResourceRoots,
    backend: B,
    last_effective: Option<EffectiveAppearance>,
    observer_state: Arc<Mutex<ObserverState>>,
}

impl<B: AppearanceBackend> NativeAppearanceService<B> {
    /// Create a service with an injected backend and explicit resource roots.
    pub fn new(backend: B, roots: ResourceRoots) -> Self {
        Self {
            roots,
            backend,
            last_effective: None,
            observer_state: Arc::new(Mutex::new(ObserverState {
                next_observer: 1,
                ..ObserverState::default()
            })),
        }
    }

    /// Apply the native application appearance on the foreground executor.
    pub fn set_theme_source(&mut self, source: ThemeSource) -> Result<(), AppearanceError> {
        self.backend.set_theme_source(source)
    }

    /// Resolve and apply the selected application/Dock icon without changing
    /// app activation or window visibility.
    pub fn set_dock_icon(&mut self, icon: DockIcon) -> Result<(), AppearanceError> {
        let resource = self.roots.icon(icon)?;
        self.backend.set_dock_icon(icon, &resource)
    }

    /// Read effective appearance without publishing an event.
    pub fn effective_appearance(&mut self) -> Result<EffectiveAppearance, AppearanceError> {
        self.backend.effective_appearance()
    }

    /// Read and publish an event only when the effective state changed.
    ///
    /// GPUI may call this when its own window-appearance observation fires.
    /// High-contrast and reduce-motion changes are additionally owned by the
    /// AppKit observer installed through [`Self::start_accessibility_observation`].
    pub fn refresh_effective_appearance(
        &mut self,
    ) -> Result<Option<AppearanceEvent>, AppearanceError> {
        let effective = self.backend.effective_appearance()?;
        let event = if self.last_effective == Some(effective) {
            None
        } else {
            self.last_effective = Some(effective);
            Some(AppearanceEvent::EffectiveChanged(effective))
        };
        if let Some(event) = event {
            publish_event(&self.observer_state, event)?;
        }
        Ok(event)
    }

    /// Start the retained native accessibility observer.
    ///
    /// AppKit delivers the callback on its main operation queue. The event
    /// registry deduplicates identical high-contrast/reduce-motion snapshots.
    pub fn start_accessibility_observation(&mut self) -> Result<(), AppearanceError> {
        let state = Arc::clone(&self.observer_state);
        self.backend
            .start_accessibility_observation(Arc::new(move |options| {
                let _ = publish_accessibility(&state, options);
            }))
    }

    /// Subscribe to deduplicated effective appearance updates.
    pub fn observe(
        &self,
        observer: impl Fn(AppearanceEvent) + Send + Sync + 'static,
    ) -> Result<u64, AppearanceError> {
        let mut state = self
            .observer_state
            .lock()
            .map_err(|_| AppearanceError::Backend("appearance service lock poisoned".into()))?;
        let id = state.next_observer;
        state.next_observer += 1;
        state.observers.insert(id, Arc::new(observer));
        Ok(id)
    }

    /// Remove a previously registered observer.
    pub fn remove_observer(&self, id: u64) {
        if let Ok(mut state) = self.observer_state.lock() {
            state.observers.remove(&id);
        }
    }

    /// Apply persisted settings at boot. A failed saved icon is retried once
    /// with the stable Aiden icon; theme failure is never hidden.
    pub fn restore_at_boot(
        &mut self,
        source: ThemeSource,
        icon: DockIcon,
    ) -> Result<BootRestoreResult, AppearanceError> {
        self.set_theme_source(source)?;
        match self.set_dock_icon(icon) {
            Ok(()) => Ok(BootRestoreResult {
                dock_icon: icon,
                dock_icon_fell_back: false,
            }),
            Err(saved) if icon != DockIcon::Aiden => match self.set_dock_icon(DockIcon::Aiden) {
                Ok(()) => Ok(BootRestoreResult {
                    dock_icon: DockIcon::Aiden,
                    dock_icon_fell_back: true,
                }),
                Err(fallback) => Err(AppearanceError::DockFallbackFailed {
                    saved: saved.to_string(),
                    fallback: fallback.to_string(),
                }),
            },
            Err(error) => Err(error),
        }
    }
}

fn publish_accessibility(
    state: &Mutex<ObserverState>,
    options: AccessibilityOptions,
) -> Result<(), AppearanceError> {
    let observers = {
        let mut state = state
            .lock()
            .map_err(|_| AppearanceError::Backend("appearance observer lock poisoned".into()))?;
        if state.last_accessibility == Some(options) {
            return Ok(());
        }
        state.last_accessibility = Some(options);
        state.observers.values().cloned().collect::<Vec<_>>()
    };
    let event = AppearanceEvent::AccessibilityChanged(options);
    for observer in observers {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(event))).is_err() {
            tracing::error!("native appearance observer panicked; event delivery continued");
        }
    }
    Ok(())
}

fn publish_event(
    state: &Mutex<ObserverState>,
    event: AppearanceEvent,
) -> Result<(), AppearanceError> {
    let observers = state
        .lock()
        .map_err(|_| AppearanceError::Backend("appearance observer lock poisoned".into()))?
        .observers
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for observer in observers {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(event))).is_err() {
            tracing::error!("native appearance observer panicked; event delivery continued");
        }
    }
    Ok(())
}

/// The production AppKit backend. It must be called by the GPUI foreground
/// executor (or another main-thread dispatcher); it rejects all other calls.
#[cfg(target_os = "macos")]
pub struct MacAppearanceBackend {
    marker: objc2::MainThreadMarker,
    accessibility_center: Option<objc2::rc::Retained<objc2_foundation::NSNotificationCenter>>,
    accessibility_observer: Option<
        objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2::runtime::NSObjectProtocol>>,
    >,
}

#[cfg(target_os = "macos")]
impl MacAppearanceBackend {
    /// Create the real macOS backend on the AppKit main thread.
    pub fn new() -> Result<Self, AppearanceError> {
        Ok(Self {
            marker: objc2::MainThreadMarker::new().ok_or(AppearanceError::NotMainThread)?,
            accessibility_center: None,
            accessibility_observer: None,
        })
    }
}

#[cfg(target_os = "macos")]
impl AppearanceBackend for MacAppearanceBackend {
    fn set_theme_source(&mut self, source: ThemeSource) -> Result<(), AppearanceError> {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
        };
        let app = NSApplication::sharedApplication(self.marker);
        let appearance = match source {
            ThemeSource::System => None,
            // SAFETY: AppKit exports these immutable appearance-name constants.
            ThemeSource::Light => unsafe { NSAppearance::appearanceNamed(NSAppearanceNameAqua) },
            // SAFETY: AppKit exports these immutable appearance-name constants.
            ThemeSource::Dark => unsafe { NSAppearance::appearanceNamed(NSAppearanceNameDarkAqua) },
        };
        app.setAppearance(appearance.as_deref());
        Ok(())
    }

    fn set_dock_icon(
        &mut self,
        _: DockIcon,
        resource: &IconResource,
    ) -> Result<(), AppearanceError> {
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        let app = NSApplication::sharedApplication(self.marker);
        let data = NSData::with_bytes(resource.bytes());
        let image = NSImage::initWithData(self.marker.alloc(), &data).ok_or_else(|| {
            AppearanceError::Backend(format!(
                "AppKit could not decode {}",
                resource.source_path().display()
            ))
        })?;
        // SAFETY: `image` is a valid retained NSImage and AppKit requires this
        // setter to run on the main thread, established by `marker` above.
        unsafe { app.setApplicationIconImage(Some(&image)) };
        Ok(())
    }

    fn effective_appearance(&mut self) -> Result<EffectiveAppearance, AppearanceError> {
        use objc2_app_kit::{NSApplication, NSWorkspace};
        let app = NSApplication::sharedApplication(self.marker);
        let appearance = app.effectiveAppearance().name();
        let workspace = NSWorkspace::sharedWorkspace();
        Ok(EffectiveAppearance {
            // This includes the accessibility high-contrast dark appearance,
            // which has a distinct AppKit name from `NSAppearanceNameDarkAqua`.
            dark: appearance.to_string().contains("Dark"),
            high_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
            reduce_motion: workspace.accessibilityDisplayShouldReduceMotion(),
        })
    }

    fn start_accessibility_observation(
        &mut self,
        handler: AccessibilityEventHandler,
    ) -> Result<(), AppearanceError> {
        use std::ptr::NonNull;

        use block2::RcBlock;
        use objc2_app_kit::{
            NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification,
        };
        use objc2_foundation::{NSNotification, NSOperationQueue};

        if self.accessibility_observer.is_some() {
            return Ok(());
        }
        let initial_handler = Arc::clone(&handler);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if objc2::MainThreadMarker::new().is_none() {
                    tracing::error!("workspace accessibility notification arrived off main thread");
                    return;
                }
                let workspace = NSWorkspace::sharedWorkspace();
                handler(AccessibilityOptions {
                    high_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
                    reduce_motion: workspace.accessibilityDisplayShouldReduceMotion(),
                });
            }));
            if result.is_err() {
                tracing::error!("workspace accessibility notification handler panicked");
            }
        });
        let workspace = NSWorkspace::sharedWorkspace();
        let center = workspace.notificationCenter();
        let queue = NSOperationQueue::mainQueue();
        // SAFETY: The exported notification name is immutable, no object
        // filter is required, and `queue` guarantees the sendable block runs
        // on AppKit's main thread.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
                Some(&queue),
                &block,
            )
        };
        self.accessibility_center = Some(center);
        self.accessibility_observer = Some(observer);
        initial_handler(AccessibilityOptions {
            high_contrast: workspace.accessibilityDisplayShouldIncreaseContrast(),
            reduce_motion: workspace.accessibilityDisplayShouldReduceMotion(),
        });
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacAppearanceBackend {
    fn drop(&mut self) {
        if let (Some(observer), Some(center)) = (
            self.accessibility_observer.take(),
            self.accessibility_center.take(),
        ) {
            // SAFETY: This is the exact opaque token returned by this center;
            // `MainThreadMarker` keeps the backend and its drop main-thread-only.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
    }
}

/// Unsupported fallback used by non-macOS builds and explicit fail-closed tests.
#[derive(Debug, Default)]
pub struct UnsupportedAppearanceBackend;

impl AppearanceBackend for UnsupportedAppearanceBackend {
    fn set_theme_source(&mut self, _: ThemeSource) -> Result<(), AppearanceError> {
        Err(AppearanceError::Unsupported)
    }

    fn set_dock_icon(&mut self, _: DockIcon, _: &IconResource) -> Result<(), AppearanceError> {
        Err(AppearanceError::Unsupported)
    }

    fn effective_appearance(&mut self) -> Result<EffectiveAppearance, AppearanceError> {
        Err(AppearanceError::Unsupported)
    }

    fn start_accessibility_observation(
        &mut self,
        _: AccessibilityEventHandler,
    ) -> Result<(), AppearanceError> {
        Err(AppearanceError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::{Arc, Mutex},
    };
    use tempfile::TempDir;

    #[derive(Default)]
    struct MockBackend {
        calls: Arc<Mutex<Vec<String>>>,
        effective: EffectiveAppearance,
        fail_monochrome: bool,
        main_thread: bool,
        icon_bytes: Arc<Mutex<Vec<Vec<u8>>>>,
        accessibility_handler: Arc<Mutex<Option<AccessibilityEventHandler>>>,
    }

    impl AppearanceBackend for MockBackend {
        fn set_theme_source(&mut self, source: ThemeSource) -> Result<(), AppearanceError> {
            if !self.main_thread {
                return Err(AppearanceError::NotMainThread);
            }
            self.calls.lock().unwrap().push(format!("theme:{source:?}"));
            Ok(())
        }
        fn set_dock_icon(
            &mut self,
            icon: DockIcon,
            resource: &IconResource,
        ) -> Result<(), AppearanceError> {
            if !self.main_thread {
                return Err(AppearanceError::NotMainThread);
            }
            self.calls.lock().unwrap().push(format!("dock:{icon:?}"));
            self.icon_bytes
                .lock()
                .unwrap()
                .push(resource.bytes().to_vec());
            if icon == DockIcon::Monochrome && self.fail_monochrome {
                Err(AppearanceError::Backend("bad icon".into()))
            } else {
                Ok(())
            }
        }
        fn effective_appearance(&mut self) -> Result<EffectiveAppearance, AppearanceError> {
            Ok(self.effective)
        }

        fn start_accessibility_observation(
            &mut self,
            handler: AccessibilityEventHandler,
        ) -> Result<(), AppearanceError> {
            *self.accessibility_handler.lock().unwrap() = Some(handler);
            Ok(())
        }
    }

    fn roots() -> (TempDir, ResourceRoots) {
        let directory = TempDir::new().unwrap();
        fs::write(directory.path().join("app-icon.png"), [1u8]).unwrap();
        fs::write(directory.path().join("app-icon-monochrome.png"), [2u8]).unwrap();
        let resource_roots = ResourceRoots::new([directory.path().to_path_buf()]);
        (directory, resource_roots)
    }

    #[test]
    fn single_owner_calls_run_in_request_order() {
        let (_directory, roots) = roots();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut service = NativeAppearanceService::new(
            MockBackend {
                calls: calls.clone(),
                main_thread: true,
                ..Default::default()
            },
            roots,
        );
        service.set_theme_source(ThemeSource::System).unwrap();
        service.set_theme_source(ThemeSource::Light).unwrap();
        service.set_theme_source(ThemeSource::Dark).unwrap();
        service.set_dock_icon(DockIcon::Aiden).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            ["theme:System", "theme:Light", "theme:Dark", "dock:Aiden"]
        );
    }

    #[test]
    fn reads_and_deduplicates_effective_appearance_events() {
        let (_directory, roots) = roots();
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut service = NativeAppearanceService::new(
            MockBackend {
                effective: EffectiveAppearance {
                    dark: true,
                    high_contrast: true,
                    reduce_motion: true,
                },
                ..Default::default()
            },
            roots,
        );
        let observed = events.clone();
        service
            .observe(move |event| observed.lock().unwrap().push(event))
            .unwrap();
        assert_eq!(
            service.effective_appearance().unwrap(),
            EffectiveAppearance {
                dark: true,
                high_contrast: true,
                reduce_motion: true
            }
        );
        assert!(service.refresh_effective_appearance().unwrap().is_some());
        assert!(service.refresh_effective_appearance().unwrap().is_none());
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[test]
    fn accessibility_observer_maps_and_deduplicates_notifications() {
        let (_directory, roots) = roots();
        let handler = Arc::new(Mutex::new(None));
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut service = NativeAppearanceService::new(
            MockBackend {
                accessibility_handler: Arc::clone(&handler),
                ..Default::default()
            },
            roots,
        );
        let observed = Arc::clone(&events);
        service
            .observe(move |event| observed.lock().unwrap().push(event))
            .unwrap();
        service.start_accessibility_observation().unwrap();
        let callback = handler.lock().unwrap().clone().unwrap();
        let options = AccessibilityOptions {
            high_contrast: true,
            reduce_motion: true,
        };
        callback(options);
        callback(options);
        assert_eq!(
            *events.lock().unwrap(),
            [AppearanceEvent::AccessibilityChanged(options)]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_accessibility_observer_uses_the_workspace_notification_center() {
        let source = include_str!("appearance.rs");
        assert!(source.contains("let center = workspace.notificationCenter();"));
        let forbidden = ["NSNotificationCenter::", "defaultCenter()"].concat();
        assert!(!source.contains(&forbidden));
        assert!(source.contains("self.accessibility_center.take()"));
    }

    #[test]
    fn boot_restore_falls_back_to_aiden_icon() {
        let (_directory, roots) = roots();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut service = NativeAppearanceService::new(
            MockBackend {
                calls: calls.clone(),
                fail_monochrome: true,
                main_thread: true,
                ..Default::default()
            },
            roots,
        );
        assert_eq!(
            service
                .restore_at_boot(ThemeSource::Dark, DockIcon::Monochrome)
                .unwrap(),
            BootRestoreResult {
                dock_icon: DockIcon::Aiden,
                dock_icon_fell_back: true
            }
        );
        assert_eq!(
            *calls.lock().unwrap(),
            ["theme:Dark", "dock:Monochrome", "dock:Aiden"]
        );
    }

    #[test]
    fn boot_restore_keeps_a_valid_saved_icon() {
        let (_directory, roots) = roots();
        let mut service = NativeAppearanceService::new(
            MockBackend {
                main_thread: true,
                ..Default::default()
            },
            roots,
        );
        assert_eq!(
            service
                .restore_at_boot(ThemeSource::System, DockIcon::Monochrome)
                .unwrap(),
            BootRestoreResult {
                dock_icon: DockIcon::Monochrome,
                dock_icon_fell_back: false,
            }
        );
    }

    #[test]
    fn unsupported_backend_fails_closed() {
        let (_directory, roots) = roots();
        let mut service = NativeAppearanceService::new(UnsupportedAppearanceBackend, roots);
        assert!(matches!(
            service.set_theme_source(ThemeSource::Dark),
            Err(AppearanceError::Unsupported)
        ));
        assert!(matches!(
            service.effective_appearance(),
            Err(AppearanceError::Unsupported)
        ));
    }

    #[test]
    fn resources_must_be_regular_files_below_a_known_root() {
        let directory = TempDir::new().unwrap();
        fs::create_dir(directory.path().join("app-icon.png")).unwrap();
        let roots = ResourceRoots::new([directory.path().to_path_buf()]);
        assert!(matches!(
            roots.icon(DockIcon::Aiden),
            Err(AppearanceError::InvalidResource { .. })
        ));
    }

    #[test]
    fn resource_reads_are_bounded() {
        let directory = TempDir::new().unwrap();
        let oversized = File::create(directory.path().join("app-icon.png")).unwrap();
        oversized.set_len(MAX_ICON_BYTES + 1).unwrap();
        let roots = ResourceRoots::new([directory.path().to_path_buf()]);
        assert!(matches!(
            roots.icon(DockIcon::Aiden),
            Err(AppearanceError::InvalidResource { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn resource_symlinks_cannot_escape_an_allowed_root() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_icon = outside.path().join("outside.png");
        fs::write(&outside_icon, [1u8]).unwrap();
        symlink(&outside_icon, root.path().join("app-icon.png")).unwrap();
        let roots = ResourceRoots::new([root.path().to_path_buf()]);
        assert!(matches!(
            roots.icon(DockIcon::Aiden),
            Err(AppearanceError::InvalidResource { .. })
        ));
    }

    #[test]
    fn resource_swap_after_open_cannot_change_decoded_bytes() {
        let (directory, roots) = roots();
        let resource = roots.icon(DockIcon::Aiden).unwrap();
        let replacement = directory.path().join("replacement.png");
        fs::write(&replacement, [9u8]).unwrap();
        fs::rename(&replacement, directory.path().join("app-icon.png")).unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let mut backend = MockBackend {
            main_thread: true,
            icon_bytes: Arc::clone(&captured),
            ..Default::default()
        };
        backend.set_dock_icon(DockIcon::Aiden, &resource).unwrap();
        assert_eq!(*captured.lock().unwrap(), [vec![1u8]]);
    }

    #[test]
    fn backend_main_thread_contract_is_fail_closed() {
        let (_directory, roots) = roots();
        let mut service = NativeAppearanceService::new(MockBackend::default(), roots);
        assert!(matches!(
            service.set_theme_source(ThemeSource::Light),
            Err(AppearanceError::NotMainThread)
        ));
    }
}

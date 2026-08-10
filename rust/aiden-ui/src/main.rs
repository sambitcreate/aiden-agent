//! Aiden Agent — GPUI application (Phase 6: wired shell).
//!
//! Boots gpui-component + the tokio bridge, loads the durable stores, and
//! opens either the onboarding flow (first run) or the main window. The
//! onboarding completion callback closes the onboarding window and opens the
//! main window; the persisted appearance is applied by the chat service.
//!
//! # Runtime contract: tokio from GPUI context
//!
//! GPUI runs everything on its own event loop + background executor. Those
//! threads do **not** carry a tokio runtime guard, so calling any tokio API
//! that needs the current thread's runtime handle will panic with
//! `"there is no reactor running, must be called from the context of a Tokio
//! 1.x runtime"` — and, because GPUI is driven from inside ObjC callbacks
//! (the `NSApplication` run loop), Rust cannot unwind, so the panic becomes a
//! `SIGABRT` that kills the app. See `main.rs`'s panic hook for how these are
//! captured.
//!
//! From any GPUI context (a `render`/event handler, or a `cx.spawn` /
//! `cx.background_spawn` future), you MUST NOT call:
//!
//! - `tokio::spawn(...)` and `tokio::task::spawn_blocking(...)` — they read
//!   `Handle::current()`, which panics with no guard.
//! - `tokio::time::sleep` / `tokio::time::interval` / `tokio::time::timeout` —
//!   they register with the timer driver, which is absent on GPUI threads.
//! - `tokio::net::*` / `tokio::fs::*` — same IO-driver dependency.
//! - `tokio::runtime::Handle::current()` — panics outright.
//! - A blocking runtime's `block_on(...)` — risks deadlocking the foreground.
//!
//! ## Correct patterns
//!
//! 1. CPU/disk/network work that needs tokio goes through the bridge:
//!    `gpui_tokio_bridge::Tokio::spawn(cx, fut)` runs `fut` on the dedicated
//!    tokio runtime registered by `gpui_tokio_bridge::init(cx)` in `main`, and
//!    surfaces the result as a GPUI `Task<Result<R, JoinError>>`. Inside `fut`
//!    there IS a tokio guard, so nested `spawn`/`spawn_blocking`/timers/IO are
//!    fine. The original `PillCoordinator` crash (commit 24e5d57) was exactly a
//!    violation of this: `PillCoordinator::new` called bare `tokio::spawn` from
//!    the GPUI foreground. `PillCoordinator::new` now returns the watcher
//!    future and the caller spawns it via the bridge.
//!
//! 2. Foreground (`cx.spawn`) tasks must contain ONLY executor-agnostic
//!    futures: GPUI's own primitives, plain `async`/`await`, and — yes —
//!    `tokio::sync::mpsc`/`watch`/`oneshot` receivers (their `poll_*` is
//!    purely waker-based and crosses executors fine). They must NOT await any
//!    tokio-driver future. The standard shape is: a `Tokio::spawn` "driver"
//!    owns the tokio work and a `cx.spawn` "watcher" drains the channel it owns
//!    into entity updates (see `services::chat_service` stream wiring and
//!    `workspace::state::WorkspaceState::start_poll`).
//!
//! 3. At shutdown (no runtime guaranteed), use the dedicated blocking variants
//!    rather than the async ones (see `LiveAudioSource::stop_capture_blocking`).
//!
//! When in doubt: anything that touches `tokio::{spawn, task::spawn_blocking,
//! time, net, fs}` belongs behind a `Tokio::spawn(cx, ..)` — never on the GPUI
//! foreground, and never inside a `cx.spawn`/`cx.background_spawn` body.

mod app;
mod app_assets;
mod approvals;
mod assistant;
mod chat;
mod environment;
#[allow(dead_code)]
mod onboarding;
mod panels;
mod pill;
mod services;
mod settings;
mod shell;
mod shortcut_runtime;
#[allow(dead_code)]
mod workspace;
#[allow(dead_code)]
mod workspace_files;

use std::cell::RefCell;
use std::io::Write as _;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{point, px, size, App, AppContext as _, Global, WindowBounds, WindowOptions};
use gpui_component::{PixelsExt as _, Root, TitleBar};

use app::AppState;
use services::appearance::appearance_from_settings;
use services::native_appearance::prepare_for_main_window;
use services::native_appearance::NativeAppearance;
use services::stores::Stores;

struct MainWindowState(shortcut_runtime::MainWindowLifecycle);
impl Global for MainWindowState {}

struct OnboardingAccessibilityMonitor {
    native: NativeAppearance,
    active: bool,
    mode: aiden_core::appearance::Mode,
    dock_icon: aiden_core::appearance::DockIcon,
    native_restored: bool,
    effective: aiden_mac::appearance::EffectiveAppearance,
}

impl OnboardingAccessibilityMonitor {
    fn poll(&mut self) -> bool {
        let mut changed = false;
        if !self.native_restored {
            if let Ok(restored) = self.native.restore_at_boot(self.mode, self.dock_icon) {
                changed |= self.effective != restored.effective;
                self.effective = restored.effective;
                self.dock_icon = restored.dock_icon;
                self.native_restored = true;
            }
        }
        // Registration is deliberately retried independently from native
        // restore. A transient AppKit notification error must not freeze the
        // System motion choice for the rest of onboarding.
        let _ = self.native.ensure_observation();
        for event in self.native.take_events() {
            match event {
                aiden_mac::appearance::AppearanceEvent::EffectiveChanged(effective) => {
                    changed |= self.effective != effective;
                    self.effective = effective;
                }
                aiden_mac::appearance::AppearanceEvent::AccessibilityChanged(options) => {
                    changed |= self.effective.high_contrast != options.high_contrast
                        || self.effective.reduce_motion != options.reduce_motion;
                    self.effective.high_contrast = options.high_contrast;
                    self.effective.reduce_motion = options.reduce_motion;
                }
            }
        }
        changed
    }
}

fn start_onboarding_accessibility_monitor(
    appearance: &aiden_core::appearance::AppearanceConfig,
    cx: &mut App,
) -> gpui::Entity<OnboardingAccessibilityMonitor> {
    let mut native = NativeAppearance::new();
    let restored = native
        .restore_at_boot(appearance.mode, appearance.dock_icon)
        .ok();
    let effective = restored
        .map(|restored| restored.effective)
        .unwrap_or_default();
    let _ = native.ensure_observation();
    cx.set_global(services::appearance::AidenSystemAccessibility {
        high_contrast: effective.high_contrast,
        reduced_motion: effective.reduce_motion,
    });
    let monitor = cx.new(|_| OnboardingAccessibilityMonitor {
        native,
        active: true,
        mode: appearance.mode,
        dock_icon: appearance.dock_icon,
        native_restored: restored.is_some(),
        effective,
    });
    let watcher = monitor.clone();
    cx.spawn(async move |cx| loop {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(150))
            .await;
        let keep_running = watcher
            .update(cx, |monitor, cx| {
                if monitor.poll() {
                    cx.set_global(services::appearance::AidenSystemAccessibility {
                        high_contrast: monitor.effective.high_contrast,
                        reduced_motion: monitor.effective.reduce_motion,
                    });
                    cx.refresh_windows();
                }
                monitor.active
            })
            .unwrap_or(false);
        if !keep_running {
            break;
        }
    })
    .detach();
    monitor
}

fn set_main_window_state(state: shortcut_runtime::MainWindowLifecycle, cx: &mut App) {
    cx.set_global(MainWindowState(state));
}

pub(crate) fn mark_main_window_closed(cx: &mut App) {
    set_main_window_state(shortcut_runtime::MainWindowLifecycle::Windowless, cx);
}

fn ensure_main_window(stores: &Stores, cx: &mut App) -> bool {
    match shortcut_runtime::main_window_preparation(cx.global::<MainWindowState>().0) {
        shortcut_runtime::MainWindowPreparation::Ignore => false,
        shortcut_runtime::MainWindowPreparation::Ready => true,
        shortcut_runtime::MainWindowPreparation::Open => {
            if let Err(error) = open_main_window(cx, stores.clone()) {
                tracing::error!("global shortcut could not reopen Aiden: {error}");
                false
            } else {
                true
            }
        }
    }
}

fn main() {
    let dev = aiden_data::is_dev_mode();

    // GPUI runs inside ObjC callbacks (NSApplication run loop) where Rust
    // panics cannot unwind. Install a hook that logs the panic + backtrace to
    // stderr AND to a file so we can diagnose crashes that macOS swallows.
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<Any panic payload".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let bt = std::backtrace::Backtrace::force_capture();
        let full = format!("PANIC: {msg}\nLocation: {location}\nBacktrace:\n{bt}");
        eprintln!("{full}");
        if let Ok(dir) = std::env::var("HOME") {
            let _ = std::fs::write(
                std::path::Path::new(&dir).join(".aiden-rs-panic.log"),
                &full,
            );
        }
    }));

    if dev {
        eprintln!("\n  ⚡ Aiden-RS-DEV — dev mode (AIDEN_DEV=1)");
        eprintln!(
            "  📁 Config:  {}",
            aiden_data::aiden_config_dir().unwrap_or_default().display()
        );
        eprintln!(
            "  📁 Data:    {}",
            aiden_data::machine_local_data_dir().display()
        );
        eprintln!();
    }

    if let Err(err) = tracing_subscriber::fmt()
        .with_max_level(if dev {
            tracing::Level::DEBUG
        } else {
            tracing::Level::INFO
        })
        .with_target(false)
        .try_init()
    {
        eprintln!("failed to init tracing: {err}");
    }

    // Single-instance lock (parity audit config §10): only one process may
    // open the shared stores at a time. A stale lock (dead owner PID) is
    // reclaimed; a live owner causes this process to activate the existing
    // instance and exit. The lock is removed on clean quit below.
    let single_instance_lock = match acquire_single_instance_lock() {
        Some(lock) => lock,
        None => {
            activate_existing_instance();
            std::process::exit(0);
        }
    };

    let app = gpui::Application::new().with_assets(app_assets::AppAssets);
    let process_stores = Rc::new(RefCell::new(None::<Stores>));
    let reopen_stores = process_stores.clone();
    app.on_reopen(move |cx| {
        // Dock-click reuses the one process-lifetime store owner. Auxiliary
        // pill/onboarding windows never count as a ready main AppState window.
        let stores = reopen_stores.borrow().clone();
        if let Some(stores) = stores {
            let _ = ensure_main_window(&stores, cx);
        }
        cx.activate(true);
    });
    app.run(move |cx: &mut App| {
        // gpui-component MUST be initialized first: theme global, i18n,
        // and component keybindings.
        gpui_component::init(cx);
        cx.set_global(services::appearance::AidenSystemAccessibility {
            high_contrast: false,
            reduced_motion: app::system_reduced_motion(),
        });
        // Tokio runtime for reqwest/SSE work (providers), bridged into
        // GPUI foreground tasks.
        gpui_tokio_bridge::init(cx);
        set_main_window_state(shortcut_runtime::MainWindowLifecycle::Windowless, cx);

        let stores = match Stores::open() {
            Ok(stores) => stores,
            Err(error) => {
                eprintln!("failed to open Aiden stores: {error}");
                std::process::exit(1);
            }
        };
        *process_stores.borrow_mut() = Some(stores.clone());

        // One app-lifetime runtime owns the effective GPUI map and all three
        // OS-global claims. Dock reopen reuses this global entity.
        let shortcut_runtime = cx.new(|cx| {
            shortcut_runtime::ShortcutRuntime::new(
                stores.config.clone(),
                shortcut_runtime::platform_port(),
                cx,
            )
        });
        cx.set_global(shortcut_runtime::ShortcutRuntimeGlobal(
            shortcut_runtime.clone(),
        ));
        let shortcut_window_stores = stores.clone();
        shortcut_runtime::install_global_listener(
            shortcut_runtime,
            std::sync::Arc::new(move |cx| ensure_main_window(&shortcut_window_stores, cx)),
            cx,
        );

        // First run: the onboarding flow owns the app until it completes;
        // its completion callback closes the onboarding window and opens
        // the main window. The marker lives in `settings.json` under the
        // exact TS key (`aiden:onboarding:v1:complete`).
        let settings = stores.config.get_settings().unwrap_or_default();
        if onboarding::should_show_onboarding(&settings) {
            let onboarding_appearance = appearance_from_settings(&settings);
            let onboarding_accessibility =
                start_onboarding_accessibility_monitor(&onboarding_appearance, cx);
            set_main_window_state(shortcut_runtime::MainWindowLifecycle::Onboarding, cx);
            let onboarding_handle = Rc::new(RefCell::new(
                None::<gpui::WindowHandle<gpui_component::Root>>,
            ));
            let close_handle = onboarding_handle.clone();
            let stores_for_complete = stores.clone();
            let complete_accessibility = onboarding_accessibility.clone();
            let services = onboarding::OnboardingServices::new(stores.clone()).with_on_complete(
                Box::new(move |cx: &mut App| {
                    complete_accessibility.update(cx, |monitor, _| monitor.active = false);
                    if let Some(handle) = close_handle.borrow().as_ref() {
                        let _ = handle.update(cx, |_view, window, _cx| window.remove_window());
                    }
                    set_main_window_state(shortcut_runtime::MainWindowLifecycle::Windowless, cx);
                    if let Err(error) = open_main_window(cx, stores_for_complete.clone()) {
                        eprintln!("failed to open the Aiden window: {error}");
                    }
                }),
            );
            match onboarding::open_onboarding_window(cx, services) {
                Ok(handle) => *onboarding_handle.borrow_mut() = Some(handle),
                Err(error) => {
                    onboarding_accessibility.update(cx, |monitor, _| monitor.active = false);
                    eprintln!("failed to open the onboarding window: {error}");
                    // Never strand the user: fall back to the main window.
                    set_main_window_state(shortcut_runtime::MainWindowLifecycle::Windowless, cx);
                    if let Err(error) = open_main_window(cx, stores) {
                        eprintln!("failed to open the Aiden window: {error}");
                    }
                }
            }
        } else {
            if let Err(error) = open_main_window(cx, stores) {
                eprintln!("failed to open the Aiden window: {error}");
                return;
            }
            // Bring the window to the front on first launch.
            cx.activate(true);
        }
    });

    // Reached only after the app quits (⌘Q / the quit-barrier path): release
    // the single-instance lock so the next launch can claim it. A crash leaves
    // a stale lock whose dead PID is reclaimed by the next launch.
    if let Err(error) = std::fs::remove_file(&single_instance_lock) {
        tracing::warn!("could not remove the single-instance lock: {error}");
    }
}

/// Try to claim the machine-local single-instance lock. Returns the lockfile
/// path to remove on exit, or `None` when another live instance holds it.
/// A stale lock (a recorded PID that no longer exists) is reclaimed once and
/// the claim is retried.
fn acquire_single_instance_lock() -> Option<PathBuf> {
    let root = aiden_data::machine_local_data_dir();
    let lock_path = root.join(if aiden_data::is_dev_mode() {
        "aiden-rs-dev.lock"
    } else {
        "aiden.lock"
    });
    let _ = std::fs::create_dir_all(&root);
    for _attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let _ = file.write_all(format!("{}\n", std::process::id()).as_bytes());
                return Some(lock_path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // A live owner's PID inside wins; stale locks are reclaimed.
                let owner: Option<i32> = std::fs::read_to_string(&lock_path)
                    .ok()
                    .and_then(|raw| raw.trim().parse().ok());
                if owner.is_some_and(process_is_alive) {
                    tracing::info!(
                        pid = owner.unwrap(),
                        "another Aiden instance is running — exiting"
                    );
                    return None;
                }
                tracing::warn!("single-instance lock is stale (owner {owner:?} gone) — reclaiming");
                let _ = std::fs::remove_file(&lock_path);
            }
            Err(error) => {
                tracing::warn!("single-instance lock could not be acquired: {error}");
                return None;
            }
        }
    }
    None
}

/// Whether a process with `pid` is alive (`kill -0` exit status; no signal is
/// sent). `false` for a missing process, a dead PID, or a permission error.
fn process_is_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Best-effort: bring the already-running instance to the front via
/// AppleScript. Requires Automation permission on modern macOS; the child is
/// bounded to two seconds so a permission prompt can never hang startup, and
/// the caller exits immediately after, killing this thread.
fn activate_existing_instance() {
    let bundle_id = if aiden_data::is_dev_mode() {
        "com.sambitcreate.aiden-rs-dev"
    } else {
        "com.sambitcreate.aiden-agent"
    };
    tracing::info!(
        "another Aiden instance is running — asking it to activate (bundle id {bundle_id})"
    );
    let script = format!("tell application id \"{bundle_id}\" to activate");
    std::thread::spawn(move || {
        let Ok(mut child) = std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
        else {
            return;
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
}

/// Open the main Aiden window: the `AppState` shell under a gpui-component
/// `Root` (dialogs/notifications/sheets live on the Root layer).
fn open_main_window(cx: &mut App, stores: Stores) -> anyhow::Result<gpui::WindowHandle<Root>> {
    let dev = aiden_data::is_dev_mode();
    let app_id = if dev {
        "com.sambitcreate.aiden-rs-dev"
    } else {
        "com.sambitcreate.aiden-agent"
    };
    let tabbing_id = if dev {
        "aiden-rs-dev-main"
    } else {
        "aiden-main"
    };

    let titlebar = gpui::TitlebarOptions {
        traffic_light_position: Some(point(px(14.0), px(20.0))),
        ..TitleBar::title_bar_options()
    };
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::centered(size(px(1000.0), px(700.0)), cx)),
        // Canonical Electron minimum. GPUI 0.2.2 exposes content-size bounds
        // only; its full-size macOS titlebar keeps this aligned in practice.
        window_min_size: Some(size(px(390.0), px(456.0))),
        titlebar: Some(titlebar),
        window_background: gpui::WindowBackgroundAppearance::Blurred,
        app_id: Some(app_id.to_string()),
        tabbing_identifier: Some(tabbing_id.to_string()),
        ..Default::default()
    };

    // ConfigStore is local and atomic; reading it here avoids showing the
    // default palette/Dock icon for a frame while ChatService's async catalog
    // boot is still in flight.
    let initial_appearance =
        appearance_from_settings(&stores.config.get_settings().unwrap_or_default());
    let prepared_native =
        prepare_for_main_window(initial_appearance.mode, initial_appearance.dock_icon);
    let handle = cx.open_window(options, |window, cx| {
        let outer = window.bounds().size;
        let content = window.viewport_size();
        tracing::debug!(
            outer_width = outer.width.as_f32(),
            outer_height = outer.height.as_f32(),
            content_width = content.width.as_f32(),
            content_height = content.height.as_f32(),
            "opened main window bounds"
        );
        let view =
            cx.new(|cx| AppState::new(stores, initial_appearance, prepared_native, window, cx));
        let weak_view = view.downgrade();
        // Red ✕ follows the Files draft barrier before allowing the normal
        // macOS windowless-app behavior. Saving hard-blocks; dirty state
        // opens the same explicit discard confirmation as other navigation.
        window.on_window_should_close(cx, move |window, cx| {
            let allow = weak_view
                .update(cx, |view, cx| view.request_native_close(window, cx))
                .unwrap_or(true);
            if allow {
                mark_main_window_closed(cx);
            }
            allow
        });
        cx.new(|cx| Root::new(view, window, cx))
    })?;
    set_main_window_state(shortcut_runtime::MainWindowLifecycle::Ready, cx);
    Ok(handle)
}

#[cfg(test)]
mod lifecycle_tests {
    #[test]
    fn stores_are_opened_once_and_reused_for_every_reopen_path() {
        let source = include_str!("main.rs");
        assert_eq!(source.matches(concat!("Stores::", "open()")).count(), 1);
        assert!(source.contains("process_stores"));
        assert!(source.contains("ensure_main_window"));
    }

    #[test]
    fn appearance_and_native_restore_are_prepared_before_opening_a_main_window() {
        let source = include_str!("main.rs");
        let prepared = source
            .find("prepare_for_main_window(initial_appearance.mode")
            .expect("main-window launch prepares native appearance");
        let opened = source
            .find("cx.open_window(options")
            .expect("main window is opened");
        assert!(
            prepared < opened,
            "restore must precede the first window frame"
        );
    }
}

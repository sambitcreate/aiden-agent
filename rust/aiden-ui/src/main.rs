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
mod approvals;
mod assistant;
mod chat;
#[allow(dead_code)]
mod onboarding;
mod panels;
mod pill;
mod services;
mod settings;
mod shell;
#[allow(dead_code)]
mod skills;
mod workspace;
#[allow(dead_code)]
mod workspace_files;

use std::cell::RefCell;
use std::io::Write as _;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{px, size, App, AppContext as _, Bounds, KeyBinding, WindowBounds, WindowOptions};
use gpui_component::{Root, TitleBar};

use app::AppState;
use services::stores::Stores;

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

    let app = gpui::Application::new().with_assets(gpui_component_assets::Assets);
    app.on_reopen(|cx| {
        // Dock-click when the window was closed via ✕: reopen it.
        if cx.windows().is_empty() {
            let stores = match Stores::open() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("failed to open stores on reopen: {e}");
                    return;
                }
            };
            if let Err(e) = open_main_window(cx, stores) {
                eprintln!("failed to reopen the Aiden window: {e}");
            }
        }
        cx.activate(true);
    });
    app.run(move |cx: &mut App| {
        // gpui-component MUST be initialized first: theme global, i18n,
        // and component keybindings.
        gpui_component::init(cx);
        // Tokio runtime for reqwest/SSE work (providers), bridged into
        // GPUI foreground tasks.
        gpui_tokio_bridge::init(cx);

        // All 26 commands from the keybinding catalog
        // (renderer/shared/keybindings.ts ↔ aiden-core::keybindings) are
        // bound in-app where the target surface exists. The settings
        // editor lists every catalog command; the bindings below are the
        // catalog defaults mapped onto gpui's key syntax
        // ("Command+K" → "cmd-k").
        cx.bind_keys([
            // Core (catalog defaults).
            KeyBinding::new("cmd-q", app::Quit, Some("App")),
            KeyBinding::new("cmd-n", app::NewChat, Some("App")),
            KeyBinding::new("cmd-k", app::TogglePalette, Some("App")),
            KeyBinding::new("cmd-j", app::ToggleTerminal, Some("App")),
            // In-app pill toggle. A true global hotkey (active while
            // another app is focused) comes with the aiden-mac wiring in
            // a later phase.
            KeyBinding::new("cmd-shift-d", app::TogglePill, Some("App")),
            // Settings / navigation.
            KeyBinding::new("cmd-,", app::OpenSettings, Some("App")),
            KeyBinding::new("cmd-shift-f", app::SearchChats, Some("App")),
            KeyBinding::new("cmd-shift-[", app::PreviousChat, Some("App")),
            KeyBinding::new("cmd-shift-]", app::NextChat, Some("App")),
            KeyBinding::new("cmd-1", app::ChatJump1, Some("App")),
            KeyBinding::new("cmd-2", app::ChatJump2, Some("App")),
            KeyBinding::new("cmd-3", app::ChatJump3, Some("App")),
            KeyBinding::new("cmd-4", app::ChatJump4, Some("App")),
            KeyBinding::new("cmd-5", app::ChatJump5, Some("App")),
            KeyBinding::new("cmd-6", app::ChatJump6, Some("App")),
            KeyBinding::new("cmd-7", app::ChatJump7, Some("App")),
            KeyBinding::new("cmd-8", app::ChatJump8, Some("App")),
            KeyBinding::new("cmd-9", app::ChatJump9, Some("App")),
            KeyBinding::new("cmd-o", app::OpenWorkspaceFolder, Some("App")),
            KeyBinding::new("cmd-shift-e", app::OpenInEditor, Some("App")),
            KeyBinding::new("cmd-ctrl-s", app::ToggleSidebar, Some("App")),
            // Panel toggles + composer (TS global bindings, in-app scope
            // until the aiden-mac global hotkey wiring lands).
            KeyBinding::new("cmd-shift-a", app::ToggleAssistant, Some("App")),
            KeyBinding::new("cmd-shift-s", app::ToggleSubagents, Some("App")),
            KeyBinding::new("cmd-shift-u", app::ToggleUsage, Some("App")),
            KeyBinding::new("cmd-alt-space", app::FocusComposer, Some("App")),
            KeyBinding::new("cmd-alt-a", app::ToggleAssistant, Some("App")),
            // Aiden-specific conveniences beyond the TS catalog.
            KeyBinding::new("cmd-shift-t", app::ToggleTerminal, Some("App")),
            KeyBinding::new("cmd-enter", app::SendMessage, Some("App")),
            KeyBinding::new("cmd-w", app::CloseWindow, Some("App")),
            // file.save: accepted (no-op stub) so the catalog stays honest.
            KeyBinding::new("cmd-s", app::SaveFile, Some("App")),
        ]);

        let stores = match Stores::open() {
            Ok(stores) => stores,
            Err(error) => {
                eprintln!("failed to open Aiden stores: {error}");
                std::process::exit(1);
            }
        };

        // Global dictation hotkey (parity audit config §12): a real
        // OS-wide ⌘⇧D registration so the pill toggle works while another
        // app is focused — not just inside Aiden. The port lives inside
        // the app-lifetime listener task and is released at process exit.
        // Without the macOS Accessibility permission the registration is
        // refused (logged inside) and the in-app ⌘⇧D binding remains the
        // only toggle path.
        let global_dictation = app::register_global_dictation_hotkey(cx);
        tracing::info!(
            "dictation global hotkey: registered={global_dictation} (in-app ⌘⇧D always bound)"
        );

        // First run: the onboarding flow owns the app until it completes;
        // its completion callback closes the onboarding window and opens
        // the main window. The marker lives in `settings.json` under the
        // exact TS key (`aiden:onboarding:v1:complete`).
        let settings = stores.config.get_settings().unwrap_or_default();
        if onboarding::should_show_onboarding(&settings) {
            let onboarding_handle = Rc::new(RefCell::new(
                None::<gpui::WindowHandle<gpui_component::Root>>,
            ));
            let close_handle = onboarding_handle.clone();
            let stores_for_complete = stores.clone();
            let services = onboarding::OnboardingServices::new(stores.clone()).with_on_complete(
                Box::new(move |cx: &mut App| {
                    if let Some(handle) = close_handle.borrow().as_ref() {
                        let _ = handle.update(cx, |_view, window, _cx| window.remove_window());
                    }
                    if let Err(error) = open_main_window(cx, stores_for_complete.clone()) {
                        eprintln!("failed to open the Aiden window: {error}");
                    }
                }),
            );
            match onboarding::open_onboarding_window(cx, services) {
                Ok(handle) => *onboarding_handle.borrow_mut() = Some(handle),
                Err(error) => {
                    eprintln!("failed to open the onboarding window: {error}");
                    // Never strand the user: fall back to the main window.
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

    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1000.0), px(700.0)),
            cx,
        ))),
        // Parity audit UI §9: the TS renderer constrained its window
        // (minWidth 390 / minHeight 456); the Rust port previously had no
        // floor, so the app could be shrunk into unusability. 700×500 keeps
        // the sidebar + composer legible at the smallest allowed size.
        window_min_size: Some(size(px(700.0), px(500.0))),
        titlebar: Some(TitleBar::title_bar_options()),
        window_background: gpui::WindowBackgroundAppearance::Blurred,
        app_id: Some(app_id.to_string()),
        tabbing_identifier: Some(tabbing_id.to_string()),
        ..Default::default()
    };

    cx.open_window(options, |window, cx| {
        // Red ✕ button: allow the window to close. The app process stays
        // alive (macOS convention); the user can reopen via the dock icon
        // (on_reopen handler below). ⌘Q / ⌘W still fully quit.
        window.on_window_should_close(cx, |_window, _cx| true);
        let view = cx.new(|cx| AppState::new(stores, window, cx));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

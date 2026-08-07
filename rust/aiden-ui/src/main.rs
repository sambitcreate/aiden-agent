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
mod onboarding;
mod panels;
mod pill;
mod services;
mod settings;
mod shell;
mod workspace;

use std::cell::RefCell;
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

    gpui::Application::new()
        .with_assets(gpui_component_assets::Assets)
        .run(move |cx: &mut App| {
            // gpui-component MUST be initialized first: theme global, i18n,
            // and component keybindings.
            gpui_component::init(cx);
            // Tokio runtime for reqwest/SSE work (providers), bridged into
            // GPUI foreground tasks.
            gpui_tokio_bridge::init(cx);

            cx.bind_keys([
                KeyBinding::new("cmd-q", app::Quit, Some("App")),
                KeyBinding::new("cmd-n", app::NewChat, Some("App")),
                KeyBinding::new("cmd-k", app::TogglePalette, Some("App")),
                KeyBinding::new("cmd-j", app::ToggleTerminal, Some("App")),
                // In-app pill toggle. A true global hotkey (active while
                // another app is focused) comes with the aiden-mac wiring in
                // a later phase.
                KeyBinding::new("cmd-shift-d", app::TogglePill, Some("App")),
            ]);

            let stores = match Stores::open() {
                Ok(stores) => stores,
                Err(error) => {
                    eprintln!("failed to open Aiden stores: {error}");
                    std::process::exit(1);
                }
            };

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
                let services = onboarding::OnboardingServices::new(stores.clone())
                    .with_on_complete(Box::new(move |cx: &mut App| {
                        if let Some(handle) = close_handle.borrow().as_ref() {
                            let _ = handle.update(cx, |_view, window, _cx| window.remove_window());
                        }
                        if let Err(error) = open_main_window(cx, stores_for_complete.clone()) {
                            eprintln!("failed to open the Aiden window: {error}");
                        }
                    }));
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
        titlebar: Some(TitleBar::title_bar_options()),
        window_background: gpui::WindowBackgroundAppearance::Blurred,
        app_id: Some(app_id.to_string()),
        tabbing_identifier: Some(tabbing_id.to_string()),
        ..Default::default()
    };

    cx.open_window(options, |window, cx| {
        let view = cx.new(|cx| AppState::new(stores, window, cx));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

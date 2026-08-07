//! Aiden Agent — GPUI application (Phase 6: wired shell).
//!
//! Boots gpui-component + the tokio bridge, loads the durable stores, and
//! opens either the onboarding flow (first run) or the main window. The
//! onboarding completion callback closes the onboarding window and opens the
//! main window; the persisted appearance is applied by the chat service.

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
    if let Err(err) = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .try_init()
    {
        eprintln!("failed to init tracing: {err}");
    }

    gpui::Application::new()
        .with_assets(gpui_component_assets::Assets)
        .run(|cx: &mut App| {
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
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1000.0), px(700.0)),
            cx,
        ))),
        titlebar: Some(TitleBar::title_bar_options()),
        window_background: gpui::WindowBackgroundAppearance::Blurred,
        app_id: Some("com.sambitcreate.aiden-agent".to_string()),
        tabbing_identifier: Some("aiden-main".to_string()),
        ..Default::default()
    };

    cx.open_window(options, |window, cx| {
        let view = cx.new(|cx| AppState::new(stores, window, cx));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

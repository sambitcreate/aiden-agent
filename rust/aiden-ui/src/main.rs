//! Aiden Agent — GPUI application (Phase 5: working chat shell).
//!
//! Boots gpui-component + the tokio bridge, loads the durable stores, opens
//! the main window with the chat shell, and applies the persisted appearance.

mod app;
mod chat;
// The onboarding flow and dictation pill are compiled here for standalone
// check coverage (the orchestrator wires them into the shell in a later
// phase). Until then, dead-code is expected.
#[allow(dead_code)]
mod onboarding;
mod panels;
#[allow(dead_code)]
mod pill;
mod services;
// The settings surface is compiled here for standalone check coverage (the
// `SettingsView` entity + `SettingsServices` are wired into the app shell by
// the orchestrator in a later phase). Until then, dead-code is expected.
#[allow(dead_code)]
mod settings;
mod shell;

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
            ]);

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

            let stores = match Stores::open() {
                Ok(stores) => stores,
                Err(error) => {
                    eprintln!("failed to open Aiden stores: {error}");
                    std::process::exit(1);
                }
            };

            cx.open_window(options, |window, cx| {
                let view = cx.new(|cx| AppState::new(stores, window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("failed to open the Aiden window");

            // Bring the window to the front on first launch.
            cx.activate(true);
        });
}

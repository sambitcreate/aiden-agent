//! Aiden Agent — GPUI application shell (Phase 3: bootable window).
//!
//! Boilerplate note: this file deliberately mirrors the Electron window's
//! look-and-feel — a `hiddenInset`-style transparent titlebar (traffic lights
//! supplied by the OS, dragged via the custom `TitleBar` row), a left sidebar
//! of chats, and a centered empty-state. Everything is themed through
//! gpui-component's `Theme` global (dark mode forced at boot).

use gpui::prelude::*;
use gpui::{
    actions, div, px, size, App, Bounds, Context, ElementId, FontWeight, KeyBinding, Render,
    SharedString, Window, WindowBounds, WindowOptions,
};

use gpui_component::{
    button::{Button, ButtonVariants},
    h_flex, v_flex, ActiveTheme, Icon, IconName, Root, Sizable, Theme, ThemeMode, TitleBar,
};

actions!(aiden, [Quit]);

/// A sidebar chat entry.
struct ChatEntry {
    title: SharedString,
    subtitle: SharedString,
}

struct AppState {
    chats: Vec<ChatEntry>,
    selected_chat: usize,
}

impl AppState {
    fn new() -> Self {
        Self {
            chats: vec![
                ChatEntry {
                    title: "Getting started".into(),
                    subtitle: "Welcome to Aiden".into(),
                },
                ChatEntry {
                    title: "What can you help me with?".into(),
                    subtitle: "An overview".into(),
                },
                ChatEntry {
                    title: "How do scheduled tasks work?".into(),
                    subtitle: "Automation basics".into(),
                },
                ChatEntry {
                    title: "Where do I add a provider?".into(),
                    subtitle: "Settings walkthrough".into(),
                },
            ],
            selected_chat: 0,
        }
    }

    fn on_quit(&mut self, _: &Quit, _window: &mut Window, cx: &mut Context<Self>) {
        cx.quit();
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();

        v_flex()
            .id("sidebar")
            .w(px(256.0))
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .child(self.sidebar_header(cx))
            .child(self.chat_list(cx))
    }

    fn sidebar_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        h_flex()
            .id("sidebar-header")
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .items_center()
            .justify_between()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        icon_chip(IconName::Bot)
                            .text_color(theme.sidebar_primary_foreground)
                            .bg(theme.sidebar_primary)
                            .rounded_md(),
                    )
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_sm()
                            .child("Aiden"),
                    ),
            )
            .child(
                Button::new("new-chat")
                    .ghost()
                    .small()
                    .icon(IconName::Plus)
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.chats.insert(
                            0,
                            ChatEntry {
                                title: "New chat".into(),
                                subtitle: "Just now".into(),
                            },
                        );
                        this.selected_chat = 0;
                        cx.notify();
                    })),
            )
    }

    fn chat_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("chat-list")
            .flex_1()
            .px_2()
            .py_1()
            .gap_1()
            .children(self.chats.iter().enumerate().map(|(index, chat)| {
                let selected = index == self.selected_chat;
                let (bg, fg) = if selected {
                    (theme.sidebar_accent, theme.sidebar_accent_foreground)
                } else {
                    (theme.sidebar, theme.sidebar_foreground)
                };
                v_flex()
                    .id(ElementId::Name(SharedString::from(format!("chat-{index}"))))
                    .w_full()
                    .px_2()
                    .py_1p5()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(bg)
                    .text_color(fg)
                    .hover(|style| {
                        if !selected {
                            style.bg(theme.sidebar_primary)
                        } else {
                            style
                        }
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.selected_chat = index;
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(chat.title.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .opacity(0.7)
                            .truncate()
                            .child(chat.subtitle.clone()),
                    )
            }))
    }

    fn main_area(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("main-area")
            .flex_1()
            .h_full()
            .items_center()
            .justify_center()
            .gap_3()
            .child(
                div()
                    .text_size(px(44.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme.foreground)
                    .child("Aiden"),
            )
            .child(
                div()
                    .text_lg()
                    .text_color(theme.muted_foreground)
                    .child("Your AI assistant for code, automation, and answers"),
            )
            .child(
                h_flex()
                    .gap_2()
                    .mt_4()
                    .items_center()
                    .child(Icon::new(IconName::Bot).small().text_color(theme.primary))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("GPUI port — Phase 3 scaffold"),
                    ),
            )
    }
}

impl Render for AppState {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("aiden-root")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context("App")
            .on_action(cx.listener(Self::on_quit))
            .child(
                TitleBar::new().child(
                    h_flex()
                        .id("titlebar-content")
                        .size_full()
                        .items_center()
                        .px_3()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .child("Aiden"),
                        ),
                ),
            )
            .child(
                h_flex()
                    .id("app-body")
                    .flex_1()
                    .size_full()
                    .child(self.sidebar(cx))
                    .child(self.main_area(cx)),
            )
    }
}

/// A small icon chip styled with the theme.
fn icon_chip(name: IconName) -> Icon {
    Icon::new(name).small().p_1()
}

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

            // Force the dark theme preset at boot (the Electron app defaults
            // to a dark shell).
            Theme::change(ThemeMode::Dark, None, cx);

            cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);

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
                let view = cx.new(|_| AppState::new());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("failed to open the Aiden window");

            // Bring the window to the front on first launch.
            cx.activate(true);
        });
}

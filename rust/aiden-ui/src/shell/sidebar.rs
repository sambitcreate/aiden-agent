//! Left sidebar: brand row, new-chat button, searchable chat list loaded from
//! the `ChatStore`, a view-navigation section (Chats / Scheduled / Subagents /
//! Usage / Settings), and a footer with the model picker, appearance mode
//! toggle, and the settings gear.

use aiden_core::appearance::Mode;
use gpui::{
    div, prelude::FluentBuilder as _, px, Context, ElementId, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::app::{AppState, AppView};
use crate::chat::composer::model_picker;
use crate::services::chat_service::relative_time;

impl AppState {
    /// The whole sidebar column.
    pub(crate) fn sidebar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("sidebar")
            .w(px(260.))
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .child(self.sidebar_header(cx))
            .child(self.sidebar_search(cx))
            .child(self.sidebar_list(window, cx))
            .child(self.sidebar_nav(cx))
            .child(self.sidebar_footer(window, cx))
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
                        div()
                            .size(px(20.))
                            .rounded_md()
                            .bg(theme.sidebar_primary)
                            .items_center()
                            .justify_center()
                            .child(
                                Icon::new(IconName::Bot)
                                    .xsmall()
                                    .text_color(theme.sidebar_primary_foreground),
                            ),
                    )
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Aiden"),
                    ),
            )
            .child(
                Button::new("new-chat")
                    .ghost()
                    .small()
                    .icon(IconName::Plus)
                    .tooltip("New chat (⌘N)")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.service.update(cx, |service, cx| service.new_chat(cx));
                    })),
            )
    }

    fn sidebar_search(&self, _cx: &mut Context<Self>) -> impl IntoElement {
        div().id("sidebar-search").w_full().px_2().pb_1().child(
            Input::new(&self.search_input)
                .small()
                .appearance(false)
                .bordered(false)
                .focus_bordered(true),
        )
    }

    fn sidebar_list(&self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let active_id = self.service.read(cx).active_chat_id.clone();
        let now = aiden_data::now_millis();
        // Owned row data so the render closures never borrow `cx`.
        let rows: Vec<(aiden_core::ChatMeta, bool)> = self
            .service
            .read(cx)
            .filtered_chats()
            .into_iter()
            .map(|meta| {
                let selected = active_id.as_deref() == Some(meta.id.as_str());
                (meta.clone(), selected)
            })
            .collect();
        let empty = rows.is_empty();

        v_flex()
            .id("sidebar-list")
            .flex_1()
            .w_full()
            .px_2()
            .py_1()
            .gap_1()
            .overflow_y_scroll()
            .when(empty, |el| {
                el.child(
                    div()
                        .w_full()
                        .px_2()
                        .py_2()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("No chats yet"),
                )
            })
            .children(
                rows.into_iter()
                    .map(|(meta, selected)| self.sidebar_chat_row(&meta, selected, now, cx)),
            )
    }

    fn sidebar_chat_row(
        &self,
        meta: &aiden_core::ChatMeta,
        selected: bool,
        now: u64,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let (bg, fg) = if selected {
            (theme.sidebar_accent, theme.sidebar_accent_foreground)
        } else {
            (theme.sidebar, theme.sidebar_foreground)
        };
        let id = meta.id.clone();
        let title = meta.title.clone();
        let timestamp = relative_time(meta.updated_at, now);
        let row_id = ElementId::Name(SharedString::from(format!("chat-{id}")));
        let click_id = id.clone();

        h_flex()
            .id(row_id)
            .w_full()
            .px_2()
            .py_1p5()
            .gap_2()
            .items_center()
            .rounded_md()
            .cursor_pointer()
            .bg(bg)
            .text_color(fg)
            .hover(move |style| {
                if !selected {
                    style.bg(theme.sidebar_primary)
                } else {
                    style
                }
            })
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.set_view(AppView::Chat, cx);
                this.service
                    .update(cx, |service, cx| service.select_chat(&click_id, cx));
            }))
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(0.))
                    .gap_0p5()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(title),
                    )
                    .child(div().text_xs().opacity(0.7).truncate().child(timestamp)),
            )
            .when(selected, |el| {
                let delete_id = id.clone();
                el.child(
                    Button::new(ElementId::Name(SharedString::from(format!(
                        "delete-chat-{delete_id}"
                    ))))
                    .ghost()
                    .xsmall()
                    .icon(IconName::Delete)
                    .tooltip("Delete chat")
                    .on_click(cx.listener(
                        move |this, _event, _window, cx| {
                            cx.stop_propagation();
                            this.service
                                .update(cx, |service, cx| service.delete_chat(&delete_id, cx));
                        },
                    )),
                )
            })
    }

    /// The view-navigation section: icons + labels for the main content areas
    /// (Charts first — the active view is highlighted like the chat rows).
    fn sidebar_nav(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let active = self.view;
        v_flex()
            .id("sidebar-nav")
            .w_full()
            .px_2()
            .py_1()
            .gap_0p5()
            .child(
                div()
                    .px_3()
                    .pb_1()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.muted_foreground)
                    .child("Views"),
            )
            .children(AppView::ALL.iter().map(|view| {
                let selected = *view == active;
                let (bg, fg) = if selected {
                    (theme.sidebar_accent, theme.sidebar_accent_foreground)
                } else {
                    (theme.sidebar, theme.sidebar_foreground)
                };
                let view = *view;
                let label = view.label();
                let icon = view.icon();
                h_flex()
                    .id(ElementId::Name(SharedString::from(format!(
                        "sidebar-nav-{}",
                        label.to_ascii_lowercase()
                    ))))
                    .w_full()
                    .px_2()
                    .py_1p5()
                    .gap_2()
                    .items_center()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(bg)
                    .text_color(fg)
                    .hover(move |style| {
                        if !selected {
                            style.bg(theme.sidebar_primary)
                        } else {
                            style
                        }
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.set_view(view, cx);
                    }))
                    .child(Icon::new(icon).small().text_color(fg))
                    .child(div().text_sm().truncate().child(label))
            }))
    }

    /// Footer: model picker, appearance mode toggle, settings gear.
    fn sidebar_footer(&self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let snapshot = self.service.read(cx).snapshot();
        let mode = self.service.read(cx).appearance.mode;
        let providers_empty = !snapshot.has_providers;

        v_flex()
            .id("sidebar-footer")
            .w_full()
            .px_2()
            .py_2()
            .gap_2()
            .border_t_1()
            .border_color(theme.sidebar_border)
            .child(
                self.model_select
                    .as_ref()
                    .map(|state| model_picker(state, providers_empty).into_any_element())
                    .unwrap_or_else(|| div().into_any_element()),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_1()
                    .items_center()
                    .child(self.mode_toggle(mode, cx))
                    .child(div().flex_1())
                    .child(
                        Button::new("settings-gear")
                            .ghost()
                            .small()
                            .icon(IconName::Settings)
                            .tooltip("Settings")
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.open_settings_section(window, cx);
                            })),
                    ),
            )
    }

    /// System / Light / Dark appearance toggle.
    fn mode_toggle(&self, current: Mode, cx: &mut Context<Self>) -> impl IntoElement {
        let button = |id: &'static str, mode: Mode, icon: IconName, label: &'static str| {
            let active = current == mode;
            let mut button = Button::new(id).ghost().xsmall().icon(icon).tooltip(label);
            if active {
                button = button.primary();
            }
            button.on_click(cx.listener(move |this, _event, _window, cx| {
                this.service
                    .update(cx, |service, cx| service.set_appearance_mode(mode, cx));
            }))
        };
        h_flex()
            .id("mode-toggle")
            .gap_1()
            .child(button(
                "mode-system",
                Mode::System,
                IconName::Palette,
                "System appearance",
            ))
            .child(button(
                "mode-light",
                Mode::Light,
                IconName::Sun,
                "Light appearance",
            ))
            .child(button(
                "mode-dark",
                Mode::Dark,
                IconName::Moon,
                "Dark appearance",
            ))
            .map(|el| el)
    }
}

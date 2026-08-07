//! The open-in-editor chip + picker (port of `open-in-editor-picker.tsx`).
//! Editor detection runs on the background through `aiden-data`'s bounded
//! `EditorCache`; launching uses the argv-only `open -b <bundleId> <folder>`.

use gpui::{
    div, prelude::FluentBuilder as _, px, App, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    h_flex, input::Input, spinner::Spinner, v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::app::AppState;

use super::state::{preferred_editor, Overlay, WorkspaceBarSnapshot, WorkspaceState};

impl AppState {
    /// The open-in-editor chip: launches the preferred editor from the picker.
    pub(crate) fn editor_chip(
        &self,
        state: &WorkspaceBarSnapshot,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let hover_theme = theme.clone();
        let active_theme = theme.clone();
        let loading = state.editors_loading && state.editors.is_empty();
        let label = preferred_editor(&state.editors)
            .map(|editor| format!("Open in {}", editor.label))
            .unwrap_or_else(|| "Open in editor".to_string());
        let enabled = state.active_folder.is_some();

        h_flex()
            .id("open-in-editor-chip")
            .px_2()
            .py_0p5()
            .gap_1()
            .items_center()
            .rounded_md()
            .cursor_pointer()
            .text_color(theme.muted_foreground)
            .hover(move |style| style.bg(hover_theme.list_hover))
            .active(move |style| style.bg(active_theme.list_active))
            .on_click(cx.listener(move |this, _event, window, cx| {
                if enabled {
                    this.workspace_state.update(cx, |state, cx| {
                        state.open_overlay(Overlay::Editors, window, cx)
                    });
                }
            }))
            .child(if loading {
                Spinner::new()
                    .small()
                    .color(theme.muted_foreground)
                    .into_any_element()
            } else {
                Icon::new(IconName::ExternalLink)
                    .xsmall()
                    .text_color(theme.muted_foreground)
                    .into_any_element()
            })
            .child(div().text_xs().max_w(px(180.)).truncate().child(label))
    }
}

/// The editors picker overlay: detected editors (priority-ranked, Finder
/// last); selecting one launches it and closes the overlay.
pub(crate) fn editors_content(
    entity: &Entity<WorkspaceState>,
    _window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let theme = cx.theme();
    let state = entity.read(cx);
    let search_input = state.search_input.clone();
    let query = state.search_input.read(cx).value().to_string();
    let editors: Vec<aiden_data::external_editors::ResolvedExternalEditor> = state.editors.clone();
    let loading = state.editors_loading;

    let filtered: Vec<_> = editors
        .iter()
        .filter(|editor| {
            let query = query.trim().to_lowercase();
            query.is_empty() || editor.label.to_lowercase().contains(&query)
        })
        .collect();

    v_flex()
        .id("editors-picker")
        .w_full()
        .max_h(px(360.))
        .child(
            div().w_full().p_2().child(
                Input::new(&search_input)
                    .small()
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(true),
            ),
        )
        .child(
            v_flex()
                .id("editors-list")
                .w_full()
                .flex_1()
                .overflow_y_scroll()
                .px_1()
                .pb_1()
                .gap_0p5()
                .when(filtered.is_empty(), |el| {
                    el.child(
                        div()
                            .w_full()
                            .px_2()
                            .py_2()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(if loading {
                                "Looking for installed editors…"
                            } else {
                                "No editors found."
                            }),
                    )
                })
                .children(filtered.into_iter().map(|editor| {
                    let editor_id = editor.id.clone();
                    let label = editor.label.clone();
                    let is_finder = editor.id == "finder";
                    let entity = entity.clone();
                    h_flex()
                        .id(ElementId::Name(SharedString::from(format!(
                            "editor-row-{editor_id}"
                        ))))
                        .w_full()
                        .px_2()
                        .py_1p5()
                        .gap_2()
                        .items_center()
                        .rounded_md()
                        .cursor_pointer()
                        .text_color(theme.foreground)
                        .hover(move |style| style.bg(theme.list_hover))
                        .on_click(move |_event, window, cx| {
                            entity.update(cx, |state, cx| {
                                state.open_in_editor(&editor_id, window, cx)
                            });
                        })
                        .child(
                            Icon::new(if is_finder {
                                IconName::Folder
                            } else {
                                IconName::ExternalLink
                            })
                            .small()
                            .text_color(theme.muted_foreground),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .truncate()
                                .child(label),
                        )
                })),
        )
}

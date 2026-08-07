//! The workspace context bar rendering: the workspace / git / open-in-editor
//! chips plus the workspace picker overlay content.

use aiden_data::portable_config::Workspace;
use gpui::{
    div, prelude::FluentBuilder as _, px, App, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{h_flex, input::Input, v_flex, ActiveTheme, Icon, IconName, Sizable as _};

use crate::app::AppState;

use super::state::{
    filter_workspaces, truncate_path_middle, Overlay, WorkspaceEvent, WorkspaceState,
};

impl AppState {
    /// The chat-pane header strip: workspace chip · git chip · editor chip.
    pub(crate) fn workspace_bar(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let snapshot = self.workspace_state.read(cx).bar_snapshot();
        let workspace = self.service.read(cx).workspace.clone();
        h_flex()
            .id("workspace-bar")
            .w_full()
            .px_3()
            .py_1()
            .gap_1()
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .child(self.workspace_chip(workspace.as_ref(), cx))
            .child(self.bar_divider(theme.border))
            .child(self.git_chip(&snapshot, cx))
            .child(self.bar_divider(theme.border))
            .child(self.editor_chip(&snapshot, cx))
    }

    fn bar_divider(&self, color: gpui::Hsla) -> impl IntoElement {
        div()
            .id("workspace-bar-divider")
            .h(px(14.))
            .w(px(1.))
            .bg(color)
            .flex_shrink_0()
    }

    /// The workspace chip: current workspace name (or "No workspace").
    fn workspace_chip(
        &self,
        workspace: Option<&Workspace>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let hover_theme = theme.clone();
        let active_theme = theme.clone();
        let name = workspace
            .map(|workspace| workspace.name.clone())
            .unwrap_or_else(|| "No workspace".to_string());
        let has_workspace = workspace.is_some();
        let folder = workspace.is_some_and(|workspace| workspace.folder_path.is_some());

        h_flex()
            .id("workspace-chip")
            .px_2()
            .py_0p5()
            .gap_1()
            .items_center()
            .rounded_md()
            .cursor_pointer()
            .text_color(if has_workspace {
                theme.foreground
            } else {
                theme.muted_foreground
            })
            .hover(move |style| style.bg(hover_theme.list_hover))
            .active(move |style| style.bg(active_theme.list_active))
            .on_click(cx.listener(|this, _event, window, cx| {
                this.workspace_state.update(cx, |state, cx| {
                    state.open_overlay(Overlay::Workspaces, window, cx)
                });
            }))
            .child(
                Icon::new(if folder {
                    IconName::FolderOpen
                } else {
                    IconName::Folder
                })
                .xsmall()
                .text_color(theme.muted_foreground),
            )
            .child(div().text_xs().max_w(px(220.)).truncate().child(name))
    }
}

/// The workspace picker overlay: recent workspaces (filtered by the search
/// input) + a "Choose folder…" row that opens the macOS folder panel.
pub(crate) fn workspaces_content(
    entity: &Entity<WorkspaceState>,
    _window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let theme = cx.theme();
    let state = entity.read(cx);
    let search_input = state.search_input.clone();
    let query = state.search_input.read(cx).value().to_string();
    let active_id = state.active_id.clone();
    let workspaces: Vec<Workspace> = state.workspaces.clone();

    let rows = filter_workspaces(&workspaces, &query);
    let active = active_id.as_deref();

    v_flex()
        .id("workspace-picker")
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
                .id("workspace-picker-list")
                .w_full()
                .flex_1()
                .overflow_y_scroll()
                .px_1()
                .pb_1()
                .gap_0p5()
                .when(rows.is_empty(), |el| {
                    el.child(
                        div()
                            .w_full()
                            .px_2()
                            .py_2()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("No matching workspaces."),
                    )
                })
                .children(rows.into_iter().map(|workspace| {
                    let row_id = workspace.id.clone();
                    let selected = active == Some(workspace.id.as_str());
                    let label = workspace.name.clone();
                    let path = workspace.folder_path.clone();
                    let entity = entity.clone();
                    h_flex()
                        .id(ElementId::Name(SharedString::from(format!(
                            "workspace-row-{row_id}"
                        ))))
                        .w_full()
                        .px_2()
                        .py_1p5()
                        .gap_2()
                        .items_center()
                        .rounded_md()
                        .cursor_pointer()
                        .bg(if selected {
                            theme.list_active
                        } else {
                            theme.popover
                        })
                        .text_color(theme.foreground)
                        .hover(move |style| {
                            if !selected {
                                style.bg(theme.list_hover)
                            } else {
                                style
                            }
                        })
                        .on_click(move |_event, window, cx| {
                            entity.update(cx, |state, cx| {
                                if !selected {
                                    cx.emit(WorkspaceEvent::SelectWorkspace { id: row_id.clone() });
                                }
                                state.close_dialog(window, cx);
                            });
                        })
                        .child(
                            Icon::new(IconName::Folder)
                                .small()
                                .text_color(theme.muted_foreground),
                        )
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
                                        .child(label),
                                )
                                .when_some(path, |el, path| {
                                    el.child(
                                        div()
                                            .text_xs()
                                            .text_color(theme.muted_foreground)
                                            .truncate()
                                            .child(truncate_path_middle(&path, 44)),
                                    )
                                }),
                        )
                        .when(selected, |el| {
                            el.child(Icon::new(IconName::Check).small().text_color(theme.accent))
                        })
                })),
        )
        .child(
            div()
                .w_full()
                .p_1()
                .border_t_1()
                .border_color(theme.border)
                .child(
                    h_flex()
                        .id("workspace-choose-folder")
                        .w_full()
                        .px_2()
                        .py_1p5()
                        .gap_2()
                        .items_center()
                        .rounded_md()
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.list_hover))
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |state, cx| state.choose_folder(window, cx));
                            }
                        })
                        .child(
                            Icon::new(IconName::FolderOpen)
                                .small()
                                .text_color(theme.muted_foreground),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.foreground)
                                .child("Choose folder…"),
                        ),
                ),
        )
}

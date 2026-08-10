//! The workspace context bar rendering: workspace and Git context plus the
//! workspace picker overlay content. Editor launching lives in the titlebar.

use aiden_data::portable_config::Workspace;
use gpui::{
    div, prelude::FluentBuilder as _, px, App, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    h_flex, input::Input, v_flex, ActiveTheme, Icon, IconName, PixelsExt as _, Sizable as _,
};

use crate::app::AppState;

use super::state::{
    filter_workspaces, truncate_path_middle, Overlay, WorkspaceEvent, WorkspaceState,
};

impl AppState {
    /// The quiet strip attached to the composer: workspace · local execution ·
    /// git. Permission is intentionally absent until the Rust service
    /// exposes an honest mutation path.
    pub(crate) fn workspace_bar(
        &self,
        interaction_busy: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let snapshot = self.workspace_state.read(cx).bar_snapshot();
        let workspace = self.service.read(cx).workspace.clone();
        let window_width = window.viewport_size().width.as_f32();
        let hide_local = window_width < 460.0;
        let context_busy = interaction_busy || snapshot.git_busy;
        h_flex()
            .id("workspace-bar")
            .mx_3()
            .min_h(px(32.))
            .min_w(px(0.))
            .px_1p5()
            .pt_1()
            .pb_2()
            .mb(px(-4.))
            .gap_0p5()
            .items_center()
            .rounded_t(px(12.))
            .bg(theme.secondary)
            .child(self.workspace_chip(workspace.as_ref(), window_width < 700.0, context_busy, cx))
            .child(self.bar_divider(theme.border))
            .when(!hide_local, |el| {
                el.child(
                    h_flex()
                        .px_2()
                        .gap_1()
                        .items_center()
                        .text_color(theme.muted_foreground)
                        .child(
                            Icon::new(IconName::SquareTerminal)
                                .xsmall()
                                .text_color(theme.muted_foreground),
                        )
                        .child(div().text_xs().child("Local")),
                )
                .child(self.bar_divider(theme.border))
            })
            .child(self.git_chip(&snapshot, interaction_busy, cx))
    }

    fn bar_divider(&self, color: gpui::Hsla) -> impl IntoElement {
        div().h(px(14.)).w(px(1.)).bg(color).flex_shrink_0()
    }

    /// The workspace chip: current workspace name (or "No workspace").
    fn workspace_chip(
        &self,
        workspace: Option<&Workspace>,
        compact: bool,
        busy: bool,
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
            .when(
                !busy && crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .when(busy, |el| el.opacity(0.55))
            .text_color(if has_workspace {
                theme.foreground
            } else {
                theme.muted_foreground
            })
            .when(!busy, |el| {
                el.hover(move |style| style.bg(hover_theme.list_hover))
                    .active(move |style| style.bg(active_theme.list_active))
            })
            .on_click(cx.listener(move |this, _event, window, cx| {
                if !busy {
                    this.workspace_state.update(cx, |state, cx| {
                        state.open_overlay(Overlay::Workspaces, window, cx)
                    });
                }
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
            .child(
                div()
                    .text_xs()
                    .max_w(px(if compact { 120.0 } else { 220.0 }))
                    .truncate()
                    .child(name),
            )
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
                        .when(
                            crate::services::appearance::pointer_cursors_enabled(cx),
                            |el| el.cursor_pointer(),
                        )
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
                        .when(
                            crate::services::appearance::pointer_cursors_enabled(cx),
                            |el| el.cursor_pointer(),
                        )
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

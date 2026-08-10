//! Canonical per-chat titlebar actions. The shell's `TitleBar` is the only
//! toolbar host; the chat pane deliberately owns no duplicate header.

use aiden_data::portable_config::{Workspace, WorkspacePermission};
use gpui::{
    div, prelude::FluentBuilder as _, px, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonRounded, ButtonVariants as _},
    h_flex, ActiveTheme, Disableable as _, IconName, PixelsExt as _, Selectable as _,
};

use crate::app::AppState;
use crate::shell::sidebar::SidebarVisibility;
use crate::workspace::preferred_editor;
use crate::workspace::Overlay;

pub(crate) const CHAT_TITLEBAR_HEIGHT_PX: f32 = 52.0;
const CHAT_TITLEBAR_INLINE_INSET_PX: f32 = 16.0;
const CHAT_TITLEBAR_TRAFFIC_INSET_PX: f32 = 142.0;
const EDITOR_LABEL_BREAKPOINT_PX: f32 = 600.0;

pub(crate) fn chat_title(title: Option<&str>) -> String {
    title
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("New agent")
        .to_string()
}

pub(crate) fn titlebar_left_inset(visibility: SidebarVisibility) -> f32 {
    if !visibility.compact && visibility.wide_visible {
        CHAT_TITLEBAR_INLINE_INSET_PX
    } else {
        CHAT_TITLEBAR_TRAFFIC_INSET_PX
    }
}

pub(crate) fn toolbar_content_width(
    window_width: f32,
    visibility: SidebarVisibility,
    sidebar_width: f32,
) -> f32 {
    if !visibility.compact && visibility.wide_visible {
        (window_width - sidebar_width).max(0.0)
    } else {
        window_width.max(0.0)
    }
}

pub(crate) fn editor_label_visible(toolbar_width: f32) -> bool {
    toolbar_width > EDITOR_LABEL_BREAKPOINT_PX
}

pub(crate) fn toolbar_conversation_width(
    workbench_width: f32,
    environment_full_open: bool,
    environment_layout: crate::environment::layout::EnvironmentLayout,
) -> f32 {
    if environment_full_open && environment_layout.inline {
        (workbench_width - environment_layout.width).max(0.0)
    } else {
        workbench_width.max(0.0)
    }
}

pub(crate) fn editor_action_enabled(
    has_workspace_folder: bool,
    has_preferred_editor: bool,
    generation_active: bool,
) -> bool {
    has_workspace_folder && has_preferred_editor && !generation_active
}

pub(crate) fn terminal_eligible(workspace: Option<&Workspace>) -> bool {
    workspace.is_some_and(|workspace| {
        workspace.folder_path.is_some() && workspace.permission != WorkspacePermission::None
    })
}

impl AppState {
    pub(crate) fn chat_toolbar_actions(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let workspace = self.service.read(cx).workspace.clone();
        let workspace_snapshot = self.workspace_state.read(cx).bar_snapshot();
        let generation_active = self.service.read(cx).generation_active();
        let workbench_width = toolbar_content_width(
            window.viewport_size().width.as_f32(),
            self.sidebar_visibility,
            self.sidebar_width,
        );
        let environment = self.environment.read(cx);
        let environment_layout = crate::environment::layout::resolve_layout(
            environment.preferred_width,
            workbench_width,
        );
        let toolbar_width = toolbar_conversation_width(
            workbench_width,
            environment.full_open(),
            environment_layout,
        );
        let terminal_open = self
            .terminal
            .as_ref()
            .is_some_and(|terminal| terminal.read(cx).is_open());
        let terminal_enabled = terminal_eligible(workspace.as_ref());
        let environment_enabled = terminal_enabled;
        let environment_open = self.environment.read(cx).open;

        h_flex()
            .id("chat-toolbar-actions")
            .gap_2()
            .items_center()
            .when(
                workspace
                    .as_ref()
                    .and_then(|workspace| workspace.folder_path.as_ref())
                    .is_some(),
                |el| {
                    let preferred = preferred_editor(
                        &workspace_snapshot.editors,
                        workspace_snapshot.preferred_editor_id.as_deref(),
                    );
                    let editor_label = preferred.map(|editor| editor.label.clone());
                    let editor_enabled =
                        editor_action_enabled(true, editor_label.is_some(), generation_active);
                    let editor_tooltip = if let Some(label) = &editor_label {
                        format!("Open workspace in {label} (⌘⇧E)")
                    } else if workspace_snapshot.editors_loading {
                        "Looking for installed editors…".to_string()
                    } else {
                        "No installed editor is available".to_string()
                    };
                    el.child(
                        h_flex()
                            .id("chat-toolbar-editor")
                            .h(px(36.))
                            .overflow_hidden()
                            .rounded_full()
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.secondary)
                            .child(
                                Button::new("chat-toolbar-editor-open")
                                    .ghost()
                                    .rounded(ButtonRounded::None)
                                    .h(px(36.))
                                    .px_2p5()
                                    .icon(IconName::ExternalLink)
                                    .when(editor_label_visible(toolbar_width), |button| {
                                        button.label("Open")
                                    })
                                    .disabled(!editor_enabled)
                                    .tooltip(editor_tooltip)
                                    .on_click(cx.listener(|this, _event, window, cx| {
                                        if this.service.read(cx).generation_active() {
                                            return;
                                        }
                                        this.workspace_state.update(cx, |state, cx| {
                                            state.open_preferred_editor(window, cx)
                                        });
                                    })),
                            )
                            .child(div().h(px(24.)).w(px(1.)).bg(theme.border))
                            .child(
                                Button::new("chat-toolbar-editor-menu")
                                    .ghost()
                                    .rounded(ButtonRounded::None)
                                    .size(px(36.))
                                    .icon(IconName::ChevronDown)
                                    .disabled(!editor_enabled)
                                    .tooltip("Choose editor")
                                    .on_click(cx.listener(|this, _event, window, cx| {
                                        if this.service.read(cx).generation_active() {
                                            return;
                                        }
                                        this.workspace_state.update(cx, |state, cx| {
                                            state.open_overlay(Overlay::Editors, window, cx)
                                        });
                                    })),
                            ),
                    )
                },
            )
            .child(
                div()
                    .id("chat-toolbar-environment-focus")
                    .track_focus(&self.environment_toggle_focus)
                    .tab_stop(environment_enabled)
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.toggle_environment(window, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(
                        Button::new("chat-toolbar-environment")
                            .ghost()
                            .size(px(36.))
                            .tab_stop(false)
                            .icon(if environment_open {
                                IconName::PanelRightClose
                            } else {
                                IconName::PanelRightOpen
                            })
                            .selected(environment_open)
                            .disabled(!environment_enabled)
                            .tooltip(if environment_open {
                                "Hide environment"
                            } else {
                                "Show environment"
                            })
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.toggle_environment(window, cx);
                            })),
                    ),
            )
            .child(
                div()
                    .id("chat-toolbar-terminal-focus")
                    .track_focus(&self.terminal_toggle_focus)
                    .tab_stop(terminal_enabled)
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            this.toggle_terminal(window, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(
                        Button::new("chat-toolbar-terminal")
                            .ghost()
                            .size(px(36.))
                            .tab_stop(false)
                            .icon(IconName::SquareTerminal)
                            .selected(terminal_open)
                            .disabled(!terminal_enabled)
                            .tooltip(if terminal_open {
                                "Hide terminal (⌘J)"
                            } else {
                                "Show terminal (⌘J)"
                            })
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.toggle_terminal(window, cx);
                            })),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(folder: Option<&str>, permission: WorkspacePermission) -> Workspace {
        Workspace {
            id: "workspace".into(),
            name: "Workspace".into(),
            folder_path: folder.map(str::to_string),
            permission,
            managed_worktree: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn chat_title_falls_back_exactly_to_new_agent() {
        assert_eq!(chat_title(None), "New agent");
        assert_eq!(chat_title(Some("  ")), "New agent");
        assert_eq!(chat_title(Some("Pinned title")), "Pinned title");
    }

    #[test]
    fn title_inset_tracks_inline_sidebar_geometry() {
        let visible = SidebarVisibility::new(true, false);
        assert_eq!(titlebar_left_inset(visible), 16.0);
        assert_eq!(toolbar_content_width(1000.0, visible, 272.0), 728.0);
        assert_eq!(
            titlebar_left_inset(SidebarVisibility::new(false, false)),
            142.0
        );
        assert_eq!(
            titlebar_left_inset(SidebarVisibility::new(true, true)),
            142.0
        );
    }

    #[test]
    fn editor_label_hides_at_the_canonical_breakpoint() {
        assert!(!editor_label_visible(600.0));
        assert!(editor_label_visible(600.1));
    }

    #[test]
    fn toolbar_width_subtracts_an_inline_environment_panel() {
        let workbench_width =
            toolbar_content_width(1400.0, SidebarVisibility::new(true, false), 272.0);
        let environment_layout = crate::environment::layout::resolve_layout(560.0, workbench_width);
        assert_eq!(workbench_width, 1128.0);
        assert_eq!(
            toolbar_conversation_width(workbench_width, true, environment_layout),
            568.0
        );
        assert!(!editor_label_visible(568.0));
    }

    #[test]
    fn editor_actions_ignore_git_refresh_state_and_require_generation_idle() {
        assert!(editor_action_enabled(true, true, false));
        assert!(!editor_action_enabled(true, true, true));
        assert!(!editor_action_enabled(false, true, false));
        assert!(!editor_action_enabled(true, false, false));
    }

    #[test]
    fn compact_minimum_keeps_title_and_icon_actions_in_bounds() {
        // 390 window - 142 traffic inset - 16 right inset - 12 title/action
        // gap - (editor split + Environment + Terminal + two 8px gaps).
        let title_budget =
            390.0 - 142.0 - 16.0 - 12.0 - (36.0 + 1.0 + 36.0 + 8.0 + 36.0 + 8.0 + 36.0);
        assert_eq!(title_budget, 59.0);
    }

    #[test]
    fn terminal_requires_folder_and_non_none_permission() {
        assert!(!terminal_eligible(None));
        assert!(!terminal_eligible(Some(&workspace(
            None,
            WorkspacePermission::Ask
        ))));
        assert!(!terminal_eligible(Some(&workspace(
            Some("/tmp"),
            WorkspacePermission::None
        ))));
        assert!(terminal_eligible(Some(&workspace(
            Some("/tmp"),
            WorkspacePermission::Ask
        ))));
        assert!(terminal_eligible(Some(&workspace(
            Some("/tmp"),
            WorkspacePermission::Full
        ))));
    }
}

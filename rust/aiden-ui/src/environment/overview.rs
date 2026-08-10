use aiden_data::portable_config::{Workspace, WorkspacePermission};
use gpui::{
    div, prelude::FluentBuilder as _, px, AnyElement, ElementId, FontWeight,
    InteractiveElement as _, IntoElement as _, ParentElement as _, StatefulInteractiveElement as _,
    Styled as _,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _};

use crate::app::AppState;

use super::{EnvironmentTab, EnvironmentWorkbench, ReviewMode, ReviewWorkbench};

pub(crate) fn overview(
    environment: &gpui::Entity<EnvironmentWorkbench>,
    review: &gpui::Entity<ReviewWorkbench>,
    workspace: Option<&Workspace>,
    compact: bool,
    cx: &mut gpui::Context<AppState>,
) -> AnyElement {
    let theme = cx.theme();
    let Some(workspace) = workspace else {
        return empty_state(
            "No workspace folder",
            "Choose a local workspace to see its environment, changes, and branch.",
            cx,
        );
    };
    if workspace.folder_path.is_none() {
        return empty_state(
            "No workspace folder",
            "Choose a local workspace to see its environment, changes, and branch.",
            cx,
        );
    }
    if workspace.permission == WorkspacePermission::None {
        return empty_state(
            "File access is off",
            "Change this workspace from No Access to inspect its local environment.",
            cx,
        );
    }

    let access = match workspace.permission {
        WorkspacePermission::Full => "Full access",
        WorkspacePermission::Ask => "Ask first",
        WorkspacePermission::None => "No access",
    };
    let local = if workspace.managed_worktree.is_some() {
        "Isolated worktree"
    } else {
        "Runs on this Mac"
    };
    let review_state = review.read(cx);
    let branch = review_state
        .review
        .data
        .as_ref()
        .filter(|review| review.is_repo)
        .and_then(|review| review.branch.clone())
        .unwrap_or_else(|| "Not a Git repository".to_string());
    let changes = review_state.review.data.as_ref().map_or_else(
        || {
            if review_state.review.loading {
                "Loading…".to_string()
            } else if review_state.review.warning.is_some() {
                "Review unavailable".to_string()
            } else {
                "Not loaded".to_string()
            }
        },
        |review| {
            if !review.is_repo {
                "Not a Git repository".to_string()
            } else if review.summary.file_count == 0 {
                "Clean".to_string()
            } else {
                format!(
                    "{} files · +{} −{}",
                    review.summary.file_count, review.summary.additions, review.summary.deletions
                )
            }
        },
    );

    v_flex()
        .id(if compact {
            "environment-overview-card"
        } else {
            "environment-overview-panel"
        })
        .w_full()
        .min_h(px(0.))
        .p_3()
        .gap_1()
        .when(!compact, |el| {
            el.child(
                v_flex()
                    .px_2()
                    .pb_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(workspace.name.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(access),
                    ),
            )
        })
        .child(review_row(
            environment,
            review,
            ReviewMode::Changes,
            "Changes",
            changes,
            cx,
        ))
        .child(review_row(
            environment,
            review,
            ReviewMode::Compare,
            "Compare",
            "Choose branch",
            cx,
        ))
        .child(overview_row(IconName::SquareTerminal, "Local", local, cx))
        .child(overview_row(IconName::GitHub, "Branch", branch, cx))
        .child(overview_row(
            IconName::FolderOpen,
            "Workspace",
            workspace.name.clone(),
            cx,
        ))
        .into_any_element()
}

fn review_row(
    environment: &gpui::Entity<EnvironmentWorkbench>,
    review: &gpui::Entity<ReviewWorkbench>,
    mode: ReviewMode,
    label: &'static str,
    detail: impl Into<gpui::SharedString>,
    cx: &mut gpui::Context<AppState>,
) -> AnyElement {
    let environment = environment.clone();
    let review = review.clone();
    let keyboard_environment = environment.clone();
    let keyboard_review = review.clone();
    gpui::div()
        .id(ElementId::Name(
            format!("environment-overview-{}", label.to_lowercase()).into(),
        ))
        .tab_stop(true)
        .when(
            crate::services::appearance::pointer_cursors_enabled(cx),
            |el| el.cursor_pointer(),
        )
        .hover(|style| style.bg(cx.theme().list_hover))
        .on_click(move |_event, window, cx| {
            review.update(cx, |state, cx| state.set_mode(mode, cx));
            environment.update(cx, |state, cx| {
                state.show(EnvironmentTab::Review, window, cx)
            });
        })
        .on_key_down(move |event: &gpui::KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                keyboard_review.update(cx, |state, cx| state.set_mode(mode, cx));
                keyboard_environment.update(cx, |state, cx| {
                    state.show(EnvironmentTab::Review, window, cx)
                });
                cx.stop_propagation();
            }
        })
        .child(overview_row(IconName::Inspector, label, detail, cx))
        .into_any_element()
}

fn overview_row(
    icon: IconName,
    label: impl Into<gpui::SharedString>,
    detail: impl Into<gpui::SharedString>,
    cx: &mut gpui::App,
) -> impl gpui::IntoElement {
    let theme = cx.theme();
    let label = label.into();
    let detail = detail.into();
    h_flex()
        .min_h(px(44.))
        .px_2()
        .gap_3()
        .items_center()
        .child(Icon::new(icon).small().text_color(theme.muted_foreground))
        .child(
            div()
                .min_w(px(0.))
                .flex_1()
                .text_sm()
                .truncate()
                .child(label),
        )
        .child(
            div()
                .max_w(px(190.))
                .text_xs()
                .text_color(theme.muted_foreground)
                .truncate()
                .child(detail),
        )
}

fn empty_state(title: &str, description: &str, cx: &mut gpui::App) -> AnyElement {
    let theme = cx.theme();
    v_flex()
        .w_full()
        .min_h(px(192.))
        .p_6()
        .items_center()
        .justify_center()
        .text_center()
        .gap_1()
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title.to_string()),
        )
        .child(
            div()
                .max_w(px(280.))
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(description.to_string()),
        )
        .into_any_element()
}

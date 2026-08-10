use aiden_git::{GitReviewFile, GitReviewFileStatus};
use gpui::{
    div, prelude::FluentBuilder as _, px, uniform_list, AnyElement, Context, ElementId, Entity,
    FontWeight, InteractiveElement as _, IntoElement as _, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex, v_flex, ActiveTheme, Disableable as _, Icon, IconName, Selectable as _, Sizable as _,
};

use crate::app::AppState;

use super::diff::DiffTone;
use super::state::{ReviewMode, ReviewWorkbench};

const MODE_BAR_HEIGHT: f32 = 40.;
const FILE_LIST_MAX_HEIGHT: f32 = 192.;
const FILE_ROW_MIN_HEIGHT: f32 = 40.;
const DIFF_TOOLBAR_HEIGHT: f32 = 36.;
const DIFF_ROW_HEIGHT: f32 = 18.;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CompareBranchesState {
    Ready,
    Loading,
    Error,
    NotRepository,
    NoTargets,
    NoTargetSelected,
}

fn compare_branches_state(
    has_data: bool,
    is_repo: bool,
    loading: bool,
    has_error: bool,
    target_count: usize,
    target_selected: bool,
) -> CompareBranchesState {
    if !has_data {
        return if loading {
            CompareBranchesState::Loading
        } else {
            CompareBranchesState::Error
        };
    }
    if !is_repo {
        return CompareBranchesState::NotRepository;
    }
    if target_count == 0 {
        return if has_error {
            CompareBranchesState::Error
        } else {
            CompareBranchesState::NoTargets
        };
    }
    if !target_selected {
        return CompareBranchesState::NoTargetSelected;
    }
    CompareBranchesState::Ready
}

fn keyboard_activates_target_trigger(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

fn comparison_empty_copy(ahead: u64, behind: u64) -> (&'static str, &'static str) {
    if ahead == 0 && behind == 0 {
        (
            "Branches are identical",
            "Both references point to the same history.",
        )
    } else {
        (
            "No file differences",
            "The histories differ, but the current branch has the same tree as their merge base.",
        )
    }
}

fn file_count_label(count: u64) -> String {
    format!("{count} {}", if count == 1 { "file" } else { "files" })
}

pub(crate) fn review_panel(
    review: &Entity<ReviewWorkbench>,
    _width: f32,
    _window: &mut Window,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let state = review.read(cx);
    let theme = cx.theme().clone();
    let mode = state.mode;
    let mode_focus = state.mode_focus.clone();
    let selected = state.selected_file.clone();
    let (files, summary, is_repo, branch, loading, warning) = match mode {
        ReviewMode::Changes => state.review.data.as_ref().map_or_else(
            || {
                (
                    Vec::new(),
                    None,
                    true,
                    None,
                    state.review.loading,
                    state.review.warning.clone(),
                )
            },
            |data| {
                (
                    data.files.clone(),
                    Some(data.summary.clone()),
                    data.is_repo,
                    data.branch.clone(),
                    state.review.loading,
                    state.review.warning.clone(),
                )
            },
        ),
        ReviewMode::Compare => state.comparison.data.as_ref().map_or_else(
            || {
                (
                    Vec::new(),
                    None,
                    true,
                    None,
                    state.comparison.loading,
                    state.comparison.warning.clone(),
                )
            },
            |data| {
                (
                    data.files.clone(),
                    Some(data.summary.clone()),
                    true,
                    data.current_branch.clone(),
                    state.comparison.loading,
                    state.comparison.warning.clone(),
                )
            },
        ),
    };
    let warning = warning.or_else(|| {
        (mode == ReviewMode::Compare)
            .then(|| state.branches.warning.clone())
            .flatten()
    });
    let data_present = match mode {
        ReviewMode::Changes => state.review.data.is_some(),
        ReviewMode::Compare => state.comparison.data.is_some(),
    };
    let targets = state.branch_targets();
    let target_ref = state.target_ref.clone();
    let target_menu_open = state.target_menu_open;
    let target_menu_active = state.target_menu_active.clone();
    let target_focus = state.target_focus.clone();
    let target_option_focus = state.target_option_focus.clone();
    let branches_data_present = state.branches.data.is_some();
    let branches_is_repo = state
        .branches
        .data
        .as_ref()
        .is_none_or(|branches| branches.is_repo);
    let branches_loading = state.branches.loading;
    let branches_warning = state.branches.warning.clone();
    let active_file = state.active_file.clone();
    let file_scroll = state.file_scroll.clone();
    let diff_scroll = state.diff_scroll.clone();
    let diff = state.file_diff.data.clone();
    let parsed = state.parsed_diff.clone();
    let diff_loading = state.file_diff.loading;
    let diff_warning = state.file_diff.warning.clone();
    let parsed_truncated = state.parsed_truncated;

    let mode_button = |button_mode: ReviewMode, label: &'static str| {
        let entity = review.clone();
        let button_focus = mode_focus.clone();
        h_flex()
            .id(match button_mode {
                ReviewMode::Changes => "review-mode-changes",
                ReviewMode::Compare => "review-mode-compare",
            })
            .when(mode == button_mode, |el| el.track_focus(&mode_focus))
            .tab_stop(mode == button_mode)
            .on_key_down({
                let entity = review.clone();
                move |event: &gpui::KeyDownEvent, _window, cx| {
                    let target = match event.keystroke.key.as_str() {
                        "left" | "right" => Some(if button_mode == ReviewMode::Changes {
                            ReviewMode::Compare
                        } else {
                            ReviewMode::Changes
                        }),
                        "home" => Some(ReviewMode::Changes),
                        "end" => Some(ReviewMode::Compare),
                        _ => None,
                    };
                    if let Some(target) = target {
                        entity.update(cx, |state, cx| state.set_mode(target, cx));
                        button_focus.focus(_window);
                        cx.stop_propagation();
                    }
                }
            })
            .child(
                Button::new(ElementId::Name(format!("review-mode-{label}").into()))
                    .ghost()
                    .small()
                    .tab_stop(false)
                    .label(label)
                    .selected(mode == button_mode)
                    .on_click(move |_event, _window, cx| {
                        entity.update(cx, |state, cx| state.set_mode(button_mode, cx));
                    }),
            )
    };

    let current_branch = branch.unwrap_or_else(|| "Current branch".into());
    let escape_focus = target_focus.clone();
    let mut body = v_flex()
        .id("review-panel-body")
        .relative()
        .size_full()
        .min_h(px(0.))
        .on_key_down({
            let review = review.clone();
            move |event: &gpui::KeyDownEvent, window, cx| {
                if target_menu_open && event.keystroke.key == "escape" {
                    review.update(cx, |state, cx| state.close_target_menu(cx));
                    escape_focus.focus(window);
                    cx.stop_propagation();
                }
            }
        })
        .child(
            h_flex()
                .h(px(MODE_BAR_HEIGHT))
                .flex_shrink_0()
                .px_3()
                .gap_1()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    h_flex()
                        .p(px(2.))
                        .rounded(px(9.))
                        .bg(theme.secondary)
                        .child(mode_button(ReviewMode::Changes, "Changes"))
                        .child(mode_button(ReviewMode::Compare, "Compare")),
                ),
        );

    if mode == ReviewMode::Changes {
        body = body.child(
            h_flex()
                .h(px(40.))
                .flex_shrink_0()
                .px_3()
                .gap_2()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    Icon::new(IconName::GitHub)
                        .small()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .truncate()
                        .text_sm()
                        .child(current_branch.clone()),
                )
                .when_some(
                    summary.as_ref().map(|summary| summary.file_count),
                    |el, count| {
                        el.child(
                            div()
                                .flex_shrink_0()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(file_count_label(count)),
                        )
                    },
                )
                .child(
                    Button::new("review-refresh")
                        .ghost()
                        .small()
                        .icon(IconName::Redo)
                        .disabled(loading)
                        .tooltip("Refresh changes")
                        .on_click({
                            let review = review.clone();
                            move |_event, _window, cx| {
                                review.update(cx, |state, cx| state.refresh(cx))
                            }
                        }),
                ),
        );
    } else {
        let current_label = targets
            .iter()
            .find(|target| Some(target.0.as_str()) == target_ref.as_deref())
            .map(|target| target.1.clone())
            .unwrap_or_else(|| "Choose branch".into());
        body = body.child(
            h_flex()
                .min_h(px(44.))
                .flex_shrink_0()
                .gap_2()
                .px_2()
                .py_1()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    Icon::new(IconName::GitHub)
                        .small()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    div()
                        .min_w(px(0.))
                        .max_w(gpui::relative(0.32))
                        .flex_shrink_0()
                        .truncate()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(current_branch),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child("with"),
                )
                .child(
                    h_flex()
                        .min_w(px(0.))
                        .flex_1()
                        .track_focus(&target_focus)
                        .tab_stop(!targets.is_empty())
                        .on_key_down({
                            let review = review.clone();
                            let return_focus = target_focus.clone();
                            let option_focus = target_option_focus.clone();
                            let enabled = !targets.is_empty();
                            move |event: &gpui::KeyDownEvent, window, cx| {
                                if enabled
                                    && keyboard_activates_target_trigger(
                                        event.keystroke.key.as_str(),
                                    )
                                {
                                    let was_open = review.read(cx).target_menu_open;
                                    review.update(cx, |state, cx| state.toggle_target_menu(cx));
                                    if was_open {
                                        return_focus.focus(window);
                                    } else {
                                        option_focus.focus(window);
                                    }
                                    cx.stop_propagation();
                                }
                            }
                        })
                        .child(
                            Button::new("review-target-select")
                                .ghost()
                                .small()
                                .tab_stop(false)
                                .icon(IconName::ChevronDown)
                                .label(current_label)
                                .disabled(targets.is_empty())
                                .on_click({
                                    let review = review.clone();
                                    let return_focus = target_focus.clone();
                                    let option_focus = target_option_focus.clone();
                                    move |_event, window, cx| {
                                        let was_open = review.read(cx).target_menu_open;
                                        review.update(cx, |state, cx| state.toggle_target_menu(cx));
                                        if was_open {
                                            return_focus.focus(window);
                                        } else {
                                            option_focus.focus(window);
                                        }
                                    }
                                }),
                        ),
                )
                .child(
                    Button::new("review-compare-refresh")
                        .ghost()
                        .small()
                        .icon(IconName::Redo)
                        .disabled(loading || target_ref.is_none())
                        .tooltip("Refresh comparison")
                        .on_click({
                            let review = review.clone();
                            move |_event, _window, cx| {
                                review.update(cx, |state, cx| state.refresh(cx))
                            }
                        }),
                ),
        );
        if target_menu_open {
            body = body
                .child(
                    div()
                        .id("review-target-menu-backdrop")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                            cx.stop_propagation();
                        })
                        .on_click({
                            let review = review.clone();
                            let return_focus = target_focus.clone();
                            move |_event, window, cx| {
                                cx.stop_propagation();
                                review.update(cx, |state, cx| state.close_target_menu(cx));
                                return_focus.focus(window);
                            }
                        }),
                )
                .child(
                    v_flex()
                        .id("review-target-menu")
                        .absolute()
                        .top(px(84.))
                        .left(px(120.))
                        .right(px(44.))
                        .max_h(px(240.))
                        .overflow_y_scroll()
                        .occlude()
                        .p_1()
                        .rounded(px(10.))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .shadow_lg()
                        .children(targets.iter().map(|(value, label)| {
                            let active = target_menu_active.as_deref() == Some(value.as_str());
                            let selected = target_ref.as_deref() == Some(value.as_str());
                            h_flex()
                                .id(ElementId::Name(
                                    format!("review-target-option:{value}").into(),
                                ))
                                .min_h(px(32.))
                                .px_2()
                                .gap_2()
                                .rounded(px(8.))
                                .tab_stop(active)
                                .when(active, |el| {
                                    el.track_focus(&target_option_focus).bg(theme.list_active)
                                })
                                .on_key_down({
                                    let review = review.clone();
                                    let return_focus = target_focus.clone();
                                    move |event: &gpui::KeyDownEvent, window, cx| {
                                        if matches!(event.keystroke.key.as_str(), "enter" | "space")
                                        {
                                            review.update(cx, |state, cx| {
                                                state.activate_target_menu(cx)
                                            });
                                            return_focus.focus(window);
                                            cx.stop_propagation();
                                        } else if review.update(cx, |state, cx| {
                                            state.move_target_menu(event.keystroke.key.as_str(), cx)
                                        }) {
                                            cx.stop_propagation();
                                        }
                                    }
                                })
                                .on_click({
                                    let review = review.clone();
                                    let value = value.clone();
                                    let return_focus = target_focus.clone();
                                    move |_event, window, cx| {
                                        review.update(cx, |state, cx| {
                                            state.choose_target(value.clone(), cx)
                                        });
                                        return_focus.focus(window);
                                    }
                                })
                                .child(div().w(px(14.)).child(if selected { "✓" } else { "" }))
                                .child(
                                    div()
                                        .min_w(px(0.))
                                        .flex_1()
                                        .truncate()
                                        .text_sm()
                                        .child(label.clone()),
                                )
                        })),
                );
        }
        if let Some(comparison) = state.comparison.data.as_ref() {
            body = body.child(
                h_flex()
                    .h(px(32.))
                    .flex_shrink_0()
                    .px_3()
                    .gap_3()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.secondary.opacity(0.5))
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex_1()
                            .truncate()
                            .child("Compared from merge base · no fetch."),
                    )
                    .child(format!("↑{} ↓{}", comparison.ahead, comparison.behind)),
            );
        }
    }

    if let Some(warning) = warning {
        body = body.child(
            div()
                .px_3()
                .py_2()
                .text_xs()
                .text_color(theme.warning)
                .child(warning),
        );
    }
    if mode == ReviewMode::Compare {
        let branch_state = compare_branches_state(
            branches_data_present,
            branches_is_repo,
            branches_loading,
            branches_warning.is_some(),
            targets.len(),
            target_ref.is_some(),
        );
        let branch_empty = match branch_state {
            CompareBranchesState::Ready => None,
            CompareBranchesState::Loading => Some((
                "Loading branches…",
                "Reading local and last-fetched branch references.",
            )),
            CompareBranchesState::Error => Some((
                "Branch list unavailable",
                "Refresh to read local branch references. Aiden never fetches implicitly.",
            )),
            CompareBranchesState::NotRepository => Some((
                "Not a Git repository",
                "Branch comparison is available for Git workspaces. Files remains usable.",
            )),
            CompareBranchesState::NoTargets => Some((
                "No branch to compare",
                "Create another local branch or fetch one outside Aiden, then refresh.",
            )),
            CompareBranchesState::NoTargetSelected => Some((
                "Choose a branch",
                "Select a local or last-fetched branch to compare.",
            )),
        };
        if let Some((title, detail)) = branch_empty {
            return body.child(empty(title, detail, cx)).into_any_element();
        }
    }
    if !data_present {
        let (title, detail) = if loading && mode == ReviewMode::Compare {
            (
                "Loading comparison…",
                "Comparing the current branch from its merge base.",
            )
        } else if loading {
            ("Loading review…", "Reading the current local Git snapshot.")
        } else if mode == ReviewMode::Compare && target_ref.is_none() {
            (
                "Choose a branch",
                "Select a local or last-fetched branch to compare.",
            )
        } else if mode == ReviewMode::Compare {
            (
                "Comparison unavailable",
                "Refresh to compare the pinned local Git references.",
            )
        } else {
            (
                "Review unavailable",
                "Refresh to read the local Git snapshot.",
            )
        };
        return body.child(empty(title, detail, cx)).into_any_element();
    }
    if !is_repo {
        return body
            .child(empty(
                "Not a Git repository",
                "Files remains available for this workspace.",
                cx,
            ))
            .into_any_element();
    }
    if files.is_empty() {
        let (title, detail) = if mode == ReviewMode::Changes {
            ("Clean", "The working tree has no changes.")
        } else {
            let comparison = state
                .comparison
                .data
                .as_ref()
                .expect("comparison data is present when rendering its empty state");
            comparison_empty_copy(comparison.ahead, comparison.behind)
        };
        return body.child(empty(title, detail, cx)).into_any_element();
    }

    let files = std::sync::Arc::new(files);
    let selected_file = files
        .iter()
        .find(|file| selected.as_deref() == Some(file.path.as_str()))
        .or_else(|| files.first())
        .cloned();
    let active_path = active_file.as_deref().or(selected.as_deref());
    let list_height = (files.len() as f32 * FILE_ROW_MIN_HEIGHT).min(FILE_LIST_MAX_HEIGHT);
    let list_files = files.clone();
    let list_review = review.clone();
    let list_selected = selected_file.as_ref().map(|file| file.path.clone());
    let list_active = active_path.map(str::to_string);
    body.child(
        uniform_list(
            "review-file-list",
            files.len(),
            cx.processor(move |_app, visible: std::ops::Range<usize>, _window, cx| {
                visible
                    .map(|index| {
                        file_row(
                            &list_review,
                            list_files[index].clone(),
                            list_selected.as_deref(),
                            list_active.as_deref(),
                            cx,
                        )
                    })
                    .collect()
            }),
        )
        .track_scroll(file_scroll)
        .h(px(list_height))
        .flex_shrink_0()
        .border_b_1()
        .border_color(theme.border),
    )
    .child(diff_surface(
        review,
        DiffSurfaceProps {
            file: selected_file,
            diff,
            lines: parsed,
            loading: diff_loading,
            warning: diff_warning,
            parsed_truncated,
            scroll: diff_scroll,
        },
        cx,
    ))
    .into_any_element()
}

fn file_row(
    review: &Entity<ReviewWorkbench>,
    file: GitReviewFile,
    selected: Option<&str>,
    active_path: Option<&str>,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let theme = cx.theme();
    let status_color = match file.status {
        GitReviewFileStatus::Added | GitReviewFileStatus::Untracked => theme.success,
        GitReviewFileStatus::Conflicted | GitReviewFileStatus::Deleted => theme.danger,
        _ => theme.muted_foreground,
    };
    let selected = selected == Some(file.path.as_str());
    let active = active_path == Some(file.path.as_str());
    let path = file.path.clone();
    h_flex()
        .id(ElementId::Name(format!("review-file:{}", file.path).into()))
        .min_h(px(FILE_ROW_MIN_HEIGHT))
        .px_3()
        .gap_2()
        .tab_stop(active)
        .when(selected, |el| el.bg(theme.list_active))
        .when(active, |el| el.track_focus(&review.read(cx).file_focus))
        .hover(|style| style.bg(theme.list_hover))
        .on_click({
            let review = review.clone();
            move |_event, _window, cx| {
                review.update(cx, |state, cx| state.choose_file(path.clone(), cx))
            }
        })
        .on_key_down({
            let review = review.clone();
            move |event: &gpui::KeyDownEvent, _window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    review.update(cx, |state, cx| state.activate_focused_file(cx));
                    cx.stop_propagation();
                } else if review.update(cx, |state, cx| {
                    state.move_file_focus(event.keystroke.key.as_str(), cx)
                }) {
                    cx.stop_propagation();
                }
            }
        })
        .child(
            div()
                .w(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(status_color)
                .child(status_label(file.status)),
        )
        .child(
            div()
                .min_w(px(0.))
                .flex_1()
                .truncate()
                .text_sm()
                .child(file.path.clone()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(stats(&file)),
        )
        .into_any_element()
}

struct DiffSurfaceProps {
    file: Option<GitReviewFile>,
    diff: Option<aiden_git::GitFileDiff>,
    lines: std::sync::Arc<Vec<super::diff::DiffLine>>,
    loading: bool,
    warning: Option<String>,
    parsed_truncated: bool,
    scroll: gpui::UniformListScrollHandle,
}

fn diff_surface(
    review: &Entity<ReviewWorkbench>,
    props: DiffSurfaceProps,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let DiffSurfaceProps {
        file,
        diff,
        lines,
        loading,
        warning,
        parsed_truncated,
        scroll,
    } = props;
    let theme = cx.theme().clone();
    let diff_markers = cx
        .try_global::<crate::services::appearance::AidenAppearanceRuntime>()
        .map(|runtime| runtime.diff_markers)
        .unwrap_or(aiden_core::appearance::DiffMarkers::Symbols);
    let Some(file) = file else {
        return div().into_any_element();
    };
    let cannot_open = file.status == GitReviewFileStatus::Deleted || file.binary == Some(true);
    let mut surface = v_flex().min_h(px(0.)).flex_1().child(
        h_flex()
            .h(px(DIFF_TOOLBAR_HEIGHT))
            .flex_shrink_0()
            .px_2()
            .gap_2()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .min_w(px(0.))
                    .flex_1()
                    .truncate()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(file.path.clone()),
            )
            .child(
                Button::new("review-open-file")
                    .ghost()
                    .small()
                    .label("Open file")
                    .disabled(cannot_open)
                    .on_click({
                        let review = review.clone();
                        move |_event, _window, cx| {
                            review.update(cx, |state, cx| state.open_selected_in_files(cx))
                        }
                    }),
            ),
    );
    if diff.as_ref().is_some_and(|diff| diff.binary) {
        return surface
            .child(empty("Binary file", "A text diff is not available.", cx))
            .into_any_element();
    }
    if diff.as_ref().is_some_and(|diff| diff.truncated) {
        surface = surface.child(
            div()
                .px_3()
                .py_2()
                .text_xs()
                .text_color(theme.warning)
                .child("Diff truncated by Aiden."),
        );
    }
    if parsed_truncated {
        surface = surface.child(
            div()
                .px_3()
                .py_2()
                .text_xs()
                .text_color(theme.warning)
                .child("Only the first 5,000 diff rows are rendered."),
        );
    }
    let warning_present = warning.is_some();
    if let Some(warning) = warning {
        surface = surface.child(
            div()
                .px_3()
                .py_2()
                .text_xs()
                .text_color(theme.danger)
                .child(warning),
        );
    }
    if loading && lines.is_empty() {
        return surface
            .child(empty(
                "Loading diff…",
                "Checking the pinned Git snapshot.",
                cx,
            ))
            .into_any_element();
    }
    if lines.is_empty() {
        let (title, detail) = if diff.is_some() {
            (
                "No textual diff",
                "Git returned an empty patch for this file.",
            )
        } else if warning_present {
            (
                "Diff unavailable",
                "Refresh the pinned Git snapshot and try again.",
            )
        } else {
            (
                "Select a changed file",
                "Its bounded unified diff will appear here.",
            )
        };
        return surface.child(empty(title, detail, cx)).into_any_element();
    }
    let row_lines = lines.clone();
    let row_theme = theme.clone();
    surface
        .child(
            div()
                .id("review-diff-horizontal-scroll")
                .min_h(px(0.))
                .flex_1()
                .overflow_x_scroll()
                .child(
                    uniform_list(
                        "review-diff-scroll",
                        lines.len(),
                        cx.processor(move |_app, visible: std::ops::Range<usize>, _window, _cx| {
                            visible
                                .map(|index| {
                                    let line = &row_lines[index];
                                    let (background, foreground) = match line.tone {
                                        DiffTone::Addition => {
                                            (row_theme.success.opacity(0.10), row_theme.success)
                                        }
                                        DiffTone::Deletion => {
                                            (row_theme.danger.opacity(0.10), row_theme.danger)
                                        }
                                        DiffTone::Hunk => (
                                            row_theme.accent.opacity(0.08),
                                            row_theme.accent_foreground,
                                        ),
                                        DiffTone::Header | DiffTone::Meta | DiffTone::Context => {
                                            (row_theme.background, row_theme.foreground)
                                        }
                                    };
                                    let marker = match (diff_markers, line.tone) {
                                        (
                                            aiden_core::appearance::DiffMarkers::Symbols,
                                            DiffTone::Addition,
                                        ) => "+",
                                        (
                                            aiden_core::appearance::DiffMarkers::Symbols,
                                            DiffTone::Deletion,
                                        ) => "−",
                                        _ => " ",
                                    };
                                    h_flex()
                                        .h(px(DIFF_ROW_HEIGHT))
                                        .min_w(px(404.))
                                        .bg(background)
                                        .text_xs()
                                        .text_color(foreground)
                                        .child(div().w(px(12.)).text_center().child(marker))
                                        .child(
                                            div()
                                                .w(px(42.))
                                                .text_right()
                                                .pr_2()
                                                .text_color(row_theme.muted_foreground)
                                                .child(
                                                    line.old
                                                        .map(|n| n.to_string())
                                                        .unwrap_or_default(),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .w(px(42.))
                                                .text_right()
                                                .pr_2()
                                                .text_color(row_theme.muted_foreground)
                                                .child(
                                                    line.new
                                                        .map(|n| n.to_string())
                                                        .unwrap_or_default(),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .min_w(px(320.))
                                                .whitespace_nowrap()
                                                .child(line.text.clone()),
                                        )
                                })
                                .collect()
                        }),
                    )
                    .track_scroll(scroll)
                    .min_h(px(0.))
                    .flex_1()
                    .font_family("monospace"),
                ),
        )
        .into_any_element()
}

fn status_label(status: GitReviewFileStatus) -> &'static str {
    match status {
        GitReviewFileStatus::Added => "A",
        GitReviewFileStatus::Conflicted => "U",
        GitReviewFileStatus::Copied => "C",
        GitReviewFileStatus::Deleted => "D",
        GitReviewFileStatus::Modified => "M",
        GitReviewFileStatus::Renamed => "R",
        GitReviewFileStatus::Untracked => "?",
    }
}
fn stats(file: &GitReviewFile) -> String {
    match (file.additions, file.deletions) {
        (Some(add), Some(del)) => format!("+{add} −{del}"),
        _ if file.binary == Some(true) => "Binary".into(),
        _ => String::new(),
    }
}
fn empty(title: &'static str, detail: &'static str, cx: &mut Context<AppState>) -> AnyElement {
    v_flex()
        .min_h(px(0.))
        .flex_1()
        .items_center()
        .justify_center()
        .gap_1()
        .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child(detail),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{
        compare_branches_state, comparison_empty_copy, file_count_label,
        keyboard_activates_target_trigger, CompareBranchesState,
    };

    #[test]
    fn compare_branch_states_are_explicit_and_ordered() {
        assert_eq!(
            compare_branches_state(false, true, true, false, 0, false),
            CompareBranchesState::Loading
        );
        assert_eq!(
            compare_branches_state(false, true, false, true, 0, false),
            CompareBranchesState::Error
        );
        assert_eq!(
            compare_branches_state(true, false, false, false, 0, false),
            CompareBranchesState::NotRepository
        );
        assert_eq!(
            compare_branches_state(true, true, false, false, 0, false),
            CompareBranchesState::NoTargets
        );
        assert_eq!(
            compare_branches_state(true, true, false, false, 2, false),
            CompareBranchesState::NoTargetSelected
        );
        assert_eq!(
            compare_branches_state(true, true, false, false, 2, true),
            CompareBranchesState::Ready
        );
        assert_eq!(
            compare_branches_state(true, true, false, true, 0, false),
            CompareBranchesState::Error
        );
    }

    #[test]
    fn comparison_empty_copy_distinguishes_history_identity() {
        assert_eq!(
            comparison_empty_copy(0, 0),
            (
                "Branches are identical",
                "Both references point to the same history."
            )
        );
        assert_eq!(comparison_empty_copy(1, 0).0, "No file differences");
        assert_eq!(comparison_empty_copy(0, 2).0, "No file differences");
    }

    #[test]
    fn comparison_target_trigger_uses_native_activation_keys() {
        assert!(keyboard_activates_target_trigger("enter"));
        assert!(keyboard_activates_target_trigger("space"));
        assert!(!keyboard_activates_target_trigger("down"));
        assert!(!keyboard_activates_target_trigger("escape"));
    }

    #[test]
    fn changes_toolbar_file_count_is_pluralized() {
        assert_eq!(file_count_label(0), "0 files");
        assert_eq!(file_count_label(1), "1 file");
        assert_eq!(file_count_label(2), "2 files");
    }
}

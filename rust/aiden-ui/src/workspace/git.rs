//! The git chip + the branch picker / commit / push dialog contents (ports of
//! `git-branch-picker.tsx`, `git-commit-dialog.tsx`, `git-push-dialog.tsx`).

use aiden_git::{GitBranches, GitCommitMode};
use gpui::{
    div, prelude::FluentBuilder as _, px, App, Context, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    spinner::Spinner,
    switch::Switch,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, Theme,
};

use crate::app::AppState;
use crate::services::appearance::pointer_cursors_enabled;

use super::state::{
    commit_selection_description, filter_branches, git_chip_from_info, order_local_branches,
    Overlay, WorkspaceBarSnapshot, WorkspaceState,
};

// ===========================================================================
// Git chip (branch name, dirty dot, ahead/behind)
// ===========================================================================

impl AppState {
    /// The git status chip. Clicking it opens the branch picker.
    pub(crate) fn git_chip(
        &self,
        state: &WorkspaceBarSnapshot,
        interaction_busy: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let busy = state.git_busy || interaction_busy;
        let hover_theme = theme.clone();
        let active_theme = theme.clone();
        let (text, dirty, ahead, behind, tone, enabled) =
            match state.git_info.as_ref().and_then(git_chip_from_info) {
                Some(chip) => (
                    chip.branch.clone(),
                    chip.dirty,
                    chip.ahead,
                    chip.behind,
                    theme.foreground,
                    true,
                ),
                None => {
                    if state.active_folder.is_none() {
                        (
                            "No folder".to_string(),
                            false,
                            0,
                            0,
                            theme.muted_foreground,
                            false,
                        )
                    } else if state.git_error.is_some() {
                        ("Git error".to_string(), false, 0, 0, theme.danger, true)
                    } else {
                        (
                            "Git…".to_string(),
                            false,
                            0,
                            0,
                            theme.muted_foreground,
                            false,
                        )
                    }
                }
            };

        h_flex()
            .id("git-chip")
            .px_2()
            .py_0p5()
            .gap_1()
            .items_center()
            .rounded_md()
            .when(enabled && !busy && pointer_cursors_enabled(cx), |el| {
                el.cursor_pointer()
            })
            .when(busy, |el| el.opacity(0.55))
            .text_color(tone)
            .when(enabled && !busy, |el| {
                el.hover(move |style| style.bg(hover_theme.list_hover))
                    .active(move |style| style.bg(active_theme.list_active))
            })
            .on_click(cx.listener(move |this, _event, window, cx| {
                if enabled && !busy {
                    this.workspace_state.update(cx, |state, cx| {
                        state.open_overlay(Overlay::Branches, window, cx)
                    });
                }
            }))
            .child(
                Icon::new(IconName::GitHub)
                    .xsmall()
                    .text_color(theme.muted_foreground),
            )
            .when(dirty, |el| {
                el.child(
                    div()
                        .size(px(6.))
                        .rounded_full()
                        .bg(theme.accent)
                        .flex_shrink_0(),
                )
            })
            .child(div().text_xs().max_w(px(180.)).truncate().child(text))
            .when(ahead > 0, |el| {
                el.child(
                    h_flex()
                        .gap_0p5()
                        .items_center()
                        .child(
                            Icon::new(IconName::ArrowUp)
                                .xsmall()
                                .text_color(theme.muted_foreground),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(ahead.to_string()),
                        ),
                )
            })
            .when(behind > 0, |el| {
                el.child(
                    h_flex()
                        .gap_0p5()
                        .items_center()
                        .child(
                            Icon::new(IconName::ArrowDown)
                                .xsmall()
                                .text_color(theme.muted_foreground),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(behind.to_string()),
                        ),
                )
            })
            .when(busy, |el| {
                el.child(Spinner::new().small().color(theme.muted_foreground))
            })
    }
}

// ===========================================================================
// Branch picker
// ===========================================================================

/// The branch picker overlay: searchable local branch list (current pinned
/// first), create-branch form, and Commit/Push entry rows.
pub(crate) fn branches_content(
    entity: &Entity<WorkspaceState>,
    _window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    let state = entity.read(cx);
    let search_input = state.search_input.clone();
    let branch_input = state.branch_input.clone();
    let query = state.search_input.read(cx).value().to_string();
    let branches = state.branches.clone();
    let busy = state.git_busy || state.interaction_blocked;
    let branch_error = state.branch_error.clone();
    let creating = state.branch_creating;
    let active_folder = state.active_folder.is_some();

    let Some(branches) = branches else {
        return loading_or_error(entity, busy, branch_error, cx).into_any_element();
    };

    let current = branches.current.clone();
    let unborn = branches.unborn.unwrap_or(false);
    let default_branch = branches.default_branch.clone();
    let local = order_local_branches(&branches);
    let filtered = filter_branches(&local, &query);
    let remote = branches.remote_branches.clone();
    let chip = git_chip_from_info(&GitInfoFromBranches::to_info(&branches));

    if creating {
        return create_form(entity, branch_input, busy, unborn, current.clone(), &theme)
            .into_any_element();
    }

    v_flex()
        .id("branch-picker")
        .w_full()
        .max_h(px(400.))
        .child(
            div().w_full().p_2().child(
                Input::new(&search_input)
                    .small()
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(true),
            ),
        )
        .when_some(branch_error, |el, error| {
            el.child(
                div()
                    .mx_2()
                    .rounded_md()
                    .px_2()
                    .py_1p5()
                    .bg(theme.danger)
                    .text_color(theme.danger_foreground)
                    .text_xs()
                    .child(error),
            )
        })
        .child(
            div()
                .px_3()
                .pt_2()
                .pb_1()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.muted_foreground)
                .child("Local branches"),
        )
        .child(
            v_flex()
                .id("branch-list")
                .w_full()
                .flex_1()
                .overflow_y_scroll()
                .px_1()
                .pb_1()
                .gap_0p5()
                .when(filtered.is_empty() && remote.is_empty(), |el| {
                    el.child(
                        div()
                            .w_full()
                            .px_2()
                            .py_2()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("No branches found."),
                    )
                })
                .children(filtered.into_iter().map(|name| {
                    branch_row(
                        entity,
                        name,
                        name == current.as_deref().unwrap_or(""),
                        unborn && name == current.as_deref().unwrap_or(""),
                        name == default_branch.as_deref().unwrap_or(""),
                        busy,
                        chip.as_ref().map(|chip| chip.summary.clone()),
                        cx,
                    )
                }))
                .when(!remote.is_empty(), |el| {
                    el.child(
                        div()
                            .px_3()
                            .pt_2()
                            .pb_1()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.muted_foreground)
                            .child("Remote tracking refs"),
                    )
                    .children(remote.into_iter().map(|name| {
                        remote_row(&name, theme.muted_foreground, cx).into_any_element()
                    }))
                }),
        )
        .child(
            div()
                .w_full()
                .p_1()
                .border_t_1()
                .border_color(theme.border)
                .child(
                    h_flex()
                        .id("branch-picker-footer")
                        .w_full()
                        .gap_1()
                        .child(
                            Button::new("branch-create-open")
                                .ghost()
                                .small()
                                .icon(IconName::Plus)
                                .label("Create and checkout new branch…")
                                .disabled(busy || unborn || !active_folder)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _window, cx| {
                                        entity.update(cx, |state, cx| {
                                            state.branch_creating = true;
                                            cx.notify();
                                        });
                                    }
                                }),
                        )
                        .child(div().flex_1())
                        .child(
                            Button::new("branch-commit-open")
                                .ghost()
                                .small()
                                .label("Commit changes…")
                                .disabled(busy)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |state, cx| {
                                            state.open_overlay(Overlay::Commit, window, cx)
                                        });
                                    }
                                }),
                        )
                        .child(
                            Button::new("branch-push-open")
                                .ghost()
                                .small()
                                .label("Push branch…")
                                .disabled(busy)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, window, cx| {
                                        entity.update(cx, |state, cx| {
                                            state.open_overlay(Overlay::Push, window, cx)
                                        });
                                    }
                                }),
                        ),
                ),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn branch_row(
    entity: &Entity<WorkspaceState>,
    name: &str,
    is_current: bool,
    is_unborn_current: bool,
    is_default: bool,
    busy: bool,
    current_summary: Option<String>,
    cx: &mut App,
) -> impl IntoElement {
    let theme = cx.theme();
    let name = name.to_string();
    let display = name.clone();
    let subtitle = if is_current {
        current_summary.clone()
    } else if is_default {
        Some("Default branch".to_string())
    } else {
        None
    };
    let row_id = ElementId::Name(SharedString::from(format!("branch-row-{name}")));
    let entity = entity.clone();
    h_flex()
        .id(row_id)
        .w_full()
        .px_2()
        .py_1p5()
        .gap_2()
        .items_center()
        .rounded_md()
        .when(pointer_cursors_enabled(cx), |el| el.cursor_pointer())
        .bg(if is_current {
            theme.list_active
        } else {
            theme.popover
        })
        .text_color(theme.foreground)
        .hover(move |style| {
            if !is_current {
                style.bg(theme.list_hover)
            } else {
                style
            }
        })
        .on_click(move |_event, _window, cx| {
            if !is_current && !busy {
                entity.update(cx, |state, cx| state.checkout_branch(&name, cx));
            }
        })
        .child(
            Icon::new(IconName::GitHub)
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
                        .child(display),
                )
                .when_some(subtitle, |el, subtitle| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate()
                            .child(subtitle),
                    )
                })
                .when(is_unborn_current, |el| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Create the first commit to continue"),
                    )
                }),
        )
        .when(is_current, |el| {
            el.child(Icon::new(IconName::Check).small().text_color(theme.accent))
        })
}

fn remote_row(name: &str, muted: gpui::Hsla, _cx: &mut App) -> impl IntoElement {
    let name = name.to_string();
    h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "remote-branch-{name}"
        ))))
        .w_full()
        .px_2()
        .py_1p5()
        .gap_2()
        .items_center()
        .rounded_md()
        .text_color(muted)
        .child(Icon::new(IconName::GitHub).small().text_color(muted))
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap_0p5()
                .child(div().text_sm().truncate().child(name))
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child("Create a local branch to switch"),
                ),
        )
}

fn create_form(
    entity: &Entity<WorkspaceState>,
    branch_input: Entity<gpui_component::input::InputState>,
    busy: bool,
    unborn: bool,
    current: Option<String>,
    theme: &Theme,
) -> impl IntoElement {
    let entity_for_create = entity.clone();
    v_flex()
        .id("branch-create")
        .w_full()
        .p_3()
        .gap_2()
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "New branch from {}",
                    current.unwrap_or_else(|| "HEAD".into())
                )),
        )
        .child(Input::new(&branch_input).small())
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap_2()
                .child(
                    Button::new("branch-create-cancel")
                        .ghost()
                        .small()
                        .label("Cancel")
                        .disabled(busy)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _window, cx| {
                                entity.update(cx, |state, cx| {
                                    state.branch_creating = false;
                                    cx.notify();
                                });
                            }
                        }),
                )
                .child(
                    Button::new("branch-create-confirm")
                        .primary()
                        .small()
                        .label("Create")
                        .disabled(busy || unborn)
                        .on_click(move |_, _window, cx| {
                            entity_for_create.update(cx, |state, cx| state.create_branch(cx));
                        }),
                ),
        )
}

fn loading_or_error(
    entity: &Entity<WorkspaceState>,
    busy: bool,
    branch_error: Option<String>,
    cx: &mut App,
) -> impl IntoElement {
    let theme = cx.theme();
    let retry = entity.clone();
    v_flex()
        .id("branch-loading")
        .w_full()
        .p_3()
        .gap_2()
        .child(
            div().text_sm().text_color(theme.muted_foreground).child(
                branch_error
                    .clone()
                    .unwrap_or_else(|| "Loading branches…".to_string()),
            ),
        )
        .when(branch_error.is_some(), |el| {
            el.child(
                Button::new("branch-retry")
                    .ghost()
                    .small()
                    .label("Try again")
                    .disabled(busy)
                    .on_click(move |_, _window, cx| {
                        retry.update(cx, |state, cx| {
                            state.branch_error = None;
                            state.refresh_branches(cx);
                        });
                    }),
            )
        })
}

// ===========================================================================
// Commit dialog
// ===========================================================================

/// The commit dialog: staged-summary description, message input, staged/all
/// mode, inline errors (taxonomy hints), and a result notification on success.
pub(crate) fn commit_content(
    entity: &Entity<WorkspaceState>,
    _window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    let state = entity.read(cx);
    let commit_input = state.commit_input.clone();
    let review = state.review.clone();
    let busy = state.git_busy || state.interaction_blocked;
    let error = state.commit_error.clone();
    let mode = state.commit_mode;
    let pointer_cursors = crate::services::appearance::pointer_cursor_for_interaction(cx, true);
    let message = state.commit_input.read(cx).value().to_string();

    let Some(review) = review else {
        return v_flex()
            .id("commit-loading")
            .w_full()
            .p_3()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("Loading the change review…"),
            )
            .into_any_element();
    };

    let allowed = review.commit.allowed;
    let branch = review
        .branch
        .clone()
        .unwrap_or_else(|| "current branch".to_string());
    let disabled_reason = if allowed {
        None
    } else {
        review.commit.reason.clone()
    };
    let staged_available = review.summary.staged_files > 0;
    let snapshot_ok = review.commit.snapshot.is_some();
    let confirm_disabled = busy
        || !allowed
        || !snapshot_ok
        || message.trim().is_empty()
        || (mode == GitCommitMode::Staged && !staged_available);

    let confirm = entity.clone();
    let retry = entity.clone();
    let set_staged = entity.clone();
    let set_all = entity.clone();

    v_flex()
        .id("commit-dialog")
        .w_full()
        .gap_3()
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "Commit the reviewed snapshot to {branch}. Git hooks and signing settings apply; push stays separate."
                )),
        )
        .when(allowed, |el| {
            el.child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.muted_foreground)
                            .child("Commit message"),
                    )
                    .child(
                        Input::new(&commit_input)
                            .small()
                            .appearance(false)
                            .bordered(true)
                            .focus_bordered(true),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.muted_foreground)
                            .child("Changes to include"),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                mode_row(
                                    "commit-mode-staged",
                                    "Staged changes only",
                                    commit_selection_description(&review, GitCommitMode::Staged),
                                    mode == GitCommitMode::Staged,
                                    !staged_available || busy,
                                    set_staged,
                                    false,
                                    pointer_cursors,
                                    &theme,
                                ),
                            )
                            .child(
                                mode_row(
                                    "commit-mode-all",
                                    "All current changes",
                                    commit_selection_description(&review, GitCommitMode::All),
                                    mode == GitCommitMode::All,
                                    busy,
                                    set_all,
                                    true,
                                    pointer_cursors,
                                    &theme,
                                ),
                            ),
                    ),
            )
        })
        .when(busy, |el| {
            el.child(
                h_flex()
                    .id("commit-busy")
                    .w_full()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.accent)
                    .child(
                        Spinner::new().small().color(theme.accent_foreground),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.accent_foreground)
                            .child("Creating an immutable local commit…"),
                    ),
            )
        })
        .when_some(disabled_reason, |el, reason| {
            el.child(
                div()
                    .w_full()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.warning)
                    .text_color(theme.warning_foreground)
                    .text_sm()
                    .child(reason),
            )
        })
        .when_some(error, |el, error| {
            el.child(
                v_flex()
                    .id("commit-error")
                    .w_full()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.danger)
                    .text_color(theme.danger_foreground)
                    .child(div().text_sm().child(error))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("commit-refresh")
                                    .ghost()
                                    .xsmall()
                                    .label("Refresh changes")
                                    .disabled(busy)
                                    .on_click(move |_, _window, cx| {
                                        retry.update(cx, |state, cx| {
                                            state.commit_error = None;
                                            state.refresh_review(cx);
                                        });
                                    }),
                            )
                            .child(div().flex_1()),
                    ),
            )
        })
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap_2()
                .child(
                    Button::new("commit-cancel")
                        .ghost()
                        .small()
                        .label("Cancel")
                        .disabled(busy)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |state, cx| state.close_dialog(window, cx));
                            }
                        }),
                )
                .child(
                    Button::new("commit-confirm")
                        .primary()
                        .small()
                        .label(if busy { "Committing…" } else { "Commit" })
                        .disabled(confirm_disabled)
                        .on_click(move |_, _window, cx| {
                            confirm.update(cx, |state, cx| state.commit_changes(cx));
                        }),
                ),
        )
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn mode_row(
    id: &'static str,
    title: &'static str,
    description: String,
    selected: bool,
    disabled: bool,
    entity: Entity<WorkspaceState>,
    all: bool,
    pointer_cursors: bool,
    theme: &Theme,
) -> impl IntoElement {
    let theme = theme.clone();
    let hover_theme = theme.clone();
    h_flex()
        .id(ElementId::Name(SharedString::from(id)))
        .w_full()
        .px_3()
        .py_2p5()
        .gap_2()
        .items_center()
        .rounded_md()
        .border_1()
        .border_color(theme.border)
        .when(pointer_cursors && !disabled, |el| el.cursor_pointer())
        .bg(if selected {
            theme.list_active
        } else {
            theme.popover
        })
        .hover(move |style| {
            if !disabled {
                style.bg(hover_theme.list_hover)
            } else {
                style
            }
        })
        .on_click(move |_event, _window, cx| {
            if !disabled {
                entity.update(cx, |state, cx| {
                    state.commit_mode = if all {
                        GitCommitMode::All
                    } else {
                        GitCommitMode::Staged
                    };
                    cx.notify();
                });
            }
        })
        .child(
            div()
                .size(px(14.))
                .rounded_full()
                .border_1()
                .border_color(if selected { theme.accent } else { theme.border })
                .items_center()
                .justify_center()
                .child(if selected {
                    Icon::new(IconName::Check)
                        .xsmall()
                        .text_color(theme.accent_foreground)
                        .into_any_element()
                } else {
                    div().into_any_element()
                }),
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
                        .text_color(if disabled {
                            theme.muted_foreground
                        } else {
                            theme.foreground
                        })
                        .child(title),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(description),
                ),
        )
}

// ===========================================================================
// Push dialog
// ===========================================================================

/// The push dialog: upstream detection + ahead count, remote/destination,
/// upstream toggle, and force-with-lease hidden behind an explicit confirm.
pub(crate) fn push_content(
    entity: &Entity<WorkspaceState>,
    _window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let theme = cx.theme().clone();
    let state = entity.read(cx);
    let push_input = state.push_input.clone();
    let confirm_input = state.confirm_input.clone();
    let capability = state.push_capability.clone();
    let busy = state.git_busy || state.interaction_blocked;
    let error = state.push_error.clone();
    let remote = state.push_remote.clone();
    let set_upstream = state.push_set_upstream;
    let force = state.push_force;
    let destination = state.push_input.read(cx).value().trim().to_string();

    let Some(capability) = capability else {
        return v_flex()
            .id("push-loading")
            .w_full()
            .p_3()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child("Loading the push state…"),
            )
            .into_any_element();
    };

    let allowed = capability.allowed;
    let branch = capability
        .branch
        .clone()
        .unwrap_or_else(|| "current branch".to_string());
    let disabled_reason = if allowed {
        None
    } else {
        capability.reason.clone()
    };
    let ahead = capability.ahead;
    let confirm_text = confirm_input.read(cx).value().trim().to_string();
    let remote_identity_ok = capability.remote_identities.contains_key(&remote);
    let confirm_disabled = busy
        || !allowed
        || !remote_identity_ok
        || remote.is_empty()
        || destination.is_empty()
        || (force && confirm_text != destination);

    let confirm = entity.clone();
    let retry = entity.clone();
    let set_upstream_entity = entity.clone();
    let force_entity = entity.clone();

    v_flex()
        .id("push-dialog")
        .w_full()
        .gap_3()
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "Push the reviewed {branch} commit. Aiden uses a normal non-force push and does not fetch first."
                )),
        )
        .when(allowed, |el| {
            el.child(
                v_flex()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.muted_foreground)
                            .child("Remote"),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .children(
                                capability.remotes.iter().map(|name| {
                                    let name = name.clone();
                                    let selected = name == remote;
                                    let click_name = name.clone();
                                    let entity = entity.clone();
                                    let mut chip = Button::new(ElementId::Name(SharedString::from(
                                        format!("push-remote-{name}"),
                                    )))
                                    .ghost()
                                    .small()
                                    .label(name);
                                    if selected {
                                        chip = chip.primary();
                                    }
                                    chip.disabled(busy)
                                        .on_click(move |_, _window, cx| {
                                            entity.update(cx, |state, cx| {
                                                state.push_remote = click_name.clone();
                                                cx.notify();
                                            });
                                        })
                                        .into_any_element()
                                }),
                            )
                            .when(capability.remotes.is_empty(), |el| {
                                el.child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child("No remotes configured."),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.muted_foreground)
                            .child("Destination branch"),
                    )
                    .child(Input::new(&push_input).small()),
            )
            .child(
                h_flex()
                    .id("push-upstream-row")
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .px_3()
                    .py_2p5()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.foreground)
                            .child("Remember as upstream"),
                    )
                    .child(
                        Switch::new("push-set-upstream")
                            .checked(set_upstream)
                            .disabled(busy)
                            .on_click(move |checked, _window, cx| {
                                set_upstream_entity.update(cx, |state, cx| {
                                    state.push_set_upstream = *checked;
                                    cx.notify();
                                });
                            }),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .rounded_md()
                    .px_3()
                    .py_2()
                    .bg(theme.secondary)
                    .text_color(theme.secondary_foreground)
                    .text_xs()
                    .child(if ahead > 0 {
                        format!("{ahead} commit{} ahead of the last-fetched upstream. Pre-push hooks and configured Git authentication may run; force push and submodule recursion are never used by default.", if ahead == 1 { "" } else { "s" })
                    } else {
                        "Up to date with the last-fetched upstream. Pre-push hooks and configured Git authentication may run; force push and submodule recursion are never used by default.".to_string()
                    }),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        h_flex()
                            .id("push-advanced-row")
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme.foreground)
                                    .child("Force push with lease"),
                            )
                            .child(
                                Switch::new("push-force")
                                    .checked(force)
                                    .disabled(busy)
                                    .on_click(move |checked, _window, cx| {
                                        force_entity.update(cx, |state, cx| {
                                            state.push_force = *checked;
                                            cx.notify();
                                        });
                                    }),
                            ),
                    )
                    .when(force, |el| {
                        el.child(
                            v_flex()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .child(format!(
                                            "Force-with-lease overwrites the remote ref only if it still matches. Type “{destination}” to confirm."
                                        )),
                                )
                                .child(Input::new(&confirm_input).small()),
                        )
                    }),
            )
        })
        .when(busy, |el| {
            el.child(
                h_flex()
                    .id("push-busy")
                    .w_full()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.accent)
                    .child(Spinner::new().small().color(theme.accent_foreground))
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.accent_foreground)
                            .child("Pushing the frozen commit… Workspace switching and dismissal stay locked."),
                    ),
            )
        })
        .when_some(disabled_reason, |el, reason| {
            el.child(
                div()
                    .w_full()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.warning)
                    .text_color(theme.warning_foreground)
                    .text_sm()
                    .child(reason),
            )
        })
        .when_some(error, |el, error| {
            el.child(
                v_flex()
                    .id("push-error")
                    .w_full()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(theme.danger)
                    .text_color(theme.danger_foreground)
                    .child(div().text_sm().child(error))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("push-refresh")
                                    .ghost()
                                    .xsmall()
                                    .label("Refresh branch state")
                                    .disabled(busy)
                                    .on_click(move |_, _window, cx| {
                                        retry.update(cx, |state, cx| {
                                            state.push_error = None;
                                            state.refresh_push(cx);
                                        });
                                    }),
                            )
                            .child(div().flex_1()),
                    ),
            )
        })
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap_2()
                .child(
                    Button::new("push-cancel")
                        .ghost()
                        .small()
                        .label("Cancel")
                        .disabled(busy)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                entity.update(cx, |state, cx| state.close_dialog(window, cx));
                            }
                        }),
                )
                .child(
                    Button::new("push-confirm")
                        .primary()
                        .small()
                        .label(if busy { "Pushing…" } else { "Push" })
                        .disabled(confirm_disabled)
                        .on_click(move |_, _window, cx| {
                            confirm.update(cx, |state, cx| state.push_changes(cx));
                        }),
                ),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Adapter so the branch picker can reuse the git chip summary for the
/// current branch's subtitle without another git round trip.
struct GitInfoFromBranches;

impl GitInfoFromBranches {
    fn to_info(branches: &GitBranches) -> aiden_git::GitInfo {
        aiden_git::GitInfo {
            is_repo: branches.is_repo,
            branch: branches.current.clone(),
            detached: branches.detached,
            unborn: branches.unborn,
            uncommitted: Some(branches.uncommitted),
            upstream: branches.upstream.clone(),
            ahead: branches.ahead,
            behind: branches.behind,
            default_branch: branches.default_branch.clone(),
            has_remote: branches.has_remote,
            remote_state: branches.remote_state.clone(),
        }
    }
}

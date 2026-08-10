use std::cell::Cell;
use std::rc::Rc;

use aiden_data::portable_config::Workspace;
use gpui::{
    div, prelude::FluentBuilder as _, px, AnyElement, AppContext as _, Context, Entity, FontWeight,
    InteractiveElement as _, IntoElement as _, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    resizable::{h_resizable, resizable_panel},
    v_flex, ActiveTheme, IconName, PixelsExt as _, Selectable as _, Sizable as _,
};

use crate::app::AppState;

use super::layout::{
    keyboard_resize_width, resolve_layout, summary_card_width, MAX_PANEL_WIDTH,
    MIN_CONVERSATION_WIDTH, MIN_PANEL_WIDTH,
};
use super::overview::overview;
use super::state::{EnvironmentTab, EnvironmentWorkbench};
use super::{files_panel, review_panel, FilesWorkbench, ReviewWorkbench};

#[derive(Clone)]
struct EnvironmentResizeDrag {
    start_width: f32,
    start_x: Rc<Cell<Option<f32>>>,
}

struct EnvironmentResizeDragView;

impl Render for EnvironmentResizeDragView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        div().size_0()
    }
}

fn pointer_resized_width(
    start_width: f32,
    start_x: f32,
    current_x: f32,
    container_width: f32,
) -> f32 {
    super::layout::clamp_panel_width(start_width + start_x - current_x, container_width)
}

#[cfg(test)]
fn overlay_pointer_drag_origin(preferred_width: f32, container_width: f32) -> Option<f32> {
    let layout = resolve_layout(preferred_width, container_width);
    (!layout.inline).then_some(layout.width)
}

pub(crate) struct EnvironmentWorkbenchProps {
    pub container_width: f32,
    pub workspace: Option<Workspace>,
    pub fallback_focus: gpui::FocusHandle,
    pub files: Entity<FilesWorkbench>,
    pub review: Entity<ReviewWorkbench>,
}

pub(crate) fn environment_workbench(
    environment: &Entity<EnvironmentWorkbench>,
    conversation: AnyElement,
    props: EnvironmentWorkbenchProps,
    window: &mut Window,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let EnvironmentWorkbenchProps {
        container_width,
        workspace,
        fallback_focus,
        files,
        review,
    } = props;
    let state = environment.read(cx);
    let open = state.open;
    let tab = state.tab;
    let full_open = state.full_open();
    let preferred_width = state.preferred_width;
    let resizable = state.resizable.clone();
    let layout = resolve_layout(preferred_width, container_width);
    let inline = full_open && layout.inline;
    let overlay = full_open && !layout.inline;
    let panel = panel_surface(
        environment,
        PanelSurfaceProps {
            width: layout.width,
            container_width,
            inline,
            fallback_focus: fallback_focus.clone(),
            files: files.clone(),
            review: review.clone(),
        },
        window,
        cx,
    );

    let body = if inline {
        let environment_weak = environment.downgrade();
        h_resizable("environment-inline-split")
            .with_state(&resizable)
            .child(
                resizable_panel()
                    .size_range(px(MIN_CONVERSATION_WIDTH)..gpui::Pixels::MAX)
                    .child(conversation),
            )
            .child(
                resizable_panel()
                    .size(px(layout.width))
                    .size_range(px(MIN_PANEL_WIDTH)..px(MAX_PANEL_WIDTH))
                    .child(panel),
            )
            .on_resize(move |state, _window, cx| {
                let Some(width) = state.read(cx).sizes().last().copied() else {
                    return;
                };
                let _ = environment_weak.update(cx, |environment, cx| {
                    environment.accept_resized_width(width.as_f32(), container_width, cx);
                });
            })
            .into_any_element()
    } else {
        div()
            .relative()
            .size_full()
            .min_w(px(0.))
            .child(conversation)
            .when(overlay, |el| {
                let environment = environment.clone();
                let files = files.clone();
                let fallback = fallback_focus.clone();
                el.child(
                    div()
                        .id("environment-overlay-backdrop")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .bg(gpui::black().opacity(0.10))
                        .on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                            cx.stop_propagation();
                        })
                        .on_click(move |_event, window, cx| {
                            cx.stop_propagation();
                            if files.read(cx).confirmation_open() {
                                return;
                            }
                            environment.update(cx, |state, cx| {
                                state.close(window, &fallback, cx);
                            });
                        }),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .w(px(layout.width))
                        .occlude()
                        .child(panel),
                )
            })
            .into_any_element()
    };

    div()
        .id("environment-workbench")
        .relative()
        .size_full()
        .min_w(px(0.))
        .overflow_hidden()
        .child(body)
        .when(open && tab == EnvironmentTab::Overview, |el| {
            el.child(summary_card(
                environment,
                &review,
                workspace.as_ref(),
                (container_width, window.viewport_size().height.as_f32()),
                fallback_focus,
                cx,
            ))
        })
        .into_any_element()
}

struct PanelSurfaceProps {
    width: f32,
    container_width: f32,
    inline: bool,
    fallback_focus: gpui::FocusHandle,
    files: Entity<FilesWorkbench>,
    review: Entity<ReviewWorkbench>,
}

fn panel_surface(
    environment: &Entity<EnvironmentWorkbench>,
    props: PanelSurfaceProps,
    _window: &mut Window,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let PanelSurfaceProps {
        width,
        container_width,
        inline,
        fallback_focus,
        files,
        review,
    } = props;
    let theme = cx.theme().clone();
    let state = environment.read(cx);
    let tab = state.tab;
    let first_focus = state.first_focus.clone();
    let last_focus = state.last_focus.clone();
    let active_tab_focus = state.active_tab_focus.clone();
    let panel_scope = state.panel_scope.clone();
    let compact_tabs = width < 520.0;
    let resize_drag = EnvironmentResizeDrag {
        start_width: width,
        start_x: Rc::new(Cell::new(None)),
    };

    let review_button = {
        let environment = environment.clone();
        h_flex()
            .id("environment-review-tab")
            .when(tab == EnvironmentTab::Review, |el| {
                el.track_focus(&active_tab_focus)
            })
            .tab_stop(tab == EnvironmentTab::Review)
            .rounded(px(9.))
            .on_key_down({
                let environment = environment.clone();
                move |event: &gpui::KeyDownEvent, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Review, window, cx)
                        });
                        cx.stop_propagation();
                    } else if let Some(tab) = super::state::roving_tab_from_key(
                        EnvironmentTab::Review,
                        &event.keystroke.key,
                    ) {
                        environment.update(cx, |state, cx| state.show(tab, window, cx));
                        cx.stop_propagation();
                    }
                }
            })
            .child(
                Button::new("environment-review-tab-button")
                    .ghost()
                    .small()
                    .tab_stop(false)
                    .icon(IconName::Inspector)
                    .selected(tab == EnvironmentTab::Review)
                    .when(!compact_tabs, |button| button.label("Review"))
                    .tooltip("Review workspace changes")
                    .on_click(move |_event, window, cx| {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Review, window, cx)
                        });
                    }),
            )
    };
    let files_button = {
        let environment = environment.clone();
        h_flex()
            .id("environment-files-tab-focus")
            .when(tab == EnvironmentTab::Files, |el| {
                el.track_focus(&active_tab_focus)
            })
            .tab_stop(tab == EnvironmentTab::Files)
            .on_key_down({
                let environment = environment.clone();
                move |event: &gpui::KeyDownEvent, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Files, window, cx)
                        });
                        cx.stop_propagation();
                    } else if let Some(tab) = super::state::roving_tab_from_key(
                        EnvironmentTab::Files,
                        &event.keystroke.key,
                    ) {
                        environment.update(cx, |state, cx| state.show(tab, window, cx));
                        cx.stop_propagation();
                    }
                }
            })
            .child(
                Button::new("environment-files-tab")
                    .ghost()
                    .small()
                    .tab_stop(false)
                    .icon(IconName::File)
                    .selected(tab == EnvironmentTab::Files)
                    .when(!compact_tabs, |button| button.label("Files"))
                    .tooltip("Browse workspace files")
                    .on_click(move |_event, window, cx| {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Files, window, cx)
                        });
                    }),
            )
    };
    let summary_button = {
        let environment = environment.clone();
        h_flex()
            .id("environment-summary-toggle-focus")
            .track_focus(&first_focus)
            .tab_stop(true)
            .child(
                Button::new("environment-summary-toggle")
                    .ghost()
                    .small()
                    .tab_stop(false)
                    .icon(IconName::LayoutDashboard)
                    .tooltip("Show environment summary")
                    .on_click(move |_event, window, cx| {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Overview, window, cx)
                        });
                    }),
            )
    };
    let close_button = {
        let environment = environment.clone();
        Button::new("environment-close")
            .ghost()
            .small()
            .icon(IconName::Close)
            .tooltip("Close environment panel")
            .on_click(move |_event, window, cx| {
                environment.update(cx, |state, cx| state.close(window, &fallback_focus, cx));
            })
    };

    let content = match tab {
        EnvironmentTab::Overview => div().into_any_element(),
        EnvironmentTab::Review => review_panel(&review, width, _window, cx),
        EnvironmentTab::Files => files_panel(&files, width, _window, cx),
    };

    v_flex()
        .id("environment-panel")
        .track_focus(&panel_scope)
        .relative()
        .size_full()
        .w(px(width))
        .min_w(px(0.))
        .overflow_hidden()
        .bg(theme.popover)
        .text_color(theme.foreground)
        .border_l_1()
        .border_color(theme.border)
        .when(!inline, |el| el.shadow_lg())
        .child(
            h_flex()
                .h(px(52.))
                .flex_shrink_0()
                .px_3()
                .gap_2()
                .items_center()
                .border_b_1()
                .border_color(theme.border)
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .truncate()
                        .child("Environment"),
                )
                .child(summary_button)
                .child(
                    h_flex()
                        .p(px(2.))
                        .rounded_md()
                        .bg(theme.secondary)
                        .child(review_button)
                        .child(files_button),
                )
                .child(close_button),
        )
        .child(div().min_h(px(0.)).flex_1().child(content))
        .child(
            div()
                .id("environment-resize-separator")
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(-4.))
                .w(px(8.))
                .cursor_col_resize()
                .track_focus(&last_focus)
                .tab_stop(true)
                .focus(move |style| style.bg(theme.list_active))
                .when(!inline, |el| {
                    el.on_mouse_down(gpui::MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation();
                    })
                    .on_drag(resize_drag, |drag, position, _window, cx| {
                        drag.start_x.set(Some(position.x.as_f32()));
                        cx.stop_propagation();
                        cx.new(|_| EnvironmentResizeDragView)
                    })
                    .on_drag_move({
                        let environment = environment.clone();
                        move |event: &gpui::DragMoveEvent<EnvironmentResizeDrag>, _window, cx| {
                            let drag = event.drag(cx);
                            let Some(start_x) = drag.start_x.get() else {
                                return;
                            };
                            let width = pointer_resized_width(
                                drag.start_width,
                                start_x,
                                event.event.position.x.as_f32(),
                                container_width,
                            );
                            environment.update(cx, |state, cx| {
                                state.preview_resized_width(width, container_width, cx);
                            });
                        }
                    })
                    .on_mouse_up(gpui::MouseButton::Left, {
                        let environment = environment.clone();
                        move |_event, _window, cx| {
                            environment.update(cx, |state, cx| state.persist_resized_width(cx));
                        }
                    })
                    .on_mouse_up_out(gpui::MouseButton::Left, {
                        let environment = environment.clone();
                        move |_event, _window, cx| {
                            environment.update(cx, |state, cx| state.persist_resized_width(cx));
                        }
                    })
                })
                .on_key_down({
                    let environment = environment.clone();
                    move |event: &gpui::KeyDownEvent, _window, cx| {
                        let current = environment.read(cx).preferred_width;
                        if let Some(width) = keyboard_resize_width(
                            current,
                            &event.keystroke.key,
                            event.keystroke.modifiers.shift,
                            container_width,
                        ) {
                            environment.update(cx, |state, cx| {
                                state.set_width(width, container_width, cx)
                            });
                            cx.stop_propagation();
                        }
                    }
                }),
        )
        .into_any_element()
}

fn summary_card(
    environment: &Entity<EnvironmentWorkbench>,
    review_workbench: &Entity<ReviewWorkbench>,
    workspace: Option<&Workspace>,
    viewport: (f32, f32),
    fallback_focus: gpui::FocusHandle,
    cx: &mut Context<AppState>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let summary_focus = environment.read(cx).summary_focus.clone();
    let summary_scope = environment.read(cx).summary_scope.clone();
    let card_width = summary_card_width(viewport.0);
    let card_height = (viewport.1 - 68.0).max(0.0);
    let review_button = {
        let environment = environment.clone();
        h_flex()
            .id("environment-card-review-focus")
            .track_focus(&summary_focus)
            .tab_stop(true)
            .child(
                Button::new("environment-card-review")
                    .ghost()
                    .small()
                    .tab_stop(false)
                    .icon(IconName::Inspector)
                    .tooltip("Review changes")
                    .on_click(move |_event, window, cx| {
                        environment.update(cx, |state, cx| {
                            state.show(EnvironmentTab::Review, window, cx)
                        });
                    }),
            )
    };
    let files = {
        let environment = environment.clone();
        Button::new("environment-card-files")
            .ghost()
            .small()
            .icon(IconName::File)
            .tooltip("Browse files")
            .on_click(move |_event, window, cx| {
                environment.update(cx, |state, cx| {
                    state.show(EnvironmentTab::Files, window, cx)
                });
            })
    };
    let close = {
        let environment = environment.clone();
        Button::new("environment-card-close")
            .ghost()
            .small()
            .icon(IconName::Close)
            .tooltip("Close environment summary")
            .on_click(move |_event, window, cx| {
                environment.update(cx, |state, cx| state.close(window, &fallback_focus, cx));
            })
    };
    v_flex()
        .id("environment-summary-card")
        .track_focus(&summary_scope)
        .absolute()
        .top(px(56.))
        .right(px(12.))
        .w(px(card_width))
        .max_h(px(card_height))
        .overflow_hidden()
        .rounded(px(24.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.popover)
        .shadow_lg()
        .occlude()
        .child(
            h_flex()
                .h(px(48.))
                .flex_shrink_0()
                .px_4()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .min_w(px(0.))
                        .flex_1()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.muted_foreground)
                        .truncate()
                        .child("Environment"),
                )
                .child(review_button)
                .child(files)
                .child(close),
        )
        .child(overview(environment, review_workbench, workspace, true, cx))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_drag_grows_left_and_shrinks_right_with_container_clamping() {
        assert_eq!(pointer_resized_width(560.0, 600.0, 584.0, 1200.0), 576.0);
        assert_eq!(pointer_resized_width(560.0, 600.0, 640.0, 1200.0), 520.0);
        assert_eq!(pointer_resized_width(480.0, 600.0, 800.0, 1200.0), 480.0);
        assert_eq!(pointer_resized_width(720.0, 600.0, 400.0, 1200.0), 720.0);
    }

    #[test]
    fn custom_pointer_drag_is_overlay_only_and_uses_rendered_width() {
        assert_eq!(resolve_layout(720.0, 1100.0).width, 540.0);
        assert_eq!(overlay_pointer_drag_origin(720.0, 1100.0), None);
        assert_eq!(overlay_pointer_drag_origin(720.0, 1039.0), Some(720.0));
        assert_eq!(overlay_pointer_drag_origin(560.0, 500.0), Some(456.0));
    }
}

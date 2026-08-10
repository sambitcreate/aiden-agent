//! Canonical settings navigation rendered through the application's one shared rail.

use gpui::{
    div, point, prelude::FluentBuilder as _, px, App, AppContext as _, BoxShadow, Context,
    ElementId, Entity, FocusHandle, Focusable as _, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window,
};
use gpui_component::{
    h_flex,
    input::{Input, InputState},
    v_flex, ActiveTheme, Icon, IconName,
};

use crate::app::{AppState, AppView};

use super::catalog::{
    destinations_in_group, filter_destinations, SettingsDestination, SettingsDestinationGroup,
    SettingsDestinationIcon,
};
use super::SettingsSection;

pub(crate) const SETTINGS_CONTROL_HEIGHT_PX: f32 = 40.0;
pub(crate) const SETTINGS_ROW_RADIUS_PX: f32 = 13.0;
pub(crate) const SETTINGS_BODY_TEXT_PX: f32 = 15.0;
pub(crate) const SETTINGS_GROUP_TEXT_PX: f32 = 13.0;
pub(crate) const SETTINGS_TITLE_TEXT_PX: f32 = 16.0;
pub(crate) const SETTINGS_ICON_SIZE_PX: f32 = 20.0;
const SETTINGS_CONTROL_SHADOW_LIGHT_OPACITY: f32 = 0.08;
const SETTINGS_CONTROL_SHADOW_DARK_OPACITY: f32 = 0.50;
const SETTINGS_CONTROL_OUTLINE_LIGHT_OPACITY: f32 = 0.10;
const SETTINGS_CONTROL_OUTLINE_DARK_OPACITY: f32 = 0.12;

fn settings_control_shadows(is_dark: bool) -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: if is_dark {
                gpui::white().opacity(SETTINGS_CONTROL_OUTLINE_DARK_OPACITY)
            } else {
                gpui::black().opacity(SETTINGS_CONTROL_OUTLINE_LIGHT_OPACITY)
            },
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(0.5),
        },
        BoxShadow {
            color: gpui::black().opacity(if is_dark {
                SETTINGS_CONTROL_SHADOW_DARK_OPACITY
            } else {
                SETTINGS_CONTROL_SHADOW_LIGHT_OPACITY
            }),
            offset: point(px(0.), px(1.)),
            blur_radius: px(2.),
            spread_radius: px(-1.),
        },
    ]
}

pub(crate) struct SettingsNavigation {
    pub(crate) search: Entity<InputState>,
    pub(crate) back_focus: FocusHandle,
    pub(crate) scope: FocusHandle,
    row_focus: Vec<(SettingsSection, FocusHandle)>,
}

impl SettingsNavigation {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<AppState>) -> Self {
        Self {
            search: cx.new(|cx| InputState::new(window, cx).placeholder("Search settings…")),
            back_focus: cx.focus_handle().tab_stop(true),
            scope: cx.focus_handle(),
            row_focus: SettingsSection::ALL
                .iter()
                .map(|section| (*section, cx.focus_handle().tab_stop(true)))
                .collect(),
        }
    }

    pub(crate) fn row_focus(&self, section: SettingsSection) -> &FocusHandle {
        self.row_focus
            .iter()
            .find_map(|(candidate, focus)| (*candidate == section).then_some(focus))
            .unwrap_or(&self.back_focus)
    }

    pub(crate) fn last_visible_focus(&self, cx: &App) -> FocusHandle {
        let query = self.search.read(cx).value();
        filter_destinations(query.as_ref()).last().map_or_else(
            || self.search.read(cx).focus_handle(cx),
            |destination| self.row_focus(destination.id).clone(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettingsCompactTabTarget {
    Native,
    Back,
    LastRailControl,
    LeadingToggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettingsEscapeTarget {
    Native,
    ClearSearchAndFocusBack,
    DismissCompact,
}

pub(crate) fn settings_escape_target(
    search_focused: bool,
    compact_open: bool,
) -> SettingsEscapeTarget {
    if search_focused {
        SettingsEscapeTarget::ClearSearchAndFocusBack
    } else if compact_open {
        SettingsEscapeTarget::DismissCompact
    } else {
        SettingsEscapeTarget::Native
    }
}

pub(crate) fn settings_compact_tab_target(
    backwards: bool,
    back_focused: bool,
    leading_toggle_focused: bool,
    last_rail_control_focused: bool,
    focus_inside_rail: bool,
) -> SettingsCompactTabTarget {
    if backwards && back_focused {
        SettingsCompactTabTarget::LeadingToggle
    } else if backwards && leading_toggle_focused {
        SettingsCompactTabTarget::LastRailControl
    } else if !backwards && last_rail_control_focused {
        SettingsCompactTabTarget::LeadingToggle
    } else if !backwards && leading_toggle_focused {
        SettingsCompactTabTarget::Back
    } else if !focus_inside_rail && !leading_toggle_focused {
        if backwards {
            SettingsCompactTabTarget::LeadingToggle
        } else {
            SettingsCompactTabTarget::Back
        }
    } else {
        SettingsCompactTabTarget::Native
    }
}

pub(crate) fn capture_settings_return_view(
    existing: Option<AppView>,
    current: AppView,
) -> Option<AppView> {
    existing.or((current != AppView::Settings).then_some(current))
}

fn keyboard_activates(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

fn destination_icon(icon: SettingsDestinationIcon) -> IconName {
    match icon {
        SettingsDestinationIcon::Server => IconName::Globe,
        SettingsDestinationIcon::ChartScatter => IconName::ChartPie,
        SettingsDestinationIcon::Wand2 => IconName::Asterisk,
        SettingsDestinationIcon::Plug => IconName::SquareTerminal,
        SettingsDestinationIcon::Globe => IconName::Globe,
        SettingsDestinationIcon::Clock3 => IconName::Calendar,
        SettingsDestinationIcon::Sparkles => IconName::Bot,
        SettingsDestinationIcon::MousePointer2 => IconName::Inspector,
        SettingsDestinationIcon::Mic => IconName::GalleryVerticalEnd,
        SettingsDestinationIcon::Keyboard => IconName::Check,
        SettingsDestinationIcon::Palette => IconName::Palette,
        SettingsDestinationIcon::Info => IconName::Info,
    }
}

impl AppState {
    pub(crate) fn settings_navigation_view(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let query = self.settings_navigation.search.read(cx).value().to_string();
        let filtered = filter_destinations(&query);
        let active = self
            .settings
            .as_ref()
            .map_or(SettingsSection::Providers, |settings| {
                settings.read(cx).active_section()
            });
        let search_focus = self.settings_navigation.search.read(cx).focus_handle(cx);
        let search_focused = search_focus.is_focused(window);
        let search = Input::new(&self.settings_navigation.search)
            .appearance(false)
            .bordered(false)
            .focus_bordered(false);
        let back_hover = theme.list_hover;
        let back_active = theme.list_active;
        let search_hover_border = if search_focused {
            theme.ring
        } else {
            theme.foreground.opacity(0.3)
        };

        v_flex()
            .id("settings-navigation")
            .track_focus(&self.settings_navigation.scope)
            .size_full()
            .min_w(gpui::px(0.))
            .overflow_y_scroll()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .px_3()
            .pb_4()
            .child(
                h_flex()
                    .id("settings-back")
                    .h(gpui::px(SETTINGS_CONTROL_HEIGHT_PX))
                    .flex_shrink_0()
                    .mb_2()
                    .px_2()
                    .gap_3()
                    .rounded(gpui::px(SETTINGS_ROW_RADIUS_PX))
                    .track_focus(&self.settings_navigation.back_focus)
                    .tab_stop(true)
                    .when(
                        crate::services::appearance::pointer_cursors_enabled(cx),
                        |el| el.cursor_pointer(),
                    )
                    .hover(move |style| style.bg(back_hover))
                    .focus(move |style| style.bg(back_active))
                    .active(move |style| style.bg(back_active))
                    .on_click(cx.listener(|this, _event, window, cx| {
                        this.return_from_settings(window, cx);
                    }))
                    .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                        if keyboard_activates(&event.keystroke.key) {
                            this.return_from_settings(window, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(
                        Icon::new(IconName::ChevronLeft)
                            .size(gpui::px(SETTINGS_ICON_SIZE_PX))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div()
                            .text_size(gpui::px(SETTINGS_BODY_TEXT_PX))
                            .child("Back to app"),
                    ),
            )
            .child(
                h_flex()
                    .id("settings-all")
                    .h(gpui::px(SETTINGS_CONTROL_HEIGHT_PX))
                    .flex_shrink_0()
                    .mb_4()
                    .px_2()
                    .gap_3()
                    .child(Icon::new(IconName::Settings2).size(gpui::px(SETTINGS_ICON_SIZE_PX)))
                    .child(
                        div()
                            .text_size(gpui::px(SETTINGS_TITLE_TEXT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .child("All settings"),
                    ),
            )
            .child(
                h_flex()
                    .id("settings-search")
                    .h(gpui::px(SETTINGS_CONTROL_HEIGHT_PX))
                    .flex_shrink_0()
                    .mb_6()
                    .px_3()
                    .gap_2()
                    .rounded(gpui::px(SETTINGS_ROW_RADIUS_PX))
                    .border_1()
                    .border_color(if search_focused {
                        theme.ring
                    } else {
                        theme.input
                    })
                    .bg(if search_focused {
                        crate::services::appearance::input_surface(cx)
                    } else {
                        theme.background
                    })
                    .shadow(settings_control_shadows(theme.is_dark()))
                    .hover(move |style| style.border_color(search_hover_border))
                    .text_size(gpui::px(SETTINGS_BODY_TEXT_PX))
                    .child(
                        Icon::new(IconName::Search)
                            .size(gpui::px(SETTINGS_ICON_SIZE_PX))
                            .text_color(theme.muted_foreground),
                    )
                    .child(div().min_w(gpui::px(0.)).flex_1().child(search)),
            )
            .child(
                v_flex()
                    .id("settings-destinations")
                    .gap_5()
                    .children(SettingsDestinationGroup::ALL.iter().filter_map(|group| {
                        let items = destinations_in_group(*group)
                            .filter(|destination| filtered.contains(destination))
                            .collect::<Vec<_>>();
                        (!items.is_empty()).then(|| {
                            v_flex()
                                .id(ElementId::Name(
                                    format!("settings-group-{}", group.label()).into(),
                                ))
                                .child(
                                    div()
                                        .mb_2()
                                        .px_3()
                                        .text_size(gpui::px(SETTINGS_GROUP_TEXT_PX))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.muted_foreground)
                                        .child(group.label()),
                                )
                                .child(v_flex().gap_0p5().children(items.into_iter().map(
                                    |destination| {
                                        self.settings_destination_row(
                                            destination,
                                            destination.id == active,
                                            cx,
                                        )
                                    },
                                )))
                        })
                    }))
                    .when(filtered.is_empty(), |el| {
                        el.child(
                            div()
                                .px_3()
                                .py_2()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(format!("No settings match “{}”.", query.trim())),
                        )
                    }),
            )
    }

    fn settings_destination_row(
        &self,
        destination: &'static SettingsDestination,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let id = destination.id;
        let row_focus = self.settings_navigation.row_focus(id).clone();
        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "settings-nav-{}",
                destination.id.as_str()
            ))))
            .w_full()
            .min_h(gpui::px(SETTINGS_CONTROL_HEIGHT_PX))
            .px_3()
            .py_2()
            .gap_3()
            .rounded(gpui::px(SETTINGS_ROW_RADIUS_PX))
            .when(
                crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .track_focus(&row_focus)
            .tab_stop(true)
            .bg(if selected {
                theme.list_active
            } else {
                theme.sidebar
            })
            .hover(move |style| {
                if selected {
                    style.bg(theme.list_active)
                } else {
                    style.bg(theme.list_hover)
                }
            })
            .focus(move |style| style.bg(theme.list_active))
            .active(move |style| style.bg(theme.list_active))
            .on_click(cx.listener(move |this, _event, window, cx| {
                this.select_settings_destination(id, window, cx);
            }))
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    if keyboard_activates(&event.keystroke.key) {
                        this.select_settings_destination(id, window, cx);
                        cx.stop_propagation();
                    }
                }),
            )
            .child(
                Icon::new(destination_icon(destination.icon))
                    .size(gpui::px(SETTINGS_ICON_SIZE_PX))
                    .text_color(theme.muted_foreground),
            )
            .child(
                div()
                    .min_w(gpui::px(0.))
                    .truncate()
                    .text_size(gpui::px(SETTINGS_BODY_TEXT_PX))
                    .child(destination.label),
            )
    }

    pub(crate) fn select_settings_destination(
        &mut self,
        section: SettingsSection,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(settings) = &self.settings {
            settings.update(cx, |settings, cx| settings.select_section(section, cx));
        }
        cx.notify();
    }

    pub(crate) fn return_from_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let destination = self.settings_return_view.take().unwrap_or(AppView::Chat);
        let focus = self.settings_return_focus.take();
        self.sidebar_return_focus = None;
        if self.sidebar_visibility.compact_open {
            self.sidebar_visibility = self
                .sidebar_visibility
                .transition(crate::shell::sidebar::SidebarVisibilityEvent::DismissCompact);
        }
        self.set_view(destination, cx);
        if let Some(focus) = focus {
            cx.defer_in(window, move |_this, window, _cx| focus.focus(window));
        } else {
            self.sidebar_toggle_focus.focus(window);
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::catalog::{filter_destinations, SettingsDestinationId};

    #[test]
    fn all_twelve_catalog_routes_are_selectable() {
        assert_eq!(SettingsDestinationId::ALL.len(), 12);
    }

    #[test]
    fn filtering_preserves_catalog_order_without_changing_selection() {
        let selected = SettingsDestinationId::About;
        let ids = filter_destinations("model")
            .into_iter()
            .map(|destination| destination.id)
            .collect::<Vec<_>>();

        assert_eq!(
            (ids, selected),
            (
                vec![
                    SettingsDestinationId::Providers,
                    SettingsDestinationId::ModelData,
                    SettingsDestinationId::Assistant,
                ],
                SettingsDestinationId::About,
            )
        );
    }

    #[test]
    fn return_view_is_captured_only_on_first_entry() {
        assert_eq!(
            capture_settings_return_view(Some(AppView::Usage), AppView::Chat),
            Some(AppView::Usage)
        );
    }

    #[test]
    fn return_view_never_captures_settings_itself() {
        assert_eq!(capture_settings_return_view(None, AppView::Settings), None);
    }

    #[test]
    fn compact_tab_wraps_between_back_and_leading_toggle() {
        assert_eq!(
            settings_compact_tab_target(true, true, false, false, true),
            SettingsCompactTabTarget::LeadingToggle
        );
        assert_eq!(
            settings_compact_tab_target(false, false, true, false, false),
            SettingsCompactTabTarget::Back
        );
        assert_eq!(
            settings_compact_tab_target(true, false, true, false, false),
            SettingsCompactTabTarget::LastRailControl
        );
        assert_eq!(
            settings_compact_tab_target(false, false, false, true, true),
            SettingsCompactTabTarget::LeadingToggle
        );
    }

    #[test]
    fn compact_tab_preserves_native_order_inside_the_rail() {
        assert_eq!(
            settings_compact_tab_target(false, false, false, false, true),
            SettingsCompactTabTarget::Native
        );
    }

    #[test]
    fn activation_keys_match_native_buttons() {
        assert!(keyboard_activates("enter"));
        assert!(keyboard_activates("space"));
        assert!(!keyboard_activates("escape"));
    }

    #[test]
    fn settings_search_escape_clears_in_wide_and_compact_layouts() {
        assert_eq!(
            settings_escape_target(true, false),
            SettingsEscapeTarget::ClearSearchAndFocusBack
        );
        assert_eq!(
            settings_escape_target(true, true),
            SettingsEscapeTarget::ClearSearchAndFocusBack
        );
        assert_eq!(
            settings_escape_target(false, true),
            SettingsEscapeTarget::DismissCompact
        );
        assert_eq!(
            settings_escape_target(false, false),
            SettingsEscapeTarget::Native
        );
    }

    #[test]
    fn settings_search_shadow_matches_the_electron_control_elevation() {
        let light = settings_control_shadows(false);
        let dark = settings_control_shadows(true);
        assert_eq!(light.len(), 2);
        assert_eq!(dark.len(), 2);
        assert_eq!(light[0].offset, point(px(0.), px(0.)));
        assert_eq!(light[0].blur_radius, px(0.));
        assert_eq!(light[0].spread_radius, px(0.5));
        assert_eq!(
            light[0].color,
            gpui::black().opacity(SETTINGS_CONTROL_OUTLINE_LIGHT_OPACITY)
        );
        assert_eq!(
            dark[0].color,
            gpui::white().opacity(SETTINGS_CONTROL_OUTLINE_DARK_OPACITY)
        );
        assert_eq!(light[1].offset, point(px(0.), px(1.)));
        assert_eq!(light[1].blur_radius, px(2.));
        assert_eq!(light[1].spread_radius, px(-1.));
        assert_eq!(
            light[1].color,
            gpui::black().opacity(SETTINGS_CONTROL_SHADOW_LIGHT_OPACITY)
        );
        assert_eq!(
            dark[1].color,
            gpui::black().opacity(SETTINGS_CONTROL_SHADOW_DARK_OPACITY)
        );
    }

    #[test]
    fn settings_shell_uses_the_canonical_shared_sidebar_geometry() {
        assert_eq!(crate::shell::sidebar::SIDEBAR_DEFAULT_WIDTH, 272.0);
        assert_eq!(crate::shell::sidebar::SIDEBAR_MIN_WIDTH, 236.0);
        assert_eq!(crate::shell::sidebar::SIDEBAR_MAX_WIDTH, 340.0);
        assert!(crate::shell::sidebar::is_compact_sidebar_width(699.0));
        assert!(!crate::shell::sidebar::is_compact_sidebar_width(700.0));
        assert_eq!(
            crate::shell::sidebar::sidebar_overlay_width(340.0, 390.0),
            334.0
        );
    }

    #[test]
    fn settings_navigation_uses_the_electron_control_metrics() {
        assert_eq!(SETTINGS_CONTROL_HEIGHT_PX, 40.0);
        assert_eq!(SETTINGS_ROW_RADIUS_PX, 13.0);
        assert_eq!(SETTINGS_BODY_TEXT_PX, 15.0);
        assert_eq!(SETTINGS_GROUP_TEXT_PX, 13.0);
        assert_eq!(SETTINGS_TITLE_TEXT_PX, 16.0);
        assert_eq!(SETTINGS_ICON_SIZE_PX, 20.0);
    }
}

//! Canonical leading rail: search, primary actions, workspace switcher,
//! time-bucketed conversations, and the profile/settings destinations.

use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::config_store::ConfigStore;
use chrono::{Datelike as _, Local, TimeZone as _};
use gpui::{
    div, prelude::FluentBuilder as _, px, App, AppContext as _, Context, ElementId, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::Input,
    v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::app::{AppState, AppView};
use crate::workspace::Overlay;

pub const SIDEBAR_DEFAULT_WIDTH: f32 = 272.0;
pub const SIDEBAR_MIN_WIDTH: f32 = 236.0;
pub const SIDEBAR_MAX_WIDTH: f32 = 340.0;
pub const SIDEBAR_COMPACT_BREAKPOINT: f32 = 700.0;
const SIDEBAR_OVERLAY_MARGIN: f32 = 56.0;
const SIDEBAR_WIDTH_SETTINGS_KEY: &str = "shell.sidebarWidth";
const SIDEBAR_COLLAPSED_SETTINGS_KEY: &str = "shell.sidebarCollapsed";
static SIDEBAR_WIDTH_GENERATION: AtomicU64 = AtomicU64::new(0);
static SIDEBAR_COLLAPSE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SidebarVisibility {
    pub(crate) wide_visible: bool,
    pub(crate) compact: bool,
    pub(crate) compact_open: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SidebarVisibilityEvent {
    Toggle,
    DismissCompact,
    WindowCompact(bool),
}

impl SidebarVisibility {
    pub(crate) fn new(wide_visible: bool, compact: bool) -> Self {
        Self {
            wide_visible,
            compact,
            compact_open: false,
        }
    }

    pub(crate) fn visible(self) -> bool {
        if self.compact {
            self.compact_open
        } else {
            self.wide_visible
        }
    }

    pub(crate) fn transition(self, event: SidebarVisibilityEvent) -> Self {
        match event {
            SidebarVisibilityEvent::Toggle if self.compact => Self {
                compact_open: !self.compact_open,
                ..self
            },
            SidebarVisibilityEvent::Toggle => Self {
                wide_visible: !self.wide_visible,
                ..self
            },
            SidebarVisibilityEvent::DismissCompact => Self {
                compact_open: false,
                ..self
            },
            SidebarVisibilityEvent::WindowCompact(compact) => Self {
                compact,
                compact_open: false,
                ..self
            },
        }
    }
}

pub(crate) fn clamp_sidebar_width(width: f32) -> f32 {
    if width.is_finite() {
        width.clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
    } else {
        SIDEBAR_DEFAULT_WIDTH
    }
}

pub(crate) fn is_compact_sidebar_width(window_width: f32) -> bool {
    window_width < SIDEBAR_COMPACT_BREAKPOINT
}

pub(crate) fn sidebar_overlay_width(saved_width: f32, window_width: f32) -> f32 {
    clamp_sidebar_width(saved_width).min((window_width - SIDEBAR_OVERLAY_MARGIN).max(0.0))
}

pub(crate) fn load_sidebar_width(config: &ConfigStore) -> f32 {
    config
        .get_settings()
        .ok()
        .and_then(|settings| {
            settings
                .get(SIDEBAR_WIDTH_SETTINGS_KEY)
                .and_then(|value| value.as_f64())
        })
        .map(|width| clamp_sidebar_width(width as f32))
        .unwrap_or(SIDEBAR_DEFAULT_WIDTH)
}

pub(crate) fn load_sidebar_wide_visible(config: &ConfigStore) -> bool {
    sidebar_wide_visible_from_collapsed(config.get_settings().ok().and_then(|settings| {
        settings
            .get(SIDEBAR_COLLAPSED_SETTINGS_KEY)
            .and_then(|value| value.as_bool())
    }))
}

fn sidebar_wide_visible_from_collapsed(collapsed: Option<bool>) -> bool {
    !collapsed.unwrap_or(false)
}

fn sidebar_collapsed_value(wide_visible: bool) -> bool {
    !wide_visible
}

pub(crate) fn persist_sidebar_width(config: Arc<ConfigStore>, width: f32, cx: &mut App) {
    let width = clamp_sidebar_width(width);
    let generation = next_generation(&SIDEBAR_WIDTH_GENERATION);
    cx.background_spawn(async move {
        let mut patch = serde_json::Map::new();
        patch.insert(SIDEBAR_WIDTH_SETTINGS_KEY.into(), serde_json::json!(width));
        if let Err(error) = config.set_settings(&patch, &|| {
            generation_is_current(&SIDEBAR_WIDTH_GENERATION, generation)
        }) {
            if generation_is_current(&SIDEBAR_WIDTH_GENERATION, generation) {
                tracing::warn!(%error, "failed to persist sidebar width");
            }
        }
    })
    .detach();
}

pub(crate) fn persist_sidebar_wide_visible(
    config: Arc<ConfigStore>,
    wide_visible: bool,
    cx: &mut App,
) {
    let generation = next_generation(&SIDEBAR_COLLAPSE_GENERATION);
    cx.background_spawn(async move {
        let mut patch = serde_json::Map::new();
        patch.insert(
            SIDEBAR_COLLAPSED_SETTINGS_KEY.into(),
            serde_json::Value::Bool(sidebar_collapsed_value(wide_visible)),
        );
        if let Err(error) = config.set_settings(&patch, &|| {
            generation_is_current(&SIDEBAR_COLLAPSE_GENERATION, generation)
        }) {
            if generation_is_current(&SIDEBAR_COLLAPSE_GENERATION, generation) {
                tracing::warn!(%error, "failed to persist sidebar collapse preference");
            }
        }
    })
    .detach();
}

fn next_generation(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
}

fn generation_is_current(counter: &AtomicU64, generation: u64) -> bool {
    counter.load(Ordering::Acquire) == generation
}

pub(crate) fn keyboard_resize_width(width: f32, key: &str, shift: bool) -> Option<f32> {
    let step = if shift { 40.0 } else { 16.0 };
    match key {
        "left" => Some(clamp_sidebar_width(width - step)),
        "right" => Some(clamp_sidebar_width(width + step)),
        "home" => Some(SIDEBAR_MIN_WIDTH),
        "end" => Some(SIDEBAR_MAX_WIDTH),
        _ => None,
    }
}

fn keyboard_activates(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum TimeBucket {
    Recent,
    Yesterday,
    Month { year: i32, month: u32 },
    Older,
}

impl TimeBucket {
    fn label(&self) -> String {
        match self {
            Self::Recent => "Recent".into(),
            Self::Yesterday => "Yesterday".into(),
            Self::Month { month, .. } => month_name(*month).into(),
            Self::Older => "Older".into(),
        }
    }

    fn rank(&self) -> (u8, i32, u32) {
        match self {
            Self::Recent => (0, 0, 0),
            Self::Yesterday => (1, 0, 0),
            Self::Month { year, month } => (2, -*year, 12 - *month),
            Self::Older => (3, 0, 0),
        }
    }
}

#[derive(Debug, Clone)]
struct ChatGroup {
    bucket: TimeBucket,
    chats: Vec<aiden_core::ChatMeta>,
}

fn month_name(month: u32) -> &'static str {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    MONTHS
        .get(month.saturating_sub(1) as usize)
        .copied()
        .unwrap_or("Older")
}

fn bucket_for(updated_at: u64, now: u64) -> TimeBucket {
    let timestamp = i64::try_from(updated_at).unwrap_or(i64::MAX);
    let now_timestamp = i64::try_from(now).unwrap_or(i64::MAX);
    let updated = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(Local::now);
    let current = Local
        .timestamp_millis_opt(now_timestamp)
        .single()
        .unwrap_or_else(Local::now);
    let age_days = current
        .date_naive()
        .signed_duration_since(updated.date_naive())
        .num_days();

    if age_days <= 0 {
        TimeBucket::Recent
    } else if age_days == 1 {
        TimeBucket::Yesterday
    } else if updated.year() == current.year() {
        TimeBucket::Month {
            year: updated.year(),
            month: updated.month(),
        }
    } else {
        TimeBucket::Older
    }
}

fn group_chats(mut chats: Vec<aiden_core::ChatMeta>, now: u64) -> Vec<ChatGroup> {
    chats.sort_by_key(|chat| Reverse(chat.updated_at));
    let mut groups = BTreeMap::<TimeBucket, Vec<aiden_core::ChatMeta>>::new();
    for chat in chats {
        groups
            .entry(bucket_for(chat.updated_at, now))
            .or_default()
            .push(chat);
    }
    let mut groups: Vec<_> = groups
        .into_iter()
        .map(|(bucket, chats)| ChatGroup { bucket, chats })
        .collect();
    groups.sort_by_key(|group| group.bucket.rank());
    groups
}

impl AppState {
    pub(crate) fn sidebar(&self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let translucent = cx
            .try_global::<crate::services::appearance::AidenAppearanceRuntime>()
            .is_some_and(|runtime| runtime.translucent_sidebar);
        v_flex()
            .id("sidebar")
            .size_full()
            .min_w(px(0.))
            .bg(if translucent {
                theme.sidebar.opacity(0.88)
            } else {
                theme.sidebar
            })
            .text_color(theme.sidebar_foreground)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .child(self.sidebar_search(cx))
            .child(self.sidebar_primary_actions(cx))
            .child(self.sidebar_workspace(cx))
            .child(self.sidebar_list(cx))
            .child(self.sidebar_footer(cx))
    }

    fn sidebar_search(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let input = Input::new(&self.search_input)
            .small()
            .appearance(false)
            .bordered(false)
            .focus_bordered(false);
        h_flex()
            .id("sidebar-search")
            .mx_3()
            .mb_3()
            .h(px(32.))
            .px_2()
            .gap_1p5()
            .items_center()
            .rounded_full()
            .bg(cx.theme().secondary)
            .child(
                Icon::new(IconName::Search)
                    .xsmall()
                    .text_color(cx.theme().muted_foreground),
            )
            .child(div().flex_1().min_w(px(0.)).child(input))
    }

    fn sidebar_primary_actions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("sidebar-primary-actions")
            .w_full()
            .px_2p5()
            .gap_0p5()
            .child(self.sidebar_destination(
                "sidebar-new-agent",
                "New Agent",
                IconName::Plus,
                (false, self.service.read(cx).workspace.is_none()),
                cx.listener(|this, _event, window, cx| {
                    this.new_chat_guarded(window, cx);
                    this.dismiss_compact_sidebar_for_navigation(window, cx);
                }),
                cx,
            ))
            .child(self.sidebar_destination(
                "sidebar-scheduled",
                "Scheduled",
                IconName::Calendar,
                (self.view == AppView::Scheduled, false),
                cx.listener(|this, _event, window, cx| {
                    this.navigate_view(AppView::Scheduled, window, cx);
                    this.dismiss_compact_sidebar_for_navigation(window, cx);
                }),
                cx,
            ))
    }

    fn sidebar_workspace(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let workspace = self.service.read(cx).workspace.clone();
        let label = workspace
            .as_ref()
            .map(|workspace| workspace.name.clone())
            .unwrap_or_else(|| "Workspace".into());
        let folder = workspace.is_some_and(|workspace| workspace.folder_path.is_some());
        h_flex()
            .id("sidebar-workspace")
            .mx_2p5()
            .mt_2()
            .mb_3()
            .h(px(40.))
            .px_2p5()
            .gap_2p5()
            .items_center()
            .rounded(px(11.))
            .when(
                crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .focusable()
            .hover(move |style| style.bg(theme.list_hover))
            .focus(move |style| style.bg(theme.list_active))
            .active(move |style| style.bg(theme.list_active))
            .on_click(cx.listener(|this, _event, window, cx| {
                this.workspace_state.update(cx, |state, cx| {
                    state.open_overlay(Overlay::Workspaces, window, cx);
                });
            }))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if keyboard_activates(&event.keystroke.key) {
                    this.workspace_state.update(cx, |state, cx| {
                        state.open_overlay(Overlay::Workspaces, window, cx);
                    });
                    cx.stop_propagation();
                }
            }))
            .child(
                Icon::new(if folder {
                    IconName::FolderOpen
                } else {
                    IconName::Folder
                })
                .small()
                .text_color(theme.muted_foreground),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .truncate()
                    .child(label),
            )
            .child(
                Icon::new(IconName::ChevronsUpDown)
                    .xsmall()
                    .text_color(theme.muted_foreground),
            )
    }

    fn sidebar_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let active_id = self.service.read(cx).active_chat_id.clone();
        let groups = group_chats(
            self.service
                .read(cx)
                .filtered_chats()
                .into_iter()
                .cloned()
                .collect(),
            aiden_data::now_millis(),
        );
        let empty = groups.is_empty();

        v_flex()
            .id("sidebar-list")
            .flex_1()
            .w_full()
            .min_h(px(0.))
            .px_2p5()
            .pb_3()
            .overflow_y_scroll()
            .when(empty, |el| {
                let searching = !self.search_input.read(cx).value().is_empty();
                el.child(
                    div()
                        .w_full()
                        .px_2p5()
                        .py_3()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(if searching {
                            "No matches"
                        } else {
                            "No chats yet"
                        }),
                )
            })
            .children(groups.into_iter().map(|group| {
                v_flex()
                    .w_full()
                    .mt_3()
                    .child(
                        div()
                            .mb_1()
                            .px_2p5()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child(group.bucket.label()),
                    )
                    .child(
                        v_flex()
                            .w_full()
                            .gap_0p5()
                            .children(group.chats.into_iter().map(|chat| {
                                let selected = active_id.as_deref() == Some(chat.id.as_str());
                                self.sidebar_chat_row(chat, selected, cx)
                            })),
                    )
            }))
    }

    fn sidebar_chat_row(
        &self,
        meta: aiden_core::ChatMeta,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let id = meta.id;
        let click_id = id.clone();
        let delete_id = id.clone();
        h_flex()
            .id(ElementId::Name(SharedString::from(format!("chat-{id}"))))
            .w_full()
            .min_h(px(36.))
            .px_2p5()
            .py_1p5()
            .gap_2()
            .items_center()
            .rounded(px(11.))
            .when(
                crate::services::appearance::pointer_cursors_enabled(cx),
                |el| el.cursor_pointer(),
            )
            .focusable()
            .bg(if selected {
                theme.list_active
            } else {
                theme.sidebar
            })
            .text_color(theme.sidebar_foreground)
            .hover(move |style| {
                if selected {
                    style.bg(theme.list_active)
                } else {
                    style.bg(theme.list_hover)
                }
            })
            .focus(move |style| style.bg(theme.list_active))
            .active(move |style| style.bg(theme.list_active))
            .on_click(cx.listener(move |this, _event, _window, cx| {
                this.navigate_chat(click_id.clone(), _window, cx);
                if this.sidebar_visibility.compact {
                    this.dismiss_compact_sidebar_for_navigation(_window, cx);
                }
            }))
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    if keyboard_activates(&event.keystroke.key) {
                        this.navigate_chat(id.clone(), window, cx);
                        if this.sidebar_visibility.compact {
                            this.dismiss_compact_sidebar_for_navigation(window, cx);
                        }
                        cx.stop_propagation();
                    }
                }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .text_sm()
                    .truncate()
                    .child(meta.title),
            )
            .when(selected, |el| {
                el.child(
                    Button::new(ElementId::Name(SharedString::from(format!(
                        "delete-chat-{delete_id}"
                    ))))
                    .ghost()
                    .xsmall()
                    .icon(IconName::Delete)
                    .tooltip("Delete chat")
                    .on_click(cx.listener(
                        move |this, _event, window, cx| {
                            cx.stop_propagation();
                            this.delete_chat_guarded(delete_id.clone(), window, cx);
                        },
                    )),
                )
            })
    }

    fn sidebar_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("sidebar-footer")
            .w_full()
            .px_2p5()
            .pb_2()
            .pt_1()
            .gap_0p5()
            .child(self.sidebar_destination(
                "sidebar-profile",
                "Profile",
                IconName::User,
                (self.view == AppView::Usage, false),
                cx.listener(|this, _event, window, cx| {
                    this.navigate_view(AppView::Usage, window, cx);
                    this.dismiss_compact_sidebar_for_navigation(window, cx);
                }),
                cx,
            ))
            .child(self.sidebar_destination(
                "sidebar-settings",
                "Settings",
                IconName::Settings,
                (self.view == AppView::Settings, false),
                cx.listener(|this, _event, window, cx| {
                    this.navigate_view(AppView::Settings, window, cx);
                    this.dismiss_compact_sidebar_for_navigation(window, cx);
                }),
                cx,
            ))
    }

    fn sidebar_destination(
        &self,
        id: &'static str,
        label: &'static str,
        icon: IconName,
        state: (bool, bool),
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme();
        let (selected, disabled) = state;
        let on_click = Rc::new(on_click);
        h_flex()
            .id(id)
            .w_full()
            .min_h(px(36.))
            .px_2p5()
            .py_1p5()
            .gap_2p5()
            .items_center()
            .rounded(px(11.))
            .when(!disabled, |el| {
                el.when(
                    crate::services::appearance::pointer_cursors_enabled(cx),
                    |el| el.cursor_pointer(),
                )
                .focusable()
            })
            .when(id == "sidebar-settings", |el| {
                el.track_focus(&self.sidebar_last_focus)
            })
            .when(disabled, |el| el.opacity(0.45))
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
            .when(!disabled, |el| {
                let click = on_click.clone();
                let key = on_click.clone();
                el.on_click(move |event, window, cx| click(event, window, cx))
                    .on_key_down(move |event, window, cx| {
                        if keyboard_activates(&event.keystroke.key) {
                            key(&gpui::ClickEvent::default(), window, cx);
                            cx.stop_propagation();
                        }
                    })
            })
            .child(Icon::new(icon).small().text_color(theme.muted_foreground))
            .child(div().min_w(px(0.)).text_sm().truncate().child(label))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{LocalResult, NaiveDate, NaiveDateTime};

    fn local_millis(year: i32, month: u32, day: u32, hour: u32) -> u64 {
        let local = NaiveDate::from_ymd_opt(year, month, day)
            .and_then(|date| date.and_hms_opt(hour, 0, 0))
            .expect("valid fixture date");
        let timestamp = match Local.from_local_datetime(&local) {
            LocalResult::Single(timestamp) => timestamp,
            LocalResult::Ambiguous(first, _) => first,
            LocalResult::None => {
                Local.from_utc_datetime(&NaiveDateTime::new(local.date(), local.time()))
            }
        };
        timestamp.timestamp_millis() as u64
    }

    fn chat(id: &str, updated_at: u64) -> aiden_core::ChatMeta {
        aiden_core::ChatMeta {
            id: id.into(),
            title: id.into(),
            workspace_id: None,
            provider_id: None,
            model: None,
            created_at: updated_at,
            updated_at,
        }
    }

    #[test]
    fn sidebar_width_clamps_and_rejects_non_finite_values() {
        assert_eq!(clamp_sidebar_width(120.0), SIDEBAR_MIN_WIDTH);
        assert_eq!(clamp_sidebar_width(300.0), 300.0);
        assert_eq!(clamp_sidebar_width(500.0), SIDEBAR_MAX_WIDTH);
        assert_eq!(clamp_sidebar_width(f32::NAN), SIDEBAR_DEFAULT_WIDTH);
    }

    #[test]
    fn compact_breakpoint_and_overlay_width_preserve_safe_content_margin() {
        assert!(is_compact_sidebar_width(699.0));
        assert!(!is_compact_sidebar_width(700.0));
        assert_eq!(sidebar_overlay_width(300.0, 280.0), 224.0);
        assert_eq!(sidebar_overlay_width(400.0, 900.0), SIDEBAR_MAX_WIDTH);
    }

    #[test]
    fn compact_overlay_does_not_overwrite_wide_screen_preference() {
        let collapsed = SidebarVisibility::new(false, false);
        let compact = collapsed.transition(SidebarVisibilityEvent::WindowCompact(true));
        assert!(!compact.visible());
        let open = compact.transition(SidebarVisibilityEvent::Toggle);
        assert!(open.visible());
        let dismissed = open.transition(SidebarVisibilityEvent::DismissCompact);
        assert!(!dismissed.visible());
        let wide_again = dismissed.transition(SidebarVisibilityEvent::WindowCompact(false));
        assert!(!wide_again.visible());
        assert!(!wide_again.wide_visible);
    }

    #[test]
    fn wide_toggle_changes_only_the_persisted_preference() {
        let open = SidebarVisibility::new(true, false);
        let collapsed = open.transition(SidebarVisibilityEvent::Toggle);
        assert!(!collapsed.wide_visible);
        assert!(!collapsed.compact);
        assert!(!collapsed.compact_open);
        assert!(sidebar_collapsed_value(collapsed.wide_visible));
    }

    #[test]
    fn collapse_setting_round_trips_and_defaults_open() {
        assert!(sidebar_wide_visible_from_collapsed(None));
        for wide_visible in [false, true] {
            let stored = sidebar_collapsed_value(wide_visible);
            assert_eq!(
                sidebar_wide_visible_from_collapsed(Some(stored)),
                wide_visible
            );
        }
    }

    #[test]
    fn keyboard_resize_uses_canonical_steps_and_bounds() {
        assert_eq!(keyboard_resize_width(272.0, "left", false), Some(256.0));
        assert_eq!(keyboard_resize_width(272.0, "right", true), Some(312.0));
        assert_eq!(keyboard_resize_width(272.0, "home", false), Some(236.0));
        assert_eq!(keyboard_resize_width(272.0, "end", false), Some(340.0));
        assert_eq!(keyboard_resize_width(272.0, "escape", false), None);
    }

    #[test]
    fn keyboard_activation_accepts_enter_and_space_only() {
        assert!(keyboard_activates("enter"));
        assert!(keyboard_activates("space"));
        assert!(!keyboard_activates("tab"));
    }

    #[test]
    fn persistence_generation_accepts_only_the_latest_write() {
        let generation = AtomicU64::new(0);
        let first = next_generation(&generation);
        assert!(generation_is_current(&generation, first));
        let second = next_generation(&generation);
        assert!(!generation_is_current(&generation, first));
        assert!(generation_is_current(&generation, second));
    }

    #[test]
    fn chats_group_in_canonical_time_order_with_newest_rows_first() {
        let now = local_millis(2026, 8, 10, 12);
        let groups = group_chats(
            vec![
                chat("older", local_millis(2025, 12, 31, 12)),
                chat("july", local_millis(2026, 7, 2, 12)),
                chat("yesterday", local_millis(2026, 8, 9, 9)),
                chat("recent-old", local_millis(2026, 8, 10, 8)),
                chat("recent-new", local_millis(2026, 8, 10, 11)),
            ],
            now,
        );
        let labels: Vec<_> = groups.iter().map(|group| group.bucket.label()).collect();
        assert_eq!(labels, ["Recent", "Yesterday", "July", "Older"]);
        let recent_ids: Vec<_> = groups[0]
            .chats
            .iter()
            .map(|chat| chat.id.as_str())
            .collect();
        assert_eq!(recent_ids, ["recent-new", "recent-old"]);
    }
}

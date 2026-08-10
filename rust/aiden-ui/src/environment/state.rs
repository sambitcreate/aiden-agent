use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aiden_data::config_store::ConfigStore;
use gpui::{App, AppContext as _, Context, FocusHandle, Window};
use gpui_component::resizable::ResizableState;

use super::layout::{clamp_panel_width, DEFAULT_PANEL_WIDTH};

const OPEN_SETTINGS_KEY: &str = "aiden-agent.environment.open";
const TAB_SETTINGS_KEY: &str = "aiden-agent.environment.tab";
const WIDTH_SETTINGS_KEY: &str = "aiden-agent.environment.width";

static OPEN_WRITE_GENERATION: AtomicU64 = AtomicU64::new(0);
static TAB_WRITE_GENERATION: AtomicU64 = AtomicU64::new(0);
static WIDTH_WRITE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnvironmentTab {
    #[default]
    Overview,
    Review,
    Files,
}

impl EnvironmentTab {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Review => "review",
            Self::Files => "files",
        }
    }

    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("review") => Self::Review,
            Some("files") => Self::Files,
            _ => Self::Overview,
        }
    }
}

pub struct EnvironmentWorkbench {
    config: Arc<ConfigStore>,
    pub open: bool,
    pub tab: EnvironmentTab,
    pub preferred_width: f32,
    pub return_focus: Option<FocusHandle>,
    pub first_focus: FocusHandle,
    pub last_focus: FocusHandle,
    pub active_tab_focus: FocusHandle,
    pub summary_focus: FocusHandle,
    pub summary_scope: FocusHandle,
    pub panel_scope: FocusHandle,
    pub resizable: gpui::Entity<ResizableState>,
}

pub fn should_focus_overlay_transition(
    was_overlay: bool,
    is_overlay: bool,
    focus_inside_panel: bool,
) -> bool {
    is_overlay && !was_overlay && !focus_inside_panel
}

pub fn should_focus_summary_transition(
    was_summary: bool,
    is_summary: bool,
    focus_inside_summary: bool,
) -> bool {
    is_summary && !was_summary && !focus_inside_summary
}

impl EnvironmentWorkbench {
    pub fn new(config: Arc<ConfigStore>, cx: &mut Context<Self>) -> Self {
        let settings = config.get_settings().unwrap_or_default();
        let open = settings
            .get(OPEN_SETTINGS_KEY)
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let tab = EnvironmentTab::parse(
            settings
                .get(TAB_SETTINGS_KEY)
                .and_then(|value| value.as_str()),
        );
        let preferred_width = settings
            .get(WIDTH_SETTINGS_KEY)
            .and_then(|value| value.as_f64())
            .map(|value| clamp_panel_width(value as f32, f32::MAX))
            .unwrap_or(DEFAULT_PANEL_WIDTH);
        Self {
            config,
            open,
            tab,
            preferred_width,
            return_focus: None,
            first_focus: cx.focus_handle().tab_stop(true),
            last_focus: cx.focus_handle().tab_stop(true),
            active_tab_focus: cx.focus_handle().tab_stop(true),
            summary_focus: cx.focus_handle().tab_stop(true),
            summary_scope: cx.focus_handle(),
            panel_scope: cx.focus_handle(),
            resizable: cx.new(|_| ResizableState::default()),
        }
    }

    pub fn full_open(&self) -> bool {
        self.open && self.tab != EnvironmentTab::Overview
    }

    pub fn show(&mut self, tab: EnvironmentTab, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            self.return_focus = window.focused(cx);
        }
        self.open = true;
        self.tab = tab;
        persist_bool(
            self.config.clone(),
            OPEN_SETTINGS_KEY,
            true,
            &OPEN_WRITE_GENERATION,
            cx,
        );
        persist_string(
            self.config.clone(),
            TAB_SETTINGS_KEY,
            tab.as_str(),
            &TAB_WRITE_GENERATION,
            cx,
        );
        let target = if tab == EnvironmentTab::Overview {
            self.summary_focus.clone()
        } else {
            self.active_tab_focus.clone()
        };
        cx.defer_in(window, move |_this, window, _cx| target.focus(window));
        cx.notify();
    }

    pub fn toggle(&mut self, window: &mut Window, fallback: &FocusHandle, cx: &mut Context<Self>) {
        if self.open {
            self.close(window, fallback, cx);
        } else {
            self.show(self.tab, window, cx);
        }
    }

    pub fn close(&mut self, window: &mut Window, fallback: &FocusHandle, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        persist_bool(
            self.config.clone(),
            OPEN_SETTINGS_KEY,
            false,
            &OPEN_WRITE_GENERATION,
            cx,
        );
        self.return_focus
            .take()
            .unwrap_or_else(|| fallback.clone())
            .focus(window);
        cx.notify();
    }

    pub fn close_to_fallback(
        &mut self,
        window: &mut Window,
        fallback: &FocusHandle,
        cx: &mut Context<Self>,
    ) {
        if !self.open {
            return;
        }
        self.open = false;
        self.return_focus = None;
        persist_bool(
            self.config.clone(),
            OPEN_SETTINGS_KEY,
            false,
            &OPEN_WRITE_GENERATION,
            cx,
        );
        fallback.focus(window);
        cx.notify();
    }

    pub fn set_width(&mut self, width: f32, container_width: f32, cx: &mut Context<Self>) {
        self.commit_width(width, container_width, true, cx);
    }

    pub fn accept_resized_width(
        &mut self,
        width: f32,
        container_width: f32,
        cx: &mut Context<Self>,
    ) {
        self.commit_width(width, container_width, false, cx);
    }

    pub fn preview_resized_width(
        &mut self,
        width: f32,
        container_width: f32,
        cx: &mut Context<Self>,
    ) {
        self.preferred_width = clamp_panel_width(width, container_width);
        cx.notify();
    }

    pub fn persist_resized_width(&mut self, cx: &mut Context<Self>) {
        persist_number(
            self.config.clone(),
            WIDTH_SETTINGS_KEY,
            self.preferred_width,
            &WIDTH_WRITE_GENERATION,
            cx,
        );
    }

    fn commit_width(
        &mut self,
        width: f32,
        container_width: f32,
        reset_resizable: bool,
        cx: &mut Context<Self>,
    ) {
        self.preferred_width = clamp_panel_width(width, container_width);
        if reset_resizable {
            self.resizable = cx.new(|_| ResizableState::default());
        }
        persist_number(
            self.config.clone(),
            WIDTH_SETTINGS_KEY,
            self.preferred_width,
            &WIDTH_WRITE_GENERATION,
            cx,
        );
        cx.notify();
    }
}

pub fn roving_tab_from_key(current: EnvironmentTab, key: &str) -> Option<EnvironmentTab> {
    match (current, key) {
        (_, "home") => Some(EnvironmentTab::Review),
        (_, "end") => Some(EnvironmentTab::Files),
        (EnvironmentTab::Review, "left") | (EnvironmentTab::Review, "right") => {
            Some(EnvironmentTab::Files)
        }
        (EnvironmentTab::Files, "left") | (EnvironmentTab::Files, "right") => {
            Some(EnvironmentTab::Review)
        }
        _ => None,
    }
}

fn next_generation(counter: &AtomicU64) -> u64 {
    counter.fetch_add(1, Ordering::SeqCst) + 1
}

fn persist_value(
    config: Arc<ConfigStore>,
    key: &'static str,
    value: serde_json::Value,
    counter: &'static AtomicU64,
    cx: &mut App,
) {
    let generation = next_generation(counter);
    cx.background_spawn(async move {
        let mut patch = serde_json::Map::new();
        patch.insert(key.into(), value);
        let current = || counter.load(Ordering::SeqCst) == generation;
        if let Err(error) = config.set_settings(&patch, &current) {
            if current() {
                tracing::warn!(%error, key, "failed to persist environment preference");
            }
        }
    })
    .detach();
}

fn persist_bool(
    config: Arc<ConfigStore>,
    key: &'static str,
    value: bool,
    counter: &'static AtomicU64,
    cx: &mut App,
) {
    persist_value(config, key, serde_json::Value::Bool(value), counter, cx);
}

fn persist_string(
    config: Arc<ConfigStore>,
    key: &'static str,
    value: &'static str,
    counter: &'static AtomicU64,
    cx: &mut App,
) {
    persist_value(
        config,
        key,
        serde_json::Value::String(value.into()),
        counter,
        cx,
    );
}

fn persist_number(
    config: Arc<ConfigStore>,
    key: &'static str,
    value: f32,
    counter: &'static AtomicU64,
    cx: &mut App,
) {
    persist_value(config, key, serde_json::json!(value), counter, cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_values_round_trip_and_invalid_values_fall_back() {
        for tab in [
            EnvironmentTab::Overview,
            EnvironmentTab::Review,
            EnvironmentTab::Files,
        ] {
            assert_eq!(EnvironmentTab::parse(Some(tab.as_str())), tab);
        }
        assert_eq!(
            EnvironmentTab::parse(Some("subagents")),
            EnvironmentTab::Overview
        );
    }

    #[test]
    fn ordered_writer_accepts_only_the_latest_generation() {
        let counter = AtomicU64::new(0);
        let first = next_generation(&counter);
        let second = next_generation(&counter);
        assert_ne!(counter.load(Ordering::SeqCst), first);
        assert_eq!(counter.load(Ordering::SeqCst), second);
    }

    #[test]
    fn overlay_transition_focuses_only_when_crossing_modal_boundary_from_outside() {
        assert!(should_focus_overlay_transition(false, true, false));
        assert!(!should_focus_overlay_transition(false, true, true));
        assert!(!should_focus_overlay_transition(true, true, false));
        assert!(!should_focus_overlay_transition(true, false, false));
    }

    #[test]
    fn summary_transition_focuses_only_when_newly_opened_from_outside() {
        assert!(should_focus_summary_transition(false, true, false));
        assert!(!should_focus_summary_transition(false, true, true));
        assert!(!should_focus_summary_transition(true, true, false));
        assert!(!should_focus_summary_transition(true, false, false));
    }

    #[test]
    fn review_and_files_tabs_use_roving_arrow_home_end_navigation() {
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Review, "right"),
            Some(EnvironmentTab::Files)
        );
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Files, "left"),
            Some(EnvironmentTab::Review)
        );
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Files, "home"),
            Some(EnvironmentTab::Review)
        );
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Review, "end"),
            Some(EnvironmentTab::Files)
        );
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Review, "left"),
            Some(EnvironmentTab::Files)
        );
        assert_eq!(
            roving_tab_from_key(EnvironmentTab::Files, "right"),
            Some(EnvironmentTab::Review)
        );
        assert_eq!(roving_tab_from_key(EnvironmentTab::Review, "up"), None);
    }
}

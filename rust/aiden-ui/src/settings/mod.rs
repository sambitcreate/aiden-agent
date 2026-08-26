//! Settings surface (port of `renderer/components/settings/*`).
//!
//! A single [`SettingsView`] entity renders a left navigation column and the
//! active section's content. Every section talks to the durable stores through
//! [`SettingsServices`] (Arc handles constructed by the orchestrator from
//! `services::stores::Stores`) and runs all store/keychain I/O on the
//! background executor, mirroring the chat service patterns. Pure form logic
//! (cron humanize, shortcut capture encoding, env-line parsing) lives in each
//! section module with unit tests.
//!
//! Section state lives in per-section modules (`providers`, `skills`, `appearance`,
//! `shortcuts`, `mcp`, `scheduled`, `about`), each implementing render helpers
//! on `SettingsView`, so this file stays a thin shell + router.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use aiden_data::config_store::ConfigStore;
use aiden_data::schedule_store::{DataStorePersistence, ScheduleStore};
use aiden_data::secret_map::ProviderKeysStore;
use aiden_mcp::client::McpClientManager;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, ElementId, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable as _};

mod about;
mod appearance;
mod codex_auth;
mod mcp;
mod providers;
mod scheduled;
mod shortcuts;
mod skills;
mod web_search;

/// The left-nav sections, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsSection {
    Providers,
    Skills,
    WebSearch,
    Appearance,
    Shortcuts,
    Mcp,
    ScheduledTasks,
    About,
}

impl SettingsSection {
    pub const ALL: &'static [SettingsSection] = &[
        SettingsSection::Providers,
        SettingsSection::Skills,
        SettingsSection::WebSearch,
        SettingsSection::Mcp,
        SettingsSection::ScheduledTasks,
        SettingsSection::Shortcuts,
        SettingsSection::Appearance,
        SettingsSection::About,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SettingsSection::Providers => "Providers",
            SettingsSection::Skills => "Skills",
            SettingsSection::WebSearch => "Web Search",
            SettingsSection::Appearance => "Appearance",
            SettingsSection::Shortcuts => "Keyboard shortcuts",
            SettingsSection::Mcp => "MCP servers",
            SettingsSection::ScheduledTasks => "Scheduled tasks",
            SettingsSection::About => "About",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            SettingsSection::Providers => IconName::Globe,
            SettingsSection::Skills => IconName::Bot,
            SettingsSection::WebSearch => IconName::Globe,
            SettingsSection::Appearance => IconName::Palette,
            SettingsSection::Shortcuts => IconName::Check,
            SettingsSection::Mcp => IconName::SquareTerminal,
            SettingsSection::ScheduledTasks => IconName::Calendar,
            SettingsSection::About => IconName::Info,
        }
    }
}

fn should_hide_codex_auth_for_section_change(
    from: SettingsSection,
    to: SettingsSection,
) -> bool {
    from == SettingsSection::Providers && to != SettingsSection::Providers
}

/// Everything the settings surface needs from the data layer. The orchestrator
/// constructs this (convenience constructor: [`SettingsServices::from_stores`])
/// and passes it to [`SettingsView::new`].
#[derive(Clone)]
pub struct SettingsServices {
    pub config: Arc<ConfigStore>,
    pub keys: Arc<ProviderKeysStore>,
    pub schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    pub mcp: Arc<McpClientManager>,
    /// Coordinates Web Search config/key reads with mutations. This lock is
    /// only acquired from background tasks.
    pub web_search_state: Arc<Mutex<()>>,
    /// The portable config directory (`~/.aiden`), for the About section.
    pub config_dir: PathBuf,
}

impl SettingsServices {
    /// Build the services from the app's durable stores. The schedule store is
    /// shared with the scheduled-tasks panel (both surfaces list the same
    /// task records), and the MCP manager is fresh per settings surface.
    pub fn from_stores(stores: &crate::services::stores::Stores) -> Self {
        let config_dir = aiden_data::aiden_config_dir()
            .unwrap_or_else(|_| aiden_data::home_dir().join(".aiden"));
        Self {
            config: stores.config.clone(),
            keys: stores.keys.clone(),
            schedules: stores.schedules.clone(),
            mcp: Arc::new(McpClientManager::new()),
            web_search_state: stores.web_search_state.clone(),
            config_dir,
        }
    }
}

/// Read the portable enable bit and machine-local credential as one
/// application-level capability snapshot. A copied config can contain an
/// enabled bit without its device key; repair that state fail-closed so adding
/// a key later still requires an explicit enable action.
fn reconcile_web_search_state(
    services: &SettingsServices,
    settings: &mut serde_json::Map<String, serde_json::Value>,
) -> bool {
    let _guard = services
        .web_search_state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *settings = services.config.get_settings().unwrap_or_default();
    let has_key = services
        .keys
        .get(aiden_providers::web_search::EXA_KEY_ID)
        .ok()
        .flatten()
        .is_some();
    let enabled = settings
        .get("exaEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if enabled && !has_key {
        let mut patch = serde_json::Map::new();
        patch.insert("exaEnabled".to_string(), serde_json::Value::Bool(false));
        if services.config.set_settings(&patch, &|| true).is_ok() {
            settings.insert("exaEnabled".to_string(), serde_json::Value::Bool(false));
        }
    }
    has_key
}

/// The settings window entity: left nav + active section content.
pub struct SettingsView {
    services: SettingsServices,
    active: SettingsSection,
    booted: bool,
    refresh_generation: u64,
    pub(crate) error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,

    pub(crate) providers: providers::ProvidersState,
    pub(crate) codex_auth: codex_auth::CodexAuthSettingsState,
    pub(crate) skills: skills::SkillsState,
    pub(crate) web_search: web_search::WebSearchState,
    pub(crate) appearance: appearance::AppearanceState,
    pub(crate) shortcuts: shortcuts::ShortcutsState,
    pub(crate) mcp: mcp::McpState,
    pub(crate) scheduled: scheduled::ScheduledState,
}

impl SettingsView {
    pub fn new(cx: &mut Context<Self>, services: SettingsServices) -> Self {
        let mut this = Self {
            services,
            active: SettingsSection::Providers,
            booted: false,
            refresh_generation: 0,
            error: None,
            _subscriptions: Vec::new(),
            providers: providers::ProvidersState::default(),
            codex_auth: codex_auth::CodexAuthSettingsState::default(),
            skills: skills::SkillsState::default(),
            web_search: web_search::WebSearchState::default(),
            appearance: appearance::AppearanceState::default(),
            shortcuts: shortcuts::ShortcutsState::default(),
            mcp: mcp::McpState::default(),
            scheduled: scheduled::ScheduledState::default(),
        };
        let codex_service = cx
            .global::<crate::services::codex_auth::GlobalCodexAuthService>()
            .0
            .clone();
        this.codex_auth.initialize(cx);
        this.codex_auth.sync(codex_service.read(cx).ui_snapshot());
        this._subscriptions
            .push(cx.observe(&codex_service, |this, service, cx| {
                this.sync_codex_auth(service.read(cx).ui_snapshot(), cx);
            }));
        codex_service.update(cx, |service, cx| service.refresh_status(cx));
        this.boot(cx);
        this
    }

    /// Load every section's durable state on the background executor.
    pub fn boot(&mut self, cx: &mut Context<Self>) {
        if self.booted {
            return;
        }
        self.booted = true;
        self.refresh_generation = self.refresh_generation.wrapping_add(1);
        let refresh_generation = self.refresh_generation;
        let web_search_revision = self.web_search.revision();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_spawn(async move {
                    let mut providers = services
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(providers::ProviderRow::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    providers.retain(|provider| {
                        provider.id != aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID
                    });
                    let mut settings = services.config.get_settings().unwrap_or_default();
                    let schedules = services
                        .schedules
                        .list()
                        .map(|list| {
                            list.iter()
                                .map(scheduled::ScheduleRow::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mcp_servers = services
                        .config
                        .list_mcp_servers()
                        .unwrap_or_default()
                        .iter()
                        .map(mcp::McpServerRow::from)
                        .collect::<Vec<_>>();
                    let workspaces = services
                        .config
                        .list_workspaces()
                        .map(|list| {
                            list.into_iter()
                                .map(|workspace| (workspace.id, workspace.name))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let skills = services.config.list_skills().unwrap_or_default();
                    let exa_has_key = reconcile_web_search_state(&services, &mut settings);
                    (
                        providers,
                        settings,
                        schedules,
                        mcp_servers,
                        workspaces,
                        skills,
                        exa_has_key,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                if this.refresh_generation != refresh_generation {
                    return;
                }
                let (providers, settings, schedules, mcp_servers, workspaces, skills, exa_has_key) =
                    snapshot;
                let exa_enabled = settings
                    .get("exaEnabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                this.providers.providers = providers;
                this.providers.settings = settings;
                this.scheduled.schedules = schedules;
                this.scheduled.workspaces = workspaces;
                this.mcp.servers = mcp_servers;
                this.skills.items = skills;
                this.web_search
                    .hydrate(exa_enabled, exa_has_key, web_search_revision);
                this.skills.finish_reload();
                let settings = this.providers.settings.clone();
                this.appearance.hydrate(&settings, cx);
                this.shortcuts.hydrate(&this.providers.settings);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Route the settings surface to a section (the shell calls this when the
    /// palette or the sidebar gear opens settings).
    pub(crate) fn select_section(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        if should_hide_codex_auth_for_section_change(self.active, section) {
            self.hide_codex_auth(cx);
        }
        self.active = section;
        self.error = None;
        if section == SettingsSection::Skills && self.skills.begin_reload() {
            self.refresh(cx);
            self.refresh_discovered_skills(cx);
        } else if section == SettingsSection::WebSearch {
            self.refresh(cx);
        } else if section == SettingsSection::Providers {
            self.refresh_codex_auth(cx);
        }
        cx.notify();
    }
    /// Refresh the provider + settings snapshots after a mutation (all section
    /// mutations run on the background and then call this).
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.refresh_generation = self.refresh_generation.wrapping_add(1);
        let refresh_generation = self.refresh_generation;
        let web_search_revision = self.web_search.revision();
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_spawn(async move {
                    let mut providers = services
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(providers::ProviderRow::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    providers.retain(|provider| {
                        provider.id != aiden_providers::codex::OPENAI_CODEX_PROVIDER_ID
                    });
                    let mut settings = services.config.get_settings().unwrap_or_default();
                    let schedules = services
                        .schedules
                        .list()
                        .map(|list| {
                            list.iter()
                                .map(scheduled::ScheduleRow::from)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mcp_servers = services
                        .config
                        .list_mcp_servers()
                        .unwrap_or_default()
                        .iter()
                        .map(mcp::McpServerRow::from)
                        .collect::<Vec<_>>();
                    let workspaces = services
                        .config
                        .list_workspaces()
                        .map(|list| {
                            list.into_iter()
                                .map(|workspace| (workspace.id, workspace.name))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let skills = services.config.list_skills().unwrap_or_default();
                    let exa_has_key = reconcile_web_search_state(&services, &mut settings);
                    (
                        providers,
                        settings,
                        schedules,
                        mcp_servers,
                        workspaces,
                        skills,
                        exa_has_key,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                if this.refresh_generation != refresh_generation {
                    return;
                }
                let (providers, settings, schedules, mcp_servers, workspaces, skills, exa_has_key) =
                    snapshot;
                let exa_enabled = settings
                    .get("exaEnabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                this.providers.providers = providers;
                this.providers.settings = settings;
                this.scheduled.schedules = schedules;
                this.scheduled.workspaces = workspaces;
                this.mcp.servers = mcp_servers;
                this.skills.items = skills;
                this.web_search
                    .hydrate(exa_enabled, exa_has_key, web_search_revision);
                this.skills.finish_reload();
                let settings = this.providers.settings.clone();
                this.appearance.hydrate(&settings, cx);
                this.shortcuts.hydrate(&this.providers.settings);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        v_flex()
            .id("settings-view")
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(
                h_flex()
                    .id("settings-body")
                    .flex_1()
                    .size_full()
                    .child(self.sidebar(window, cx))
                    .child(self.content(window, cx)),
            )
    }
}

impl SettingsView {
    /// Left navigation column.
    fn sidebar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let active = self.active;
        v_flex()
            .id("settings-nav")
            .w(gpui::px(210.))
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .py_3()
            .px_2()
            .gap_0p5()
            .child(
                div()
                    .px_3()
                    .pb_2()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.muted_foreground)
                    .child("Settings"),
            )
            .children(SettingsSection::ALL.iter().map(|section| {
                let selected = *section == active;
                let (bg, fg) = if selected {
                    (theme.sidebar_accent, theme.sidebar_accent_foreground)
                } else {
                    (theme.sidebar, theme.sidebar_foreground)
                };
                let section_id = *section;
                let label = section.label();
                let icon = section.icon();
                let focus = window
                    .use_keyed_state(("settings-nav", label), cx, |_, cx| cx.focus_handle())
                    .read(cx)
                    .clone();
                h_flex()
                    .id(ElementId::Name(SharedString::from(format!(
                        "settings-nav-{}",
                        label.to_ascii_lowercase().replace(' ', "-")
                    ))))
                    .w_full()
                    .px_2()
                    .py_1p5()
                    .gap_2()
                    .items_center()
                    .rounded_md()
                    .cursor_pointer()
                    .track_focus(&focus)
                    .tab_index(0)
                    .bg(bg)
                    .text_color(fg)
                    .hover(move |style| {
                        if !selected {
                            style.bg(theme.sidebar_primary)
                        } else {
                            style
                        }
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_section(section_id, cx);
                    }))
                    .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space" | " ") {
                            this.select_section(section_id, cx);
                            cx.stop_propagation();
                        }
                    }))
                    .child(Icon::new(icon).small().text_color(fg))
                    .child(div().text_sm().truncate().child(label))
            }))
    }

    /// Active section content (scrollable right column).
    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let inner = match self.active {
            SettingsSection::Providers => self.providers_section(window, cx).into_any_element(),
            SettingsSection::Skills => self.skills_section(window, cx).into_any_element(),
            SettingsSection::WebSearch => self.web_search_section(window, cx).into_any_element(),
            SettingsSection::Appearance => self.appearance_section(window, cx).into_any_element(),
            SettingsSection::Shortcuts => self.shortcuts_section(window, cx).into_any_element(),
            SettingsSection::Mcp => self.mcp_section(window, cx).into_any_element(),
            SettingsSection::ScheduledTasks => {
                self.scheduled_section(window, cx).into_any_element()
            }
            SettingsSection::About => self.about_section(window, cx).into_any_element(),
        };
        let theme = cx.theme();
        v_flex()
            .id("settings-content")
            .flex_1()
            .h_full()
            .min_w(gpui::px(0.))
            .overflow_y_scroll()
            .child(div().w_full().px_6().py_5().child(inner))
            .when_some(self.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .px_4()
                        .py_2()
                        .text_sm()
                        .text_color(theme.danger)
                        .child(message),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_section_has_a_unique_label_and_icon() {
        let labels: std::collections::HashSet<_> = SettingsSection::ALL
            .iter()
            .map(|section| section.label())
            .collect();
        assert_eq!(labels.len(), SettingsSection::ALL.len());
        for section in SettingsSection::ALL {
            assert!(!section.label().is_empty());
        }
    }

    #[test]
    fn leaving_providers_hides_auth_once_but_reselecting_does_not() {
        assert!(should_hide_codex_auth_for_section_change(
            SettingsSection::Providers,
            SettingsSection::Skills
        ));
        assert!(!should_hide_codex_auth_for_section_change(
            SettingsSection::Providers,
            SettingsSection::Providers
        ));
        assert!(!should_hide_codex_auth_for_section_change(
            SettingsSection::Skills,
            SettingsSection::About
        ));
    }
}

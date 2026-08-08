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
//! Section state lives in per-section modules (`providers`, `appearance`,
//! `shortcuts`, `mcp`, `scheduled`, `about`), each implementing render helpers
//! on `SettingsView`, so this file stays a thin shell + router.

use std::path::PathBuf;
use std::sync::Arc;

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
mod mcp;
mod providers;
mod scheduled;
mod shortcuts;

use providers::enrich_provider_row;

/// The left-nav sections, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsSection {
    Providers,
    Appearance,
    Shortcuts,
    Mcp,
    ScheduledTasks,
    About,
}

impl SettingsSection {
    pub const ALL: &'static [SettingsSection] = &[
        SettingsSection::Providers,
        SettingsSection::Appearance,
        SettingsSection::Shortcuts,
        SettingsSection::Mcp,
        SettingsSection::ScheduledTasks,
        SettingsSection::About,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SettingsSection::Providers => "Providers",
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
            SettingsSection::Appearance => IconName::Palette,
            SettingsSection::Shortcuts => IconName::Check,
            SettingsSection::Mcp => IconName::SquareTerminal,
            SettingsSection::ScheduledTasks => IconName::Calendar,
            SettingsSection::About => IconName::Info,
        }
    }
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
            config_dir,
        }
    }
}

/// The settings window entity: left nav + active section content.
pub struct SettingsView {
    services: SettingsServices,
    active: SettingsSection,
    booted: bool,
    pub(crate) error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,

    pub(crate) providers: providers::ProvidersState,
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
            error: None,
            _subscriptions: Vec::new(),
            providers: providers::ProvidersState::default(),
            appearance: appearance::AppearanceState::default(),
            shortcuts: shortcuts::ShortcutsState::default(),
            mcp: mcp::McpState::default(),
            scheduled: scheduled::ScheduledState::default(),
        };
        this.boot(cx);
        this
    }

    /// Load every section's durable state on the background executor. Also
    /// loads the models.dev capability catalog and enriches each built-in
    /// provider row with its catalog models (shown with a "discovered" badge
    /// in the Providers section). A missing catalog file (dev checkouts) just
    /// leaves the rows unenriched — never a crash.
    pub fn boot(&mut self, cx: &mut Context<Self>) {
        if self.booted {
            return;
        }
        self.booted = true;
        let services = self.services.clone();
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_spawn(async move {
                    let capabilities = crate::services::provider_kit::load_capabilities();
                    let providers = services
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(providers::ProviderRow::from)
                                .map(|row| enrich_provider_row(row, capabilities.as_deref()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let settings = services.config.get_settings().unwrap_or_default();
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
                    (
                        providers,
                        settings,
                        schedules,
                        mcp_servers,
                        workspaces,
                        capabilities,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                let (providers, settings, schedules, mcp_servers, workspaces, capabilities) =
                    snapshot;
                this.providers.providers = providers;
                this.providers.settings = settings;
                this.providers.capabilities = capabilities;
                this.scheduled.schedules = schedules;
                this.scheduled.workspaces = workspaces;
                this.mcp.servers = mcp_servers;
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
        self.active = section;
        self.error = None;
        cx.notify();
    }
    /// Refresh the provider + settings snapshots after a mutation (all section
    /// mutations run on the background and then call this).
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let services = self.services.clone();
        let capabilities = self.providers.capabilities.clone();
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_spawn(async move {
                    let providers = services
                        .config
                        .list_providers()
                        .map(|list| {
                            list.iter()
                                .map(providers::ProviderRow::from)
                                .map(|row| enrich_provider_row(row, capabilities.as_deref()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let settings = services.config.get_settings().unwrap_or_default();
                    let mcp_servers = services
                        .config
                        .list_mcp_servers()
                        .unwrap_or_default()
                        .iter()
                        .map(mcp::McpServerRow::from)
                        .collect::<Vec<_>>();
                    (providers, settings, mcp_servers)
                })
                .await;
            this.update(cx, |this, cx| {
                let (providers, settings, mcp_servers) = snapshot;
                this.providers.providers = providers;
                this.providers.settings = settings;
                this.mcp.servers = mcp_servers;
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
    fn sidebar(&self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
                    .child(Icon::new(icon).small().text_color(fg))
                    .child(div().text_sm().truncate().child(label))
            }))
    }

    /// Active section content (scrollable right column).
    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let inner = match self.active {
            SettingsSection::Providers => self.providers_section(window, cx).into_any_element(),
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
}

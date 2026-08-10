//! Settings surface (port of `renderer/components/settings/*`).
//!
//! A single [`SettingsView`] entity renders the active section's content. The
//! application shell renders the catalog-driven settings navigation in its one
//! shared leading rail. Every section talks to the durable stores through
//! [`SettingsServices`] (Arc handles constructed by the orchestrator from
//! `services::stores::Stores`) and runs all store/keychain I/O on the
//! background executor, mirroring the chat service patterns. Pure form logic
//! (cron humanize, shortcut capture encoding, env-line parsing) lives in each
//! section module with unit tests.
//!
//! Section state lives in per-section modules (`providers`, `model_data`,
//! `assistant`, `web_search`, `voice`, `computer_use`, `appearance`,
//! `shortcuts`, `mcp`, `scheduled`, `about`), each implementing render
//! helpers on `SettingsView`, so this file stays a thin shell + router.

use std::sync::Arc;

use aiden_data::config_store::ConfigStore;
use aiden_data::model_pad_store::ModelPadStore;
use aiden_data::portable_config::Workspace;
use aiden_data::schedule_store::{DataStorePersistence, ScheduleStore};
use aiden_data::secret_map::ProviderKeysStore;
use aiden_mcp::client::McpClientManager;
use aiden_scheduler::runtime::SchedulerCore;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{v_flex, ActiveTheme};

mod about;
mod appearance;
mod assistant;
pub mod catalog;
mod computer_use;
mod mcp;
mod model_data;
#[allow(dead_code)]
mod model_pad;
pub(crate) mod navigation;
mod providers;
mod scheduled;
mod shortcuts;
pub(crate) mod skills;
mod voice;
mod web_search;

use providers::enrich_provider_row;

pub use catalog::SettingsDestinationId as SettingsSection;

const SETTINGS_CONTENT_MAX_WIDTH_PX: f32 = 672.0;

/// Everything the settings surface needs from the data layer. The orchestrator
/// constructs this (convenience constructor: [`SettingsServices::from_stores`])
/// and passes it to [`SettingsView::new`].
#[derive(Clone)]
pub struct SettingsServices {
    pub config: Arc<ConfigStore>,
    pub keys: Arc<ProviderKeysStore>,
    pub codex_auth: Arc<crate::services::codex_auth::PiCodexAuthStore>,
    pub foundation_models: Arc<aiden_computer_use::FoundationModelsConnection>,
    pub schedules: Arc<ScheduleStore<DataStorePersistence, DataStorePersistence>>,
    /// The shared lifecycle authority for every schedule mutation.
    pub scheduler: Arc<SchedulerCore<DataStorePersistence, DataStorePersistence>>,
    pub mcp: Arc<McpClientManager>,
    pub mcp_mutation: Arc<crate::services::mcp_mutation::McpMutationAuthority>,
    pub shortcuts: gpui::Entity<crate::shortcut_runtime::ShortcutRuntime>,
    pub appearance_service: gpui::Entity<crate::services::chat_service::ChatService>,
    /// Device-local, network-free personal model arrangement.
    pub model_pad: Arc<ModelPadStore>,
    /// The Artificial Analysis runtime (keychain credential + device-local
    /// cache + the pinned Free endpoint). Every network path requires the
    /// explicit [`aiden_providers::artificial_analysis::UserInitiated`] token,
    /// so the app only contacts Artificial Analysis when the user chooses
    /// Connect & fetch or Fetch latest (see AGENTS.md).
    pub aa: model_data::AaRuntime,
}

impl SettingsServices {
    /// Build the services from the app's durable stores. The schedule store is
    /// shared with the scheduled-tasks panel (both surfaces list the same
    /// task records), and MCP uses the same app-lifetime manager as chat.
    pub fn from_stores(
        stores: &crate::services::stores::Stores,
        shortcuts: gpui::Entity<crate::shortcut_runtime::ShortcutRuntime>,
        appearance_service: gpui::Entity<crate::services::chat_service::ChatService>,
    ) -> Self {
        Self {
            config: stores.config.clone(),
            keys: stores.keys.clone(),
            codex_auth: stores.codex_auth.clone(),
            foundation_models: stores.foundation_models.clone(),
            schedules: stores.schedules.clone(),
            scheduler: stores.scheduler.clone(),
            mcp: stores.mcp.clone(),
            mcp_mutation: stores.mcp_mutation.clone(),
            shortcuts,
            appearance_service,
            model_pad: Arc::new(ModelPadStore::default()),
            aa: model_data::build_aa_runtime(),
        }
    }
}

/// The retained settings content entity. Navigation belongs to the app shell.
pub struct SettingsView {
    services: SettingsServices,
    active: SettingsSection,
    booted: bool,
    pub(crate) error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
    _recorder_drop_guard: shortcuts::RecorderDropGuard,

    pub(crate) providers: providers::ProvidersState,
    pub(crate) model_data: model_data::ModelDataState,
    pub(crate) model_pad: model_pad::ModelPadState,
    pub(crate) assistant: assistant::AssistantState,
    pub(crate) web_search: web_search::WebSearchState,
    pub(crate) voice: voice::VoiceState,
    pub(crate) computer_use: computer_use::ComputerUseState,
    pub(crate) appearance: appearance::AppearanceState,
    pub(crate) shortcuts: shortcuts::ShortcutsState,
    pub(crate) mcp: mcp::McpState,
    pub(crate) scheduled: scheduled::ScheduledState,
    pub(crate) skills: skills::SkillsState,
}

impl SettingsView {
    pub fn new(
        cx: &mut Context<Self>,
        services: SettingsServices,
        workspace: Option<Workspace>,
    ) -> Self {
        let shortcuts = shortcuts::ShortcutsState::default();
        let recorder_drop_guard = shortcuts::RecorderDropGuard::new(
            services.shortcuts.clone(),
            shortcuts.owner_signal(),
            cx.to_async(),
        );
        let mut this = Self {
            services,
            active: SettingsSection::Providers,
            booted: false,
            error: None,
            _subscriptions: Vec::new(),
            _recorder_drop_guard: recorder_drop_guard,
            providers: providers::ProvidersState::default(),
            model_data: model_data::ModelDataState::default(),
            model_pad: model_pad::ModelPadState::default(),
            assistant: assistant::AssistantState::default(),
            web_search: web_search::WebSearchState::default(),
            voice: voice::VoiceState::default(),
            computer_use: computer_use::ComputerUseState::default(),
            appearance: appearance::AppearanceState::default(),
            shortcuts,
            mcp: mcp::McpState::default(),
            scheduled: scheduled::ScheduledState::default(),
            skills: skills::SkillsState::new(cx, workspace.as_ref()),
        };
        let runtime = this.services.shortcuts.clone();
        this._subscriptions.push(cx.subscribe(
            &runtime,
            |this, runtime, _event: &crate::shortcut_runtime::ShortcutRuntimeChanged, cx| {
                this.shortcuts.sync_runtime(runtime.read(cx));
                cx.notify();
            },
        ));
        let appearance_service = this.services.appearance_service.clone();
        this._subscriptions.push(cx.observe(
            &appearance_service,
            |this, _appearance_service, cx| {
                if let Ok((account, needs_attention)) = this.services.codex_auth.account_status() {
                    this.providers.codex_configured = account.is_some();
                    this.providers.codex_account = account;
                    this.providers.codex_needs_attention = needs_attention;
                }
                cx.notify()
            },
        ));
        this.shortcuts.sync_runtime(runtime.read(cx));
        this.boot(cx);
        this.refresh_skills(cx);
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
                    let catalog_status = model_data::catalog_status_of(capabilities.as_deref());
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
                    let model_pad = services.model_pad.load();
                    let codex_status = services.codex_auth.account_status();
                    let foundation_status = services.foundation_models.status(false).await;
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
                        catalog_status,
                        model_pad,
                        codex_status,
                        foundation_status,
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                let (
                    providers,
                    settings,
                    schedules,
                    mcp_servers,
                    workspaces,
                    capabilities,
                    catalog_status,
                    model_pad,
                    codex_status,
                    foundation_status,
                ) = snapshot;
                this.providers.providers = providers;
                this.providers.settings = settings;
                this.providers.capabilities = capabilities;
                match codex_status {
                    Ok((account, needs_attention)) => {
                        this.providers.codex_configured = account.is_some();
                        this.providers.codex_account = account;
                        this.providers.codex_needs_attention = needs_attention;
                    }
                    Err(_) => {
                        this.providers.codex_configured = false;
                        this.providers.codex_account = None;
                        this.providers.codex_error = Some(
                            "ChatGPT secure storage could not be read. Retry or sign in again."
                                .to_string(),
                        );
                    }
                }
                this.providers.foundation_status = foundation_status;
                this.scheduled.schedules = schedules;
                this.scheduled.workspaces = workspaces;
                this.mcp.servers = mcp_servers;
                let settings = this.providers.settings.clone();
                this.appearance.hydrate(&settings, cx);
                this.shortcuts.hydrate(&this.providers.settings);
                this.model_data.catalog = Some(catalog_status);
                let available_models =
                    model_pad::available_model_inventory(&this.providers.providers)
                        .into_iter()
                        .map(|entry| entry.value)
                        .collect::<Vec<_>>();
                this.model_pad.hydrate(model_pad, available_models);
                this.assistant.hydrate(&settings);
                this.web_search.hydrate(&settings);
                this.voice.hydrate(&settings);
                this.computer_use.hydrate(&settings);
                // Background loads that need more than the settings map:
                // keychain checks (web search), the Parakeet catalog + mic
                // permission (voice), and the Artificial Analysis status (its
                // cache store reads through tokio, so it runs on the bridge).
                this.web_search.load_key_state(&this.services, cx);
                this.voice.load_runtime(cx);
                this.model_data.load_aa_status(&this.services, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Route the settings surface to a section (the shell calls this when the
    /// palette or the sidebar gear opens settings).
    pub(crate) fn select_section(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        if self.active != section {
            if self.active == SettingsSection::Appearance {
                self.services
                    .appearance_service
                    .update(cx, |service, cx| service.flush_appearance_save(cx));
            }
            self.cancel_shortcut_recording(cx);
            if self.active == SettingsSection::Providers {
                self.cancel_codex_sign_in();
            }
        }
        self.active = section;
        self.error = None;
        if section == SettingsSection::Skills {
            self.refresh_skills(cx);
        }
        cx.notify();
    }

    pub(crate) fn active_section(&self) -> SettingsSection {
        self.active
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
                this.model_pad.set_available_models(
                    model_pad::available_model_inventory(&this.providers.providers)
                        .into_iter()
                        .map(|entry| entry.value),
                );
                this.providers.settings = settings;
                this.mcp.servers = mcp_servers;
                this.shortcuts.hydrate(&this.providers.settings);
                let services = this.services.clone();
                this.model_data.load_aa_status(&services, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.content(window, cx)
    }
}

impl SettingsView {
    /// Active section content (scrollable right column).
    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let inner = match self.active {
            SettingsSection::Providers => self.providers_section(window, cx).into_any_element(),
            SettingsSection::ModelData => self.model_pad_section(window, cx).into_any_element(),
            SettingsSection::Skills => self.skills_section(window, cx).into_any_element(),
            SettingsSection::Mcp => self.mcp_section(window, cx).into_any_element(),
            SettingsSection::WebSearch => self.web_search_section(window, cx).into_any_element(),
            SettingsSection::ScheduledTasks => {
                self.scheduled_section(window, cx).into_any_element()
            }
            SettingsSection::Assistant => self.assistant_section(window, cx).into_any_element(),
            SettingsSection::ComputerUse => {
                self.computer_use_section(window, cx).into_any_element()
            }
            SettingsSection::Voice => self.voice_section(window, cx).into_any_element(),
            SettingsSection::Shortcut => self.shortcuts_section(window, cx).into_any_element(),
            SettingsSection::Appearance => self.appearance_section(window, cx).into_any_element(),
            SettingsSection::About => self.about_section(window, cx).into_any_element(),
        };
        let theme = cx.theme();
        v_flex()
            .id("settings-view")
            .flex_1()
            .h_full()
            .min_w(gpui::px(0.))
            .bg(theme.background)
            .text_color(theme.foreground)
            .overflow_y_scroll()
            .child(
                div()
                    .w_full()
                    .max_w(gpui::px(SETTINGS_CONTENT_MAX_WIDTH_PX))
                    .mx_auto()
                    .px_5()
                    .py_6()
                    .child(inner),
            )
            .when_some(self.error.clone(), |el, message| {
                el.child(
                    div()
                        .w_full()
                        .max_w(gpui::px(SETTINGS_CONTENT_MAX_WIDTH_PX))
                        .mx_auto()
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
    fn content_measure_matches_the_electron_shell() {
        assert_eq!(SETTINGS_CONTENT_MAX_WIDTH_PX, 672.0);
    }
}

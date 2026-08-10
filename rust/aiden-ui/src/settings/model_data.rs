//! Model data settings (port of `model-data-settings.tsx`, reduced).
//!
//! **Artificial Analysis** is the optional benchmark source. The key is
//!    written to the keychain-backed pi credential store
//!    (`pi-provider-credentials.json` + macOS Keychain), normalized data is
//!    cached device-locally, and the pinned Free endpoint is contacted **only**
//!    on the explicit Connect & fetch / Fetch latest actions (the
//!    [`UserInitiated`] token gates every network path). Offline status reads
//!    never fetch.
//!
//! All I/O runs off the GPUI foreground: config/keychain reads on the
//! background executor, and the Artificial Analysis operations on the tokio
//! bridge (its cache store reads through `tokio::fs` and the fetch uses
//! timers + reqwest — see the runtime contract in `main.rs`).

use std::sync::Arc;

use aiden_data::pi_credential_store::{
    EncryptedPiCredentialStore, EncryptedPiCredentialStoreOptions,
};
use aiden_data::secret_map::KeyringCredentialCipher;
use aiden_providers::artificial_analysis::{
    run_artificial_analysis_action, ArtificialAnalysisActionResult,
    ArtificialAnalysisCredentialStore, ArtificialAnalysisRuntime,
    ArtificialAnalysisRuntimeDependencies, ArtificialAnalysisStatus,
    ArtificialAnalysisStoredCredential, ArtificialAnalysisUserCache,
    DefaultArtificialAnalysisCatalogFetcher, FileArtificialAnalysisCacheStore,
    FileArtificialAnalysisCacheStoreOptions, UserInitiated, ARTIFICIAL_ANALYSIS_CREDENTIAL_ID,
    LEGACY_UNBOUND_GENERATION,
};
use aiden_providers::model_capabilities::{self, ModelCapabilitiesCatalog};
use async_trait::async_trait;
use gpui::{
    div, prelude::FluentBuilder as _, AppContext as _, Context, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    v_flex, ActiveTheme, Disableable as _, IconName, Sizable as _,
};
use gpui_tokio_bridge::Tokio;

use super::SettingsView;

/// The device-local cache filename (`CACHE_FILE` in the TS runtime).
const AA_CACHE_FILE: &str = "artificial-analysis-model-cache.json";
/// The credential env slot that binds the stored key to a cache generation.
const AA_GENERATION_ENV: &str = "AIDEN_ARTIFICIAL_ANALYSIS_GENERATION";

/// The Artificial Analysis runtime handle shared by the settings surface.
pub type AaRuntime = Arc<ArtificialAnalysisRuntime>;

/// Build the Artificial Analysis runtime against the machine-local data dir:
/// the pi credential store (keychain-backed) and the device-local cache file.
pub fn build_aa_runtime() -> AaRuntime {
    let root = aiden_data::machine_local_data_dir();
    let credential_store = EncryptedPiCredentialStore::new(EncryptedPiCredentialStoreOptions {
        file_path: root.join("pi-provider-credentials.json"),
        cipher: Arc::new(KeyringCredentialCipher::new(aiden_mac::KEYCHAIN_SERVICE)),
        sync_directory: None,
        on_durability_warning: None,
        before_document_write: None,
    });
    let cache = FileArtificialAnalysisCacheStore::new(FileArtificialAnalysisCacheStoreOptions {
        file_path: root.join(AA_CACHE_FILE),
        ..Default::default()
    });
    let dependencies = ArtificialAnalysisRuntimeDependencies {
        credentials: Arc::new(PiCredentialStoreAdapter(credential_store)),
        cache: Arc::new(cache),
        fetch_catalog: Arc::new(DefaultArtificialAnalysisCatalogFetcher),
    };
    Arc::new(ArtificialAnalysisRuntime::new(dependencies))
}

/// Keychain-backed credential adapter: reads/writes the `api_key` credential
/// under `artificial-analysis` with the generation bound in `env`.
struct PiCredentialStoreAdapter(EncryptedPiCredentialStore);

#[async_trait]
impl ArtificialAnalysisCredentialStore for PiCredentialStoreAdapter {
    async fn read(&self) -> Result<Option<ArtificialAnalysisStoredCredential>, String> {
        let credential = self
            .0
            .read(ARTIFICIAL_ANALYSIS_CREDENTIAL_ID)
            .map_err(|error| error.to_string())?;
        let Some(credential) = credential else {
            return Ok(None);
        };
        if credential.get("type").and_then(|value| value.as_str()) != Some("api_key") {
            return Err("Stored Artificial Analysis credentials are invalid.".to_string());
        }
        let key = credential
            .get("key")
            .and_then(|value| value.as_str())
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Stored Artificial Analysis credentials are invalid.".to_string())?;
        let generation = credential
            .get("env")
            .and_then(|env| env.get(AA_GENERATION_ENV))
            .and_then(|value| value.as_str())
            .filter(|generation| !generation.is_empty())
            .unwrap_or(LEGACY_UNBOUND_GENERATION)
            .to_string();
        Ok(Some(ArtificialAnalysisStoredCredential { key, generation }))
    }

    async fn write(&self, credential: &ArtificialAnalysisStoredCredential) -> Result<(), String> {
        self.0
            .modify(ARTIFICIAL_ANALYSIS_CREDENTIAL_ID, |_| {
                Ok(Some(serde_json::json!({
                    "type": "api_key",
                    "key": credential.key,
                    "env": { AA_GENERATION_ENV: credential.generation },
                })))
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn delete_key(&self) -> Result<(), String> {
        self.0
            .delete(ARTIFICIAL_ANALYSIS_CREDENTIAL_ID)
            .map_err(|error| error.to_string())
    }
}

/// The models.dev capability catalog status shown at the top of the section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogStatus {
    /// Whether the snapshot loaded successfully.
    pub loaded: bool,
    /// The resolved snapshot path (when present on disk).
    pub path: Option<String>,
    /// Total catalog model rows (provider entries summed).
    pub model_count: usize,
    /// A human-readable reason when the catalog is unavailable.
    pub detail: Option<String>,
}

/// Project the boot-loaded catalog into a status row. Pure so it is
/// unit-testable without touching disk.
pub fn catalog_status_of(capabilities: Option<&ModelCapabilitiesCatalog>) -> CatalogStatus {
    match capabilities {
        Some(catalog) => {
            let model_count = catalog.values().map(|provider| provider.models.len()).sum();
            CatalogStatus {
                loaded: true,
                path: model_capabilities::default_capabilities_path()
                    .map(|path| path.display().to_string()),
                model_count,
                detail: None,
            }
        }
        None => CatalogStatus {
            loaded: false,
            path: model_capabilities::default_capabilities_path()
                .map(|path| path.display().to_string()),
            model_count: 0,
            detail: Some("The bundled model capability snapshot is unavailable.".to_string()),
        },
    }
}

/// The section's transient state.
#[derive(Default)]
pub struct ModelDataState {
    pub catalog: Option<CatalogStatus>,
    /// The Artificial Analysis connection status (None = still checking).
    pub aa: Option<ArtificialAnalysisStatus>,
    pub aa_error: Option<String>,
    pub aa_busy: bool,
    pub(crate) aa_catalog: Option<ArtificialAnalysisUserCache>,
    aa_load_generation: u64,
    _aa_load_task: Option<gpui::Task<()>>,
    /// The key editor (opened by the user).
    pub key_editor: Option<Entity<InputState>>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl SettingsView {
    /// The Model data section. Bundled model metadata is deliberately not a
    /// live-app surface: catalog refresh belongs to development/release tools.
    #[allow(dead_code)]
    pub(crate) fn model_data_section(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        v_flex()
            .id("model-data-section")
            .w_full()
            .gap_4()
            .child(
                v_flex()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Model data"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .mt_0p5()
                            .child(
                                "Manage the optional Artificial Analysis benchmark source used \
                                 for model suggestions.",
                            ),
                    ),
            )
            .child(self.aa_card(cx))
    }

    /// The Artificial Analysis connection card: status callout + key editor +
    /// Fetch latest / Disconnect actions.
    pub(crate) fn aa_card(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let state = &self.model_data;
        let aa = state.aa.as_ref();
        let status_label = aa_status_label(aa);
        let detail = aa_detail_text(aa);
        let fetched = aa
            .and_then(|status| status.fetched_at.as_deref())
            .map(format_fetched_at)
            .unwrap_or_else(|| "never fetched".to_string());
        v_flex()
            .w_full()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(theme.border)
            .px_4()
            .py_3()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Artificial Analysis"),
                            )
                            .child(
                                div()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_md()
                                    .bg(theme.accent.opacity(0.14))
                                    .text_xs()
                                    .text_color(theme.accent)
                                    .child(status_label),
                            ),
                    )
                    .when(aa.is_some_and(|status| status.has_key), |el| {
                        el.child(
                            h_flex()
                                .gap_2()
                                .child(
                                    Button::new("aa-fetch-latest")
                                        .small()
                                        .icon(IconName::Redo)
                                        .label(if state.aa_busy {
                                            "Fetching…"
                                        } else if aa.is_some_and(|status| status.ready) {
                                            "Fetch latest"
                                        } else {
                                            "Fetch model data"
                                        })
                                        .disabled(state.aa_busy)
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.model_data.aa_refresh(&this.services, cx);
                                        })),
                                )
                                .child(
                                    Button::new("aa-disconnect")
                                        .small()
                                        .ghost()
                                        .icon(IconName::Delete)
                                        .label("Disconnect")
                                        .disabled(state.aa_busy)
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.model_data.aa_disconnect(&this.services, cx);
                                        })),
                                ),
                        )
                    }),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(div().text_sm().text_color(theme.foreground).child(detail))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "{cached} cached · {ranked} ranked · Fetched {fetched}",
                                cached = aa.map(|s| s.cached_model_count).unwrap_or(0),
                                ranked = aa.map(|s| s.ranked_model_count).unwrap_or(0),
                            )),
                    )
                    .when_some(state.aa_error.clone(), |el, message| {
                        el.child(
                            div()
                                .text_xs()
                                .mt_0p5()
                                .text_color(theme.danger)
                                .child(message),
                        )
                    }),
            )
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.muted_foreground)
                            .child("Connection"),
                    )
                    .child(div().text_xs().text_color(theme.muted_foreground).child(
                        "Bring your own key. Connecting validates it and fetches the \
                                 first local snapshot; later updates happen only when you press \
                                 Fetch latest. A Free key works with Aiden's model-list endpoint. \
                                 The key is stored encrypted on this Mac and sent only to \
                                 Artificial Analysis when you connect or fetch.",
                    )),
            )
            .when_some(state.key_editor.as_ref(), |el, editor| {
                el.child(
                    h_flex()
                        .w_full()
                        .gap_2()
                        .child(Input::new(editor).small())
                        .child(
                            Button::new("aa-connect")
                                .small()
                                .primary()
                                .label(if state.aa_busy {
                                    "Connecting…"
                                } else if aa.is_some_and(|status| status.has_key) {
                                    "Replace & fetch"
                                } else {
                                    "Connect & fetch"
                                })
                                .disabled(state.aa_busy)
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.model_data.aa_connect(&this.services, cx);
                                })),
                        ),
                )
            })
            .when(state.key_editor.is_none(), |el| {
                el.child(
                    h_flex().w_full().child(
                        Button::new("aa-open-key")
                            .small()
                            .icon(IconName::Settings2)
                            .label(if aa.is_some_and(|status| status.has_key) {
                                "Replace API key"
                            } else {
                                "Connect Artificial Analysis"
                            })
                            .on_click(cx.listener(|this, _event, window, cx| {
                                this.model_data.open_aa_key_editor(window, cx);
                            })),
                    ),
                )
            })
    }
}

impl ModelDataState {
    fn begin_aa_load(&mut self) -> u64 {
        self.aa_load_generation = self.aa_load_generation.saturating_add(1);
        self.aa_load_generation
    }

    fn aa_load_is_current(&self, generation: u64) -> bool {
        self.aa_load_generation == generation
    }

    /// Open the key editor input (created with the window handle).
    fn open_aa_key_editor(&mut self, window: &mut Window, cx: &mut Context<SettingsView>) {
        let editor = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste your API key")
                .masked(true)
        });
        let subscription =
            cx.subscribe_in(&editor, window, |_this, _source, event, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            });
        self._subscriptions.push(subscription);
        self.key_editor = Some(editor);
        self.aa_error = None;
        cx.notify();
    }

    /// Connect with the drafted key: validates + fetches the first snapshot
    /// (explicit user action — `UserInitiated::explicit` gates the network).
    fn aa_connect(&mut self, services: &super::SettingsServices, cx: &mut Context<SettingsView>) {
        if self.aa_busy {
            return;
        }
        let Some(editor) = self.key_editor.as_ref() else {
            return;
        };
        let key = editor.read(cx).value().to_string();
        if key.trim().is_empty() {
            self.aa_error = Some("Paste an Artificial Analysis API key.".to_string());
            cx.notify();
            return;
        }
        self.aa_busy = true;
        self.aa_error = None;
        let services = services.clone();
        let task = Tokio::spawn(cx, async move {
            run_artificial_analysis_action(
                || async { services.aa.connect(&key, UserInitiated::explicit()).await },
                "Aiden couldn't connect to Artificial Analysis. Try again.",
                None,
            )
            .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.model_data.aa_busy = false;
                this.model_data.key_editor = None;
                match result {
                    Ok(ArtificialAnalysisActionResult::Ok { status }) => {
                        this.model_data.aa = Some(status);
                        this.model_data.aa_error = None;
                        let services = this.services.clone();
                        this.model_data.load_aa_status(&services, cx);
                    }
                    Ok(ArtificialAnalysisActionResult::Err { message, .. }) => {
                        this.model_data.aa_error = Some(message);
                    }
                    Err(_) => {
                        this.model_data.aa_error = Some(
                            "Aiden couldn't connect to Artificial Analysis. Try again.".to_string(),
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Re-fetch with the stored key (explicit user action).
    fn aa_refresh(&mut self, services: &super::SettingsServices, cx: &mut Context<SettingsView>) {
        if self.aa_busy {
            return;
        }
        self.aa_busy = true;
        self.aa_error = None;
        let services = services.clone();
        let task = Tokio::spawn(cx, async move {
            run_artificial_analysis_action(
                || async { services.aa.refresh(UserInitiated::explicit()).await },
                "Aiden couldn't fetch the latest model data. Try again.",
                None,
            )
            .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.model_data.aa_busy = false;
                match result {
                    Ok(ArtificialAnalysisActionResult::Ok { status }) => {
                        this.model_data.aa = Some(status);
                        this.model_data.aa_error = None;
                        let services = this.services.clone();
                        this.model_data.load_aa_status(&services, cx);
                    }
                    Ok(ArtificialAnalysisActionResult::Err { message, .. }) => {
                        this.model_data.aa_error = Some(message);
                    }
                    Err(_) => {
                        this.model_data.aa_error = Some(
                            "Aiden couldn't fetch the latest model data. Try again.".to_string(),
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Remove the key + cached data (no network).
    fn aa_disconnect(
        &mut self,
        services: &super::SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        if self.aa_busy {
            return;
        }
        self.aa_busy = true;
        self.aa_error = None;
        let services = services.clone();
        let task = Tokio::spawn(cx, async move {
            run_artificial_analysis_action(
                || async { services.aa.disconnect().await },
                "Aiden couldn't remove the Artificial Analysis connection.",
                None,
            )
            .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.model_data.aa_busy = false;
                match result {
                    Ok(ArtificialAnalysisActionResult::Ok { status }) => {
                        this.model_data.aa = Some(status);
                        this.model_data.aa_error = None;
                        let services = this.services.clone();
                        this.model_data.load_aa_status(&services, cx);
                    }
                    Ok(ArtificialAnalysisActionResult::Err { message, .. }) => {
                        this.model_data.aa_error = Some(message);
                    }
                    Err(_) => {
                        this.model_data.aa_error = Some(
                            "Aiden couldn't remove the Artificial Analysis connection.".to_string(),
                        );
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Refresh the offline connection status (boot + after any mutation).
    pub(crate) fn load_aa_status(
        &mut self,
        services: &super::SettingsServices,
        cx: &mut Context<SettingsView>,
    ) {
        let generation = self.begin_aa_load();
        let services = services.clone();
        let task = Tokio::spawn(cx, async move {
            let status = services.aa.status().await?;
            let catalog = services.aa.catalog().await?;
            Ok::<_, aiden_providers::artificial_analysis::ArtificialAnalysisError>((
                status, catalog,
            ))
        });
        self._aa_load_task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if !this.model_data.aa_load_is_current(generation) {
                    return;
                }
                match result {
                    Ok(Ok((status, catalog))) => {
                        this.model_data.aa = Some(status);
                        this.model_data.aa_error = None;
                        this.model_data.aa_catalog = catalog;
                    }
                    Ok(Err(error)) => {
                        this.model_data.aa_error = Some(error.message().to_string());
                        this.model_data.aa_catalog = None;
                    }
                    Err(_) => {
                        this.model_data.aa_error = Some(
                            "Aiden couldn't read the local Artificial Analysis connection."
                                .to_string(),
                        );
                        this.model_data.aa_catalog = None;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

/// The status label for the Artificial Analysis connection.
fn aa_status_label(status: Option<&ArtificialAnalysisStatus>) -> &'static str {
    match status {
        Some(status) if status.ready => "Suggestions available",
        Some(status) if status.cleanup_needed => "Cleanup needed",
        Some(status) if status.has_key => "Connected",
        Some(_) => "Off",
        None => "Checking…",
    }
}

/// The one-line connection detail under the AA status.
fn aa_detail_text(status: Option<&ArtificialAnalysisStatus>) -> String {
    match status {
        Some(status) if status.ready => format!(
            "{} benchmark position{} available as optional suggestions.",
            status.ranked_model_count,
            if status.ranked_model_count == 1 {
                " is"
            } else {
                "s are"
            }
        ),
        Some(status) if status.cleanup_needed => {
            "The API key is gone, but cached Artificial Analysis data still needs removing."
                .to_string()
        }
        Some(status) if status.has_key => {
            "Your API key is saved. Fetch model data to enable suggestions.".to_string()
        }
        Some(_) => "Off. Your personal Model Pad works without Artificial Analysis.".to_string(),
        None => "Checking for cached suggestions on this Mac.".to_string(),
    }
}

/// Format an RFC 3339 fetched-at timestamp as a short label.
fn format_fetched_at(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.format("%b %d, %Y %H:%M").to_string())
        .unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(has_key: bool, ready: bool, ranked: usize) -> ArtificialAnalysisStatus {
        ArtificialAnalysisStatus {
            state: aiden_providers::artificial_analysis::ArtificialAnalysisConnectionState::Ready,
            has_key,
            cleanup_needed: false,
            ready,
            cached_model_count: if ready { ranked } else { 0 },
            ranked_model_count: if ready { ranked } else { 0 },
            fetched_at: None,
            tier: None,
            intelligence_index_version: None,
        }
    }

    #[test]
    fn status_label_covers_every_state() {
        assert_eq!(aa_status_label(None), "Checking…");
        assert_eq!(aa_status_label(Some(&status(false, false, 0))), "Off");
        assert_eq!(aa_status_label(Some(&status(true, false, 0))), "Connected");
        assert_eq!(
            aa_status_label(Some(&status(true, true, 12))),
            "Suggestions available"
        );
        let mut cleanup = status(false, false, 0);
        cleanup.cleanup_needed = true;
        assert_eq!(aa_status_label(Some(&cleanup)), "Cleanup needed");
    }

    #[test]
    fn detail_text_mentions_counts_and_states() {
        assert!(aa_detail_text(Some(&status(true, true, 1))).contains("position is"));
        assert!(aa_detail_text(Some(&status(true, true, 3))).contains("positions are"));
        assert!(aa_detail_text(Some(&status(false, false, 0))).contains("Pad works"));
        assert!(aa_detail_text(None).contains("Checking"));
    }

    #[test]
    fn catalog_status_counts_provider_models() {
        let mut catalog = ModelCapabilitiesCatalog::new();
        catalog.insert(
            "anthropic".to_string(),
            aiden_providers::model_capabilities::ProviderModels {
                id: Some("anthropic".into()),
                name: None,
                models: Default::default(),
            },
        );
        let loaded = catalog_status_of(Some(&catalog));
        assert!(loaded.loaded);
        assert_eq!(loaded.model_count, 0);
        let missing = catalog_status_of(None);
        assert!(!missing.loaded);
        assert!(missing.detail.is_some());
    }

    #[test]
    fn fetched_at_formats_iso_or_falls_back() {
        let formatted = format_fetched_at("2026-01-02T03:04:05Z");
        assert!(formatted.contains("Jan 02"));
        assert_eq!(format_fetched_at("not-a-date"), "not-a-date");
    }

    #[test]
    fn product_model_data_source_has_no_catalog_refresh_process_path() {
        let source = include_str!("model_data.rs");
        let forbidden_script = ["models:", "refresh"].concat();
        let process_command = ["std::process::", "Command"].concat();
        assert!(!source.contains(&forbidden_script));
        assert!(!source.contains(&process_command));
        let refresh_control = ["model-data-", "refresh"].concat();
        assert!(!source.contains(&refresh_control));
    }

    #[test]
    fn newer_offline_status_load_fences_an_older_completion() {
        let mut state = ModelDataState::default();
        let older = state.begin_aa_load();
        let newer = state.begin_aa_load();

        assert!(!state.aa_load_is_current(older));
        assert!(state.aa_load_is_current(newer));
    }
}

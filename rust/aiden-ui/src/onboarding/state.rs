//! Pure onboarding state machine (port of `renderer/components/onboarding-flow.tsx`
//! + `onboarding-flow.test.tsx`).
//!
//! The Electron flow was three steps (`profile → provider → tour`); this port
//! keeps every behavior the TS version had and widens the tour step into the
//! four final steps the port plan calls for. The mapping:
//!
//! | this port | TS original | notes |
//! |---|---|---|
//! | `Welcome` | `profile` | name entry, persisted under `profileName` |
//! | `Provider` | `provider` | the seven real Aiden providers; key → keychain |
//! | `Model` | — (implicit) | pick from the just-saved provider / catalog; persists `modelSelection` |
//! | `Appearance` | — | preset + mode, live preview via `services::appearance` |
//! | `Permissions` | — | microphone/dictation + computer-use explainer (copy ported from the TS) |
//! | `Finish` | `tour` | "Aiden is ready" feature bento; writes the first-run marker |
//!
//! Preserved TS contracts (unit-tested below): `shouldShowOnboarding` reads the
//! marker `aiden:onboarding:v1:complete`, `make_onboarding_provider` emits the
//! real builtin provider IDs and current model lists (from the TS config
//! services, not the legacy `custom:onboarding-*` placeholders), and the
//! provider-step validation copy matches the TS toasts.

use aiden_core::appearance::{
    create_default_appearance_config, get_preset_variant, AppearanceConfig, Mode, PresetId,
    ReduceMotion, Scheme,
};
use aiden_data::portable_config::{ProviderDeployment, ProviderKind};

/// The first-run-complete marker. The TS stored it in `localStorage` under
/// `STORAGE_KEY = "aiden:onboarding:v1:complete"`; the Rust port persists the
/// same key string into `settings.json` via the config store so the disk
/// contract stays byte-compatible.
pub const ONBOARDING_COMPLETE_KEY: &str = "aiden:onboarding:v1:complete";
/// `settings.json` key for the profile name (TS `profileService.setName`).
pub const PROFILE_NAME_SETTINGS_KEY: &str = "profileName";
/// `settings.json` key for the provider+model selection (matches the chat
/// service's `MODEL_SELECTION_KEY`).
pub const MODEL_SELECTION_SETTINGS_KEY: &str = "modelSelection";
/// TS `MAX_PROFILE_NAME_LENGTH` (profile-core) and the Input `maxLength`.
pub const MAX_PROFILE_NAME_LENGTH: usize = 80;

/// The six onboarding steps, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Welcome,
    Provider,
    Model,
    Appearance,
    Permissions,
    Finish,
}

impl Step {
    pub const ALL: &'static [Step] = &[
        Step::Welcome,
        Step::Provider,
        Step::Model,
        Step::Appearance,
        Step::Permissions,
        Step::Finish,
    ];

    #[allow(dead_code)] // renderer-contract helper; the view tracks the machine step directly
    pub fn index(self) -> usize {
        match self {
            Step::Welcome => 0,
            Step::Provider => 1,
            Step::Model => 2,
            Step::Appearance => 3,
            Step::Permissions => 4,
            Step::Finish => 5,
        }
    }

    pub fn from_index(index: usize) -> Step {
        Self::ALL.get(index).copied().unwrap_or(Step::Finish)
    }
}

/// The seven provider choices — the real Aiden builtin providers plus the two
/// local keyless servers. The legacy TS `openai-signin` OAuth path and the
/// `tailscale` choice are dropped (the OAuth window is out of scope in this
/// port and Tailscale was never a builtin provider).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderChoice {
    ChatGpt,
    Anthropic,
    Google,
    Openai,
    DeepSeek,
    Moonshot,
    LmStudio,
    Ollama,
}

impl ProviderChoice {
    pub const ALL: &'static [ProviderChoice] = &[
        ProviderChoice::ChatGpt,
        ProviderChoice::Anthropic,
        ProviderChoice::Google,
        ProviderChoice::Openai,
        ProviderChoice::DeepSeek,
        ProviderChoice::Moonshot,
        ProviderChoice::LmStudio,
        ProviderChoice::Ollama,
    ];

    pub fn title(self) -> &'static str {
        match self {
            ProviderChoice::ChatGpt => "ChatGPT / Codex",
            ProviderChoice::Anthropic => "Anthropic (Claude)",
            ProviderChoice::Google => "Google Gemini",
            ProviderChoice::Openai => "OpenAI",
            ProviderChoice::DeepSeek => "DeepSeek",
            ProviderChoice::Moonshot => "Moonshot (Kimi)",
            ProviderChoice::LmStudio => "LM Studio",
            ProviderChoice::Ollama => "Ollama",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ProviderChoice::ChatGpt => "Use your ChatGPT Plus or Pro account with Codex models.",
            ProviderChoice::Anthropic => {
                "Bring Claude with your Anthropic API key and provider-hosted models."
            }
            ProviderChoice::Google => "Use Gemini with your Google AI Studio or Gemini API key.",
            ProviderChoice::Openai => "Use OpenAI's hosted models with your own API key.",
            ProviderChoice::DeepSeek => "Use DeepSeek's hosted models with your own API key.",
            ProviderChoice::Moonshot => {
                "Use Moonshot AI's hosted Kimi models with your own API key."
            }
            ProviderChoice::LmStudio => {
                "Use models served locally from LM Studio's OpenAI-compatible server."
            }
            ProviderChoice::Ollama => {
                "Use local Ollama models through Aiden's OpenAI-compatible adapter."
            }
        }
    }

    pub fn footnote(self) -> &'static str {
        match self {
            ProviderChoice::ChatGpt => "OAuth tokens stay encrypted in this Mac's Keychain.",
            ProviderChoice::Anthropic | ProviderChoice::Google => {
                "The key stays on this Mac and can be rotated later in Settings."
            }
            ProviderChoice::Openai | ProviderChoice::DeepSeek | ProviderChoice::Moonshot => {
                "Key is saved through Aiden's local secret storage."
            }
            ProviderChoice::LmStudio => "Default URL: http://127.0.0.1:1234/v1",
            ProviderChoice::Ollama => "Default URL: http://127.0.0.1:11434/v1",
        }
    }

    /// TS `requiresKey`: every hosted provider needs a key; the local servers
    /// are keyless.
    pub fn requires_key(self) -> bool {
        matches!(
            self,
            ProviderChoice::Anthropic
                | ProviderChoice::Google
                | ProviderChoice::Openai
                | ProviderChoice::DeepSeek
                | ProviderChoice::Moonshot
        )
    }

    /// The Base URL input shows for every key-based provider (so users can
    /// point at a gateway/proxy); local servers always use their fixed default
    /// URL.
    pub fn shows_base_url(self) -> bool {
        self.requires_key()
    }

    #[allow(dead_code)] // renderer-contract helper; the view uses the machine defaults
    pub fn base_url_placeholder(self) -> &'static str {
        match self {
            ProviderChoice::ChatGpt => "Managed by secure ChatGPT sign-in",
            ProviderChoice::LmStudio => "http://127.0.0.1:1234/v1",
            ProviderChoice::Ollama => "http://127.0.0.1:11434/v1",
            _ => "Default provider URL",
        }
    }
}

/// Port of `makeOnboardingProvider`'s return type — the TS
/// `Omit<Provider, "hasKey">`. `kind`/`deployment` serialize with the same
/// wire strings as the TS values.
#[derive(Debug, Clone, PartialEq)]
pub struct OnboardingProvider {
    pub id: String,
    pub kind: ProviderKind,
    pub label: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub needs_key: bool,
    pub deployment: ProviderDeployment,
}

/// What the provider step must persist. Every real provider choice produces a
/// record; the `None` provider arm is kept so the writer can no-op when no
/// record is ready (e.g. a future OAuth/sign-in path). The key is `Some` only
/// for choices that require one.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingProviderSave {
    pub provider: Option<OnboardingProvider>,
    pub api_key: Option<String>,
}

/// Build the provider record for a choice (TS `makeOnboardingProvider`, with
/// the legacy `custom:onboarding-*` IDs replaced by the real builtin provider
/// IDs and current model lists from the TS config services).
pub fn make_onboarding_provider(
    choice: ProviderChoice,
    base_url: &str,
) -> Option<OnboardingProvider> {
    let (id, kind, label, models, default_model, needs_key, deployment) = match choice {
        ProviderChoice::ChatGpt => return None,
        ProviderChoice::Anthropic => (
            "anthropic".to_string(),
            ProviderKind::Anthropic,
            "Anthropic (Claude)".to_string(),
            vec![
                "claude-sonnet-5".to_string(),
                "claude-opus-4-8".to_string(),
                "claude-haiku-4-5".to_string(),
            ],
            Some("claude-sonnet-5".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        // Google talks to the generativelanguage API but is wired as an
        // OpenAI-compatible provider (`kind: "openai"` in the TS config).
        ProviderChoice::Google => (
            "google".to_string(),
            ProviderKind::Openai,
            "Google Gemini".to_string(),
            vec![
                "gemini-2.5-flash".to_string(),
                "gemini-2.5-flash-lite".to_string(),
                "gemini-2.5-pro".to_string(),
            ],
            Some("gemini-2.5-flash".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::Openai => (
            "openai".to_string(),
            ProviderKind::Openai,
            "OpenAI".to_string(),
            vec![
                "gpt-4o".to_string(),
                "gpt-4o-mini".to_string(),
                "gpt-4.1".to_string(),
                "o3-mini".to_string(),
            ],
            Some("gpt-4o".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::DeepSeek => (
            "deepseek".to_string(),
            ProviderKind::Openai,
            "DeepSeek".to_string(),
            vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()],
            Some("deepseek-chat".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::Moonshot => (
            "moonshotai".to_string(),
            ProviderKind::Openai,
            "Moonshot (Kimi)".to_string(),
            vec![
                "kimi-k2-0711-preview".to_string(),
                "moonshot-v1-128k".to_string(),
                "moonshot-v1-32k".to_string(),
            ],
            Some("kimi-k2-0711-preview".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::LmStudio => (
            "custom:lmstudio".to_string(),
            ProviderKind::Openai,
            "LM Studio (local)".to_string(),
            Vec::new(),
            None,
            false,
            ProviderDeployment::Local,
        ),
        ProviderChoice::Ollama => (
            "custom:ollama".to_string(),
            ProviderKind::Openai,
            "Ollama (local)".to_string(),
            Vec::new(),
            None,
            false,
            ProviderDeployment::Local,
        ),
    };
    let base_url = if base_url.trim().is_empty() {
        match choice {
            ProviderChoice::ChatGpt => return None,
            ProviderChoice::Anthropic => "https://api.anthropic.com/v1",
            ProviderChoice::Google => "https://generativelanguage.googleapis.com/v1beta",
            ProviderChoice::Openai => "https://api.openai.com/v1",
            ProviderChoice::DeepSeek => "https://api.deepseek.com/v1",
            ProviderChoice::Moonshot => "https://api.moonshot.ai/v1",
            ProviderChoice::LmStudio => "http://127.0.0.1:1234/v1",
            ProviderChoice::Ollama => "http://127.0.0.1:11434/v1",
        }
    } else {
        base_url.trim()
    };
    Some(OnboardingProvider {
        id,
        kind,
        label,
        base_url: base_url.to_string(),
        models,
        default_model,
        needs_key,
        deployment,
    })
}

/// Whether onboarding should run. Mirrors `shouldShowOnboarding`:
/// `localStorage.getItem(STORAGE_KEY) !== "true"` — i.e. show whenever the
/// marker is missing or not exactly `"true"`.
pub fn should_show_onboarding(settings: &serde_json::Map<String, serde_json::Value>) -> bool {
    settings
        .get(ONBOARDING_COMPLETE_KEY)
        .and_then(|value| value.as_str())
        != Some("true")
}

/// Outcome of a transition. The view performs per-step persistence when it
/// sees `Advanced`, and writes the marker + emits the completion event on
/// `Completed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextOutcome {
    Advanced,
    Completed,
    /// Never constructed by the wired view (it validates before advancing);
    /// kept so the state machine is exhaustive.
    #[allow(dead_code)]
    Blocked,
}

/// One selectable model on the Model step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingModelOption {
    pub id: String,
    pub is_default: bool,
}

/// The pure step-state machine. No IO, no GPUI: every transition and the
/// validation copy are unit-tested below (mirroring `onboarding-flow.test.tsx`).
#[derive(Debug, Clone)]
pub struct OnboardingMachine {
    step_index: usize,
    pub name: String,
    pub choice: ProviderChoice,
    pub api_key: String,
    pub defer_pi_setup: bool,
    pub base_url: String,
    pub selected_model: Option<String>,
    pub preset: PresetId,
    pub mode: Mode,
    pub reduce_motion: ReduceMotion,
    pub saved_provider: Option<OnboardingProvider>,
    pub codex_configured: bool,
    /// Fallback catalog loaded from the store at boot (used when the user
    /// skips the provider save).
    pub catalog: Vec<String>,
    pub catalog_provider_id: Option<String>,
    completed: bool,
    pub error: Option<&'static str>,
}

impl Default for OnboardingMachine {
    fn default() -> Self {
        Self {
            step_index: 0,
            name: String::new(),
            // Keep the key-based first option selected until the user
            // explicitly chooses the networked ChatGPT sign-in action.
            choice: ProviderChoice::Anthropic,
            api_key: String::new(),
            defer_pi_setup: false,
            base_url: String::new(),
            selected_model: None,
            preset: PresetId::Aiden,
            mode: Mode::System,
            reduce_motion: ReduceMotion::System,
            saved_provider: None,
            codex_configured: false,
            catalog: Vec::new(),
            catalog_provider_id: None,
            completed: false,
            error: None,
        }
    }
}

impl OnboardingMachine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current(&self) -> Step {
        Step::from_index(self.step_index)
    }

    pub fn step_index(&self) -> usize {
        self.step_index
    }

    pub fn total_steps(&self) -> usize {
        Step::ALL.len()
    }

    #[allow(dead_code)] // renderer-contract helper; the view emits the completion event
    pub fn is_complete(&self) -> bool {
        self.completed
    }

    /// The provider persisted by the provider step, if any. The view uses
    /// this only to offer an explicit handoff to the app-owned setup modal.
    pub fn saved_provider(&self) -> Option<&OnboardingProvider> {
        self.saved_provider.as_ref()
    }

    pub fn defer_pi_provider_setup(&mut self) {
        self.defer_pi_setup = self.choice.requires_key();
        self.api_key.clear();
        self.error = None;
    }

    /// The blocking validation error for the current step, if any. Copy is
    /// taken from the TS toasts / profile-core messages.
    pub fn validate(&self) -> Option<&'static str> {
        match self.current() {
            Step::Welcome => {
                if self.name.trim().is_empty() {
                    return Some("Enter the name you want shown on your profile.");
                }
                if self.name.chars().count() > MAX_PROFILE_NAME_LENGTH {
                    return Some("Profile names can be up to 80 characters.");
                }
                None
            }
            Step::Provider => {
                if self.choice == ProviderChoice::ChatGpt && !self.codex_configured {
                    return Some("Sign in to ChatGPT, or choose another provider.");
                }
                if self.choice.requires_key()
                    && !self.defer_pi_setup
                    && self.api_key.trim().is_empty()
                {
                    return Some("Paste an API key or choose a local option.");
                }
                None
            }
            Step::Model | Step::Appearance | Step::Permissions | Step::Finish => None,
        }
    }

    /// Whether the Next button is enabled (TS `canContinue`).
    pub fn can_continue(&self) -> bool {
        self.validate().is_none()
    }

    /// Move to the next step without validation (the view calls this only
    /// after persisting side effects). Completes on the last step.
    pub fn advance(&mut self) -> NextOutcome {
        if self.current() == Step::Finish {
            self.completed = true;
            return NextOutcome::Completed;
        }
        self.step_index += 1;
        self.error = None;
        NextOutcome::Advanced
    }

    /// Validate + advance in one call. The view uses `validate()` /
    /// `pending_provider_save()` + `advance()` directly for the async provider
    /// step; `next()` covers everything else and all tests.
    #[allow(dead_code)] // renderer-contract helper; the wired view drives steps explicitly
    pub fn next(&mut self) -> NextOutcome {
        if let Some(message) = self.validate() {
            self.error = Some(message);
            return NextOutcome::Blocked;
        }
        self.error = None;
        self.advance()
    }

    /// Go back one step (TS Back button); never below Welcome.
    pub fn back(&mut self) {
        if self.step_index > 0 {
            self.step_index -= 1;
        }
        self.error = None;
    }

    /// Skip the whole flow (TS "Skip"): marks complete so the view writes the
    /// marker and closes.
    pub fn skip(&mut self) -> NextOutcome {
        self.completed = true;
        NextOutcome::Completed
    }

    /// What the provider step should persist for the current choices.
    pub fn pending_provider_save(&self) -> PendingProviderSave {
        let provider = make_onboarding_provider(self.choice, &self.base_url);
        let api_key = if self.choice.requires_key() {
            let key = self.api_key.trim().to_string();
            (!key.is_empty()).then_some(key)
        } else {
            None
        };
        PendingProviderSave { provider, api_key }
    }

    /// Record a successful provider save (config + keychain write) and seed
    /// the model step with the provider's default.
    pub fn record_provider_saved(&mut self, provider: OnboardingProvider) {
        self.selected_model = provider.default_model.clone();
        self.saved_provider = Some(provider);
        self.error = None;
    }

    pub fn record_codex_configured(&mut self) {
        let snapshot = aiden_providers::list::bundled_codex_provider_snapshot(true);
        let models = snapshot.models.into_iter().map(|model| model.id).collect();
        self.codex_configured = true;
        self.record_provider_saved(OnboardingProvider {
            id: "openai-codex".to_string(),
            kind: ProviderKind::Openai,
            label: "ChatGPT / Codex".to_string(),
            base_url: "https://chatgpt.com/backend-api".to_string(),
            models,
            default_model: Some("gpt-5.4".to_string()),
            needs_key: true,
            deployment: ProviderDeployment::Hosted,
        });
    }

    /// Load the configured-provider catalog read at boot (returning users).
    pub fn set_catalog(&mut self, provider_id: Option<String>, models: Vec<String>) {
        self.catalog_provider_id = provider_id;
        self.catalog = models;
    }

    /// Models offered on the Model step: the just-saved provider's list, else
    /// the boot catalog.
    pub fn model_options(&self) -> Vec<OnboardingModelOption> {
        if let Some(provider) = &self.saved_provider {
            return provider
                .models
                .iter()
                .map(|id| OnboardingModelOption {
                    id: id.clone(),
                    is_default: provider.default_model.as_deref() == Some(id),
                })
                .collect();
        }
        self.catalog
            .iter()
            .enumerate()
            .map(|(index, id)| OnboardingModelOption {
                id: id.clone(),
                is_default: index == 0,
            })
            .collect()
    }

    pub fn set_model(&mut self, model: Option<String>) {
        self.selected_model = model;
    }

    /// The resolved `(providerId, model)` pair to persist under
    /// `modelSelection`, or `None` when nothing was configured.
    pub fn selection(&self) -> Option<(String, String)> {
        let provider_id = self
            .saved_provider
            .as_ref()
            .map(|provider| provider.id.clone())
            .or_else(|| self.catalog_provider_id.clone())?;
        let model = self.selected_model.clone().or_else(|| {
            self.saved_provider
                .as_ref()
                .and_then(|provider| provider.default_model.clone())
                .or_else(|| self.catalog.first().cloned())
        })?;
        Some((provider_id, model))
    }

    pub fn set_preset(&mut self, preset: PresetId) {
        self.preset = preset;
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    pub fn set_reduce_motion(&mut self, reduce_motion: ReduceMotion) {
        self.reduce_motion = reduce_motion;
    }

    /// The full appearance config for the chosen preset + mode (used for the
    /// live preview and for persisting under the `appearance` settings key).
    pub fn appearance_config(&self) -> AppearanceConfig {
        let mut config = create_default_appearance_config();
        config.mode = self.mode;
        config.light = get_preset_variant(self.preset, Scheme::Light);
        config.dark = get_preset_variant(self.preset, Scheme::Dark);
        config.reduce_motion = self.reduce_motion;
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(
        key: &str,
        value: serde_json::Value,
    ) -> serde_json::Map<String, serde_json::Value> {
        let mut settings = serde_json::Map::new();
        settings.insert(key.to_string(), value);
        settings
    }

    // -----------------------------------------------------------------------
    // onboarding-flow.test.tsx — "onboarding appears only until it is completed"
    // -----------------------------------------------------------------------

    #[test]
    fn onboarding_appears_only_until_completed() {
        assert!(
            should_show_onboarding(&serde_json::Map::new()),
            "no marker yet → show"
        );
        assert!(
            should_show_onboarding(&settings_with(
                ONBOARDING_COMPLETE_KEY,
                serde_json::Value::String("yes".into())
            )),
            "any value other than exactly \"true\" still shows (TS !== \"true\")"
        );
        let completed = settings_with(
            ONBOARDING_COMPLETE_KEY,
            serde_json::Value::String("true".into()),
        );
        // The marker key matches the TS STORAGE_KEY exactly.
        assert_eq!(ONBOARDING_COMPLETE_KEY, "aiden:onboarding:v1:complete");
        assert!(
            !should_show_onboarding(&completed),
            "marker \"true\" hides the flow"
        );
    }

    #[test]
    fn skip_marks_the_flow_complete() {
        let mut machine = OnboardingMachine::new();
        assert_eq!(machine.skip(), NextOutcome::Completed);
        assert!(machine.is_complete());
    }

    // -----------------------------------------------------------------------
    // onboarding-flow.test.tsx — "onboarding provider choices preserve local
    // and hosted defaults"
    // -----------------------------------------------------------------------

    #[test]
    fn provider_factory_emits_real_provider_ids_models_and_defaults() {
        assert_eq!(
            make_onboarding_provider(ProviderChoice::Anthropic, ""),
            Some(OnboardingProvider {
                id: "anthropic".into(),
                kind: ProviderKind::Anthropic,
                label: "Anthropic (Claude)".into(),
                base_url: "https://api.anthropic.com/v1".into(),
                models: vec![
                    "claude-sonnet-5".into(),
                    "claude-opus-4-8".into(),
                    "claude-haiku-4-5".into(),
                ],
                default_model: Some("claude-sonnet-5".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Google, ""),
            Some(OnboardingProvider {
                id: "google".into(),
                kind: ProviderKind::Openai,
                label: "Google Gemini".into(),
                base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
                models: vec![
                    "gemini-2.5-flash".into(),
                    "gemini-2.5-flash-lite".into(),
                    "gemini-2.5-pro".into(),
                ],
                default_model: Some("gemini-2.5-flash".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Openai, "https://gateway.example/v1"),
            Some(OnboardingProvider {
                id: "openai".into(),
                kind: ProviderKind::Openai,
                label: "OpenAI".into(),
                base_url: "https://gateway.example/v1".into(),
                models: vec![
                    "gpt-4o".into(),
                    "gpt-4o-mini".into(),
                    "gpt-4.1".into(),
                    "o3-mini".into()
                ],
                default_model: Some("gpt-4o".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::DeepSeek, ""),
            Some(OnboardingProvider {
                id: "deepseek".into(),
                kind: ProviderKind::Openai,
                label: "DeepSeek".into(),
                base_url: "https://api.deepseek.com/v1".into(),
                models: vec!["deepseek-chat".into(), "deepseek-reasoner".into()],
                default_model: Some("deepseek-chat".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Moonshot, ""),
            Some(OnboardingProvider {
                id: "moonshotai".into(),
                kind: ProviderKind::Openai,
                label: "Moonshot (Kimi)".into(),
                base_url: "https://api.moonshot.ai/v1".into(),
                models: vec![
                    "kimi-k2-0711-preview".into(),
                    "moonshot-v1-128k".into(),
                    "moonshot-v1-32k".into(),
                ],
                default_model: Some("kimi-k2-0711-preview".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::LmStudio, ""),
            Some(OnboardingProvider {
                id: "custom:lmstudio".into(),
                kind: ProviderKind::Openai,
                label: "LM Studio (local)".into(),
                base_url: "http://127.0.0.1:1234/v1".into(),
                models: vec![],
                default_model: None,
                needs_key: false,
                deployment: ProviderDeployment::Local,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Ollama, ""),
            Some(OnboardingProvider {
                id: "custom:ollama".into(),
                kind: ProviderKind::Openai,
                label: "Ollama (local)".into(),
                base_url: "http://127.0.0.1:11434/v1".into(),
                models: vec![],
                default_model: None,
                needs_key: false,
                deployment: ProviderDeployment::Local,
            })
        );
    }

    /// Compact parity lock: the five hosted providers map to the real builtin
    /// IDs, model lists, and defaults from the TS config services.
    #[test]
    fn hosted_providers_match_the_real_builtin_presets() {
        let expected: [(&str, &[&str], &str); 5] = [
            (
                "anthropic",
                &["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
                "claude-sonnet-5",
            ),
            (
                "google",
                &[
                    "gemini-2.5-flash",
                    "gemini-2.5-flash-lite",
                    "gemini-2.5-pro",
                ],
                "gemini-2.5-flash",
            ),
            (
                "openai",
                &["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
                "gpt-4o",
            ),
            (
                "deepseek",
                &["deepseek-chat", "deepseek-reasoner"],
                "deepseek-chat",
            ),
            (
                "moonshotai",
                &[
                    "kimi-k2-0711-preview",
                    "moonshot-v1-128k",
                    "moonshot-v1-32k",
                ],
                "kimi-k2-0711-preview",
            ),
        ];
        let choices = [
            ProviderChoice::Anthropic,
            ProviderChoice::Google,
            ProviderChoice::Openai,
            ProviderChoice::DeepSeek,
            ProviderChoice::Moonshot,
        ];
        for (choice, (id, models, default_model)) in choices.into_iter().zip(expected) {
            let provider = make_onboarding_provider(choice, "").expect("hosted provider");
            assert_eq!(provider.id, id, "{choice:?} id");
            assert_eq!(
                provider.models,
                models
                    .iter()
                    .map(|model| model.to_string())
                    .collect::<Vec<_>>(),
                "{choice:?} model list"
            );
            assert_eq!(
                provider.default_model.as_deref(),
                Some(default_model),
                "{choice:?} default model"
            );
            assert!(provider.needs_key, "{choice:?} needs a key");
            assert_eq!(provider.deployment, ProviderDeployment::Hosted);
        }
    }

    #[test]
    fn factory_trims_custom_base_urls_and_defaults_local_urls() {
        let provider =
            make_onboarding_provider(ProviderChoice::Anthropic, "  https://gateway.example/v1  ")
                .expect("anthropic provider");
        assert_eq!(provider.base_url, "https://gateway.example/v1");
        // Local choices fall back to their fixed default URL when left blank.
        assert_eq!(
            make_onboarding_provider(ProviderChoice::LmStudio, "")
                .expect("lm studio provider")
                .base_url,
            "http://127.0.0.1:1234/v1"
        );
        assert_eq!(
            make_onboarding_provider(ProviderChoice::Ollama, "")
                .expect("ollama provider")
                .base_url,
            "http://127.0.0.1:11434/v1"
        );
    }

    // -----------------------------------------------------------------------
    // Machine transitions
    // -----------------------------------------------------------------------

    #[test]
    fn welcome_step_requires_a_name() {
        let mut machine = OnboardingMachine::new();
        assert_eq!(machine.current(), Step::Welcome);
        assert!(!machine.can_continue());
        assert_eq!(
            machine.next(),
            NextOutcome::Blocked,
            "empty name blocks advance"
        );
        assert_eq!(
            machine.error,
            Some("Enter the name you want shown on your profile.")
        );

        machine.name = "Ada".into();
        assert!(machine.can_continue());
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.current(), Step::Provider);
    }

    #[test]
    fn name_length_is_capped_at_eighty() {
        let mut machine = OnboardingMachine::new();
        machine.name = "a".repeat(81);
        assert_eq!(
            machine.validate(),
            Some("Profile names can be up to 80 characters.")
        );
        machine.name = "a".repeat(80);
        assert_eq!(machine.validate(), None);
    }

    #[test]
    fn provider_step_validation_matches_ts() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next();

        // Every key-requiring choice demands a key.
        for choice in [
            ProviderChoice::Anthropic,
            ProviderChoice::Google,
            ProviderChoice::Openai,
            ProviderChoice::DeepSeek,
            ProviderChoice::Moonshot,
        ] {
            machine.choice = choice;
            assert_eq!(
                machine.validate(),
                Some("Paste an API key or choose a local option."),
                "{choice:?} requires a key"
            );
            machine.api_key = "  sk-ant-abcdef  ".into();
            assert_eq!(
                machine.validate(),
                None,
                "a non-empty (untrimmed) key passes TS too ({choice:?})"
            );
            machine.api_key.clear();
        }

        // Local choices never require a key.
        for choice in [ProviderChoice::LmStudio, ProviderChoice::Ollama] {
            machine.choice = choice;
            assert_eq!(machine.validate(), None, "{choice:?} is keyless");
        }
    }

    #[test]
    fn explicit_pi_setup_handoff_allows_progress_without_portable_key_material() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        assert_eq!(machine.next(), NextOutcome::Advanced);
        machine.choice = ProviderChoice::Anthropic;
        assert!(machine.validate().is_some());
        machine.defer_pi_provider_setup();
        assert_eq!(machine.validate(), None);
        let pending = machine.pending_provider_save();
        assert_eq!(pending.api_key, None);
        assert_eq!(
            pending.provider.map(|provider| provider.id),
            Some("anthropic".to_string())
        );
    }

    #[test]
    fn pending_provider_save_carries_the_trimmed_key() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next();
        machine.choice = ProviderChoice::Anthropic;
        machine.api_key = "  sk-ant-abcdef  ".into();
        machine.base_url = "".into();

        let pending = machine.pending_provider_save();
        assert_eq!(pending.api_key.as_deref(), Some("sk-ant-abcdef"));
        assert_eq!(
            pending
                .provider
                .as_ref()
                .map(|provider| provider.id.as_str()),
            Some("anthropic")
        );

        machine.choice = ProviderChoice::LmStudio;
        let pending = machine.pending_provider_save();
        assert_eq!(pending.api_key, None);
        assert_eq!(
            pending.provider.map(|provider| provider.id),
            Some("custom:lmstudio".to_string()),
            "local choices still produce a provider record"
        );
    }

    #[test]
    fn model_step_resolves_selection_from_the_saved_provider() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next();
        machine.choice = ProviderChoice::Anthropic;
        machine.api_key = "sk-ant-abcdef".into();
        let provider = machine
            .pending_provider_save()
            .provider
            .expect("anthropic provider");
        machine.record_provider_saved(provider);
        assert_eq!(
            machine
                .saved_provider()
                .map(|provider| provider.id.as_str()),
            Some("anthropic")
        );
        assert_eq!(machine.current(), Step::Provider);
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.current(), Step::Model);

        let options = machine.model_options();
        assert_eq!(
            options,
            vec![
                OnboardingModelOption {
                    id: "claude-sonnet-5".into(),
                    is_default: true
                },
                OnboardingModelOption {
                    id: "claude-opus-4-8".into(),
                    is_default: false
                },
                OnboardingModelOption {
                    id: "claude-haiku-4-5".into(),
                    is_default: false
                },
            ]
        );
        // The default model is pre-selected and persists under modelSelection.
        assert_eq!(
            machine.selection(),
            Some(("anthropic".to_string(), "claude-sonnet-5".to_string()))
        );

        machine.set_model(Some("claude-haiku-4-5".into()));
        assert_eq!(
            machine.selection(),
            Some(("anthropic".to_string(), "claude-haiku-4-5".to_string()))
        );
    }

    #[test]
    fn model_step_without_a_provider_offers_the_catalog() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next();
        // Skip the provider save (no record persisted) and use the catalog.
        machine.api_key = "sk-ant-abcdef".into();
        machine.set_catalog(
            Some("custom:existing".into()),
            vec!["model-a".into(), "model-b".into()],
        );
        machine.next();
        assert_eq!(machine.current(), Step::Model);
        assert_eq!(
            machine.model_options(),
            vec![
                OnboardingModelOption {
                    id: "model-a".into(),
                    is_default: true
                },
                OnboardingModelOption {
                    id: "model-b".into(),
                    is_default: false
                },
            ]
        );
        assert_eq!(
            machine.selection(),
            Some(("custom:existing".into(), "model-a".into()))
        );
    }

    #[test]
    fn appearance_step_composes_the_full_config() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.api_key = "sk-ant-abcdef".into(); // default choice (Anthropic) needs a key
        machine.next();
        machine.next();
        assert_eq!(machine.current(), Step::Model);
        machine.next();
        assert_eq!(machine.current(), Step::Appearance);

        machine.set_preset(PresetId::Berry);
        machine.set_mode(Mode::Dark);
        let config = machine.appearance_config();
        assert_eq!(config.mode, Mode::Dark);
        assert_eq!(config.dark.preset, aiden_core::appearance::Selection::Berry);
        assert_eq!(
            config.light.preset,
            aiden_core::appearance::Selection::Berry
        );
        assert_eq!(config.reduce_motion, ReduceMotion::System);
    }

    #[test]
    fn finish_marks_the_flow_complete() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.api_key = "sk-ant-abcdef".into(); // default choice (Anthropic) needs a key
                                                  // Walk the whole flow.
        for _ in 0..5 {
            let outcome = machine.next();
            assert_eq!(outcome, NextOutcome::Advanced);
        }
        assert_eq!(machine.current(), Step::Finish);
        assert!(!machine.is_complete());
        assert_eq!(machine.next(), NextOutcome::Completed);
        assert!(machine.is_complete());
    }

    #[test]
    fn back_never_goes_below_welcome() {
        let mut machine = OnboardingMachine::new();
        machine.back();
        assert_eq!(machine.current(), Step::Welcome);
        machine.name = "Ada".into();
        machine.next();
        machine.back();
        assert_eq!(machine.current(), Step::Welcome);
    }

    #[test]
    fn blocked_advance_sets_the_error_and_clears_resets_it() {
        let mut machine = OnboardingMachine::new();
        assert_eq!(machine.next(), NextOutcome::Blocked);
        assert!(machine.error.is_some());
        machine.name = "Ada".into();
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.error, None);
    }

    // The wired view calls `advance()` (not `next()`) after a passing
    // `validate()`, and treats the `Blocked` arm as a defensive no-op instead
    // of panicking (ObjC callbacks cannot unwind). This locks in the invariant
    // that makes that no-op correct: `advance()` only ever yields `Advanced`
    // or `Completed`, never `Blocked`.
    #[test]
    fn advance_never_yields_blocked_across_the_whole_flow() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        loop {
            let outcome = machine.advance();
            assert!(
                matches!(outcome, NextOutcome::Advanced | NextOutcome::Completed),
                "advance() must never return Blocked, got {outcome:?}"
            );
            if outcome == NextOutcome::Completed {
                break;
            }
        }
        assert!(machine.is_complete());
        // Advancing past completion keeps yielding Completed (never Blocked).
        assert_eq!(machine.advance(), NextOutcome::Completed);
    }

    #[test]
    fn back_and_reenter_preserves_entered_step_data() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next(); // → Provider
        machine.choice = ProviderChoice::Anthropic;
        machine.api_key = "  sk-ant-abcdef  ".into();
        machine.base_url = "https://gateway.example/v1".into();
        machine.back(); // → Welcome
        assert_eq!(machine.current(), Step::Welcome);
        machine.next(); // → Provider again
                        // The machine keeps every field the user entered; the inputs mirror
                        // it, so re-advancing never requires re-entering data.
        assert_eq!(machine.choice, ProviderChoice::Anthropic);
        assert_eq!(machine.api_key, "  sk-ant-abcdef  ");
        assert_eq!(machine.base_url, "https://gateway.example/v1");
        // The provider is saved again on re-advance; the save is an upsert by
        // id (config_store::save_provider), so this is idempotent.
        assert_eq!(
            machine.pending_provider_save().api_key.as_deref(),
            Some("sk-ant-abcdef")
        );
    }

    #[test]
    fn advance_is_bounded_by_the_finish_step() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.api_key = "sk-ant-abcdef".into(); // default choice (Anthropic) needs a key
                                                  // Walk the flow, then hammer Next well past the end.
        for _ in 0..10 {
            let _ = machine.next();
        }
        assert_eq!(machine.current(), Step::Finish);
        assert!(machine.is_complete());
        // The step index never escapes the step list.
        assert_eq!(machine.step_index(), Step::Finish.index());
        assert_eq!(machine.current(), Step::from_index(machine.step_index()));
    }

    #[test]
    fn should_show_onboarding_when_the_marker_is_missing_or_malformed() {
        // Non-string marker values (corrupt / legacy) still show the flow —
        // the TS contract is `localStorage.getItem(key) !== "true"`.
        assert!(should_show_onboarding(&settings_with(
            ONBOARDING_COMPLETE_KEY,
            serde_json::json!(true)
        )));
        assert!(should_show_onboarding(&settings_with(
            ONBOARDING_COMPLETE_KEY,
            serde_json::json!(1)
        )));
        assert!(should_show_onboarding(&settings_with(
            ONBOARDING_COMPLETE_KEY,
            serde_json::Value::Null
        )));
        // The exact TS string hides it.
        assert!(!should_show_onboarding(&settings_with(
            ONBOARDING_COMPLETE_KEY,
            serde_json::json!("true")
        )));
    }

    #[test]
    fn model_step_with_no_provider_or_catalog_still_advances() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.api_key = "sk-ant-abcdef".into(); // default choice (Anthropic) needs a key
        machine.next(); // → Provider
        machine.next(); // → Model (no saved provider, no boot catalog)
        assert!(machine.model_options().is_empty());
        assert_eq!(machine.selection(), None);
        assert_eq!(
            machine.validate(),
            None,
            "no models to pick from is not a blocking validation error"
        );
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.current(), Step::Appearance);
    }

    #[test]
    fn skip_then_advance_never_reenters_editing() {
        let mut machine = OnboardingMachine::new();
        machine.skip();
        assert!(machine.is_complete());
        // The machine stays at Welcome (index 0) but reports complete, so the
        // view's completion guard prevents any further navigation. Calling
        // `next()` here cannot advance (the empty name fails `validate()`), so
        // it returns `Blocked` and the machine remains complete + parked.
        assert_eq!(machine.step_index(), 0);
        assert_eq!(machine.next(), NextOutcome::Blocked);
        assert!(machine.is_complete());
        assert_eq!(machine.step_index(), 0);
    }

    #[test]
    fn choosing_chatgpt_does_not_start_or_persist_any_network_setup() {
        let mut machine = OnboardingMachine::new();
        machine.choice = ProviderChoice::ChatGpt;

        let pending = machine.pending_provider_save();

        assert_eq!(pending.provider, None);
        assert_eq!(pending.api_key, None);
        machine.step_index = Step::Provider.index();
        assert_eq!(
            machine.validate(),
            Some("Sign in to ChatGPT, or choose another provider.")
        );
    }

    #[test]
    fn configured_chatgpt_exposes_bundled_models_and_exact_selection() {
        let mut machine = OnboardingMachine::new();
        machine.choice = ProviderChoice::ChatGpt;

        machine.record_codex_configured();

        assert!(machine.codex_configured);
        assert!(machine
            .model_options()
            .iter()
            .any(|model| model.id == "gpt-5.6-sol"));
        assert_eq!(
            machine.selection(),
            Some(("openai-codex".to_string(), "gpt-5.4".to_string()))
        );
    }
}

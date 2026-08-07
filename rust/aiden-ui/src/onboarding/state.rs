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
//! | `Provider` | `provider` | the six TS choices; key → keychain, `openai-signin` stubbed |
//! | `Model` | — (implicit) | pick from the just-saved provider / catalog; persists `modelSelection` |
//! | `Appearance` | — | preset + mode, live preview via `services::appearance` |
//! | `Permissions` | — | microphone/dictation + computer-use explainer (copy ported from the TS) |
//! | `Finish` | `tour` | "Aiden is ready" feature bento; writes the first-run marker |
//!
//! Preserved TS contracts (unit-tested below): `shouldShowOnboarding` reads the
//! marker `aiden:onboarding:v1:complete`, `makeOnboardingProvider` keeps the
//! exact ids/URLs/model lists, and the provider-step validation copy matches
//! the TS toasts.

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

/// The six provider choices (TS `ProviderChoice`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderChoice {
    OpenaiKey,
    OpenaiSignin,
    Anthropic,
    LmStudio,
    Ollama,
    Tailscale,
}

impl ProviderChoice {
    pub const ALL: &'static [ProviderChoice] = &[
        ProviderChoice::OpenaiKey,
        ProviderChoice::OpenaiSignin,
        ProviderChoice::Anthropic,
        ProviderChoice::LmStudio,
        ProviderChoice::Ollama,
        ProviderChoice::Tailscale,
    ];

    pub fn title(self) -> &'static str {
        match self {
            ProviderChoice::OpenaiKey => "OpenAI API key",
            ProviderChoice::OpenaiSignin => "ChatGPT sign in",
            ProviderChoice::Anthropic => "Anthropic API key",
            ProviderChoice::LmStudio => "LM Studio",
            ProviderChoice::Ollama => "Ollama",
            ProviderChoice::Tailscale => "Tailscale custom model",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ProviderChoice::OpenaiKey => {
                "Use an OpenAI-compatible hosted endpoint with your own API key."
            }
            ProviderChoice::OpenaiSignin => {
                "Connect the built-in ChatGPT provider when you prefer browser sign-in."
            }
            ProviderChoice::Anthropic => {
                "Bring Claude with your Anthropic API key and provider-hosted models."
            }
            ProviderChoice::LmStudio => {
                "Use models served locally from LM Studio's OpenAI-compatible server."
            }
            ProviderChoice::Ollama => {
                "Use local Ollama models through Aiden's OpenAI-compatible adapter."
            }
            ProviderChoice::Tailscale => {
                "Point Aiden at a private OpenAI-compatible model reachable over Tailscale."
            }
        }
    }

    pub fn footnote(self) -> &'static str {
        match self {
            ProviderChoice::OpenaiKey => "Key is saved through Aiden's local secret storage.",
            ProviderChoice::OpenaiSignin => {
                "Aiden opens the provider auth flow outside the onboarding card."
            }
            ProviderChoice::Anthropic => {
                "The key stays on this Mac and can be rotated later in Settings."
            }
            ProviderChoice::LmStudio => "Default URL: http://127.0.0.1:1234/v1",
            ProviderChoice::Ollama => "Default URL: http://127.0.0.1:11434/v1",
            ProviderChoice::Tailscale => {
                "Add your tailnet URL now; refine models later in Settings."
            }
        }
    }

    /// TS `requiresKey`.
    pub fn requires_key(self) -> bool {
        matches!(self, ProviderChoice::OpenaiKey | ProviderChoice::Anthropic)
    }

    /// TS shows the Base URL input for `tailscale || openai-key || anthropic`.
    pub fn shows_base_url(self) -> bool {
        matches!(
            self,
            ProviderChoice::OpenaiKey | ProviderChoice::Anthropic | ProviderChoice::Tailscale
        )
    }

    #[allow(dead_code)] // renderer-contract helper; the view uses the machine defaults
    pub fn base_url_placeholder(self) -> &'static str {
        match self {
            ProviderChoice::Tailscale => "https://model.tailnet.ts.net/v1",
            ProviderChoice::OpenaiKey | ProviderChoice::Anthropic => "Default provider URL",
            _ => "",
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

/// What the provider step must persist: `None` provider means the
/// `openai-signin` path (no provider record; the OAuth flow is a later-phase
/// stub). The key is `Some` only for choices that require one.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingProviderSave {
    pub provider: Option<OnboardingProvider>,
    pub api_key: Option<String>,
}

/// Build the provider record for a choice (TS `makeOnboardingProvider`).
/// `openai-signin` has no provider record — the sign-in flow is out of scope.
pub fn make_onboarding_provider(
    choice: ProviderChoice,
    base_url: &str,
) -> Option<OnboardingProvider> {
    let (id, kind, label, models, default_model, needs_key, deployment) = match choice {
        ProviderChoice::OpenaiSignin => return None,
        ProviderChoice::OpenaiKey => (
            "custom:onboarding-openai".to_string(),
            ProviderKind::Openai,
            "OpenAI".to_string(),
            vec!["gpt-4.1".to_string(), "gpt-4.1-mini".to_string()],
            Some("gpt-4.1-mini".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::Anthropic => (
            "custom:onboarding-anthropic".to_string(),
            ProviderKind::Anthropic,
            "Anthropic".to_string(),
            vec![
                "claude-sonnet-4-5".to_string(),
                "claude-haiku-4-5".to_string(),
            ],
            Some("claude-sonnet-4-5".to_string()),
            true,
            ProviderDeployment::Hosted,
        ),
        ProviderChoice::LmStudio => (
            "custom:onboarding-lmstudio".to_string(),
            ProviderKind::Openai,
            "LM Studio (local)".to_string(),
            Vec::new(),
            None,
            false,
            ProviderDeployment::Local,
        ),
        ProviderChoice::Ollama => (
            "custom:onboarding-ollama".to_string(),
            ProviderKind::Openai,
            "Ollama (local)".to_string(),
            Vec::new(),
            None,
            false,
            ProviderDeployment::Local,
        ),
        ProviderChoice::Tailscale => (
            "custom:onboarding-tailscale".to_string(),
            ProviderKind::Openai,
            "Tailscale model".to_string(),
            Vec::new(),
            None,
            false,
            ProviderDeployment::Local,
        ),
    };
    let base_url = if base_url.trim().is_empty() {
        match choice {
            ProviderChoice::OpenaiKey => "https://api.openai.com/v1",
            ProviderChoice::Anthropic => "https://api.anthropic.com/v1",
            ProviderChoice::LmStudio => "http://127.0.0.1:1234/v1",
            ProviderChoice::Ollama => "http://127.0.0.1:11434/v1",
            // TS passes the raw (possibly empty) tailnet URL through; the
            // machine validates it before advancing.
            ProviderChoice::Tailscale => "",
            ProviderChoice::OpenaiSignin => unreachable!("returns None above"),
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
    pub base_url: String,
    pub selected_model: Option<String>,
    pub preset: PresetId,
    pub mode: Mode,
    pub reduce_motion: ReduceMotion,
    pub saved_provider: Option<OnboardingProvider>,
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
            // TS default selection is "openai-signin".
            choice: ProviderChoice::OpenaiSignin,
            api_key: String::new(),
            base_url: String::new(),
            selected_model: None,
            preset: PresetId::Aiden,
            mode: Mode::System,
            reduce_motion: ReduceMotion::System,
            saved_provider: None,
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
                if self.choice == ProviderChoice::Tailscale && self.base_url.trim().is_empty() {
                    return Some("Enter the Tailscale model server URL before continuing.");
                }
                if self.choice.requires_key() && self.api_key.trim().is_empty() {
                    return Some("Paste an API key or choose a sign-in/local option.");
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
    fn provider_factory_preserves_local_and_hosted_defaults() {
        assert_eq!(
            make_onboarding_provider(ProviderChoice::OpenaiSignin, ""),
            None
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::OpenaiKey, ""),
            Some(OnboardingProvider {
                id: "custom:onboarding-openai".into(),
                kind: ProviderKind::Openai,
                label: "OpenAI".into(),
                base_url: "https://api.openai.com/v1".into(),
                models: vec!["gpt-4.1".into(), "gpt-4.1-mini".into()],
                default_model: Some("gpt-4.1-mini".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Anthropic, "https://gateway.example/v1"),
            Some(OnboardingProvider {
                id: "custom:onboarding-anthropic".into(),
                kind: ProviderKind::Anthropic,
                label: "Anthropic".into(),
                base_url: "https://gateway.example/v1".into(),
                models: vec!["claude-sonnet-4-5".into(), "claude-haiku-4-5".into()],
                default_model: Some("claude-sonnet-4-5".into()),
                needs_key: true,
                deployment: ProviderDeployment::Hosted,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::LmStudio, ""),
            Some(OnboardingProvider {
                id: "custom:onboarding-lmstudio".into(),
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
                id: "custom:onboarding-ollama".into(),
                kind: ProviderKind::Openai,
                label: "Ollama (local)".into(),
                base_url: "http://127.0.0.1:11434/v1".into(),
                models: vec![],
                default_model: None,
                needs_key: false,
                deployment: ProviderDeployment::Local,
            })
        );

        assert_eq!(
            make_onboarding_provider(ProviderChoice::Tailscale, "https://model.tailnet.ts.net/v1"),
            Some(OnboardingProvider {
                id: "custom:onboarding-tailscale".into(),
                kind: ProviderKind::Openai,
                label: "Tailscale model".into(),
                base_url: "https://model.tailnet.ts.net/v1".into(),
                models: vec![],
                default_model: None,
                needs_key: false,
                deployment: ProviderDeployment::Local,
            })
        );
    }

    #[test]
    fn factory_trims_base_urls_and_keeps_tailscale_raw() {
        let provider =
            make_onboarding_provider(ProviderChoice::Anthropic, "  https://gateway.example/v1  ")
                .expect("anthropic provider");
        assert_eq!(provider.base_url, "https://gateway.example/v1");
        assert_eq!(
            make_onboarding_provider(ProviderChoice::Tailscale, "")
                .expect("tailscale provider")
                .base_url,
            "",
            "TS passes the raw (possibly empty) tailnet URL through"
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

        // Tailscale requires the tailnet URL.
        machine.choice = ProviderChoice::Tailscale;
        assert_eq!(
            machine.validate(),
            Some("Enter the Tailscale model server URL before continuing.")
        );
        machine.base_url = "https://model.tailnet.ts.net/v1".into();
        assert_eq!(machine.validate(), None);

        // Key-requiring choices require a key.
        machine.choice = ProviderChoice::Anthropic;
        assert_eq!(
            machine.validate(),
            Some("Paste an API key or choose a sign-in/local option.")
        );
        machine.api_key = "  sk-ant-abcdef  ".into();
        assert_eq!(
            machine.validate(),
            None,
            "a non-empty (untrimmed) key passes TS too"
        );

        // Local / sign-in choices never require a key.
        machine.choice = ProviderChoice::LmStudio;
        machine.api_key.clear();
        assert_eq!(machine.validate(), None);
        machine.choice = ProviderChoice::OpenaiSignin;
        assert_eq!(machine.validate(), None);
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
            Some("custom:onboarding-anthropic")
        );

        machine.choice = ProviderChoice::LmStudio;
        assert_eq!(machine.pending_provider_save().api_key, None);

        machine.choice = ProviderChoice::OpenaiSignin;
        assert_eq!(machine.pending_provider_save().provider, None);
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
        assert_eq!(machine.current(), Step::Provider);
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.current(), Step::Model);

        let options = machine.model_options();
        assert_eq!(
            options,
            vec![
                OnboardingModelOption {
                    id: "claude-sonnet-4-5".into(),
                    is_default: true
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
            Some((
                "custom:onboarding-anthropic".to_string(),
                "claude-sonnet-4-5".to_string()
            ))
        );

        machine.set_model(Some("claude-haiku-4-5".into()));
        assert_eq!(
            machine.selection(),
            Some((
                "custom:onboarding-anthropic".to_string(),
                "claude-haiku-4-5".to_string()
            ))
        );
    }

    #[test]
    fn model_step_without_a_provider_offers_the_catalog() {
        let mut machine = OnboardingMachine::new();
        machine.name = "Ada".into();
        machine.next();
        // Skip the provider save (e.g. openai-signin path) and use the catalog.
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
    fn blocked_advance_sets_the_error_and_clear_resets_it() {
        let mut machine = OnboardingMachine::new();
        assert_eq!(machine.next(), NextOutcome::Blocked);
        assert!(machine.error.is_some());
        machine.name = "Ada".into();
        assert_eq!(machine.next(), NextOutcome::Advanced);
        assert_eq!(machine.error, None);
    }
}

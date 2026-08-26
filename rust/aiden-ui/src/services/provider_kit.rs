//! Provider catalog + streaming dispatch for the chat service.
//!
//! The catalog is built from the *portable config* (`ConfigStore::list_providers`)
//! — anthropic, openai, and `custom:` base-URL providers — plus the keychain
//! state attached to each (`hasKey`). Streaming dispatches through the
//! aiden-providers transports on the tokio runtime and forwards batched
//! updates over a channel to the GPUI foreground (see [`drive_stream`]).

use std::collections::HashMap;
use std::sync::Arc;

use aiden_agent::llm_client::{
    project_user_chat_message, TerminalTimelineStatus, TimelineProjector, ToolFinishStatus,
};
use aiden_agent::{
    build_coding_tool_executor_with_cancellation, AllowAllApprovalPolicy, ApprovalPolicy,
    ApprovalVerdict, CodingToolExecutor, ToolCancellation, ToolExecutor,
};
use aiden_core::{
    anthropic_thinking_can_disable, anthropic_thinking_levels_for_model,
    codex_thinking_levels_for_model, google_thinking_can_disable, google_thinking_levels_for_model,
    normalize_anthropic_thinking_level, normalize_codex_thinking_level,
    normalize_google_thinking_level, validate_message_attachments,
    AnthropicThinkingModelCapabilities, AssistantMessage, AssistantMessageEvent, ChatMessage,
    ChatRole, CodexThinkingModelCapabilities, ContentBlock, GenerationThinkingLevel,
    GenerationTimeline, GoogleThinkingModelCapabilities, Message, StopReason, TextContent, ToolDef,
    ToolResultMessage, Usage,
};
use aiden_data::config_store::Provider as StoredProvider;
use aiden_data::portable_config::{ProviderKind, Skill, WorkspacePermission};
use aiden_data::skill_discovery::{
    discover_skills, supporting_skill_files_with_root, DiscoveredSkill, DiscoveredSkillSource,
};
use aiden_providers::catalog::{self, Modality};
use aiden_providers::codex::{CodexAuthStore, CodexProvider, OPENAI_CODEX_PROVIDER_ID};
use aiden_providers::compact::{
    assert_generation_context_capacity, compact_generation_context, GenerationContextCompaction,
    GenerationContextOptions,
};
use aiden_providers::google::{GoogleProvider, GOOGLE_PROVIDER_ID};
use aiden_providers::list::CodexProviderSnapshot;
use aiden_providers::provider_error_message;
use aiden_providers::web_search::{
    render_tool_result as render_web_search_result, ExaClient, ExaSearchQuery,
    EXA_MAX_TEXT_CHARACTERS,
};
use aiden_providers::{
    anthropic::AnthropicProvider, openai_completions::OpenAICompletionsProvider, ApiFamily,
    Provider, StreamOptions, StreamRequest, ThinkingLevel,
};

use crate::approvals::approval_bridge::ApprovalBridge;
use crate::services::mcp_tools::{
    collect_chat_mcp_tools, ChatMcpTools, McpStreamContext, CHAT_MCP_CALL_TIMEOUT_MS,
};
use crate::services::stream::{
    message_content, tool_calls_of, zero_usage, zero_usage_message, StreamReducer, StreamTerminal,
};

/// Channel message sent from the streaming driver to the foreground.
#[derive(Debug)]
pub enum StreamMsg {
    /// Batched incremental append (text/thinking deltas since the last flush).
    Flush {
        text: String,
        thinking: String,
        thinking_active: Option<bool>,
    },
    /// A live generation-timeline snapshot (thinking/tool steps). Sent on
    /// every recorded transition; the foreground mirrors it onto the
    /// generation state so the live message renders tool activity.
    Timeline { timeline: Box<GenerationTimeline> },
    /// A mutating coding tool is paused until the chat UI resolves this
    /// renderer-safe approval envelope.
    ApprovalRequired { details: serde_json::Value },
    /// Terminal success: the final assistant message + full text/thinking.
    Done {
        message: Box<AssistantMessage>,
        full_text: String,
        full_thinking: String,
        usage: Usage,
    },
    /// Terminal failure.
    Error {
        message: String,
        partial_text: String,
        partial_thinking: String,
        usage: Usage,
    },
}

/// One provider as configured on disk (the model-picker catalog entry).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfiguredProvider {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub models: Vec<String>,
    pub default_model: Option<String>,
    /// Per-model metadata reported by explicit discovery (drives request-time
    /// reasoning/vision/context limits for the selected model).
    pub model_metadata: HashMap<String, aiden_data::portable_config::ProviderModelMetadata>,
    pub needs_key: bool,
    pub has_key: bool,
}

/// The pi-ai API family a provider dispatches through — the `resolveModelRuntimeWith`
/// routing funnel ported to the chat driver:
///
/// 1. `openai-codex` → `openai-codex-responses` (id check, before kind);
/// 2. `google` → `google-generative-ai` (id check — the stored record is
///    `kind: "openai"` but streams through Google's native transport);
/// 3. anthropic-kind → `anthropic-messages`;
/// 4. everything else (openai, deepseek, moonshotai, `custom:*`) →
///    `openai-completions`.
pub fn resolve_api_family(provider_id: &str, kind: ProviderKind) -> ApiFamily {
    if provider_id == OPENAI_CODEX_PROVIDER_ID {
        return ApiFamily::OpenAICodexResponses;
    }
    if provider_id == GOOGLE_PROVIDER_ID {
        return ApiFamily::GoogleGenerativeAi;
    }
    match kind {
        ProviderKind::Anthropic => ApiFamily::AnthropicMessages,
        ProviderKind::Openai => ApiFamily::OpenAICompletions,
    }
}

impl ConfiguredProvider {
    pub fn offers_model(&self, model: &str) -> bool {
        self.default_model.as_deref() == Some(model)
            || self.models.iter().any(|candidate| candidate == model)
    }

    /// The pi-ai API family this provider dispatches through.
    pub fn api_family(&self) -> ApiFamily {
        resolve_api_family(&self.id, self.kind)
    }

    /// The concrete transport registered for this provider's API family. The
    /// transport's fixed info id (`anthropic`, `google`, `openai-completions`)
    /// is decoupled from the *configured* provider id so `custom:` providers
    /// work; the request still carries the configured id for auth + headers.
    pub fn transport(&self, codex_auth: Arc<dyn CodexAuthStore>) -> Arc<dyn Provider> {
        match self.api_family() {
            ApiFamily::OpenAICodexResponses => {
                Arc::new(CodexProvider::new(codex_auth).with_base_url(self.base_url.clone()))
            }
            ApiFamily::GoogleGenerativeAi => Arc::new(GoogleProvider::new()),
            ApiFamily::AnthropicMessages => Arc::new(
                AnthropicProvider::new().with_base_url(anthropic_messages_url(&self.base_url)),
            ),
            ApiFamily::OpenAICompletions => Arc::new(OpenAICompletionsProvider::with_base_url(
                self.base_url.clone(),
            )),
            // `OpenAIResponses` is not a stored-provider family; the catalog
            // path that resolves it constructs its own transport.
            ApiFamily::OpenAIResponses => Arc::new(OpenAICompletionsProvider::with_base_url(
                self.base_url.clone(),
            )),
        }
    }
}

impl From<&StoredProvider> for ConfiguredProvider {
    fn from(provider: &StoredProvider) -> Self {
        let mut configured = Self {
            id: provider.id.clone(),
            label: provider.label.clone(),
            kind: provider.kind,
            base_url: provider.base_url.clone(),
            models: provider.models.clone(),
            default_model: provider.default_model.clone(),
            model_metadata: provider
                .model_metadata
                .clone()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            needs_key: provider.needs_key,
            has_key: provider.has_key,
        };
        // Electron's native Anthropic provider projects Pi's builtin model
        // metadata into the picker. The portable preset intentionally stores
        // only the model ids, so restore that provider-owned declaration at
        // the renderer boundary instead of treating missing metadata as an
        // unrestricted composer capability.
        if configured.id == aiden_providers::builtin::ANTHROPIC_PROVIDER_ID {
            for model_id in &configured.models {
                if configured.model_metadata.contains_key(model_id) {
                    continue;
                }
                let Some(model) = aiden_providers::builtin::builtin_model(
                    aiden_providers::builtin::ANTHROPIC_PROVIDER_ID,
                    model_id,
                ) else {
                    continue;
                };
                let capabilities = AnthropicThinkingModelCapabilities {
                    reasoning: Some(model.reasoning),
                    thinking_level_map: Some(
                        model
                            .thinking_level_map
                            .iter()
                            .map(|(key, value)| ((*key).to_string(), value.map(str::to_string)))
                            .collect(),
                    ),
                };
                configured.model_metadata.insert(
                    model_id.clone(),
                    aiden_data::portable_config::ProviderModelMetadata {
                        source: aiden_data::portable_config::ProviderModelMetadataSource::Provider,
                        name: Some(model.name.to_string()),
                        r#type: None,
                        vision: Some(model.vision),
                        tool_call: Some(true),
                        reasoning: Some(model.reasoning),
                        thinking_levels: Some(
                            anthropic_thinking_levels_for_model(&capabilities)
                                .into_iter()
                                .filter_map(|level| match level.as_str() {
                                    "off" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::Off,
                                    ),
                                    "low" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::Low,
                                    ),
                                    "medium" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::Medium,
                                    ),
                                    "high" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::High,
                                    ),
                                    "xhigh" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::Xhigh,
                                    ),
                                    "max" => Some(
                                        aiden_data::portable_config::GenerationThinkingLevel::Max,
                                    ),
                                    _ => None,
                                })
                                .collect(),
                        ),
                        thinking_can_disable: Some(anthropic_thinking_can_disable(&capabilities)),
                        context_length: Some(model.context_window as u64),
                        parameter_count: None,
                        format: None,
                    },
                );
            }
        }
        configured
    }
}

/// Apply Electron's virtual-provider rule to the normal-chat catalog: stale
/// portable records using the reserved id are always removed, and the Codex
/// entry exists only while the shared OAuth status is healthy.
pub fn merge_codex_configured_provider(
    providers: impl IntoIterator<Item = ConfiguredProvider>,
    snapshot: &CodexProviderSnapshot,
) -> Vec<ConfiguredProvider> {
    let mut providers: Vec<_> = providers
        .into_iter()
        .filter(|provider| provider.id != OPENAI_CODEX_PROVIDER_ID)
        .collect();
    if !snapshot.configured || snapshot.needs_attention || snapshot.models.is_empty() {
        return providers;
    }

    let mut models = Vec::new();
    let mut model_metadata = HashMap::new();
    for model in &snapshot.models {
        if !models.contains(&model.id) {
            models.push(model.id.clone());
        }
        let thinking_levels = model
            .thinking_levels
            .iter()
            .filter_map(|level| match level.as_str() {
                "off" => Some(aiden_data::portable_config::GenerationThinkingLevel::Off),
                "low" => Some(aiden_data::portable_config::GenerationThinkingLevel::Low),
                "medium" => Some(aiden_data::portable_config::GenerationThinkingLevel::Medium),
                "high" => Some(aiden_data::portable_config::GenerationThinkingLevel::High),
                "xhigh" => Some(aiden_data::portable_config::GenerationThinkingLevel::Xhigh),
                "max" => Some(aiden_data::portable_config::GenerationThinkingLevel::Max),
                _ => None,
            })
            .collect();
        model_metadata.insert(
            model.id.clone(),
            aiden_data::portable_config::ProviderModelMetadata {
                source: aiden_data::portable_config::ProviderModelMetadataSource::Provider,
                name: Some(model.name.clone()),
                r#type: None,
                vision: Some(model.vision),
                tool_call: Some(true),
                reasoning: Some(model.reasoning),
                thinking_levels: Some(thinking_levels),
                thinking_can_disable: Some(true),
                context_length: Some(model.context_window),
                parameter_count: None,
                format: None,
            },
        );
    }
    let default_model = if models
        .iter()
        .any(|model| model == aiden_providers::codex::OPENAI_CODEX_DEFAULT_MODEL)
    {
        aiden_providers::codex::OPENAI_CODEX_DEFAULT_MODEL.to_string()
    } else {
        models[0].clone()
    };
    providers.push(ConfiguredProvider {
        id: OPENAI_CODEX_PROVIDER_ID.to_string(),
        label: aiden_providers::codex::OPENAI_CODEX_PROVIDER_LABEL.to_string(),
        kind: ProviderKind::Openai,
        base_url: aiden_providers::codex::OPENAI_CODEX_BASE_URL.to_string(),
        models,
        default_model: Some(default_model),
        model_metadata,
        needs_key: true,
        has_key: true,
    });
    providers
}

/// The Messages endpoint for a configured Anthropic-compatible base URL:
/// `resolveRuntimeBaseUrl` (drop a trailing `/v1`) + pi-ai's `/v1/messages`
/// suffix. A base URL that already ends in `/v1/messages` is used verbatim.
pub fn anthropic_messages_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1/messages") {
        return trimmed.to_string();
    }
    let stripped = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    format!("{stripped}/v1/messages")
}

/// A fully-resolved selection: provider + model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelection {
    pub provider_id: String,
    pub model: String,
}

impl ModelSelection {
    /// `providerId`/`model` — the key used by the settings persistence.
    pub fn to_settings(&self) -> serde_json::Value {
        serde_json::json!({
            "providerId": self.provider_id,
            "model": self.model,
        })
    }

    pub fn from_settings(value: &serde_json::Value) -> Option<Self> {
        let provider_id = value.get("providerId")?.as_str()?.to_string();
        let model = value.get("model")?.as_str()?.to_string();
        if provider_id.is_empty() || model.is_empty() {
            return None;
        }
        Some(Self { provider_id, model })
    }
}

/// A snapshot of everything the background driver needs for one turn.
#[derive(Debug, Clone)]
pub struct TurnSnapshot {
    pub provider: ConfiguredProvider,
    pub selection: ModelSelection,
    /// Model-aware effort captured when Send is admitted. Every tool-driven
    /// follow-up uses the same level even if Settings changes mid-generation.
    pub thinking_level: GenerationThinkingLevel,
    /// Stable chat identity used for provider prompt-cache/session affinity.
    pub session_id: String,
    pub messages: Vec<Message>,
    pub system_prompt: Option<String>,
    /// Optional MCP tool wiring: when enabled servers are configured, the
    /// driver collects their tools into the request and dispatches model tool
    /// calls through the manager (bounded multi-round loop).
    pub mcp: Option<McpStreamContext>,
    /// User-enabled Exa surface captured for this generation. The key itself
    /// is resolved separately on the driver thread and never stored here.
    pub web_search: Option<WebSearchStreamContext>,
    /// Folder-scoped coding tools for a normal project chat. `None` means the
    /// current workspace has no authorized folder capability.
    pub coding: Option<CodingStreamContext>,
    /// Enabled inline Agent Skills captured at generation start. Each becomes
    /// a callable instruction-loading tool and is listed in the system prompt.
    pub skills: Vec<Skill>,
    /// Workspace facts used to rebuild the prompt after background skill and
    /// branch discovery, including read-only/no-tool generations.
    pub prompt: WorkspacePromptContext,
}

/// Renderer-safe model-aware thinking control for the selected connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThinkingControlSnapshot {
    pub provider_label: &'static str,
    pub level: GenerationThinkingLevel,
    pub levels: Vec<GenerationThinkingLevel>,
    pub can_disable: bool,
}

/// Resolve the exact Electron composer contract from the connection-bound
/// runtime metadata plus the persisted per-model preference map.
pub fn resolve_thinking_control(
    provider: &ConfiguredProvider,
    selection: &ModelSelection,
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Option<ThinkingControlSnapshot> {
    if provider.id != selection.provider_id || !provider.offers_model(&selection.model) {
        return None;
    }
    let stored = catalog_provider(provider);
    let limits = catalog::resolve_provider_runtime_limits(None, &stored, &selection.model, None);
    let map = limits.thinking_level_map.as_ref().map(|map| {
        map.iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    });
    let preference = |key: &str| {
        settings
            .get(key)
            .and_then(serde_json::Value::as_object)
            .and_then(|preferences| preferences.get(&selection.model))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let to_generation = |value: &str| GenerationThinkingLevel::from_str(value);
    let declared = provider.model_metadata.get(&selection.model);
    let declared_levels = declared.and_then(|metadata| metadata.thinking_levels.as_ref());
    let declared_supports = |level: &str| {
        declared_levels
            .is_some_and(|levels| levels.iter().any(|declared| declared.as_str() == level))
    };

    if provider.id == aiden_providers::google::GOOGLE_PROVIDER_ID {
        let capabilities = GoogleThinkingModelCapabilities {
            reasoning: Some(limits.reasoning),
            thinking_level_map: map.clone(),
        };
        let mut native_levels = google_thinking_levels_for_model(&capabilities);
        if declared_levels.is_some_and(|levels| !levels.is_empty()) {
            // Electron always offers the UI's Off state for Gemini even when
            // provider metadata omits it; the model capability separately
            // decides whether Off can actually disable provider thinking.
            native_levels
                .retain(|level| level.as_str() == "off" || declared_supports(level.as_str()));
        }
        if native_levels.is_empty() {
            return None;
        }
        let level =
            normalize_google_thinking_level(&native_levels, &preference("googleThinkingByModel"));
        return Some(ThinkingControlSnapshot {
            provider_label: "Gemini",
            level: to_generation(level.as_str())?,
            levels: native_levels
                .iter()
                .filter_map(|level| to_generation(level.as_str()))
                .collect(),
            can_disable: declared
                .and_then(|metadata| metadata.thinking_can_disable)
                .unwrap_or_else(|| google_thinking_can_disable(&capabilities)),
        });
    }
    if provider.id == OPENAI_CODEX_PROVIDER_ID {
        if !declared_levels.is_some_and(|levels| !levels.is_empty()) {
            return None;
        }
        let capabilities = CodexThinkingModelCapabilities {
            reasoning: Some(limits.reasoning),
            thinking_level_map: map.clone(),
        };
        let mut native_levels = codex_thinking_levels_for_model(&capabilities);
        native_levels.retain(|level| declared_supports(level.as_str()));
        if native_levels.is_empty() {
            return None;
        }
        let level =
            normalize_codex_thinking_level(&native_levels, &preference("codexThinkingByModel"));
        return Some(ThinkingControlSnapshot {
            provider_label: "Codex",
            level: to_generation(level.as_str())?,
            levels: native_levels
                .iter()
                .filter_map(|level| to_generation(level.as_str()))
                .collect(),
            can_disable: true,
        });
    }
    if provider.id == aiden_providers::builtin::ANTHROPIC_PROVIDER_ID {
        if !declared_levels.is_some_and(|levels| !levels.is_empty()) {
            return None;
        }
        let capabilities = AnthropicThinkingModelCapabilities {
            reasoning: Some(limits.reasoning),
            thinking_level_map: map,
        };
        let mut native_levels = anthropic_thinking_levels_for_model(&capabilities);
        native_levels.retain(|level| declared_supports(level.as_str()));
        if native_levels.is_empty() {
            return None;
        }
        let level = normalize_anthropic_thinking_level(
            &native_levels,
            &preference("anthropicThinkingByModel"),
        );
        return Some(ThinkingControlSnapshot {
            provider_label: "Claude",
            level: to_generation(level.as_str())?,
            levels: native_levels
                .iter()
                .filter_map(|level| to_generation(level.as_str()))
                .collect(),
            can_disable: declared
                .and_then(|metadata| metadata.thinking_can_disable)
                .unwrap_or_else(|| anthropic_thinking_can_disable(&capabilities)),
        });
    }
    None
}

#[derive(Clone)]
pub struct WebSearchStreamContext {
    pub client: Arc<ExaClient>,
}

impl std::fmt::Debug for WebSearchStreamContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebSearchStreamContext")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct WorkspacePromptContext {
    pub root: Option<std::path::PathBuf>,
    pub permission: WorkspacePermission,
    pub managed_branch: Option<String>,
}

/// Authorized normal-chat coding context captured at generation start.
#[derive(Clone)]
pub struct CodingStreamContext {
    pub root: std::path::PathBuf,
    pub permission: WorkspacePermission,
    pub managed_branch: Option<String>,
    pub approval: Arc<ApprovalBridge>,
    pub cancellation: ToolCancellation,
}

impl std::fmt::Debug for CodingStreamContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodingStreamContext")
            .field("root", &self.root)
            .field("permission", &self.permission)
            .field("managed_branch", &self.managed_branch)
            .finish_non_exhaustive()
    }
}

/// Map persisted chat history into the normalized `Message` union the
/// providers serialize onto the wire. System messages are dropped (the
/// phase-5 build has no system-prompt pipeline). Assistant messages are
/// stamped with the resolved API family so `transform_messages`'s
/// same-model check (`provider`/`api`/`model`) stays accurate when history is
/// replayed into an anthropic / google / codex turn — a hardcoded
/// "openai-completions" stamp would demote thinking blocks to plain text.
pub fn chat_history_to_messages(
    history: &[ChatMessage],
    default_model: &str,
    default_provider: &str,
    default_api: ApiFamily,
    supports_images: bool,
) -> Vec<Message> {
    let api = default_api.as_str().to_string();
    history
        .iter()
        .filter_map(|entry| match entry.role {
            ChatRole::User => {
                let mut canonical = entry.clone();
                canonical.attachments =
                    validate_message_attachments(entry.role, entry.attachments.as_deref())
                        .ok()
                        .flatten();
                Some(Message::User(project_user_chat_message(
                    &canonical,
                    supports_images,
                    entry.created_at,
                )))
            }
            ChatRole::Assistant => Some(Message::Assistant(AssistantMessage {
                content: if entry.content.is_empty() {
                    Vec::new()
                } else {
                    vec![ContentBlock::Text(TextContent {
                        text: entry.content.clone(),
                        text_signature: None,
                    })]
                },
                api: api.clone(),
                provider: default_provider.to_string(),
                model: entry
                    .model
                    .clone()
                    .unwrap_or_else(|| default_model.to_string()),
                response_model: None,
                response_id: None,
                usage: zero_usage(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: entry.created_at,
            })),
            ChatRole::System => None,
        })
        .collect()
}

/// Connection-bound image authority captured when a generation is admitted.
/// This uses the same discovered-over-Pi-exact runtime limits as the eventual
/// request template, so replay never gains images from a provider-global hint.
pub fn configured_provider_supports_images(provider: &ConfiguredProvider, model_id: &str) -> bool {
    let stored = catalog_provider(provider);
    catalog::resolve_provider_runtime_limits(None, &stored, model_id, None)
        .input
        .contains(&Modality::Image)
}

/// Build the normalized `StreamRequest` for one turn.
#[allow(dead_code)] // convenience wrapper; the driver uses the tools variant
pub fn build_stream_request(snapshot: &TurnSnapshot) -> StreamRequest {
    build_stream_request_with_tools(snapshot, &[], snapshot.messages.clone())
}

/// Build the normalized `StreamRequest` for one turn with an explicit tool
/// surface and message list (the driver re-invokes this after each tool round
/// with the appended tool results).
pub fn build_stream_request_with_tools(
    snapshot: &TurnSnapshot,
    tools: &[aiden_core::ToolDef],
    messages: Vec<Message>,
) -> StreamRequest {
    let model_id = &snapshot.selection.model;
    // `buildModel` (model-runtime-core.ts): request-time limits are pi-exact
    // builtin metadata overridden by connection-discovered metadata, then the
    // conservative fallback. Discovered fields win because the builtin record
    // is the *fallback* layer (`resolveProviderRuntimeLimits`).
    let stored = catalog_provider(&snapshot.provider);
    let limits = catalog::resolve_provider_runtime_limits(None, &stored, model_id, None);
    StreamRequest {
        provider_id: snapshot.selection.provider_id.clone(),
        api: snapshot.provider.api_family(),
        model: model_id.clone(),
        base_url: snapshot.provider.base_url.clone(),
        reasoning: limits.reasoning,
        thinking_level_map: limits.thinking_level_map,
        force_adaptive_thinking: limits.force_adaptive_thinking,
        vision: limits.input.contains(&Modality::Image),
        context_window: limits.context_window,
        max_tokens_limit: limits.max_tokens,
        messages,
        system_prompt: snapshot.system_prompt.clone(),
        max_tokens: None,
        session_id: Some(snapshot.session_id.clone()),
        thinking_level: match snapshot.thinking_level {
            GenerationThinkingLevel::Off => None,
            GenerationThinkingLevel::Low => Some(ThinkingLevel::Low),
            GenerationThinkingLevel::Medium => Some(ThinkingLevel::Medium),
            GenerationThinkingLevel::High => Some(ThinkingLevel::High),
            GenerationThinkingLevel::Xhigh => Some(ThinkingLevel::Xhigh),
            GenerationThinkingLevel::Max => Some(ThinkingLevel::Max),
        },
        tools: tools.to_vec(),
        ..Default::default()
    }
}

/// Resolve one immutable request template and the exact context budget derived
/// from it. The driver calls this only after prompt and tool discovery finish,
/// so every provider pass uses one generation-pinned model/prompt/tool surface.
fn build_generation_request_template(
    snapshot: &TurnSnapshot,
    tools: &[ToolDef],
) -> Result<(StreamRequest, GenerationContextOptions), String> {
    let request = build_stream_request_with_tools(snapshot, tools, Vec::new());
    let context = GenerationContextOptions {
        context_window: request.context_window,
        system_prompt: request.system_prompt.clone().unwrap_or_default(),
        tools: request.tools.clone(),
    };
    assert_generation_context_capacity(&context)?;
    Ok((request, context))
}

struct PreparedGenerationRequest {
    request: StreamRequest,
    compaction: GenerationContextCompaction,
}

/// Compact only the disposable provider payload. `authoritative_messages`
/// remains the complete generation-owned transcript used by later rounds.
fn prepare_generation_request(
    template: &StreamRequest,
    context: &GenerationContextOptions,
    authoritative_messages: &[Message],
) -> PreparedGenerationRequest {
    let mut compaction = compact_generation_context(authoritative_messages.to_vec(), context);
    let mut request = template.clone();
    request.messages = std::mem::take(&mut compaction.messages);
    if compaction.used_context_fallback {
        // The fallback replaces the active request with a recovery notice. It
        // must never retain a mutation capability solely because a provider
        // hallucinates a tool call in response to that notice.
        request.tools.clear();
    }
    PreparedGenerationRequest {
        request,
        compaction,
    }
}

const FALLBACK_TOOL_CALL_ERROR: &str = "The model attempted to call tools after Aiden replaced an oversized context with a recovery notice. Retry with a larger-context model or fewer/lower-size attachments.";

fn fallback_tool_call_error(
    fallback_tools_disabled: bool,
    has_tool_calls: bool,
) -> Option<&'static str> {
    (fallback_tools_disabled && has_tool_calls).then_some(FALLBACK_TOOL_CALL_ERROR)
}

/// Project a `ConfiguredProvider` into the catalog's `StoredProvider` shape so
/// [`catalog::resolve_provider_runtime_limits`] can merge discovered metadata
/// with the pi-exact builtin fallback.
fn catalog_provider(provider: &ConfiguredProvider) -> catalog::StoredProvider {
    let model_metadata = if provider.model_metadata.is_empty() {
        None
    } else {
        Some(
            provider
                .model_metadata
                .iter()
                .map(|(model_id, metadata)| {
                    (
                        model_id.clone(),
                        catalog::ProviderModelMetadata {
                            source: "provider".into(),
                            name: metadata.name.clone(),
                            r#type: None,
                            vision: metadata.vision,
                            tool_call: metadata.tool_call,
                            reasoning: metadata.reasoning,
                            thinking_levels: metadata.thinking_levels.as_ref().map(|levels| {
                                levels
                                    .iter()
                                    .map(|level| level.as_str().to_string())
                                    .collect()
                            }),
                            thinking_can_disable: metadata.thinking_can_disable,
                            context_length: metadata.context_length.map(|length| length as u32),
                            parameter_count: metadata.parameter_count.clone(),
                            format: metadata.format.clone(),
                        },
                    )
                })
                .collect(),
        )
    };
    catalog::StoredProvider {
        id: provider.id.clone(),
        kind: match provider.kind {
            ProviderKind::Anthropic => catalog::ProviderKind::Anthropic,
            ProviderKind::Openai => catalog::ProviderKind::Openai,
        },
        label: provider.label.clone(),
        base_url: provider.base_url.clone(),
        models: provider.models.clone(),
        model_metadata,
        default_model: provider.default_model.clone(),
        needs_key: provider.needs_key,
        deployment: None,
        is_preset: None,
        is_builtin: None,
    }
}

/// The timeout for one provider turn.
const TURN_TIMEOUT_MS: u64 = 120_000;
/// Batched flush cadence, mirroring the renderer's rAF batching (~30ms).
const FLUSH_INTERVAL_MS: u64 = 30;
/// Bound tool-driven provider turns so a model cannot loop forever. This
/// matches the native AgentRunner's default guard.
const MAX_CHAT_TOOL_ITERATIONS: usize = 10;
/// Stop when the same canonical call set repeats without progress.
const MAX_REPEATED_CHAT_TOOL_CALLS: usize = 3;

/// Drive one provider turn on the tokio runtime, forwarding batched updates
/// into `tx`. Never panics: transport failures become a terminal
/// [`StreamMsg::Error`].
///
/// When [`TurnSnapshot::mcp`] is set, the driver first collects the enabled
/// servers' tools (bounded), passes them into the provider request, and — if
/// the model emits tool calls — dispatches each through
/// [`McpClientManager::call_tool`], appends the assistant tool-call turn and
/// normalized results in protocol order, and continues until the model
/// produces a text-only terminal turn. The loop is bounded by
/// [`MAX_CHAT_TOOL_ITERATIONS`].
#[allow(dead_code)] // retained as the keyless test/convenience entry point
pub async fn drive_stream(
    snapshot: TurnSnapshot,
    api_key: Option<String>,
    codex_auth: Arc<dyn CodexAuthStore>,
    tx: tokio::sync::mpsc::UnboundedSender<StreamMsg>,
) {
    drive_stream_with_web_key(snapshot, api_key, None, codex_auth, tx).await;
}

/// Production driver entry that receives the separately resolved, ephemeral
/// Exa key. Tests use [`drive_stream`] unless they exercise the web tool.
pub async fn drive_stream_with_web_key(
    mut snapshot: TurnSnapshot,
    api_key: Option<String>,
    web_search_api_key: Option<String>,
    codex_auth: Arc<dyn CodexAuthStore>,
    tx: tokio::sync::mpsc::UnboundedSender<StreamMsg>,
) {
    struct CancelOnDrop(Option<ToolCancellation>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            if let Some(cancellation) = &self.0 {
                cancellation.cancel();
            }
        }
    }
    let _cancel_on_drop = CancelOnDrop(
        snapshot
            .coding
            .as_ref()
            .map(|context| context.cancellation.clone()),
    );
    let discovery_root = snapshot.prompt.root.clone();
    let discovered_skills =
        tokio::task::spawn_blocking(move || discover_skills(discovery_root.as_deref()))
            .await
            .unwrap_or_default();
    let skill_tools = collect_skill_tools(&snapshot.skills, &discovered_skills);
    let skills_text = format_available_skills(&skill_tools);
    {
        // The checked-out branch can change after a managed worktree is
        // created (for example through the in-app branch picker). Inspect the
        // actual checkout every turn and use stored metadata only as fallback.
        let detected = if let Some(root) = snapshot.prompt.root.as_ref() {
            let git = aiden_git::GitService::new(aiden_git::GitServiceOptions::default());
            aiden_git::status::info(&git, root, None)
                .await
                .ok()
                .and_then(|info| info.branch)
        } else {
            None
        };
        let branch = select_workspace_branch(
            snapshot.prompt.managed_branch.as_deref(),
            detected.as_deref(),
        );
        let root = snapshot
            .prompt
            .root
            .as_ref()
            .map(|root| root.to_string_lossy());
        snapshot.system_prompt = Some(aiden_agent::build_workspace_system_prompt(
            root.as_deref(),
            branch.as_deref(),
            workspace_permission_label(snapshot.prompt.permission),
            false,
            skills_text.as_deref(),
        ));
    }

    let coding = snapshot.coding.as_ref().and_then(|context| {
        if context.permission == WorkspacePermission::None {
            return None;
        }
        let approval: Arc<dyn ApprovalPolicy> = match context.permission {
            WorkspacePermission::Ask => context.approval.clone(),
            WorkspacePermission::Full => Arc::new(AllowAllApprovalPolicy::new()),
            WorkspacePermission::None => return None,
        };
        // The driver owns the one approval boundary for every mutating coding
        // tool. The executor receives AllowAll so run_command is not prompted
        // twice by its defense-in-depth policy hook.
        let executor = Arc::new(build_coding_tool_executor_with_cancellation(
            context.root.clone(),
            Arc::new(AllowAllApprovalPolicy::new()),
            context.cancellation.clone(),
        ));
        Some(CodingExecution { executor, approval })
    });
    let web_search =
        snapshot
            .web_search
            .as_ref()
            .zip(web_search_api_key)
            .map(|(context, api_key)| WebSearchExecution {
                client: context.client.clone(),
                api_key,
            });

    // MCP tool collection (bounded, never fails the turn).
    let mcp = match &snapshot.mcp {
        Some(context) => {
            let tools =
                collect_chat_mcp_tools(&context.manager, &context.servers, &context.preset_key)
                    .await;
            Some(McpExecution {
                manager: context.manager.clone(),
                tools,
            })
        }
        None => None,
    };
    let mut tool_defs: Vec<aiden_core::ToolDef> = coding
        .as_ref()
        .map(|execution| execution.executor.tool_defs())
        .unwrap_or_default();
    // Match Electron's ordering: local coding tools, web search, configured
    // skills, then external MCP tools. Skill names are namespaced with `skill_`.
    let mcp_defs = if let Some(execution) = mcp.as_ref() {
        execution.tools.defs.clone()
    } else {
        Vec::new()
    };
    if web_search.is_some() {
        tool_defs.push(web_search_tool_def());
    }
    tool_defs.extend(skill_tools.defs.clone());
    tool_defs.extend(mcp_defs);

    // The live activity timeline for this turn; every transition is pushed to
    // the foreground so the streaming bubble renders thinking/tool steps.
    let timeline_tx = tx.clone();
    let mut projector = TimelineProjector::new(
        aiden_data::chat_store::new_uuid_like(),
        Box::new(move |timeline| {
            let _ = timeline_tx.send(StreamMsg::Timeline {
                timeline: Box::new(timeline.clone()),
            });
        }),
    );

    let (request_template, context_options) =
        match build_generation_request_template(&snapshot, &tool_defs) {
            Ok(runtime) => runtime,
            Err(message) => {
                let timeline = projector.finish(TerminalTimelineStatus::Failed);
                let _ = tx.send(StreamMsg::Timeline {
                    timeline: Box::new(timeline),
                });
                let _ = tx.send(StreamMsg::Error {
                    message,
                    partial_text: String::new(),
                    partial_thinking: String::new(),
                    usage: zero_usage(),
                });
                return;
            }
        };
    // Construct the transport only after the capacity preflight. Provider
    // constructors are currently side-effect-free, and this ordering keeps the
    // no-provider-I/O invariant explicit if that ever changes.
    let transport = snapshot.provider.transport(codex_auth);
    // Match Electron's privacy boundary: Claude/Codex reasoning still drives
    // timeline timing, but only Gemini and local providers expose raw thought
    // text in the live transcript or persisted assistant message.
    let expose_reasoning = catalog::should_expose_reasoning(&snapshot.provider.id);
    let options = StreamOptions {
        api_key,
        timeout_ms: Some(TURN_TIMEOUT_MS),
        ..Default::default()
    };
    let mut messages = snapshot.messages.clone();
    let mut tool_rounds = 0usize;
    let mut accumulated_text = String::new();
    let mut accumulated_thinking = String::new();
    let mut accumulated_usage = zero_usage();
    let mut last_tool_signatures: Option<Vec<(String, String)>> = None;
    let mut repeated_tool_streak = 0usize;

    // Continue until the model stops calling tools. Every continuation carries
    // the assistant tool-call message immediately before its tool results.
    loop {
        let prepared = prepare_generation_request(&request_template, &context_options, &messages);
        let fallback_tools_disabled = prepared.compaction.used_context_fallback;
        if prepared.compaction.compacted {
            tracing::info!(
                model = %snapshot.selection.model,
                estimated_tokens_before = prepared.compaction.estimated_tokens_before,
                estimated_tokens_after = prepared.compaction.estimated_tokens_after,
                input_budget_tokens = prepared.compaction.input_budget_tokens,
                truncated_tool_results = prepared.compaction.truncated_tool_results,
                compacted_tool_results = prepared.compaction.compacted_tool_results,
                removed_history_messages = prepared.compaction.removed_history_messages,
                removed_current_turn_messages = prepared.compaction.removed_current_turn_messages,
                used_context_fallback = prepared.compaction.used_context_fallback,
                "compacted generation context"
            );
        }
        let request = prepared.request;
        let mut reducer = StreamReducer::new();
        let mut boundary = FlushBoundary {
            text: !accumulated_text.is_empty(),
            thinking: !accumulated_thinking.is_empty(),
        };
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

        match transport.stream_simple(&request, &options) {
            Ok(mut stream) => {
                use futures::StreamExt;
                loop {
                    tokio::select! {
                        maybe_event = stream.next() => match maybe_event {
                            Some(Ok(event)) => {
                                project_timeline_event(&mut projector, &event);
                                apply_stream_event(&mut reducer, event, expose_reasoning);
                            }
                            Some(Err(error)) => {
                                reducer.fail(provider_error_message(&error));
                                break;
                            }
                            None => break,
                        },
                        _ = interval.tick() => {
                            send_flush(&mut reducer, &tx, &mut boundary);
                        }
                    }
                }
            }
            Err(error) => {
                reducer.fail(provider_error_message(&error));
            }
        }
        send_flush(&mut reducer, &tx, &mut boundary);

        // Defensive: a provider stream that ended without a terminal event
        // (no Done/Error arrived) must not be mistaken for a successful empty
        // turn — surface it as a failure so partial content is preserved and
        // the user sees an error banner instead of a silent truncation.
        if reducer.failure.is_none() && reducer.final_message.is_none() {
            reducer.fail("Stream ended without a terminal event.");
        }

        if reducer.failure.is_some() {
            add_usage(&mut accumulated_usage, &reducer.usage);
            let timeline = projector.finish(TerminalTimelineStatus::Failed);
            let _ = tx.send(StreamMsg::Timeline {
                timeline: Box::new(timeline),
            });
            match reducer.finalize() {
                StreamTerminal::Error {
                    message,
                    mut partial_text,
                    mut partial_thinking,
                    ..
                } => {
                    partial_text = join_provider_turns(&accumulated_text, &partial_text);
                    partial_thinking = visible_failure_thinking(
                        expose_reasoning,
                        &accumulated_thinking,
                        &partial_thinking,
                    );
                    let _ = tx.send(StreamMsg::Error {
                        message,
                        partial_text,
                        partial_thinking,
                        usage: accumulated_usage,
                    });
                }
                StreamTerminal::Done { .. } => unreachable!("a failing reducer finalizes as Error"),
            }
            return;
        }

        let final_message = reducer
            .final_message
            .clone()
            .unwrap_or_else(zero_usage_message);
        let (turn_text, raw_turn_thinking) = message_content(&final_message);
        let turn_thinking = visible_thinking(expose_reasoning, raw_turn_thinking);
        accumulated_text = join_provider_turns(&accumulated_text, &turn_text);
        accumulated_thinking = join_provider_turns(&accumulated_thinking, &turn_thinking);
        add_usage(&mut accumulated_usage, &final_message.usage);
        let tool_calls = tool_calls_of(&final_message);
        // A provider can still emit an unknown/hallucinated call even when no
        // tools were offered. Feed a fail-closed tool result back instead of
        // silently treating the call-only response as success.
        let dispatch_ready = !tool_calls.is_empty();
        if dispatch_ready {
            if let Some(message) = fallback_tool_call_error(fallback_tools_disabled, true) {
                let timeline = projector.finish(TerminalTimelineStatus::Failed);
                let _ = tx.send(StreamMsg::Timeline {
                    timeline: Box::new(timeline),
                });
                let _ = tx.send(StreamMsg::Error {
                    message: message.to_string(),
                    partial_text: accumulated_text,
                    partial_thinking: accumulated_thinking,
                    usage: accumulated_usage,
                });
                return;
            }
            if tool_rounds >= MAX_CHAT_TOOL_ITERATIONS {
                let timeline = projector.finish(TerminalTimelineStatus::Failed);
                let _ = tx.send(StreamMsg::Timeline {
                    timeline: Box::new(timeline),
                });
                let _ = tx.send(StreamMsg::Error {
                    message: format!(
                        "The model exceeded the maximum number of tool iterations ({MAX_CHAT_TOOL_ITERATIONS})."
                    ),
                    partial_text: accumulated_text,
                    partial_thinking: accumulated_thinking,
                    usage: accumulated_usage,
                });
                return;
            }
            let signatures = tool_call_signatures(&tool_calls);
            if last_tool_signatures.as_ref() == Some(&signatures) {
                repeated_tool_streak += 1;
                if repeated_tool_streak >= MAX_REPEATED_CHAT_TOOL_CALLS {
                    let timeline = projector.finish(TerminalTimelineStatus::Failed);
                    let _ = tx.send(StreamMsg::Timeline {
                        timeline: Box::new(timeline),
                    });
                    let _ = tx.send(StreamMsg::Error {
                        message: "The model repeated the same tool calls without making progress."
                            .to_string(),
                        partial_text: accumulated_text,
                        partial_thinking: accumulated_thinking,
                        usage: accumulated_usage,
                    });
                    return;
                }
            } else {
                repeated_tool_streak = 0;
            }
            last_tool_signatures = Some(signatures);
            tool_rounds += 1;
            // Tool results are invalid without the assistant turn that
            // declared their ids. Preserve it before dispatching calls.
            begin_tool_round(&mut messages, &final_message);
            for call in &tool_calls {
                let result = if final_message.stop_reason == StopReason::Length {
                    projector.tool_finished(&call.id, ToolFinishStatus::Failed);
                    truncated_tool_call_result(call)
                } else {
                    execute_tool_call(
                        &mut projector,
                        coding.as_ref(),
                        web_search.as_ref(),
                        &skill_tools,
                        mcp.as_ref(),
                        call,
                        &tx,
                    )
                    .await
                };
                messages.push(Message::ToolResult(ToolResultMessage {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    content: vec![ContentBlock::Text(TextContent {
                        text: result.text,
                        text_signature: None,
                    })],
                    details: None,
                    added_tool_names: None,
                    is_error: result.is_error,
                    timestamp: aiden_data::now_millis(),
                }));
            }
            continue;
        }

        // Settled success: the turn produced a final assistant message without
        // another dispatchable tool round.
        let terminal = reducer.finalize();
        match terminal {
            StreamTerminal::Done { message } => {
                let timeline = projector.finish(TerminalTimelineStatus::Completed);
                let _ = tx.send(StreamMsg::Timeline {
                    timeline: Box::new(timeline),
                });
                let _ = tx.send(StreamMsg::Done {
                    message,
                    full_text: accumulated_text,
                    full_thinking: accumulated_thinking,
                    usage: accumulated_usage,
                });
            }
            StreamTerminal::Error { .. } => unreachable!("failure handled above"),
        }
        return;
    }
}

fn workspace_permission_label(permission: WorkspacePermission) -> &'static str {
    match permission {
        WorkspacePermission::Full => "full",
        WorkspacePermission::Ask => "ask",
        WorkspacePermission::None => "none",
    }
}

fn select_workspace_branch(managed: Option<&str>, detected: Option<&str>) -> Option<String> {
    detected
        .filter(|branch| !branch.trim().is_empty())
        .or_else(|| managed.filter(|branch| !branch.trim().is_empty()))
        .map(str::to_string)
}

/// Preserve the provider's tool-call turn before its results. Keeping this as
/// a small pure seam makes the cross-provider transcript invariant testable.
fn begin_tool_round(messages: &mut Vec<Message>, assistant: &AssistantMessage) {
    messages.push(Message::Assistant(assistant.clone()));
}

fn tool_call_signatures(calls: &[aiden_core::ToolCall]) -> Vec<(String, String)> {
    let mut signatures: Vec<(String, String)> = calls
        .iter()
        .map(|call| {
            let arguments = aiden_core::canonical_parsed_json(&call.arguments)
                .unwrap_or_else(|_| "{}".to_string());
            (call.name.clone(), arguments)
        })
        .collect();
    signatures.sort();
    signatures
}

/// Aggregate usage across every provider pass in a tool loop. Counts saturate
/// instead of wrapping if a malformed provider reports pathological values.
fn add_usage(total: &mut Usage, turn: &Usage) {
    total.input = total.input.saturating_add(turn.input);
    total.output = total.output.saturating_add(turn.output);
    total.cache_read = total.cache_read.saturating_add(turn.cache_read);
    total.cache_write = total.cache_write.saturating_add(turn.cache_write);
    total.cache_write_1h = match (total.cache_write_1h, turn.cache_write_1h) {
        (None, None) => None,
        (left, right) => Some(left.unwrap_or(0).saturating_add(right.unwrap_or(0))),
    };
    total.reasoning = match (total.reasoning, turn.reasoning) {
        (None, None) => None,
        (left, right) => Some(left.unwrap_or(0).saturating_add(right.unwrap_or(0))),
    };
    total.total_tokens = total.total_tokens.saturating_add(turn.total_tokens);
    total.cost.input += turn.cost.input;
    total.cost.output += turn.cost.output;
    total.cost.cache_read += turn.cost.cache_read;
    total.cost.cache_write += turn.cost.cache_write;
    total.cost.total += turn.cost.total;
}

fn join_provider_turns(accumulated: &str, turn: &str) -> String {
    match (accumulated.is_empty(), turn.is_empty()) {
        (true, _) => turn.to_string(),
        (_, true) => accumulated.to_string(),
        (false, false) => format!("{accumulated}\n\n{turn}"),
    }
}

/// The manager + collected tool surface the driver executes tool calls with.
struct McpExecution {
    manager: Arc<aiden_mcp::McpClientManager>,
    tools: ChatMcpTools,
}

/// Folder-scoped coding executor plus the permission policy captured for this
/// generation. Both are immutable after the turn starts.
struct CodingExecution {
    executor: Arc<CodingToolExecutor>,
    approval: Arc<dyn ApprovalPolicy>,
}

struct WebSearchExecution {
    client: Arc<ExaClient>,
    api_key: String,
}

/// One resolved configured or filesystem skill. This exact immutable value is
/// shared by prompt disclosure, tool definitions, and dispatch.
#[derive(Debug, Clone)]
struct RuntimeSkill {
    id: String,
    name: String,
    description: String,
    instructions: String,
    location: String,
    path: Option<std::path::PathBuf>,
    scan_root: Option<std::path::PathBuf>,
}

impl RuntimeSkill {
    fn configured(skill: &Skill) -> Self {
        Self {
            id: skill.id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            instructions: skill.instructions.clone(),
            location: "configured".to_string(),
            path: None,
            scan_root: None,
        }
    }

    fn discovered(skill: &DiscoveredSkill) -> Self {
        Self {
            id: skill.id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            instructions: skill.instructions.clone(),
            location: skill.path.display().to_string(),
            path: Some(skill.path.clone()),
            scan_root: Some(skill.scan_root.clone()),
        }
    }
}

/// Generation-pinned skill registry, keyed exactly as advertised to the
/// provider. Configured entries win tool-key collisions over discovered ones.
#[derive(Debug, Default)]
struct SkillToolSet {
    defs: Vec<ToolDef>,
    dispatch: HashMap<String, RuntimeSkill>,
}

fn skill_tool_key(id: &str, name: &str) -> String {
    fn slug(value: &str) -> String {
        // Match JavaScript's `toLowerCase()` before the ASCII replacement.
        // Unicode compatibility characters such as the Kelvin sign can fold
        // into ASCII and therefore participate in the same collision set.
        let mut output = String::new();
        for character in value.to_lowercase().chars() {
            if character.is_ascii_alphanumeric() {
                output.push(character);
            } else if !output.is_empty() && !output.ends_with('_') {
                output.push('_');
            }
        }
        let trimmed = output.trim_matches('_');
        trimmed.chars().take(40).collect()
    }
    let name = slug(name);
    let fallback = slug(id);
    format!(
        "skill_{}",
        if !name.is_empty() {
            name
        } else if !fallback.is_empty() {
            fallback
        } else {
            "unnamed".to_string()
        }
    )
}

fn collect_skill_tools(configured: &[Skill], discovered: &[DiscoveredSkill]) -> SkillToolSet {
    let mut tools = SkillToolSet::default();
    let mut discovered = discovered.iter().collect::<Vec<_>>();
    discovered.sort_by(|left, right| {
        fn source_rank(source: DiscoveredSkillSource) -> u8 {
            match source {
                DiscoveredSkillSource::Workspace => 0,
                DiscoveredSkillSource::Global => 1,
            }
        }
        fn root_rank(skill: &DiscoveredSkill) -> u8 {
            match skill.scan_root.file_name().and_then(|name| name.to_str()) {
                Some(".aiden") => 0,
                Some(".claude") => 1,
                Some(".agents") => 2,
                _ => 3,
            }
        }
        source_rank(left.source)
            .cmp(&source_rank(right.source))
            .then_with(|| root_rank(left).cmp(&root_rank(right)))
            .then_with(|| left.path.cmp(&right.path))
    });
    let skills = configured
        .iter()
        .filter(|skill| skill.enabled)
        .map(RuntimeSkill::configured)
        .chain(discovered.into_iter().map(RuntimeSkill::discovered));
    for skill in skills {
        let key = skill_tool_key(&skill.id, &skill.name);
        if tools.dispatch.contains_key(&key) {
            continue;
        }
        let summary = if skill.description.trim().is_empty() {
            skill.name.clone()
        } else {
            format!("{}: {}", skill.name, skill.description)
        };
        tools.defs.push(ToolDef {
            name: key.clone(),
            description: format!(
                "{summary} — call this to load detailed instructions before performing the task."
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        });
        tools.dispatch.insert(key, skill);
    }
    tools
}

fn escape_skill_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_skill_attribute(value: &str) -> String {
    escape_skill_xml(value).replace('"', "&quot;")
}

fn format_available_skills(skills: &SkillToolSet) -> Option<String> {
    if skills.defs.is_empty() {
        return None;
    }
    let mut entries: Vec<_> = skills
        .defs
        .iter()
        .filter_map(|definition| {
            skills
                .dispatch
                .get(&definition.name)
                .map(|skill| (skill, definition.name.as_str()))
        })
        .collect();
    entries.sort_by(|(left, _), (right, _)| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut lines = vec![
        "Skills provide specialized instructions and workflows for specific tasks.".to_string(),
        "When a request matches a skill's description, call its skill tool to load the instructions.".to_string(),
        "<available_skills>".to_string(),
    ];
    for (skill, tool) in entries {
        lines.push("  <skill>".to_string());
        lines.push(format!(
            "    <name>{}</name>",
            escape_skill_xml(&skill.name)
        ));
        if !skill.description.trim().is_empty() {
            lines.push(format!(
                "    <description>{}</description>",
                escape_skill_xml(&skill.description)
            ));
        }
        lines.push(format!("    <tool>{tool}</tool>"));
        lines.push(format!(
            "    <location>{}</location>",
            escape_skill_xml(&skill.location)
        ));
        lines.push("  </skill>".to_string());
    }
    lines.push("</available_skills>".to_string());
    Some(lines.join("\n"))
}

/// Project stream events onto the live timeline: thinking stretches and tool
/// step lifecycle (start when the model begins emitting a call, running once
/// the call is complete, terminal status set by the executor).
fn project_timeline_event(projector: &mut TimelineProjector, event: &AssistantMessageEvent) {
    match event {
        AssistantMessageEvent::ThinkingStart { .. } => projector.thinking_started(),
        AssistantMessageEvent::ThinkingEnd { .. } => projector.thinking_ended(),
        AssistantMessageEvent::ToolcallStart { partial, .. } => {
            if let Some(call) = first_tool_call(partial) {
                if !call.id.is_empty() && !call.name.is_empty() {
                    projector.tool_started(&call.id, &call.name, &call.arguments);
                }
            }
        }
        AssistantMessageEvent::ToolcallEnd { tool_call, .. } if !tool_call.id.is_empty() => {
            projector.tool_running(&tool_call.id);
        }
        _ => {}
    }
}

fn is_thinking_event(event: &AssistantMessageEvent) -> bool {
    matches!(
        event,
        AssistantMessageEvent::ThinkingStart { .. }
            | AssistantMessageEvent::ThinkingDelta { .. }
            | AssistantMessageEvent::ThinkingEnd { .. }
    )
}

fn apply_stream_event(
    reducer: &mut StreamReducer,
    event: AssistantMessageEvent,
    expose_reasoning: bool,
) {
    if expose_reasoning || !is_thinking_event(&event) {
        reducer.apply(event);
    }
}

fn visible_thinking(expose_reasoning: bool, thinking: String) -> String {
    if expose_reasoning {
        thinking
    } else {
        String::new()
    }
}

fn visible_failure_thinking(expose_reasoning: bool, accumulated: &str, partial: &str) -> String {
    if expose_reasoning {
        join_provider_turns(accumulated, partial)
    } else {
        String::new()
    }
}

fn first_tool_call(message: &AssistantMessage) -> Option<aiden_core::ToolCall> {
    message.content.iter().find_map(|block| match block {
        ContentBlock::ToolCall(call) => Some(call.clone()),
        _ => None,
    })
}

#[derive(Debug, Default)]
struct FlushBoundary {
    text: bool,
    thinking: bool,
}

fn send_flush(
    reducer: &mut StreamReducer,
    tx: &tokio::sync::mpsc::UnboundedSender<StreamMsg>,
    boundary: &mut FlushBoundary,
) {
    if let Some(mut flush) = reducer.take_flush() {
        if boundary.text && !flush.text.is_empty() {
            flush.text.insert_str(0, "\n\n");
            boundary.text = false;
        }
        if boundary.thinking && !flush.thinking.is_empty() {
            flush.thinking.insert_str(0, "\n\n");
            boundary.thinking = false;
        }
        let _ = tx.send(StreamMsg::Flush {
            text: flush.text,
            thinking: flush.thinking,
            thinking_active: flush.thinking_active,
        });
    }
}

/// The normalized text result of a dispatched local or MCP tool call.
struct DispatchedToolResult {
    text: String,
    is_error: bool,
}

fn truncated_tool_call_result(call: &aiden_core::ToolCall) -> DispatchedToolResult {
    DispatchedToolResult {
        text: format!(
            "Tool call \"{}\" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.",
            call.name
        ),
        is_error: true,
    }
}

fn web_search_tool_def() -> ToolDef {
    ToolDef {
        name: "web_search".to_string(),
        description: "Search the web for current, real-world information using Exa. Use when the user asks about recent events, facts you're unsure of, or anything that benefits from up-to-date sources.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The web search query."
                },
                "numResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "How many results to return (default 5)."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        }),
    }
}

/// Dispatch one model tool call through the local coding executor or connected
/// MCP server and settle its timeline step. Unknown names fail closed.
async fn execute_tool_call(
    projector: &mut TimelineProjector,
    coding: Option<&CodingExecution>,
    web_search: Option<&WebSearchExecution>,
    skills: &SkillToolSet,
    mcp: Option<&McpExecution>,
    call: &aiden_core::ToolCall,
    tx: &tokio::sync::mpsc::UnboundedSender<StreamMsg>,
) -> DispatchedToolResult {
    if let Some(execution) = coding {
        if execution
            .executor
            .tool_defs()
            .iter()
            .any(|definition| definition.name == call.name)
        {
            if execution.executor.requires_approval(&call.name) {
                match execution.approval.evaluate(call) {
                    ApprovalVerdict::Allow => {}
                    ApprovalVerdict::Ask(request) => {
                        projector.tool_awaiting_approval(&call.id);
                        let _ = tx.send(StreamMsg::ApprovalRequired {
                            details: request.details.clone(),
                        });
                        if let Err(reason) = execution.approval.resolve(&request.approval_id).await
                        {
                            projector.tool_finished(&call.id, ToolFinishStatus::Blocked);
                            return DispatchedToolResult {
                                text: reason,
                                is_error: true,
                            };
                        }
                        projector.tool_running(&call.id);
                    }
                    ApprovalVerdict::Deny { reason } => {
                        projector.tool_finished(&call.id, ToolFinishStatus::Blocked);
                        return DispatchedToolResult {
                            text: reason,
                            is_error: true,
                        };
                    }
                }
            }
            return match execution.executor.execute(call).await {
                Ok(output) => {
                    projector.tool_finished(&call.id, ToolFinishStatus::Completed);
                    DispatchedToolResult {
                        text: output.text,
                        is_error: false,
                    }
                }
                Err(error) => {
                    projector.tool_finished(&call.id, ToolFinishStatus::Failed);
                    DispatchedToolResult {
                        text: error.to_string(),
                        is_error: true,
                    }
                }
            };
        }
    }

    if call.name == "web_search" {
        let Some(execution) = web_search else {
            projector.tool_finished(&call.id, ToolFinishStatus::Blocked);
            return DispatchedToolResult {
                text: "Web search is not enabled or its API key is unavailable.".to_string(),
                is_error: true,
            };
        };
        let query = match serde_json::from_value::<ExaSearchQuery>(call.arguments.clone()) {
            Ok(query) => query,
            Err(error) => {
                projector.tool_finished(&call.id, ToolFinishStatus::Failed);
                return DispatchedToolResult {
                    text: format!("invalid web search input: {error}"),
                    is_error: true,
                };
            }
        };
        return match execution
            .client
            .search(&query, &execution.api_key, EXA_MAX_TEXT_CHARACTERS)
            .await
        {
            Ok(results) => {
                projector.tool_finished(&call.id, ToolFinishStatus::Completed);
                DispatchedToolResult {
                    text: render_web_search_result(&results),
                    is_error: false,
                }
            }
            Err(error) => {
                projector.tool_finished(&call.id, ToolFinishStatus::Failed);
                DispatchedToolResult {
                    text: error.to_string(),
                    is_error: true,
                }
            }
        };
    }

    if let Some(skill) = skills.dispatch.get(&call.name) {
        let text = if let Some(path) = skill.path.as_ref() {
            let base = path.parent().unwrap_or(path);
            let files = if let Some(root) = skill.scan_root.as_ref() {
                let path = path.clone();
                let root = root.clone();
                tokio::task::spawn_blocking(move || supporting_skill_files_with_root(&path, &root))
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let mut lines = vec![
                format!(
                    "<skill_content name=\"{}\">",
                    escape_skill_attribute(&skill.name)
                ),
                skill.instructions.clone(),
                String::new(),
                format!("Base directory for this skill: {}", base.display()),
                "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.".to_string(),
            ];
            if !files.is_empty() {
                lines.push(String::new());
                lines.push("Files bundled with this skill (sampled):".to_string());
                lines.extend(files.iter().map(|file| format!("- {}", file.display())));
            }
            lines.push("</skill_content>".to_string());
            lines.join("\n")
        } else {
            skill.instructions.clone()
        };
        projector.tool_finished(&call.id, ToolFinishStatus::Completed);
        return DispatchedToolResult {
            text,
            is_error: false,
        };
    }

    if let Some(execution) = mcp {
        if let Some(target) = execution.tools.dispatch.get(&call.name) {
            let outcome = execution
                .manager
                .call_tool_for_lease(
                    &target.connection,
                    &target.tool_name,
                    call.arguments.clone(),
                    std::time::Duration::from_millis(CHAT_MCP_CALL_TIMEOUT_MS),
                )
                .await;
            return match outcome {
                Ok(result) => {
                    projector.tool_finished(&call.id, ToolFinishStatus::Completed);
                    DispatchedToolResult {
                        text: result.text,
                        is_error: false,
                    }
                }
                Err(error) => {
                    projector.tool_finished(&call.id, ToolFinishStatus::Failed);
                    DispatchedToolResult {
                        text: error.to_string(),
                        is_error: true,
                    }
                }
            };
        }
    }

    projector.tool_finished(&call.id, ToolFinishStatus::Failed);
    DispatchedToolResult {
        text: format!("Unknown tool \"{}\".", call.name),
        is_error: true,
    }
}

/// Resolve a stored API key for the provider (keychain access — call on a
/// background thread, never the GPUI foreground). Keyless providers (local
/// runtimes like LM Studio / Ollama) resolve to the process-only compatibility
/// token so the transports do not refuse to build a keyless request — the
/// transports require a non-empty key or an auth header.
pub fn resolve_api_key(
    keys: &aiden_data::secret_map::ProviderKeysStore,
    provider: &ConfiguredProvider,
) -> Option<String> {
    if !provider.needs_key {
        return Some(aiden_providers::catalog::PI_AUTH_COMPATIBILITY_TOKEN.to_string());
    }
    keys.get(&provider.id).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::{UserContent, UserMessage};
    use aiden_providers::codex::OAuthCredential;
    use base64::Engine as _;
    use std::collections::HashMap;

    struct MissingCodexAuth;

    impl CodexAuthStore for MissingCodexAuth {
        fn read(&self) -> Result<Option<OAuthCredential>, aiden_providers::ProviderError> {
            Ok(None)
        }

        fn write(
            &self,
            _credential: Option<&OAuthCredential>,
        ) -> Result<(), aiden_providers::ProviderError> {
            Ok(())
        }

        fn write_if_revision(
            &self,
            _expected_revision: &str,
            _credential: &OAuthCredential,
        ) -> Result<bool, aiden_providers::ProviderError> {
            Ok(false)
        }

        fn refresh_coordinator(&self) -> Arc<aiden_providers::codex::CodexRefreshCoordinator> {
            Arc::new(aiden_providers::codex::CodexRefreshCoordinator::default())
        }

        fn begin_dispatch(
            &self,
            _expected_revision: &str,
        ) -> Result<
            Option<aiden_providers::codex::CodexDispatchGuard>,
            aiden_providers::ProviderError,
        > {
            Ok(None)
        }
    }

    fn missing_codex_auth() -> Arc<dyn CodexAuthStore> {
        Arc::new(MissingCodexAuth)
    }

    struct WebFixtureTransport {
        calls: std::sync::Mutex<Vec<(String, String)>>,
    }

    #[async_trait::async_trait]
    impl aiden_providers::web_search::ExaSearchTransport for WebFixtureTransport {
        async fn post(
            &self,
            _endpoint: &str,
            api_key: &str,
            body: &str,
        ) -> Result<aiden_providers::web_search::ExaHttpResponse, String> {
            self.calls
                .lock()
                .unwrap()
                .push((api_key.to_string(), body.to_string()));
            Ok(aiden_providers::web_search::ExaHttpResponse {
                status: 200,
                status_text: "OK".into(),
                body: br#"{"results":[{"title":"Current","url":"https://example.test","text":"Evidence"}]}"#.to_vec(),
            })
        }
    }

    /// A trivial in-memory cipher so `ProviderKeysStore` is constructible in
    /// tests without touching the macOS Keychain.
    #[derive(Default)]
    struct MemoryCipher(std::sync::Mutex<HashMap<String, String>>);

    impl aiden_data::secret_map::SecretCipher for MemoryCipher {
        fn is_encryption_available(&self) -> bool {
            true
        }
        fn encrypt_string(
            &self,
            account: &str,
            value: &str,
        ) -> Result<Vec<u8>, aiden_data::secret_map::SecretCipherError> {
            self.0
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(format!("encrypted:{value}").into_bytes())
        }
        fn decrypt_string(
            &self,
            account: &str,
            value: &[u8],
        ) -> Result<String, aiden_data::secret_map::SecretCipherError> {
            let text = String::from_utf8_lossy(value);
            if !text.starts_with("encrypted:") {
                return Err(aiden_data::secret_map::SecretCipherError::NeedsRotation);
            }
            let plaintext = text.trim_start_matches("encrypted:").to_string();
            let vaulted = self.0.lock().unwrap().get(account).cloned();
            match vaulted {
                Some(stored) if stored == plaintext => Ok(plaintext),
                _ => Err(aiden_data::secret_map::SecretCipherError::UnrecognizedFormat),
            }
        }
    }

    fn key_store() -> aiden_data::secret_map::ProviderKeysStore {
        use aiden_data::secret_map::SecretCipher;
        let dir = tempfile::tempdir().unwrap();
        let cipher: std::sync::Arc<dyn SecretCipher> = std::sync::Arc::new(MemoryCipher::default());
        aiden_data::secret_map::ProviderKeysStore::new(
            dir.path().to_path_buf(),
            "aiden-test",
            cipher,
        )
    }

    fn keyed_provider(id: &str, needs_key: bool, has_key: bool) -> ConfiguredProvider {
        ConfiguredProvider {
            id: id.into(),
            label: id.into(),
            kind: ProviderKind::Openai,
            base_url: "http://127.0.0.1:1234/v1".into(),
            models: vec!["m1".into()],
            default_model: None,
            model_metadata: Default::default(),
            needs_key,
            has_key,
        }
    }

    fn turn_snapshot(provider: ConfiguredProvider) -> TurnSnapshot {
        TurnSnapshot {
            selection: ModelSelection {
                provider_id: provider.id.clone(),
                model: "m1".into(),
            },
            provider,
            thinking_level: GenerationThinkingLevel::Off,
            session_id: "chat-test".into(),
            messages: Vec::new(),
            system_prompt: Some("You are Aiden.".into()),
            mcp: None,
            web_search: None,
            coding: None,
            skills: Vec::new(),
            prompt: WorkspacePromptContext {
                root: None,
                permission: WorkspacePermission::None,
                managed_branch: None,
            },
        }
    }

    fn provider_with_context_window(context_window: u64) -> ConfiguredProvider {
        use aiden_data::portable_config::{ProviderModelMetadata, ProviderModelMetadataSource};

        let mut provider = keyed_provider("custom:test", false, false);
        provider.model_metadata.insert(
            "m1".into(),
            ProviderModelMetadata {
                source: ProviderModelMetadataSource::Provider,
                name: Some("Test model".into()),
                r#type: None,
                vision: None,
                tool_call: Some(true),
                reasoning: None,
                thinking_levels: None,
                thinking_can_disable: None,
                context_length: Some(context_window),
                parameter_count: None,
                format: None,
            },
        );
        provider
    }

    #[test]
    fn generation_context_preflight_uses_the_exact_pinned_request_surface() {
        let mut snapshot = turn_snapshot(provider_with_context_window(8_000));
        snapshot.system_prompt = Some("Pinned workspace prompt".into());
        let tools = vec![ToolDef {
            name: "read_file".into(),
            description: "Read a file from the pinned workspace".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }),
        }];

        let (template, context) =
            build_generation_request_template(&snapshot, &tools).expect("preflight passes");

        assert_eq!(template.context_window, 8_000);
        assert_eq!(context.context_window, template.context_window);
        assert_eq!(context.system_prompt, "Pinned workspace prompt");
        assert_eq!(context.tools, tools);
        assert_eq!(template.tools, context.tools);
        assert!(template.messages.is_empty());
    }

    #[test]
    fn static_capacity_preflight_fails_before_a_request_template_is_returned() {
        let mut snapshot = turn_snapshot(provider_with_context_window(256));
        snapshot.system_prompt = Some("oversized-static-prompt".repeat(200));
        let error = build_generation_request_template(&snapshot, &[]).unwrap_err();

        assert!(error.contains("context window is too small"));
    }

    #[test]
    fn outbound_compaction_leaves_authoritative_messages_unchanged() {
        let snapshot = turn_snapshot(provider_with_context_window(8_000));
        let (template, context) =
            build_generation_request_template(&snapshot, &[]).expect("preflight passes");
        let authoritative = vec![Message::User(UserMessage {
            content: UserContent::Text("x".repeat(100_000)),
            timestamp: 1,
        })];
        let original = authoritative.clone();

        let prepared = prepare_generation_request(&template, &context, &authoritative);

        assert!(prepared.compaction.compacted);
        assert!(prepared.compaction.used_context_fallback);
        assert!(
            prepared.compaction.estimated_tokens_after <= prepared.compaction.input_budget_tokens
        );
        assert_eq!(authoritative, original);
        assert_eq!(prepared.request.messages.len(), 1);
    }

    #[test]
    fn context_fallback_removes_tools_and_rejects_hallucinated_calls() {
        let snapshot = turn_snapshot(provider_with_context_window(8_000));
        let tools = vec![ToolDef {
            name: "run_command".into(),
            description: "Run a command".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }];
        let (template, context) =
            build_generation_request_template(&snapshot, &tools).expect("preflight passes");
        let authoritative = vec![Message::User(UserMessage {
            content: UserContent::Text("x".repeat(100_000)),
            timestamp: 1,
        })];

        let prepared = prepare_generation_request(&template, &context, &authoritative);

        assert!(prepared.compaction.used_context_fallback);
        assert!(prepared.request.tools.is_empty());
        assert_eq!(
            fallback_tool_call_error(true, true),
            Some(FALLBACK_TOOL_CALL_ERROR)
        );
        assert_eq!(fallback_tool_call_error(true, false), None);
        assert_eq!(fallback_tool_call_error(false, true), None);
    }

    fn user(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: "m1".into(),
            role,
            content: content.into(),
            created_at: 1_700_000_000_000,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    fn attachment(
        id: &str,
        name: &str,
        kind: aiden_core::AttachmentKind,
        data: Option<&str>,
        text: Option<&str>,
    ) -> aiden_core::Attachment {
        aiden_core::Attachment {
            id: id.into(),
            name: name.into(),
            mime_type: match kind {
                aiden_core::AttachmentKind::Image => "image/png",
                aiden_core::AttachmentKind::Text => "text/plain",
            }
            .into(),
            kind,
            size: match kind {
                aiden_core::AttachmentKind::Image => data
                    .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
                    .map_or(0, |bytes| bytes.len())
                    as u64,
                aiden_core::AttachmentKind::Text => text.map_or(0, str::len) as u64,
            },
            data: data.map(str::to_string),
            text: text.map(str::to_string),
        }
    }

    #[test]
    fn history_maps_user_and_assistant_turns() {
        let history = vec![
            user(ChatRole::User, "hi"),
            user(ChatRole::Assistant, "hello there"),
            user(ChatRole::System, "you are a helper"),
        ];
        let messages = chat_history_to_messages(
            &history,
            "claude-sonnet-5",
            "anthropic",
            ApiFamily::AnthropicMessages,
            false,
        );
        assert_eq!(messages.len(), 2, "system messages are dropped");
        assert!(
            matches!(messages[0], Message::User(ref u) if matches!(&u.content, UserContent::Text(t) if t == "hi"))
        );
        let Message::Assistant(ref a) = messages[1] else {
            panic!("expected assistant turn");
        };
        assert_eq!(a.provider, "anthropic");
        assert_eq!(a.model, "claude-sonnet-5");
        assert_eq!(a.api, "anthropic-messages");
        assert!(matches!(&a.content[0], ContentBlock::Text(t) if t.text == "hello there"));
    }

    #[test]
    fn history_keeps_per_message_model() {
        let mut assistant = user(ChatRole::Assistant, "hi");
        assistant.model = Some("claude-haiku-4".into());
        let messages = chat_history_to_messages(
            &[assistant],
            "claude-sonnet-5",
            "anthropic",
            ApiFamily::AnthropicMessages,
            false,
        );
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert_eq!(a.model, "claude-haiku-4");
    }

    #[test]
    fn empty_assistant_history_produces_no_text_block() {
        let assistant = user(ChatRole::Assistant, "");
        let messages =
            chat_history_to_messages(&[assistant], "m", "p", ApiFamily::OpenAICompletions, false);
        let Message::Assistant(ref a) = messages[0] else {
            panic!();
        };
        assert!(a.content.is_empty());
    }

    #[test]
    fn attachment_projection_orders_text_prefix_before_images() {
        let mut turn = user(ChatRole::User, "Explain these");
        turn.created_at = 41;
        turn.attachments = Some(vec![
            attachment(
                "image-a",
                "first.png",
                aiden_core::AttachmentKind::Image,
                Some("aW1hZ2UtYS1kYXRh"),
                None,
            ),
            attachment(
                "text-a",
                "notes.txt",
                aiden_core::AttachmentKind::Text,
                None,
                Some("file body"),
            ),
            attachment(
                "image-b",
                "second.png",
                aiden_core::AttachmentKind::Image,
                Some("aW1hZ2UtYi1kYXRh"),
                None,
            ),
        ]);

        let messages = chat_history_to_messages(
            &[turn],
            "gpt-5.4",
            "openai-codex",
            ApiFamily::OpenAICodexResponses,
            true,
        );
        let Message::User(projected) = &messages[0] else {
            panic!("expected user message");
        };
        assert_eq!(projected.timestamp, 41);
        let UserContent::Blocks(blocks) = &projected.content else {
            panic!("expected multimodal blocks");
        };
        assert_eq!(blocks.len(), 3);
        assert!(matches!(
            &blocks[0],
            aiden_core::UserBlock::Text(text)
                if text.text == "Attached file: notes.txt\n```\nfile body\n```\n\nExplain these"
        ));
        assert!(matches!(
            &blocks[1],
            aiden_core::UserBlock::Image(image) if image.data == "aW1hZ2UtYS1kYXRh"
        ));
        assert!(matches!(
            &blocks[2],
            aiden_core::UserBlock::Image(image) if image.data == "aW1hZ2UtYi1kYXRh"
        ));
    }

    #[test]
    fn attachment_projection_supports_image_only_turns() {
        let mut turn = user(ChatRole::User, "");
        turn.attachments = Some(vec![attachment(
            "image",
            "only.png",
            aiden_core::AttachmentKind::Image,
            Some("b25seS1pbWFnZS1kYXRh"),
            None,
        )]);
        let messages = chat_history_to_messages(
            &[turn],
            "gemini-3-pro-preview",
            "google",
            ApiFamily::GoogleGenerativeAi,
            true,
        );
        let Message::User(projected) = &messages[0] else {
            panic!("expected user message");
        };
        assert!(matches!(
            &projected.content,
            UserContent::Blocks(blocks)
                if matches!(blocks.as_slice(), [aiden_core::UserBlock::Image(image)] if image.data == "b25seS1pbWFnZS1kYXRh")
        ));
    }

    #[test]
    fn attachment_projection_nonvision_keeps_text_and_drops_image_bytes() {
        let mut turn = user(ChatRole::User, "Read it");
        turn.attachments = Some(vec![
            attachment(
                "text",
                "readme.txt",
                aiden_core::AttachmentKind::Text,
                None,
                Some("hello"),
            ),
            attachment(
                "image",
                "hidden.png",
                aiden_core::AttachmentKind::Image,
                Some("aGlkZGVu"),
                None,
            ),
        ]);
        let messages = chat_history_to_messages(
            &[turn],
            "text-only",
            "custom:text",
            ApiFamily::OpenAICompletions,
            false,
        );
        let Message::User(projected) = &messages[0] else {
            panic!("expected user message");
        };
        assert!(matches!(
            &projected.content,
            UserContent::Blocks(blocks)
                if matches!(blocks.as_slice(), [aiden_core::UserBlock::Text(text)]
                    if text.text == "Attached file: readme.txt\n```\nhello\n```\n\nRead it")
        ));
    }

    #[test]
    fn attachment_projection_replays_earlier_images_and_timestamps() {
        let mut first = user(ChatRole::User, "first");
        first.created_at = 10;
        first.attachments = Some(vec![attachment(
            "image",
            "replay.png",
            aiden_core::AttachmentKind::Image,
            Some("cmVwbGF5ZWQtaW1hZ2U="),
            None,
        )]);
        let mut assistant = user(ChatRole::Assistant, "seen");
        assistant.created_at = 20;
        let mut later = user(ChatRole::User, "later");
        later.created_at = 30;

        let messages = chat_history_to_messages(
            &[first, assistant, later],
            "gpt-5.4",
            "openai-codex",
            ApiFamily::OpenAICodexResponses,
            true,
        );
        assert_eq!(messages.len(), 3);
        assert!(matches!(
            &messages[0],
            Message::User(user)
                if user.timestamp == 10
                    && matches!(&user.content, UserContent::Blocks(blocks)
                        if matches!(blocks.last(), Some(aiden_core::UserBlock::Image(image)) if image.data == "cmVwbGF5ZWQtaW1hZ2U="))
        ));
        assert!(matches!(&messages[1], Message::Assistant(message) if message.timestamp == 20));
        assert!(matches!(
            &messages[2],
            Message::User(user)
                if user.timestamp == 30 && user.content == UserContent::Text("later".into())
        ));
    }

    #[test]
    fn custom_provider_resolves_to_openai_completions_transport() {
        let provider = ConfiguredProvider {
            id: "custom:lmstudio".into(),
            label: "LM Studio".into(),
            kind: ProviderKind::Openai,
            base_url: "http://127.0.0.1:1234/v1".into(),
            models: vec!["qwen2.5-coder".into()],
            default_model: None,
            model_metadata: Default::default(),
            needs_key: false,
            has_key: false,
        };
        assert_eq!(provider.api_family(), ApiFamily::OpenAICompletions);
        // The transport is constructible and reports its fixed info id.
        let transport = provider.transport(missing_codex_auth());
        assert_eq!(transport.info().id, "openai-completions");
    }

    #[test]
    fn healthy_codex_oauth_adds_the_virtual_picker_provider() {
        let legacy = keyed_provider("openai", true, true);
        let signed_out = aiden_providers::list::bundled_codex_provider_snapshot(false, false);
        assert_eq!(
            merge_codex_configured_provider([legacy.clone()], &signed_out),
            vec![legacy.clone()]
        );

        let signed_in = aiden_providers::list::bundled_codex_provider_snapshot(true, false);
        let merged = merge_codex_configured_provider([legacy], &signed_in);
        let codex = merged.last().expect("virtual Codex provider");
        assert_eq!(codex.id, OPENAI_CODEX_PROVIDER_ID);
        assert!(codex.has_key);
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5.4"));
        assert!(codex.offers_model("gpt-5.6-sol"));
        assert_eq!(
            codex.model_metadata["gpt-5.6-sol"]
                .thinking_levels
                .as_ref()
                .unwrap()
                .last(),
            Some(&aiden_data::portable_config::GenerationThinkingLevel::Max)
        );
        let limits = catalog::resolve_provider_runtime_limits(
            None,
            &catalog_provider(codex),
            "gpt-5.6-sol",
            None,
        );
        assert_eq!(limits.context_window, 372_000);
        assert_eq!(limits.max_tokens, 128_000);

        let needs_attention = aiden_providers::list::bundled_codex_provider_snapshot(true, true);
        assert!(merge_codex_configured_provider(merged, &needs_attention)
            .iter()
            .all(|provider| provider.id != OPENAI_CODEX_PROVIDER_ID));
    }

    #[test]
    fn builtin_providers_route_to_matching_transports() {
        use aiden_data::portable_config::ProviderKind as Kind;

        // google: kind is "openai" in the stored config but the TS native path
        // streams it through Google's own transport (google-generative-ai).
        let google = ConfiguredProvider {
            id: "google".into(),
            label: "Google Gemini".into(),
            kind: Kind::Openai,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            models: vec!["gemini-2.5-flash".into()],
            default_model: Some("gemini-2.5-flash".into()),
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        assert_eq!(google.api_family(), ApiFamily::GoogleGenerativeAi);
        assert_eq!(google.transport(missing_codex_auth()).info().id, "google");

        // openai-codex: routed by id to the codex-responses transport, never
        // through chat completions.
        let codex = ConfiguredProvider {
            id: "openai-codex".into(),
            label: "ChatGPT / Codex".into(),
            kind: Kind::Openai,
            base_url: "https://chatgpt.com/backend-api".into(),
            models: vec!["gpt-5.4".into()],
            default_model: Some("gpt-5.4".into()),
            model_metadata: Default::default(),
            needs_key: true,
            has_key: false,
        };
        assert_eq!(codex.api_family(), ApiFamily::OpenAICodexResponses);
        assert_eq!(
            codex.transport(missing_codex_auth()).info().id,
            "openai-codex"
        );

        // anthropic kind → anthropic-messages.
        let anthropic = ConfiguredProvider {
            id: "custom:onboarding-anthropic".into(),
            label: "Anthropic".into(),
            kind: Kind::Anthropic,
            base_url: "https://gateway.example/v1".into(),
            models: vec!["claude-sonnet-4-5".into()],
            default_model: Some("claude-sonnet-4-5".into()),
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        assert_eq!(anthropic.api_family(), ApiFamily::AnthropicMessages);
        assert_eq!(
            anthropic.transport(missing_codex_auth()).info().id,
            "anthropic"
        );

        // openai / deepseek / moonshotai (kind "openai", openai-completions
        // family per the TS `apiFor` fallback).
        for id in ["openai", "deepseek", "moonshotai"] {
            let provider = ConfiguredProvider {
                id: id.into(),
                label: id.into(),
                kind: Kind::Openai,
                base_url: "https://example.test/v1".into(),
                models: vec!["m".into()],
                default_model: None,
                model_metadata: Default::default(),
                needs_key: true,
                has_key: true,
            };
            assert_eq!(provider.api_family(), ApiFamily::OpenAICompletions, "{id}");
            assert_eq!(
                provider.transport(missing_codex_auth()).info().id,
                "openai-completions",
                "{id}"
            );
        }
    }

    #[test]
    fn anthropic_messages_url_derives_the_endpoint_from_the_base_url() {
        // Default API URL keeps its /v1 path.
        assert_eq!(
            anthropic_messages_url("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        // A gateway without a version segment gets /v1/messages appended
        // (TS `resolveRuntimeBaseUrl` + pi `apiUrl(..., '/v1/messages')`).
        assert_eq!(
            anthropic_messages_url("https://gateway.example"),
            "https://gateway.example/v1/messages"
        );
        // Trailing slashes and an already-complete messages URL are stable.
        assert_eq!(
            anthropic_messages_url("https://gateway.example/v1/"),
            "https://gateway.example/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://gateway.example/v1/messages"),
            "https://gateway.example/v1/messages"
        );
    }

    #[test]
    fn model_metadata_drives_request_params() {
        use aiden_data::portable_config::ProviderModelMetadataSource;

        let metadata = aiden_data::portable_config::ProviderModelMetadata {
            source: ProviderModelMetadataSource::Provider,
            name: Some("Gemini 2.5 Flash".into()),
            r#type: Some(aiden_data::portable_config::ProviderModelType::Llm),
            vision: Some(true),
            tool_call: Some(true),
            reasoning: Some(true),
            thinking_levels: None,
            thinking_can_disable: None,
            context_length: Some(1_000_000),
            parameter_count: None,
            format: None,
        };
        let provider = ConfiguredProvider {
            id: "google".into(),
            label: "Google Gemini".into(),
            kind: ProviderKind::Openai,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            models: vec!["gemini-2.5-flash".into()],
            default_model: None,
            model_metadata: HashMap::from([("gemini-2.5-flash".to_string(), metadata)]),
            needs_key: true,
            has_key: true,
        };
        let snapshot = TurnSnapshot {
            provider,
            selection: ModelSelection {
                provider_id: "google".into(),
                model: "gemini-2.5-flash".into(),
            },
            thinking_level: GenerationThinkingLevel::Off,
            session_id: "chat-test".into(),
            messages: Vec::new(),
            system_prompt: None,
            mcp: None,
            web_search: None,
            coding: None,
            skills: Vec::new(),
            prompt: WorkspacePromptContext {
                root: None,
                permission: WorkspacePermission::None,
                managed_branch: None,
            },
        };
        let request = build_stream_request(&snapshot);
        assert_eq!(request.api, ApiFamily::GoogleGenerativeAi);
        assert!(request.reasoning);
        assert!(request.vision);
        assert_eq!(request.context_window, 1_000_000);

        // A model without metadata falls back to pi-exact builtin metadata
        // (google's gemini-2.5-flash is builtin, so reasoning/window survive).
        let snapshot = TurnSnapshot {
            selection: ModelSelection {
                provider_id: "google".into(),
                model: "unknown-model".into(),
            },
            ..snapshot
        };
        let request = build_stream_request(&snapshot);
        assert!(!request.reasoning);
        assert!(!request.vision);
        // `CONSERVATIVE_RUNTIME_LIMITS` (128k/8k), not the pre-fix 32k/4k.
        assert_eq!(request.context_window, 128_000);
        assert_eq!(request.max_tokens_limit, 8_192);
    }

    #[test]
    fn thinking_control_uses_runtime_capabilities_and_per_model_preference() {
        let provider = ConfiguredProvider {
            id: aiden_providers::google::GOOGLE_PROVIDER_ID.into(),
            label: "Google Gemini".into(),
            kind: ProviderKind::Openai,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            models: vec!["gemini-3-pro-preview".into()],
            default_model: None,
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        let selection = ModelSelection {
            provider_id: provider.id.clone(),
            model: "gemini-3-pro-preview".into(),
        };
        let settings = serde_json::json!({
            "googleThinkingByModel": { "gemini-3-pro-preview": "high" }
        })
        .as_object()
        .unwrap()
        .clone();

        let control = resolve_thinking_control(&provider, &selection, &settings).unwrap();
        assert_eq!(control.provider_label, "Gemini");
        assert_eq!(control.level, GenerationThinkingLevel::High);
        assert_eq!(
            control.levels,
            vec![
                GenerationThinkingLevel::Off,
                GenerationThinkingLevel::Low,
                GenerationThinkingLevel::High,
            ]
        );
        assert!(!control.can_disable);
    }

    #[test]
    fn thinking_control_honors_exact_discovered_level_and_disable_metadata() {
        use aiden_data::portable_config::{ProviderModelMetadata, ProviderModelMetadataSource};

        let metadata = ProviderModelMetadata {
            source: ProviderModelMetadataSource::Provider,
            name: None,
            r#type: None,
            vision: None,
            tool_call: None,
            reasoning: Some(true),
            thinking_levels: Some(vec![
                aiden_data::portable_config::GenerationThinkingLevel::Off,
                aiden_data::portable_config::GenerationThinkingLevel::High,
            ]),
            thinking_can_disable: Some(true),
            context_length: None,
            parameter_count: None,
            format: None,
        };
        let provider = ConfiguredProvider {
            id: aiden_providers::google::GOOGLE_PROVIDER_ID.into(),
            label: "Google Gemini".into(),
            kind: ProviderKind::Openai,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            models: vec!["gemini-3-pro-preview".into()],
            default_model: None,
            model_metadata: HashMap::from([("gemini-3-pro-preview".into(), metadata)]),
            needs_key: true,
            has_key: true,
        };
        let selection = ModelSelection {
            provider_id: provider.id.clone(),
            model: "gemini-3-pro-preview".into(),
        };

        let control = resolve_thinking_control(&provider, &selection, &serde_json::Map::new())
            .expect("exact native provider exposes reasoning control");
        assert_eq!(
            control.levels,
            vec![GenerationThinkingLevel::Off, GenerationThinkingLevel::High]
        );
        assert!(control.can_disable);
    }

    #[test]
    fn thinking_control_rejects_unoffered_models_and_requires_declared_codex_levels() {
        let provider = ConfiguredProvider {
            id: OPENAI_CODEX_PROVIDER_ID.into(),
            label: "ChatGPT / Codex".into(),
            kind: ProviderKind::Openai,
            base_url: "https://chatgpt.com/backend-api".into(),
            models: vec!["gpt-5.6-sol".into()],
            default_model: Some("gpt-5.6-sol".into()),
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        assert!(provider.offers_model("gpt-5.6-sol"));
        assert!(!provider.offers_model("arbitrary-model"));
        assert!(resolve_thinking_control(
            &provider,
            &ModelSelection {
                provider_id: provider.id.clone(),
                model: "gpt-5.6-sol".into(),
            },
            &serde_json::Map::new(),
        )
        .is_none());
        assert!(resolve_thinking_control(
            &provider,
            &ModelSelection {
                provider_id: provider.id.clone(),
                model: "arbitrary-model".into(),
            },
            &serde_json::Map::new(),
        )
        .is_none());
    }

    #[test]
    fn native_anthropic_projection_restores_declared_picker_metadata() {
        let stored = StoredProvider {
            id: aiden_providers::builtin::ANTHROPIC_PROVIDER_ID.into(),
            kind: ProviderKind::Anthropic,
            label: "Anthropic (Claude)".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec!["claude-sonnet-5".into()],
            model_metadata: None,
            default_model: Some("claude-sonnet-5".into()),
            needs_key: true,
            deployment: None,
            is_preset: Some(true),
            is_builtin: Some(true),
            has_key: true,
            legacy_ids: None,
        };
        let provider = ConfiguredProvider::from(&stored);
        let declared = provider.model_metadata["claude-sonnet-5"]
            .thinking_levels
            .as_ref()
            .expect("native Claude levels are projected");
        assert!(!declared.is_empty());
        let control = resolve_thinking_control(
            &provider,
            &ModelSelection {
                provider_id: provider.id.clone(),
                model: "claude-sonnet-5".into(),
            },
            &serde_json::Map::new(),
        )
        .expect("native Claude control is declared");
        assert_eq!(control.provider_label, "Claude");
        assert!(control.levels.contains(&GenerationThinkingLevel::Xhigh));
        assert!(control.levels.contains(&GenerationThinkingLevel::Max));
    }

    #[test]
    fn google_declared_levels_always_keep_the_ui_off_state() {
        use aiden_data::portable_config::{ProviderModelMetadata, ProviderModelMetadataSource};

        let provider = ConfiguredProvider {
            id: aiden_providers::google::GOOGLE_PROVIDER_ID.into(),
            label: "Google Gemini".into(),
            kind: ProviderKind::Openai,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            models: vec!["gemini-3-pro-preview".into()],
            default_model: None,
            model_metadata: HashMap::from([(
                "gemini-3-pro-preview".into(),
                ProviderModelMetadata {
                    source: ProviderModelMetadataSource::Provider,
                    name: None,
                    r#type: None,
                    vision: None,
                    tool_call: None,
                    reasoning: Some(true),
                    thinking_levels: Some(vec![
                        aiden_data::portable_config::GenerationThinkingLevel::High,
                    ]),
                    thinking_can_disable: Some(false),
                    context_length: None,
                    parameter_count: None,
                    format: None,
                },
            )]),
            needs_key: true,
            has_key: true,
        };
        let control = resolve_thinking_control(
            &provider,
            &ModelSelection {
                provider_id: provider.id.clone(),
                model: "gemini-3-pro-preview".into(),
            },
            &serde_json::Map::new(),
        )
        .unwrap();
        assert_eq!(
            control.levels,
            vec![GenerationThinkingLevel::Off, GenerationThinkingLevel::High,]
        );
        assert!(!control.can_disable);
    }

    #[test]
    fn hidden_provider_reasoning_never_enters_live_or_persisted_text() {
        let mut reducer = StreamReducer::new();
        apply_stream_event(
            &mut reducer,
            AssistantMessageEvent::ThinkingStart {
                content_index: 0,
                partial: zero_usage_message(),
            },
            false,
        );
        apply_stream_event(
            &mut reducer,
            AssistantMessageEvent::ThinkingDelta {
                content_index: 0,
                delta: "private reasoning".into(),
                partial: zero_usage_message(),
            },
            false,
        );
        apply_stream_event(
            &mut reducer,
            AssistantMessageEvent::ThinkingEnd {
                content_index: 0,
                content: "private reasoning".into(),
                partial: zero_usage_message(),
            },
            false,
        );

        assert!(reducer.take_flush().is_none());
        assert_eq!(visible_thinking(false, "private reasoning".into()), "");
        assert_eq!(
            visible_thinking(true, "visible reasoning".into()),
            "visible reasoning"
        );
        assert!(!catalog::should_expose_reasoning("anthropic"));
        assert!(!catalog::should_expose_reasoning("openai-codex"));
        assert!(catalog::should_expose_reasoning("google"));
        assert!(catalog::should_expose_reasoning("custom:lmstudio"));

        let mut terminal = zero_usage_message();
        terminal.content = vec![ContentBlock::Thinking(aiden_core::ThinkingContent {
            thinking: "terminal private reasoning".into(),
            thinking_signature: Some("provider-signature".into()),
            redacted: None,
        })];
        apply_stream_event(
            &mut reducer,
            AssistantMessageEvent::Done {
                reason: StopReason::Stop,
                message: terminal,
            },
            false,
        );
        reducer.fail("late transport failure");
        let StreamTerminal::Error {
            partial_thinking, ..
        } = reducer.finalize()
        else {
            panic!("expected error terminal");
        };
        assert_eq!(partial_thinking, "terminal private reasoning");
        assert_eq!(
            visible_failure_thinking(false, "older private", &partial_thinking),
            ""
        );
    }

    #[test]
    fn request_pins_the_selected_thinking_level_for_every_provider_pass() {
        let provider = ConfiguredProvider {
            id: aiden_providers::builtin::ANTHROPIC_PROVIDER_ID.into(),
            label: "Anthropic".into(),
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec!["claude-sonnet-5".into()],
            default_model: None,
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        let snapshot = TurnSnapshot {
            provider,
            selection: ModelSelection {
                provider_id: "anthropic".into(),
                model: "claude-sonnet-5".into(),
            },
            thinking_level: GenerationThinkingLevel::Xhigh,
            session_id: "chat-test".into(),
            messages: Vec::new(),
            system_prompt: None,
            mcp: None,
            web_search: None,
            coding: None,
            skills: Vec::new(),
            prompt: WorkspacePromptContext {
                root: None,
                permission: WorkspacePermission::None,
                managed_branch: None,
            },
        };

        let first = build_stream_request_with_tools(&snapshot, &[], Vec::new());
        let follow_up = build_stream_request_with_tools(&snapshot, &[], Vec::new());
        assert_eq!(first.thinking_level, Some(ThinkingLevel::Xhigh));
        assert_eq!(follow_up.thinking_level, first.thinking_level);
        assert_eq!(first.session_id.as_deref(), Some("chat-test"));
        assert_eq!(follow_up.session_id, first.session_id);
    }

    #[test]
    fn builtin_pi_exact_metadata_drives_request_params_without_discovery() {
        // An anthropic connection with no discovery metadata still gets
        // pi-exact limits (`buildModel` + `resolveProviderRuntimeLimits`):
        // reasoning, vision, the 1M window, max tokens, and the thinking map.
        let provider = ConfiguredProvider {
            id: "anthropic".into(),
            label: "Anthropic".into(),
            kind: ProviderKind::Anthropic,
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec!["claude-sonnet-5".into()],
            default_model: None,
            model_metadata: Default::default(),
            needs_key: true,
            has_key: true,
        };
        let snapshot = TurnSnapshot {
            provider,
            selection: ModelSelection {
                provider_id: "anthropic".into(),
                model: "claude-sonnet-5".into(),
            },
            thinking_level: GenerationThinkingLevel::Off,
            session_id: "chat-test".into(),
            messages: Vec::new(),
            system_prompt: None,
            mcp: None,
            web_search: None,
            coding: None,
            skills: Vec::new(),
            prompt: WorkspacePromptContext {
                root: None,
                permission: WorkspacePermission::None,
                managed_branch: None,
            },
        };
        let request = build_stream_request(&snapshot);
        assert_eq!(request.api, ApiFamily::AnthropicMessages);
        assert!(request.reasoning);
        assert!(request.vision);
        assert_eq!(request.context_window, 1_000_000);
        assert_eq!(request.max_tokens_limit, 128_000);
        let map = request.thinking_level_map.as_ref().unwrap();
        assert_eq!(map.get("xhigh"), Some(&Some("xhigh".to_string())));
        assert_eq!(map.get("max"), Some(&Some("max".to_string())));

        // claude-fable-5 forces adaptive thinking (pi compat).
        let snapshot = TurnSnapshot {
            selection: ModelSelection {
                provider_id: "anthropic".into(),
                model: "claude-fable-5".into(),
            },
            ..snapshot
        };
        let _request = build_stream_request(&snapshot);
        let fable = aiden_providers::builtin::builtin_model(
            aiden_providers::builtin::ANTHROPIC_PROVIDER_ID,
            "claude-fable-5",
        )
        .unwrap();
        assert!(fable.force_adaptive_thinking);

        // An unrelated custom provider falls back to conservative limits.
        let snapshot = TurnSnapshot {
            provider: ConfiguredProvider {
                id: "custom:lmstudio".into(),
                label: "LM Studio".into(),
                kind: ProviderKind::Openai,
                base_url: "http://127.0.0.1:1234/v1".into(),
                models: vec!["m1".into()],
                default_model: None,
                model_metadata: Default::default(),
                needs_key: false,
                has_key: false,
            },
            selection: ModelSelection {
                provider_id: "custom:lmstudio".into(),
                model: "m1".into(),
            },
            ..snapshot
        };
        let request = build_stream_request(&snapshot);
        assert!(!request.reasoning);
        assert_eq!(request.context_window, 128_000);
        assert!(request.thinking_level_map.is_none());
    }

    #[test]
    fn selection_settings_roundtrip() {
        let selection = ModelSelection {
            provider_id: "anthropic".into(),
            model: "claude-sonnet-5".into(),
        };
        let value = selection.to_settings();
        assert_eq!(value["providerId"], "anthropic");
        let back = ModelSelection::from_settings(&value).expect("parses back");
        assert_eq!(back, selection);
        assert!(ModelSelection::from_settings(&serde_json::json!({})).is_none());
    }

    #[test]
    fn keyless_providers_resolve_a_compatibility_token() {
        // A keyless local runtime (LM Studio / Ollama) must still produce a
        // non-empty key value so the OpenAI-completions transport does not
        // refuse the request with "No API key for provider".
        let keyless = keyed_provider("custom:lmstudio", false, false);
        let keys = key_store();
        assert_eq!(
            resolve_api_key(&keys, &keyless).as_deref(),
            Some(aiden_providers::catalog::PI_AUTH_COMPATIBILITY_TOKEN)
        );
    }

    #[test]
    fn keyed_providers_resolve_the_stored_key() {
        let keyed = keyed_provider("anthropic", true, true);
        let keys = key_store();
        keys.set(&keyed.id, "secret-key-1").unwrap();
        assert_eq!(
            resolve_api_key(&keys, &keyed).as_deref(),
            Some("secret-key-1")
        );
        // A keyed provider with no stored key resolves to None (the transport
        // then reports the missing-key error to the user).
        let missing = keyed_provider("openai", true, false);
        assert_eq!(resolve_api_key(&keys, &missing), None);
    }

    /// An assistant message whose only content block is a tool call.
    fn tool_use_message(id: &str, name: &str, args: serde_json::Value) -> AssistantMessage {
        AssistantMessage {
            content: vec![ContentBlock::ToolCall(aiden_core::ToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments: args,
                thought_signature: None,
            })],
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            model: "claude".into(),
            response_model: None,
            response_id: None,
            usage: aiden_core::Usage {
                input: 5,
                output: 2,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: None,
                reasoning: None,
                total_tokens: 7,
                cost: aiden_core::UsageCost {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    total: 0.0,
                },
            },
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn tool_round_transcript_keeps_assistant_call_before_result() {
        let assistant = tool_use_message("toolu_1", "Docs__lookup", serde_json::json!({}));
        let mut messages = vec![Message::User(UserMessage {
            content: UserContent::Text("Look it up".into()),
            timestamp: 1,
        })];
        begin_tool_round(&mut messages, &assistant);
        messages.push(Message::ToolResult(ToolResultMessage {
            tool_call_id: "toolu_1".into(),
            tool_name: "Docs__lookup".into(),
            content: vec![ContentBlock::Text(TextContent {
                text: "result".into(),
                text_signature: None,
            })],
            details: None,
            added_tool_names: None,
            is_error: false,
            timestamp: 2,
        }));

        assert!(matches!(messages[1], Message::Assistant(_)));
        assert!(matches!(
            messages[2],
            Message::ToolResult(ref result) if result.tool_call_id == "toolu_1"
        ));
    }

    #[test]
    fn repeated_tool_signatures_ignore_json_key_and_call_order() {
        let call = |id: &str, name: &str, arguments| aiden_core::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            thought_signature: None,
        };
        let left = vec![
            call(
                "1",
                "read_file",
                serde_json::json!({ "path": "a", "line": 1 }),
            ),
            call("2", "grep", serde_json::json!({ "query": "x" })),
        ];
        let right = vec![
            call("new-2", "grep", serde_json::json!({ "query": "x" })),
            call(
                "new-1",
                "read_file",
                serde_json::json!({ "line": 1, "path": "a" }),
            ),
        ];
        assert_eq!(tool_call_signatures(&left), tool_call_signatures(&right));
        assert_eq!(MAX_REPEATED_CHAT_TOOL_CALLS, 3);
    }

    #[test]
    fn tool_loop_usage_aggregates_every_provider_pass() {
        let mut total = zero_usage();
        let mut first = tool_use_message("toolu_1", "Docs__lookup", serde_json::json!({})).usage;
        first.cache_write_1h = Some(3);
        first.reasoning = Some(1);
        first.cost.total = 0.25;
        let mut second = first;
        second.input = 7;
        second.output = 4;
        second.total_tokens = 11;
        second.cache_write_1h = None;
        second.reasoning = Some(2);
        second.cost.total = 0.5;

        add_usage(&mut total, &first);
        add_usage(&mut total, &second);

        assert_eq!(total.input, 12);
        assert_eq!(total.output, 6);
        assert_eq!(total.total_tokens, 18);
        assert_eq!(total.cache_write_1h, Some(3));
        assert_eq!(total.reasoning, Some(3));
        assert_eq!(total.cost.total, 0.75);
        assert_eq!(MAX_CHAT_TOOL_ITERATIONS, 10);
    }

    #[test]
    fn provider_turns_are_joined_without_smashing_words_together() {
        assert_eq!(join_provider_turns("", "Found it."), "Found it.");
        assert_eq!(
            join_provider_turns("I'll inspect.", "Found it."),
            "I'll inspect.\n\nFound it."
        );
        assert_eq!(join_provider_turns("Thinking", ""), "Thinking");
    }

    #[test]
    fn detected_checkout_branch_wins_with_managed_metadata_as_fallback() {
        assert_eq!(
            select_workspace_branch(Some("feature/aiden"), Some("main")).as_deref(),
            Some("main")
        );
        assert_eq!(
            select_workspace_branch(Some("feature/aiden"), None).as_deref(),
            Some("feature/aiden")
        );
        assert_eq!(select_workspace_branch(Some("  "), None), None);
    }

    fn configured_skill(
        id: &str,
        name: &str,
        description: &str,
        instructions: &str,
        enabled: bool,
    ) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            instructions: instructions.into(),
            enabled,
        }
    }

    #[test]
    fn configured_skills_are_namespaced_deduped_and_escaped_in_the_prompt() {
        let skills = vec![
            configured_skill(
                "first",
                "Review <Rust>",
                "Check safety & correctness",
                "First instructions",
                true,
            ),
            configured_skill(
                "collision",
                "Review Rust",
                "Later collision",
                "Second instructions",
                true,
            ),
            configured_skill("disabled", "Hidden", "", "Never exposed", false),
        ];
        let tools = collect_skill_tools(&skills, &[]);
        assert_eq!(tools.defs.len(), 1);
        assert_eq!(tools.defs[0].name, "skill_review_rust");
        assert_eq!(
            tools.dispatch["skill_review_rust"].instructions,
            "First instructions"
        );
        let prompt = format_available_skills(&tools).expect("one enabled skill");
        assert!(prompt.contains("<name>Review &lt;Rust&gt;</name>"));
        assert!(prompt.contains("Check safety &amp; correctness"));
        assert!(prompt.contains("<tool>skill_review_rust</tool>"));
        assert!(!prompt.contains("Hidden"));
    }

    #[test]
    fn configured_skill_keys_apply_unicode_lowercase_before_ascii_slugging() {
        let skills = vec![
            configured_skill("kelvin", "K Review", "", "Kelvin wins", true),
            configured_skill("ascii", "K Review", "", "ASCII collides", true),
            configured_skill("dotted", "İTest", "", "Dotted I", true),
        ];
        let tools = collect_skill_tools(&skills, &[]);
        assert_eq!(
            tools
                .defs
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            vec!["skill_k_review", "skill_i_test"]
        );
        assert_eq!(tools.dispatch["skill_k_review"].instructions, "Kelvin wins");
    }

    #[tokio::test]
    async fn configured_skill_call_returns_generation_pinned_instructions() {
        let tools = collect_skill_tools(
            &[configured_skill(
                "review",
                "Review Rust",
                "Review Rust code",
                "Inspect ownership and cancellation boundaries.",
                true,
            )],
            &[],
        );
        let call = aiden_core::ToolCall {
            id: "toolu_skill".into(),
            name: "skill_review_rust".into(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        };
        let mut projector = TimelineProjector::new("generation-skill", Box::new(|_| {}));
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();

        let result = execute_tool_call(&mut projector, None, None, &tools, None, &call, &tx).await;
        assert!(!result.is_error);
        assert_eq!(
            result.text,
            "Inspect ownership and cancellation boundaries."
        );
        let timeline = projector.finish(TerminalTimelineStatus::Completed);
        assert!(matches!(
            timeline.steps.last(),
            Some(aiden_core::AgentStep::Tool(tool))
                if tool.status == aiden_core::AgentStepStatus::Completed
        ));
    }

    #[tokio::test]
    async fn discovered_skill_uses_the_same_prompt_registry_and_returns_base_context() {
        let temp = tempfile::tempdir().unwrap();
        let skill_path = temp.path().join("review/SKILL.md");
        std::fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
        std::fs::write(&skill_path, "Pinned instructions").unwrap();
        std::fs::write(skill_path.parent().unwrap().join("checklist.md"), "secret").unwrap();
        let discovered = DiscoveredSkill {
            id: format!("workspace:{}", skill_path.display()),
            name: "Review \"Rust\"".into(),
            description: "Check <ownership> & safety".into(),
            instructions: "Pinned instructions".into(),
            source: aiden_data::skill_discovery::DiscoveredSkillSource::Workspace,
            path: skill_path.clone(),
            scan_root: temp.path().canonicalize().unwrap(),
        };
        let tools = collect_skill_tools(&[], std::slice::from_ref(&discovered));
        let key = skill_tool_key(&discovered.id, &discovered.name);
        assert_eq!(tools.defs.len(), 1);
        let prompt = format_available_skills(&tools).unwrap();
        assert!(prompt.contains("Review \"Rust\""));
        assert!(prompt.contains("Check &lt;ownership&gt; &amp; safety"));
        assert!(prompt.contains(&escape_skill_xml(&skill_path.display().to_string())));

        let call = aiden_core::ToolCall {
            id: "toolu_discovered".into(),
            name: key,
            arguments: serde_json::json!({}),
            thought_signature: None,
        };
        let mut projector = TimelineProjector::new("generation-discovered", Box::new(|_| {}));
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = execute_tool_call(&mut projector, None, None, &tools, None, &call, &tx).await;
        assert!(!result.is_error);
        assert!(result
            .text
            .contains("<skill_content name=\"Review &quot;Rust&quot;\">"));
        assert!(result.text.contains("Pinned instructions"));
        assert!(result.text.contains(&format!(
            "Base directory for this skill: {}",
            temp.path().join("review").display()
        )));
        assert!(result.text.contains("checklist.md"));
        assert!(!result.text.contains("secret"));
    }

    #[test]
    fn configured_skill_wins_a_discovered_tool_key_collision_everywhere() {
        let configured = configured_skill(
            "configured",
            "Review Rust",
            "Configured",
            "Configured instructions",
            true,
        );
        let discovered = DiscoveredSkill {
            id: "workspace:/tmp/review/SKILL.md".into(),
            name: "Review-Rust".into(),
            description: "Filesystem".into(),
            instructions: "Filesystem instructions".into(),
            source: aiden_data::skill_discovery::DiscoveredSkillSource::Workspace,
            path: "/tmp/review/SKILL.md".into(),
            scan_root: "/tmp".into(),
        };
        let tools = collect_skill_tools(&[configured], &[discovered]);
        assert_eq!(tools.defs.len(), 1);
        assert_eq!(
            tools.dispatch["skill_review_rust"].instructions,
            "Configured instructions"
        );
        assert!(format_available_skills(&tools)
            .unwrap()
            .contains("<location>configured</location>"));
    }

    #[tokio::test]
    async fn web_search_uses_the_pinned_key_and_settles_its_timeline() {
        let transport = Arc::new(WebFixtureTransport {
            calls: std::sync::Mutex::new(Vec::new()),
        });
        let execution = WebSearchExecution {
            client: Arc::new(ExaClient::new().with_transport(transport.clone())),
            api_key: "pinned-key".into(),
        };
        let definition = web_search_tool_def();
        assert_eq!(definition.name, "web_search");
        assert_eq!(
            definition.parameters["required"],
            serde_json::json!(["query"])
        );
        let call = aiden_core::ToolCall {
            id: "toolu_web".into(),
            name: "web_search".into(),
            arguments: serde_json::json!({"query":"current Aiden release","numResults":1}),
            thought_signature: None,
        };
        let mut projector = TimelineProjector::new("generation-web", Box::new(|_| {}));
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = execute_tool_call(
            &mut projector,
            None,
            Some(&execution),
            &SkillToolSet::default(),
            None,
            &call,
            &tx,
        )
        .await;
        assert!(!result.is_error);
        assert!(result.text.contains("Current"));
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "pinned-key");
        assert!(!calls[0].1.contains("pinned-key"));
        drop(calls);
        let timeline = projector.finish(TerminalTimelineStatus::Completed);
        assert!(matches!(
            timeline.steps.last(),
            Some(aiden_core::AgentStep::Tool(tool))
                if tool.status == aiden_core::AgentStepStatus::Completed
        ));
    }

    #[tokio::test]
    async fn malformed_web_search_arguments_never_reach_the_transport() {
        let transport = Arc::new(WebFixtureTransport {
            calls: std::sync::Mutex::new(Vec::new()),
        });
        let execution = WebSearchExecution {
            client: Arc::new(ExaClient::new().with_transport(transport.clone())),
            api_key: "pinned-key".into(),
        };
        let call = aiden_core::ToolCall {
            id: "toolu_bad_web".into(),
            name: "web_search".into(),
            arguments: serde_json::json!({"query":"aiden","unexpected":true}),
            thought_signature: None,
        };
        let mut projector = TimelineProjector::new("generation-web", Box::new(|_| {}));
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let result = execute_tool_call(
            &mut projector,
            None,
            Some(&execution),
            &SkillToolSet::default(),
            None,
            &call,
            &tx,
        )
        .await;
        assert!(result.is_error);
        assert!(transport.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn workspace_discovered_skill_wins_a_global_slug_collision() {
        let global = DiscoveredSkill {
            id: "global:/home/.aiden/skills/review/SKILL.md".into(),
            name: "Review Rust".into(),
            description: "Global".into(),
            instructions: "Global instructions".into(),
            source: DiscoveredSkillSource::Global,
            path: "/home/.aiden/skills/review/SKILL.md".into(),
            scan_root: "/home/.aiden".into(),
        };
        let workspace = DiscoveredSkill {
            id: "workspace:/repo/.agents/review/SKILL.md".into(),
            name: "Review-Rust".into(),
            description: "Workspace".into(),
            instructions: "Workspace instructions".into(),
            source: DiscoveredSkillSource::Workspace,
            path: "/repo/.agents/review/SKILL.md".into(),
            scan_root: "/repo/.agents".into(),
        };

        let tools = collect_skill_tools(&[], &[global, workspace]);
        assert_eq!(tools.defs.len(), 1);
        assert_eq!(
            tools.dispatch["skill_review_rust"].instructions,
            "Workspace instructions"
        );
    }

    #[test]
    fn later_provider_pass_flush_starts_with_a_live_separator() {
        let mut reducer = StreamReducer::new();
        reducer.apply(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "Found it.".into(),
            partial: tool_use_message("unused", "unused", serde_json::json!({})),
        });
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut boundary = FlushBoundary {
            text: true,
            thinking: false,
        };
        send_flush(&mut reducer, &tx, &mut boundary);
        assert!(matches!(
            rx.try_recv(),
            Ok(StreamMsg::Flush { text, .. }) if text == "\n\nFound it."
        ));
        assert!(!boundary.text);
    }

    #[tokio::test]
    async fn normal_chat_coding_tools_pause_mutations_on_the_ui_bridge() {
        use crate::approvals::approval_bridge::ApprovalDecision;

        let root = tempfile::Builder::new()
            .prefix("aiden-chat-tools-")
            .tempdir()
            .unwrap();
        let bridge = Arc::new(ApprovalBridge::new());
        let execution = CodingExecution {
            executor: Arc::new(aiden_agent::build_coding_tool_executor(
                root.path().to_path_buf(),
                Arc::new(AllowAllApprovalPolicy::new()),
            )),
            approval: bridge.clone(),
        };
        let call = aiden_core::ToolCall {
            id: "toolu_write".into(),
            name: "write_file".into(),
            arguments: serde_json::json!({ "path": "notes.txt", "content": "hello" }),
            thought_signature: None,
        };
        let emitted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let emitted_for_callback = emitted.clone();
        let mut projector = TimelineProjector::new(
            "generation-1",
            Box::new(move |timeline| {
                emitted_for_callback.lock().unwrap().push(timeline.clone());
            }),
        );
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let skills = SkillToolSet::default();
        let dispatch = execute_tool_call(
            &mut projector,
            Some(&execution),
            None,
            &skills,
            None,
            &call,
            &tx,
        );
        tokio::pin!(dispatch);
        let details = tokio::select! {
            message = rx.recv() => match message {
                Some(StreamMsg::ApprovalRequired { details }) => details,
                other => panic!("expected approval event, got {other:?}"),
            },
            outcome = &mut dispatch => panic!("mutation ran before approval: {:?}", outcome.text),
        };
        let approval_id = details["approvalId"].as_str().unwrap();
        assert_eq!(details["toolName"], "write_file");
        let awaiting = emitted.lock().unwrap().last().cloned().unwrap();
        assert!(matches!(
            awaiting.steps.last(),
            Some(aiden_core::AgentStep::Tool(tool))
                if tool.status == aiden_core::AgentStepStatus::AwaitingApproval
        ));
        assert!(bridge.decide(approval_id, ApprovalDecision::AllowOnce));

        let outcome = dispatch.await;
        assert!(!outcome.is_error);
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn stream_events_project_onto_the_live_timeline() {
        // The driver folds normalized events into the TimelineProjector; the
        // projected steps must be renderer-safe (public `tool-N` / `think-N`
        // ids, resolved statuses, settled on finish).
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        projector.thinking_started();
        let thinking_partial = AssistantMessage {
            content: vec![ContentBlock::Thinking(aiden_core::ThinkingContent {
                thinking: "hmm".into(),
                thinking_signature: None,
                redacted: None,
            })],
            ..tool_use_message("unused", "unused", serde_json::json!({}))
        };
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ThinkingDelta {
                content_index: 0,
                delta: "hmm".into(),
                partial: thinking_partial,
            },
        );
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ThinkingEnd {
                content_index: 0,
                content: "hmm".into(),
                partial: tool_use_message("unused", "unused", serde_json::json!({})),
            },
        );

        // The model emits a tool call: start (partial carries id+name), end.
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ToolcallStart {
                content_index: 0,
                partial: tool_use_message(
                    "toolu_abc",
                    "Docs__lookup_fb4b3e0873c6",
                    serde_json::json!({ "query": "ports" }),
                ),
            },
        );
        project_timeline_event(
            &mut projector,
            &AssistantMessageEvent::ToolcallEnd {
                content_index: 0,
                tool_call: aiden_core::ToolCall {
                    id: "toolu_abc".into(),
                    name: "Docs__lookup_fb4b3e0873c6".into(),
                    arguments: serde_json::json!({ "query": "ports" }),
                    thought_signature: None,
                },
                partial: tool_use_message(
                    "toolu_abc",
                    "Docs__lookup_fb4b3e0873c6",
                    serde_json::json!({}),
                ),
            },
        );
        // The dispatcher settles the executed step before the turn finishes.
        projector.tool_finished("toolu_abc", ToolFinishStatus::Completed);
        let timeline = projector.finish(TerminalTimelineStatus::Completed);

        assert_eq!(timeline.steps.len(), 2);
        match &timeline.steps[0] {
            aiden_core::AgentStep::Thinking(thinking) => {
                assert_eq!(thinking.id, "think-1");
                assert!(thinking.finished_at.is_some());
                assert!(thinking.duration_ms.is_some());
            }
            other => panic!("expected thinking step, got {other:?}"),
        }
        match &timeline.steps[1] {
            aiden_core::AgentStep::Tool(tool) => {
                assert_eq!(tool.id, "tool-1");
                assert_eq!(tool.tool_call_id, "call-1");
                assert_eq!(tool.tool_name, "Docs__lookup_fb4b3e0873c6");
                assert_eq!(tool.status, aiden_core::AgentStepStatus::Completed);
                // Provider call ids never cross the safe boundary.
                let serialized = serde_json::to_string(&timeline).unwrap();
                assert!(!serialized.contains("toolu_abc"));
            }
            other => panic!("expected tool step, got {other:?}"),
        }
    }

    #[test]
    fn executed_tool_calls_settle_running_steps_as_completed_or_failed() {
        let mut projector = TimelineProjector::new("generation-1", Box::new(|_| {}));
        let call = aiden_core::ToolCall {
            id: "toolu_1".into(),
            name: "Docs__lookup_fb4b3e0873c6".into(),
            arguments: serde_json::json!({ "query": "ports" }),
            thought_signature: None,
        };
        projector.tool_started(&call.id, &call.name, &call.arguments);
        projector.tool_running(&call.id);

        // Unknown namespaced name fails closed.
        let unknown = aiden_core::ToolCall {
            id: "toolu_2".into(),
            name: "Missing__tool_000000000000".into(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        };
        projector.tool_started(&unknown.id, &unknown.name, &unknown.arguments);
        projector.tool_running(&unknown.id);
        projector.tool_finished(&unknown.id, ToolFinishStatus::Failed);

        let execution = McpExecution {
            manager: Arc::new(aiden_mcp::McpClientManager::new()),
            tools: ChatMcpTools {
                defs: Vec::new(),
                dispatch: HashMap::new(),
            },
        };
        let skills = SkillToolSet::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let snapshot = futures::executor::block_on(execute_tool_call(
            &mut projector,
            None,
            None,
            &skills,
            Some(&execution),
            &call,
            &tx,
        ));
        assert!(snapshot.is_error);
        let timeline = projector.finish(TerminalTimelineStatus::Completed);
        let statuses: Vec<&str> = timeline
            .steps
            .iter()
            .filter_map(|step| match step {
                aiden_core::AgentStep::Tool(tool) => Some(match tool.status {
                    aiden_core::AgentStepStatus::Completed => "completed",
                    aiden_core::AgentStepStatus::Failed => "failed",
                    _ => "other",
                }),
                _ => None,
            })
            .collect();
        assert_eq!(statuses, vec!["failed", "failed"]);
    }
}

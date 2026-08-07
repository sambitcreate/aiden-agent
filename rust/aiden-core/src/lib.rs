//! Aiden domain core: the serde contracts that travel on the wire and onto disk.
//!
//! This crate is a faithful port of the dependency-free renderer/shared modules
//! (`renderer/shared/assistant.ts`, `renderer/shared/generation-timeline.ts`) plus
//! the normalized pi-ai stream contract (`@earendil-works/pi-ai` `AssistantMessage`,
//! `AssistantMessageEvent`, content blocks) and the domain `Chat*` shapes from
//! `main/services/types.ts`. Disk JSON must stay byte-compatible with the Electron
//! app's files, so every struct mirrors the TypeScript camelCase/snake_case
//! conventions exactly.
//!
//! Rules: no tokio types, no UI, no filesystem access — this crate is pure domain
//! logic so `aiden-data`/`aiden-providers`/`aiden-ui` can all depend on it.
//!
//! Several domain enums expose an inherent `from_str` mirroring the TypeScript
//! string-union predicates; the name is intentional (they are used in
//! `.and_then(Enum::from_str)` chains) so the standard-trait lint is disabled.
#![allow(clippy::should_implement_trait)]

use serde::{Deserialize, Serialize};

pub mod anthropic_thinking;
pub mod app_update;
pub mod appearance;
pub mod appearance_preview;
pub mod assistant;
pub mod chat_store_core;
pub mod chat_title;
pub mod chat_workspace;
pub mod claim_check;
pub mod codex_thinking;
pub mod dictation;
pub mod generation_thinking;
pub mod google_thinking;
pub mod keybindings;
pub mod model_pad;
pub mod provider_deployment;
pub mod subagent_management_v2;
pub mod subagent_runs;
pub mod subagent_safe_text;

pub use anthropic_thinking::{
    anthropic_thinking_can_disable, anthropic_thinking_levels_for_model,
    is_anthropic_thinking_level, merge_anthropic_thinking_preference,
    normalize_anthropic_thinking_level, parse_anthropic_thinking_preferences,
    AnthropicThinkingError, AnthropicThinkingLevel, AnthropicThinkingModelCapabilities,
    DEFAULT_ANTHROPIC_THINKING_LEVEL,
};
pub use app_update::{
    normalize_app_update_version, parse_app_update_snapshot, AppUpdateRestartReason,
    AppUpdateRestartResult, AppUpdateSnapshot, IDLE_APP_UPDATE_SNAPSHOT,
};
pub use appearance::{
    color_contrast_ratio, create_default_appearance_config, get_preset_variant, is_hex_color,
    normalize_appearance_config, parse_appearance_config, parse_theme_variant_json,
    resolve_theme_tokens, serialize_theme_variant, theme_presets, theme_variant_safety_issues,
    AppearanceConfig, AppearanceMode, AppearancePreviewSnapshot, AppearanceScheme, CodeFont,
    CodeFontId, DiffMarkerPreference, DiffMarkers, DockIcon, DockIconPreference, Mode, PresetId,
    ReduceMotion, ReduceMotionPreference, Selection, ThemePreset, ThemePresetId, ThemeSelection,
    ThemeVariantConfig, UiFont, UiFontId,
};
pub use appearance_preview::AppearancePreviewState;
pub use assistant::{
    canonical_parsed_json, escape_subagent_mcp_mutation_approval_json,
    is_assistant_automation_approval_details, is_subagent_mcp_mutation_approval_details,
    is_subagent_shell_approval_details, is_subagent_workspace_write_approval_details,
    SUBAGENT_MCP_MUTATION_DISPLAY_ESCAPED_CHARS, SUBAGENT_MCP_MUTATION_DISPLAY_INPUT_BYTES,
};
pub use chat_store_core::{
    chat_transaction_id, is_chat_delete_staging, is_chat_write_staging, is_index_write_staging,
    is_valid_chat_id, is_valid_meta, meta_of, new_chat_id, validate_chat_id, DEFAULT_WORKSPACE_ID,
    INDEX,
};
pub use chat_title::{
    build_chat_rename_prompt, build_chat_title_prompt, can_replace_generated_chat_title,
    derive_chat_title_seed, is_default_chat_title, resolve_chat_title_route,
    sanitize_generated_chat_title, ChatTitleInput, ChatTitleProviderId, ChatTitleRoute,
    FoundationModelsConnectionState, FoundationModelsConnectionStatus, DEFAULT_CHAT_TITLE,
    MAX_CHAT_TITLE_LENGTH,
};
pub use chat_workspace::{persisted_chat_workspace_id, ChatWorkspace, DEFAULT_CHAT_WORKSPACE_ID};
pub use claim_check::{attach_claim_check, detect_unverified_success_claim};
pub use codex_thinking::{
    codex_thinking_levels_for_model, is_codex_thinking_level, merge_codex_thinking_preference,
    normalize_codex_thinking_level, parse_codex_thinking_preferences, CodexThinkingError,
    CodexThinkingLevel, CodexThinkingModelCapabilities, DEFAULT_CODEX_THINKING_LEVEL,
};
pub use dictation::{DictationState, DictationStatePayload, DICTATION_STATE_CHANNEL};
pub use generation_thinking::{
    is_generation_thinking_level, GenerationThinkingLevel, GENERATION_THINKING_LEVELS,
};
pub use google_thinking::{
    google_thinking_can_disable, google_thinking_levels_for_model, is_google_thinking_level,
    merge_google_thinking_preference, normalize_google_thinking_level,
    parse_google_thinking_preferences, GoogleThinkingError, GoogleThinkingLevel,
    GoogleThinkingModelCapabilities, DEFAULT_GOOGLE_THINKING_LEVEL,
};
pub use keybindings::{
    accelerator_from_keyboard_event, apply_keybinding_mutation, aria_key_shortcut,
    command_scopes_overlap, effective_binding, effective_bindings, has_canonical_keybindings,
    has_future_keybindings, is_command_id, matches_accelerator, migrate_legacy_keybindings,
    normalize_accelerator, normalize_keybinding_overrides, pretty_accelerator,
    repair_keybinding_overrides, should_persist_canonical_keybindings, validate_effective_bindings,
    CommandCategory, CommandDefinition, CommandId, CommandScope, GlobalShortcutState,
    GlobalShortcutStatus, KeybindingError, KeybindingErrorCode, KeybindingMutation,
    KeybindingOverride, KeybindingOverridesV1, KeybindingSnapshot, KeyboardEventLike,
    LegacyAssistantKeybindings, LegacyGlobalKeybindings, COMMAND_IDS,
};
pub use model_pad::{
    empty_model_pad_layout, model_pad_layouts_equal, next_model_pad_placement,
    parse_model_pad_layout, read_model_pad_layout, write_model_pad_layout, ModelPadLayout,
    ModelPadPlacement, ModelPadPlacementSource, StorageLike, MAX_MODEL_KEY_LENGTH, MAX_PLACEMENTS,
    MODEL_PAD_LAYOUT_KEY,
};
pub use provider_deployment::{
    is_local_provider_deployment, is_loopback_provider_base_url, resolve_provider_deployment,
    ProviderDeployment, ProviderDeploymentFields,
};
pub use subagent_management_v2::{
    parse_subagent_management_result_v2, SubagentManagementRequestV2, SubagentManagementResultV2,
};
pub use subagent_runs::{
    adapt_subagent_run_snapshot_v1_to_v2, adapt_subagent_run_snapshot_v2_to_v1,
    is_safe_subagent_identifier, parse_subagent_effect_activity_v1,
    parse_subagent_history_detail_v1, parse_subagent_message_reference_v1,
    parse_subagent_run_snapshot, parse_subagent_run_snapshot_v1, parse_subagent_run_snapshot_v2,
    parse_subagent_run_snapshots_v1, subagent_message_reference, SubagentContextModeV2,
    SubagentEffectActivityKindV1, SubagentEffectActivityStateV1, SubagentEffectActivityV1,
    SubagentExecutionModeV2, SubagentHistoryDetailV1, SubagentMessageReferenceItemV1,
    SubagentMessageReferenceV1, SubagentMilestoneKind, SubagentRunSnapshot, SubagentRunSnapshotV1,
    SubagentRunSnapshotV2, SubagentRunState, SubagentRunStateV2, SubagentSnapshotRole,
    MAX_SUBAGENT_ACTIVITY_CHARS, MAX_SUBAGENT_EFFECT_ACTIVITY, MAX_SUBAGENT_ERROR_CHARS,
    MAX_SUBAGENT_LABEL_CHARS, MAX_SUBAGENT_LATEST_TEXT_CHARS, MAX_SUBAGENT_MILESTONES,
    MAX_SUBAGENT_RUNS_PER_GENERATION, MAX_SUBAGENT_TASK_PREVIEW_CHARS,
    MAX_SUBAGENT_TERMINAL_MARKDOWN_CHARS, MAX_SUBAGENT_WARNINGS, MAX_SUBAGENT_WARNING_CHARS,
    SUBAGENT_MILESTONE_KINDS, SUBAGENT_RUN_SNAPSHOT_VERSION, SUBAGENT_RUN_SNAPSHOT_VERSION_V2,
};
pub use subagent_safe_text::{
    contains_high_confidence_secret, contains_high_confidence_secret_including_encodings,
    sanitize_subagent_snapshot_text, sanitize_subagent_text,
};

// ===========================================================================
// 1. Chat domain model (main/services/types.ts)
// ===========================================================================

/// Roles a persisted `ChatMessage` can take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

/// Attachment kind: image (base64 `data`) or inlined text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Text,
}

/// An attachment on a user message. `data` is base64 without a `data:` prefix;
/// `text` is inlined (and possibly truncated) UTF-8.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: AttachmentKind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// One persisted message. Persistence is a lossy projection: tool calls survive
/// only via the renderer-safe `timeline`, and provider thinking text only when
/// the provider family exposes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    /// ms epoch.
    pub created_at: u64,
    /// Model that produced an assistant message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Exposed provider thinking (assistant only, Google/LM Studio/Ollama).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// User messages only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    /// Renderer-safe tool milestones (assistant only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<GenerationTimeline>,
    /// Bounded child-run references (assistant only). Projection type TBD in
    /// the subagent phase; kept as an opaque string map for now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents: Option<serde_json::Value>,
}

/// Chat list entry — the sidebar model. Absent `workspace_id` means "default".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A full chat document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Per-chat opt-in; the global beta setting is authoritative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer_use_enabled: Option<bool>,
    pub messages: Vec<ChatMessage>,
}

// ===========================================================================
// 2. pi-ai normalized message protocol (AssistantMessageEvent, 12 variants)
// ===========================================================================
//
// Research doc says "14 variants"; the actual vendored pi-ai `types.d.ts`
// (node_modules/@earendil-works/pi-ai/dist/types.d.ts, "AssistantMessageEvent")
// defines exactly 12: start, text_start/delta/end, thinking_start/delta/end,
// toolcall_start/delta/end, done, error. We follow the real contract.

/// Terminal stop reasons of a provider turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

/// Token + cost accounting reported by a provider for one assistant message.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Anthropic-only split of `cache_write` with 1h retention.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_1h: Option<u64>,
    /// Reasoning tokens (subset of `output`); absent when not reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    pub total_tokens: u64,
    pub cost: UsageCost,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

/// Assistant message content blocks. Tagged by `type`; note `ToolCall` maps to
/// the camelCase `"toolCall"` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text(TextContent),
    Thinking(ThinkingContent),
    Image(ImageContent),
    ToolCall(ToolCall),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextContent {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingContent {
    pub thinking: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    /// Redacted by provider safety filters; the encrypted payload lives in
    /// `thinking_signature` so multi-turn continuity still works.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    /// base64 image bytes (no data: prefix).
    pub data: String,
    pub mime_type: String,
}

/// A tool-call block. `arguments` is a JSON object; consumers reassemble it
/// from `toolcall_delta` JSON fragments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[schemars(schema_with = "json_object_schema")]
    pub arguments: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

fn json_object_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut map = serde_json::Map::new();
    map.insert(
        "type".to_string(),
        serde_json::Value::String("object".to_string()),
    );
    map.into()
}

/// A normalized assistant message — the payload carried by every stream event
/// and the terminal payload of `done`/`error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub content: Vec<ContentBlock>,
    pub api: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    pub usage: Usage,
    pub stop_reason: StopReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub timestamp: u64,
}

/// User turn: either a plain string or a block list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub content: UserContent,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<UserBlock>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserBlock {
    Text(TextContent),
    Image(ImageContent),
}

/// Tool result turn fed back to the provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    pub tool_call_id: String,
    pub tool_name: String,
    pub content: Vec<ContentBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_tool_names: Option<Vec<String>>,
    pub is_error: bool,
    pub timestamp: u64,
}

/// Conversation message union, tagged by `role`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum Message {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

/// The normalized stream event protocol. Streams never throw: failures are
/// terminal `Error` events with `stop_reason == Error | Aborted`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    Start {
        partial: AssistantMessage,
    },
    TextStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    TextDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    TextEnd {
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ThinkingStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ThinkingDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ThinkingEnd {
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ToolcallStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolcallDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ToolcallEnd {
        content_index: usize,
        tool_call: ToolCall,
        partial: AssistantMessage,
    },
    Done {
        reason: StopReason,
        message: AssistantMessage,
    },
    Error {
        reason: StopReason,
        error: AssistantMessage,
    },
}

/// A minimal conversation context handed to a provider.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StreamContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDef>>,
}

/// A tool the model may call. `parameters` is a raw JSON Schema object
/// (replaces typebox `Type.Unsafe` schemas).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[schemars(schema_with = "json_object_schema")]
    pub parameters: serde_json::Value,
}

// ===========================================================================
// 3. Generation timeline (renderer/shared/generation-timeline.ts)
// ===========================================================================

/// Versions of the timeline format this build persists and replays.
pub const GENERATION_TIMELINE_VERSION: u8 = 2;
/// Versions this build can still replay from local chat storage.
pub const REPLAYABLE_TIMELINE_VERSIONS: &[u8] = &[1, 2];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentStepStatus {
    Pending,
    AwaitingApproval,
    Running,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

/// One model tool invocation recorded as a renderer-safe milestone. `target`
/// is a workspace-relative path; `detail` is a single-line object of the action
/// — never raw file contents or commands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolStep {
    pub id: String,
    pub order: usize,
    pub tool_call_id: String,
    pub tool_name: String,
    pub label: String,
    pub status: AgentStepStatus,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One uninterrupted stretch of model reasoning between tool calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentThinkingStep {
    pub id: String,
    pub order: usize,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    /// Wall-clock reasoning time measured by the host; pi reports none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentStep {
    Tool(AgentToolStep),
    Thinking(AgentThinkingStep),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GenerationTimelineStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// Append-only post-turn outcome; the assistant's prose is never rewritten.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GenerationClaimCheck {
    #[serde(rename = "unverified_success", rename_all = "camelCase")]
    UnverifiedSuccess { step_ids: Vec<String> },
}

/// The persisted record of tool activity for one generation (version 2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenerationTimeline {
    pub version: u8,
    pub generation_id: String,
    pub status: GenerationTimelineStatus,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub steps: Vec<AgentStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_check: Option<GenerationClaimCheck>,
}

/// Payload pushed over the `chat:timeline` channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatTimelineNotification {
    pub stream_id: String,
    pub timeline: GenerationTimeline,
}

impl GenerationTimeline {
    /// Returns the newest active (pending/awaiting_approval/running) tool step.
    pub fn latest_active_tool_step(&self) -> Option<&AgentToolStep> {
        self.steps.iter().rev().find_map(|step| match step {
            AgentStep::Tool(tool) => matches!(
                tool.status,
                AgentStepStatus::Pending
                    | AgentStepStatus::AwaitingApproval
                    | AgentStepStatus::Running
            )
            .then_some(tool),
            AgentStep::Thinking(_) => None,
        })
    }
}

// ===========================================================================
// 4. Assistant automation + subagent approval details
//    (renderer/shared/assistant.ts)
// ===========================================================================

/// Reserved workspace id keeping assistant threads out of the main sidebar.
pub const ASSISTANT_WORKSPACE_ID: &str = "assistant";
pub const ASSISTANT_AUTOMATION_TOOL_NAME: &str = "schedule_task";
pub const ASSISTANT_AUTOMATION_EDIT_TOOL_NAME: &str = "edit_automation";
pub const ASSISTANT_AUTOMATION_NAME_LIMIT: usize = 120;
pub const ASSISTANT_AUTOMATION_PROMPT_LIMIT: usize = 32 * 1024;
pub const ASSISTANT_AUTOMATION_CRON_LIMIT: usize = 256;
pub const ASSISTANT_AUTOMATION_TIMEZONE_LIMIT: usize = 128;
pub const ASSISTANT_AUTOMATION_TASK_ID_LIMIT: usize = 160;
pub const ASSISTANT_AUTOMATION_WORKSPACE_ID_LIMIT: usize = 160;
pub const ASSISTANT_AUTOMATION_WORKSPACE_NAME_LIMIT: usize = 120;
pub const ASSISTANT_AUTOMATION_MCP_SERVER_LIMIT: usize = 16;
pub const ASSISTANT_AUTOMATION_MCP_SERVER_ID_LIMIT: usize = 160;
pub const ASSISTANT_AUTOMATION_MCP_SERVER_NAME_LIMIT: usize = 120;
pub const ASSISTANT_AUTOMATION_PROVIDER_ID_LIMIT: usize = 160;
pub const ASSISTANT_AUTOMATION_PROVIDER_NAME_LIMIT: usize = 120;
pub const ASSISTANT_AUTOMATION_MODEL_ID_LIMIT: usize = 256;
pub const ASSISTANT_AUTOMATION_MODEL_NAME_LIMIT: usize = 256;
pub const SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT: usize = 120;
pub const SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT: usize = 512;
pub const SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT: usize = 120;
pub const SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT: usize = 160;
pub const SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT: usize = 12 * 1024;
pub const SUBAGENT_WORKSPACE_WRITE_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH: usize = 12;
pub const SUBAGENT_MCP_MUTATION_DIGEST_PREFIX_LENGTH: usize = 12;
pub const SUBAGENT_SHELL_COMMAND_DISPLAY_CHARS: usize = 32 * 1024;

/// Prompts offered in Aiden's empty state.
pub const ASSISTANT_SUGGESTED_PROMPTS: &[&str] = &[
    "What can you help me with?",
    "How do scheduled tasks work?",
    "Where do I add a provider?",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationAction {
    Create,
    Edit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMode {
    Llm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationPermission {
    ReadOnly,
    Full,
}

/// The exact automation proposal shown before an attended Assistant tool call
/// resumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantAutomationApprovalDetails {
    pub action: AutomationAction,
    /// Present only when changing an existing saved automation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Present on edits so a paused task is not described as having an active
    /// next run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub name: String,
    pub prompt: String,
    pub cron: String,
    pub timezone: String,
    pub next_run_at: u64,
    pub notify: bool,
    pub mode: AutomationMode,
    pub permission: AutomationPermission,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub mcp_server_ids: Vec<String>,
    pub mcp_server_names: Vec<String>,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub model_name: String,
    pub scheduler_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWriteOperation {
    Create,
    Replace,
    Edit,
}

/// Renderer-safe facts for one exact, attended child file mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWorkspaceWriteApprovalDetails {
    pub operation: WorkspaceWriteOperation,
    pub child_label: String,
    /// Canonical workspace-relative path; absolute and parent-traversal paths
    /// are rejected upstream.
    pub path: String,
    pub workspace_label: String,
    /// Present only when the authorized workspace is an Aiden managed worktree.
    pub worktree_label: Option<String>,
    pub is_managed_worktree: bool,
    /// Null only for a create that requires the target not to exist.
    pub pre_digest_prefix: Option<String>,
    pub post_digest_prefix: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub diff_preview: String,
    pub diff_truncated: bool,
    pub command_will_run: bool,
    pub refuse_if_changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpMutationClassification {
    DeclaredMutating,
    UnprovenMutating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationDestructive {
    Destructive,
    Additive,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationIdempotency {
    Idempotent,
    NotDeclared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationOpenWorld {
    Open,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MutationTaskSupport {
    Forbidden,
    Optional,
}

/// Renderer-safe host-derived facts for one inert mutating-MCP approval
/// proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMcpMutationApprovalDetails {
    pub child_label: String,
    pub server_id: String,
    pub tool_name: String,
    pub connection_digest_prefix: String,
    pub schema_digest_prefix: String,
    pub profile_digest_prefix: String,
    pub argument_digest_prefix: String,
    pub classification: McpMutationClassification,
    pub destructive: MutationDestructive,
    pub idempotency: MutationIdempotency,
    pub open_world: MutationOpenWorld,
    pub task_support: MutationTaskSupport,
    pub timeout_ms: u64,
    /// Canonical escaped JSON of the arguments (no raw control characters).
    pub canonical_arguments: String,
    pub prior_unknown_effect: bool,
    pub automatic_retry: bool,
    pub rollback_available: bool,
}

/// Renderer-safe exact facts for one attended full-host child command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentShellApprovalDetails {
    pub child_label: String,
    pub command: String,
    pub initial_cwd: String,
    pub shell: String,
    pub argument_digest_prefix: String,
    pub root_digest_prefix: String,
    pub effect_digest_prefix: String,
    pub timeout_ms: u64,
    pub stdout_limit_bytes: u64,
    pub stderr_limit_bytes: u64,
    pub workspace_label: String,
    pub is_managed_worktree: bool,
    pub worktree_label: Option<String>,
    pub environment_profile: String,
    pub os_sandboxed: bool,
    pub rollback_available: bool,
    pub output_sent_to_model: bool,
    pub arbitrary_network_available: bool,
    pub detached_processes_may_survive: bool,
}

/// The renderer-safe tool-approval union, discriminated by `kind` (kebab-case).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToolApprovalDetails {
    #[serde(rename = "assistant-automation")]
    AssistantAutomation(AssistantAutomationApprovalDetails),
    #[serde(rename = "subagent-workspace-write")]
    SubagentWorkspaceWrite(SubagentWorkspaceWriteApprovalDetails),
    #[serde(rename = "subagent-mcp-mutation")]
    SubagentMcpMutation(SubagentMcpMutationApprovalDetails),
    #[serde(rename = "subagent-shell")]
    SubagentShell(SubagentShellApprovalDetails),
}

// ===========================================================================
// 5. Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_message_roundtrip_with_all_optionals() {
        let message = ChatMessage {
            id: "msg-1".into(),
            role: ChatRole::Assistant,
            content: "hello".into(),
            created_at: 1_700_000_000_000,
            model: Some("claude-sonnet-5".into()),
            reasoning: Some("thinking...".into()),
            attachments: None,
            timeline: Some(timeline_fixture()),
            subagents: None,
        };
        let json = serde_json::to_string(&message).unwrap();
        // camelCase keys on disk, matching the Electron app.
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"generationId\""));
        assert!(!json.contains("created_at"));
        let back: ChatMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, message);
    }

    #[test]
    fn stop_reason_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&StopReason::ToolUse).unwrap(),
            "\"toolUse\""
        );
        assert_eq!(
            serde_json::to_string(&StopReason::Aborted).unwrap(),
            "\"aborted\""
        );
    }

    #[test]
    fn message_union_is_tagged_by_role() {
        let message = Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::Text(TextContent {
                text: "hi".into(),
                text_signature: None,
            })],
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            model: "claude-sonnet-5".into(),
            response_model: None,
            response_id: Some("resp_1".into()),
            usage: usage_fixture(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: 1_700_000_000_000,
        });
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["role"], "assistant");
        let back: Message = serde_json::from_value(json).unwrap();
        assert_eq!(back, message);
    }

    #[test]
    fn assistant_message_event_variants_roundtrip() {
        let partial = AssistantMessage {
            content: vec![ContentBlock::ToolCall(ToolCall {
                id: "call-1".into(),
                name: "grep".into(),
                arguments: serde_json::json!({ "pattern": "foo" }),
                thought_signature: None,
            })],
            api: "anthropic-messages".into(),
            provider: "anthropic".into(),
            model: "claude-sonnet-5".into(),
            response_model: None,
            response_id: None,
            usage: usage_fixture(),
            stop_reason: StopReason::ToolUse,
            error_message: None,
            timestamp: 1_700_000_000_000,
        };

        let cases: Vec<AssistantMessageEvent> = vec![
            AssistantMessageEvent::Start {
                partial: partial.clone(),
            },
            AssistantMessageEvent::TextStart {
                content_index: 0,
                partial: partial.clone(),
            },
            AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "a".into(),
                partial: partial.clone(),
            },
            AssistantMessageEvent::ThinkingEnd {
                content_index: 1,
                content: "t".into(),
                partial: partial.clone(),
            },
            AssistantMessageEvent::ToolcallEnd {
                content_index: 2,
                tool_call: ToolCall {
                    id: "call-1".into(),
                    name: "grep".into(),
                    arguments: serde_json::json!({}),
                    thought_signature: None,
                },
                partial: partial.clone(),
            },
            AssistantMessageEvent::Done {
                reason: StopReason::Stop,
                message: partial.clone(),
            },
            AssistantMessageEvent::Error {
                reason: StopReason::Aborted,
                error: partial,
            },
        ];

        for event in cases {
            let value = serde_json::to_value(&event).unwrap();
            // Correct wire tag per variant.
            let tag = match &event {
                AssistantMessageEvent::Start { .. } => "start",
                AssistantMessageEvent::TextStart { .. } => "text_start",
                AssistantMessageEvent::TextDelta { .. } => "text_delta",
                AssistantMessageEvent::ThinkingEnd { .. } => "thinking_end",
                AssistantMessageEvent::ToolcallEnd { .. } => "toolcall_end",
                AssistantMessageEvent::Done { .. } => "done",
                AssistantMessageEvent::Error { .. } => "error",
                _ => unreachable!(),
            };
            assert_eq!(value["type"], tag, "wrong tag for {event:?}");
            let back: AssistantMessageEvent = serde_json::from_value(value).unwrap();
            assert_eq!(back, event);
        }
    }

    #[test]
    fn timeline_roundtrip_with_claim_check() {
        let timeline = timeline_fixture();
        let json = serde_json::to_string(&timeline).unwrap();
        let back: GenerationTimeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back, timeline);
        assert_eq!(back.latest_active_tool_step().unwrap().tool_name, "grep");
    }

    #[test]
    fn timeline_serializes_version_2() {
        let mut timeline = timeline_fixture();
        timeline.status = GenerationTimelineStatus::Completed;
        timeline.claim_check = Some(GenerationClaimCheck::UnverifiedSuccess {
            step_ids: vec!["tool-1".into()],
        });
        let value = serde_json::to_value(&timeline).unwrap();
        assert_eq!(value["version"], 2);
        assert_eq!(value["steps"][0]["kind"], "tool");
        assert_eq!(value["steps"][1]["kind"], "thinking");
        assert_eq!(value["claimCheck"]["kind"], "unverified_success");
        assert_eq!(value["claimCheck"]["stepIds"][0], "tool-1");
    }

    #[test]
    fn tool_approval_details_use_kebab_kinds() {
        let details =
            ToolApprovalDetails::AssistantAutomation(AssistantAutomationApprovalDetails {
                action: AutomationAction::Create,
                task_id: None,
                enabled: None,
                name: "nightly".into(),
                prompt: "summarize".into(),
                cron: "0 9 * * *".into(),
                timezone: "UTC".into(),
                next_run_at: 1_700_000_000_000,
                notify: true,
                mode: AutomationMode::Llm,
                permission: AutomationPermission::Full,
                workspace_id: Some("w1".into()),
                workspace_name: Some("project".into()),
                mcp_server_ids: vec![],
                mcp_server_names: vec![],
                provider_id: "anthropic".into(),
                provider_name: "Anthropic".into(),
                model: "claude-sonnet-5".into(),
                model_name: "Claude Sonnet 5".into(),
                scheduler_enabled: true,
            });
        let value = serde_json::to_value(&details).unwrap();
        assert_eq!(value["kind"], "assistant-automation");
        assert_eq!(value["permission"], "full");
        assert_eq!(value["mode"], "llm");
        let back: ToolApprovalDetails = serde_json::from_value(value).unwrap();
        assert_eq!(back, details);
    }

    fn usage_fixture() -> Usage {
        Usage {
            input: 10,
            output: 20,
            cache_read: 5,
            cache_write: 0,
            cache_write_1h: None,
            reasoning: Some(4),
            total_tokens: 30,
            cost: UsageCost {
                input: 0.01,
                output: 0.02,
                cache_read: 0.005,
                cache_write: 0.0,
                total: 0.035,
            },
        }
    }

    fn timeline_fixture() -> GenerationTimeline {
        GenerationTimeline {
            version: GENERATION_TIMELINE_VERSION,
            generation_id: "gen-1".into(),
            status: GenerationTimelineStatus::Running,
            started_at: 1_700_000_000_000,
            finished_at: None,
            steps: vec![
                AgentStep::Tool(AgentToolStep {
                    id: "tool-1".into(),
                    order: 0,
                    tool_call_id: "call-1".into(),
                    tool_name: "grep".into(),
                    label: "Searching files".into(),
                    status: AgentStepStatus::Running,
                    started_at: 1_700_000_000_000,
                    updated_at: 1_700_000_000_010,
                    finished_at: None,
                    target: Some("src/main.rs".into()),
                    detail: Some("pattern: foo".into()),
                }),
                AgentStep::Thinking(AgentThinkingStep {
                    id: "think-1".into(),
                    order: 1,
                    started_at: 1_700_000_000_010,
                    updated_at: 1_700_000_000_020,
                    finished_at: None,
                    duration_ms: Some(10),
                }),
            ],
            claim_check: None,
        }
    }
}

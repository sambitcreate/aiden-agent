// Electron-free shared IPC contracts for MCP servers, skills, voice, Assistant
// configuration, app settings, computer use status, profiles, and usage metrics.

import type { WebSearchSettingsV2 } from "../../main/services/web-search-provider-registry-core.js";
import type { AgentSliderSettings } from "./agent-slider.js";
import type { AidenLiveSettingsFields } from "./aiden-live-settings.js";
import type { AnthropicThinkingLevel } from "./anthropic-thinking.js";
import type { AppControlPolicy } from "./app-controls.js";
import type { AppearanceConfig } from "./appearance.js";
import type { ApprovalMode } from "./approval-mode.js";
import type { CodexThinkingLevel } from "./codex-thinking.js";
import type { CompactionEngine, CompactionModelOverrides } from "./compaction.js";
import type { DictationDictionaryEntry } from "./dictation-dictionary.js";
import type { DictationActivationMode } from "./dictation-preferences.js";
import type { GenerationThinkingLevel } from "./generation-thinking.js";
import type { GoogleThinkingLevel } from "./google-thinking.js";
import type { ScheduledTaskMode, ScheduledTaskPermission } from "./ipc-chat-schedule-contracts.js";
import type { KeybindingOverridesV1 } from "./keybindings.js";
import type { McpExposure } from "./mcp-exposure.js";
import type { HiddenModelsByProvider } from "./model-visibility.js";
import type { OnboardingState } from "./onboarding.js";
import type { QuickChatDefaultPersistence } from "./quick-chat.js";
import type { SpendingLimitsSettings } from "./spending.js";
import type { SubagentSnapshotRole } from "./subagent-runs.js";
import type { TtsSettingsV1 } from "./tts.js";
import type { UsageLimitWaitHours } from "./usage-limits.js";
import type { WebFetchSettingsV1 } from "./web-fetch-settings.js";

export type McpTransport = "stdio" | "http";

/** A user-configured MCP server connection. */
export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  /** Remote servers only: authenticate with OAuth (browser sign-in) instead of / in addition to headers. */
  oauth?: boolean;
  /** Explicit authorization-server metadata document for custom remote OAuth connections. */
  authServerMetadataUrl?: string;
  /**
   * Custom remote OAuth servers without dynamic registration: a client the
   * person registered with the provider. Sign-in uses it instead of registering.
   */
  oauthClientId?: string;
  /**
   * That client's secret. config.json holds only a keychain marker (see
   * mcp-field-secrets-core.ts); the value never reaches the renderer.
   */
  oauthClientSecret?: string;
  /** Built-in provider reference; requires separate device-local consent before use. */
  authProvider?: string;
  /** Optional bounded server description used for tool discovery. */
  description?: string;
  /** Set when this record came from the built-in preset catalog (see mcp-presets.ts). */
  presetId?: string;
  enabled: boolean;
  /** How the model reaches this server's tools (default `auto`); see renderer/shared/mcp-exposure.ts. */
  exposure?: McpExposure;
  /** Raw remote tool names withheld from every model surface. */
  hiddenTools?: string[];
}

/** An Agent Skill — instructions exposed to the model as a callable tool. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

/** An Agent Skill discovered on disk from a skill folder (read-only). */
export interface DiscoveredSkill {
  /** Omitted legacy metadata permits both invocation surfaces. */
  modelInvocable?: boolean;
  userInvocable?: boolean;
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Where it was found. */
  source: "workspace" | "global";
  /** Absolute path to the SKILL.md file. */
  path: string;
}

export type VoiceProvider = "openai" | "gemini" | "local";
export type GeminiUsageScope = "transcription_only" | "models_and_transcription";

export type ChatTitleProviderId = "automatic" | "apple-foundation-models" | "chat-model";

export type FoundationModelsConnectionState =
  | "ready"
  | "unsupported_os"
  | "device_not_eligible"
  | "apple_intelligence_disabled"
  | "model_preparing"
  | "helper_unavailable"
  | "unavailable"
  | "error";

export interface FoundationModelsConnectionStatus {
  id: "apple-foundation-models";
  label: "Apple Foundation Models";
  state: FoundationModelsConnectionState;
  detail: string;
  local: true;
  titleOnly: true;
  retryable: boolean;
}

/** How much the Aiden assistant may do with app settings through its tools. */
export type AssistantSettingsPermission = "full" | "ask" | "none";

/** Aiden assistant window, hotkey, and proactive-watching settings. */
export interface AssistantConfig {
  /** Proactivity master switch. Off by default — nudging is opt-in. */
  enabled: boolean;
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /**
   * Required pin for proactivity. An unattended loop must never inherit
   * whichever model the user happens to have selected, so the ticker refuses to
   * run until both of these are set. Interactive Aiden chat still follows
   * lastProviderId/lastModel.
   */
  providerId?: string;
  model?: string;
  watchUncommitted: boolean;
  watchUntouchedProjects: boolean;
  watchConfigChanges: boolean;
  pollIntervalMinutes: number;
  untouchedThresholdDays: number;
  quietHoursEnabled: boolean;
  /** "HH:MM" local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  maxNudgesPerDay: number;
  urgencyThreshold: number;
  settingsPermission: AssistantSettingsPermission;
}

export interface SubagentModelRoleSetting {
  model?: string;
  effort?: GenerationThinkingLevel;
  /** A locked role ignores spawn arguments and applies after every default. */
  locked?: boolean;
}

/** Optional `settings.subagentModels`; absent means children inherit the parent. */
export interface SubagentModelSettings {
  defaultModel?: string;
  defaultEffort?: GenerationThinkingLevel;
  roles?: Partial<Record<SubagentSnapshotRole, SubagentModelRoleSetting>>;
  /** Keys an agent may request. Absent: the parent plus each provider's default model. */
  allowedModels?: string[];
  maxEffort?: GenerationThinkingLevel;
  allowCostlierModels?: boolean;
}

/** Persisted lightweight app settings; raw credentials remain main-owned. */
export interface AppSettings extends AidenLiveSettingsFields {
  /** App effects are separately authorized from workspace file access. */
  appControlPolicy?: AppControlPolicy;
  /** Explicit host-owner consent; older pairings cannot enable this. */
  remoteAppControlsEnabled?: boolean;
  compactionEngine?: CompactionEngine;
  compactionModelOverrides?: CompactionModelOverrides;
  /** Explicit opt-in to paid cache refreshes during active foreground runs. */
  cacheWarmingEnabled?: boolean;
  /**
   * Explicit opt-in to hour-long prompt caches for chat requests on the
   * providers in `prompt-cache-retention.ts`; side calls keep the default.
   */
  longPromptCacheRetention?: boolean;
  /** Longest wait, in hours, for a usage limit to clear before a reply fails; 0 turns waiting off. Absent means 6. */
  usageLimitWaitHours?: UsageLimitWaitHours;
  /**
   * Settings → Approvals → Advanced: routine runs go ahead with Ask first steps and connected-app
   * changes instead of waiting for the person. Never lowers Hand off to me rules,
   * the password and money rules, or chat turns. Absent means off.
   */
  botRoutinesGoAhead?: boolean;
  /**
   * The global approval mode (Settings → Approvals). Absent on a fresh install:
   * Auto once a usable model exists, else Ask. Written as "ask" on the first
   * start of an install upgraded from before modes (deviation a).
   */
  approvalMode?: ApprovalMode;
  /**
   * Written once, on the first start of a release with modes: "upgrade" for an
   * install already in use (it was given Ask and sees the one-time "What
   * changed" note), "fresh" otherwise.
   */
  approvalModeOrigin?: "fresh" | "upgrade";
  /** The person dismissed the "What changed" note in Settings → Approvals. */
  approvalChangesSeen?: boolean;
  /** Advanced: the model the Auto judge uses. Absent: the chat's own model. */
  approvalModel?: { providerId: string; model: string };
  botMessaging?: boolean;
  /** Approvals → Advanced: "Chats can start other chats". On unless false; only false is stored. */
  childChats?: boolean;
  /** Settings → Context & Limits: dollar limits per chat, Bot month and routine run. Absent amounts: no limit. */
  spendingLimits?: SpendingLimitsSettings;
  lastProviderId?: string;
  lastModel?: string;
  /**
   * The reasoning effort picked with the new-chat model, so a new chat lands
   * on the same Agent Slider stop. Machine-local like `lastModel`; cleared when
   * the new-chat model changes without a level.
   */
  lastThinkingLevel?: GenerationThinkingLevel;
  /**
   * Read-only projection of the Agent Slider stored in the portable
   * config.json (`PortableConfigShape.agentSlider`); settings.json never holds
   * it. Absent until first seeded. Written only by `setAgentSlider`.
   */
  agentSlider?: AgentSliderSettings;
  /**
   * Read-only: config.json holds an `agentSlider` that does not read as a
   * slider (a malformed hand edit), so `agentSlider` is absent and the
   * first-run seed refuses to replace it. Only `setAgentSlider` does.
   */
  agentSliderUnreadable?: true;
  /** Most recently selected real project workspace ID in the main window (shared with Quick Chat). */
  lastWorkspaceId?: string;
  /** Presentation-only chat models hidden from Mac and paired mobile selection UI. */
  hiddenModelsByProvider?: HiddenModelsByProvider;
  /** Presentation-only model-picker pins as distinct `provider::model` values (at most 200). */
  pinnedModels?: string[];
  /**
   * Presentation-only model history: distinct `provider::model` values, newest
   * first (at most 5). Machine-local; never part of the portable config.
   */
  recentModels?: string[];
  exaEnabled?: boolean;
  /** Versioned Web Search routing/preferences; credentials stay main-owned. */
  webSearch?: WebSearchSettingsV2;
  /** Versioned web page reading (`web_fetch`) and extract mode; keys stay main-owned. */
  webFetch?: WebFetchSettingsV1;
  /** Versioned Text to Speech (Read aloud) preferences; credentials stay encrypted. */
  tts?: TtsSettingsV1;
  voiceProvider?: VoiceProvider;
  voiceModel?: string;
  /** Whether Google is exposed for voice only or for both chat models and voice. */
  geminiUsageScope?: GeminiUsageScope;
  /** Selected on-device speech model id (see local-speech-catalog). */
  localVoiceModel?: string;
  /** "auto" or a base language code; resolved per model at use (see renderer/shared/voice-language.ts). */
  voiceLanguage?: string;
  /** Translate speech to English when the active on-device model can. */
  voiceTranslateToEnglish?: boolean;
  /** Trim silence and segment long audio with Silero VAD before on-device decode (default on). */
  voiceTrimSilence?: boolean;
  /** Load the on-device model at launch and when one is chosen, before the first dictation (default on). */
  localVoicePreload?: boolean;
  shortcutEnabled?: boolean;
  shortcutAccelerator?: string;
  /** Global hotkey that toggles dictation into the focused app (pill + auto-paste). */
  dictationEnabled?: boolean;
  dictationAccelerator?: string;
  /** Hold the dictation shortcut to record; release to transcribe. */
  dictationHoldToTalk?: boolean;
  /** Refines a release-capable shortcut: `hold` (push-to-talk) or `hybrid` (tap toggles, hold talks). */
  dictationActivationMode?: DictationActivationMode;
  /** Vocabulary and replacement rules applied to finished dictation transcripts. */
  dictationDictionary?: DictationDictionaryEntry[];
  /** Minutes an idle on-device voice model stays loaded; 0 keeps it loaded. */
  localVoiceIdleUnloadMinutes?: number;
  /** End dictation shortly after silence. */
  dictationSilenceStop?: boolean;
  /** Polish the transcript with the current chat model before paste. */
  dictationCleanup?: boolean;
  /** Play start/stop/done cues from the dictation pill. */
  dictationSounds?: boolean;
  /** Versioned command overrides. Legacy global fields remain migration fallbacks. */
  keybindings?: KeybindingOverridesV1;
  /** Background chat-title generation policy. Defaults to automatic. */
  chatTitleProviderId?: ChatTitleProviderId;
  /** Paired light/dark palettes and global appearance preferences. */
  appearance?: AppearanceConfig;
  /** Last explicit native-Google thinking level, keyed by exact model id. */
  googleThinkingByModel?: Record<string, GoogleThinkingLevel>;
  /** Last explicit ChatGPT/Codex reasoning effort, keyed by exact model id. */
  codexThinkingByModel?: Record<string, CodexThinkingLevel>;
  /** Last explicit Anthropic/Claude thinking effort, keyed by exact model id. */
  anthropicThinkingByModel?: Record<string, AnthropicThinkingLevel>;
  providerThinkingByModel?: Record<string, Record<string, GenerationThinkingLevel>>;
  /** Per-subagent model and effort defaults; parsed leniently, absent means children inherit. */
  subagentModels?: SubagentModelSettings;
  /** Presentation-only Pi thinking visibility for models running on a local deployment. */
  showLocalModelReasoning?: boolean;
  /** Global skill discovery/invocation gate. Omitted means enabled. */
  skillsEnabled?: boolean;
  /** Global durable-memory gate. Omitted means enabled. */
  memoryEnabled?: boolean;
  /** Global opt-in for the external cua-driver Computer Use beta. */
  computerUseEnabled?: boolean;
  /** "Always allow" Computer Use in every chat without the per-chat access card. */
  computerUseAlwaysAllow?: boolean;
  /** Aiden Live (voice and on-screen actions). Omitted means enabled; false refuses every Live start. */
  aidenLiveEnabled?: boolean;
  /** Show the idle Live button in the window corner. Omitted means shown; active sessions always show it. */
  aidenLiveButtonVisible?: boolean;
  /** Default persistence mode for new chats started from the floating Quick Chat starter. Omitted means "ephemeral". */
  quickChatDefaultPersistence?: QuickChatDefaultPersistence;
  /** Keep the floating Quick Chat mini-modal open when clicking outside. Omitted means true (stays pinned). */
  quickChatKeepOpenOnBlur?: boolean;
  /** Settings → Bots → Bubbles → Allow bubbles. Omitted means on; off hides every head and the bubble button. */
  botBubblesEnabled?: boolean;
  /** Settings → Bots → Bubbles → Float over other apps (macOS only). Omitted means on. */
  botBubblesFloatOverApps?: boolean;
  /** On-device Form Fill Specialist; gated on Computer Use plus a verified local model package. Default off. */
  formFillSpecialistEnabled?: boolean;
  /** Global scheduler gate. Turning it off pauses jobs without deleting them. */
  scheduledTasksEnabled?: boolean;
  scheduledDefaultMode?: ScheduledTaskMode;
  scheduledDefaultPermission?: ScheduledTaskPermission;
  scheduledDefaultMcpEnabled?: boolean;
  scheduledDefaultNotify?: boolean;
  scheduledDefaultTimezone?: string;
  /** Workspace chats may promise to check back later (`check_back`). Omitted means on. */
  chatCheckBacks?: boolean;
  /** Settings → Scheduled tasks → While you're away. Omitted means on; only `false` is stored. */
  keepAwakeWhileWorking?: boolean;
  /** Aiden assistant window, hotkey, and proactivity settings. */
  assistant?: AssistantConfig;
  /** Device-local display name used by the private usage profile. */
  profileName?: string;
  /** Main-owned first-run progress. Secrets and prompt drafts are never stored here. */
  onboarding?: OnboardingState;
  /** Telegram remote-control enable flag; gates long-poll polling. */
  telegramEnabled?: boolean;
  /** Paired Telegram owner chat id; undefined until first /start pairs. */
  telegramAllowedUserId?: number;
  /** Provider for Telegram turns; falls back to lastProviderId when unset. */
  telegramProviderId?: string;
  /** Model for Telegram turns; falls back to provider default when unset. */
  telegramModel?: string;
  /** Explicit reasoning effort for Telegram-originated turns. */
  telegramThinkingLevel?: GenerationThinkingLevel;
  /** Stream bounded answer previews into one edited Telegram message. */
  telegramDraftPreviews?: boolean;
  /** Technical activity projected into Telegram during a turn. */
  telegramActivity?: "quiet" | "thinking" | "tools" | "verbose";
  /** Native Rich Markdown or legacy HTML assistant answer delivery. */
  telegramRendering?: "rich" | "html";
  /** Automatic voice reply policy; explicit telegram_voice actions remain available. */
  telegramVoiceMode?: "hidden" | "mirror" | "always";
  /**
   * Explicit folder workspace authorized for Telegram project automation.
   * Omitted keeps Telegram turns assistant-only.
   */
  telegramWorkspaceId?: string;
  /** Named Telegram bot profiles; the legacy root fields remain profiles.default. */
  telegramProfiles?: Record<string, TelegramProfileSettings>;
  /** Profile currently edited by Settings and used as the default direct-delivery target. */
  telegramActiveProfile?: string;
  /** Provision and route private-chat topics to explicit Aiden workspace targets. */
  telegramThreadedMode?: boolean;
}

export interface TelegramProfileSettings {
  enabled?: boolean;
  allowedUserId?: number;
  providerId?: string;
  model?: string;
  thinkingLevel?: GenerationThinkingLevel;
  draftPreviews?: boolean;
  activity?: "quiet" | "thinking" | "tools" | "verbose";
  rendering?: "rich" | "html";
  voiceMode?: "hidden" | "mirror" | "always";
  workspaceId?: string;
  threadedMode?: boolean;
}

export type ComputerUseStatusState =
  | "disabled"
  | "ready"
  | "permission_required"
  | "production_build_required"
  | "unsupported"
  | "unavailable"
  | "incompatible"
  | "error";

export interface ComputerUseStatus {
  enabled: boolean;
  beta: true;
  state: ComputerUseStatusState;
  detail: string;
  ready: boolean;
  available: boolean;
  retryable: boolean;
  canRequestPermissions: boolean;
  driverVersion?: string;
  permissions: {
    accessibility: boolean | null;
    screenRecording: boolean | null;
  };
}

export interface Profile {
  name: string;
}

/** Date windows available in the private, device-local usage profile. */
export type UsageDateRange = "7d" | "30d" | "90d" | "1y" | "all";

/** Token counts reported by a model provider. Reasoning is a subset of output. */
export interface UsageTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anthropic's one-hour cache writes, already included in cacheWrite. */
  cacheWrite1h?: number;
  reasoning: number;
  total: number;
}

export interface UsageDaySummary {
  date: string;
  requests: number;
  reportedTokenRequests: number;
  unmeteredRequests: number;
  tokens: UsageTokenBreakdown;
  hostedCostUsd: number;
}

export interface UsageModelSummary {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  local: boolean;
  requests: number;
  reportedTokenRequests: number;
  unmeteredRequests: number;
  tokens: UsageTokenBreakdown;
  hostedCostUsd: number;
}

/** Privacy-safe aggregate returned to the renderer. No chat or workspace content is persisted. */
export interface UsageSummary {
  range: UsageDateRange;
  startDate: string;
  endDate: string;
  totals: {
    requests: number;
    completedRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    reportedTokenRequests: number;
    unmeteredRequests: number;
    localRequests: number;
    costedRequests: number;
    unpricedHostedRequests: number;
    hostedCostUsd: number;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
    tokens: UsageTokenBreakdown;
  };
  days: UsageDaySummary[];
  models: UsageModelSummary[];
}

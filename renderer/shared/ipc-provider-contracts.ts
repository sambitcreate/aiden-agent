// Electron-free shared IPC contracts for LLM providers, ChatGPT/Codex, and
// provider authentication flows. Raw credentials never cross IPC.

import type { CodexThinkingLevel } from "./codex-thinking.js";
import type { CustomModelOptions } from "./custom-model-options.js";
import type { GenerationThinkingLevel } from "./generation-thinking.js";
import type { ProviderArtwork } from "./provider-artwork.js";

export type ProviderKind = "openai" | "anthropic";

export type ProviderDeployment = "local" | "hosted";

export type ProviderModelType = "llm" | "embedding" | "reranker" | "image" | "audio" | "video";

/** Metadata reported by the configured provider during explicit model discovery. */
export interface ProviderModelMetadata {
  overrides?: CustomModelOptions;
  manuallyAdded?: boolean;
  source: "lmstudio" | "ollama" | "provider";
  name?: string;
  type?: ProviderModelType;
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  /** Distinct Aiden thinking choices supported by this native model. */
  thinkingLevels?: GenerationThinkingLevel[];
  /** False when Google's minimum thinking can only be hidden, not disabled. */
  thinkingCanDisable?: boolean;
  contextLength?: number;
  parameterCount?: string;
  format?: string;
}

/** A configured connection to an LLM backend (hosted or local). */
export interface StoredProvider {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Optional normalized artwork for custom providers. Never contains a filesystem path. */
  artwork?: ProviderArtwork;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Suggested / cached model ids for the picker. */
  models: string[];
  /** Provider-reported metadata captured alongside the last explicit discovery. */
  modelMetadata?: Record<string, ProviderModelMetadata>;
  /** User-authored model intent, portable independently of discovery cache. */
  customModelOptions?: Record<string, CustomModelOptions & { manuallyAdded?: boolean }>;
  defaultModel?: string;
  /** Whether this provider requires an API key (local backends often don't). */
  needsKey: boolean;
  /**
   * Where inference runs. When unset, Aiden infers from the base URL (loopback =
   * local). Custom / Tailscale servers can override so loading UX and usage
   * treat them as local even off localhost.
   */
  deployment?: ProviderDeployment;
  /** Explicit opt-in for an existing llama-server native classifier endpoint. */
  llamaCppClassifierEnabled?: boolean;
  /** Legacy marker retained only for persisted custom-connection migration. */
  isPreset?: boolean;
  /**
   * A provider supplied by Pi itself. Its endpoint, models, authentication,
   * and stream transport are Pi-owned rather than renderer-configurable.
   */
  isBuiltin?: boolean;
}

/** Provider as exposed to the renderer — `hasKey` is derived, the key itself never leaves the backend. */
export interface Provider extends StoredProvider {
  hasKey: boolean;
  /** True only when Aiden owns a stored credential it can remove. */
  canLogout?: boolean;
  /** Former custom IDs remapped during a safe provider-identity migration. */
  legacyIds?: string[];
  /** Built-in providers: the kind of credential Aiden stores (never the value). */
  credentialType?: "api_key" | "oauth";
  /** Built-in API-key providers: custom connectors may use this key on this device (Settings → Providers). */
  connectorKeySharing?: boolean;
  /** Pi-owned setup options. No credentials or provider environment values cross IPC. */
  authMethods?: Array<{
    type: "api_key" | "oauth";
    label: string;
    canLogin: boolean;
  }>;
}

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;

export interface CodexModelSummary {
  id: string;
  name: string;
  api: "openai-codex-responses";
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: CodexThinkingLevel[];
}

export interface CodexProviderSnapshot {
  id: typeof OPENAI_CODEX_PROVIDER_ID;
  name: string;
  authName: string;
  /** Configuration-only status. Request-time refresh may still require re-login. */
  configured: boolean;
  /** Set only after request-time auth resolution proves the stored sign-in needs repair. */
  needsAttention: boolean;
  models: CodexModelSummary[];
}

export type ProviderAuthPromptType = "text" | "secret" | "select" | "manual_code";

export interface ProviderAuthSelectOption {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderAuthPrompt {
  flowId: string;
  providerId: string;
  promptId: string;
  type: ProviderAuthPromptType;
  message: string;
  placeholder?: string;
  options?: ProviderAuthSelectOption[];
}

export type ProviderAuthEvent =
  | {
      flowId: string;
      providerId: string;
      type: "info";
      message: string;
      links?: Array<{ url: string; label?: string }>;
    }
  | {
      flowId: string;
      providerId: string;
      type: "auth_url";
      url: string;
      instructions?: string;
    }
  | {
      flowId: string;
      providerId: string;
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | {
      flowId: string;
      providerId: string;
      type: "browser_open_failed";
      url: string;
      message: string;
    }
  | {
      flowId: string;
      providerId: string;
      type: "progress";
      message: string;
    };

export interface ProviderAuthDone {
  flowId: string;
  providerId: string;
  cancelled: boolean;
  warning?: string;
}

export type ProviderAuthErrorCode =
  | "port_busy"
  | "rate_limited"
  | "timed_out"
  | "verification_failed"
  | "sign_in_failed";

export interface ProviderAuthError {
  flowId: string;
  providerId: string;
  code: ProviderAuthErrorCode;
  message: string;
}

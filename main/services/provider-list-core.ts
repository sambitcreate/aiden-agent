import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_LABEL,
  type CodexProviderSnapshot,
} from "./codex-provider.js";
import type { Provider } from "./types.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";

export const CODEX_PROVIDER_STATUS_CHANGED_CHANNEL = "providers:auth:status-changed";

export interface CodexProviderStatusChangedEvent {
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  needsAttention: boolean;
}

/** Electron-free bridge contract: every service notification becomes one global renderer event. */
export function forwardCodexProviderStatusChanges(
  source: {
    onStatusChange(listener: (needsAttention: boolean) => void): () => void;
  },
  broadcast: (channel: NotificationChannel, event: CodexProviderStatusChangedEvent) => void,
  onAuthorityChanged: () => void = () => undefined,
): () => void {
  return source.onStatusChange((needsAttention) => {
    onAuthorityChanged();
    broadcast(CODEX_PROVIDER_STATUS_CHANGED_CHANNEL, {
      providerId: OPENAI_CODEX_PROVIDER_ID,
      needsAttention,
    });
  });
}

/** The OAuth-backed Codex ID never enters the generic API-key configuration path. */
export function assertMutableProviderId(providerId: string): void {
  if (providerId === OPENAI_CODEX_PROVIDER_ID) {
    throw new Error("ChatGPT / Codex is managed through its built-in sign-in settings.");
  }
}

/**
 * Add Codex to the shared picker only when OAuth metadata says it is configured.
 * Any stale custom record using the reserved ID is hidden in either state.
 */
export function mergeCodexProvider(
  providers: readonly Provider[],
  snapshot: CodexProviderSnapshot | null,
): Provider[] {
  const legacyProviders = providers.filter((provider) => provider.id !== OPENAI_CODEX_PROVIDER_ID);
  if (!snapshot?.configured || snapshot.needsAttention) return legacyProviders;

  const modelIds = [...new Set(snapshot.models.map((model) => model.id))];
  const defaultModel = modelIds.includes(OPENAI_CODEX_DEFAULT_MODEL)
    ? OPENAI_CODEX_DEFAULT_MODEL
    : modelIds[0];
  return [
    ...legacyProviders,
    {
      id: OPENAI_CODEX_PROVIDER_ID,
      kind: "openai",
      label: OPENAI_CODEX_PROVIDER_LABEL,
      baseUrl: OPENAI_CODEX_BASE_URL,
      models: modelIds,
      modelMetadata: Object.fromEntries(
        snapshot.models.map((model) => [
          model.id,
          {
            source: "provider",
            name: model.name,
            type: "llm",
            vision: model.vision,
            toolCall: true,
            reasoning: model.reasoning,
            thinkingLevels: model.thinkingLevels,
            contextLength: model.contextWindow,
          },
        ]),
      ),
      defaultModel,
      needsKey: true,
      isPreset: true,
      isBuiltin: true,
      hasKey: true,
      canLogout: true,
    },
  ];
}

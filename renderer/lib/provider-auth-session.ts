import type {
  ProviderAuthDone,
  ProviderAuthError,
  ProviderAuthEvent,
  ProviderAuthPrompt,
} from "./types";

export type PiAuthMethod = "api_key" | "oauth";

export interface ProviderAuthSessionApi {
  authStart(request: {
    flowId: string;
    providerId: string;
    authType: PiAuthMethod;
  }): Promise<{ started: true }>;
  authRespond(request: {
    flowId: string;
    providerId: string;
    promptId: string;
    value: string;
  }): Promise<{ accepted: true }>;
  authCancel(request: {
    flowId: string;
    providerId: string;
  }): Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }>;
  onAuthPrompt(handler: (prompt: ProviderAuthPrompt) => void): () => void;
  onAuthEvent(handler: (event: ProviderAuthEvent) => void): () => void;
  onAuthDone(handler: (event: ProviderAuthDone) => void): () => void;
  onAuthError(handler: (event: ProviderAuthError) => void): () => void;
}

export interface ProviderAuthSessionHandlers {
  onPrompt(prompt: ProviderAuthPrompt): void;
  onEvent(event: ProviderAuthEvent): void;
  onDone(event: ProviderAuthDone): void;
  onError(event: ProviderAuthError): void;
}

export interface ProviderAuthSession {
  readonly flowId: string;
  isActive(): boolean;
  isCurrentPrompt(promptId: string): boolean;
  start(): Promise<{ started: true }>;
  respond(promptId: string, value: string): Promise<{ accepted: true }>;
  cancel(): Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }>;
  dispose(): void;
}

function defaultFlowId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Generic renderer binding for Pi-owned setup. It subscribes before start and
 * accepts terminal messages only for its opaque flow ID and provider ID.
 */
export function createProviderAuthSession(
  api: ProviderAuthSessionApi,
  providerId: string,
  authType: PiAuthMethod,
  handlers: ProviderAuthSessionHandlers,
  createFlowId: () => string = defaultFlowId,
): ProviderAuthSession {
  const flowId = createFlowId();
  const request = { flowId, providerId, authType } as const;
  let disposed = false;
  let started = false;
  let cancelRequested = false;
  let currentPromptId: string | undefined;
  const pendingResponses = new Set<string>();
  const unsubscribe: Array<() => void> = [];

  const matches = (event: { flowId: string; providerId: string }): boolean =>
    !disposed && event.flowId === flowId && event.providerId === providerId;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    currentPromptId = undefined;
    pendingResponses.clear();
    for (const remove of unsubscribe.splice(0)) remove();
  };

  const assertAvailable = (): void => {
    if (disposed) throw new Error("Provider setup session is unavailable.");
  };

  try {
    unsubscribe.push(
      api.onAuthPrompt((prompt) => {
        if (!matches(prompt) || cancelRequested) return;
        currentPromptId = prompt.promptId;
        handlers.onPrompt(prompt);
      }),
      api.onAuthEvent((event) => {
        if (matches(event) && !cancelRequested) handlers.onEvent(event);
      }),
      api.onAuthDone((event) => {
        if (!matches(event)) return;
        dispose();
        handlers.onDone(event);
      }),
      api.onAuthError((event) => {
        if (!matches(event)) return;
        dispose();
        handlers.onError(event);
      }),
    );
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    flowId,
    isActive: () => !disposed,
    isCurrentPrompt: (promptId) => !disposed && !cancelRequested && currentPromptId === promptId,
    async start() {
      assertAvailable();
      if (started) throw new Error("Provider setup session is unavailable.");
      started = true;
      try {
        return await api.authStart(request);
      } catch (error) {
        dispose();
        throw error;
      }
    },
    async respond(promptId, value) {
      assertAvailable();
      if (cancelRequested || currentPromptId !== promptId || pendingResponses.has(promptId)) {
        throw new Error("Provider setup prompt is unavailable.");
      }
      pendingResponses.add(promptId);
      try {
        return await api.authRespond({ flowId, providerId, promptId, value });
      } finally {
        pendingResponses.delete(promptId);
      }
    },
    async cancel() {
      assertAvailable();
      cancelRequested = true;
      currentPromptId = undefined;
      pendingResponses.clear();
      return api.authCancel({ flowId, providerId });
    },
    dispose,
  };
}

import type {
  ProviderAuthDone,
  ProviderAuthError,
  ProviderAuthEvent,
  ProviderAuthPrompt,
} from "./types";

const PROVIDER_ID = "openai-codex" as const;

export interface CodexAuthSessionApi {
  authStart(request: {
    flowId: string;
    providerId: typeof PROVIDER_ID;
  }): Promise<{ started: true }>;
  authRespond(request: {
    flowId: string;
    providerId: typeof PROVIDER_ID;
    promptId: string;
    value: string;
  }): Promise<{ accepted: true }>;
  authCancel(request: {
    flowId: string;
    providerId: typeof PROVIDER_ID;
  }): Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }>;
  onAuthPrompt(handler: (prompt: ProviderAuthPrompt) => void): () => void;
  onAuthEvent(handler: (event: ProviderAuthEvent) => void): () => void;
  onAuthDone(handler: (event: ProviderAuthDone) => void): () => void;
  onAuthError(handler: (event: ProviderAuthError) => void): () => void;
}

export interface CodexAuthSessionHandlers {
  onPrompt(prompt: ProviderAuthPrompt): void;
  onEvent(event: ProviderAuthEvent): void;
  onDone(event: ProviderAuthDone): void;
  onError(event: ProviderAuthError): void;
}

export interface CodexAuthSession {
  readonly flowId: string;
  isActive(): boolean;
  isCancelling(): boolean;
  isCurrentPrompt(promptId: string): boolean;
  start(): Promise<{ started: true }>;
  respond(promptId: string, value: string): Promise<{ accepted: true }>;
  cancel(): Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }>;
  dispose(): void;
}

const releasedSessions = new WeakSet<CodexAuthSession>();

/**
 * Cancel an auth flow when its settings surface unmounts, but retain terminal
 * listeners after a successful acknowledgement. A cancellation can cross the
 * credential-commit boundary and return `finishing`; its eventual terminal
 * notification still has to reconcile the shared provider cache. If the IPC
 * request itself fails, no terminal delivery is reliable and listeners are
 * removed immediately.
 */
export async function releaseCodexAuthSession(session: CodexAuthSession | null): Promise<void> {
  if (!session || releasedSessions.has(session)) return;
  releasedSessions.add(session);
  try {
    await session.cancel();
  } catch {
    session.dispose();
  }
}

export function handleCodexAuthTerminal(effects: {
  refreshProviderState(): void;
  isMounted(): boolean;
  updateMountedView(): void;
}): void {
  effects.refreshProviderState();
  if (effects.isMounted()) effects.updateMountedView();
}

function defaultFlowId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Subscribes to every auth notification before exposing `start()`. The session
 * filters by its unguessable flow id and removes all listeners on either
 * terminal event, start failure, failed unmount cancellation, or explicit disposal.
 */
export function createCodexAuthSession(
  api: CodexAuthSessionApi,
  handlers: CodexAuthSessionHandlers,
  createFlowId: () => string = defaultFlowId,
): CodexAuthSession {
  const flowId = createFlowId();
  const request = { flowId, providerId: PROVIDER_ID } as const;
  let disposed = false;
  let started = false;
  let cancelRequested = false;
  let cancelRequest:
    | Promise<{ cancelled: true } | { cancelled: false; reason: "finishing" }>
    | undefined;
  let currentPromptId: string | undefined;
  const pendingResponses = new Set<string>();
  const unsubscribe: Array<() => void> = [];

  const matches = (event: { flowId: string; providerId: string }): boolean =>
    !disposed && event.flowId === flowId && event.providerId === PROVIDER_ID;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    currentPromptId = undefined;
    pendingResponses.clear();
    for (const remove of unsubscribe.splice(0)) remove();
  }

  function assertAvailable(): void {
    if (disposed) throw new Error("ChatGPT sign-in session is unavailable.");
  }

  try {
    unsubscribe.push(
      api.onAuthPrompt((prompt) => {
        if (!matches(prompt) || cancelRequested) return;
        currentPromptId = prompt.promptId;
        handlers.onPrompt(prompt);
      }),
    );
    unsubscribe.push(
      api.onAuthEvent((event) => {
        if (matches(event) && !cancelRequested) handlers.onEvent(event);
      }),
    );
    unsubscribe.push(
      api.onAuthDone((event) => {
        if (!matches(event)) return;
        dispose();
        handlers.onDone(event);
      }),
    );
    unsubscribe.push(
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
    isCancelling: () => !disposed && cancelRequested,
    isCurrentPrompt: (promptId) => !disposed && !cancelRequested && currentPromptId === promptId,
    async start() {
      assertAvailable();
      if (started) throw new Error("ChatGPT sign-in session is unavailable.");
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
        throw new Error("ChatGPT sign-in prompt is unavailable.");
      }
      pendingResponses.add(promptId);
      try {
        return await api.authRespond({ ...request, promptId, value });
      } finally {
        pendingResponses.delete(promptId);
      }
    },
    async cancel() {
      assertAvailable();
      cancelRequested = true;
      currentPromptId = undefined;
      pendingResponses.clear();
      if (cancelRequest) return cancelRequest;
      const attempt = api.authCancel(request);
      cancelRequest = attempt;
      try {
        return await attempt;
      } catch (error) {
        if (cancelRequest === attempt) cancelRequest = undefined;
        throw error;
      }
    },
    dispose,
  };
}

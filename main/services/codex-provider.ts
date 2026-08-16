import { createHash } from "node:crypto";
import type {
  Api,
  AuthResult,
  AuthInteraction,
  AssistantMessage,
  Credential,
  CredentialStore,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  OAuthCredential,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { cleanupSessionResources, lazyStream } from "@earendil-works/pi-ai";
import { isCodexAuthenticationFailure } from "./codex-auth-failure.js";
import {
  codexThinkingLevelsForModel,
  isCodexThinkingLevel,
  type CodexThinkingLevel,
} from "../../renderer/shared/codex-thinking.js";
import type { ModelInfo } from "./types.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_PROVIDER_LABEL = "ChatGPT / Codex";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.4";

export type CodexRuntimeErrorCode =
  | "model_unavailable"
  | "request_cancelled"
  | "sign_in_required"
  | "sign_in_needs_attention"
  | "temporarily_unavailable";

export class CodexRuntimeError extends Error {
  readonly name = "CodexRuntimeError";

  constructor(
    readonly code: CodexRuntimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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

export interface PreparedCodexIsolatedStream {
  model: Model<Api>;
  options: ModelsSimpleStreamOptions;
  /** Aborts immediately when login/logout supersedes the credential generation. */
  signal: AbortSignal;
  observeResult(result: AssistantMessage, metadata?: { authenticationFailure?: boolean }): void;
}

interface CodexAuthAttempt {
  credentialGeneration: number;
  generationSignal: AbortSignal;
  id: number;
}

interface OAuthCredentialIdentity {
  access: string;
  refresh: string;
  expires: number;
}

interface PreparedCodexAuth {
  attempt: CodexAuthAttempt;
  auth: AuthResult;
}

interface CodexRefreshOperation {
  controller: AbortController;
  credentialGeneration: number;
  credentialRevision: string;
  promise: Promise<OAuthCredential | undefined>;
}

class CodexAuthCancelledError extends Error {
  readonly name = "CodexAuthCancelledError";
}

class CodexAuthTimedOutError extends Error {
  readonly name = "CodexAuthTimedOutError";
}

class CodexCredentialSupersededError extends Error {
  readonly name = "CodexCredentialSupersededError";
}

const DEFAULT_AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_OPERATION_TIMEOUT_MS = 60_000;
const MAX_SUPERSEDED_AUTH_RETRIES = 2;
const OAUTH_REFRESH_SKEW_MS = 60_000;

function credentialIdentity(credential: Credential | undefined): OAuthCredentialIdentity | null {
  return credential?.type === "oauth"
    ? {
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      }
    : null;
}

function credentialRevision(identity: OAuthCredentialIdentity | null): string | null {
  if (!identity) return null;
  return createHash("sha256")
    .update(identity.access)
    .update("\0")
    .update(identity.refresh)
    .update("\0")
    .update(String(identity.expires))
    .digest("hex");
}

function mergeProviderHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === name.toLowerCase()) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new CodexAuthCancelledError("Codex request cancelled.");
}

/** Race a promise without leaving abort listeners attached to a long-lived signal. */
function waitForAbort<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]) {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const alreadyAborted = activeSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    // The caller already created/started this promise before entering the
    // helper. Observe a later rejection even though cancellation wins now, or
    // Electron can promote the orphaned rejection to a main-process failure.
    void promise.catch(() => undefined);
    return Promise.reject<T>(abortReason(alreadyAborted));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abortHandlers = new Map<AbortSignal, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of abortHandlers) {
        signal.removeEventListener("abort", handler);
      }
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    for (const signal of activeSignals) {
      // Capture the signal directly. Node/Electron may null `currentTarget` for
      // a later listener when an earlier listener mutates the listener set
      // during the same abort dispatch.
      const handler = () => finish(() => reject(abortReason(signal)));
      abortHandlers.set(signal, handler);
      signal.addEventListener("abort", handler, { once: true });
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join("\n");
}

function summarizeModel(model: Model<Api>): CodexModelSummary {
  if (model.api !== "openai-codex-responses") {
    throw new Error(`Unexpected API for OpenAI Codex model "${model.id}".`);
  }
  return {
    id: model.id,
    name: model.name,
    api: "openai-codex-responses",
    reasoning: model.reasoning,
    vision: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevels: codexThinkingLevelsForModel(model),
  };
}

function modelInfo(model: Model<Api>): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    vision: model.input.includes("image"),
    toolCall: true,
    reasoning: model.reasoning,
    openWeights: false,
    contextLength: model.contextWindow,
    outputLimit: model.maxTokens,
    inputModalities: [...model.input],
    metadataSource: "provider",
    matched: true,
  };
}

export class CodexProviderService {
  private localNeedsAttention = false;
  private remoteNeedsAttention = false;
  private credentialGeneration = 0;
  private credentialGenerationController = new AbortController();
  private latestAuthAttempt = 0;
  private latestLocalConclusionAttempt = 0;
  private latestRemoteConclusionAttempt = 0;
  private hasObservedCredential = false;
  private observedCredentialRevision: string | null = null;
  private refreshOperation: CodexRefreshOperation | null = null;
  private readonly statusListeners = new Set<(needsAttention: boolean) => void>();

  constructor(
    private readonly models: Models,
    private readonly credentials: CredentialStore,
    private readonly cleanupSessions: () => void = cleanupSessionResources,
    private readonly authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    private readonly refreshOperationTimeoutMs = DEFAULT_REFRESH_OPERATION_TIMEOUT_MS,
  ) {
    const provider = models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    if (!provider?.auth.oauth) {
      throw new Error("The installed Pi release does not provide OpenAI Codex OAuth.");
    }
  }

  async snapshot(): Promise<CodexProviderSnapshot> {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    if (!provider?.auth.oauth) throw new Error("OpenAI Codex provider is unavailable.");
    const auth = await this.models.checkAuth(OPENAI_CODEX_PROVIDER_ID);
    return {
      id: OPENAI_CODEX_PROVIDER_ID,
      name: provider.name,
      authName: provider.auth.oauth.name,
      configured: auth?.type === "oauth",
      needsAttention:
        auth?.type === "oauth" && (this.localNeedsAttention || this.remoteNeedsAttention),
      models: this.models.getModels(OPENAI_CODEX_PROVIDER_ID).map(summarizeModel),
    };
  }

  /** Safe status after logout has committed but a fresh Pi auth probe cannot complete. */
  committedLogoutSnapshot(): CodexProviderSnapshot {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    let models: CodexModelSummary[] = [];
    try {
      models = this.models.getModels(OPENAI_CODEX_PROVIDER_ID).map(summarizeModel);
    } catch {
      // Model metadata is optional in this post-commit recovery response.
    }
    return {
      id: OPENAI_CODEX_PROVIDER_ID,
      name: provider?.name ?? OPENAI_CODEX_PROVIDER_LABEL,
      authName: provider?.auth.oauth?.name ?? "ChatGPT",
      configured: false,
      needsAttention: false,
      models,
    };
  }

  /** Complete the remote OAuth exchange without mutating the credential store. */
  authenticate(interaction: AuthInteraction): Promise<OAuthCredential> {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    if (!provider?.auth.oauth) throw new Error("OpenAI Codex provider is unavailable.");
    return provider.auth.oauth.login(interaction);
  }

  /** Commit only after the owning flow has crossed its cancellation boundary. */
  async commitCredential(credential: OAuthCredential): Promise<void> {
    await this.credentials.modify(OPENAI_CODEX_PROVIDER_ID, async () => credential);
    this.hasObservedCredential = true;
    this.observedCredentialRevision = credentialRevision(credentialIdentity(credential));
    this.advanceCredentialGeneration();
    this.latestAuthAttempt += 1;
    this.resetRuntimeAttention(true);
  }

  async logout(): Promise<void> {
    await this.models.logout(OPENAI_CODEX_PROVIDER_ID);
    this.hasObservedCredential = true;
    this.observedCredentialRevision = null;
    this.advanceCredentialGeneration();
    this.latestAuthAttempt += 1;
    this.resetRuntimeAttention(true);
  }

  /** Notify the main-process bridge when request-time credential health changes. */
  onStatusChange(listener: (needsAttention: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatusChange(previous: boolean, force = false): void {
    const needsAttention = this.localNeedsAttention || this.remoteNeedsAttention;
    if (!force && previous === needsAttention) return;
    for (const listener of this.statusListeners) {
      // Health tracking must not make a model request fail because a UI observer did.
      try {
        listener(needsAttention);
      } catch {
        // Observers are best-effort; status remains authoritative in this service.
      }
    }
  }

  private resetRuntimeAttention(forceNotification = false): void {
    const previous = this.localNeedsAttention || this.remoteNeedsAttention;
    this.localNeedsAttention = false;
    this.remoteNeedsAttention = false;
    this.latestLocalConclusionAttempt = 0;
    this.latestRemoteConclusionAttempt = 0;
    this.notifyStatusChange(previous, forceNotification);
  }

  private setLocalNeedsAttention(needsAttention: boolean): void {
    const previous = this.localNeedsAttention || this.remoteNeedsAttention;
    this.localNeedsAttention = needsAttention;
    this.notifyStatusChange(previous);
  }

  private setRemoteNeedsAttention(needsAttention: boolean): void {
    const previous = this.localNeedsAttention || this.remoteNeedsAttention;
    this.remoteNeedsAttention = needsAttention;
    this.notifyStatusChange(previous);
  }

  private beginAuthAttempt(): CodexAuthAttempt {
    return {
      credentialGeneration: this.credentialGeneration,
      generationSignal: this.credentialGenerationController.signal,
      id: ++this.latestAuthAttempt,
    };
  }

  private advanceCredentialGeneration(): void {
    const reason = new CodexCredentialSupersededError("Codex credential changed.");
    this.credentialGenerationController.abort(reason);
    this.refreshOperation?.controller.abort(reason);
    this.credentialGeneration += 1;
    this.credentialGenerationController = new AbortController();
    // Pi keys cached Codex WebSockets only by session ID. A credential change
    // must close every session before another turn can reuse the old account.
    // The request-generation signal above is the hard security boundary; a
    // best-effort cache cleanup must not turn an already-persisted login/logout
    // into a false failure if an unrelated registered cleanup throws.
    try {
      this.cleanupSessions();
    } catch {
      // Active requests were already aborted and future dispatches use the new
      // generation. The next mutation will attempt global cleanup again.
    }
  }

  /** Track Pi's serialized OAuth refreshes without retaining another plaintext token copy. */
  private observeCredential(identity: OAuthCredentialIdentity | null): void {
    const revision = credentialRevision(identity);
    if (!this.hasObservedCredential) {
      this.hasObservedCredential = true;
      this.observedCredentialRevision = revision;
      return;
    }
    if (this.observedCredentialRevision === revision) return;
    this.observedCredentialRevision = revision;
    this.advanceCredentialGeneration();
    this.resetRuntimeAttention();
  }

  private updateLocalAttention(attempt: CodexAuthAttempt, needsAttention: boolean): void {
    if (
      this.credentialGeneration === attempt.credentialGeneration &&
      attempt.id >= this.latestLocalConclusionAttempt
    ) {
      this.latestLocalConclusionAttempt = attempt.id;
      this.setLocalNeedsAttention(needsAttention);
    }
  }

  private updateRemoteAttention(attempt: CodexAuthAttempt, needsAttention: boolean): void {
    if (
      this.credentialGeneration !== attempt.credentialGeneration ||
      attempt.id < this.latestRemoteConclusionAttempt
    ) {
      return;
    }
    this.latestRemoteConclusionAttempt = attempt.id;
    this.setRemoteNeedsAttention(needsAttention);
  }

  private bindAttemptToCurrentCredential(attempt: CodexAuthAttempt): void {
    attempt.credentialGeneration = this.credentialGeneration;
    attempt.generationSignal = this.credentialGenerationController.signal;
  }

  private assertAttemptCurrent(attempt: CodexAuthAttempt): void {
    if (
      attempt.credentialGeneration !== this.credentialGeneration ||
      attempt.generationSignal.aborted
    ) {
      throw new CodexCredentialSupersededError("Codex credential changed.");
    }
  }

  private refreshCredential(
    credential: OAuthCredential,
    attempt: CodexAuthAttempt,
    requestSignal?: AbortSignal,
  ): Promise<OAuthCredential | undefined> {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    const oauth = provider?.auth.oauth;
    if (!oauth) throw new Error("OpenAI Codex provider is unavailable.");
    const revision = credentialRevision(credentialIdentity(credential));
    if (!revision) throw new Error("OpenAI Codex credential is unavailable.");

    let operation = this.refreshOperation;
    if (
      !operation ||
      operation.credentialGeneration !== attempt.credentialGeneration ||
      operation.credentialRevision !== revision
    ) {
      const controller = new AbortController();
      const operationGeneration = attempt.credentialGeneration;
      let operationTimeout: ReturnType<typeof setTimeout> | undefined;
      // Reconciliation intentionally outlives the bounded public operation.
      // Pi 0.80.10 drops the refresh signal, so a token server can still rotate
      // a one-time token after our deadline. Preserve that valid result only if
      // both the credential revision and app-owned generation are unchanged.
      const completion = Promise.resolve()
        .then(() => oauth.refresh(credential, controller.signal))
        .then(async (refreshed) => {
          const post = await this.credentials.modify(OPENAI_CODEX_PROVIDER_ID, async (current) =>
            this.credentialGeneration === operationGeneration &&
            credentialRevision(credentialIdentity(current)) === revision
              ? refreshed
              : undefined,
          );
          // An explicit login/logout or another successful rotation may win
          // while this conditional write is queued. Its generation owns the
          // store and this late result is inert.
          if (this.credentialGeneration !== operationGeneration) {
            throw new CodexCredentialSupersededError("Codex credential changed.");
          }
          const persisted = post?.type === "oauth" ? post : undefined;
          // A normal successful rotation advances the generation. Release this
          // operation first so it does not abort its own bounded waiter; a late
          // rotation instead aborts whichever newer old-token retry is active.
          if (this.refreshOperation?.controller === controller) this.refreshOperation = null;
          this.observeCredential(credentialIdentity(persisted));
          return persisted;
        })
        .catch((error: unknown) => {
          // Callers can time out while Pi's non-abortable Codex fetch continues.
          // A late invalid_grant still proves the unchanged stored credential is
          // broken, so publish that conclusive result from the shared operation.
          if (
            this.credentialGeneration === operationGeneration &&
            isCodexAuthenticationFailure(errorMessages(error))
          ) {
            this.updateLocalAttention(attempt, true);
          }
          throw error;
        });
      // Bound the complete refresh-and-persist pipeline. The completion above
      // remains guarded and observed after timeout so a late one-time rotation
      // is not discarded, while this shared slot is released for recovery.
      const promise = waitForAbort(completion, [controller.signal]).finally(() => {
        if (operationTimeout) clearTimeout(operationTimeout);
        if (this.refreshOperation?.controller === controller) this.refreshOperation = null;
      });
      // Pi 0.80.10 does not forward the signal into Codex's refresh fetch. The
      // service still needs a terminal lifecycle so one dead dependency call
      // cannot pin every later retry to the same promise forever. This longer
      // operation deadline is deliberately separate from each caller's short
      // wait below; callers may leave while a healthy shared rotation finishes.
      operationTimeout = setTimeout(
        () =>
          controller.abort(
            new CodexAuthTimedOutError("ChatGPT credential refresh operation timed out."),
          ),
        this.refreshOperationTimeoutMs,
      );
      operation = {
        controller,
        credentialGeneration: attempt.credentialGeneration,
        credentialRevision: revision,
        promise,
      };
      this.refreshOperation = operation;
    }

    // A caller may cancel or hit its deadline without killing a refresh shared
    // by another request. If the token server already rotated a one-time refresh
    // token, the service-owned operation still conditionally persists it.
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () =>
        timeoutController.abort(
          new CodexAuthTimedOutError("ChatGPT credential refresh timed out."),
        ),
      this.authTimeoutMs,
    );
    return waitForAbort(operation.promise, [
      requestSignal,
      attempt.generationSignal,
      timeoutController.signal,
    ]).finally(() => clearTimeout(timeout));
  }

  /**
   * Resolve Codex OAuth without holding the credential-store mutex across the
   * token endpoint. Pi's public OAuth contract accepts a signal, but this Pi
   * release's Codex fetch does not yet consume it. Each caller still has an
   * app-owned deadline; a successful late rotation is conditionally persisted,
   * while an explicit credential change makes that result inert.
   */
  private async resolveRuntimeAuth(
    model: Model<Api>,
    attempt: CodexAuthAttempt,
    requestSignal?: AbortSignal,
  ): Promise<AuthResult | undefined> {
    const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
    const oauth = provider?.auth.oauth;
    if (!oauth) throw new Error("OpenAI Codex provider is unavailable.");

    const stored = await waitForAbort(this.credentials.read(OPENAI_CODEX_PROVIDER_ID), [
      requestSignal,
      attempt.generationSignal,
    ]);
    let credential = stored?.type === "oauth" ? stored : undefined;
    this.observeCredential(credentialIdentity(credential));
    this.bindAttemptToCurrentCredential(attempt);
    if (!credential) return undefined;

    if (Date.now() >= credential.expires - OAUTH_REFRESH_SKEW_MS) {
      credential = await this.refreshCredential(credential, attempt, requestSignal);
      this.observeCredential(credentialIdentity(credential));
      this.bindAttemptToCurrentCredential(attempt);
      if (!credential) return undefined;
    }

    const auth = await waitForAbort(
      Promise.resolve().then(() => oauth.toAuth(credential)),
      [requestSignal, attempt.generationSignal],
    );
    this.assertAttemptCurrent(attempt);
    return {
      auth: {
        ...auth,
        headers: mergeProviderHeaders(auth.headers, model.headers),
      },
      source: "OAuth",
    };
  }

  private async prepareRuntimeAuth(
    model: Model<Api>,
    requestSignal?: AbortSignal,
  ): Promise<PreparedCodexAuth> {
    for (let supersededRetries = 0; ; supersededRetries += 1) {
      const attempt = this.beginAuthAttempt();
      try {
        const auth = await this.resolveRuntimeAuth(model, attempt, requestSignal);
        this.assertAttemptCurrent(attempt);
        if (!auth) {
          this.updateLocalAttention(attempt, false);
          throw new CodexRuntimeError(
            "sign_in_required",
            "Sign in with ChatGPT in Settings → Providers to use Codex.",
          );
        }
        this.updateLocalAttention(attempt, false);
        return { attempt, auth };
      } catch (error) {
        if (
          error instanceof CodexCredentialSupersededError &&
          supersededRetries < MAX_SUPERSEDED_AUTH_RETRIES &&
          !requestSignal?.aborted
        ) {
          continue;
        }
        if (error instanceof CodexRuntimeError) throw error;
        if (error instanceof CodexAuthCancelledError || requestSignal?.aborted) {
          throw new CodexRuntimeError("request_cancelled", "Codex request cancelled.");
        }
        if (error instanceof CodexCredentialSupersededError) {
          throw new CodexRuntimeError(
            "temporarily_unavailable",
            "Your ChatGPT sign-in changed while this request was starting. Try again.",
          );
        }

        const requiresSignIn = isCodexAuthenticationFailure(errorMessages(error));
        // Network failures and deadlines are inconclusive: keep the previous
        // credential verdict. Only definitive auth rejection or a successful
        // resolution may move the local health watermark.
        if (requiresSignIn) this.updateLocalAttention(attempt, true);
        throw new CodexRuntimeError(
          requiresSignIn ? "sign_in_needs_attention" : "temporarily_unavailable",
          requiresSignIn
            ? "Your ChatGPT sign-in needs attention. Sign in again in Settings → Providers."
            : "ChatGPT sign-in could not be refreshed right now. Check your connection and try again.",
        );
      }
    }
  }

  getModel(modelId: string): Model<Api> | undefined {
    return this.models.getModel(OPENAI_CODEX_PROVIDER_ID, modelId);
  }

  parseThinkingSelection(
    modelIdValue: unknown,
    levelValue: unknown,
  ): { modelId: string; level: CodexThinkingLevel } {
    if (typeof modelIdValue !== "string") throw new Error("Invalid Codex model.");
    const model = this.getModel(modelIdValue);
    if (!model?.reasoning) throw new Error("This Codex model does not support thinking.");
    if (
      !isCodexThinkingLevel(levelValue) ||
      !codexThinkingLevelsForModel(model).includes(levelValue)
    ) {
      throw new Error("This thinking level is not supported by the selected Codex model.");
    }
    return { modelId: modelIdValue, level: levelValue };
  }

  getModelInfo(modelId: string): ModelInfo | undefined {
    const model = this.getModel(modelId);
    return model ? modelInfo(model) : undefined;
  }

  /** Validate the selection and refresh OAuth before a request enters Pi's lazy stream. */
  async prepareRuntimeModel(modelId: string, signal?: AbortSignal): Promise<Model<Api>> {
    const model = this.getModel(modelId);
    if (!model) {
      throw new CodexRuntimeError(
        "model_unavailable",
        "That Codex model is no longer available. Choose another model and try again.",
      );
    }

    await this.prepareRuntimeAuth(model, signal);
    return model;
  }

  async getAvailableModels(): Promise<readonly Model<Api>[]> {
    return this.models.getAvailable(OPENAI_CODEX_PROVIDER_ID);
  }

  /**
   * Main-owned dispatch lease for a killable provider worker. Credentials are
   * refreshed and re-read behind the same generation barrier as streamSimple;
   * only the prepared one-request auth is handed to the child process.
   */
  async prepareIsolatedStream(
    model: Model<Api>,
    options?: ModelsSimpleStreamOptions,
  ): Promise<PreparedCodexIsolatedStream> {
    for (let supersededRetries = 0; ; supersededRetries += 1) {
      try {
        const { attempt, auth } = await this.prepareRuntimeAuth(model, options?.signal);
        let headers = mergeProviderHeaders(auth.auth.headers, options?.headers);
        if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
        const env =
          auth.env || options?.env ? { ...(auth.env ?? {}), ...(options?.env ?? {}) } : undefined;
        const requestModel = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
        const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
        const current = credentialIdentity(
          await waitForAbort(this.credentials.read(OPENAI_CODEX_PROVIDER_ID), [
            options?.signal,
            attempt.generationSignal,
          ]),
        );
        this.observeCredential(current);
        if (!current || current.access !== auth.auth.apiKey) {
          throw new CodexCredentialSupersededError("Codex credential changed.");
        }
        this.bindAttemptToCurrentCredential(attempt);
        this.assertAttemptCurrent(attempt);
        const signal = options?.signal
          ? AbortSignal.any([options.signal, attempt.generationSignal])
          : attempt.generationSignal;
        return {
          model: requestModel,
          signal,
          options: {
            ...providerOptions,
            transport: "sse",
            signal,
            apiKey: options?.apiKey ?? auth.auth.apiKey,
            headers,
            env,
            onResponse: async (response, responseModel) => {
              if (response.status === 401) this.updateRemoteAttention(attempt, true);
              else if (response.status >= 200 && response.status < 300) {
                this.updateRemoteAttention(attempt, false);
              }
              await options?.onResponse?.(response, responseModel);
            },
          },
          observeResult: (result, metadata) => {
            if (result.stopReason === "error") {
              if (
                metadata?.authenticationFailure === true ||
                isCodexAuthenticationFailure(result.errorMessage)
              ) {
                this.updateRemoteAttention(attempt, true);
              }
            } else if (result.stopReason !== "aborted") {
              this.updateRemoteAttention(attempt, false);
            }
          },
        };
      } catch (error) {
        if (
          error instanceof CodexCredentialSupersededError &&
          supersededRetries < MAX_SUPERSEDED_AUTH_RETRIES &&
          !options?.signal?.aborted
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /** Re-check OAuth on every Agent turn and observe backend rejection before it reaches the UI. */
  streamSimple: Models["streamSimple"] = (model, context, options) =>
    lazyStream(model, async () => {
      const provider = this.models.getProvider(OPENAI_CODEX_PROVIDER_ID);
      if (!provider) throw new Error("OpenAI Codex provider is unavailable.");
      const prepared = await this.prepareIsolatedStream(model, options);
      const source = provider.streamSimple(prepared.model, context, prepared.options);
      void source
        .result()
        .then(prepared.observeResult)
        .catch(() => undefined);
      return source;
    });
}

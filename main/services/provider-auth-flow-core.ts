import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import type { NotificationChannel } from "../../renderer/preload-channels.js";

const FLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE_LENGTH = 8_192;
const MAX_EXTERNAL_URL_LENGTH = 8_192;
const DEFAULT_FLOW_TIMEOUT_MS = 16 * 60 * 1_000;
const DEFAULT_AUTH_CLEANUP_TIMEOUT_MS = 5_000;
const SAFE_DIAGNOSTIC_CODES = new Set([
  "ABORT_ERR",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "Error",
  "ModelsError",
  "ProviderAuthCancellationError",
  "TypeError",
]);

export type ProviderAuthPromptType = AuthPrompt["type"];
export type ProviderAuthEventType = AuthEvent["type"];

export interface ProviderAuthSelectOptionDto {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderAuthPromptDto {
  flowId: string;
  providerId: string;
  promptId: string;
  type: ProviderAuthPromptType;
  message: string;
  placeholder?: string;
  options?: ProviderAuthSelectOptionDto[];
}

export type ProviderAuthEventDto =
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

export interface ProviderAuthDoneDto {
  flowId: string;
  providerId: string;
  cancelled: boolean;
}

export type ProviderAuthErrorCode =
  | "port_busy"
  | "rate_limited"
  | "timed_out"
  | "verification_failed"
  | "sign_in_failed";

export interface ProviderAuthErrorDto {
  flowId: string;
  providerId: string;
  code: ProviderAuthErrorCode;
  message: string;
}

export interface ProviderAuthStartRequest {
  flowId: string;
  providerId: string;
  /** Defaults to OAuth for the existing ChatGPT flow. */
  authType?: AuthType;
}

export interface ProviderAuthResponseRequest extends ProviderAuthStartRequest {
  promptId: string;
  value: string;
}

export interface ProviderAuthOwner {
  readonly id: number;
  readonly documentId: string;
  isDestroyed(): boolean;
  send(channel: NotificationChannel, payload: unknown): void;
  onInvalidated(listener: () => void): () => void;
}

export interface ProviderAuthBackend {
  snapshot(): Promise<unknown>;
  authenticate(interaction: AuthInteraction): Promise<unknown>;
  commitCredential(credential: unknown): Promise<void>;
  logout(): Promise<void>;
}

export interface ProviderLogoutBackend {
  snapshot(): Promise<unknown>;
  logout(): Promise<void>;
  committedFallback?(): unknown;
}

export interface ProviderAuthDiagnostic {
  operation: "login" | "logout" | "open_external";
  providerId: string;
  errorName: string;
  errorCode?: string;
}

export interface ProviderAuthFlowDependencies {
  backendFor(providerId: string, authType: AuthType): ProviderAuthBackend;
  logoutBackendFor?(providerId: string): ProviderLogoutBackend;
  openExternal(url: string): Promise<void>;
  diagnostic?(event: ProviderAuthDiagnostic): void;
  flowTimeoutMs?: number;
  authCleanupTimeoutMs?: number;
  createId?: () => string;
}

interface PendingPrompt {
  readonly id: string;
  readonly prompt: AuthPrompt;
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
  readonly removeListeners: () => void;
  readonly selectValues?: ReadonlyMap<string, string>;
}

interface AuthSession {
  readonly flowId: string;
  readonly providerId: string;
  readonly backend: ProviderAuthBackend;
  readonly owner: ProviderAuthOwner;
  readonly abortController: AbortController;
  removeOwnerInvalidation: () => void;
  readonly completion: Promise<void>;
  resolveCompletion: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  pendingPrompt?: PendingPrompt;
  phase: "authenticating" | "committing";
  timedOut: boolean;
  suppressNotifications: boolean;
}

type AuthenticationOutcome =
  | { type: "credential"; credential: unknown }
  | { type: "error"; error: unknown }
  | { type: "aborted" };

interface AuthenticationAttempt {
  readonly outcome: Promise<AuthenticationOutcome>;
  /** Settles only after provider-owned abort cleanup and finally blocks finish. */
  readonly settled: Promise<void>;
}

interface PreparedPrompt {
  dto: ProviderAuthPromptDto;
  selectValues?: ReadonlyMap<string, string>;
}

class ProviderAuthCancellationError extends Error {
  constructor() {
    super("Provider authentication was cancelled.");
    this.name = "ProviderAuthCancellationError";
  }
}

class ProviderAuthPromptAbortedError extends Error {
  constructor() {
    super("The provider authentication prompt is no longer active.");
    this.name = "AbortError";
  }
}

export class ProviderAuthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ProviderAuthRequestError("Provider authentication request has an invalid shape.");
  }
}

function parseProviderId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value)) {
    throw new ProviderAuthRequestError("Provider authentication provider ID is invalid.");
  }
  return value;
}

function parseAuthType(value: unknown): AuthType {
  if (value === undefined || value === "oauth") return "oauth";
  if (value === "api_key") return "api_key";
  throw new ProviderAuthRequestError("Provider authentication method is invalid.");
}

function parseFlowId(value: unknown): string {
  if (typeof value !== "string" || !FLOW_ID_PATTERN.test(value)) {
    throw new ProviderAuthRequestError("Provider authentication flow ID is invalid.");
  }
  return value;
}

function parsePromptId(value: unknown): string {
  if (typeof value !== "string" || !FLOW_ID_PATTERN.test(value)) {
    throw new ProviderAuthRequestError("Provider authentication prompt ID is invalid.");
  }
  return value;
}

export function parseProviderAuthStartRequest(value: unknown): ProviderAuthStartRequest {
  if (!isRecord(value)) {
    throw new ProviderAuthRequestError("Provider authentication request is invalid.");
  }
  assertExactKeys(value, ["flowId", "providerId", "authType"]);
  return {
    flowId: parseFlowId(value.flowId),
    providerId: parseProviderId(value.providerId),
    authType: parseAuthType(value.authType),
  };
}

export function parseProviderAuthResponseRequest(value: unknown): ProviderAuthResponseRequest {
  if (!isRecord(value)) {
    throw new ProviderAuthRequestError("Provider authentication response is invalid.");
  }
  assertExactKeys(value, ["flowId", "providerId", "promptId", "value"]);
  if (typeof value.value !== "string" || value.value.length > MAX_RESPONSE_LENGTH) {
    throw new ProviderAuthRequestError("Provider authentication response is invalid.");
  }
  return {
    flowId: parseFlowId(value.flowId),
    providerId: parseProviderId(value.providerId),
    promptId: parsePromptId(value.promptId),
    value: value.value,
  };
}

export function parseProviderAuthProviderId(value: unknown): string {
  return parseProviderId(value);
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function externalHttpsUrl(value: string, providerId?: string): string {
  if (value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new Error("Provider authentication supplied an invalid external URL.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Provider authentication supplied an invalid external URL.");
  }
  if (providerId === OPENAI_CODEX_PROVIDER_ID && url.hostname !== "auth.openai.com") {
    throw new Error("ChatGPT authentication supplied an unexpected external host.");
  }
  return url.toString();
}

function errorName(error: unknown): string {
  if (!(error instanceof Error) || !SAFE_ERROR_NAMES.has(error.name)) return "UnknownError";
  return error.name;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return SAFE_DIAGNOSTIC_CODES.has(error.code) ? error.code : undefined;
}

function errorClassifierText(error: unknown): string {
  if (!isRecord(error) && !(error instanceof Error)) return "";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return `${name} ${code} ${message}`.toLowerCase();
}

function classifyLoginError(
  error: unknown,
  timedOut: boolean,
  providerId: string,
): Omit<ProviderAuthErrorDto, "flowId" | "providerId"> {
  const codex = providerId === OPENAI_CODEX_PROVIDER_ID;
  if (timedOut) {
    return {
      code: "timed_out",
      message: codex
        ? "ChatGPT sign-in timed out. Start a new sign-in attempt to try again."
        : "Provider setup timed out. Start a new setup attempt to try again.",
    };
  }

  const text = errorClassifierText(error);
  if (text.includes("eaddrinuse") || (text.includes("1455") && text.includes("listen"))) {
    return {
      code: "port_busy",
      message: codex
        ? "The local sign-in port is busy. Try again and choose Device code instead."
        : "The local setup port is busy. Try the provider's alternate setup method.",
    };
  }
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many request")) {
    return {
      code: "rate_limited",
      message: codex
        ? "OpenAI is temporarily limiting sign-in attempts. Wait a moment, then try again."
        : "The provider is temporarily limiting setup attempts. Wait a moment, then try again.",
    };
  }
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("expired_token") ||
    text.includes("device code expired")
  ) {
    return {
      code: "timed_out",
      message: codex
        ? "ChatGPT sign-in expired. Start a new sign-in attempt to try again."
        : "Provider setup expired. Start a new setup attempt to try again.",
    };
  }
  if (text.includes("state mismatch") || text.includes("verification")) {
    return {
      code: "verification_failed",
      message: codex
        ? "OpenAI could not verify this sign-in response. Start a new sign-in attempt."
        : "The provider could not verify this setup response. Start a new attempt.",
    };
  }
  return {
    code: "sign_in_failed",
    message: codex
      ? "ChatGPT sign-in did not complete. Try again or use Device code."
      : "Provider setup did not complete. Check the requested information and try again.",
  };
}

function promptCopy(type: ProviderAuthPromptType): { message: string; placeholder?: string } {
  if (type === "select") return { message: "Choose how to sign in to ChatGPT." };
  if (type === "manual_code") {
    return {
      message: "Paste the authorization code or redirect URL from your browser.",
      placeholder: "Authorization code or redirect URL",
    };
  }
  if (type === "secret") return { message: "Enter the requested sign-in secret." };
  return { message: "Enter the requested sign-in information." };
}

function boundedCopy(value: string | undefined, fallback: string, maxLength = 2_048): string {
  const text = value?.trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function selectOptionCopy(
  providerOptionId: string,
  index: number,
): Omit<ProviderAuthSelectOptionDto, "id"> {
  if (providerOptionId === "browser") {
    return {
      label: "Browser login",
      description: "Complete sign-in in your default browser.",
    };
  }
  if (providerOptionId === "device_code") {
    return {
      label: "Device code",
      description: "Use a short code on OpenAI's verification page.",
    };
  }
  return { label: `Sign-in option ${index + 1}` };
}

function preparePrompt(session: AuthSession, promptId: string, prompt: AuthPrompt): PreparedPrompt {
  // Preserve Pi's provider-authored copy for multi-field and OAuth flows. The
  // ChatGPT flow intentionally retains its reviewed product wording.
  const codexCopy = promptCopy(prompt.type);
  const copy =
    session.providerId === OPENAI_CODEX_PROVIDER_ID
      ? codexCopy
      : {
          message: boundedCopy(prompt.message, codexCopy.message),
          placeholder:
            "placeholder" in prompt
              ? boundedCopy(prompt.placeholder, codexCopy.placeholder ?? "") || undefined
              : undefined,
        };
  const base = {
    flowId: session.flowId,
    providerId: session.providerId,
    promptId,
    type: prompt.type,
    message: copy.message,
  };

  if (prompt.type === "select") {
    if (prompt.options.length === 0 || prompt.options.length > 32) {
      throw new Error("Provider authentication supplied an invalid number of sign-in options.");
    }
    const optionIds = new Set<string>();
    const selectValues = new Map<string, string>();
    for (const option of prompt.options) {
      if (option.id.length === 0 || option.id.length > 256 || optionIds.has(option.id)) {
        throw new Error("Provider authentication supplied invalid sign-in options.");
      }
      optionIds.add(option.id);
    }
    const options = prompt.options.map((option, index) => {
      const id = `option-${index + 1}`;
      selectValues.set(id, option.id);
      if (session.providerId === OPENAI_CODEX_PROVIDER_ID) {
        return { id, ...selectOptionCopy(option.id, index) };
      }
      return {
        id,
        label: boundedCopy(option.label, `Option ${index + 1}`, 256),
        description: boundedCopy(option.description, "", 1_024) || undefined,
      };
    });
    return {
      dto: { ...base, options },
      selectValues,
    };
  }
  return { dto: { ...base, placeholder: copy.placeholder } };
}

export class ProviderAuthFlowCoordinator {
  private readonly flowTimeoutMs: number;
  private readonly authCleanupTimeoutMs: number;
  private readonly createId: () => string;
  private activeSession?: AuthSession;
  private logoutInProgress = false;
  private logoutCompletion?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private disposed = false;

  constructor(private readonly dependencies: ProviderAuthFlowDependencies) {
    this.flowTimeoutMs = dependencies.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
    if (!Number.isFinite(this.flowTimeoutMs) || this.flowTimeoutMs <= 0) {
      throw new Error("Provider authentication timeout must be positive.");
    }
    this.authCleanupTimeoutMs =
      dependencies.authCleanupTimeoutMs ?? DEFAULT_AUTH_CLEANUP_TIMEOUT_MS;
    if (!Number.isFinite(this.authCleanupTimeoutMs) || this.authCleanupTimeoutMs <= 0) {
      throw new Error("Provider authentication cleanup timeout must be positive.");
    }
    this.createId = dependencies.createId ?? randomUUID;
  }

  async status(providerId: unknown): Promise<unknown> {
    const validProviderId = parseProviderId(providerId);
    this.assertAvailable();
    return this.dependencies.backendFor(validProviderId, "oauth").snapshot();
  }

  start(owner: ProviderAuthOwner, request: ProviderAuthStartRequest): { started: true } {
    this.assertAvailable();
    this.assertUsableOwner(owner);
    parseFlowId(request.flowId);
    const providerId = parseProviderId(request.providerId);
    const authType = parseAuthType(request.authType);
    const backend = this.dependencies.backendFor(providerId, authType);

    if (this.logoutInProgress) {
      throw new ProviderAuthRequestError(
        providerId === OPENAI_CODEX_PROVIDER_ID
          ? "ChatGPT sign-out is still in progress."
          : "Provider sign-out is still in progress.",
      );
    }
    if (this.activeSession) {
      if (this.activeSession.flowId === request.flowId) {
        throw new ProviderAuthRequestError("This provider authentication flow is already active.");
      }
      throw new ProviderAuthRequestError(
        providerId === OPENAI_CODEX_PROVIDER_ID
          ? "Another ChatGPT sign-in is already in progress."
          : "Another provider sign-in is already in progress.",
      );
    }

    const abortController = new AbortController();
    let resolveCompletion = (): void => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const ownerInvalidated = (): void => {
      const session = this.activeSession;
      if (
        !session ||
        session.flowId !== request.flowId ||
        session.owner.id !== owner.id ||
        session.owner.documentId !== owner.documentId
      ) {
        return;
      }
      session.suppressNotifications = true;
      this.abortSession(session);
    };
    const session: AuthSession = {
      flowId: request.flowId,
      providerId,
      backend,
      owner,
      abortController,
      removeOwnerInvalidation: () => undefined,
      completion,
      resolveCompletion,
      phase: "authenticating",
      timedOut: false,
      suppressNotifications: false,
    };
    session.timeout = setTimeout(() => {
      session.timedOut = true;
      this.abortSession(session);
    }, this.flowTimeoutMs);
    session.timeout.unref?.();
    this.activeSession = session;
    session.removeOwnerInvalidation = owner.onInvalidated(ownerInvalidated);

    queueMicrotask(() => {
      void this.run(session);
    });
    return { started: true };
  }

  respond(owner: ProviderAuthOwner, request: ProviderAuthResponseRequest): { accepted: true } {
    this.assertAvailable();
    const session = this.ownedSession(owner, request.flowId, request.providerId);
    parsePromptId(request.promptId);
    if (typeof request.value !== "string" || request.value.length > MAX_RESPONSE_LENGTH) {
      throw new ProviderAuthRequestError("Provider authentication response is invalid.");
    }
    const pending = session.pendingPrompt;
    if (!pending || pending.id !== request.promptId) {
      throw new ProviderAuthRequestError(
        "This provider authentication prompt is no longer active.",
      );
    }
    const resolvedValue = pending.selectValues?.get(request.value);
    if (pending.prompt.type === "select" && resolvedValue === undefined) {
      throw new ProviderAuthRequestError("Select one of the available sign-in options.");
    }
    this.clearPendingPrompt(session, pending);
    pending.resolve(resolvedValue ?? request.value);
    return { accepted: true };
  }

  cancel(
    owner: ProviderAuthOwner,
    request: ProviderAuthStartRequest,
  ): { cancelled: true } | { cancelled: false; reason: "finishing" } {
    this.assertAvailable();
    const session = this.ownedSession(owner, request.flowId, request.providerId);
    if (session.phase === "committing") {
      return { cancelled: false, reason: "finishing" };
    }
    this.abortSession(session);
    return { cancelled: true };
  }

  async logout(providerId: unknown): Promise<unknown> {
    const validProviderId = parseProviderId(providerId);
    this.assertAvailable();
    if (this.activeSession) {
      throw new ProviderAuthRequestError(
        "Finish or cancel the active provider sign-in before signing out.",
      );
    }
    if (this.logoutInProgress) {
      throw new ProviderAuthRequestError("Provider sign-out is already in progress.");
    }
    this.logoutInProgress = true;
    let resolveLogout = (): void => undefined;
    const logoutCompletion = new Promise<void>((resolve) => {
      resolveLogout = resolve;
    });
    this.logoutCompletion = logoutCompletion;
    try {
      let backend: ProviderLogoutBackend | ProviderAuthBackend;
      try {
        backend =
          this.dependencies.logoutBackendFor?.(validProviderId) ??
          this.dependencies.backendFor(validProviderId, "oauth");
        await backend.logout();
      } catch (error) {
        this.reportDiagnostic("logout", validProviderId, error);
        throw new ProviderAuthRequestError("Provider sign-out did not complete. Try again.");
      }
      try {
        return await backend.snapshot();
      } catch (error) {
        const committedFallback =
          "committedFallback" in backend ? backend.committedFallback : undefined;
        if (!committedFallback) throw error;
        return committedFallback();
      }
    } finally {
      this.logoutInProgress = false;
      resolveLogout();
      if (this.logoutCompletion === logoutCompletion) this.logoutCompletion = undefined;
    }
  }

  dispose(): void {
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    const session = this.activeSession;
    if (session) {
      session.suppressNotifications = true;
      this.abortSession(session);
    }
    const pending = [session?.completion, this.logoutCompletion].filter(
      (operation): operation is Promise<void> => operation !== undefined,
    );
    this.shutdownPromise = Promise.all(pending).then(() => undefined);
    return this.shutdownPromise;
  }

  private async run(session: AuthSession): Promise<void> {
    const authentication = this.authenticate(session);
    try {
      const outcome = await authentication.outcome;
      if (outcome.type === "aborted") {
        // The cancel invoke acknowledges immediately, but the terminal event
        // means the provider slot is reusable. Give provider-owned cleanup a
        // bounded chance to finish before advertising that terminal state.
        await this.waitForAuthenticationCleanup(authentication.settled);
        if (session.timedOut) this.sendError(session, new ProviderAuthCancellationError());
        else this.sendDone(session, true);
        return;
      }
      if (outcome.type === "error") throw outcome.error;
      if (session.abortController.signal.aborted) {
        if (session.timedOut) this.sendError(session, new ProviderAuthCancellationError());
        else this.sendDone(session, true);
        return;
      }

      // Credential persistence is the point of no return. Cancellation wins
      // before this synchronous state transition; after it, commit completion
      // wins so the terminal event always agrees with stored status.
      session.phase = "committing";
      if (session.timeout) {
        clearTimeout(session.timeout);
        session.timeout = undefined;
      }
      await session.backend.commitCredential(outcome.credential);
      this.sendDone(session, false);
    } catch (error) {
      if (session.abortController.signal.aborted && !session.timedOut) {
        this.sendDone(session, true);
      } else {
        this.reportDiagnostic("login", session.providerId, error);
        this.sendError(session, error);
      }
    } finally {
      this.finishSession(session);
    }
  }

  private authenticate(session: AuthSession): AuthenticationAttempt {
    const authentication = Promise.resolve()
      .then(() =>
        session.backend.authenticate({
          signal: session.abortController.signal,
          prompt: (prompt) => this.requestPrompt(session, prompt),
          notify: (event) => this.notify(session, event),
        }),
      )
      .then(
        (credential): AuthenticationOutcome => ({ type: "credential", credential }),
        (error: unknown): AuthenticationOutcome => ({ type: "error", error }),
      );

    const settled = authentication.then(() => undefined);
    const outcome = new Promise<AuthenticationOutcome>((resolve) => {
      if (session.abortController.signal.aborted) {
        resolve({ type: "aborted" });
        return;
      }
      const onAbort = (): void => resolve({ type: "aborted" });
      session.abortController.signal.addEventListener("abort", onAbort, { once: true });
      void authentication.then((result) => {
        session.abortController.signal.removeEventListener("abort", onAbort);
        resolve(result);
      });
    });
    return { outcome, settled };
  }

  private async waitForAuthenticationCleanup(settled: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.authCleanupTimeoutMs);
    });
    try {
      await Promise.race([settled, bounded]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private requestPrompt(session: AuthSession, prompt: AuthPrompt): Promise<string> {
    if (!this.isCurrentSession(session)) {
      return Promise.reject(new ProviderAuthCancellationError());
    }
    if (session.pendingPrompt) {
      return Promise.reject(new Error("Provider authentication requested overlapping prompts."));
    }
    if (session.abortController.signal.aborted) {
      return Promise.reject(new ProviderAuthCancellationError());
    }
    if (prompt.signal?.aborted) {
      return Promise.reject(new ProviderAuthPromptAbortedError());
    }

    const promptId = this.createId();
    if (!FLOW_ID_PATTERN.test(promptId)) {
      return Promise.reject(new Error("Provider authentication generated an invalid prompt ID."));
    }
    const prepared = preparePrompt(session, promptId, prompt);

    return new Promise<string>((resolve, reject) => {
      const onFlowAbort = (): void => {
        const pending = session.pendingPrompt;
        if (!pending || pending.id !== promptId) return;
        this.clearPendingPrompt(session, pending);
        reject(new ProviderAuthCancellationError());
      };
      const onPromptAbort = (): void => {
        const pending = session.pendingPrompt;
        if (!pending || pending.id !== promptId) return;
        this.clearPendingPrompt(session, pending);
        reject(new ProviderAuthPromptAbortedError());
      };
      const removeListeners = (): void => {
        session.abortController.signal.removeEventListener("abort", onFlowAbort);
        prompt.signal?.removeEventListener("abort", onPromptAbort);
      };
      const pending: PendingPrompt = {
        id: promptId,
        prompt,
        resolve,
        reject,
        removeListeners,
        selectValues: prepared.selectValues,
      };
      session.pendingPrompt = pending;
      session.abortController.signal.addEventListener("abort", onFlowAbort, { once: true });
      prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
      if (!this.safeSend(session, "providers:auth:prompt", prepared.dto)) {
        this.abortSession(session);
      }
    });
  }

  private notify(session: AuthSession, event: AuthEvent): void {
    // A provider may finish unwinding after abort won the coordinator race.
    // Ignoring its late notification lets its next rejected prompt/signal path
    // reach provider-owned cleanup (notably Pi's localhost callback server).
    if (!this.isCurrentSession(session)) return;
    let dto: ProviderAuthEventDto;
    if (event.type === "auth_url") {
      const url = externalHttpsUrl(event.url, session.providerId);
      dto = {
        flowId: session.flowId,
        providerId: session.providerId,
        type: "auth_url",
        url,
        instructions:
          session.providerId === OPENAI_CODEX_PROVIDER_ID
            ? "Complete sign-in in your browser."
            : boundedCopy(event.instructions, "Complete setup in your browser."),
      };
      this.openExternal(session, url);
    } else if (event.type === "device_code") {
      const verificationUri = externalHttpsUrl(event.verificationUri, session.providerId);
      if (event.userCode.length === 0 || event.userCode.length > 256) {
        throw new Error("Provider authentication supplied an invalid device code.");
      }
      dto = {
        flowId: session.flowId,
        providerId: session.providerId,
        type: "device_code",
        userCode: event.userCode,
        verificationUri,
        intervalSeconds: finiteNonNegative(event.intervalSeconds),
        expiresInSeconds: finiteNonNegative(event.expiresInSeconds),
      };
      this.openExternal(session, verificationUri);
    } else if (event.type === "info") {
      // The established Codex flow deliberately redacts provider text. For
      // generic Pi setup, preserve instructional links but never forward URL
      // query/fragment data that could carry a credential or callback token.
      const links =
        session.providerId === OPENAI_CODEX_PROVIDER_ID
          ? undefined
          : event.links?.slice(0, 8).map((link) => {
              const url = new URL(externalHttpsUrl(link.url));
              url.search = "";
              url.hash = "";
              return {
                url: url.toString(),
                label: boundedCopy(link.label, "", 256) || undefined,
              };
            });
      dto = {
        flowId: session.flowId,
        providerId: session.providerId,
        type: "info",
        message:
          session.providerId === OPENAI_CODEX_PROVIDER_ID
            ? "OpenAI provided an update during sign-in."
            : boundedCopy(event.message, "Provider setup is in progress."),
        ...(links?.length ? { links } : {}),
      };
    } else {
      dto = {
        flowId: session.flowId,
        providerId: session.providerId,
        type: "progress",
        message:
          session.providerId === OPENAI_CODEX_PROVIDER_ID
            ? "Signing in to ChatGPT…"
            : boundedCopy(event.message, "Completing provider setup…"),
      };
    }
    if (!this.safeSend(session, "providers:auth:event", dto)) this.abortSession(session);
  }

  private openExternal(session: AuthSession, url: string): void {
    void this.dependencies.openExternal(url).catch((error: unknown) => {
      this.reportDiagnostic("open_external", session.providerId, error);
      if (!this.isCurrentSession(session)) return;
      this.safeSend(session, "providers:auth:event", {
        flowId: session.flowId,
        providerId: session.providerId,
        type: "browser_open_failed",
        url,
        message: "Aiden couldn't open the browser automatically. Use the sign-in link below.",
      } satisfies ProviderAuthEventDto);
    });
  }

  private ownedSession(
    owner: ProviderAuthOwner,
    flowId: unknown,
    providerId: unknown,
  ): AuthSession {
    this.assertUsableOwner(owner);
    const validFlowId = parseFlowId(flowId);
    const validProviderId = parseProviderId(providerId);
    const session = this.activeSession;
    if (
      !session ||
      session.flowId !== validFlowId ||
      session.providerId !== validProviderId ||
      session.owner.id !== owner.id ||
      session.owner.documentId !== owner.documentId
    ) {
      throw new ProviderAuthRequestError(
        "Provider authentication flow is not owned by this window.",
      );
    }
    return session;
  }

  private abortSession(session: AuthSession): void {
    if (session.phase === "committing") return;
    if (!session.abortController.signal.aborted) session.abortController.abort();
  }

  private finishSession(session: AuthSession): void {
    try {
      if (session.timeout) clearTimeout(session.timeout);
      try {
        session.removeOwnerInvalidation();
      } catch {
        // Renderer teardown can race listener removal; completion must still settle.
      }
      const pending = session.pendingPrompt;
      if (pending) {
        this.clearPendingPrompt(session, pending);
        pending.reject(new ProviderAuthCancellationError());
      }
    } finally {
      if (this.activeSession === session) this.activeSession = undefined;
      session.resolveCompletion();
    }
  }

  private clearPendingPrompt(session: AuthSession, pending: PendingPrompt): void {
    pending.removeListeners();
    if (session.pendingPrompt === pending) session.pendingPrompt = undefined;
  }

  private sendDone(session: AuthSession, cancelled: boolean): void {
    this.safeSend(session, "providers:auth:done", {
      flowId: session.flowId,
      providerId: session.providerId,
      cancelled,
    } satisfies ProviderAuthDoneDto);
  }

  private sendError(session: AuthSession, error: unknown): void {
    const classified = classifyLoginError(error, session.timedOut, session.providerId);
    this.safeSend(session, "providers:auth:error", {
      flowId: session.flowId,
      providerId: session.providerId,
      ...classified,
    } satisfies ProviderAuthErrorDto);
  }

  private safeSend(session: AuthSession, channel: NotificationChannel, payload: unknown): boolean {
    if (session.suppressNotifications || session.owner.isDestroyed()) return false;
    try {
      session.owner.send(channel, payload);
      return true;
    } catch {
      session.suppressNotifications = true;
      this.abortSession(session);
      return false;
    }
  }

  private isCurrentSession(session: AuthSession): boolean {
    return this.activeSession === session && !session.abortController.signal.aborted;
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new ProviderAuthRequestError("Provider authentication is shutting down.");
    }
  }

  private assertUsableOwner(owner: ProviderAuthOwner): void {
    if (
      !Number.isSafeInteger(owner.id) ||
      owner.id <= 0 ||
      owner.documentId.length === 0 ||
      owner.isDestroyed()
    ) {
      throw new ProviderAuthRequestError("Provider authentication window is unavailable.");
    }
  }

  private reportDiagnostic(
    operation: ProviderAuthDiagnostic["operation"],
    providerId: string,
    error: unknown,
  ): void {
    this.dependencies.diagnostic?.({
      operation,
      providerId,
      errorName: errorName(error),
      errorCode: errorCode(error),
    });
  }
}

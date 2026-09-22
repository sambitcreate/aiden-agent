/**
 * Main-process-only OpenAI/Codex Web Search auth reuse.
 *
 * The ordinary Pi model resolver intentionally remains out of this module:
 * `Models.getAuth()` may resolve ambient environment credentials and may
 * refresh OAuth.  Web Search reuse instead reads one exact persisted
 * credential, validates it against a durable provider/model/endpoint binding,
 * and only then returns a request credential to another main-only caller.
 * Consent itself only reads local state and writes the binding store; it never
 * changes Web Search routing and has no network-capable dependency.
 */

import { createHash } from "node:crypto";
import type { Api, Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import {
  normalizeWebSearchExistingAuthBinding,
  normalizeWebSearchExistingAuthBindingDocument,
  normalizeWebSearchExistingAuthConsent,
  webSearchExistingAuthRendererOptions,
  webSearchExistingAuthRendererStatus,
  webSearchExistingAuthSourceMetadata,
  OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT,
  OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
  WEB_SEARCH_EXISTING_AUTH_SUPPORTED_SOURCE_PROVIDER_IDS,
  WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
  type WebSearchExistingAuthBinding,
  type WebSearchExistingAuthBindingDocument,
  type WebSearchExistingAuthBindingState,
  type WebSearchExistingAuthConsentRequest,
  type WebSearchExistingAuthEndpoint,
  type WebSearchExistingAuthModelApi,
  type WebSearchExistingAuthRendererOption,
  type WebSearchExistingAuthRendererStatus,
  type WebSearchExistingAuthSourceProviderId,
} from "./web-search-auth-reuse-core.js";

export const WEB_SEARCH_EXISTING_AUTH_BINDINGS_FILE = "web-search-existing-auth-bindings.json";
export const WEB_SEARCH_EXISTING_AUTH_BINDINGS_MAX_BYTES = 128 * 1_024;

export class WebSearchExistingAuthError extends Error {
  readonly name = "WebSearchExistingAuthError";

  constructor(
    readonly code:
      | "consent-required"
      | "unsupported-source"
      | "model-unavailable"
      | "credential-missing"
      | "credential-invalid"
      | "binding-missing"
      | "binding-invalid"
      | "identity-drift"
      | "credential-expired",
    message: string,
  ) {
    super(message);
  }
}

/** Narrow persistence surface so consent can be tested without Electron. */
export interface WebSearchExistingAuthBindingStore {
  load(): Promise<WebSearchExistingAuthBindingDocument>;
  update<R>(
    mutation: (draft: WebSearchExistingAuthBindingDocument) => R | Promise<R>,
    isCurrent?: () => boolean,
  ): Promise<R>;
}

/** Synchronous model metadata surface used by the binding, never auth resolution. */
export interface WebSearchExistingAuthModelCatalog {
  getProvider(providerId: string):
    | {
        readonly id: string;
        readonly baseUrl?: string;
      }
    | undefined;
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  getModels(providerId: string): readonly Model<Api>[];
}

export interface WebSearchExistingAuthReuseDependencies {
  readonly credentials: Pick<CredentialStore, "read">;
  readonly models: WebSearchExistingAuthModelCatalog;
  readonly store: WebSearchExistingAuthBindingStore;
  readonly now?: () => number;
}

/** Request auth returned only to main-process adapters/services. */
export interface WebSearchResolvedExistingAuth {
  readonly targetProviderId: typeof WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID;
  readonly sourceProviderId: WebSearchExistingAuthSourceProviderId;
  readonly modelId: string;
  readonly modelApi: WebSearchExistingAuthModelApi;
  readonly endpoint: WebSearchExistingAuthEndpoint;
  /** Secret material is intentionally confined to this main-only result. */
  readonly credential: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface PreparedCredential {
  readonly credential: string;
  readonly fingerprint: string;
  readonly accountId?: string;
  readonly expiresAt?: number;
}

interface BindingInspection {
  readonly binding?: WebSearchExistingAuthBinding;
  readonly state: WebSearchExistingAuthBindingState;
  readonly prepared?: PreparedCredential;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyCredential(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || /\p{Cc}/u.test(normalized)) return undefined;
  if (Array.from(normalized).length > 16_384) return undefined;
  if (new TextEncoder().encode(normalized).byteLength > 64 * 1_024) return undefined;
  return normalized;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function codexAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (!isRecord(auth)) return undefined;
  const accountId = auth.chatgpt_account_id;
  if (typeof accountId !== "string") return undefined;
  const normalized = accountId.trim();
  if (!normalized || /\p{Cc}/u.test(normalized) || normalized.length > 256) return undefined;
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceModelSpec(sourceProviderId: WebSearchExistingAuthSourceProviderId): {
  readonly api: WebSearchExistingAuthModelApi;
  readonly endpoint: WebSearchExistingAuthEndpoint;
  readonly baseUrl: string;
} {
  if (sourceProviderId === "openai") {
    return {
      api: "openai-responses",
      endpoint: OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
      baseUrl: "https://api.openai.com/v1",
    };
  }
  return {
    api: "openai-codex-responses",
    endpoint: OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT,
    baseUrl: "https://chatgpt.com/backend-api",
  };
}

function sourceIsSupported(sourceProviderId: WebSearchExistingAuthSourceProviderId): boolean {
  return WEB_SEARCH_EXISTING_AUTH_SUPPORTED_SOURCE_PROVIDER_IDS.includes(
    sourceProviderId as (typeof WEB_SEARCH_EXISTING_AUTH_SUPPORTED_SOURCE_PROVIDER_IDS)[number],
  );
}

function sameFixedBaseUrl(value: string | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      url.origin === new URL(expected).origin &&
      url.pathname.replace(/\/+$/u, "") === new URL(expected).pathname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function modelSupportsSpec(
  model: Model<Api> | undefined,
  spec: ReturnType<typeof sourceModelSpec>,
): model is Model<Api> {
  return model !== undefined && model.api === spec.api;
}

function credentialFingerprint(
  sourceProviderId: WebSearchExistingAuthSourceProviderId,
  prepared: PreparedCredential,
): string {
  // Codex access tokens rotate during normal OAuth refresh. Account identity
  // is the stable exact identity to bind, while API keys themselves are the
  // identity for the OpenAI API-key provider.
  const identity = sourceProviderId === "openai-codex" ? prepared.accountId : prepared.credential;
  return sha256(`${sourceProviderId}\0${identity ?? ""}`);
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

function copyBinding(value: WebSearchExistingAuthBinding): WebSearchExistingAuthBinding {
  return normalizeWebSearchExistingAuthBinding(structuredClone(value));
}

async function readPersistedCredential(
  credentials: Pick<CredentialStore, "read">,
  sourceProviderId: WebSearchExistingAuthSourceProviderId,
): Promise<PreparedCredential | undefined> {
  let stored: Credential | undefined;
  try {
    stored = await credentials.read(sourceProviderId);
  } catch {
    return undefined;
  }
  if (!stored) return undefined;
  if (sourceProviderId === "openai") {
    if (stored.type !== "api_key") return undefined;
    const key = nonEmptyCredential(stored.key);
    if (!key) return undefined;
    const prepared: PreparedCredential = { credential: key, fingerprint: "" };
    return { ...prepared, fingerprint: credentialFingerprint(sourceProviderId, prepared) };
  }
  if (stored.type !== "oauth") return undefined;
  const access = nonEmptyCredential(stored.access);
  const refresh = nonEmptyCredential(stored.refresh);
  if (!access || !refresh || !Number.isFinite(stored.expires)) return undefined;
  const accountId = codexAccountId(access);
  if (!accountId) return undefined;
  const prepared: PreparedCredential = {
    credential: access,
    fingerprint: "",
    accountId,
    expiresAt: stored.expires,
  };
  return { ...prepared, fingerprint: credentialFingerprint(sourceProviderId, prepared) };
}

function rendererStatus(inspection: BindingInspection): WebSearchExistingAuthRendererStatus {
  return webSearchExistingAuthRendererStatus(inspection.state, inspection.binding);
}

function optionModels(
  models: WebSearchExistingAuthModelCatalog,
  sourceProviderId: WebSearchExistingAuthSourceProviderId,
): readonly { id: string; label: string }[] {
  const spec = sourceModelSpec(sourceProviderId);
  try {
    return models
      .getModels(sourceProviderId)
      .filter((model) => modelSupportsSpec(model, spec))
      .map((model) => ({ id: model.id, label: model.name }))
      .filter((model) => model.id.length > 0 && model.label.length > 0);
  } catch {
    return [];
  }
}

export class WebSearchExistingAuthReuseService {
  private readonly now: () => number;

  constructor(private readonly dependencies: WebSearchExistingAuthReuseDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }

  /**
   * Read a redacted status. This never resolves ambient auth or performs OAuth
   * refresh, so opening Settings cannot cause a provider request.
   */
  async status(): Promise<WebSearchExistingAuthRendererStatus> {
    const inspection = await this.inspect();
    return rendererStatus(inspection);
  }

  /** Enumerate source/model choices using only local persisted auth/catalog state. */
  async options(): Promise<readonly WebSearchExistingAuthRendererOption[]> {
    const result: WebSearchExistingAuthRendererOption[] = [];
    for (const sourceProviderId of ["openai", "openai-codex"] as const) {
      const source = webSearchExistingAuthSourceMetadata(sourceProviderId);
      if (!sourceIsSupported(sourceProviderId)) {
        result.push({
          sourceProviderId,
          label: source.label,
          authKind: source.authKind,
          available: false,
          models: [],
        });
        continue;
      }
      let provider: { readonly id: string; readonly baseUrl?: string } | undefined;
      try {
        provider = this.dependencies.models.getProvider(sourceProviderId);
      } catch {
        provider = undefined;
      }
      const prepared = provider
        ? await readPersistedCredential(this.dependencies.credentials, sourceProviderId)
        : undefined;
      let models: readonly { id: string; label: string }[] = [];
      try {
        models =
          provider && sameFixedBaseUrl(provider.baseUrl, sourceModelSpec(sourceProviderId).baseUrl)
            ? optionModels(this.dependencies.models, sourceProviderId)
            : [];
      } catch {
        models = [];
      }
      result.push({
        sourceProviderId,
        label: source.label,
        authKind: source.authKind,
        available:
          prepared !== undefined &&
          (prepared.expiresAt === undefined || prepared.expiresAt > this.now()) &&
          models.length > 0,
        models,
      });
    }
    return webSearchExistingAuthRendererOptions(result);
  }

  /**
   * Persist a provider-scoped confirmation. The route and global switch are
   * intentionally untouched. Missing/false consent is rejected before any
   * credential or model-store read.
   */
  async consent(
    value: unknown,
    isCurrent: () => boolean = () => true,
  ): Promise<WebSearchExistingAuthRendererStatus> {
    const request = normalizeWebSearchExistingAuthConsent(value);
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    const binding = await this.buildBinding(request);
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    await this.dependencies.store.update((document) => {
      document.bindings.openai = binding;
    }, isCurrent);
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    return this.status();
  }

  /** Alias used by IPC callers that name the operation after the binding. */
  async bind(
    value: unknown,
    isCurrent: () => boolean = () => true,
  ): Promise<WebSearchExistingAuthRendererStatus> {
    return this.consent(value, isCurrent);
  }

  /** Revoke only the Web Search binding; the underlying model credential remains untouched. */
  async revoke(
    isCurrent: () => boolean = () => true,
  ): Promise<WebSearchExistingAuthRendererStatus> {
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    await this.dependencies.store.update((document) => {
      delete document.bindings.openai;
    }, isCurrent);
    if (!isCurrent()) throw new Error("The renderer document is no longer active.");
    return this.status();
  }

  /**
   * Resolve the already-approved exact identity for a main-only adapter. No
   * provider resolver, environment fallback, refresh, or dynamic endpoint is
   * reachable from this method.
   */
  async resolve(): Promise<WebSearchResolvedExistingAuth> {
    const inspection = await this.inspect();
    const binding = inspection.binding;
    if (!binding) {
      throw new WebSearchExistingAuthError(
        "binding-missing",
        "Web Search existing OpenAI account access has not been approved.",
      );
    }
    // Keep the unreviewed ChatGPT/Codex source uncallable even if an older
    // build left a syntactically valid binding on disk.  Discovery retains a
    // redacted unavailable option so the source can be reviewed later, but no
    // runtime path may return its OAuth token to a Web Search adapter.
    if (!sourceIsSupported(binding.sourceProviderId)) {
      throw new WebSearchExistingAuthError(
        "unsupported-source",
        "ChatGPT / Codex Web Search reuse is unavailable until its Responses contract is reviewed.",
      );
    }
    if (inspection.state === "revoked") {
      throw new WebSearchExistingAuthError(
        "credential-missing",
        "The approved OpenAI account credential is no longer available.",
      );
    }
    if (inspection.state === "identity-drift") {
      throw new WebSearchExistingAuthError(
        "identity-drift",
        "The approved OpenAI account identity changed; approve it again in Web Search settings.",
      );
    }
    if (inspection.state === "expired") {
      throw new WebSearchExistingAuthError(
        "credential-expired",
        "The approved ChatGPT / Codex sign-in has expired; sign in again before using Web Search.",
      );
    }
    if (inspection.state === "model-unavailable") {
      throw new WebSearchExistingAuthError(
        "model-unavailable",
        "The approved OpenAI Web Search model is no longer available.",
      );
    }
    if (inspection.state !== "ready" || !inspection.prepared) {
      throw new WebSearchExistingAuthError(
        "binding-invalid",
        "The approved OpenAI Web Search account binding is unavailable.",
      );
    }
    const prepared = inspection.prepared;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${prepared.credential}`,
      "Content-Type": "application/json",
    };
    if (binding.sourceProviderId === "openai-codex") {
      // inspect() only reports ready when accountId was extracted from the
      // current persisted token, so this header cannot target another account.
      if (!prepared.accountId) {
        throw new WebSearchExistingAuthError(
          "credential-invalid",
          "The approved ChatGPT / Codex sign-in is invalid.",
        );
      }
      headers["OpenAI-Beta"] = "responses=experimental";
      headers["chatgpt-account-id"] = prepared.accountId;
      headers.originator = "pi";
    }
    return Object.freeze({
      targetProviderId: WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
      sourceProviderId: binding.sourceProviderId,
      modelId: binding.modelId,
      modelApi: binding.modelApi,
      endpoint: binding.endpoint,
      credential: prepared.credential,
      headers: Object.freeze(headers),
    });
  }

  private async buildBinding(
    request: WebSearchExistingAuthConsentRequest,
  ): Promise<WebSearchExistingAuthBinding> {
    if (request.targetProviderId !== WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID) {
      throw new WebSearchExistingAuthError(
        "unsupported-source",
        "This Web Search account binding is not supported.",
      );
    }
    if (!sourceIsSupported(request.sourceProviderId)) {
      throw new WebSearchExistingAuthError(
        "unsupported-source",
        "ChatGPT / Codex Web Search reuse is unavailable until its Responses contract is reviewed.",
      );
    }
    const spec = sourceModelSpec(request.sourceProviderId);
    let provider: { readonly id: string; readonly baseUrl?: string } | undefined;
    let model: Model<Api> | undefined;
    try {
      provider = this.dependencies.models.getProvider(request.sourceProviderId);
      model = this.dependencies.models.getModel(request.sourceProviderId, request.modelId);
    } catch {
      provider = undefined;
      model = undefined;
    }
    if (
      !provider ||
      !sameFixedBaseUrl(provider.baseUrl, spec.baseUrl) ||
      !modelSupportsSpec(model, spec)
    ) {
      throw new WebSearchExistingAuthError(
        "model-unavailable",
        "The selected OpenAI Web Search model is unavailable.",
      );
    }
    const prepared = await readPersistedCredential(
      this.dependencies.credentials,
      request.sourceProviderId,
    );
    if (!prepared) {
      throw new WebSearchExistingAuthError(
        "credential-missing",
        "No eligible saved OpenAI or ChatGPT / Codex credential is available.",
      );
    }
    if (prepared.expiresAt !== undefined && prepared.expiresAt <= this.now()) {
      throw new WebSearchExistingAuthError(
        "credential-expired",
        "The selected ChatGPT / Codex sign-in has expired; sign in again first.",
      );
    }
    return normalizeWebSearchExistingAuthBinding({
      version: 1,
      consentVersion: 1,
      targetProviderId: WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
      sourceProviderId: request.sourceProviderId,
      modelId: model.id,
      modelApi: spec.api,
      endpoint: spec.endpoint,
      credentialFingerprint: prepared.fingerprint,
      consentedAt: safeTimestamp(this.now()),
    });
  }

  private async inspect(): Promise<BindingInspection> {
    let document: WebSearchExistingAuthBindingDocument;
    try {
      document = normalizeWebSearchExistingAuthBindingDocument(
        await this.dependencies.store.load(),
      );
    } catch {
      return { state: "invalid" };
    }
    const rawBinding = document.bindings.openai;
    if (!rawBinding) return { state: "not-consented" };
    let binding: WebSearchExistingAuthBinding;
    try {
      binding = copyBinding(rawBinding);
    } catch {
      return { state: "invalid" };
    }
    const spec = sourceModelSpec(binding.sourceProviderId);
    if (!sourceIsSupported(binding.sourceProviderId)) {
      return { binding, state: "model-unavailable" };
    }
    let provider: { readonly id: string; readonly baseUrl?: string } | undefined;
    let model: Model<Api> | undefined;
    try {
      provider = this.dependencies.models.getProvider(binding.sourceProviderId);
      model = this.dependencies.models.getModel(binding.sourceProviderId, binding.modelId);
    } catch {
      provider = undefined;
      model = undefined;
    }
    if (
      !provider ||
      !sameFixedBaseUrl(provider.baseUrl, spec.baseUrl) ||
      binding.modelApi !== spec.api ||
      binding.endpoint !== spec.endpoint ||
      !modelSupportsSpec(model, spec)
    ) {
      return { binding, state: "model-unavailable" };
    }
    const prepared = await readPersistedCredential(
      this.dependencies.credentials,
      binding.sourceProviderId,
    );
    if (!prepared) return { binding, state: "revoked" };
    if (prepared.expiresAt !== undefined && prepared.expiresAt <= this.now()) {
      return { binding, state: "expired" };
    }
    if (prepared.fingerprint !== binding.credentialFingerprint) {
      return { binding, state: "identity-drift" };
    }
    return { binding, state: "ready", prepared };
  }
}

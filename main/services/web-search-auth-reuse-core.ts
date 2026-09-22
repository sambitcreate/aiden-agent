/**
 * Contracts for the optional OpenAI/Codex Web Search credential reuse path.
 *
 * This file is deliberately free of Electron, filesystem, network, and Pi
 * credential-store imports.  The durable binding is a main-process record, not
 * a renderer setting.  It contains the exact provider/model/endpoint identity
 * and a non-secret identity fingerprint; it never contains a key or token.
 */

export const WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION = 1 as const;
export const WEB_SEARCH_EXISTING_AUTH_CONSENT_VERSION = 1 as const;

export const OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses" as const;
export const OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses" as const;

export const WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID = "openai" as const;

export const WEB_SEARCH_EXISTING_AUTH_SOURCE_PROVIDER_IDS = ["openai", "openai-codex"] as const;

/**
 * OpenAI API-key reuse is the only source currently eligible for routing.
 * Codex's ChatGPT backend response contract is not the public JSON Responses
 * contract used by the shipped adapter, so it remains visible only as an
 * unavailable discovery option until that contract is separately reviewed.
 */
export const WEB_SEARCH_EXISTING_AUTH_SUPPORTED_SOURCE_PROVIDER_IDS = ["openai"] as const;

export const WEB_SEARCH_EXISTING_AUTH_OPENAI_CONSENT_COPY =
  "Allow Web Search to use the saved OpenAI API key. Searches use your OpenAI API quota and billing; the key stays encrypted on this device and is never copied into Web Search settings." as const;

export type WebSearchExistingAuthSourceProviderId =
  (typeof WEB_SEARCH_EXISTING_AUTH_SOURCE_PROVIDER_IDS)[number];

export type WebSearchExistingAuthModelApi = "openai-responses" | "openai-codex-responses";

export type WebSearchExistingAuthEndpoint =
  | typeof OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT
  | typeof OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT;

export interface WebSearchExistingAuthBinding {
  readonly version: typeof WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION;
  readonly consentVersion: typeof WEB_SEARCH_EXISTING_AUTH_CONSENT_VERSION;
  readonly targetProviderId: typeof WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID;
  /** Exact Pi provider whose persisted credential was approved. */
  readonly sourceProviderId: WebSearchExistingAuthSourceProviderId;
  /** Exact Pi model selected for the Web Search Responses request. */
  readonly modelId: string;
  readonly modelApi: WebSearchExistingAuthModelApi;
  /** Exact fixed endpoint selected by the source provider; never user input. */
  readonly endpoint: WebSearchExistingAuthEndpoint;
  /** SHA-256 of a stable credential identity, never the secret itself. */
  readonly credentialFingerprint: string;
  readonly consentedAt: number;
}

export interface WebSearchExistingAuthBindingDocument {
  readonly version: typeof WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION;
  readonly bindings: Partial<
    Record<typeof WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID, WebSearchExistingAuthBinding>
  >;
}

export interface WebSearchExistingAuthConsentRequest {
  readonly targetProviderId: typeof WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID;
  readonly sourceProviderId: WebSearchExistingAuthSourceProviderId;
  readonly modelId: string;
  /** Separate affirmative confirmation; absence/false must fail closed. */
  readonly consent: true;
}

export type WebSearchExistingAuthBindingState =
  | "not-consented"
  | "ready"
  | "revoked"
  | "identity-drift"
  | "model-unavailable"
  | "expired"
  | "invalid";

/** Renderer-safe status.  No fingerprint, endpoint, token, key, or hash. */
export interface WebSearchExistingAuthRendererStatus {
  readonly targetProviderId: typeof WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID;
  readonly state: WebSearchExistingAuthBindingState;
  readonly configured: boolean;
  readonly sourceProviderId?: WebSearchExistingAuthSourceProviderId;
  readonly modelId?: string;
}

export interface WebSearchExistingAuthRendererModelOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Renderer-safe account choice. `available` only says whether a compatible
 * persisted credential exists; it never describes that credential.
 */
export interface WebSearchExistingAuthRendererOption {
  readonly sourceProviderId: WebSearchExistingAuthSourceProviderId;
  readonly label: string;
  readonly authKind: "api-key" | "subscription";
  readonly available: boolean;
  readonly models: readonly WebSearchExistingAuthRendererModelOption[];
}

/** Entire renderer-facing projection for the optional existing-auth flow. */
export interface WebSearchExistingAuthRendererSnapshot {
  readonly options: readonly WebSearchExistingAuthRendererOption[];
  readonly status: WebSearchExistingAuthRendererStatus;
}

const SOURCE_ENDPOINTS: Readonly<
  Record<
    WebSearchExistingAuthSourceProviderId,
    {
      readonly api: WebSearchExistingAuthModelApi;
      readonly endpoint: WebSearchExistingAuthEndpoint;
    }
  >
> = Object.freeze({
  openai: {
    api: "openai-responses",
    endpoint: OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT,
  },
  "openai-codex": {
    api: "openai-codex-responses",
    endpoint: OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT,
  },
});

const SOURCE_PROVIDER_LABELS: Readonly<Record<WebSearchExistingAuthSourceProviderId, string>> =
  Object.freeze({
    openai: "OpenAI API key",
    "openai-codex": "ChatGPT / Codex subscription",
  });

const SOURCE_AUTH_KINDS: Readonly<
  Record<WebSearchExistingAuthSourceProviderId, "api-key" | "subscription">
> = Object.freeze({
  openai: "api-key",
  "openai-codex": "subscription",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`Web Search ${label} is invalid.`);
  const normalized = value.trim();
  if (
    !normalized ||
    hasControlCharacter(normalized) ||
    Array.from(normalized).length > maximum ||
    new TextEncoder().encode(normalized).byteLength > maximum * 4
  ) {
    throw new Error(`Web Search ${label} is invalid.`);
  }
  return normalized;
}

function sourceProviderId(value: unknown): WebSearchExistingAuthSourceProviderId {
  if (value !== "openai" && value !== "openai-codex") {
    throw new Error("Web Search existing-auth source provider is invalid.");
  }
  return value;
}

function modelApi(value: unknown): WebSearchExistingAuthModelApi {
  if (value !== "openai-responses" && value !== "openai-codex-responses") {
    throw new Error("Web Search existing-auth model API is invalid.");
  }
  return value;
}

function endpoint(value: unknown): WebSearchExistingAuthEndpoint {
  if (
    value !== OPENAI_WEB_SEARCH_RESPONSES_ENDPOINT &&
    value !== OPENAI_CODEX_WEB_SEARCH_RESPONSES_ENDPOINT
  ) {
    throw new Error("Web Search existing-auth endpoint is not an approved OpenAI endpoint.");
  }
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Web Search existing-auth credential identity is invalid.");
  }
  return value;
}

function consentedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Web Search existing-auth consent timestamp is invalid.");
  }
  return value;
}

function bindingKeysAreKnown(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(
    (key) =>
      key === "version" ||
      key === "consentVersion" ||
      key === "targetProviderId" ||
      key === "sourceProviderId" ||
      key === "modelId" ||
      key === "modelApi" ||
      key === "endpoint" ||
      key === "credentialFingerprint" ||
      key === "consentedAt",
  );
}

/** Normalize one durable binding without ever accepting a secret field. */
export function normalizeWebSearchExistingAuthBinding(
  value: unknown,
): WebSearchExistingAuthBinding {
  if (!isRecord(value) || !bindingKeysAreKnown(value)) {
    throw new Error("Web Search existing-auth binding has an invalid shape.");
  }
  if (value.version !== WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION) {
    throw new Error("Web Search existing-auth binding version is unsupported.");
  }
  if (value.consentVersion !== WEB_SEARCH_EXISTING_AUTH_CONSENT_VERSION) {
    throw new Error("Web Search existing-auth consent version is unsupported.");
  }
  if (value.targetProviderId !== WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID) {
    throw new Error("Web Search existing-auth target provider is invalid.");
  }
  const source = sourceProviderId(value.sourceProviderId);
  const api = modelApi(value.modelApi);
  const fixed = SOURCE_ENDPOINTS[source];
  if (api !== fixed.api || endpoint(value.endpoint) !== fixed.endpoint) {
    throw new Error("Web Search existing-auth provider identity does not match its endpoint.");
  }
  return {
    version: WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION,
    consentVersion: WEB_SEARCH_EXISTING_AUTH_CONSENT_VERSION,
    targetProviderId: WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
    sourceProviderId: source,
    modelId: boundedText(value.modelId, "existing-auth model", 256),
    modelApi: api,
    endpoint: fixed.endpoint,
    credentialFingerprint: fingerprint(value.credentialFingerprint),
    consentedAt: consentedAt(value.consentedAt),
  };
}

/** Normalize the entire main-only durable binding document. */
export function normalizeWebSearchExistingAuthBindingDocument(
  value: unknown,
): WebSearchExistingAuthBindingDocument {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => key === "version" || key === "bindings") ||
    value.version !== WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION
  ) {
    throw new Error("Web Search existing-auth binding document version is unsupported.");
  }
  if (!isRecord(value.bindings)) {
    throw new Error("Web Search existing-auth binding document has an invalid shape.");
  }
  if (
    Object.keys(value.bindings).some((key) => key !== WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID)
  ) {
    throw new Error("Web Search existing-auth binding document contains an unsupported target.");
  }
  const binding = own(value.bindings, WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID)
    ? normalizeWebSearchExistingAuthBinding(value.bindings.openai)
    : undefined;
  return {
    version: WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION,
    bindings: binding ? { openai: binding } : {},
  };
}

export function parseWebSearchExistingAuthBindingDocument(
  value: unknown,
): WebSearchExistingAuthBindingDocument | null {
  try {
    return normalizeWebSearchExistingAuthBindingDocument(value);
  } catch {
    return null;
  }
}

export function emptyWebSearchExistingAuthBindingDocument(): WebSearchExistingAuthBindingDocument {
  return {
    version: WEB_SEARCH_EXISTING_AUTH_BINDING_VERSION,
    bindings: {},
  };
}

/** Validate and normalize the separate affirmative consent input. */
export function normalizeWebSearchExistingAuthConsent(
  value: unknown,
): WebSearchExistingAuthConsentRequest {
  if (!isRecord(value)) {
    throw new Error("Web Search existing-auth consent is required.");
  }
  if (
    Object.keys(value).some(
      (key) =>
        key !== "targetProviderId" &&
        key !== "sourceProviderId" &&
        key !== "modelId" &&
        key !== "consent",
    )
  ) {
    throw new Error("Web Search existing-auth consent contains unsupported fields.");
  }
  if (value.consent !== true) {
    throw new Error("Web Search existing-auth consent is required.");
  }
  if (value.targetProviderId !== WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID) {
    throw new Error("Web Search existing-auth target provider is invalid.");
  }
  return {
    targetProviderId: WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
    sourceProviderId: sourceProviderId(value.sourceProviderId),
    modelId: boundedText(value.modelId, "existing-auth model", 256),
    consent: true,
  };
}

export function webSearchExistingAuthSourceMetadata(
  providerId: WebSearchExistingAuthSourceProviderId,
): {
  readonly label: string;
  readonly authKind: "api-key" | "subscription";
  readonly modelApi: WebSearchExistingAuthModelApi;
  readonly endpoint: WebSearchExistingAuthEndpoint;
} {
  const source = sourceProviderId(providerId);
  return {
    label: SOURCE_PROVIDER_LABELS[source],
    authKind: SOURCE_AUTH_KINDS[source],
    modelApi: SOURCE_ENDPOINTS[source].api,
    endpoint: SOURCE_ENDPOINTS[source].endpoint,
  };
}

/** Renderer-safe status constructor; it intentionally omits all binding internals. */
export function webSearchExistingAuthRendererStatus(
  state: WebSearchExistingAuthBindingState,
  binding?: Pick<WebSearchExistingAuthBinding, "sourceProviderId" | "modelId">,
): WebSearchExistingAuthRendererStatus {
  return {
    targetProviderId: WEB_SEARCH_EXISTING_AUTH_TARGET_PROVIDER_ID,
    state,
    configured: state === "ready",
    ...(binding ? { sourceProviderId: binding.sourceProviderId, modelId: binding.modelId } : {}),
  };
}

export function webSearchExistingAuthRendererOptions(
  options: readonly WebSearchExistingAuthRendererOption[],
): readonly WebSearchExistingAuthRendererOption[] {
  return Object.freeze(
    options.map((option) =>
      Object.freeze({
        sourceProviderId: option.sourceProviderId,
        label: option.label,
        authKind: option.authKind,
        available: option.available === true,
        models: Object.freeze(
          option.models.map((model) => Object.freeze({ id: model.id, label: model.label })),
        ),
      }),
    ),
  );
}

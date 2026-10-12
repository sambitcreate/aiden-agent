// The image-only Pi registry. It owns a dedicated `Models` instance whose
// credential store is the `aiden-internal:image-gen:*` view, so it can never
// see or use a chat provider key. Disabled models are never registered, which
// keeps them out of every consumer lookup.

import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type AssistantImages,
  type AuthContext,
  type CredentialStore,
  type ImageApi,
  type ImageModel,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openrouterImagesApi } from "@earendil-works/pi-ai/api/openrouter-images.lazy";
import {
  curatedImageModels,
  inferImageModelMaker,
  openRouterImageModelDisplayName,
} from "../../../renderer/shared/image-generation/catalog.js";
import {
  IMAGE_GENERATION_LIMITS,
  IMAGE_GENERATION_PROVIDER_IDS,
  IMAGE_GENERATION_PROVIDER_NAMES,
  REPLICATE_REFERENCE_FIELDS,
  type ImageCatalogEntry,
  type ImageGenerationAddCustomModelRequest,
  type ImageGenerationErrorCode,
  type ImageGenerationKeyStatus,
  type ImageGenerationModelView,
  type ImageGenerationProviderId,
  type ImageGenerationSnapshot,
  type ImageGenerationState,
  type ImageModelAdapter,
  type ImageModelOrigin,
  type ImageModelRef,
  type ReplicateReferenceField,
} from "../../../renderer/shared/image-generation/types.js";
import { createImageCredentialView } from "./credential-view.js";
import { CatalogFetchError, fetchImageModels, IMAGE_CATALOG_FETCH_TIMEOUT_MS } from "./catalog-fetch.js";
import { FAL_IMAGES_API, falImagesApi } from "./fal-images.js";
import { REPLICATE_API_BASE, REPLICATE_IMAGES_API, replicateImagesApi } from "./replicate-images.js";
import {
  isValidImageModelId,
  parseImageCatalogEntry,
  type ImageGenerationSettings,
  type ImageGenerationSettingsStore,
} from "./settings-store.js";

type Fetch = typeof fetch;

/** The only ambient fallback for each image provider. Never the chat env vars. */
export const IMAGE_GENERATION_ENV_VARS: Readonly<Record<ImageGenerationProviderId, string>> = {
  openrouter: "AIDEN_IMAGE_OPENROUTER_API_KEY",
  replicate: "AIDEN_IMAGE_REPLICATE_API_TOKEN",
  fal: "AIDEN_IMAGE_FAL_KEY",
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const FAL_BASE_URL = "https://queue.fal.run";
const AUTO_ROUTER = /^openrouter\/auto(?:[-/]|$)/u;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What consumers (chat tools, Create Images) may call. */
export type ImageGenerationModels = Pick<
  Models,
  "getAvailableOfType" | "getModelOfType" | "getModelsOfType" | "generateImages"
>;

export class ImageGenerationError extends Error {
  constructor(
    readonly code: ImageGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export interface ImageGenerationRuntimeDeps {
  /** The shared encrypted store; the runtime only ever sees its image namespace. */
  credentials: CredentialStore;
  settings: ImageGenerationSettingsStore;
  /** Pi's bundled OpenRouter image models (the offline curated list). */
  openRouterModels(): readonly ImageModel<ImageApi>[];
  authContext?: AuthContext;
  fetch?: Fetch;
  pollIntervalMs?: number;
  /** Overall limit for one Fetch latest models. Default IMAGE_CATALOG_FETCH_TIMEOUT_MS. */
  catalogFetchTimeoutMs?: number;
  onWarning?(message: string): void;
}

type KeyStatuses = Record<ImageGenerationProviderId, ImageGenerationKeyStatus>;

interface CatalogRow {
  entry: ImageCatalogEntry;
  origin: ImageModelOrigin;
  enabled: boolean;
  model: ImageModel<ImageApi>;
}

function defaultAuthContext(): AuthContext {
  return {
    env: async (name) => process.env[name],
    fileExists: async () => false,
  };
}

function storedKey(credential: { type: string; key?: unknown } | undefined): string | undefined {
  return credential?.type === "api_key" && typeof credential.key === "string" && credential.key.trim()
    ? credential.key.trim()
    : undefined;
}

function imageKeyAuth(provider: ImageGenerationProviderId): ApiKeyAuth {
  const envName = IMAGE_GENERATION_ENV_VARS[provider];
  const resolveKey = async (ctx: AuthContext, credential: { type: string; key?: unknown } | undefined) => {
    const stored = storedKey(credential);
    if (stored) return { key: stored, source: "stored" };
    const ambient = (await ctx.env(envName))?.trim();
    return ambient ? { key: ambient, source: envName } : undefined;
  };
  return {
    name: `${IMAGE_GENERATION_PROVIDER_NAMES[provider]} image key`,
    async check({ ctx, credential }) {
      const resolved = await resolveKey(ctx, credential);
      return resolved ? { type: "api_key", source: resolved.source } : undefined;
    },
    async resolve({ ctx, credential }) {
      const resolved = await resolveKey(ctx, credential);
      return resolved ? { auth: { apiKey: resolved.key }, source: resolved.source } : undefined;
    },
  };
}

export function openRouterEntry(model: ImageModel<ImageApi>): ImageCatalogEntry {
  const maker = inferImageModelMaker("openrouter", model.id);
  return {
    provider: "openrouter",
    id: model.id,
    name: openRouterImageModelDisplayName(model.name || model.id).slice(0, IMAGE_GENERATION_LIMITS.maxModelNameLength),
    ...(maker ? { maker } : {}),
    acceptsReferenceImages: model.input.includes("image"),
    adapter: { kind: "openrouter", ...(model.output.includes("text") ? { textOutput: true } : {}) },
  };
}

function maxReferences(adapter: ImageModelAdapter): number | undefined {
  if (adapter.kind === "replicate") {
    if (!adapter.referenceField) return undefined;
    return REPLICATE_REFERENCE_FIELDS[adapter.referenceField] === "single" ? 1 : adapter.maxReferences ?? 4;
  }
  if (adapter.kind === "fal") {
    if (!adapter.editEndpoint) return undefined;
    return adapter.referenceField === "image_url" ? 1 : adapter.maxReferences ?? 4;
  }
  return undefined;
}

function piModel(entry: ImageCatalogEntry, bundled?: ImageModel<ImageApi>): ImageModel<ImageApi> {
  // Register the same display name Settings shows, so every surface agrees.
  if (bundled) return bundled.name === entry.name ? bundled : { ...bundled, name: entry.name };
  const max = maxReferences(entry.adapter);
  const base = {
    type: "image" as const,
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    input: entry.acceptsReferenceImages ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
    cost: ZERO_COST,
    ...(max ? { inputLimits: { images: { maxPerRequest: max } } } : {}),
  };
  if (entry.adapter.kind === "replicate") {
    return { ...base, api: REPLICATE_IMAGES_API, baseUrl: REPLICATE_API_BASE, output: ["image"] };
  }
  if (entry.adapter.kind === "fal") {
    return { ...base, api: FAL_IMAGES_API, baseUrl: FAL_BASE_URL, output: ["image"] };
  }
  return {
    ...base,
    api: "openrouter-images",
    baseUrl: OPENROUTER_BASE_URL,
    output: entry.adapter.textOutput ? ["image", "text"] : ["image"],
  };
}

function isEnabled(settings: ImageGenerationSettings, provider: ImageGenerationProviderId, id: string, origin: ImageModelOrigin) {
  const choices = settings.enabled[provider];
  if (choices && Object.prototype.hasOwnProperty.call(choices, id)) return choices[id] === true;
  // A fetch can return hundreds of models; only curated and custom ones start on.
  return origin !== "fetched";
}

function invalidRequest(message = "Invalid Image Generation request."): ImageGenerationError {
  return new ImageGenerationError("invalid_request", message);
}

const KEY_CHARACTERS = /^[\x21-\x7e]+$/u;

/** Trim and bound a key; no network call is made to validate it. */
export function normalizeImageKey(value: unknown): string {
  if (typeof value !== "string") throw new ImageGenerationError("invalid_key", "Enter an API key.");
  const key = value.trim();
  if (key.length < IMAGE_GENERATION_LIMITS.minKeyLength || key.length > IMAGE_GENERATION_LIMITS.maxKeyLength) {
    throw new ImageGenerationError("invalid_key", "That key doesn't look right. Check its length and try again.");
  }
  if (!KEY_CHARACTERS.test(key)) {
    throw new ImageGenerationError("invalid_key", "Keys can't contain spaces or special characters.");
  }
  return key;
}

/** Build a custom catalog entry from a validated request. */
export function customEntry(request: ImageGenerationAddCustomModelRequest): ImageCatalogEntry {
  const { provider } = request;
  const id = request.id.trim();
  if (provider === "openrouter" && AUTO_ROUTER.test(id)) {
    // The auto router is never listed, so it could not be removed again.
    throw invalidRequest("OpenRouter's auto router can't be added as an image model.");
  }
  if (!isValidImageModelId(provider, id)) {
    throw invalidRequest(
      provider === "replicate"
        ? "Enter a Replicate model as owner/name."
        : provider === "fal"
          ? "Enter a fal endpoint id such as fal-ai/flux/schnell."
          : "Enter an OpenRouter model id such as vendor/model.",
    );
  }
  const name = request.name?.trim() || id;
  if (name.length > IMAGE_GENERATION_LIMITS.maxModelNameLength) throw invalidRequest("That name is too long.");
  const maker = inferImageModelMaker(provider, id);
  let adapter: ImageModelAdapter;
  if (provider === "openrouter") {
    if (request.referenceField !== undefined || request.editEndpoint !== undefined) throw invalidRequest();
    adapter = { kind: "openrouter" };
  } else if (provider === "replicate") {
    if (request.editEndpoint !== undefined || request.acceptsReferenceImages !== undefined) throw invalidRequest();
    const field = request.referenceField;
    if (field !== undefined && !Object.prototype.hasOwnProperty.call(REPLICATE_REFERENCE_FIELDS, field)) {
      throw invalidRequest("Choose a supported reference image field.");
    }
    adapter = { kind: "replicate", ...(field ? { referenceField: field as ReplicateReferenceField } : {}) };
  } else {
    if (request.acceptsReferenceImages !== undefined) throw invalidRequest();
    const edit = request.editEndpoint?.trim();
    if (edit !== undefined && !isValidImageModelId("fal", edit)) throw invalidRequest("Enter a valid fal edit endpoint.");
    const field = request.referenceField;
    if (field !== undefined && field !== "image_urls" && field !== "image_url") {
      throw invalidRequest("Choose a supported reference image field.");
    }
    if (field !== undefined && !edit) throw invalidRequest("Reference images need an edit endpoint.");
    adapter = {
      kind: "fal",
      textEndpoint: id,
      ...(edit ? { editEndpoint: edit, referenceField: field ?? "image_urls" } : {}),
    };
  }
  return parseImageCatalogEntry(provider, {
    provider,
    id,
    name,
    ...(maker ? { maker } : {}),
    acceptsReferenceImages: provider === "openrouter" ? request.acceptsReferenceImages === true : false,
    adapter,
  });
}

export class ImageGenerationRuntime {
  readonly credentials: CredentialStore;
  private readonly native: MutableModels;
  private readonly authContext: AuthContext;
  private readonly fetchImpl: Fetch;
  private readonly metadata = new Map<ImageGenerationProviderId, Map<string, ImageModelAdapter>>();
  private rows: CatalogRow[] = [];
  private settingsSnapshot: ImageGenerationSettings | undefined;
  private readyPromise: Promise<void> | undefined;
  /** Per-provider key presence, computed lazily and dropped on every key change. */
  private keyCache: Promise<KeyStatuses> | undefined;
  private registration: Promise<void> = Promise.resolve();
  readonly models: ImageGenerationModels;

  constructor(private readonly deps: ImageGenerationRuntimeDeps) {
    this.credentials = createImageCredentialView(deps.credentials);
    this.authContext = deps.authContext ?? defaultAuthContext();
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.native = createModels({ credentials: this.credentials, authContext: this.authContext });
    for (const provider of IMAGE_GENERATION_PROVIDER_IDS) this.metadata.set(provider, new Map());

    const native = this.native;
    const ready = () => this.ready();
    this.models = {
      getModelsOfType: ((type, provider) => native.getModelsOfType(type, provider)) as Models["getModelsOfType"],
      getModelOfType: ((type, provider, id) => native.getModelOfType(type, provider, id)) as Models["getModelOfType"],
      getAvailableOfType: (async (type, provider, options) => {
        await ready();
        return native.getAvailableOfType(type, provider, options);
      }) as Models["getAvailableOfType"],
      generateImages: async (model, context, options): Promise<AssistantImages> => {
        await ready();
        // Dispatch the registered model, never a caller-built one, so a
        // disabled or forged model (or a foreign baseUrl) cannot reach a provider.
        const registered = native.getModelOfType("image", model.provider, model.id);
        if (!registered) {
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "error",
            errorMessage: "This image model is turned off or unavailable in Settings → Image Generation.",
            timestamp: Date.now(),
          };
        }
        return native.generateImages(registered, context, options);
      },
    };
  }

  /** Load settings and register providers once. Offline; never touches the network. */
  ready(): Promise<void> {
    if (!this.readyPromise) {
      const pending = (async () => {
        if (await this.deps.settings.loadedFromCorruptFile()) {
          this.deps.onWarning?.("Image generation settings were unreadable and have been reset to defaults.");
        }
        await this.register();
      })();
      this.readyPromise = pending;
      // A failed load (for example a transient disk error) is retried by the next call.
      pending.catch(() => {
        if (this.readyPromise === pending) this.readyPromise = undefined;
      });
    }
    return this.readyPromise;
  }

  /** The maker logo slug for a listed model, or one inferred from its id. */
  imageModelMaker(provider: string, id: string): string | undefined {
    const row = this.rows.find((candidate) => candidate.entry.provider === provider && candidate.entry.id === id);
    return row ? row.entry.maker : inferImageModelMaker(provider, id);
  }

  private curatedIds(provider: ImageGenerationProviderId): string[] {
    if (provider !== "openrouter") return curatedImageModels(provider).map((entry) => entry.id);
    return this.deps
      .openRouterModels()
      .filter((model) => model.provider === "openrouter" && model.type === "image")
      .map((model) => model.id);
  }

  /** Drop enable choices for ids no longer in any list, so the choice cap can't fill with stale ids. */
  private pruneEnabled(draft: ImageGenerationSettings): void {
    for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
      const choices = draft.enabled[provider];
      if (!choices) continue;
      const known = new Set([
        ...this.curatedIds(provider),
        ...(draft.custom[provider] ?? []).map((entry) => entry.id),
        ...(draft.fetched[provider]?.models ?? []).map((entry) => entry.id),
      ]);
      const kept = Object.entries(choices).filter(([id]) => known.has(id));
      if (kept.length !== Object.keys(choices).length) draft.enabled[provider] = Object.fromEntries(kept);
    }
  }

  private adapterFor(provider: ImageGenerationProviderId, id: string): ImageModelAdapter | undefined {
    return this.metadata.get(provider)?.get(id);
  }

  private buildRows(provider: ImageGenerationProviderId, settings: ImageGenerationSettings): CatalogRow[] {
    const rows: CatalogRow[] = [];
    const seen = new Set<string>();
    const add = (entry: ImageCatalogEntry, origin: ImageModelOrigin, bundled?: ImageModel<ImageApi>) => {
      if (seen.has(entry.id) || (provider === "openrouter" && AUTO_ROUTER.test(entry.id))) return;
      seen.add(entry.id);
      rows.push({
        entry,
        origin,
        enabled: isEnabled(settings, provider, entry.id, origin),
        model: piModel(entry, bundled),
      });
    };
    if (provider === "openrouter") {
      for (const model of this.deps.openRouterModels()) {
        if (model.provider === "openrouter" && model.type === "image") add(openRouterEntry(model), "curated", model);
      }
    } else {
      for (const entry of curatedImageModels(provider)) add(entry, "curated");
    }
    // Curated wins, then the user's custom metadata, then fetched lists.
    for (const entry of settings.custom[provider] ?? []) add(entry, "custom");
    for (const entry of settings.fetched[provider]?.models ?? []) add(entry, "fetched");
    return rows;
  }

  /**
   * Rebuild the rows of `providers` and re-register only those providers;
   * every other provider keeps its registration. `known` skips a re-read when
   * the caller already holds the freshly written settings.
   */
  private register(
    providers: readonly ImageGenerationProviderId[] = IMAGE_GENERATION_PROVIDER_IDS,
    known?: ImageGenerationSettings,
  ): Promise<void> {
    const run = this.registration.then(async () => {
      const settings = known ?? (await this.deps.settings.read());
      const rows: CatalogRow[] = [];
      for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
        if (!providers.includes(provider)) {
          rows.push(...this.rows.filter((row) => row.entry.provider === provider));
          continue;
        }
        const providerRows = this.buildRows(provider, settings);
        const metadata = new Map<string, ImageModelAdapter>();
        const models: ImageModel<ImageApi>[] = [];
        for (const row of providerRows) {
          if (!row.enabled) continue;
          metadata.set(row.entry.id, row.entry.adapter);
          models.push(row.model);
        }
        this.metadata.set(provider, metadata);
        this.native.setProvider(this.buildProvider(provider, models));
        rows.push(...providerRows);
      }
      this.rows = rows;
      this.settingsSnapshot = settings;
    });
    this.registration = run.catch(() => undefined);
    return run;
  }

  private buildProvider(provider: ImageGenerationProviderId, models: ImageModel<ImageApi>[]) {
    const common = {
      id: provider,
      name: IMAGE_GENERATION_PROVIDER_NAMES[provider],
      auth: { apiKey: imageKeyAuth(provider) },
      models,
    };
    const adapterDeps = { fetch: this.fetchImpl, ...(this.deps.pollIntervalMs ? { pollIntervalMs: this.deps.pollIntervalMs } : {}) };
    if (provider === "replicate") {
      return createProvider({
        ...common,
        baseUrl: REPLICATE_API_BASE,
        images: {
          [REPLICATE_IMAGES_API]: replicateImagesApi({
            ...adapterDeps,
            metadata: (id) => {
              const adapter = this.adapterFor("replicate", id);
              return adapter?.kind === "replicate" ? adapter : undefined;
            },
          }),
        },
      });
    }
    if (provider === "fal") {
      return createProvider({
        ...common,
        baseUrl: FAL_BASE_URL,
        images: {
          [FAL_IMAGES_API]: falImagesApi({
            ...adapterDeps,
            metadata: (id) => {
              const adapter = this.adapterFor("fal", id);
              return adapter?.kind === "fal" ? adapter : undefined;
            },
          }),
        },
      });
    }
    return createProvider({ ...common, baseUrl: OPENROUTER_BASE_URL, images: { "openrouter-images": openrouterImagesApi() } });
  }

  private async keyStatus(provider: ImageGenerationProviderId): Promise<ImageGenerationKeyStatus> {
    if (storedKey(await this.credentials.read(provider))) return { connected: true, source: "stored" };
    const ambient = (await this.authContext.env(IMAGE_GENERATION_ENV_VARS[provider]))?.trim();
    return ambient ? { connected: true, source: "env" } : { connected: false, source: null };
  }

  /** Key presence for every provider, read once and cached until a key changes. */
  private keyStatuses(): Promise<KeyStatuses> {
    if (!this.keyCache) {
      const pending = (async () => {
        const entries = await Promise.all(
          IMAGE_GENERATION_PROVIDER_IDS.map(async (provider) => [provider, await this.keyStatus(provider)] as const),
        );
        return Object.fromEntries(entries) as KeyStatuses;
      })();
      this.keyCache = pending;
      pending.catch(() => {
        if (this.keyCache === pending) this.keyCache = undefined;
      });
    }
    return this.keyCache;
  }

  private invalidateKeys(): void {
    this.keyCache = undefined;
  }

  private async resolvedKey(provider: ImageGenerationProviderId): Promise<string | undefined> {
    const stored = storedKey(await this.credentials.read(provider));
    if (stored) return stored;
    return (await this.authContext.env(IMAGE_GENERATION_ENV_VARS[provider]))?.trim() || undefined;
  }

  /** Redacted renderer state. Offline. */
  async getState(): Promise<ImageGenerationState> {
    await this.ready();
    await this.registration;
    const settings = this.settingsSnapshot ?? (await this.deps.settings.read());
    const keys = await this.keyStatuses();
    const providers = await Promise.all(
      IMAGE_GENERATION_PROVIDER_IDS.map(async (id) => {
        const fetched = settings.fetched[id];
        return {
          id,
          name: IMAGE_GENERATION_PROVIDER_NAMES[id],
          key: { ...keys[id] },
          fetchedAt: fetched?.fetchedAt ?? null,
          fetchedCount: fetched?.models.length ?? 0,
          fetchRequiresKey: id === "replicate",
        };
      }),
    );
    const models: ImageGenerationModelView[] = this.rows.map(({ entry, origin, enabled }) => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
      ...(entry.maker ? { maker: entry.maker } : {}),
      acceptsReferenceImages: entry.acceptsReferenceImages,
      enabled,
      origin,
    }));
    return { providers, models, defaultModel: settings.defaultModel };
  }

  /** Apply a settings change, then re-register only `providers`. */
  private async mutate(
    providers: readonly ImageGenerationProviderId[],
    mutation: (draft: ImageGenerationSettings) => void,
  ): Promise<ImageGenerationState> {
    await this.ready();
    const settings = await this.deps.settings.update((draft) => {
      mutation(draft);
      this.pruneEnabled(draft);
    });
    await this.register(providers, settings);
    return this.getState();
  }

  private requireRow(provider: ImageGenerationProviderId, id: string): CatalogRow {
    const row = this.rows.find((candidate) => candidate.entry.provider === provider && candidate.entry.id === id);
    if (!row) throw new ImageGenerationError("unknown_model", "That model isn't in the list.");
    return row;
  }

  async setKey(provider: ImageGenerationProviderId, value: unknown): Promise<ImageGenerationState> {
    const key = normalizeImageKey(value);
    await this.ready();
    try {
      await this.credentials.modify(provider, async () => ({ type: "api_key", key }));
    } finally {
      this.invalidateKeys();
    }
    return this.getState();
  }

  async removeKey(provider: ImageGenerationProviderId): Promise<ImageGenerationState> {
    await this.ready();
    try {
      await this.credentials.delete(provider);
    } finally {
      this.invalidateKeys();
    }
    return this.getState();
  }

  async setModelEnabled(provider: ImageGenerationProviderId, id: string, enabled: boolean): Promise<ImageGenerationState> {
    await this.ready();
    this.requireRow(provider, id);
    return this.mutate([provider], (draft) => {
      draft.enabled[provider] = { ...(draft.enabled[provider] ?? {}), [id]: enabled };
    });
  }

  /**
   * Apply many enable choices in one settings write and re-register each
   * affected provider once. Every model must be listed, or nothing is written.
   * Like `setModelEnabled`, turning off the default keeps it stored.
   */
  async setModelsEnabled(
    changes: readonly { provider: ImageGenerationProviderId; id: string; enabled: boolean }[],
  ): Promise<ImageGenerationState> {
    await this.ready();
    if (changes.length > IMAGE_GENERATION_LIMITS.maxBulkModelChanges) throw invalidRequest();
    const seen = new Set<string>();
    for (const { provider, id } of changes) {
      const key = `${provider}\u0000${id}`;
      const listed = this.rows.some((row) => row.entry.provider === provider && row.entry.id === id);
      if (!listed || seen.has(key)) throw invalidRequest("One or more of those models aren't in the list.");
      seen.add(key);
    }
    if (changes.length === 0) return this.getState();
    const providers = IMAGE_GENERATION_PROVIDER_IDS.filter((provider) =>
      changes.some((change) => change.provider === provider),
    );
    return this.mutate(providers, (draft) => {
      for (const provider of providers) draft.enabled[provider] = { ...(draft.enabled[provider] ?? {}) };
      for (const { provider, id, enabled } of changes) draft.enabled[provider]![id] = enabled;
    });
  }

  async setDefaultModel(ref: ImageModelRef | null): Promise<ImageGenerationState> {
    await this.ready();
    // Only turning on a previously disabled model changes what is registered.
    const turnsOn = ref ? !this.requireRow(ref.provider, ref.id).enabled : false;
    return this.mutate(ref && turnsOn ? [ref.provider] : [], (draft) => {
      draft.defaultModel = ref ? { provider: ref.provider, id: ref.id } : null;
      // Choosing a default turns that model on.
      if (ref) draft.enabled[ref.provider] = { ...(draft.enabled[ref.provider] ?? {}), [ref.id]: true };
    });
  }

  async addCustomModel(request: ImageGenerationAddCustomModelRequest): Promise<ImageGenerationState> {
    const entry = customEntry(request);
    await this.ready();
    const existing = this.rows.find((row) => row.entry.provider === entry.provider && row.entry.id === entry.id);
    if (existing && existing.origin !== "fetched") {
      throw new ImageGenerationError("invalid_request", "That model is already in the list.");
    }
    return this.mutate([entry.provider], (draft) => {
      const custom = draft.custom[entry.provider] ?? [];
      if (custom.length >= IMAGE_GENERATION_LIMITS.maxCustomModelsPerProvider) {
        throw new ImageGenerationError("invalid_request", "You've reached the limit of custom models for this provider.");
      }
      draft.custom[entry.provider] = [...custom, entry];
      draft.enabled[entry.provider] = { ...(draft.enabled[entry.provider] ?? {}), [entry.id]: true };
    });
  }

  async removeCustomModel(ref: ImageModelRef): Promise<ImageGenerationState> {
    await this.ready();
    const row = this.requireRow(ref.provider, ref.id);
    if (row.origin !== "custom") throw new ImageGenerationError("invalid_request", "Only models you added can be removed.");
    return this.mutate([ref.provider], (draft) => {
      draft.custom[ref.provider] = (draft.custom[ref.provider] ?? []).filter((entry) => entry.id !== ref.id);
      const choices = { ...(draft.enabled[ref.provider] ?? {}) };
      delete choices[ref.id];
      draft.enabled[ref.provider] = choices;
      if (draft.defaultModel?.provider === ref.provider && draft.defaultModel.id === ref.id) draft.defaultModel = null;
    });
  }

  /** The user-pressed Fetch latest models. The only network path in this runtime besides generation. */
  async fetchModels(provider: ImageGenerationProviderId, signal?: AbortSignal): Promise<ImageGenerationState> {
    await this.ready();
    const key = provider === "openrouter" ? undefined : await this.resolvedKey(provider);
    // The whole fetch, every page included, has one deadline.
    const deadline = AbortSignal.timeout(this.deps.catalogFetchTimeoutMs ?? IMAGE_CATALOG_FETCH_TIMEOUT_MS);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let models: ImageCatalogEntry[];
    try {
      models = await fetchImageModels(provider, { fetch: this.fetchImpl, key, signal: bounded });
    } catch (error) {
      if (error instanceof CatalogFetchError) throw new ImageGenerationError(error.code, error.message);
      throw new ImageGenerationError("network_error", `Aiden couldn't fetch ${IMAGE_GENERATION_PROVIDER_NAMES[provider]} models.`);
    }
    return this.mutate([provider], (draft) => {
      draft.fetched[provider] = { fetchedAt: Date.now(), models };
    });
  }

  /**
   * The model to preselect: the stored default when it is enabled and its
   * provider has a key, otherwise the first available model.
   */
  async defaultModel(): Promise<ImageModel<ImageApi> | undefined> {
    const row = await this.defaultRow();
    return row ? this.native.getModelOfType("image", row.entry.provider, row.entry.id) : undefined;
  }

  /**
   * Whether any image model can run and the one to preselect, without
   * reading credentials beyond the cached key presence. The name is the
   * curated name, otherwise the model id (never a provider-supplied name).
   */
  async snapshot(): Promise<ImageGenerationSnapshot> {
    const row = await this.defaultRow();
    if (!row) return { available: false };
    const { provider, id, name } = row.entry;
    return { available: true, defaultModel: { provider, id, name: row.origin === "curated" ? name : id } };
  }

  private async defaultRow(): Promise<CatalogRow | undefined> {
    await this.ready();
    await this.registration;
    const keys = await this.keyStatuses();
    const usable = this.rows.filter((row) => row.enabled && keys[row.entry.provider].connected);
    const preferred = this.settingsSnapshot?.defaultModel;
    return (
      (preferred &&
        usable.find((row) => row.entry.provider === preferred.provider && row.entry.id === preferred.id)) ||
      usable[0]
    );
  }

  /** Onboarding reset: remove every image key and the settings file contents. */
  async clearAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
      await this.credentials.delete(provider).catch((error: unknown) => failures.push(error));
    }
    this.invalidateKeys();
    await this.deps.settings.reset().catch((error: unknown) => failures.push(error));
    await this.register().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw new Error("Image generation settings were not fully cleared.");
  }
}

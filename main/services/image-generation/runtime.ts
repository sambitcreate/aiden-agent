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
  type ImageGenerationState,
  type ImageModelAdapter,
  type ImageModelOrigin,
  type ImageModelRef,
  type ReplicateReferenceField,
} from "../../../renderer/shared/image-generation/types.js";
import { createImageCredentialView } from "./credential-view.js";
import { CatalogFetchError, fetchImageModels } from "./catalog-fetch.js";
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
  onWarning?(message: string): void;
}

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

function displayName(name: string): string {
  // Pi's OpenRouter names read "Vendor: Model"; the maker logo already says the vendor.
  return name.replace(/^[^:]{1,40}:\s+/u, "").trim() || name;
}

export function openRouterEntry(model: ImageModel<ImageApi>): ImageCatalogEntry {
  const maker = inferImageModelMaker("openrouter", model.id);
  return {
    provider: "openrouter",
    id: model.id,
    name: displayName(model.name || model.id).slice(0, IMAGE_GENERATION_LIMITS.maxModelNameLength),
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
  if (bundled) return bundled;
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
    this.readyPromise ??= (async () => {
      if (await this.deps.settings.loadedFromCorruptFile()) {
        this.deps.onWarning?.("Image generation settings were unreadable and have been reset to defaults.");
      }
      await this.register();
    })();
    return this.readyPromise;
  }

  private adapterFor(provider: ImageGenerationProviderId, id: string): ImageModelAdapter | undefined {
    return this.metadata.get(provider)?.get(id);
  }

  private buildRows(settings: ImageGenerationSettings): CatalogRow[] {
    const rows: CatalogRow[] = [];
    for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
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
    }
    return rows;
  }

  private register(): Promise<void> {
    const run = this.registration.then(async () => {
      const settings = await this.deps.settings.read();
      const rows = this.buildRows(settings);
      for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
        const metadata = new Map<string, ImageModelAdapter>();
        const models: ImageModel<ImageApi>[] = [];
        for (const row of rows) {
          if (row.entry.provider !== provider || !row.enabled) continue;
          metadata.set(row.entry.id, row.entry.adapter);
          models.push(row.model);
        }
        this.metadata.set(provider, metadata);
        this.native.setProvider(this.buildProvider(provider, models));
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
    const providers = await Promise.all(
      IMAGE_GENERATION_PROVIDER_IDS.map(async (id) => {
        const fetched = settings.fetched[id];
        return {
          id,
          name: IMAGE_GENERATION_PROVIDER_NAMES[id],
          key: await this.keyStatus(id),
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

  private async mutate(mutation: (draft: ImageGenerationSettings) => void): Promise<ImageGenerationState> {
    await this.ready();
    await this.deps.settings.update(mutation);
    await this.register();
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
    await this.credentials.modify(provider, async () => ({ type: "api_key", key }));
    return this.getState();
  }

  async removeKey(provider: ImageGenerationProviderId): Promise<ImageGenerationState> {
    await this.ready();
    await this.credentials.delete(provider);
    return this.getState();
  }

  async setModelEnabled(provider: ImageGenerationProviderId, id: string, enabled: boolean): Promise<ImageGenerationState> {
    await this.ready();
    this.requireRow(provider, id);
    return this.mutate((draft) => {
      draft.enabled[provider] = { ...(draft.enabled[provider] ?? {}), [id]: enabled };
    });
  }

  async setDefaultModel(ref: ImageModelRef | null): Promise<ImageGenerationState> {
    await this.ready();
    if (ref) this.requireRow(ref.provider, ref.id);
    return this.mutate((draft) => {
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
    return this.mutate((draft) => {
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
    return this.mutate((draft) => {
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
    let models: ImageCatalogEntry[];
    try {
      models = await fetchImageModels(provider, { fetch: this.fetchImpl, key, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (error instanceof CatalogFetchError) throw new ImageGenerationError(error.code, error.message);
      throw new ImageGenerationError("network_error", `Aiden couldn't fetch ${IMAGE_GENERATION_PROVIDER_NAMES[provider]} models.`);
    }
    return this.mutate((draft) => {
      draft.fetched[provider] = { fetchedAt: Date.now(), models };
    });
  }

  /**
   * The model to preselect: the stored default when it is enabled and its
   * provider has a key, otherwise the first available model.
   */
  async defaultModel(): Promise<ImageModel<ImageApi> | undefined> {
    await this.ready();
    const available = await this.native.getAvailableOfType("image");
    const preferred = this.settingsSnapshot?.defaultModel;
    return (
      (preferred && available.find((model) => model.provider === preferred.provider && model.id === preferred.id)) ||
      available[0]
    );
  }

  /** Onboarding reset: remove every image key and the settings file contents. */
  async clearAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const provider of IMAGE_GENERATION_PROVIDER_IDS) {
      await this.credentials.delete(provider).catch((error: unknown) => failures.push(error));
    }
    await this.deps.settings.reset().catch((error: unknown) => failures.push(error));
    await this.register().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw new Error("Image generation settings were not fully cleared.");
  }
}

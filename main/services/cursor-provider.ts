import {
  createAssistantMessageEventStream,
  createProvider,
  envApiKeyAuth,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import {
  CURSOR_BASE_URL,
  CURSOR_PROVIDER_ID,
  CURSOR_PROVIDER_NAME,
  currentCursorSession,
  unboundCursorSession,
  type CursorSessionBinding,
} from "./cursor-session-binding.js";

export {
  CURSOR_BASE_URL,
  CURSOR_PROVIDER_ID,
  CURSOR_PROVIDER_NAME,
} from "./cursor-session-binding.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const MAX_CATALOG_MODELS = 512;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 160;
const MAX_MODEL_TOKEN_LIMIT = 2_000_000;
const CURSOR_API = "openai-completions" as const;

type CursorCatalogModel = Model<typeof CURSOR_API>;

export interface CursorDiscoveredModel {
  id: string;
  name: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export type CursorStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface CursorProviderDependencies {
  discoverModels: (options: {
    apiKey?: string;
    forceRefresh?: boolean;
    onFallback?: (issue: { message: string }) => void;
  }) => Promise<CursorDiscoveredModel[]>;
  streamSimple?: CursorStreamSimple;
  bindSession?: (binding: CursorSessionBinding) => Promise<void>;
}

function boundedPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MODEL_TOKEN_LIMIT
    ? value
    : fallback;
}

function boundedCost(
  value: CursorDiscoveredModel["cost"],
): CursorCatalogModel["cost"] {
  if (!value) return { ...ZERO_COST };
  const rate = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  return {
    input: rate(value.input),
    output: rate(value.output),
    cacheRead: rate(value.cacheRead),
    cacheWrite: rate(value.cacheWrite),
  };
}

/**
 * Convert pi-cursor-sdk discovery rows into Pi's executable model contract.
 * Pricing is left at zero unless the SDK already published a non-negative rate.
 */
export function parseCursorModels(value: unknown): CursorCatalogModel[] {
  if (!Array.isArray(value)) throw new Error("Cursor returned an invalid model catalog.");

  const models: CursorCatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_CATALOG_MODELS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as CursorDiscoveredModel;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;

    const rawName = typeof row.name === "string" ? row.name.trim() : "";
    const name = rawName && rawName.length <= MAX_MODEL_NAME_LENGTH ? rawName : id;
    const input = row.input?.includes("image") ? (["text", "image"] as const) : (["text"] as const);
    seen.add(id);
    models.push({
      id,
      name,
      api: CURSOR_API,
      provider: CURSOR_PROVIDER_ID,
      baseUrl: CURSOR_BASE_URL,
      reasoning: row.reasoning === true,
      ...(row.reasoning === true && row.thinkingLevelMap
        ? { thinkingLevelMap: row.thinkingLevelMap }
        : {}),
      input: [...input],
      cost: boundedCost(row.cost),
      contextWindow: boundedPositiveInteger(row.contextWindow, 128_000),
      maxTokens: boundedPositiveInteger(row.maxTokens, 16_384),
    });
  }

  if (models.length === 0) throw new Error("Cursor returned no usable chat models.");
  return models;
}

let cursorTurnTail: Promise<void> = Promise.resolve();

function enqueueCursorTurn<T>(run: () => Promise<T>): Promise<T> {
  const started = cursorTurnTail.then(run, run);
  cursorTurnTail = started.then(
    () => undefined,
    () => undefined,
  );
  return started;
}

async function defaultDiscoverModels(options: {
  apiKey?: string;
  forceRefresh?: boolean;
  onFallback?: (issue: { message: string }) => void;
}): Promise<CursorDiscoveredModel[]> {
  const { discoverModels } = await import("pi-cursor-sdk/dist/model-discovery.js");
  return discoverModels(options);
}

async function defaultStreamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessageEventStream> {
  const { streamCursorLazy } = await import("pi-cursor-sdk/dist/cursor-provider-lazy.js");
  return streamCursorLazy(model, context, options);
}

async function defaultBindSession(binding: CursorSessionBinding): Promise<void> {
  // The SDK's public registerCursorSessionScope() is a Pi extension hook and
  // also parses process.argv. Aiden is not a Pi CLI host, so bind through the
  // documented session-scope test setter from fitchmultz/pi-cursor-sdk.
  const { __testUtils } = await import("pi-cursor-sdk/dist/cursor-session-scope.js");
  __testUtils.set(binding.cwd, binding.sessionFile, binding.sessionId, binding.projectTrusted);
}

function cursorRuntimeError(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: Date.now(),
    errorMessage: error instanceof Error ? error.message : "Cursor provider runtime failed.",
  };
}

function abortedError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "CursorLiveRunAbortError";
}

function cursorAbortedMessage(model: Model<Api>): AssistantMessage {
  return {
    ...cursorRuntimeError(model, abortedError()),
    stopReason: "aborted",
    errorMessage: "The response was aborted.",
  };
}

function pipeCursorStream(
  deps: CursorProviderDependencies,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const signal = options?.signal;
  enqueueCursorTurn(async () => {
    if (signal?.aborted) throw abortedError();
    const binding = currentCursorSession() ?? unboundCursorSession();
    await (deps.bindSession ?? defaultBindSession)(binding);
    const inner = await (deps.streamSimple ?? defaultStreamSimple)(model, context, options);
    for await (const event of inner) {
      outer.push(event);
    }
  }).then(
    () => {
      outer.end();
    },
    (error: unknown) => {
      const aborted = isAbortLike(error) || signal?.aborted === true;
      const message = aborted ? cursorAbortedMessage(model) : cursorRuntimeError(model, error);
      outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      outer.end(message);
    },
  );
  return outer;
}

export function cursorProvider(
  deps: CursorProviderDependencies = { discoverModels: defaultDiscoverModels },
) {
  const streams = {
    stream: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      pipeCursorStream(deps, model, context, options),
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      pipeCursorStream(deps, model, context, options),
  };

  return createProvider({
    id: CURSOR_PROVIDER_ID,
    name: CURSOR_PROVIDER_NAME,
    baseUrl: CURSOR_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("Cursor API key", ["CURSOR_API_KEY"]),
    },
    models: [],
    fetchModels: async ({ credential }) => {
      const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
      if (!key) throw new Error("Cursor model refresh needs an API key.");
      return parseCursorModels(
        await deps.discoverModels({
          apiKey: key,
          forceRefresh: true,
        }),
      );
    },
    api: streams,
  });
}

export function registerCursorProvider(models: MutableModels): MutableModels {
  models.setProvider(cursorProvider());
  return models;
}

export const __testUtils = {
  resetTurnQueue(): void {
    cursorTurnTail = Promise.resolve();
  },
};

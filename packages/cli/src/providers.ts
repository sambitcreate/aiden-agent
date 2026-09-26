import { googleThinkingLevelsForModel } from "../../../renderer/shared/google-thinking.js";
import { anthropicThinkingLevelsForModel } from "../../../renderer/shared/anthropic-thinking.js";
import { codexThinkingLevelsForModel } from "../../../renderer/shared/codex-thinking.js";
import { dirname, join } from "node:path";
import { ModelRuntime, VERSION, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { concentrateProvider } from "../../../main/services/concentrate-provider.js";
import { withPiRemoteCatalog, isPiRemoteCatalogProvider } from "../../../main/services/pi-remote-catalog.js";
import { fetchModelsDevCatalog, parseModelsDevCacheDocument } from "../../../main/services/models-dev-cache-core.js";
import { fetchArtificialAnalysisUserCache } from "../../../main/services/artificial-analysis-runtime-core.js";
import { fetchOpenRouterBenchmarkCache } from "../../../main/services/openrouter-benchmark-runtime-core.js";
import { parseArtificialAnalysisUserCache } from "../../../main/services/artificial-analysis-catalog-core.js";
import { parseOpenRouterBenchmarkCache } from "../../../main/services/openrouter-benchmark-catalog-core.js";
import { insightCredentials } from "./credentials.ts";
import { lookupCatalogModelInfo, parseModelCatalog } from "../../../main/services/models-catalog-core.js";
import { atomicJson, readJson, splitArgs, JsonStore } from "./state.ts";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export async function importProviders(agentDir: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a models.json object.");
  const input = value as Record<string, unknown>;
  if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers)) throw new Error("Expected a providers object.");
  return new JsonStore<Record<string, unknown>>(join(agentDir, "models.json"), {}).update(async (draft) => {
    Object.assign(draft, input, { providers: { ...(draft.providers as object ?? {}), ...input.providers as object } });
    const temporary = join(agentDir, `.models-validation-${randomUUID()}.json`);
    try {
      atomicJson(temporary, draft);
      const runtime = await ModelRuntime.create({ modelsPath: temporary, authPath: join(agentDir, "auth.json"), allowModelNetwork: false, refreshOnCreate: false });
      const error = runtime.getError();
      if (error) throw new Error(error);
    } finally { rmSync(temporary, { force: true }); }
    return { imported: Object.keys(input.providers as object) };
  });
}

export async function createCliModelRuntime(agentDir: string) {
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  for (const provider of runtime.getProviders()) {
    if (isPiRemoteCatalogProvider(provider)) runtime.registerNativeProvider(withPiRemoteCatalog(provider));
  }
  runtime.registerNativeProvider(concentrateProvider());
  return runtime;
}

export async function catalogCommand(agentDir: string, args: string[]) {
  if (args[0] === "refresh" && args.length === 1) {
    const runtime = await createCliModelRuntime(agentDir);
    return runtime.refresh({ allowNetwork: true });
  }
  // Deliberately no startup path to this endpoint. Metadata is display-only.
  if (args.join(" ") === "models-dev fetch") {
    const catalog = await fetchModelsDevCatalog();
    const cache = { schemaVersion: 1, appVersion: VERSION, fetchedAt: new Date().toISOString(), catalog };
    const checked = parseModelsDevCacheDocument(cache);
    atomicJson(join(agentDir, "models-dev.json"), checked);
    return { fetchedAt: checked.fetchedAt };
  }
  if (args.join(" ") === "models-dev status") return readJson(join(agentDir, "models-dev.json"), null);
  throw new Error("Usage: catalog refresh | models-dev fetch | models-dev status");
}

export async function insightsCommand(agentDir: string, args: string[]) {
  const [source, action = "show"] = args;
  if (source !== "aa" && source !== "openrouter") throw new Error("Usage: insights <aa|openrouter> <show|fetch|disconnect>");
  const file = join(agentDir, `${source}-insights.json`);
  if (action === "show") {
    const value = readJson(file, null);
    return value ? (source === "openrouter" ? parseOpenRouterBenchmarkCache(value) : parseArtificialAnalysisUserCache(value)) : null;
  }
  if (action === "disconnect") { await insightCredentials(agentDir).delete(source); atomicJson(file, null); return { disconnected: source }; }
  if (action !== "fetch" && action !== "connect") throw new Error("Expected show, fetch, or disconnect.");
  // Dedicated benchmark key only; never fall back to OPENROUTER_API_KEY.
  const key = process.env[source === "aa" ? "AIDEN_AA_KEY" : "AIDEN_OPENROUTER_BENCHMARK_KEY"]?.trim() ?? (action === "fetch" ? await insightCredentials(agentDir).read(source) : undefined);
  if (!key) throw new Error(`Set ${source === "aa" ? "AIDEN_AA_KEY" : "AIDEN_OPENROUTER_BENCHMARK_KEY"} for this manual fetch.`);
  const value = source === "aa" ? await fetchArtificialAnalysisUserCache(key) : await fetchOpenRouterBenchmarkCache(key);
  if (action === "connect") await insightCredentials(agentDir).write(source, key);
  atomicJson(file, value);
  return value;
}

export function createProviderParityExtension(agentDir: string): InlineExtension {
  return { name: "aiden-providers", factory(pi) {
    pi.registerProvider(concentrateProvider());
    pi.on("session_start", async (_event, ctx) => {
      const ids = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
      const remoteIds: string[] = [];
      for (const id of ids) {
        const provider = ctx.modelRegistry.getProvider(id);
        if (provider && isPiRemoteCatalogProvider(provider)) { pi.registerProvider(withPiRemoteCatalog(provider)); remoteIds.push(id); }
      }
      if (!process.env.PI_OFFLINE && process.env.AIDEN_CHILD !== "1" && remoteIds.length) {
        await ctx.modelRegistry.refresh({ allowNetwork: true, providers: remoteIds, signal: AbortSignal.timeout(10_000) });
      }
    });
    pi.registerCommand("models", { description: "List models or show model metadata: /models info provider/id",
      handler: async (args, ctx) => {
        const [action, identity] = splitArgs(args);
        const models = ctx.modelRegistry.getAll();
        if (action === "info") {
          const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === identity);
          if (!model) throw new Error("Model not found. Use provider/model-id.");
          const cached = readJson(join(agentDir, "models-dev.json"), null);
          const document = cached ? parseModelsDevCacheDocument(cached) : null;
          const catalog = document?.appVersion === VERSION && document.catalog ? document.catalog : parseModelCatalog(readJson(join(dirname(process.env.AIDEN_CLI_ENTRY!), "model-capabilities.json"), {}));
          ctx.ui.notify(JSON.stringify({ ...model, metadata: catalog ? lookupCatalogModelInfo(catalog, model.provider, model.id) : null }, null, 2), "info");
        } else ctx.ui.notify(models.map((model) => `${model.provider}/${model.id}\t${model.name}\tcontext ${model.contextWindow}\tthinking ${model.reasoning}`).join("\n"), "info");
      },
    });
    for (const [name, run] of Object.entries({ catalog: catalogCommand, insights: insightsCommand })) {
      pi.registerCommand(name, { description: name === "catalog" ? "Explicit catalog refresh and display-only metadata" : "Manual benchmark fetch and offline insights",
        handler: async (args, ctx) => {
          ctx.ui.notify(JSON.stringify(await run(agentDir, splitArgs(args)), null, 2), "info");
          if (name === "catalog" && args.trim() === "refresh") await ctx.modelRegistry.refresh({ allowNetwork: false });
        },
      });
    }
  } };
}


/** Main-owned provider inventory. Remote projections remove endpoints and credentials. */
export async function listCliProviders(agentDir: string): Promise<import("../../../main/services/types.js").Provider[]> {
  const runtime = await createCliModelRuntime(agentDir), available = runtime.getAvailableSnapshot();
  return runtime.getProviders().map((provider) => {
    const models = available.filter((model) => model.provider === provider.id);
    return { id: provider.id, kind: "openai", label: provider.name, baseUrl: models[0]?.baseUrl ?? "", needsKey: false, hasKey: true, models: models.map((model) => model.id),
      modelMetadata: Object.fromEntries(models.map((model) => [model.id, { name: model.name, source: "provider", type: "llm", vision: model.input.includes("image"), reasoning: model.reasoning, thinkingLevels: cliThinkingLevels(model), contextLength: model.contextWindow }])) };
  });
}

export function cliThinkingLevels(model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>) {
  if (model.api === "anthropic-messages") return anthropicThinkingLevelsForModel(model);
  if (model.api === "google-generative-ai" || model.api === "google-vertex") return googleThinkingLevelsForModel(model);
  if (model.api === "openai-codex-responses") return codexThinkingLevelsForModel(model);
  return model.reasoning ? (["off", "low", "medium", "high"] as const).filter((level) => model.thinkingLevelMap?.[level] !== null) : [];
}

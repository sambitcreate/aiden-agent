import { migrateCliAzureConfig } from "./azure-config-migration.ts";
import { googleThinkingLevelsForModel } from "../../../renderer/shared/google-thinking.js";
import { anthropicThinkingLevelsForModel } from "../../../renderer/shared/anthropic-thinking.js";
import { codexThinkingLevelsForModel } from "../../../renderer/shared/codex-thinking.js";
import { join } from "node:path";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { concentrateProvider } from "../../../main/services/concentrate-provider.js";
import { adaptGoogleXHighStreamOptions } from "../../../main/services/pi-provider-compatibility.js";
import { withPiRemoteCatalog, isPiRemoteCatalogProvider } from "../../../main/services/pi-remote-catalog.js";
import { piDefaultModelFor } from "../../../main/services/pi-default-models.js";
import { fetchModelsDevCatalog, parseModelsDevCacheDocument } from "../../../main/services/models-dev-cache-core.js";
import { atomicJson, readJson, JsonStore } from "./state.ts";
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
  migrateCliAzureConfig(agentDir);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  for (const provider of runtime.getProviders()) {
    if (isPiRemoteCatalogProvider(provider)) runtime.registerNativeProvider(withPiRemoteCatalog(provider));
  }
  runtime.registerNativeProvider(concentrateProvider());
  const innerStreamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    innerStreamSimple(model, context, adaptGoogleXHighStreamOptions(model, options));
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

/** Main-owned provider inventory. Remote projections remove endpoints and credentials. */
export async function listCliProviders(agentDir: string): Promise<import("../../../main/services/types.js").Provider[]> {
  const runtime = await createCliModelRuntime(agentDir), available = runtime.getAvailableSnapshot();
  return runtime.getProviders().map((provider) => {
    const models = available.filter((model) => model.provider === provider.id);
    return { id: provider.id, kind: "openai", label: provider.name, baseUrl: models[0]?.baseUrl ?? "", needsKey: false, hasKey: true, models: models.map((model) => model.id),
      defaultModel: piDefaultModelFor(provider.id, models.map((model) => model.id)),
      modelMetadata: Object.fromEntries(models.map((model) => [model.id, { name: model.name, source: "provider", type: "llm", vision: model.input.includes("image"), reasoning: model.reasoning, thinkingLevels: cliThinkingLevels(model), contextLength: model.contextWindow }])) };
  });
}

export function cliThinkingLevels(model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>) {
  if (model.api === "anthropic-messages") return anthropicThinkingLevelsForModel(model);
  if (model.api === "google-generative-ai" || model.api === "google-vertex") return googleThinkingLevelsForModel(model);
  if (model.api === "openai-codex-responses") return codexThinkingLevelsForModel(model);
  return model.reasoning ? (["off", "low", "medium", "high"] as const).filter((level) => model.thinkingLevelMap?.[level] !== null) : [];
}

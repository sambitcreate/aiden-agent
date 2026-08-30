import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import {
  AdvisorRuntime,
  advisorAllowedForGeneration,
  type AdvisorRuntimeDependencies,
  type AdvisorToolDetails,
} from "./advisor-runtime.js";

const selection = {
  providerId: "reviewer-provider",
  modelId: "reviewer-model",
  effort: "high" as const,
  disabledForExecutors: [],
  disclosureVersion: 1 as const,
};

const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Check the migration boundary before changing storage." }],
  api: "openai-completions",
  provider: "reviewer-provider",
  model: "reviewer-model",
  usage: {
    input: 12,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 10,
};

function fixture() {
  const events: string[] = [];
  let streamOptions: Record<string, unknown> | undefined;
  let replaced = 0;
  const runtime: ResolvedModelRuntime = {
    provider: {
      id: "reviewer-provider",
      kind: "openai" as const,
      label: "Reviewer",
      baseUrl: "https://reviewer.invalid/v1",
      models: ["reviewer-model"],
      needsKey: true,
    },
    model: {
      id: "reviewer-model",
      name: "Reviewer model",
      api: "openai-completions" as const,
      provider: "reviewer-provider",
      baseUrl: "https://reviewer.invalid/v1",
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    },
    models: createModels(),
    apiKey: "resolved-secret",
    headers: { "x-provider-auth": "resolved-header" },
    streams: {
      streamSimple: (_model: unknown, _context: unknown, options: unknown) => {
        streamOptions = options as Record<string, unknown>;
        return { result: async () => response } as never;
      },
    },
  };
  const configuration = {
    version: 1 as const,
    selection,
    disabledForExecutors: selection.disabledForExecutors,
  };
  const dependencies = {
    settings: {
      initialize: async () => undefined,
      get: async () => configuration,
      setSelection: async () => configuration,
      replaceSelection: async () => {
        replaced += 1;
        return configuration;
      },
    },
    attempts: {
      initialize: async () => undefined,
      prepare: async () => events.push("prepared"),
      markDispatchStarted: async () => events.push("dispatch_started"),
      settle: async () => events.push("completed"),
      markUsageRecorded: async () => events.push("usage_recorded"),
    },
    resolveRuntime: async () => runtime,
    recordUsage: async () => events.push("usage"),
    recordUnreportedUsage: async () => events.push("unreported"),
  } as unknown as AdvisorRuntimeDependencies;
  return {
    advisor: new AdvisorRuntime(dependencies),
    dependencies,
    runtime,
    configuration,
    events,
    getStreamOptions: () => streamOptions,
    getReplaced: () => replaced,
  };
}

test("advisor is absent from unattended, Telegram, Bot, and child generations", () => {
  const base = {
    usageSource: "chat",
    interactionSurface: "desktop",
    bot: false,
    child: false,
    rendererOwner: true,
    excluded: false,
  };
  assert.equal(advisorAllowedForGeneration(base), true);
  assert.equal(advisorAllowedForGeneration({ ...base, interactionSurface: "telegram" }), false);
  assert.equal(advisorAllowedForGeneration({ ...base, mode: "assistant-unattended" }), false);
  assert.equal(advisorAllowedForGeneration({ ...base, bot: true }), false);
  assert.equal(advisorAllowedForGeneration({ ...base, child: true }), false);
  assert.equal(advisorAllowedForGeneration({ ...base, rendererOwner: false }), false);
  assert.equal(advisorAllowedForGeneration({ ...base, excluded: true }), false);
});

test("advisor dispatch pins resolved auth, has no tools, reports running, and journals usage", async () => {
  const fixtureValue = fixture();
  const extension = await fixtureValue.advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: "executor", modelId: "executor-model", effort: "medium" },
    executorTools: [],
    getLiveMessages: () => [{ role: "user", content: "review this", timestamp: 1 }],
  });
  assert.ok(extension);
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const updates: AdvisorToolDetails[] = [];
  const result = await tool.execute("advisor-call", {}, undefined, (update) => {
    if (update.details) updates.push(update.details);
  });
  assert.equal(updates[0]?.status, "running");
  assert.equal(result.details?.status, "completed");
  const options = fixtureValue.getStreamOptions();
  assert.equal(options?.apiKey, "resolved-secret");
  assert.deepEqual(options?.headers, { "x-provider-auth": "resolved-header" });
  assert.equal(options?.cacheRetention, "none");
  assert.equal(options?.maxRetries, 0);
  assert.deepEqual(fixtureValue.events, [
    "prepared",
    "dispatch_started",
    "completed",
    "usage",
    "usage_recorded",
  ]);
});

test("stale renderer ownership is revalidated after provider/auth resolution", async () => {
  const fixtureValue = fixture();
  await assert.rejects(
    fixtureValue.advisor.setSelection(selection, () => {
      throw new Error("stale document");
    }),
    /stale document/u,
  );
  assert.equal(fixtureValue.getReplaced(), 0);
});

test("settings admission rejects a provider-classified non-chat reviewer", async () => {
  const fixtureValue = fixture();
  const nonChat = { ...selection, modelId: "image-model" };
  const dependencies = fixtureValue.dependencies;
  const originalResolve = dependencies.resolveRuntime;
  dependencies.resolveRuntime = async (...args) => {
    const runtime = await originalResolve(...args);
    runtime.provider.modelMetadata = {
      "image-model": { source: "provider", type: "image" },
    };
    runtime.model.id = "image-model";
    return runtime;
  };
  await assert.rejects(fixtureValue.advisor.setSelection(nonChat), /chat model/u);
  assert.equal(fixtureValue.getReplaced(), 0);
});

test("settings admission rejects a mismatched resolved model identity", async () => {
  const fixtureValue = fixture();
  await assert.rejects(
    fixtureValue.advisor.setSelection({ ...selection, modelId: "missing-model" }),
    /identity does not match/u,
  );
  assert.equal(fixtureValue.getReplaced(), 0);
});

test("unreadable optional settings fail closed without breaking chat generation", async () => {
  const fixtureValue = fixture();
  fixtureValue.dependencies.settings.initialize = async () => {
    throw new Error("corrupt private settings");
  };
  let area = "";
  fixtureValue.dependencies.reportFailure = (nextArea) => {
    area = nextArea;
  };
  const extension = await fixtureValue.advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: "executor", modelId: "executor-model" },
    executorTools: [],
    getLiveMessages: () => [],
  });
  assert.equal(extension, null);
  assert.equal(area, "settings");
});

test("an unreadable attempt journal disables dispatch without blocking settings", async () => {
  const fixtureValue = fixture();
  fixtureValue.dependencies.attempts.initialize = async () => {
    throw new Error("corrupt private journal");
  };
  let area = "";
  fixtureValue.dependencies.reportFailure = (nextArea) => {
    area = nextArea;
  };
  assert.deepEqual(await fixtureValue.advisor.configuration(), {
    version: 1,
    selection,
    disabledForExecutors: [],
  });
  const extension = await fixtureValue.advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: "executor", modelId: "executor-model" },
    executorTools: [],
    getLiveMessages: () => [],
  });
  assert.equal(extension, null);
  assert.equal(area, "journal");
});

test("Codex-shaped runtimes with an empty provider catalog remain authoritative", async () => {
  const fixtureValue = fixture();
  const codexSelection = {
    ...selection,
    providerId: "openai-codex",
    modelId: "gpt-codex",
    effort: undefined,
  };
  fixtureValue.runtime.provider.id = "openai-codex";
  fixtureValue.runtime.provider.models = [];
  fixtureValue.runtime.model.id = "gpt-codex";
  fixtureValue.runtime.apiKey = undefined;
  fixtureValue.runtime.prepareIsolatedStream = (async () => undefined) as never;
  fixtureValue.configuration.selection = codexSelection as unknown as typeof selection;
  await assert.doesNotReject(fixtureValue.advisor.setSelection(codexSelection));
  const extension = await fixtureValue.advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: "executor", modelId: "executor-model" },
    executorTools: [],
    getLiveMessages: () => [{ role: "user", content: "review", timestamp: 1 }],
  });
  assert.ok(extension?.tools?.[0]);
  const result = await extension.tools[0].execute("codex-advisor", {});
  assert.equal(result.details?.status, "completed");
});

test("Pi-native reviewer auth is preflighted at save and dispatch", async () => {
  const fixtureValue = fixture();
  fixtureValue.runtime.apiKey = undefined;
  fixtureValue.runtime.provider.isBuiltin = true;
  let authReads = 0;
  fixtureValue.runtime.models.getAuth = async () => {
    authReads += 1;
    return { auth: { apiKey: "native-auth" }, source: "test" };
  };
  await assert.doesNotReject(fixtureValue.advisor.setSelection(selection));
  assert.equal(authReads, 1);
  const extension = await fixtureValue.advisor.extensionForGeneration({
    scope: {
      usageSource: "chat",
      interactionSurface: "desktop",
      bot: false,
      child: false,
      rendererOwner: true,
      excluded: false,
    },
    executor: { providerId: "executor", modelId: "executor-model" },
    executorTools: [],
    getLiveMessages: () => [{ role: "user", content: "review", timestamp: 1 }],
  });
  const tool = extension?.tools?.[0];
  assert.ok(tool);
  await tool.execute("native-advisor", {});
  assert.equal(authReads, 2);
});

test("Pi-native reviewer selection fails closed without current auth", async () => {
  const fixtureValue = fixture();
  fixtureValue.runtime.apiKey = undefined;
  fixtureValue.runtime.provider.isBuiltin = true;
  fixtureValue.runtime.models.getAuth = async () => undefined;
  await assert.rejects(fixtureValue.advisor.setSelection(selection), /not authenticated/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  AssistantRequestUsageTracker,
  assistantUsageRecord,
  geminiTranscriptionTokens,
  isLocalModelProvider,
  openAITranscriptionTokens,
  reportedTokens,
} from "./usage-accounting.js";
import {
  createEmptyUsageDatabase,
  createUsageStore,
  type UsageDatabase,
  type UsagePersistence,
  type UsageRequestRecord,
} from "./usage-store-core.js";

function memoryPersistence(): UsagePersistence & { read(): UsageDatabase } {
  let value = createEmptyUsageDatabase();
  return {
    async load() {
      return structuredClone(value);
    },
    async save(data) {
      value = structuredClone(data);
    },
    read() {
      return structuredClone(value);
    },
  };
}

const NOW = new Date(2026, 6, 21, 12).getTime();

test("assistant request tracking accounts a pre-message-end cancellation exactly once", () => {
  const tracker = new AssistantRequestUsageTracker();
  for (let index = 0; index < 23; index += 1) {
    tracker.started();
    tracker.ended();
  }
  tracker.started();
  assert.equal(tracker.takeUnreportedCancellation(), true);
  assert.equal(tracker.takeUnreportedCancellation(), false);

  tracker.started();
  tracker.ended();
  assert.equal(tracker.takeUnreportedCancellation(), false);
});

function record(
  patch: Partial<UsageRequestRecord> &
    Pick<UsageRequestRecord, "providerId" | "modelId">,
): UsageRequestRecord {
  return {
    timestamp: NOW,
    source: "chat",
    providerLabel: patch.providerId,
    modelLabel: patch.modelId,
    local: false,
    status: "completed",
    tokens: null,
    costStatus: "unavailable",
    ...patch,
  };
}

test("aggregates reported tokens while keeping unmetered and local requests visible", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  await store.record(
    record({
      providerId: "openai",
      providerLabel: "OpenAI",
      modelId: "gpt-test",
      tokens: {
        input: 80,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
        reasoning: 5,
        total: 110,
      },
      costStatus: "reported",
      costUsd: 0.025,
    }),
  );
  await store.record(
    record({
      providerId: "ollama",
      providerLabel: "Ollama (local)",
      modelId: "qwen-local",
      local: true,
      costStatus: "not-applicable",
    }),
  );
  await store.record(
    record({
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-test",
      tokens: {
        input: 40,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 50,
      },
    }),
  );

  const summary = await store.summary("1y");
  assert.equal(summary.totals.requests, 3);
  assert.equal(summary.totals.reportedTokenRequests, 2);
  assert.equal(summary.totals.unmeteredRequests, 1);
  assert.equal(summary.totals.localRequests, 1);
  assert.equal(summary.totals.costedRequests, 1);
  assert.equal(summary.totals.unpricedHostedRequests, 1);
  assert.equal(summary.totals.hostedCostUsd, 0.025);
  assert.deepEqual(summary.totals.tokens, {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 5,
    total: 160,
  });
  assert.deepEqual(
    summary.models.map((model) => model.modelId),
    ["gpt-test", "claude-test", "qwen-local"],
  );
  assert.equal(
    summary.models.find((model) => model.local)?.unmeteredRequests,
    1,
  );
});

test("persists subagent requests as a first-class privacy-safe usage source", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  await store.record(
    record({
      source: "subagent",
      providerId: "openai",
      providerLabel: "OpenAI",
      modelId: "child-model",
    }),
  );
  assert.equal(persistence.read().buckets[0]?.source, "subagent");
  const reloaded = createUsageStore(persistence, () => NOW);
  assert.equal((await reloaded.summary("7d")).totals.requests, 1);
});

test("persists bot avatar requests without retaining their design prompts", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  await store.record(
    record({
      source: "bot-avatar",
      providerId: "openai-codex",
      providerLabel: "ChatGPT",
      modelId: "gpt-5.6-sol",
    }),
  );
  assert.equal(persistence.read().buckets[0]?.source, "bot-avatar");
  assert.doesNotMatch(JSON.stringify(persistence.read()), /prompt|rationale|appearance/u);
  assert.equal((await store.summary("7d")).totals.requests, 1);
});

test("computes calendar streaks and honors inclusive date ranges", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  for (const day of [15, 18, 19, 20]) {
    await store.record(
      record({
        timestamp: new Date(2026, 6, day, 12).getTime(),
        providerId: "openai",
        modelId: "gpt-test",
      }),
    );
  }
  await store.record(
    record({
      timestamp: new Date(2025, 0, 2, 12).getTime(),
      providerId: "openai",
      modelId: "gpt-test",
    }),
  );

  const week = await store.summary("7d");
  assert.equal(week.startDate, "2026-07-15");
  assert.equal(week.totals.activeDays, 4);
  assert.equal(week.totals.currentStreak, 3);
  assert.equal(week.totals.longestStreak, 3);
  assert.equal(week.totals.requests, 4);

  const all = await store.summary("all");
  assert.equal(all.startDate, "2025-01-02");
  assert.equal(all.totals.requests, 5);
});

test("serializes concurrent writes and never persists extra content fields", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      store.record({
        ...record({ providerId: "openai", modelId: "gpt-test" }),
        prompt: `private prompt ${index}`,
        workspacePath: `/private/${index}`,
      } as UsageRequestRecord & { prompt: string; workspacePath: string }),
    ),
  );

  assert.equal((await store.summary("1y")).totals.requests, 40);
  const serialized = JSON.stringify(persistence.read());
  assert.doesNotMatch(serialized, /private prompt|workspacePath|\/private\//u);
});

test("persists scheduled model calls as a separate privacy-safe usage source", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  await store.record(
    record({
      source: "scheduled",
      providerId: "openai",
      modelId: "gpt-test",
    }),
  );
  assert.equal(persistence.read().buckets[0]?.source, "scheduled");
  assert.equal((await store.summary("1y")).totals.requests, 1);
});

test("normalizes provider usage without inventing unavailable token counts or local cost", () => {
  assert.equal(
    reportedTokens({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    }),
    null,
  );
  assert.deepEqual(
    reportedTokens({
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 1,
    }),
    {
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 1,
      total: 7,
    },
  );
  assert.equal(
    reportedTokens({
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 3,
      cacheWrite1h: 2,
      totalTokens: 9,
    })?.cacheWrite1h,
    2,
  );
  assert.equal(
    isLocalModelProvider({
      id: "custom-remote-local",
      label: "Remote Ollama marked local",
      baseUrl: "https://model-server.example/v1",
      needsKey: false,
      deployment: "local",
    }),
    true,
  );
  assert.equal(
    isLocalModelProvider({
      id: "custom",
      label: "Private model",
      baseUrl: "http://127.0.0.1:9000/v1",
      needsKey: true,
    }),
    true,
  );
  assert.equal(
    isLocalModelProvider({
      id: "custom-remote",
      label: "Remote Ollama server",
      baseUrl: "https://model-server.example/v1",
      needsKey: false,
    }),
    false,
  );
  assert.equal(
    isLocalModelProvider({
      id: "lmstudio",
      label: "LM Studio (local)",
      baseUrl: "https://model-server.example/v1",
      needsKey: false,
    }),
    false,
  );
  assert.equal(
    isLocalModelProvider({
      id: "custom-numeric-hostname",
      label: "Numeric remote hostname",
      baseUrl: "https://127.models.example/v1",
      needsKey: false,
    }),
    false,
  );
  assert.equal(
    isLocalModelProvider({
      id: "custom-ipv6",
      label: "IPv6 loopback",
      baseUrl: "http://[::1]:9000/v1",
      needsKey: true,
    }),
    true,
  );

  const model: Model<Api> = {
    id: "local-model",
    name: "Local Model",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    stopReason: "stop",
    timestamp: NOW,
  };
  const accounted = assistantUsageRecord({
    message,
    provider: {
      id: "ollama",
      kind: "openai",
      label: "Ollama (local)",
      baseUrl: model.baseUrl,
      models: [model.id],
      needsKey: false,
    },
    model,
    source: "chat",
  });
  assert.equal(accounted.costStatus, "not-applicable");
  assert.equal(accounted.local, true);
  assert.equal(accounted.tokens?.total, 6);
});

test("maps exact OpenAI and Gemini transcription usage without double-counting cache", () => {
  assert.deepEqual(
    openAITranscriptionTokens({
      type: "tokens",
      input_tokens: 14,
      output_tokens: 31,
      total_tokens: 45,
    }),
    {
      input: 14,
      output: 31,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 45,
    },
  );
  assert.equal(
    openAITranscriptionTokens({ type: "duration", seconds: 20 }),
    null,
  );
  assert.deepEqual(
    geminiTranscriptionTokens({
      promptTokenCount: 100,
      cachedContentTokenCount: 30,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 130,
    }),
    {
      input: 70,
      output: 30,
      cacheRead: 30,
      cacheWrite: 0,
      reasoning: 10,
      total: 130,
    },
  );
});

test("counts every assistant turn outcome, including tool loops, failures, and aborts", async () => {
  const persistence = memoryPersistence();
  const store = createUsageStore(persistence, () => NOW);
  const provider = {
    id: "openai",
    kind: "openai" as const,
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-test"],
    needsKey: true,
  };
  const model: Model<Api> = {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-completions",
    provider: "openai",
    baseUrl: provider.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };

  for (const stopReason of ["toolUse", "error", "aborted"] as const) {
    const message: AssistantMessage = {
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
      stopReason,
      timestamp: NOW,
    };
    await store.record(
      assistantUsageRecord({ message, provider, model, source: "chat" }),
    );
  }

  const summary = await store.summary("7d");
  assert.equal(summary.totals.requests, 3);
  assert.equal(summary.totals.completedRequests, 1);
  assert.equal(summary.totals.failedRequests, 1);
  assert.equal(summary.totals.cancelledRequests, 1);
  assert.equal(summary.totals.unmeteredRequests, 3);
  assert.equal(summary.totals.costedRequests, 3);
});

test("ignores impossible persisted dates and recovers with a valid record", async () => {
  let saved = createEmptyUsageDatabase();
  let saveCount = 0;
  const persistence: UsagePersistence = {
    async load() {
      return {
        version: 1,
        buckets: [
          {
            date: "2026-02-31",
            source: "chat",
            providerId: "openai",
            providerLabel: "OpenAI",
            modelId: "gpt-test",
            modelLabel: "GPT Test",
            local: false,
            requests: 99,
          },
        ],
      };
    },
    async save(data) {
      saveCount += 1;
      saved = structuredClone(data);
    },
  };
  const store = createUsageStore(persistence, () => NOW);

  assert.equal((await store.summary("all")).totals.requests, 0);
  await store.record(record({ providerId: "openai", modelId: "gpt-test" }));
  assert.equal((await store.summary("all")).totals.requests, 1);
  assert.equal(saveCount, 1);
  assert.equal(saved.buckets.length, 1);
  assert.equal(saved.buckets[0]?.date, "2026-07-21");
});

test("drops hosted cost fields from corrupt local buckets", async () => {
  const persistence: UsagePersistence = {
    async load() {
      return {
        version: 1,
        buckets: [
          {
            date: "2026-07-21",
            source: "chat",
            providerId: "ollama",
            providerLabel: "Ollama",
            modelId: "local-model",
            modelLabel: "Local Model",
            local: true,
            requests: 1,
            completedRequests: 1,
            unmeteredRequests: 1,
            costedRequests: 1,
            unpricedHostedRequests: 1,
            hostedCostUsd: 99,
          },
        ],
      };
    },
    async save() {},
  };

  const summary = await createUsageStore(persistence, () => NOW).summary("7d");
  assert.equal(summary.totals.localRequests, 1);
  assert.equal(summary.totals.costedRequests, 0);
  assert.equal(summary.totals.unpricedHostedRequests, 0);
  assert.equal(summary.totals.hostedCostUsd, 0);
  assert.equal(summary.models[0]?.hostedCostUsd, 0);
});

test("retains queued mutations across a transient persistence failure", async () => {
  let value = createEmptyUsageDatabase();
  let saveAttempts = 0;
  const persistence: UsagePersistence = {
    async load() {
      return structuredClone(value);
    },
    async save(data) {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("temporary write failure");
      value = structuredClone(data);
    },
  };
  const store = createUsageStore(persistence, () => NOW);

  await assert.rejects(
    store.record(record({ providerId: "openai", modelId: "first-model" })),
    /temporary write failure/u,
  );
  await store.record(record({ providerId: "openai", modelId: "second-model" }));

  assert.equal((await store.summary("7d")).totals.requests, 2);
  assert.equal(
    value.buckets.reduce((total, bucket) => total + bucket.requests, 0),
    2,
  );
});

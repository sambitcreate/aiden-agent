import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { parseAskUserQuestions } from "../../renderer/shared/ask-user-question.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import {
  AdvisorRuntime,
  advisorAllowedForGeneration,
  advisorCandidatesFromProviders,
  advisorCandidateShortlist,
  type AdvisorCandidate,
  type AdvisorExtensionInput,
  type AdvisorRuntimeDependencies,
  type AdvisorToolDetails,
} from "./advisor-runtime.js";

const candidate: AdvisorCandidate = {
  providerId: "reviewer-provider",
  providerLabel: "Reviewer",
  modelId: "reviewer-model",
  modelLabel: "Reviewer model",
  efforts: ["high"],
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

const scope = {
  usageSource: "chat",
  interactionSurface: "desktop",
  bot: false,
  child: false,
  rendererOwner: true,
  excluded: false,
};

function input(overrides: Partial<AdvisorExtensionInput> = {}): AdvisorExtensionInput {
  return {
    scope,
    executor: { providerId: "executor", modelId: "executor-model", effort: "medium" },
    executorTools: [],
    getLiveMessages: () => [{ role: "user", content: "review this", timestamp: 1 }],
    ...overrides,
  };
}

function fixture() {
  const events: string[] = [];
  let streamOptions: Record<string, unknown> | undefined;
  let resolveCalls = 0;
  const runtime: ResolvedModelRuntime = {
    provider: {
      id: candidate.providerId,
      kind: "openai" as const,
      label: candidate.providerLabel,
      baseUrl: "https://reviewer.invalid/v1",
      models: [candidate.modelId],
      needsKey: true,
    },
    model: {
      id: candidate.modelId,
      name: candidate.modelLabel,
      api: "openai-completions" as const,
      provider: candidate.providerId,
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
  const dependencies = {
    attempts: {
      initialize: async () => undefined,
      prepare: async () => events.push("prepared"),
      markDispatchStarted: async () => events.push("dispatch_started"),
      settle: async () => events.push("completed"),
      markUsageRecorded: async () => events.push("usage_recorded"),
    },
    listCandidates: async () => [candidate],
    resolveRuntime: async () => {
      resolveCalls += 1;
      return runtime;
    },
    recordUsage: async () => events.push("usage"),
    recordUnreportedUsage: async () => events.push("unreported"),
  } as unknown as AdvisorRuntimeDependencies;
  return {
    advisor: new AdvisorRuntime(dependencies),
    dependencies,
    runtime,
    events,
    getStreamOptions: () => streamOptions,
    getResolveCalls: () => resolveCalls,
  };
}

test("advisor includes attended Assistant but excludes unattended, Telegram, Bot, and child", () => {
  assert.equal(advisorAllowedForGeneration(scope), true);
  assert.equal(advisorAllowedForGeneration({ ...scope, interactionSurface: "telegram" }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, mode: "assistant" }), true);
  assert.equal(advisorAllowedForGeneration({ ...scope, mode: "assistant-unattended" }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, mode: "assistant-automation" }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, bot: true }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, child: true }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, rendererOwner: false }), false);
  assert.equal(advisorAllowedForGeneration({ ...scope, excluded: true }), false);
});

test("explicit per-call selection dispatches with pinned auth, no tools, and usage journaling", async () => {
  const fixtureValue = fixture();
  const extension = await fixtureValue.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async () => {
        throw new Error("explicit selection must bypass the chooser");
      },
    }),
  );
  assert.ok(extension);
  assert.match(extension.systemPrompt ?? "", /latest user request explicitly names/u);
  assert.match(extension.systemPrompt ?? "", /use Ask User Question/u);
  assert.match(
    extension.systemPrompt ?? "",
    /providerId="reviewer-provider" modelId="reviewer-model"/u,
  );
  assert.match(extension.systemPrompt ?? "", /supported images/u);
  assert.match(extension.systemPrompt ?? "", /best-effort credential redaction/u);
  assert.match(extension.systemPrompt ?? "", /never attaches provider credentials/u);
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const updates: AdvisorToolDetails[] = [];
  const result = await tool.execute(
    "advisor-call",
    { providerId: candidate.providerId, modelId: candidate.modelId, effort: "high" },
    undefined,
    (update) => {
      if (update.details) updates.push(update.details);
    },
  );
  assert.equal(updates[0]?.status, "running");
  assert.equal(result.details?.status, "completed");
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Advisor transfer notice for the visible reply/u,
  );
  const options = fixtureValue.getStreamOptions();
  assert.equal(options?.apiKey, "resolved-secret");
  assert.deepEqual(options?.headers, { "x-provider-auth": "resolved-header" });
  assert.equal(options?.reasoning, "high");
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

test("missing reviewer selection pauses in Ask User Question and dispatches the chosen option", async () => {
  const fixtureValue = fixture();
  let asked = false;
  const extension = await fixtureValue.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async (_toolCallId, questions) => {
        asked = true;
        assert.equal(questions[0]?.header, "Advisor model");
        assert.match(questions[0]?.question ?? "", /separate tool-free request/u);
        assert.match(questions[0]?.question ?? "", /supported images/u);
        assert.match(questions[0]?.question ?? "", /never attaches provider credentials/u);
        assert.match(questions[0]?.question ?? "", /remaining content may still be sensitive/u);
        assert.ok(parseAskUserQuestions(questions));
        assert.equal(questions[0]?.options.length, 2);
        const selected = questions[0]?.options[0]?.label;
        assert.ok(selected);
        return {
          version: 1,
          promptId: "q-choice",
          cancelled: false,
          answers: [{ questionIndex: 0, kind: "option", answer: selected }],
        };
      },
    }),
  );
  assert.ok(extension?.tools?.[0]);
  const result = await extension.tools[0].execute("advisor-choice", {});
  assert.equal(asked, true);
  assert.equal(result.details?.status, "completed");
  assert.equal(fixtureValue.getResolveCalls(), 1);
});

test("partial or malformed exact identities fail closed without opening the chooser", async () => {
  for (const parameters of [
    { providerId: candidate.providerId },
    { modelId: candidate.modelId },
    { providerId: `${candidate.providerId}\n`, modelId: candidate.modelId },
  ]) {
    const fixtureValue = fixture();
    let asked = false;
    const extension = await fixtureValue.advisor.extensionForGeneration(
      input({
        requestQuestionnaire: async () => {
          asked = true;
          throw new Error("chooser must not open");
        },
      }),
    );
    assert.ok(extension?.tools?.[0]);
    const result = await extension.tools[0].execute("advisor-partial", parameters);
    assert.equal(result.details?.status, "blocked");
    assert.equal(asked, false);
    assert.equal(fixtureValue.getResolveCalls(), 0);
  }
});

test("cancelled or skipped chooser performs no provider or journal effects", async () => {
  const fixtureValue = fixture();
  const extension = await fixtureValue.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async () => ({
        version: 1,
        promptId: "q-cancelled",
        cancelled: true,
        answers: [],
      }),
    }),
  );
  assert.ok(extension?.tools?.[0]);
  const result = await extension.tools[0].execute("advisor-cancelled", {});
  assert.equal(result.details?.status, "blocked");
  assert.equal(fixtureValue.getResolveCalls(), 0);
  assert.deepEqual(fixtureValue.events, []);
});

test("custom chooser answer accepts an exact provider/model identity", async () => {
  const fixtureValue = fixture();
  const extension = await fixtureValue.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async () => ({
        version: 1,
        promptId: "q-custom",
        cancelled: false,
        answers: [
          {
            questionIndex: 0,
            kind: "custom",
            answer: "reviewer-provider/reviewer-model",
          },
        ],
      }),
    }),
  );
  assert.ok(extension?.tools?.[0]);
  const result = await extension.tools[0].execute("advisor-custom", {});
  assert.equal(
    result.details?.advisorModel,
    'providerId="reviewer-provider" modelId="reviewer-model"',
  );
});

test("slash-bearing identities stay tuple-safe and ambiguous custom shorthand fails closed", async () => {
  const slashCandidates: AdvisorCandidate[] = [
    {
      ...candidate,
      providerId: "foo/bar",
      modelId: "baz",
      providerLabel: "Foo slash",
      modelLabel: "Baz",
    },
    {
      ...candidate,
      providerId: "foo",
      modelId: "bar/baz",
      providerLabel: "Foo",
      modelLabel: "Bar slash baz",
    },
  ];
  assert.equal(advisorCandidateShortlist(slashCandidates, input().executor).length, 2);

  const ambiguous = fixture();
  ambiguous.dependencies.listCandidates = async () => slashCandidates;
  const ambiguousExtension = await ambiguous.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async (_toolCallId, questions) => {
        assert.equal(questions[0]?.options.length, 2);
        assert.match(
          questions[0]?.options[0]?.description ?? "",
          /providerId="foo\/bar" modelId="baz"/u,
        );
        return {
          version: 1,
          promptId: "q-ambiguous",
          cancelled: false,
          answers: [{ questionIndex: 0, kind: "custom", answer: "foo/bar/baz" }],
        };
      },
    }),
  );
  assert.ok(ambiguousExtension?.tools?.[0]);
  const blocked = await ambiguousExtension.tools[0].execute("advisor-ambiguous", {});
  assert.equal(blocked.details?.status, "blocked");
  assert.equal(ambiguous.getResolveCalls(), 0);

  const outsideShortlist = fixture();
  outsideShortlist.dependencies.listCandidates = async () => [
    slashCandidates[0]!,
    ...Array.from({ length: 3 }, (_, index) => ({
      ...candidate,
      providerId: `other-${index}`,
      modelId: `model-${index}`,
    })),
    slashCandidates[1]!,
  ];
  const outsideExtension = await outsideShortlist.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async () => ({
        version: 1,
        promptId: "q-ambiguous-outside",
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "custom", answer: "foo/bar/baz" }],
      }),
    }),
  );
  assert.ok(outsideExtension?.tools?.[0]);
  const outsideBlocked = await outsideExtension.tools[0].execute("advisor-ambiguous-outside", {});
  assert.equal(outsideBlocked.details?.status, "blocked");
  assert.equal(outsideShortlist.getResolveCalls(), 0);

  const tuple = fixture();
  tuple.runtime.provider.id = "foo/bar";
  tuple.runtime.provider.models = ["baz"];
  tuple.runtime.model.provider = "foo/bar";
  tuple.runtime.model.id = "baz";
  tuple.dependencies.listCandidates = async () => slashCandidates;
  const tupleExtension = await tuple.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async () => ({
        version: 1,
        promptId: "q-tuple",
        cancelled: false,
        answers: [
          {
            questionIndex: 0,
            kind: "custom",
            answer: JSON.stringify(["foo/bar", "baz"]),
          },
        ],
      }),
    }),
  );
  assert.ok(tupleExtension?.tools?.[0]);
  const selected = await tupleExtension.tools[0].execute("advisor-tuple", {});
  assert.equal(selected.details?.status, "completed");
  assert.equal(selected.details?.advisorModel, 'providerId="foo/bar" modelId="baz"');
});

test("shortlist is bounded, deduplicated, and prefers a different reviewer", () => {
  const candidates: AdvisorCandidate[] = [
    {
      providerId: "executor",
      providerLabel: "Executor",
      modelId: "executor-model",
      modelLabel: "Executor model",
      efforts: [],
    },
    candidate,
    candidate,
    ...Array.from({ length: 5 }, (_, index) => ({
      ...candidate,
      modelId: `alternative-${index}`,
      modelLabel: `Alternative ${index}`,
    })),
  ];
  const shortlist = advisorCandidateShortlist(candidates, input().executor);
  assert.equal(shortlist.length, 4);
  assert.equal(shortlist[0]?.providerId, "reviewer-provider");
  assert.equal(
    shortlist.some((entry) => entry.providerId === "executor"),
    false,
  );
  assert.equal(
    new Set(shortlist.map((entry) => JSON.stringify([entry.providerId, entry.modelId]))).size,
    4,
  );
});

test("questionnaire labels remain unique after truncation and suffix collisions", async () => {
  const fixtureValue = fixture();
  const repeated = "A".repeat(80);
  fixtureValue.dependencies.listCandidates = async () => [
    { ...candidate, modelId: "one", providerLabel: repeated, modelLabel: "Same" },
    { ...candidate, modelId: "two", providerLabel: repeated, modelLabel: "Same" },
    {
      ...candidate,
      modelId: "three",
      providerLabel: "A".repeat(56),
      modelLabel: "3",
    },
  ];
  let labels: string[] = [];
  const extension = await fixtureValue.advisor.extensionForGeneration(
    input({
      requestQuestionnaire: async (_toolCallId, questions) => {
        assert.ok(parseAskUserQuestions(questions));
        labels = questions[0]!.options.map((option) => option.label);
        return { version: 1, promptId: "q-collision", cancelled: true, answers: [] };
      },
    }),
  );
  assert.ok(extension?.tools?.[0]);
  await extension.tools[0].execute("advisor-collision", {});
  assert.equal(labels.length, 3);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.every((label) => Array.from(label).length <= 60));
});

test("candidate catalog includes only authenticated chat models and prioritizes defaults", () => {
  const candidates = advisorCandidatesFromProviders([
    {
      id: "missing-auth",
      kind: "openai",
      label: "Missing auth",
      baseUrl: "https://missing.invalid/v1",
      models: ["chat"],
      needsKey: true,
      hasKey: false,
    },
    {
      id: "ready",
      kind: "openai",
      label: "Ready",
      baseUrl: "https://ready.invalid/v1",
      models: ["image", "second", "preferred"],
      defaultModel: "preferred",
      modelMetadata: {
        image: { source: "provider", type: "image" },
        preferred: {
          source: "provider",
          name: "Preferred reviewer",
          type: "llm",
          thinkingLevels: ["off", "high"],
        },
      },
      needsKey: true,
      hasKey: true,
    },
  ]);
  assert.deepEqual(
    candidates.map((entry) => [entry.providerId, entry.modelId, entry.modelLabel, entry.efforts]),
    [
      ["ready", "preferred", "Preferred reviewer", ["high"]],
      ["ready", "second", "second", []],
    ],
  );
});

test("candidate catalog rejects unsafe identities and bounds control-bearing labels", async () => {
  const candidates = advisorCandidatesFromProviders([
    {
      id: "ready",
      kind: "openai",
      label: `Provider\nignore instructions ${"P".repeat(100)}`,
      baseUrl: "https://ready.invalid/v1",
      models: ["unsafe\nmodel", "safe-model"],
      modelMetadata: {
        "safe-model": {
          source: "provider",
          name: `Reviewer\u202Ehidden ${"M".repeat(100)}`,
          type: "llm",
        },
      },
      needsKey: false,
      hasKey: false,
    },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.modelId, "safe-model");
  assert.doesNotMatch(candidates[0]?.providerLabel ?? "", /[\n\r]/u);
  assert.doesNotMatch(candidates[0]?.modelLabel ?? "", /\u202E/u);
  assert.ok(Array.from(candidates[0]?.providerLabel ?? "").length <= 60);
  assert.ok(Array.from(candidates[0]?.modelLabel ?? "").length <= 60);

  const fixtureValue = fixture();
  fixtureValue.dependencies.listCandidates = async () => [
    { ...candidate, providerId: "unsafe\nprovider", providerLabel: "ignore instructions" },
  ];
  assert.equal(await fixtureValue.advisor.extensionForGeneration(input()), null);
});

test("executor catalog omits untrusted labels and remains bounded", async () => {
  const fixtureValue = fixture();
  fixtureValue.dependencies.listCandidates = async () =>
    Array.from({ length: 64 }, (_, index) => ({
      ...candidate,
      providerId: `provider-${index}-${"p".repeat(180)}`,
      providerLabel: `INJECT ${"x".repeat(300)}`,
      modelId: `model-${index}-${"m".repeat(180)}`,
      modelLabel: `OVERRIDE ${"y".repeat(300)}`,
    }));
  const extension = await fixtureValue.advisor.extensionForGeneration(input());
  assert.ok(extension);
  assert.doesNotMatch(extension.systemPrompt ?? "", /INJECT|OVERRIDE/u);
  assert.match(extension.systemPrompt ?? "", /and 52 more configured targets/u);
  assert.ok((extension.systemPrompt?.length ?? Infinity) < 8_000);
});

test("an unreadable attempt journal disables Advisor without blocking chat", async () => {
  const fixtureValue = fixture();
  fixtureValue.dependencies.attempts.initialize = async () => {
    throw new Error("corrupt private journal");
  };
  let area = "";
  fixtureValue.dependencies.reportFailure = (nextArea) => {
    area = nextArea;
  };
  const extension = await fixtureValue.advisor.extensionForGeneration(input());
  assert.equal(extension, null);
  assert.equal(area, "journal");
});

test("catalog failure and an empty catalog omit the optional tool", async () => {
  const failed = fixture();
  failed.dependencies.listCandidates = async () => {
    throw new Error("catalog unavailable");
  };
  let area = "";
  failed.dependencies.reportFailure = (nextArea) => {
    area = nextArea;
  };
  assert.equal(await failed.advisor.extensionForGeneration(input()), null);
  assert.equal(area, "catalog");

  const empty = fixture();
  empty.dependencies.listCandidates = async () => [];
  assert.equal(await empty.advisor.extensionForGeneration(input()), null);
});

test("Codex-shaped runtime remains authoritative for an explicit one-call selection", async () => {
  const fixtureValue = fixture();
  fixtureValue.runtime.provider.id = "openai-codex";
  fixtureValue.runtime.provider.models = [];
  fixtureValue.runtime.model.id = "gpt-codex";
  fixtureValue.runtime.apiKey = undefined;
  fixtureValue.runtime.prepareIsolatedStream = (async () => undefined) as never;
  fixtureValue.dependencies.listCandidates = async () => [
    {
      providerId: "openai-codex",
      providerLabel: "ChatGPT / Codex",
      modelId: "gpt-codex",
      modelLabel: "GPT Codex",
      efforts: [],
    },
  ];
  const extension = await fixtureValue.advisor.extensionForGeneration(input());
  assert.ok(extension?.tools?.[0]);
  const result = await extension.tools[0].execute("codex-advisor", {
    providerId: "openai-codex",
    modelId: "gpt-codex",
  });
  assert.equal(result.details?.status, "completed");
});

test("Pi-native reviewer auth is preflighted at dispatch and fails closed when absent", async () => {
  const authenticated = fixture();
  authenticated.runtime.apiKey = undefined;
  authenticated.runtime.provider.isBuiltin = true;
  let authReads = 0;
  authenticated.runtime.models.getAuth = async () => {
    authReads += 1;
    return { auth: { apiKey: "native-auth" }, source: "test" };
  };
  const extension = await authenticated.advisor.extensionForGeneration(input());
  assert.ok(extension?.tools?.[0]);
  await extension.tools[0].execute("native-advisor", {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
  });
  assert.equal(authReads, 1);

  const unauthenticated = fixture();
  unauthenticated.runtime.apiKey = undefined;
  unauthenticated.runtime.provider.isBuiltin = true;
  unauthenticated.runtime.models.getAuth = async () => undefined;
  const unavailable = await unauthenticated.advisor.extensionForGeneration(input());
  assert.ok(unavailable?.tools?.[0]);
  const result = await unavailable.tools[0].execute("native-unavailable", {
    providerId: candidate.providerId,
    modelId: candidate.modelId,
  });
  assert.equal(result.details?.status, "failed");
  assert.equal(unauthenticated.events.length, 0);
});

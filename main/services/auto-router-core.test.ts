import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTask,
  computeBenchmarkScore,
  computeCostScore,
  computeSpeedScore,
  filterEligibleCandidates,
  getRoutingWeights,
  promptRequiresVision,
  resolveAutoRoute,
  type AutoRouterCandidate,
} from "./auto-router-core.js";

test("promptRequiresVision correctly flags image attachments only", () => {
  assert.equal(promptRequiresVision(), false);
  assert.equal(promptRequiresVision([]), false);
  assert.equal(promptRequiresVision([{ text: "hello.ts", mimeType: "text/plain" }]), false);
  assert.equal(promptRequiresVision([{ mimeType: "image/png", data: "base64data" }]), true);
  assert.equal(promptRequiresVision([{ mimeType: "image/jpeg" }]), true);
  assert.equal(promptRequiresVision([{ data: "base64data" }]), true);
  assert.equal(promptRequiresVision([{ kind: "image", id: "att-1" }]), true);
  assert.equal(promptRequiresVision([{ kind: "file", id: "att-2", text: "code.ts" }]), false);
});

test("classifyTask differentiates trivial, moderate, high complexity, and critical coding tasks", () => {
  // Tier 1: Trivial / everyday
  const trivial1 = classifyTask("hi");
  assert.equal(trivial1.tier, 1);
  assert.equal(trivial1.isCoding, false);
  assert.equal(trivial1.requiresVision, false);

  const trivial2 = classifyTask("What is the capital of France?");
  assert.equal(trivial2.tier, 1);
  assert.equal(trivial2.isCoding, false);

  const trivial3 = classifyTask("what is 2 + 2");
  assert.equal(trivial3.tier, 1);
  assert.equal(trivial3.isCoding, false);

  // Tier 2: Moderate coding
  const moderate1 = classifyTask("Write a python function to validate email addresses");
  assert.equal(moderate1.tier, 2);
  assert.equal(moderate1.isCoding, true);

  const moderate2 = classifyTask("Create a React toggle component in TypeScript");
  assert.equal(moderate2.tier, 2);
  assert.equal(moderate2.isCoding, true);

  // Tier 3: High complexity coding
  const high1 = classifyTask(
    "Refactor this state machine to eliminate race conditions and memory leaks during high concurrency",
  );
  assert.equal(high1.tier, 3);
  assert.equal(high1.isCoding, true);

  const high2 = classifyTask(
    "Here is the stack trace from our segmentation fault:\n```\npanic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV: segmentation violation]\n```\nPlease debug and fix.",
  );
  assert.equal(high2.tier, 3);
  assert.equal(high2.isCoding, true);

  // Tier 4: Critical / architectural
  const critical = classifyTask(
    "Perform a security audit of our authentication protocol and design a zero downtime database migration strategy",
  );
  assert.equal(critical.tier, 4);
  assert.equal(critical.isCoding, true);

  // Vision requirement
  const withImage = classifyTask("Describe this screenshot", [{ mimeType: "image/png" }]);
  assert.equal(withImage.requiresVision, true);
});

test("getRoutingWeights adapts dynamically across presets and complexity tiers", () => {
  const balancedT1 = getRoutingWeights(1, "balanced");
  assert.ok(balancedT1.wCost >= balancedT1.wBench);

  const balancedT4 = getRoutingWeights(4, "balanced");
  assert.ok(balancedT4.wBench >= 0.85);
  assert.ok(balancedT4.wCost <= 0.1);

  const costT2 = getRoutingWeights(2, "cost");
  const capT2 = getRoutingWeights(2, "capability");
  assert.ok(costT2.wCost > capT2.wCost);
  assert.ok(capT2.wBench > costT2.wBench);
});

test("computeBenchmarkScore, computeCostScore, and computeSpeedScore honor model characteristics", () => {
  const localModel: AutoRouterCandidate = {
    providerId: "ollama",
    model: "llama3:latest",
    isLocal: true,
    isUsable: true,
    placement: { x: 0.1, y: 0.6 },
  };

  const cheapFastModel: AutoRouterCandidate = {
    providerId: "openrouter",
    model: "anthropic/claude-3-haiku",
    isLocal: false,
    isUsable: true,
    info: {
      cost: { input: 0.25, output: 1.25 },
      benchmark: { intelligence: 60, coding: 62 },
    },
    placement: { x: 0.1, y: 0.4 },
  };

  const expensiveFlagshipModel: AutoRouterCandidate = {
    providerId: "anthropic",
    model: "claude-3-7-sonnet",
    isLocal: false,
    isUsable: true,
    info: {
      cost: { input: 3.0, output: 15.0 },
      benchmark: { intelligence: 88, coding: 92, agentic: 86 },
    },
    placement: { x: 0.6, y: 0.95 },
  };

  // Local model cost score is always 1.0 (free)
  assert.equal(computeCostScore(localModel, { input: 2000, output: 800 }), 1.0);

  // Cheap model has higher cost score than expensive flagship model
  const tokens = { input: 5000, output: 2000 };
  const cheapScore = computeCostScore(cheapFastModel, tokens);
  const expensiveScore = computeCostScore(expensiveFlagshipModel, tokens);
  assert.ok(cheapScore > expensiveScore);

  // Flagship model has higher coding benchmark score
  const flagshipBench = computeBenchmarkScore(expensiveFlagshipModel, true);
  const cheapBench = computeBenchmarkScore(cheapFastModel, true);
  assert.ok(flagshipBench > cheapBench);

  // Fast variant has higher speed score than deliberate placement
  const fastSpeed = computeSpeedScore(cheapFastModel);
  const deliberateSpeed = computeSpeedScore(expensiveFlagshipModel);
  assert.ok(fastSpeed > deliberateSpeed);
});

test("filterEligibleCandidates enforces authentication, exclusion, and vision constraints", () => {
  const candidates: AutoRouterCandidate[] = [
    {
      providerId: "openai",
      model: "gpt-4o",
      isLocal: false,
      isUsable: true,
      info: { vision: true },
    },
    {
      providerId: "anthropic",
      model: "claude-3-5-haiku",
      isLocal: false,
      isUsable: true,
      info: { vision: false },
    },
    {
      providerId: "unauthed",
      model: "broken-model",
      isLocal: false,
      isUsable: false,
    },
  ];

  // Normal text task
  const textTask = classifyTask("Hello");
  const filteredText = filterEligibleCandidates(candidates, textTask, ["openai::gpt-4o"]);
  assert.equal(filteredText.length, 1);
  assert.equal(filteredText[0].model, "claude-3-5-haiku");

  // Vision task
  const visionTask = classifyTask("Describe image", [{ mimeType: "image/png" }]);
  const filteredVision = filterEligibleCandidates(candidates, visionTask);
  assert.equal(filteredVision.length, 1);
  assert.equal(filteredVision[0].model, "gpt-4o");
});

test("resolveAutoRoute dynamically routes according to task importance and presets", () => {
  const localFast: AutoRouterCandidate = {
    providerId: "ollama",
    model: "qwen2.5-coder:7b",
    isLocal: true,
    isUsable: true,
    placement: { x: 0.1, y: 0.5 },
    info: { benchmark: { coding: 55, intelligence: 52 } },
  };

  const premierCoding: AutoRouterCandidate = {
    providerId: "anthropic",
    model: "claude-3-7-sonnet",
    isLocal: false,
    isUsable: true,
    placement: { x: 0.5, y: 0.95 },
    info: {
      cost: { input: 3.0, output: 15.0 },
      benchmark: { coding: 92.5, intelligence: 89 },
    },
  };

  const cheapAssistant: AutoRouterCandidate = {
    providerId: "google",
    model: "gemini-2.0-flash",
    isLocal: false,
    isUsable: true,
    placement: { x: 0.05, y: 0.6 },
    info: {
      cost: { input: 0.1, output: 0.4 },
      benchmark: { coding: 74, intelligence: 76 },
    },
  };

  const pool = [localFast, premierCoding, cheapAssistant];

  // Trivial greetings should route to cheap/fast/local model
  const routeTrivial = resolveAutoRoute({
    prompt: "Hello! How are you today?",
    candidates: pool,
    preset: "balanced",
  });
  assert.notEqual(routeTrivial.model, premierCoding.model);

  // High complexity coding task routes to premier coding model
  const routeComplex = resolveAutoRoute({
    prompt:
      "Refactor this concurrency manager to eliminate deadlock and memory leaks under heavy thread contention. Include strict TypeScript types.",
    candidates: pool,
    preset: "balanced",
  });
  assert.equal(routeComplex.model, premierCoding.model);
  assert.equal(routeComplex.providerId, premierCoding.providerId);
  assert.equal(routeComplex.classification.tier, 3);
  assert.equal(routeComplex.classification.isCoding, true);

  // Cost preset favors free local or cheapest model even on moderate tasks
  const routeCost = resolveAutoRoute({
    prompt: "Write a small utility function in Python",
    candidates: pool,
    preset: "cost",
  });
  assert.ok(routeCost.model === localFast.model || routeCost.model === cheapAssistant.model);

  // Fallback when candidates empty
  const fallback = resolveAutoRoute({
    prompt: "Test",
    candidates: [],
    defaultSelection: { providerId: "fallback-prov", model: "fallback-model" },
  });
  assert.equal(fallback.providerId, "fallback-prov");
  assert.equal(fallback.model, "fallback-model");
  assert.equal(fallback.candidateCount, 0);

  // Vision requirement filters out text-only models and routes exclusively to vision models
  const visionCandidates: AutoRouterCandidate[] = [
    {
      providerId: "ollama",
      model: "deepseek-coder",
      isLocal: true,
      isUsable: true,
      info: { vision: false, benchmark: { coding: 95 } },
    },
    {
      providerId: "openai",
      model: "gpt-4o",
      isLocal: false,
      isUsable: true,
      info: { vision: true, cost: { input: 2.5, output: 10 }, benchmark: { coding: 90 } },
    },
  ];
  const visionResult = resolveAutoRoute({
    prompt: "What is shown here?",
    attachments: [{ kind: "image", id: "img-1" }],
    candidates: visionCandidates,
    preset: "cost",
  });
  assert.equal(visionResult.model, "gpt-4o");
  assert.equal(visionResult.providerId, "openai");
  assert.equal(visionResult.candidateCount, 1);
});

test("classifyTask and scoring handle empty, whitespace, and corrupt inputs safely", () => {
  const empty = classifyTask("");
  assert.equal(empty.tier, 1);
  assert.equal(empty.isCoding, false);
  assert.equal(empty.requiresVision, false);

  const whitespace = classifyTask("   \n\t  ");
  assert.equal(whitespace.tier, 1);
  assert.equal(whitespace.isCoding, false);

  // Corrupted cost inputs
  const corruptCandidate: AutoRouterCandidate = {
    providerId: "test",
    model: "corrupt",
    isLocal: false,
    isUsable: true,
    placement: { x: NaN, y: -0.5 },
    info: { cost: { input: -10, output: NaN } },
  };
  const costScore = computeCostScore(corruptCandidate, { input: 1000, output: 500 });
  assert.equal(costScore, 1.0);

  const speedScore = computeSpeedScore(corruptCandidate);
  assert.equal(speedScore, 0.5);
});

test("resolveAutoRoute strictly respects excluded models when vision is required", () => {
  const candidates: AutoRouterCandidate[] = [
    {
      providerId: "openai",
      model: "gpt-4o",
      isLocal: false,
      isUsable: true,
      info: { vision: true, cost: { input: 2.5, output: 10 }, benchmark: { coding: 90 } },
    },
    {
      providerId: "google",
      model: "gemini-2.0-flash",
      isLocal: false,
      isUsable: true,
      info: { vision: true, cost: { input: 0.1, output: 0.4 }, benchmark: { coding: 75 } },
    },
  ];

  // User excluded openai::gpt-4o
  const result = resolveAutoRoute({
    prompt: "Examine diagram",
    attachments: [{ kind: "image", id: "d-1" }],
    candidates,
    excludedModels: ["openai::gpt-4o"],
    preset: "capability",
  });
  assert.equal(result.model, "gemini-2.0-flash");
  assert.equal(result.providerId, "google");
});

test("filterEligibleCandidates rejects models whose context length is insufficient for estimated tokens", () => {
  const smallContextModel: AutoRouterCandidate = {
    providerId: "ollama",
    model: "small-ctx-model",
    isLocal: true,
    isUsable: true,
    info: { contextLength: 1000 },
  };
  const largeContextModel: AutoRouterCandidate = {
    providerId: "anthropic",
    model: "claude-3-7-sonnet",
    isLocal: false,
    isUsable: true,
    info: { contextLength: 200_000 },
  };

  // High complexity tier estimates 6000 input tokens
  const task = classifyTask(
    "Refactor this concurrency manager to eliminate deadlock and memory leaks under heavy thread contention.",
  );
  const eligible = filterEligibleCandidates([smallContextModel, largeContextModel], task);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].model, "claude-3-7-sonnet");
});

test("resolveAutoRoute gracefully falls back to defaultSelection when all models are filtered out", () => {
  const smallContextModel: AutoRouterCandidate = {
    providerId: "ollama",
    model: "small-ctx-model",
    isLocal: true,
    isUsable: true,
    info: { contextLength: 500 },
  };

  const task = "Refactor this concurrency manager to eliminate deadlock and race conditions.";
  const result = resolveAutoRoute({
    prompt: task,
    candidates: [smallContextModel],
    defaultSelection: { providerId: "default-prov", model: "default-mod" },
  });
  assert.equal(result.providerId, "default-prov");
  assert.equal(result.model, "default-mod");
  assert.equal(result.candidateCount, 0);
  assert.match(result.reason, /Default fallback/u);
});

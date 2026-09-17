import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_SELECTION_VALUE,
  buildAutoRouterCandidates,
  isAutoRouterSelection,
  resolveAutoRoute,
} from "./auto-router.js";
import type { ModelEntry } from "./model-picker-data.js";
import type { ModelPadPlacement } from "./model-pad-layout.js";
import type { Provider } from "./types.js";

test("isAutoRouterSelection accurately identifies auto router selection", () => {
  assert.equal(isAutoRouterSelection(AUTO_ROUTER_PROVIDER_ID, AUTO_ROUTER_MODEL_ID), true);
  assert.equal(isAutoRouterSelection("auto", "auto"), true);
  assert.equal(isAutoRouterSelection("auto-router", "anything"), true);
  assert.equal(isAutoRouterSelection("anthropic", "claude-3-5-sonnet"), false);
  assert.equal(isAutoRouterSelection("openai-codex", "codex"), false);
  assert.equal(AUTO_ROUTER_SELECTION_VALUE, "auto::auto");
});

test("buildAutoRouterCandidates extracts candidate metadata and Model Pad placements", () => {
  const entries = [
    {
      value: "anthropic::claude-3-7-sonnet",
      providerId: "anthropic",
      providerLabel: "Anthropic",
      model: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      format: null,
      isLocal: false,
      info: {
        id: "claude-3-7-sonnet",
        vision: true,
        toolCall: true,
        reasoning: true,
        openWeights: false,
        metadataSource: "provider",
        matched: true,
        benchmark: {
          intelligence: 82,
          coding: 85,
          agentic: 83,
          sourceLabel: "Artificial Analysis via OpenRouter",
          license: "CC BY 4.0",
          sourceUrl: "https://artificialanalysis.ai",
        },
        cost: { input: 3, output: 15 },
      },
    },
    {
      value: "ollama::qwen2.5-coder",
      providerId: "ollama",
      providerLabel: "Ollama",
      model: "qwen2.5-coder",
      label: "Qwen 2.5 Coder 32B",
      format: null,
      isLocal: true,
      info: {
        id: "qwen2.5-coder",
        vision: false,
        toolCall: true,
        reasoning: false,
        openWeights: true,
        metadataSource: "provider",
        matched: true,
        cost: { input: 0, output: 0 },
      },
    },
  ] as unknown as ModelEntry[];

  const providers = [
    {
      id: "anthropic",
      label: "Anthropic",
      models: ["claude-3-7-sonnet"],
      needsKey: true,
      hasKey: true,
    },
    {
      id: "ollama",
      label: "Ollama",
      models: ["qwen2.5-coder"],
      needsKey: false,
      hasKey: true,
    },
  ] as unknown as Provider[];

  const placements = {
    "anthropic::claude-3-7-sonnet": { x: 0.6, y: 0.85, xSource: "user", ySource: "user" },
    "ollama::qwen2.5-coder": { x: 0.9, y: 0.7, xSource: "user", ySource: "user" },
  } as unknown as Record<string, ModelPadPlacement>;

  const candidates = buildAutoRouterCandidates(entries, placements, providers);
  assert.equal(candidates.length, 2);

  const claude = candidates.find((c) => c.model === "claude-3-7-sonnet");
  assert.ok(claude);
  assert.equal(claude.isUsable, true);
  assert.equal(claude.isLocal, false);
  assert.equal(claude.placement?.x, 0.6);
  assert.equal(claude.placement?.y, 0.85);
  assert.equal(claude.info?.cost?.input, 3);

  const ollama = candidates.find((c) => c.model === "qwen2.5-coder");
  assert.ok(ollama);
  assert.equal(ollama.isUsable, true);
  assert.equal(ollama.isLocal, true);
  assert.equal(ollama.placement?.x, 0.9);
  assert.equal(ollama.placement?.y, 0.7);
});

test("resolveAutoRoute dynamically selects optimal candidate and handles constraints", () => {
  const providers = [
    {
      id: "anthropic",
      label: "Anthropic",
      models: ["claude-3-7-sonnet"],
      needsKey: true,
      hasKey: true,
    },
    {
      id: "ollama",
      label: "Ollama",
      models: ["qwen2.5-coder"],
      needsKey: false,
      hasKey: true,
    },
  ] as unknown as Provider[];

  const entries = [
    {
      value: "anthropic::claude-3-7-sonnet",
      providerId: "anthropic",
      providerLabel: "Anthropic",
      model: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      format: null,
      isLocal: false,
      info: {
        id: "claude-3-7-sonnet",
        vision: true,
        toolCall: true,
        reasoning: true,
        openWeights: false,
        metadataSource: "provider",
        matched: true,
        benchmark: {
          intelligence: 82,
          coding: 88,
          agentic: 83,
          sourceLabel: "Artificial Analysis via OpenRouter",
          license: "CC BY 4.0",
          sourceUrl: "https://artificialanalysis.ai",
        },
        cost: { input: 3, output: 15 },
      },
    },
    {
      value: "ollama::qwen2.5-coder",
      providerId: "ollama",
      providerLabel: "Ollama",
      model: "qwen2.5-coder",
      label: "Qwen 2.5 Coder 32B",
      format: null,
      isLocal: true,
      info: {
        id: "qwen2.5-coder",
        vision: false,
        toolCall: true,
        reasoning: false,
        openWeights: true,
        metadataSource: "provider",
        matched: true,
        benchmark: {
          intelligence: 68,
          coding: 72,
          agentic: 65,
          sourceLabel: "Artificial Analysis via OpenRouter",
          license: "CC BY 4.0",
          sourceUrl: "https://artificialanalysis.ai",
        },
        cost: { input: 0, output: 0 },
      },
    },
  ] as unknown as ModelEntry[];

  const placements = {
    "anthropic::claude-3-7-sonnet": { x: 0.5, y: 0.88, xSource: "user", ySource: "user" },
    "ollama::qwen2.5-coder": { x: 0.9, y: 0.72, xSource: "user", ySource: "user" },
  } as unknown as Record<string, ModelPadPlacement>;

  const candidates = buildAutoRouterCandidates(entries, placements, providers);

  // 1. High complexity coding task with capability preset routes to Claude 3.7
  const codingRoute = resolveAutoRoute({
    prompt: "Refactor the distributed consensus algorithm to prevent deadlock and livelock",
    candidates,
    preset: "capability",
  });
  assert.equal(codingRoute.model, "claude-3-7-sonnet");
  assert.equal(codingRoute.classification.isCoding, true);

  // 2. Vision requirement forces vision-capable model even if cost preset preferred
  const visionRoute = resolveAutoRoute({
    prompt: "Inspect this screenshot",
    attachments: [{ kind: "image", mimeType: "image/png", path: "/tmp/mock.png" }],
    candidates,
    preset: "cost",
  });
  assert.equal(visionRoute.model, "claude-3-7-sonnet");
  assert.equal(visionRoute.classification.requiresVision, true);

  // 2b. Vision requirement using kind: image without explicit mimeType
  const visionKindRoute = resolveAutoRoute({
    prompt: "Inspect this image",
    attachments: [{ kind: "image", id: "image-turn-1" }],
    candidates,
    preset: "cost",
  });
  assert.equal(visionKindRoute.model, "claude-3-7-sonnet");
  assert.equal(visionKindRoute.classification.requiresVision, true);

  // 3. Simple non-coding task with cost preset routes to free local model
  const costRoute = resolveAutoRoute({
    prompt: "Say hello and summarize this 1-line note",
    candidates,
    preset: "cost",
  });
  assert.equal(costRoute.model, "qwen2.5-coder");

  // 4. Excluded model respects exclusion list
  const excludedRoute = resolveAutoRoute({
    prompt: "Refactor this function",
    candidates,
    preset: "capability",
    excludedModels: ["anthropic::claude-3-7-sonnet"],
  });
  assert.equal(excludedRoute.model, "qwen2.5-coder");

  // 5. Fallback when all candidates excluded
  const fallbackRoute = resolveAutoRoute({
    prompt: "Hello",
    candidates,
    excludedModels: ["anthropic::claude-3-7-sonnet", "ollama::qwen2.5-coder"],
    defaultSelection: { providerId: "default-prov", model: "default-mod" },
  });
  assert.equal(fallbackRoute.providerId, "default-prov");
  assert.equal(fallbackRoute.model, "default-mod");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeSubagentModel,
  parseSubagentModelSettings,
  planSubagentModel,
  requestableSubagentModels,
  subagentModelKey,
  subagentModelToolOptions,
  type SubagentModelCandidate,
  type SubagentModelPolicy,
  type SubagentModelRequest,
  type SubagentModelRuntimeFacts,
  type SubagentModelSettings,
} from "./subagent-model-selection.js";
import { createSubagentChildModelResolver, subagentModelRuntimeFacts } from "./subagent-model-runtime.js";

const sonnet: SubagentModelCandidate = {
  providerId: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-sonnet",
  modelLabel: "Claude Sonnet",
};
const haiku: SubagentModelCandidate = {
  providerId: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-haiku",
  modelLabel: "Claude Haiku",
};
const mini: SubagentModelCandidate = {
  providerId: "openai",
  providerLabel: "OpenAI",
  modelId: "gpt-mini",
  modelLabel: "GPT Mini",
};
const opus: SubagentModelCandidate = {
  providerId: "openai",
  providerLabel: "OpenAI",
  modelId: "gpt-large",
  modelLabel: "GPT Large",
};
const local: SubagentModelCandidate = {
  providerId: "ollama",
  providerLabel: "Ollama",
  modelId: "qwen",
  modelLabel: "Qwen",
};

function policy(settings?: SubagentModelSettings, overridesAllowed = true): SubagentModelPolicy {
  return {
    parent: { ...sonnet, effort: "high" },
    candidates: [sonnet, haiku, mini, opus, local],
    overridesAllowed,
    settings,
  };
}

const facts: Record<string, SubagentModelRuntimeFacts> = {
  "anthropic/claude-sonnet": {
    supportedEfforts: ["off", "low", "medium", "high", "max"],
    defaultEffort: "medium",
    local: false,
    cost: { input: 3, output: 15 },
  },
  "anthropic/claude-haiku": {
    supportedEfforts: ["off", "low", "medium", "high"],
    defaultEffort: "low",
    local: false,
    cost: { input: 1, output: 5 },
  },
  "openai/gpt-mini": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    local: false,
    cost: { input: 0.5, output: 2 },
  },
  "openai/gpt-large": {
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    local: false,
    cost: { input: 10, output: 40 },
  },
  "ollama/qwen": { supportedEfforts: ["off"], defaultEffort: "off", local: true },
};

function select(request: SubagentModelRequest, current = policy()) {
  const planned = planSubagentModel(current, request);
  if (!planned.ok) return planned;
  return finalizeSubagentModel(
    current,
    planned.value,
    facts[subagentModelKey(planned.value.candidate)]!,
    facts["anthropic/claude-sonnet"]!,
  );
}

function selected(request: SubagentModelRequest, current = policy()) {
  const result = select(request, current);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return (result as Extract<typeof result, { ok: true }>).value;
}

function rejected(request: SubagentModelRequest, current = policy()): string {
  const result = select(request, current);
  assert.equal(result.ok, false);
  return (result as Extract<typeof result, { ok: false }>).error;
}

test("a child with no arguments or settings inherits the parent model and effort", () => {
  const value = selected({ role: "scout" });
  assert.deepEqual(
    [value.providerId, value.modelId, value.effort, value.modelSource, value.effortSource],
    ["anthropic", "claude-sonnet", "high", "inherited", "inherited"],
  );
});

test("a requested model without an effort uses that model's default, not the parent's", () => {
  const value = selected({ role: "scout", model: "anthropic/claude-haiku" });
  assert.equal(value.modelId, "claude-haiku");
  assert.equal(value.effort, "low");
  assert.equal(value.modelSource, "requested");
});

test("a requested effort alone is validated against the inherited parent model", () => {
  assert.equal(selected({ role: "scout", effort: "max" }).effort, "max");
  assert.match(
    rejected({ role: "scout", model: "anthropic/claude-haiku", effort: "max" }),
    /not supported by anthropic\/claude-haiku\. Supported efforts: off, low, medium, high\./,
  );
});

test("an unknown model is refused with the allowed list instead of falling back", () => {
  const error = rejected({ role: "scout", model: "anthropic/claude-made-up" });
  assert.match(error, /not available for subagents/);
  assert.match(error, /anthropic\/claude-sonnet/);
  assert.match(error, /openai\/gpt-mini/);
});

test("explicit arguments beat configured defaults, which beat the parent", () => {
  const settings: SubagentModelSettings = {
    defaultModel: "openai/gpt-mini",
    roles: { reviewer: { model: "anthropic/claude-haiku", effort: "medium" } },
    allowedModels: ["anthropic/claude-haiku", "openai/gpt-mini"],
  };
  assert.equal(selected({ role: "scout" }, policy(settings)).modelId, "gpt-mini");
  const reviewer = selected({ role: "reviewer" }, policy(settings));
  assert.deepEqual([reviewer.modelId, reviewer.effort, reviewer.modelSource], ["claude-haiku", "medium", "configured"]);
  const explicit = selected({ role: "reviewer", model: "anthropic/claude-sonnet" }, policy(settings));
  assert.deepEqual([explicit.modelId, explicit.effort], ["claude-sonnet", "high"]);
});

test("a locked role applies last and overrides explicit arguments with a visible warning", () => {
  const settings: SubagentModelSettings = {
    roles: { implementer: { model: "openai/gpt-mini", effort: "low", locked: true } },
  };
  const value = selected({ role: "implementer", model: "anthropic/claude-haiku", effort: "high" }, policy(settings));
  assert.deepEqual([value.modelId, value.effort, value.modelSource], ["gpt-mini", "low", "role_locked"]);
  assert.match(value.warnings.join(" "), /locked/);
});

test("a disconnected configured model is reported and the parent is used", () => {
  const value = selected({ role: "scout" }, policy({ defaultModel: "gone/model" }));
  assert.equal(value.modelId, "claude-sonnet");
  assert.match(value.warnings.join(" "), /gone\/model is not connected/);
});

test("the effort ceiling refuses explicit picks and caps configured ones", () => {
  const settings: SubagentModelSettings = { maxEffort: "medium", defaultEffort: "high" };
  assert.match(rejected({ role: "scout", effort: "high" }, policy(settings)), /exceeds the subagent effort ceiling \(medium\)/);
  assert.equal(selected({ role: "scout", model: "openai/gpt-mini" }, policy(settings)).effort, "medium");
  const configured = selected({ role: "scout" }, policy(settings));
  assert.equal(configured.effort, "medium");
  assert.match(configured.warnings.join(" "), /ceiling/);
});

test("an agent cannot pick a costlier hosted model unless settings allow it", () => {
  const settings: SubagentModelSettings = { allowedModels: ["openai/gpt-large", "ollama/qwen", "openai/gpt-mini"] };
  assert.match(rejected({ role: "scout", model: "openai/gpt-large" }, policy(settings)), /costs more than the current model/);
  assert.equal(selected({ role: "scout", model: "openai/gpt-mini" }, policy(settings)).modelId, "gpt-mini");
  assert.equal(selected({ role: "scout", model: "ollama/qwen" }, policy(settings)).modelId, "qwen");
  assert.equal(
    selected({ role: "scout", model: "openai/gpt-large" }, policy({ ...settings, allowCostlierModels: true })).modelId,
    "gpt-large",
  );
});

test("bot and Assistant generations cannot change the child model or effort", () => {
  const settings: SubagentModelSettings = { defaultModel: "openai/gpt-mini" };
  assert.equal(subagentModelToolOptions(policy(settings, false)), undefined);
  assert.equal(selected({ role: "scout" }, policy(settings, false)).modelId, "claude-sonnet");
  assert.match(
    rejected({ role: "scout", model: "openai/gpt-mini" }, policy(settings, false)),
    /overrides are not available/,
  );
  assert.match(
    rejected({ role: "scout", effort: "low" }, policy(settings, false)),
    /effort overrides are not available/,
  );
});

test("the listed set stays small, starts with the parent, and hides when only the parent is allowed", () => {
  const many: SubagentModelCandidate[] = Array.from({ length: 12 }, (_, index) => ({
    providerId: `provider-${index}`,
    providerLabel: `Provider ${index}`,
    modelId: "model",
    modelLabel: "Model",
  }));
  const listed = requestableSubagentModels({ ...policy(), candidates: [sonnet, ...many] });
  assert.equal(listed.length, 6);
  assert.equal(subagentModelKey(listed[0]!), "anthropic/claude-sonnet");
  assert.equal(subagentModelToolOptions({ ...policy(), candidates: [sonnet] }), undefined);
  assert.equal(subagentModelToolOptions(policy({ allowedModels: [] })), undefined);
  assert.deepEqual(subagentModelToolOptions(policy({ maxEffort: "medium" }))?.efforts, ["off", "low", "medium"]);
});

test("model settings parsing drops invalid fields instead of rejecting the whole object", () => {
  assert.deepEqual(
    parseSubagentModelSettings({
      defaultModel: "no-slash",
      defaultEffort: "high",
      maxEffort: "turbo",
      allowedModels: ["openai/gpt-mini", 4, "openai/gpt-mini"],
      roles: { scout: { model: "openai/gpt-mini", locked: true }, wizard: { model: "a/b" } },
    }),
    {
      defaultEffort: "high",
      allowedModels: ["openai/gpt-mini"],
      roles: { scout: { model: "openai/gpt-mini", locked: true } },
    },
  );
  assert.equal(parseSubagentModelSettings("nope"), undefined);
});

const runtime = (providerId: string, modelId: string, reasoning: boolean, deployment?: "local") => ({
  provider: { id: providerId, ...(deployment ? { deployment } : {}) },
  model: {
    id: modelId,
    reasoning,
    thinkingLevelMap: undefined,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  },
});

test("runtime facts expose only the efforts Pi would send unchanged", () => {
  const plain = subagentModelRuntimeFacts(runtime("custom", "plain", false), undefined);
  assert.deepEqual(plain.supportedEfforts, ["off"]);
  assert.equal(plain.defaultEffort, "off");
  const local = subagentModelRuntimeFacts(runtime("custom", "plain", false, "local"), undefined);
  assert.equal(local.local, true);
});

test("the child resolver resolves each distinct model once and reuses the parent runtime by identity", async () => {
  const parentRuntime = runtime("anthropic", "claude-sonnet", false);
  const resolved: string[] = [];
  const resolve = createSubagentChildModelResolver({
    policy: { ...policy({ allowCostlierModels: true }), parent: { ...sonnet, effort: "off" } },
    parentRuntime,
    savedEffort: () => undefined,
    resolveRuntime: async (providerId, modelId) => {
      resolved.push(`${providerId}/${modelId}`);
      return runtime(providerId, modelId, false);
    },
  });
  const signal = new AbortController().signal;
  const inherited = await resolve({ role: "scout" }, signal);
  assert.equal(inherited.runtime, parentRuntime);
  const first = await resolve({ role: "scout", model: "openai/gpt-mini" }, signal);
  const second = await resolve({ role: "planner", model: "openai/gpt-mini" }, signal);
  assert.equal(first.runtime, second.runtime);
  assert.deepEqual(resolved, ["openai/gpt-mini"]);
  await assert.rejects(resolve({ role: "scout", model: "openai/gpt-mini", effort: "high" }, signal), /Supported efforts: off/);
});

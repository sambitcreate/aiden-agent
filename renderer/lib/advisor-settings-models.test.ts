import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "./types.js";
import { availableAdvisorProviders, supportedAdvisorEfforts } from "./advisor-settings-models.js";

function provider(): Provider {
  return {
    id: "local",
    kind: "openai",
    label: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["chat-model", "text-embedding-model", "image-model"],
    modelMetadata: {
      "chat-model": { source: "provider", type: "llm" },
      "image-model": { source: "provider", type: "image" },
    },
    needsKey: false,
    hasKey: false,
  };
}

test("advisor provider choices exclude non-chat models", () => {
  assert.deepEqual(availableAdvisorProviders([provider()])[0]?.models, ["chat-model"]);
});

test("advisor exposes effort only from explicit reasoning metadata", () => {
  const value = provider();
  assert.deepEqual(supportedAdvisorEfforts(value, "chat-model"), []);
  value.modelMetadata!["chat-model"] = {
    source: "provider",
    type: "llm",
    reasoning: true,
  };
  assert.deepEqual(supportedAdvisorEfforts(value, "chat-model"), ["low", "medium", "high"]);
  value.modelMetadata!["chat-model"]!.thinkingLevels = ["off", "low", "xhigh"];
  assert.deepEqual(supportedAdvisorEfforts(value, "chat-model"), ["low", "xhigh"]);
});
